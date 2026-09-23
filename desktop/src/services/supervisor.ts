import { CAUSES } from "../diagnostics/causes";
import { exitCauseBlock } from "../diagnostics/stderr";
import { recoveryOf } from "./failure";
import { downloadInProgress, parseModelReadiness, STALL_MS } from "./model-readiness";
import type {
  ExternalState,
  LaunchContext,
  LaunchResult,
  ReadinessResult,
  ServiceId,
  ServiceSpec,
  ServiceStatus,
  StopOutcome,
  StopPlan,
} from "./types";

export interface SupervisorHooks {
  /** 상태가 바뀔 때마다 부른다. 화면 갱신이 여기에 붙는다. */
  onStatus?(statuses: ServiceStatus[]): void;
  /** 감독자 자신의 판단 기록. supervisor.log가 여기로 온다. */
  log?(line: string): void;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
  /** 재시작 예산을 돌려주는 안정 창. 기본값은 분 단위라 테스트가 줄이려고 열어 둔다. */
  stableResetMs?: number;
  /**
   * `app_setting.model_readiness` 행을 **날것 그대로** 돌려준다 (스펙 §6.9). 배선은 main.ts가
   * 번들 psql로 한다 — 감독자는 Task 11의 API를 몰라야 하고(판정 R-P8), DB에 닿는 방법을
   * 여기서 정하면 이 파일이 vitest에서 안 돈다.
   *
   * 없으면 준비 유예는 Phase 3까지와 똑같이 흐른다. 외부 DB 모드가 그 경우다 — 그 모드에서는
   * worker가 이 행을 아예 쓰지 않는다 (§6.9의 `DAMWHA_SHARED_STATE=off`).
   */
  readModelReadiness?(): Promise<unknown>;
  /**
   * 그 행을 다시 읽는 최소 간격. 기본 2초다 — 리더가 `psql` 프로세스 하나라 준비 폴링 주기
   * (기본 400ms)마다 부르면 180초 동안 450번 띄운다. writer는 진행을 **초당 1회 이하**로
   * 누르므로(스펙 §6.9) 2초 간격이 놓치는 상태 변화는 없다. 테스트가 0으로 줄이려고 열어 둔다.
   */
  readinessPollMs?: number;
  /**
   * worker를 다시 띄우기 전에 이번 실행의 `--once` 자식을 거둔다 (Phase 5 스펙 §8).
   * 배선은 main.ts가 한다 — 감독자는 `ps`에 닿는 방법을 몰라야 vitest에서 돈다
   * (`readModelReadiness`와 같은 이유).
   */
  reapOwnOnce?(): Promise<{ reaped: number[] } | { failed: true }>;
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_READY_INTERVAL_MS = 400;
/**
 * ready를 이만큼 유지하면 restarts를 0으로 되돌린다 (스펙 §6.8 — "retryCount는 ready 도달 시
 * 0으로 돌아간다"). ready 즉시 되돌리면 몇 초마다 죽는 서비스가 예산을 매번 새로 받아 무한
 * 재시작이 되고(P2-C11이 금지한다), 영영 되돌리지 않으면 maxAttempts가 앱 실행 전체의 누적
 * 상한이 되어 월·화에 한 번씩 복구된 서비스가 목요일에는 재시작되지 않는다. 창을 두면 둘 다
 * 만족한다 — 플래핑은 창을 못 넘고, 진짜 복구는 넘는다.
 */
const DEFAULT_STABLE_RESET_MS = 60_000;
/** bring()이 준비 못 한 자식을 치울 때 주는 유예. */
const CLEANUP_GRACE_MS = 5_000;
/** model_readiness를 다시 읽는 최소 간격. 근거는 SupervisorHooks.readinessPollMs. */
const DEFAULT_READINESS_POLL_MS = 2_000;
/**
 * `model_readiness.entries[*].writer`가 embed의 다운로드에 다는 이름. worker 쪽 writer는
 * `WORKER_ID`인데(R-9a) embed만 이 고정 문자열이다 — `be/worker/damwha_worker/embed_service.py`의
 * `EMBED_WRITER`가 원본이다.
 */
const EMBED_WRITER = "embed";
/**
 * restartService가 **plan에 싣는** 유예. 실제로 기다리는 시간이 이것이라는 뜻은 아니다 —
 * 어댑터가 자기 값을 쓰면 그쪽이 이긴다. worker가 그렇다: `stopOwnWorker`가
 * `Math.max(plan.graceMs, WORKER_GRACE_MS)`로 90초까지 올린다(`main.ts`). embed는 이 값을
 * 그대로 써서 SIGTERM 뒤 이만큼만 폴링한다(`python-launcher.ts`의 handle.stop).
 *
 * 그래서 이 상수는 "얼마나 기다리는가"가 아니라 "최소한 이만큼은 준다"이고, 유예 안에 안
 * 내려간 서비스는 restartService가 **다시 띄우지 않는다**(아래 restartOnce).
 */
const RESTART_GRACE_MS = 5_000;

/**
 * 이 상태의 서비스에 "서비스 다시 시작"이 **안 되는가** (스펙 §6.10 2층).
 *
 * 감독자의 `canRestart`가 이것을 그대로 쓰고, 상태 창도 `statuses()`의 한 줄을 그대로 넣는다 —
 * 판정처가 하나라 버튼의 활성 여부와 감독자의 거부가 갈릴 수 없다. 근거는 `canRestart`의 주석.
 *
 * 거부하는 것은 둘이다. 하나는 **앱이 소유하지 않은** 인스턴스이고, 다른 하나는 **정리 중인**
 * 서비스다(`cleaningUp`) — 그쪽은 신호를 이미 보냈고, 한 번 더 보내는 것이 worker에게는
 * 강제 종료다 (ServiceStatus.cleaningUp의 주석).
 */
export function restartRefused(s: ServiceStatus): boolean {
  if (s.cleaningUp === true) return true;
  return !s.owned && (s.process === "running" || s.process === "starting");
}

/**
 * 자식이 죽었을 때의 원인: 종료 코드와 그 자식의 stderr 블록 (스펙 §8).
 *
 * 코드만 적으면 사람이 볼 수 있는 것은 "프로세스가 종료됐어요 (코드 1)."뿐이고 **왜**는 로그
 * 파일에만 있다. 어댑터의 readiness도 죽은 핸들의 꼬리를 원인으로 올리도록 짜여 있지만,
 * awaitReady가 readiness보다 먼저 죽음을 보고 여기서 끝내므로 그 경로는 경쟁에서 이길 때만
 * 돈다 — 원인을 붙이는 자리는 이곳이어야 한다.
 */
export function exitedDetail(code: number | null, stderrTail: string): string {
  const head = CAUSES.processExited.text(code ?? "?");
  const block = exitCauseBlock(stderrTail);
  return block === "" ? head : `${head}\n${block}`;
}

/**
 * 의존 순서 위상 정렬. 같은 층에서는 선언 순서를 유지한다 — 순서가 바뀌면 로그와 화면의 줄
 * 순서가 실행마다 달라져 사람이 비교할 수 없다.
 */
export function orderOf(specs: readonly ServiceSpec[]): ServiceSpec[] {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const out: ServiceSpec[] = [];
  const done = new Set<ServiceId>();
  const path = new Set<ServiceId>();

  const visit = (spec: ServiceSpec) => {
    if (done.has(spec.id)) return;
    if (path.has(spec.id)) throw new Error(`service dependency cycle at ${spec.id}`);
    path.add(spec.id);
    for (const dep of spec.dependsOn) {
      const target = byId.get(dep);
      // 선언되지 않은 의존은 무시한다 — 서비스 집합이 모드마다 다를 수 있고(Phase 3·4),
      // 없는 의존 때문에 기동 전체가 예외로 끝나면 안 된다.
      if (target !== undefined) visit(target);
    }
    path.delete(spec.id);
    done.add(spec.id);
    out.push(spec);
  };

  for (const spec of specs) visit(spec);
  return out;
}

interface Runtime {
  spec: ServiceSpec;
  status: ServiceStatus;
  result: LaunchResult | null;
  /**
   * 한 번이라도 ready에 닿았나. 게이트의 "기동 중 실패"와 "ready 이후 사망"을 가르는 값이다 —
   * 앞의 것은 start()가 이미 반환한 뒤에 이 서비스만 되살려 봐야 창은 실패 화면인 채로
   * 뒤 서비스가 영원히 안 뜨는 막힌 길이 된다.
   */
  everReady: boolean;
  /** ready 뒤 주기 재프로브. 서비스마다 하나만 돈다. */
  healthTimer: NodeJS.Timeout | null;
  /** 안정 창이 지나면 재시작 예산을 돌려주는 타이머. */
  budgetTimer: NodeJS.Timeout | null;
  /**
   * 예약된 백오프 재시작. restartService가 이것도 끈다 — 사람이 지금 다시 띄우는데 몇 초 뒤
   * 백오프가 한 번 더 깨어나면 그 bring은 단일 비행에 막혀 아무 일도 안 하지만, 그때마다
   * 로그에 "N회차 재시작"이 찍혀 사람이 읽는 기록이 거짓이 된다.
   */
  restartTimer: NodeJS.Timeout | null;
  /**
   * 진행 중인 bring(). 한 값이 두 가지를 막는다 — 같은 서비스에 두 번째 bring이 겹쳐 들어와
   * 프로세스를 두 벌 만드는 것, 그리고 bring 진입부터 rt.result 대입까지의 구간이 stopAll의
   * 시야 밖으로 새는 것. 둘 다 "아직 rt.result가 없는 동안"이라는 같은 창에서 벌어진다.
   */
  inFlight: Promise<boolean> | null;
  /**
   * 진행 중인 restartService. `inFlight`와 따로 둔다 — 그쪽은 bring 하나의 겹침을 막고, 이것은
   * **정지까지 포함한** 재시작 전체의 겹침을 막는다. 없으면 버튼 두 번 클릭이 `specStop`을 두 번
   * 불러 같은 pid에 신호를 두 번 보낸다(두 번째는 worker에게 강제 종료다 — ServiceStatus.cleaningUp).
   */
  restartInFlight: Promise<void> | null;
}

export function createSupervisor(
  specs: readonly ServiceSpec[],
  baseCtx: Omit<LaunchContext, "signal">,
  hooks: SupervisorHooks,
) {
  /**
   * 기동 중단 신호 (Phase 3 스펙 §6.4). 호출자의 ctx 객체에 **제자리로** 붙인다 — main.ts는 그 객체의 env를 재시도마다
   * 다시 채우므로(refreshEnv) 새 객체를 만들면 둘이 갈라진다.
   */
  const aborter = new AbortController();
  const ctx: LaunchContext = Object.assign(baseCtx, { signal: aborter.signal });
  const ordered = orderOf(specs);
  const runtimes = new Map<ServiceId, Runtime>(
    ordered.map((spec) => [
      spec.id,
      {
        spec,
        status: { id: spec.id, process: "stopped", health: "unknown", owned: false, restarts: 0 },
        result: null,
        everReady: false,
        healthTimer: null,
        budgetTimer: null,
        restartTimer: null,
        inFlight: null,
        restartInFlight: null,
      },
    ]),
  );

  /** 종료가 시작되면 재시작을 걸지 않는다. 종료가 방금 치운 것을 타이머가 되살리면 안 된다. */
  let stopping = false;
  const timers = new Set<NodeJS.Timeout>();

  const statuses = () => ordered.map((s) => ({ ...runtimes.get(s.id)!.status }));
  const emit = () => hooks.onStatus?.(statuses());
  const log = (line: string) => hooks.log?.(line);
  const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const set = (id: ServiceId, patch: Partial<ServiceStatus>) => {
    const rt = runtimes.get(id)!;
    rt.status = { ...rt.status, ...patch };
    emit();
  };

  /** 예약한 타이머는 전부 timers에도 넣는다 — stopAll이 그 한 곳만 비우면 되게. */
  const arm = (ms: number, fn: () => void): NodeJS.Timeout => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
    return timer;
  };

  const disarm = (timer: NodeJS.Timeout | null) => {
    if (timer === null) return;
    clearTimeout(timer);
    timers.delete(timer);
  };

  const applyReadiness = (id: ServiceId, r: ReadinessResult): boolean => {
    if (r.kind === "ready") {
      set(id, { process: "running", health: "ok", detail: undefined, recovery: undefined });
      return true;
    }
    if (r.kind === "degraded") {
      // 재시작을 유발하지 않는다 — 재시작해도 의존이 돌아오지 않으면 같고 백오프만 태운다.
      set(id, { process: "running", health: "degraded", detail: r.detail, recovery: undefined });
      return true;
    }
    return false;
  };

  /**
   * 이 서비스의 다운로드를 `model_readiness`에서 알아보는 이름 (스펙 §6.9, 판정 R-9a).
   *
   * worker 쪽 writer는 **이번 실행의 `WORKER_ID`**다. 그 값을 자식 env에 싣는 것도 `ctx.env`이고
   * (config.ts의 `childEnv`가 `{...ctx.env}`로 펼친다 — 값 자체는 `withAppOwned`의 `RUN_WORKER_ID`),
   * 여기서도 같은 자리에서 읽는다. 두 곳이 갈리면 감독자가 자기 worker의 다운로드를 남의 것으로 본다.
   *
   * postgres·api는 모델을 받지 않으므로 null이다 — 리더를 부르지도 않는다.
   */
  function readinessWriter(id: ServiceId): string | null {
    if (id === "embed") return EMBED_WRITER;
    if (id === "worker") return ctx.env.WORKER_ID ?? null;
    return null;
  }

  /** 리더가 고장 났다는 말은 한 번만 적는다 — 준비 폴링마다 적으면 로그가 그것으로 찬다. */
  let readerFailureLogged = false;

  /**
   * `writer`가 지금 모델을 받고 있나. 리더가 없거나 던지면 **false**다 — 못 읽는 것이 유예를
   * 늘리는 사유가 되면 안 된다(그러면 리더 고장이 곧 영원한 기동 대기가 된다).
   */
  async function downloading(writer: string): Promise<boolean> {
    const read = hooks.readModelReadiness;
    if (read === undefined || stopping) return false;
    try {
      return downloadInProgress(parseModelReadiness(await read()), writer, Date.now(), STALL_MS);
    } catch (e) {
      if (!readerFailureLogged) {
        readerFailureLogged = true;
        log(`모델 준비 상태를 읽지 못했다 — ${reason(e)} (준비 유예는 평소대로 흐른다)`);
      }
      return false;
    }
  }

  /**
   * Phase 1의 waitForReady를 쓰지 않는다. 그 함수의 결과 어휘는 API 하나를 위한 것
   * ("ready" / "db-unreachable" / "child-exited" / "timeout")이라 ReadinessResult 넷을
   * 그대로 실어 나를 수 없고, `failed`를 "db-unreachable"에 태워 조기 탈출시키는 식으로
   * 우회하면 다음 사람이 그 값을 DB 이야기로 읽는다. 폴링은 여기 여덟 줄이면 된다.
   *
   * **유예는 고정 deadline이 아니라 누적이다** (스펙 §6.9). 이 서비스의 모델이 받아지는 동안에는
   * 시계를 멈춘다 — embed의 180초(`embed.ts:89`)는 bge-m3 첫 다운로드보다 짧고, 그 제한에 걸려
   * 재시작하면 받다 만 것을 버리고 처음부터 다시 받는 고리가 된다. 남은 시간을 빼는 방식(고정
   * deadline + 연장)이 아니라 **소모한 시간을 더하는** 방식인 이유: 다운로드가 끝난 순간 남은
   * 유예가 0이면 곧바로 실패하고, 그러면 "다운로드 중에는 죽이지 않는다"가 "다운로드 직후에
   * 죽인다"가 된다.
   */
  async function awaitReady(rt: Runtime): Promise<boolean> {
    const timeoutMs = rt.spec.readyTimeoutMs ?? hooks.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const intervalMs = hooks.readyIntervalMs ?? DEFAULT_READY_INTERVAL_MS;
    const pollMs = hooks.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;
    const writer = readinessWriter(rt.spec.id);
    /** 유예를 **실제로 소모한** 시간의 누적. 다운로드 중인 구간은 여기 들어오지 않는다. */
    let spent = 0;
    let lastTick = Date.now();
    let downloadingNow = false;
    let checkedAt = Number.NEGATIVE_INFINITY;
    let last: ReadinessResult = { kind: "not-ready" };

    for (;;) {
      // 종료가 지나갔으면 더 볼 것이 없다. 그리고 stopAll은 rt.result를 null로 만드는데,
      // 그 null을 어댑터에 넘기면 첫 줄의 result.handle 역참조에서 TypeError가 나고 그것이
      // 배경 프라미스의 처리되지 않은 rejection이 된다. 여기서 끊는다 — 상태는 stopAll이
      // 이미 stopped로 적었으므로 덧쓰지 않는다.
      const result = rt.result;
      if (stopping || result === null) return false;
      // 프로세스가 있는 서비스는 죽으면 더 기다릴 이유가 없다. 핸들이 없는 서비스
      // (postgres 컨테이너, 채택한 외부 인스턴스)는 이 검사를 건너뛴다.
      if (result.handle !== null && !result.handle.alive()) {
        set(rt.spec.id, {
          process: "failed",
          health: "unknown",
          detail: exitedDetail(result.handle.exitCode(), result.handle.stderrTail()),
        });
        return false;
      }
      try {
        last = await rt.spec.readiness(result, ctx);
      } catch (e) {
        // 준비 판정도 바깥 자원을 본다 (postgres는 postmaster.pid를 읽고 psql로 확인, api는 HTTP). 그것이
        // 던지면 bringOnce가 통째로 거부해 아래의 실패 정리 — 자식을 치우고 rt.result를 null로
        // 되돌리는 줄 — 이 건너뛰어지고, 남은 rt.result가 재진입 가드에 걸려 그 서비스의 재시도를
        // 앱이 사는 내내 막는다. 게이트면 그 거부가 runFrom을 타고 start()까지 올라간다.
        // detectExternal과 probeHealth가 이미 그렇게 하듯, 예외도 실패 판정으로 받는다.
        last = { kind: "failed", detail: CAUSES.readinessThrew.text(reason(e)), recovery: recoveryOf(e) };
        log(`${rt.spec.id}: 준비 확인에서 예외 — ${reason(e)}`);
      }
      if (applyReadiness(rt.spec.id, last)) return true;
      if (last.kind === "failed") break;
      const now = Date.now();
      if (writer !== null && now - checkedAt >= pollMs) {
        downloadingNow = await downloading(writer);
        checkedAt = now;
      }
      // lastTick은 **조건 없이** 민다. 다운로드 중일 때만 멈춰 두면 그동안 흐른 시간이 다운로드가
      // 끝나는 순간 한 번에 delta로 들어와 유예를 즉시 태운다.
      const delta = now - lastTick;
      lastTick = now;
      if (!downloadingNow) spent += delta;
      if (spent >= timeoutMs) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    const detail = last.kind === "failed" ? last.detail : CAUSES.readyTimeout.text;
    const recovery = last.kind === "failed" ? last.recovery : undefined;
    set(rt.spec.id, { process: "failed", health: "unknown", detail, recovery });
    return false;
  }

  /**
   * ready 이후의 주기 재프로브 (스펙 §6.6·§8). 프로세스 축은 건드리지 않는다 — 프로세스는
   * 살아 있는데 일을 못 하는 상태가 정확히 degraded이고, 여기서 재시작을 걸면 DB가 돌아오지
   * 않는 한 같은 실패를 반복하며 백오프만 태운다. DB가 돌아오면 다음 프로브의 ready가
   * applyReadiness를 통해 스스로 ok로 되돌린다.
   */
  function scheduleHealthProbe(rt: Runtime, intervalMs: number): void {
    if (stopping) return;
    rt.healthTimer = arm(intervalMs, () => {
      void probeHealth(rt, intervalMs);
    });
  }

  async function probeHealth(rt: Runtime, intervalMs: number): Promise<void> {
    const result = rt.result;
    if (stopping || result === null) return;
    let r: ReadinessResult;
    try {
      r = await rt.spec.readiness(result, ctx);
    } catch (e) {
      // 프로브가 던지는 것도 판정이다. 여기서 새어 나가면 처리되지 않은 rejection이 된다.
      r = { kind: "failed", detail: CAUSES.healthProbeThrew.text(reason(e)) };
    }
    // await 사이에 종료가 지나갔을 수 있다. 그 뒤의 set은 이미 내려간 서비스를 되살려 적는다.
    if (stopping || rt.result === null) return;
    if (!applyReadiness(rt.spec.id, r)) {
      const detail = r.kind === "failed" ? r.detail : CAUSES.notAnswering.text;
      set(rt.spec.id, { health: "degraded", detail });
    }
    scheduleHealthProbe(rt, intervalMs);
  }

  /** ready를 안정 창만큼 유지하면 재시작 예산을 돌려준다. 근거는 DEFAULT_STABLE_RESET_MS. */
  function scheduleBudgetReset(rt: Runtime): void {
    disarm(rt.budgetTimer);
    rt.budgetTimer = null;
    if (rt.status.restarts === 0) return;
    const ms = hooks.stableResetMs ?? DEFAULT_STABLE_RESET_MS;
    rt.budgetTimer = arm(ms, () => {
      rt.budgetTimer = null;
      if (stopping || rt.status.process !== "running") return;
      log(`${rt.spec.id}: ${Math.round(ms / 1000)}초 동안 안정적이라 재시작 예산을 되돌린다`);
      set(rt.spec.id, { restarts: 0 });
    });
  }

  /**
   * 진행 중인 bring 전부. stopAll이 이것을 기다린 뒤에 내린다.
   *
   * 배경만이 아니라 **게이트도** 들어온다. 게이트 bring은 runFrom이 인라인으로 await하지만
   * 그 프라미스를 아는 것은 runFrom뿐이라, 등록하지 않으면 종료는 bring 진입부터 rt.result
   * 대입까지를 통째로 보지 못한다 — API는 그 구간이 부팅 전체라 수 초다. 스플래시에서 ⌘Q가
   * 정확히 그 창을 친다.
   */
  const pending = new Set<Promise<unknown>>();

  /**
   * bring을 배경으로 돌린다. 예외를 반드시 상태로 바꾼다 — 배경 프라미스의 rejection은
   * 아무도 잡지 않으면 Electron main의 uncaught exception이 되고, 하필 종료 경로에서 난다.
   * pending 등록은 여기서 하지 않는다. bring이 한다 — 게이트와 배경이 같은 한 줄을 쓰면
   * 한쪽만 등록에서 빠지는 일이 생길 수 없다.
   */
  function background(spec: ServiceSpec): void {
    void bring(spec).catch((e: unknown) => {
      const detail = reason(e);
      set(spec.id, { process: "failed", health: "unknown", detail });
      log(`${spec.id}: 배경 기동에서 예외 — ${detail}`);
    });
  }

  /**
   * 서비스마다 bring을 한 번에 하나만 돌리고(단일 비행), 그 프라미스를 pending에 남긴다.
   *
   * 단일 비행이 필요한 이유: bringOnce의 재진입 가드(rt.result !== null)는 launch가 **반환한
   * 뒤에야** 문다. 그 앞 구간 — detectExternal과 launch 자체 — 에 두 번째 bring이 들어오면
   * 둘 다 가드를 지나 프로세스가 두 벌 뜨고, 먼저 뜬 쪽의 유일한 참조인 rt.result가 덮어써져
   * stopAll이 그것을 영원히 못 찾는다. 메뉴의 "다시 시도"는 app.whenReady()에서 기동 시퀀스가
   * 끝나기 전에 이미 설치되므로, 부팅 중에 눌리는 것은 가정이 아니라 평범한 경로다.
   *
   * pending 등록도 같은 자리에 두는 이유는 pending 선언부 주석에 있다.
   */
  function bring(spec: ServiceSpec): Promise<boolean> {
    const rt = runtimes.get(spec.id)!;
    if (rt.inFlight !== null) return rt.inFlight;
    const p = bringOnce(spec);
    rt.inFlight = p;
    // pending에는 거부하지 않는 쪽을 넣는다. allSettled는 rejection을 견디지만, p에 처리기가
    // 하나도 붙지 않는 순간이 생기면 그것이 곧 처리되지 않은 rejection이다.
    const tracked = p.catch(() => undefined);
    pending.add(tracked);
    void tracked.finally(() => {
      if (rt.inFlight === p) rt.inFlight = null;
      pending.delete(tracked);
    });
    return p;
  }

  /**
   * 한 서비스를 띄우고 준비까지 본다. 게이트면 호출자가 await하고, 아니면 배경으로 돈다 —
   * embed는 bge-m3를 import 시점에 올려 30초 이상 걸리는데 그것을 직렬로 기다리면 창이 그만큼
   * 늦게 뜬다. 스펙 §6.7의 "게이트는 셋뿐"은 이 비대칭을 뜻한다.
   *
   * 직접 부르지 않는다. 겹침과 종료 가시성을 함께 다루는 bring()이 유일한 입구다.
   */
  async function bringOnce(spec: ServiceSpec): Promise<boolean> {
    const rt = runtimes.get(spec.id)!;
    if (stopping) return false;
    // 이미 우리가 쥔 인스턴스가 있으면 아무것도 하지 않는다. 두 번째 bring은 첫 핸들의
    // 유일한 참조인 rt.result를 덮어써 그 프로세스를 영원히 놓친다 (P2-C4).
    if (rt.result !== null) return rt.status.process === "running";
    disarm(rt.healthTimer);
    rt.healthTimer = null;
    disarm(rt.budgetTimer);
    rt.budgetTimer = null;

    let external: ExternalState;
    try {
      external = await spec.detectExternal(ctx);
    } catch (e) {
      // 외부 탐지도 바깥 명령을 돌린다 (worker는 ps). 여기서 던지면 서비스가 화면 문구도
      // 재시작도 없이 영영 기동 전 상태에 고정된다 — launch와 같게 실패로 적는다.
      const detail = CAUSES.externalCheckFailed.text(reason(e));
      set(spec.id, { process: "failed", health: "unknown", detail, recovery: recoveryOf(e) });
      log(`${spec.id}: detectExternal 실패 — ${reason(e)}`);
      return false;
    }
    if (stopping) return false;

    if (external.kind === "stand-down") {
      log(`${spec.id}: 외부 인스턴스가 있어 앱이 띄우지 않는다 — ${external.detail}`);
      set(spec.id, { process: "running", health: "unknown", owned: false, detail: external.detail });
      return true;
    }

    set(spec.id, { process: "starting", health: "unknown", recovery: undefined });
    if (external.kind === "adopt") {
      // 이미 떠 있는 외부 인스턴스를 쓴다 — launch()를 부르면 그 옆에 우리 것을 하나 더
      // 띄우는 꼴이라 "죽이지 않는다"는 약속과 어긋난다. owned를 false로 둬 stopAll이
      // 이 서비스를 건드리지 않게 한다 (스펙 §5).
      log(`${spec.id}: 외부 인스턴스를 채택했다 — ${external.detail}`);
      rt.result = { handle: null, owned: false };
    } else {
      try {
        rt.result = await spec.launch(ctx);
      } catch (e) {
        const detail = reason(e);
        set(spec.id, { process: "failed", health: "unknown", detail, recovery: recoveryOf(e) });
        log(`${spec.id}: 기동 실패 — ${detail}`);
        return false;
      }
    }
    set(spec.id, { owned: rt.result.owned });
    if (stopping) {
      // 종료가 이 await 사이를 지나갔다. 방금 만든 자식을 rt.result에 **남겨 둬야** 한다 —
      // 게이트든 배경이든 이 bring은 pending에 있어 stopAll이 먼저 기다리므로, 이 대입은
      // 역순 루프보다 반드시 먼저 보인다. 거기서 내려야 leaked가 정직해진다. 여기서 우리가
      // 몰래 치우면 그 결과가 StopOutcome에 실리지 않는다.
      log(`${spec.id}: 종료 중에 기동이 끝났다 — stopAll에 넘긴다`);
      return false;
    }

    if (await awaitReady(rt)) {
      log(`${spec.id}: 준비됨`);
      rt.everReady = true;
      watchForDeath(rt);
      scheduleBudgetReset(rt);
      if (spec.healthIntervalMs !== undefined) scheduleHealthProbe(rt, spec.healthIntervalMs);
      return true;
    }
    if (stopping) return false;
    // 준비 못 한 것은 우리가 띄웠으면 치운다. 남겨 두면 재시도가 그 위에 또 띄운다.
    if (rt.result !== null && rt.result.owned) {
      await spec.stop(rt.result, { graceMs: CLEANUP_GRACE_MS }).catch(() => undefined);
    }
    // 채택한 인스턴스도 참조를 끊는다 — 남겨 두면 위의 재진입 가드가 재시도를 막는다.
    rt.result = null;
    // 기동 중 실패한 **게이트**에는 재시작을 걸지 않는다. start()는 이미 반환했고 창은 실패
    // 화면이므로, 백오프 뒤 이 서비스만 running이 되어도 뒤 서비스는 영원히 안 뜬다. 그
    // 경우의 복구는 메뉴의 "다시 시도"다 (스펙 §6.8) — retry()가 그 진입점이다.
    // manual 실패에도 걸지 않는다 — 같은 판정이 반복되고, 반복이 도구를 또 부른다 (Phase 3 스펙 §6.7).
    if ((!spec.gate || rt.everReady) && rt.status.recovery !== "manual") scheduleRestart(spec, "기동 실패");
    return false;
  }

  /**
   * 자동 재시작(크래시)과 사람이 누른 재시작 둘 다 여기를 지난다. worker에만 돈다 —
   * `--once` 자식은 worker만 만든다. 스캔 실패·예외는 재시작을 막지 않는다.
   */
  async function reapOwnOnceBefore(id: ServiceId): Promise<void> {
    if (id !== "worker" || hooks.reapOwnOnce === undefined) return;
    try {
      const out = await hooks.reapOwnOnce();
      if ("failed" in out) log(`${id}: --once 자식 스캔에 실패했어요 — 재시작은 계속해요`);
      else if (out.reaped.length > 0) log(`${id}: 앞 실행의 --once 자식 ${out.reaped.length}개를 거뒀어요`);
    } catch (e) {
      log(`${id}: --once 자식 스캔이 던졌어요 — 재시작은 계속해요: ${reason(e)}`);
    }
  }

  /**
   * ready 이후에 죽으면 백오프로 다시 띄운다. 상한을 넘으면 failed로 고정하고 메뉴의 재시도를
   * 기다린다 (스펙 §6.8). postgres도 이 경로를 탄다 — 내장 어댑터의 restart가 [3s, 8s, 20s]이고,
   * 재시작도 launch()를 거치므로 고아·낡은 락 판정을 매번 다시 한다 (Phase 3 스펙 §6.4 재시작).
   */
  function scheduleRestart(spec: ServiceSpec, why: string): void {
    if (spec.restart === "never" || stopping) return;
    const rt = runtimes.get(spec.id)!;
    const attempt = rt.status.restarts;
    if (attempt >= spec.restart.maxAttempts) {
      log(`${spec.id}: 재시작 상한 ${spec.restart.maxAttempts}회를 넘겼다 — 수동 재시도를 기다린다`);
      return;
    }
    const delay = spec.restart.backoffMs[Math.min(attempt, spec.restart.backoffMs.length - 1)];
    set(spec.id, { restarts: attempt + 1 });
    log(`${spec.id}: ${why} — ${Math.round(delay / 1000)}초 뒤 재시작 (${attempt + 1}회차)`);
    rt.restartTimer = arm(delay, () => {
      rt.restartTimer = null;
      if (stopping) return;
      void reapOwnOnceBefore(spec.id).then(() => {
        // 스캔 동안 종료가 시작됐을 수 있다. 종료가 치운 것을 되살리지 않는다.
        if (stopping) return;
        background(spec);
      });
    });
  }

  /** ready 뒤 자식이 죽는 것을 감시한다. degraded는 여기 오지 않는다 — 프로세스는 살아 있다. */
  function watchForDeath(rt: Runtime): void {
    const handle = rt.result?.handle;
    if (handle === null || handle === undefined) return;
    handle.onExit((code) => {
      if (stopping) return;
      // **지금 쥔** 핸들의 죽음만 다룬다. restartService가 내린 옛 자식의 종료 이벤트는 우리가
      // 그 자식을 놓은 뒤에 도착하고(신호와 이벤트 사이에 await가 둘 있다), 그것을 그대로 처리하면
      // 이 아래 세 줄이 **새 인스턴스**를 failed로 적고 그 유일한 참조(rt.result)를 지운 뒤 백오프
      // 재시작까지 건다 — 사람이 부른 재시작 한 번이 아무도 못 찾는 자식 하나를 남긴다.
      if (rt.result?.handle !== handle) return;
      // 죽은 프로세스에 계속 물어볼 이유가 없다. 재기동한 bring이 새로 건다.
      disarm(rt.healthTimer);
      rt.healthTimer = null;
      disarm(rt.budgetTimer);
      rt.budgetTimer = null;
      set(rt.spec.id, {
        process: "failed",
        health: "unknown",
        detail: exitedDetail(code, handle.stderrTail()),
        recovery: undefined,
        // 기다리던 끝이 왔다. 이제 신호를 다시 보내도 파괴적이지 않다 — 받을 프로세스가 없다.
        // 아래 scheduleRestart가 보통은 스스로 다시 띄우지만, 예산을 다 썼으면 사람이 버튼으로
        // 마저 한다. 그래서 이 표시는 여기서 **반드시** 풀린다.
        cleaningUp: undefined,
      });
      rt.result = null;
      scheduleRestart(rt.spec, `종료 (코드 ${code})`);
    });
  }

  async function start(): Promise<void> {
    // prepare()를 전부 먼저 돌린다. embed의 포트 결정처럼 다른 서비스의 env가 그것에 의존한다.
    // 선언 순서와 무관하게 launch보다 먼저 끝난다.
    for (const spec of ordered) {
      if (spec.prepare === undefined) continue;
      Object.assign(ctx.env, await spec.prepare(ctx));
    }
    await runFrom(ordered);
  }

  /**
   * 메뉴의 "다시 시도" (스펙 §6.8). start()를 다시 부르는 것으로 때울 수 없다 — 그러면
   * prepare()가 전부 다시 돌아 embed의 포트가 **살아 있는 embed 밑에서** 바뀌고(Object.assign이
   * 호출자의 ctx.env를 제자리에서 고친다), 이미 running인 서비스 위에 두 번째 인스턴스가 떠서
   * 첫 핸들의 유일한 참조가 사라진다. 여기서는 prepare를 건너뛰고 아직 안 뜬 것부터 잇는다.
   */
  async function retry(): Promise<void> {
    if (stopping) return;
    await runFrom(ordered.filter((s) => needsRetry(runtimes.get(s.id)!)));
  }

  /**
   * 재시도가 다시 돌릴 서비스. running이 아닌 것, 그리고 **running인데 쥔 결과가 없는 것** —
   * 외부 인스턴스에 밀려 서지 않은(stand-down) 서비스다.
   *
   * 뒤의 절이 없으면 stand-down worker는 `running`이라 재시도가 영영 건너뛴다. 사용자가 상태 창의
   * 안내("터미널의 worker를 끄고 다시 시도하거나…")대로 터미널 worker를 끄고 재시도해도 아무 일도
   * 일어나지 않고, 앱은 다시 켤 때까지 자기 worker를 띄우지 않는다(P2-C6의 자연스러운 복구다).
   * 외부 worker가 아직 있으면 detectExternal이 다시 서지 않을 뿐이라 해가 없다.
   *
   * 채택한 서비스(`{handle: null, owned: false}`)와 앱이 띄운 서비스는 결과를 쥐고 있으므로 이 절에
   * 걸리지 않는다 — 걸리면 살아 있는 인스턴스 옆에 두 번째를 띄운다 (bringOnce의 재진입 가드는
   * rt.result로 막지만, 그 전에 여기서 거르는 것이 계약이다).
   */
  function needsRetry(rt: Runtime): boolean {
    return rt.status.process !== "running" || rt.result === null;
  }

  /**
   * 앱이 이 서비스를 **내릴 수 없나** (스펙 §6.10 2층). 감독자 안팎이 **이 한 함수**를 쓴다 —
   * 상태 창은 `statuses()`의 한 줄로 버튼의 활성 여부를 정하고(Task 11), restartService는
   * 같은 판정으로 거부한다. 둘을 따로 적으면 버튼이 켜져 있는데 눌러도 아무 일이 없는 상태가
   * 생긴다.
   *
   * 거부하는 것은 **앱이 소유하지 않는데 이미 판에 올라와 있는** 서비스다:
   *
   * - 채택한 외부 인스턴스 — 앱이 만들지 않은 프로세스다 (§5).
   * - stand-down — 외부 worker에 밀려 서지 않은 상태라 내릴 것이 없고, 여기서 bring을 걸면
   *   살아 있는 외부 worker 옆에 우리 것을 하나 더 띄운다. 그 길은 `retry()`의 것이다.
   *
   * `starting`을 함께 보는 이유: 채택은 `detectExternal` 직후에 정해지는데 그 서비스가 ready에
   * 닿기 전까지 상태는 `{starting, owned:false}`다. `running`만 보면 그 구간에 버튼이 켜지고,
   * 눌러도 감독자가 거부한다.
   *
   * 아직 뜨지 않은(failed·stopped) 서비스는 막지 않는다 — 그건 소유의 문제가 아니라 "띄운 적이
   * 없다"이고, restartService는 그것을 그냥 띄운다. 앱이 띄우는 중인 서비스도 막지 않는다
   * (`owned:true`), restartOnce가 진행 중인 bring을 먼저 기다린다.
   */
  function canRestart(rt: Runtime): boolean {
    return !restartRefused(rt.status);
  }

  /**
   * 한 서비스만 내렸다가 다시 띄운다 (스펙 §6.10의 2층 — 상태 창의 "서비스 다시 시작").
   *
   * `retry()`로는 안 된다. 그쪽의 needsRetry는 `process !== "running" || result === null`이라
   * **살아 있는 서비스를 건너뛴다**. 토큰을 바꾼 뒤 필요한 것은 정확히 그 반대다 — HF_TOKEN은
   * 자식 env로만 들어가므로(config.ts) 살아 있는 worker·embed는 옛 토큰을 쥔 채로 계속 돈다.
   *
   * 감독자 객체의 **메서드**다. 자유 함수로 만들 수 없다 — 클로저의 runtimes·bring이 필요하다.
   *
   * 거부는 던지지 않는다. Task 11의 applyTokenChange가 그것을 `skipped`로 적어야 하고, 예외로
   * 올리면 토큰 교체 전체가 한 서비스 때문에 실패한다. 까닭은 supervisor.log에 남는다.
   */
  function restartService(id: ServiceId): Promise<void> {
    const rt = runtimes.get(id)!;
    // 겹치면 **두 번째는 그 첫 번째를 기다린다.** 두 번 부르는 것은 버튼 두 번 클릭이고, 둘 다
    // 통과시키면 `specStop`이 두 번 돌아 같은 pid에 신호를 두 번 보낸다 — worker에게 그 두 번째는
    // 처리 중인 job을 requeue 없이 버리는 강제 종료다 (ServiceStatus.cleaningUp의 주석, P2-C5).
    if (rt.restartInFlight !== null) {
      log(`${id}: 이미 다시 시작하는 중이라 이 요청은 그것을 기다린다`);
      return rt.restartInFlight;
    }
    const p = restartOnce(id);
    rt.restartInFlight = p;
    // pending에 넣는다. 정지를 기다리는 구간은 bring 밖이라 등록이 없으면 그 창의 ⌘Q가
    // stopAll의 역순 루프보다 먼저 지나가고, 그러면 rt.result가 null인 서비스를 건너뛴 채
    // `stopped: true`로 보고한다 — 아직 신호를 받는 중인 자식이 있는데 종료 안내가 "깨끗하다"고
    // 적는다. Task 8이 그 정직함에 한 번 고쳐 낸 자리다.
    const tracked = p.catch(() => undefined);
    pending.add(tracked);
    void tracked.finally(() => {
      if (rt.restartInFlight === p) rt.restartInFlight = null;
      pending.delete(tracked);
    });
    return p;
  }

  async function restartOnce(id: ServiceId): Promise<void> {
    const rt = runtimes.get(id)!;
    const refuse = (): boolean => {
      if (canRestart(rt)) return false;
      if (rt.status.cleaningUp === true) {
        // 두 번째 신호는 정리가 아니라 강제 종료다. 그 프로세스가 끝날 때까지 기다린다 —
        // watchForDeath가 끝을 보면 이 표시를 지우고 버튼이 다시 열린다.
        log(`${id}: 아직 내려가는 중이라 다시 시작하지 않는다 — 두 번째 종료 신호는 강제 종료다`);
        return true;
      }
      log(`${id}: 앱이 소유하지 않은 인스턴스라 다시 시작하지 않는다 — ${rt.status.detail ?? "외부 인스턴스"}`);
      return true;
    };
    if (stopping) return;
    // **기다리기 전에** 한 번 본다. 버튼이 보는 것과 같은 판정이므로, 거부할 것이면 그 자리에서
    // 거부해야 한다 — 채택한 서비스의 bring은 ready까지 수십 초가 걸리고, 그 뒤에 거부하면
    // 사람은 버튼을 누른 뒤 아무 일도 안 일어나는 시간을 그만큼 본다.
    if (refuse()) return;
    // 진행 중인 bring을 먼저 끝낸다. 그 사이에 만들어지는 자식의 유일한 참조가 rt.result인데,
    // 그것을 우리가 먼저 지우면 아무도 그 프로세스를 못 찾는다 (stopAll이 pending을 기다리는 것과 같은 까닭).
    if (rt.inFlight !== null) await rt.inFlight.catch(() => undefined);
    if (stopping) return;
    // 기다리는 동안 채택·stand-down이 정해졌을 수 있다. 같은 판정을 다시 본다.
    if (refuse()) return;
    disarm(rt.healthTimer);
    rt.healthTimer = null;
    disarm(rt.budgetTimer);
    rt.budgetTimer = null;
    disarm(rt.restartTimer);
    rt.restartTimer = null;

    const result = rt.result;
    // 참조를 **먼저** 끊는다. 두 가지가 여기에 걸려 있다 — bringOnce의 재진입 가드
    // (`rt.result !== null`)가 아래 bring을 막지 않게 하는 것, 그리고 곧 도착할 옛 자식의 종료
    // 이벤트가 watchForDeath의 핸들 대조에서 걸러지게 하는 것.
    rt.result = null;
    if (result !== null) {
      log(`${id}: 다시 시작한다 — 내리는 중`);
      const out = await specStop(id, result);
      if (out === null || !out.stopped) {
        // **안 내려갔으면 다시 띄우지 않는다.** 띄우면 두 가지가 한꺼번에 깨진다 —
        //  - worker: bring의 detectExternal이 `listExternalWorkers`를 부르는데, 그것이 "우리 것"을
        //    빼는 근거는 `runtimeOf("worker").result.handle.pid`다(main.ts의 ownPid). rt.result가
        //    null인 지금 **죽어 가는 우리 worker가 외부 worker로 보여** stand-down이 되고,
        //    owned:false가 박혀 이 버튼이 스스로 영영 비활성이 된다. 토큰 교체(P4-C4)의 길이 거기서 끊긴다.
        //  - embed: 옛 자식이 포트를 쥔 채 유일한 참조를 잃고, 새 자식은 그 포트에서 bind에 넘어진다.
        // 그래서 참조를 되돌리고 상태는 살아 있는 그대로 둔 채 까닭만 싣는다.
        rt.result = result;
        // 원인 문구를 **머리로** 쓴다. 어댑터의 detail만 실으면 causeOf가 이 원인을 못 찾아
        // 화면의 안내가 사라진다 (exitedDetail이 같은 모양으로 머리 + 블록을 쓴다).
        const lines = [CAUSES.restartStopFailed.text(id)];
        if (out?.detail !== undefined) lines.push(out.detail);
        const leaked = out?.leaked ?? [];
        if (leaked.length !== 0) lines.push(`남은 pid: ${leaked.join(", ")}`);
        // **정리 중 표시.** 신호는 이미 갔다. 여기서 다시 누르게 두면 두 번째 신호가 가고,
        // worker는 그것을 강제 종료로 해석해 처리 중인 job을 requeue 없이 버린다
        // (ServiceStatus.cleaningUp의 주석, P2-C5). 프로세스가 실제로 끝나면 watchForDeath가 지운다.
        // 끝을 볼 핸들이 없으면(컨테이너처럼 프로세스가 아닌 것) 표시하지 않는다 — 지워 줄 사건이
        // 없어 영영 잠기고, 신호를 누적해 세는 것은 우리가 쥔 자식의 이야기다.
        const watchable = result.handle !== null;
        set(id, { detail: lines.join("\n"), ...(watchable ? { cleaningUp: true as const } : {}) });
        log(`${id}: 내려가지 않아 다시 띄우지 않는다 — ${lines.join(" / ")}`);
        // 끝을 지켜볼 수 있으면 그 사건 하나만 기다린다. 프로브를 다시 걸면 그것이 ready를 받아
        // 방금 실은 안내를 지운다(applyReadiness가 detail을 비운다). 지켜볼 수 없으면 서비스는
        // 평소대로 살아 있으므로 감시를 되돌린다.
        if (!watchable && rt.spec.healthIntervalMs !== undefined) {
          scheduleHealthProbe(rt, rt.spec.healthIntervalMs);
        }
        scheduleBudgetReset(rt);
        return;
      }
      set(id, { process: "stopped", health: "unknown", owned: false, detail: undefined, recovery: undefined });
    }
    if (stopping) return;
    // 사람이 명시적으로 부른 재시작이다. 예산도 새로 준다 (runFrom이 재시도에 하는 것과 같다).
    set(id, { restarts: 0 });
    await reapOwnOnceBefore(id);
    await bring(rt.spec);
  }

  /**
   * restartOnce의 정지 한 줄. 던지면 null이다 — 예외도 "안 내려갔다"의 한 모양이고, 호출부는
   * 그 둘을 같게 다룬다(되돌리고 다시 띄우지 않는다).
   */
  async function specStop(id: ServiceId, result: LaunchResult): Promise<StopOutcome | null> {
    const rt = runtimes.get(id)!;
    try {
      return await rt.spec.stop(result, { graceMs: RESTART_GRACE_MS });
    } catch (e) {
      log(`${id}: 다시 시작 중 정지에서 예외 — ${reason(e)}`);
      return null;
    }
  }

  /** 기동 시퀀스 본문. 게이트 의미(실패하면 뒤를 띄우지 않는다)는 여기 한 곳에만 있다. */
  async function runFrom(list: readonly ServiceSpec[]): Promise<void> {
    for (const spec of list) {
      const rt = runtimes.get(spec.id)!;
      // failed로 고정된 서비스는 예산을 다 썼다. 사람이 다시 시도했으니 예산도 새로 준다.
      if (rt.status.restarts !== 0 && rt.status.process !== "running") set(spec.id, { restarts: 0 });
      if (!spec.gate) {
        // 배경으로 돌린다. 실패해도 기동 전체를 멈추지 않는다.
        background(spec);
        continue;
      }
      if (!(await bring(spec))) return;
    }
  }

  async function stopAll(plan: StopPlan): Promise<StopOutcome> {
    stopping = true;
    // 진행 중인 launch() 안의 도구를 먼저 끝낸다. 아래 pending 대기가 그것을 기다리므로, 순서가 뒤면 멈춘 도구 하나가
    // 종료 전체를 붙잡는다 (Phase 3 스펙 §6.4).
    aborter.abort();
    for (const t of timers) clearTimeout(t);
    timers.clear();
    // 진행 중인 bring이 아직 있을 수 있다. 기다리지 않으면 그것이 **stopAll이 반환한 뒤에**
    // 프로세스를 만들고, 그 프로세스를 가리키는 유일한 참조(rt.result)는 아무도 읽지 않는다.
    // launchPython도 launchDev도 detached라 그런 자식은 Electron이 죽어도 살아남는다 (P2-C4).
    // stopping 검사만으로는 부족하다 — launch()가 반환하고 대입되기까지의 구간이 남는다.
    //
    // 한 번의 allSettled로 끝내지 않는다. 게이트 bring이 끝나면 runFrom이 그 자리에서 다음
    // 서비스의 bring을 새로 등록하므로, 스냅숏 하나만 기다리면 그 다음 것을 놓친다. stopping이
    // 이미 참이라 새 bring은 진입부에서 곧장 물러나고, 새 등록의 출처는 runFrom과 재시작
    // 타이머(역시 stopping을 본다)뿐이라 이 루프는 서비스 수만큼 돌고 빈다.
    while (pending.size > 0) await Promise.allSettled([...pending]);
    const leaked: number[] = [];
    // 왜 깨끗하지 않은지를 모은다. 이것을 버리면 종료 대화상자가 "고아가 살아 있다"와
    // "확인하지 못했다"와 "사람이 강제를 거절했다"를 같은 말로 적게 된다 (types.ts의
    // StopOutcome.detail). 어댑터가 애써 구분해 돌려준 것이 여기서 사라지면 그 구분은
    // 어디에도 없다.
    const details: string[] = [];
    let stopped = true;
    // 역순. dependsOn이 정한 순서를 뒤집는 것이 곧 의존 역순이다.
    for (const spec of [...ordered].reverse()) {
      const rt = runtimes.get(spec.id)!;
      // 앱이 만들지 않은 것은 건드리지 않는다 (스펙 §5).
      if (rt.result === null || !rt.result.owned) continue;
      try {
        const out = await spec.stop(rt.result, plan);
        if (!out.stopped) stopped = false;
        leaked.push(...out.leaked);
        if (out.detail !== undefined) details.push(out.detail);
      } catch (e) {
        // 하나가 던져도 나머지는 내린다 — 여기서 멈추면 앞선 서비스가 통째로 남는다.
        stopped = false;
        const why = `${spec.id}: 종료 중 예외 — ${reason(e)}`;
        // 화면에도 실어 보낸다. 로그 한 줄로 끝내면 사용자는 "깨끗하지 않다"만 보고
        // 무엇이 왜 실패했는지는 로그 파일을 열어야만 알 수 있다 — 던지는 stop은 leaked도
        // 비어 있어서 그 자리가 완전히 말이 없다.
        details.push(why);
        log(why);
      }
      rt.result = null;
      set(spec.id, { process: "stopped", health: "unknown", owned: false, cleaningUp: undefined });
    }
    return details.length === 0
      ? { stopped, leaked }
      : { stopped, leaked, detail: details.join("\n") };
  }

  return { start, retry, restartService, stopAll, statuses, runtimeOf: (id: ServiceId) => runtimes.get(id) };
}
