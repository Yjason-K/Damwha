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
   * 진행 중인 bring(). 한 값이 두 가지를 막는다 — 같은 서비스에 두 번째 bring이 겹쳐 들어와
   * 프로세스를 두 벌 만드는 것, 그리고 bring 진입부터 rt.result 대입까지의 구간이 stopAll의
   * 시야 밖으로 새는 것. 둘 다 "아직 rt.result가 없는 동안"이라는 같은 창에서 벌어진다.
   */
  inFlight: Promise<boolean> | null;
}

export function createSupervisor(
  specs: readonly ServiceSpec[],
  ctx: LaunchContext,
  hooks: SupervisorHooks,
) {
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
        inFlight: null,
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
      set(id, { process: "running", health: "ok", detail: undefined });
      return true;
    }
    if (r.kind === "degraded") {
      // 재시작을 유발하지 않는다 — 재시작해도 의존이 돌아오지 않으면 같고 백오프만 태운다.
      set(id, { process: "running", health: "degraded", detail: r.detail });
      return true;
    }
    return false;
  };

  /**
   * Phase 1의 waitForReady를 쓰지 않는다. 그 함수의 결과 어휘는 API 하나를 위한 것
   * ("ready" / "db-unreachable" / "child-exited" / "timeout")이라 ReadinessResult 넷을
   * 그대로 실어 나를 수 없고, `failed`를 "db-unreachable"에 태워 조기 탈출시키는 식으로
   * 우회하면 다음 사람이 그 값을 DB 이야기로 읽는다. 폴링은 여기 여덟 줄이면 된다.
   */
  async function awaitReady(rt: Runtime): Promise<boolean> {
    const timeoutMs = rt.spec.readyTimeoutMs ?? hooks.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const intervalMs = hooks.readyIntervalMs ?? DEFAULT_READY_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
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
        const code = result.handle.exitCode();
        set(rt.spec.id, {
          process: "failed",
          health: "unknown",
          detail: `프로세스가 종료됐어요 (코드 ${code ?? "?"}).`,
        });
        return false;
      }
      try {
        last = await rt.spec.readiness(result, ctx);
      } catch (e) {
        // 준비 판정도 바깥 명령을 돌린다 (postgres는 docker compose ps, api는 HTTP). 그것이
        // 던지면 bringOnce가 통째로 거부해 아래의 실패 정리 — 자식을 치우고 rt.result를 null로
        // 되돌리는 줄 — 이 건너뛰어지고, 남은 rt.result가 재진입 가드에 걸려 그 서비스의 재시도를
        // 앱이 사는 내내 막는다. 게이트면 그 거부가 runFrom을 타고 start()까지 올라간다.
        // detectExternal과 probeHealth가 이미 그렇게 하듯, 예외도 실패 판정으로 받는다.
        last = { kind: "failed", detail: `준비 확인이 실패했어요 — ${reason(e)}` };
        log(`${rt.spec.id}: 준비 확인에서 예외 — ${reason(e)}`);
      }
      if (applyReadiness(rt.spec.id, last)) return true;
      if (last.kind === "failed") break;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    const detail = last.kind === "failed" ? last.detail : "준비 시간을 넘겼어요.";
    set(rt.spec.id, { process: "failed", health: "unknown", detail });
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
      r = { kind: "failed", detail: `상태 확인이 실패했어요 — ${reason(e)}` };
    }
    // await 사이에 종료가 지나갔을 수 있다. 그 뒤의 set은 이미 내려간 서비스를 되살려 적는다.
    if (stopping || rt.result === null) return;
    if (!applyReadiness(rt.spec.id, r)) {
      const detail = r.kind === "failed" ? r.detail : "준비 상태로 답하지 않아요.";
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
      const detail = `외부 인스턴스 확인이 실패했어요 — ${reason(e)}`;
      set(spec.id, { process: "failed", health: "unknown", detail });
      log(`${spec.id}: detectExternal 실패 — ${reason(e)}`);
      return false;
    }
    if (stopping) return false;

    if (external.kind === "stand-down") {
      log(`${spec.id}: 외부 인스턴스가 있어 앱이 띄우지 않는다 — ${external.detail}`);
      set(spec.id, { process: "running", health: "unknown", owned: false, detail: external.detail });
      return true;
    }

    set(spec.id, { process: "starting", health: "unknown" });
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
        set(spec.id, { process: "failed", health: "unknown", detail });
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
    if (!spec.gate || rt.everReady) scheduleRestart(spec, "기동 실패");
    return false;
  }

  /**
   * ready 이후에 죽으면 백오프로 다시 띄운다. 상한을 넘으면 failed로 고정하고 메뉴의 재시도를
   * 기다린다 (스펙 §6.8). postgres는 restart가 "never"다 — compose의 restart: unless-stopped가
   * 이미 그 일을 하고, 감독자가 둘이면 같은 컨테이너를 다툰다.
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
    arm(delay, () => {
      if (stopping) return;
      background(spec);
    });
  }

  /** ready 뒤 자식이 죽는 것을 감시한다. degraded는 여기 오지 않는다 — 프로세스는 살아 있다. */
  function watchForDeath(rt: Runtime): void {
    const handle = rt.result?.handle;
    if (handle === null || handle === undefined) return;
    handle.onExit((code) => {
      if (stopping) return;
      // 죽은 프로세스에 계속 물어볼 이유가 없다. 재기동한 bring이 새로 건다.
      disarm(rt.healthTimer);
      rt.healthTimer = null;
      disarm(rt.budgetTimer);
      rt.budgetTimer = null;
      set(rt.spec.id, {
        process: "failed",
        health: "unknown",
        detail: `프로세스가 종료됐어요 (코드 ${code}).`,
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
    await runFrom(ordered.filter((s) => runtimes.get(s.id)!.status.process !== "running"));
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
    for (const t of timers) clearTimeout(t);
    timers.clear();
    // 진행 중인 bring이 아직 있을 수 있다. 기다리지 않으면 그것이 **stopAll이 반환한 뒤에**
    // 프로세스를 만들고, 그 프로세스를 가리키는 유일한 참조(rt.result)는 아무도 읽지 않는다.
    // launchWithUv도 launchDev도 detached라 그런 자식은 Electron이 죽어도 살아남는다 (P2-C4).
    // stopping 검사만으로는 부족하다 — launch()가 반환하고 대입되기까지의 구간이 남는다.
    //
    // 한 번의 allSettled로 끝내지 않는다. 게이트 bring이 끝나면 runFrom이 그 자리에서 다음
    // 서비스의 bring을 새로 등록하므로, 스냅숏 하나만 기다리면 그 다음 것을 놓친다. stopping이
    // 이미 참이라 새 bring은 진입부에서 곧장 물러나고, 새 등록의 출처는 runFrom과 재시작
    // 타이머(역시 stopping을 본다)뿐이라 이 루프는 서비스 수만큼 돌고 빈다.
    while (pending.size > 0) await Promise.allSettled([...pending]);
    const leaked: number[] = [];
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
      } catch (e) {
        // 하나가 던져도 나머지는 내린다 — 여기서 멈추면 앞선 서비스가 통째로 남는다.
        stopped = false;
        log(`${spec.id}: 종료 중 예외 — ${reason(e)}`);
      }
      rt.result = null;
      set(spec.id, { process: "stopped", health: "unknown", owned: false });
    }
    return { stopped, leaked };
  }

  return { start, retry, stopAll, statuses, runtimeOf: (id: ServiceId) => runtimes.get(id) };
}
