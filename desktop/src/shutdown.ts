import type { ServiceHandle, ServiceId, StopOutcome } from "./services/types";

export interface StopWorkerOptions {
  graceMs: number;
  pollMs: number;
  signal(pid: number, sig: NodeJS.Signals): void;
  descendants(rootPid: number): Promise<Set<number>>;
  /** 유예가 지났을 때 사람에게 묻는다. true면 강제 단계로 올라간다. */
  onGraceExpired(id: ServiceId): Promise<boolean>;
  /** 테스트가 폴링 횟수를 묶는다. */
  maxWaits?: number;
  /** 마지막으로 실제 생존을 확인한다. 기본은 handle.alive()만 본다. */
  stillAlive?(pids: number[]): Promise<number[]>;
}

/**
 * worker를 SIGKILL로 먼저 죽이면 안 된다. __main__.py:279가 --once 자식을
 * start_new_session=True로 띄우므로 프로세스 그룹 kill이 그 자식에 닿지 않고, supervisor를
 * 죽이면 자식과 그것이 띄운 mlx_lm.server가 고아로 남는다 (스펙 §6.9).
 *
 * 1. SIGTERM 1회 — supervisor가 자식에 전달하고 자식은 stage boundary에서 멈춰
 *    requeue_for_shutdown을 부른다. 그 경로가 attempts를 되돌린다.
 * 2. 유예 초과 → 사람에게 묻는다.
 * 3. 강제 → SIGTERM 2회차. supervisor가 자식을 kill하고 os._exit한다.
 * 4. 그래도 남으면 자손 집합에 SIGKILL. start_new_session은 세션만 바꾸고 부모-자식
 *    관계는 그대로라 ps의 ppid BFS가 여전히 찾아낸다.
 * 5. 그래도 남으면 pid를 돌려준다. 정리 실패를 조용히 넘기지 않는다.
 */
export async function stopWorkerProcess(
  handle: ServiceHandle,
  opts: StopWorkerOptions,
): Promise<StopOutcome> {
  const pid = handle.pid;
  // pid가 없으면 애초에 우리가 띄운 적이 없다 — 더 볼 것이 없다. 여기서 handle.alive()를
  // 같이 보지 않는다: brief 원안은 `pid === undefined || !handle.alive()`였는데, 그러면
  // "1단계 SIGTERM을 보낸 뒤 곧바로 죽는" 정상 케이스(아래 첫 테스트, aliveFor=0)조차
  // 진입 시점의 alive() 한 번으로 "이미 죽었다"로 오판해 SIGTERM을 아예 안 보내고
  // 끝내 버린다 — 실측: 이 줄을 브리프대로 두면 첫 테스트가 signals=[]로 실패한다.
  // pid가 있는 한 1단계를 시도한다. 이미 죽은 pid에 신호를 보내는 것은 공짜에
  // 가깝고(아래 waitForExit 루프의 첫 검사가 그 자리에서 바로 걸러낸다), 신호 전송
  // 자체의 실패는 주입받는 signal 구현(예: launchWithUv의 killGroup)의 책임이다.
  if (pid === undefined) return { stopped: true, leaked: [] };

  const waitForExit = async (ms: number): Promise<boolean> => {
    const limit = opts.maxWaits ?? Math.ceil(ms / opts.pollMs);
    for (let i = 0; i < limit; i += 1) {
      if (!handle.alive()) return true;
      await new Promise((r) => setTimeout(r, opts.pollMs));
    }
    return !handle.alive();
  };

  // 1단계. 음수 pid = 프로세스 그룹. launchWithUv가 detached로 띄우므로 pid가 그룹 리더다.
  opts.signal(-pid, "SIGTERM");
  if (await waitForExit(opts.graceMs)) return { stopped: true, leaked: [] };

  // 2단계.
  if (!(await opts.onGraceExpired("worker"))) return { stopped: false, leaked: [] };

  // 3단계. SIGKILL이 아니라 두 번째 SIGTERM이다.
  opts.signal(-pid, "SIGTERM");
  if (await waitForExit(opts.graceMs)) return { stopped: true, leaked: [] };

  // 4단계. 세션이 다른 자손까지 ppid BFS로 찾아 직접 죽인다.
  const tree = await opts.descendants(pid).catch(() => new Set<number>());
  for (const target of [pid, ...tree]) opts.signal(target, "SIGKILL");
  await new Promise((r) => setTimeout(r, opts.pollMs));

  // 5단계.
  const candidates = [pid, ...tree];
  const leaked =
    opts.stillAlive !== undefined
      ? await opts.stillAlive(candidates)
      : handle.alive()
        ? [pid]
        : [];
  return { stopped: leaked.length === 0, leaked };
}

export interface InFlight {
  recording: boolean;
  analysing: boolean;
}

export interface QuitDecision {
  quit: boolean;
  /** 종료 전에 렌더러의 라이브 중지를 완주시켜야 하는가. */
  stopRecording: boolean;
}

/**
 * 녹음·분석 둘 다 확인을 받는다. 한 번만 묻는다 — 둘이 동시에 진행 중이라고 대화상자를
 * 두 번 띄우면 사용자는 두 번째가 무엇에 대한 질문인지 모른다.
 */
export async function decideQuit(
  state: InFlight,
  ask: (message: string) => Promise<boolean>,
): Promise<QuitDecision> {
  if (!state.recording && !state.analysing) return { quit: true, stopRecording: false };

  const parts: string[] = [];
  if (state.recording) parts.push("녹음이 진행 중이에요");
  if (state.analysing) parts.push("분석이 진행 중이에요");
  const tail = state.recording
    ? "종료하면 녹음을 먼저 안전하게 마무리합니다."
    : "종료하면 진행 중인 분석을 안전한 지점에서 멈추고 다시 큐에 넣습니다.";

  const ok = await ask(`${parts.join(", ")}. ${tail} 종료할까요?`);
  return { quit: ok, stopRecording: ok && state.recording };
}

export type HandshakeResult =
  | { kind: "stopped" }
  | { kind: "failed"; detail: string }
  | { kind: "timeout" };

/**
 * 렌더러의 라이브 중지를 부르고 서버 ACK까지 기다린다. 실패하거나 시간을 넘기면 그 사실을
 * 돌려준다 — 그때는 sweeper 경로로 떨어지고, 다음 앱 실행 때 API가 뜨면 봉인·마감된다.
 * 종료 자체를 막지는 않는다 (스펙 §6.9).
 */
export async function runHandshake(
  call: () => Promise<{ stopped: boolean; reason?: string }>,
  opts: { timeoutMs: number },
): Promise<HandshakeResult> {
  const timeout = new Promise<HandshakeResult>((resolve) => {
    const t = setTimeout(() => resolve({ kind: "timeout" }), opts.timeoutMs);
    if (typeof t === "object" && "unref" in t) t.unref();
  });
  const work = (async (): Promise<HandshakeResult> => {
    try {
      const r = await call();
      // 창이 이미 파괴됐거나 훅이 없으면 여기로 온다. 성공으로 읽으면 안 된다.
      if (!r.stopped) return { kind: "failed", detail: r.reason ?? "이유를 알 수 없어요." };
      return { kind: "stopped" };
    } catch (e) {
      return { kind: "failed", detail: e instanceof Error ? e.message : String(e) };
    }
  })();
  return Promise.race([work, timeout]);
}
