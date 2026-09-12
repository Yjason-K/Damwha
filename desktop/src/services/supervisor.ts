import type {
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
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_READY_INTERVAL_MS = 400;

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
      },
    ]),
  );

  /** 종료가 시작되면 재시작을 걸지 않는다. 종료가 방금 치운 것을 타이머가 되살리면 안 된다. */
  let stopping = false;
  const timers = new Set<NodeJS.Timeout>();

  const statuses = () => ordered.map((s) => ({ ...runtimes.get(s.id)!.status }));
  const emit = () => hooks.onStatus?.(statuses());
  const log = (line: string) => hooks.log?.(line);

  const set = (id: ServiceId, patch: Partial<ServiceStatus>) => {
    const rt = runtimes.get(id)!;
    rt.status = { ...rt.status, ...patch };
    emit();
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
      // 프로세스가 있는 서비스는 죽으면 더 기다릴 이유가 없다. 핸들이 없는 서비스
      // (postgres 컨테이너)는 이 검사를 건너뛴다.
      if (rt.result?.handle !== null && rt.result?.handle !== undefined && !rt.result.handle.alive()) {
        const code = rt.result.handle.exitCode();
        set(rt.spec.id, {
          process: "failed",
          health: "unknown",
          detail: `프로세스가 종료됐어요 (코드 ${code ?? "?"}).`,
        });
        return false;
      }
      last = await rt.spec.readiness(rt.result!, ctx);
      if (applyReadiness(rt.spec.id, last)) return true;
      if (last.kind === "failed") break;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    const detail = last.kind === "failed" ? last.detail : "준비 시간을 넘겼어요.";
    set(rt.spec.id, { process: "failed", health: "unknown", detail });
    return false;
  }

  /** 배경으로 도는 비게이트 준비 대기. stopAll이 기다릴 수 있게 모아 둔다. */
  const pending = new Set<Promise<void>>();

  /**
   * 한 서비스를 띄우고 준비까지 본다. 게이트면 호출자가 await하고, 아니면 배경으로 돈다 —
   * embed는 bge-m3를 import 시점에 올려 30초 이상 걸리는데 그것을 직렬로 기다리면 창이 그만큼
   * 늦게 뜬다. 스펙 §6.7의 "게이트는 셋뿐"은 이 비대칭을 뜻한다.
   */
  async function bring(spec: ServiceSpec): Promise<boolean> {
    const rt = runtimes.get(spec.id)!;
    const external = await spec.detectExternal(ctx);
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
        const detail = e instanceof Error ? e.message : String(e);
        set(spec.id, { process: "failed", health: "unknown", detail });
        log(`${spec.id}: 기동 실패 — ${detail}`);
        return false;
      }
    }
    set(spec.id, { owned: rt.result.owned });

    if (await awaitReady(rt)) {
      log(`${spec.id}: 준비됨`);
      watchForDeath(rt);
      return true;
    }
    // 준비 못 한 것은 우리가 띄웠으면 치운다. 남겨 두면 재시도가 그 위에 또 띄운다.
    if (rt.result !== null && rt.result.owned) {
      await spec.stop(rt.result, { graceMs: 5_000 }).catch(() => undefined);
      rt.result = null;
    }
    scheduleRestart(spec, "기동 실패");
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
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopping) return;
      const p = bring(spec).then(() => undefined);
      pending.add(p);
      void p.finally(() => pending.delete(p));
    }, delay);
    timers.add(timer);
  }

  /** ready 뒤 자식이 죽는 것을 감시한다. degraded는 여기 오지 않는다 — 프로세스는 살아 있다. */
  function watchForDeath(rt: Runtime): void {
    const handle = rt.result?.handle;
    if (handle === null || handle === undefined) return;
    handle.onExit((code) => {
      if (stopping) return;
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

    for (const spec of ordered) {
      if (!spec.gate) {
        // 배경으로 돌린다. 실패해도 기동 전체를 멈추지 않는다.
        const p = bring(spec).then(() => undefined);
        pending.add(p);
        void p.finally(() => pending.delete(p));
        continue;
      }
      if (!(await bring(spec))) return;
    }
  }

  async function stopAll(plan: StopPlan): Promise<StopOutcome> {
    stopping = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
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
        log(`${spec.id}: 종료 중 예외 — ${e instanceof Error ? e.message : String(e)}`);
      }
      rt.result = null;
      set(spec.id, { process: "stopped", health: "unknown", owned: false });
    }
    return { stopped, leaked };
  }

  return { start, stopAll, statuses, runtimeOf: (id: ServiceId) => runtimes.get(id) };
}
