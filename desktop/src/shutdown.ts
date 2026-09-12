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
  /** 주어진 pid 중 아직 살아 있는 것을 돌려준다. 안 주면 아래 기본 구현을 쓴다. */
  stillAlive?(pids: number[]): Promise<number[]>;
}

/**
 * signal 0은 아무 신호도 배달하지 않고 "그 pid가 존재하는가"만 커널에 묻는다. ESRCH만
 * 죽음이다 — EPERM은 "살아 있는데 내 것이 아니다"라는 뜻이라 살아 있는 쪽으로 센다.
 * 판정이 틀리는 방향도 안전한 쪽이다: 없는 것을 있다고 하면 사람에게 pid를 한 번 더
 * 보여줄 뿐이고, 반대로 뭉개면 살아남은 프로세스를 조용히 놓친다.
 */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * worker를 SIGKILL로 먼저 죽이면 안 된다. __main__.py:279가 --once 자식을
 * start_new_session=True로 띄우므로 프로세스 그룹 kill이 그 자식에 닿지 않고, supervisor를
 * 죽이면 자식과 그것이 띄운 mlx_lm.server가 고아로 남는다 (스펙 §6.9).
 *
 * 0. 진입할 때, 그리고 1단계 유예가 지난 직후(사람에게 묻기 **전**)에 자손 집합을 찍어
 *    둔다 — 둘 다 방금 alive()로 supervisor 생존을 읽은 시점이다. 아래 어느 단계에서
 *    "깨끗하다"고 말하기 전에 그 집합이 아직 살아 있는지 되본다 — supervisor가 먼저
 *    죽으면 그 자손은 pid 1로 재부모화되어 사후 BFS로는 보이지 않는다. worker의 --once
 *    자식은 job마다 새로 뜨므로 진입 스냅샷 하나만으로는 그 사이 새로 뜬 자식을 놓친다.
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
  // pid가 없으면 애초에 우리가 띄운 적이 없다. alive()도 같이 본다 — ApiHandle의 alive()는
  // `code === null`이라 "자식이 끝났고 Node가 'exit'로 거둬들였다" 이후에만 false가 되고,
  // 바로 그 순간부터 OS는 그 pid를 재사용할 수 있다. 며칠씩 켜 두는 앱에서 이미 죽은
  // 핸들에 signal(-pid, SIGTERM)을 쏘면 남의 프로세스 그룹을 때린다. 이 가드가
  // 정상 종료를 삼키는 것처럼 보였던 것은 테스트 픽스처 쪽 문제였다: 목의
  // `alive: () => ++calls <= aliveFor`에서 handle(0)은 첫 호출부터 false라
  // "이미 죽은 핸들"을 모형화한다 — "SIGTERM을 받고 곧 죽는다"는 handle(1)이다.
  if (pid === undefined || !handle.alive()) return { stopped: true, leaked: [] };

  // 자손 스냅샷을 한 곳으로 모은다. 실패(ps가 죽거나 타임아웃)를 "자손 없음"으로 뭉개면
  // 반대 방향의 실수가 된다 — main.ts의 verifyOwnListener가 소유를 증명 못 할 때 "아니오"로
  // 닫는 것과 같은 이유로, 여기서도 "확인 못 함"을 "깨끗함"으로 보고하지 않는다.
  // StopOutcome에는 stopped/leaked 두 필드뿐이라 실패 사유를 실어 보낼 자리가 없다 —
  // 그래서 실패는 그 자리에서 console.error로 남기고, snapshotFailed로 기억해 뒀다가 이
  // 함수가 반환하는 모든 "clean" 판정을 무효로 만든다. 다만 그 console.error가 실제로
  // 읽히는 것은 **터미널에서 띄웠을 때뿐이다**: 패키징된 .app을 Finder로 실행하면 메인
  // 프로세스의 stderr에는 받을 곳이 없고, logs.ts의 회전 로그는 자식 프로세스의
  // stdout/stderr만 파일로 보낸다. 즉 이 줄은 개발 모드의 단서이지 사후 조사용 기록이
  // 아니다 — 사람에게 도달하는 신호는 stopped:false 하나뿐이고, 그것을 화면에 어떻게
  // 적을지는 종료 대화상자를 가진 Task 13이 정한다.
  let snapshotFailed = false;
  const snapshotDescendants = async (): Promise<Set<number>> => {
    try {
      return await opts.descendants(pid);
    } catch (e) {
      snapshotFailed = true;
      console.error(
        `[shutdown] worker 자손 스냅샷 실패 — 이 종료를 "확인됨"으로 보고하지 않는다: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return new Set<number>();
    }
  };

  // 진입 스냅샷. supervisor가 아직 살아 있는 지금이 그 자손을 볼 수 있는 시점 중 하나다.
  // supervisor가 먼저 죽으면 --once 자식(start_new_session)과 그 자식이 띄운 mlx_lm.server는
  // 곧바로 pid 1로 재부모화되고, 그 뒤에 도는 ppid BFS는 영영 그들을 찾지 못한다. 그래서
  // "깨끗하게 끝났다"고 말하기 전에 이 집합이 아직 살아 있는지 되본다 — 이 확인이 없으면
  // supervisor가 스스로 죽은 경우(크래시, 신호 핸들러 경쟁)에 고아를 남겨 두고도
  // {stopped:true, leaked:[]}를 보고한다. 비용은 worker 종료당 ps 한 번(이미 1초 상한)으로
  // SIGTERM 유예에 비하면 무시할 만하다.
  let capturedDescendants = await snapshotDescendants();

  /**
   * 주어진 pid 중 살아 있는 것. root는 handle이 권위 있게 답하므로 그쪽을 쓰고(공짜다),
   * 자손은 물어볼 핸들이 없어 존재만 확인한다. 주입이 있으면 그것을 쓴다.
   */
  const survivors = async (pids: number[]): Promise<number[]> => {
    if (pids.length === 0) return [];
    if (opts.stillAlive !== undefined) return opts.stillAlive(pids);
    return pids.filter((p) => (p === pid ? handle.alive() : processExists(p)));
  };

  /** supervisor는 죽었다. 지금까지 찍어 둔 자손 스냅샷이 남아 있으면 깨끗한 종료가 아니다.
   *  스냅샷을 한 번이라도 못 찍었으면(snapshotFailed) 자손이 없다는 것도 증명 못 한
   *  것이므로 "비어 있으니 깨끗하다"고 말하지 않는다. */
  const cleanUnlessOrphans = async (): Promise<StopOutcome> => {
    const orphans = await survivors([...capturedDescendants]);
    return { stopped: orphans.length === 0 && !snapshotFailed, leaked: orphans };
  };

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
  if (await waitForExit(opts.graceMs)) return cleanUnlessOrphans();

  // 재스냅샷. worker의 --once 자식은 job마다 새로 뜨므로 진입 스냅샷 이후에 새로 뜬 자식은
  // 그 스냅샷만으로는 안 보인다. 이 자리인 이유는 **방금 waitForExit이 마지막 alive()로
  // "아직 살아 있다"를 읽고 돌아왔기** 때문이다 — supervisor가 살아 있어야 그 자손이 ppid
  // BFS에 보인다. 바로 아래 onGraceExpired는 사람이 답할 때까지 시간 제한 없이 막히는
  // 네이티브 대화상자라, 그 뒤로 옮기면 이 근거가 사라진다: 대화상자가 떠 있는 동안
  // supervisor가 죽고 자손이 pid 1로 재부모화되면 OS는 그 pid들을 재사용할 수 있고, 그때
  // 도는 BFS는 **남의 프로세스**를 capturedDescendants에 합쳐 5단계가 그것을 "우리가 남긴
  // pid"라며 사람에게 보여 준다. 대화상자 동안 새로 뜨는 --once 자식을 놓치는 것은 감수한다
  // — 그 시점의 supervisor는 이미 SIGTERM을 받아 새 job을 집지 않고 requeue 중이다.
  // 신호를 보내는 게 아니라 뒤의 "깨끗함" 판정이 참고할 후보 집합에 합칠 뿐이다 — 실제로
  // 죽일 대상(4단계)은 그 자리에서 다시 걷는 트리를 쓴다.
  capturedDescendants = new Set([...capturedDescendants, ...(await snapshotDescendants())]);

  // 2단계. 사람이 거절하면 여기서 멈춘다. 다만 이 시점의 프로세스는 방금 alive()로 확인한
  // 살아 있는 프로세스다 — types.ts:67이 leaked를 "화면과 로그에 적을 pid"로 정의하는데
  // 빈 배열을 돌려주면 화면은 "깨끗하지 않다"고만 말하고 무엇을 죽여야 할지는 말하지 못한다.
  if (!(await opts.onGraceExpired("worker"))) return { stopped: false, leaked: [pid] };

  // 3단계. SIGKILL이 아니라 두 번째 SIGTERM이다.
  opts.signal(-pid, "SIGTERM");
  if (await waitForExit(opts.graceMs)) return cleanUnlessOrphans();

  // 4단계. 세션이 다른 자손까지 ppid BFS로 찾아 직접 죽인다. 여기서 죽일 대상은 방금 다시
  // 걸은 트리다 — 스냅샷들은 유예만큼 낡아서, 그 사이 끝난 pid를 OS가 재사용했다면 SIGKILL이
  // 남의 프로세스로 간다. 스냅샷은 "죽었나"를 읽는 데만 쓰고 죽이지는 않는다.
  const tree = await snapshotDescendants();
  for (const target of [pid, ...tree]) opts.signal(target, "SIGKILL");
  await new Promise((r) => setTimeout(r, opts.pollMs));

  // 5단계. 지금까지 찍어 둔 스냅샷들도 후보에 넣는다 — 그때 우리 자손이었는데 끝까지
  // 살아 있다면 그 사이 부모를 잃어 BFS에서 사라졌더라도 여전히 우리가 남긴 프로세스다.
  const candidates = [...new Set([pid, ...tree, ...capturedDescendants])];
  const leaked = await survivors(candidates);
  return { stopped: leaked.length === 0 && !snapshotFailed, leaked };
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

  // 무엇이 진행 중인지와, 각각에 무엇을 약속하는지를 따로 모은다. 약속을 삼항으로 고르면
  // 둘 다 진행 중일 때 한쪽이 통째로 사라진다 — 녹음이 있으면 분석 문장이 밀려나, 정작
  // "분석은 다시 큐에 넣는다"는 보장이 가장 필요한 상황에서 그 말을 하지 않게 된다.
  // 낱말 조사는 "녹음"·"분석" 둘 다 받침이 있어 "과"/"이"로 고정이다.
  const nouns: string[] = [];
  const promises: string[] = [];
  if (state.recording) {
    nouns.push("녹음");
    promises.push("종료하면 녹음을 먼저 안전하게 마무리합니다.");
  }
  if (state.analysing) {
    nouns.push("분석");
    promises.push("진행 중인 분석은 안전한 지점에서 멈추고 다시 큐에 넣습니다.");
  }

  const ok = await ask(`${nouns.join("과 ")}이 진행 중이에요. ${promises.join(" ")} 종료할까요?`);
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
