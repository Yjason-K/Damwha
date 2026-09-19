import type { ServiceHandle, ServiceId, StopOutcome } from "./types";

export interface StopWorkerOptions {
  graceMs: number;
  pollMs: number;
  signal(pid: number, sig: NodeJS.Signals): void;
  descendants(rootPid: number): Promise<Set<number>>;
  /**
   * 유예가 지났을 때 사람에게 묻는다.
   *
   * - `true` → 강제 단계로 올라간다.
   * - `false` → **유예를 한 번 더 주고 다시 묻는다.** 대화상자의 "계속 기다리기"가 약속하는
   *   것이 그것이다. 예전에는 `false`가 "포기한다"였고, 그래서 사용자가 조심스러운 쪽을
   *   골랐는데 앱이 돌고 있는 job을 두고 나가 버렸다 — 버튼이 거짓말을 하는 쪽이 버튼이
   *   없는 것보다 나쁘다. 폭주하지 않는다: 한 바퀴 더 기다릴 때마다 사람의 클릭 한 번이 든다.
   * - **없으면** 강제하지 않고 그 자리에서 보고한다. 물어볼 사람이 없는 호출자가 실제로
   *   있다 — `supervisor.ts`의 `bringOnce`가 준비 못 한 자식을 치울 때
   *   `{graceMs: CLEANUP_GRACE_MS}`만 넘긴다. 그 경로에서 "다시 묻는다"를 적용하면 아무도
   *   답하지 않는 루프가 되어 기동 정리가 영영 끝나지 않는다. 이것이 boolean 하나로
   *   "기다린다"와 "물을 데가 없다"를 겸할 수 없는 이유다.
   */
  onGraceExpired?(id: ServiceId): Promise<boolean>;
  /** 테스트가 폴링 횟수를 묶는다. */
  maxWaits?: number;
  /** 주어진 pid 중 아직 살아 있는 것을 돌려준다. 안 주면 아래 기본 구현을 쓴다. */
  stillAlive?(pids: number[]): Promise<number[]>;
  /**
   * 호출자가 **진입 전에**, supervisor가 아직 살아 있던 시점에 찍어 둔 자손 집합.
   *
   * 이 모듈은 진입해서야 자손을 찍는데, 그때 supervisor가 이미 죽어 있으면 그 자손은
   * 벌써 pid 1로 재부모화되어 어떤 ppid BFS로도 보이지 않는다 (`--once` 자식은
   * `start_new_session=True`, 그 자식이 띄운 `mlx_lm.server`는 그 아래). 그 상태에서
   * "자손 없음"을 읽고 깨끗하다고 보고하면 고아를 남기고도 초록불이다 — 바로 그것이
   * Task 11이 이 모듈 밖으로 미룬 결함(N2)이고, 고칠 자리가 호출자라서 미뤄졌다.
   *
   * `undefined`와 빈 Set은 **다른 뜻**이다. 빈 Set은 "살아 있을 때 봤고 자손이 없었다",
   * `undefined`는 "찍어 두지 못했다" — 후자는 아래에서 깨끗하다고 보고하지 않는다.
   * supervisor가 살아서 진입한 보통 경로에서는 이 값을 쓰지 않는다: 그때는 이 모듈이
   * 직접 찍는 스냅샷이 더 새것이고, 낡은 집합을 합치면 그 사이 OS가 재사용한 pid를
   * "우리가 남긴 것"이라며 사람에게 보여 주게 된다 (스펙 §6.9 — 후보이지 증거가 아니다).
   */
  knownDescendants?: ReadonlySet<number>;
  /**
   * 이 모듈의 판단 기록. 스냅샷 실패처럼 결과값(`stopped:false`)만으로는 사후에 무엇이
   * 잘못됐는지 알 수 없는 사건이 여기로 간다.
   *
   * 기본값이 `console.error`인 것은 개발 편의일 뿐이다 — **패키징된 .app을 Finder로
   * 실행하면 Electron main의 stderr에는 받을 곳이 없고**, logs.ts의 회전 로그는 자식
   * 프로세스의 stdout/stderr만 파일로 보낸다. 그래서 프로덕션 호출자(main.ts)는 반드시
   * 이 구멍에 supervisor.log를 꽂는다. 이 seam을 Task 11이 아니라 지금 만드는 이유는
   * 그때는 꽂을 프로덕션 호출자가 없었기 때문이다.
   */
  log?(line: string): void;
}

/**
 * `StopOutcome.detail`에 실리는 이유. 종료 대화상자가 이 문장을 **그대로** 사람에게 보이므로
 * 여기가 곧 사용자 문구다. 한곳에 모아 두는 이유는 세 상태를 구분해 말하는 것이 이 필드의
 * 존재 이유 전부이기 때문이다 (types.ts의 StopOutcome.detail 주석).
 */
export const STOP_DETAIL = {
  /** 신호를 보냈는데도 살아 있는 것이 있다. */
  orphans: "종료 신호를 보냈지만 아직 살아 있는 프로세스가 있어요.",
  /** ps를 못 읽었다. 남은 것이 있는지 **없는지도** 모른다. */
  unverifiable: "프로세스 목록을 읽지 못해서, 남은 것이 있는지 확인하지 못했어요.",
  /** 물어볼 사람이 없어 강제로 올리지 않았다 (기동 실패 정리 경로). 화면에는 닿지 않는다. */
  unattended:
    "강제 종료 여부를 물을 수 있는 사람이 없어서 그대로 두었어요. 작업 처리기는 종료 신호를 받았으니 안전한 지점에 닿으면 스스로 끝납니다.",
  /** supervisor가 먼저 죽었고, 그 자식이 아직 살아 있다. */
  diedFirst: "작업 처리기가 먼저 종료돼서, 그 아래에 있던 프로세스가 남았어요.",
  /** supervisor가 먼저 죽었고, 우리는 그 자식을 본 적이 없다. */
  diedUnseen:
    "작업 처리기가 이미 종료된 뒤라, 그 아래에 남은 프로세스가 있는지 확인할 방법이 없었어요.",
} as const;

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
 * worker를 SIGKILL로 먼저 죽이면 안 된다. __main__.py의 `_spawn`이 --once 자식을
 * start_new_session=True로 띄우므로 프로세스 그룹 kill이 그 자식에 닿지 않고, supervisor를
 * 죽이면 자식과 그것이 띄운 LLM 서버(llm_entry)가 고아로 남는다 (스펙 §6.9).
 *
 * `handle.pid`는 **Python supervisor 자신**이다 (Phase 4 — process/python-launcher.ts). 중간 전달자가
 * 없고, launchPython이 `detached: true`로 띄우므로 supervisor가 자기 그룹의 리더다(pgid = pid).
 *
 * 0. 진입할 때, 그리고 1단계 유예가 지난 직후(사람에게 묻기 **전**)에 자손 집합을 찍어
 *    둔다 — 둘 다 방금 alive()로 supervisor 생존을 읽은 시점이다. 아래 어느 단계에서
 *    "깨끗하다"고 말하기 전에 그 집합이 아직 살아 있는지 되본다 — supervisor가 먼저
 *    죽으면 그 자손은 pid 1로 재부모화되어 사후 BFS로는 보이지 않는다. worker의 --once
 *    자식은 job마다 새로 뜨므로 진입 스냅샷 하나만으로는 그 사이 새로 뜬 자식을 놓친다.
 * 1. SIGTERM 1회 — supervisor가 자식에 전달하고 자식은 stage boundary에서 멈춰
 *    requeue_for_shutdown을 부른다. 그 경로가 attempts를 되돌린다. **supervisor의 pid로 직접
 *    보낸다, 그룹이 아니라.** 이유는 본문의 1단계 주석에 있다.
 * 2. 유예 초과 → 사람에게 묻는다. "계속 기다리기"면 유예를 한 번 더 주고 **다시 묻는다** —
 *    끝나는 길은 프로세스가 스스로 끝나거나 사람이 강제를 고르는 것뿐이다.
 * 3. 강제 → **트리를 한 번 더 걷고** SIGTERM 2회차(역시 supervisor의 pid). supervisor가 자식의
 *    프로세스 그룹을 kill하고 os._exit한다. 걷기가 신호보다 앞인 이유: 그 신호를 받은
 *    supervisor는 os._exit로 **반드시** 즉시 죽고, 그 뒤의 BFS는 재부모화된 자손을 못 본다.
 * 4. 방금 걸은 트리에서 살아 있는 것에 SIGKILL. start_new_session은 세션만 바꾸고 부모-자식
 *    관계는 그대로라 ps의 ppid BFS가 여전히 찾아낸다. **supervisor가 2회차에 죽었어도 돈다** —
 *    예전에는 죽으면 여기 오기 전에 반환했고, 2차 핸들러가 os._exit라 그 분기가 항상 참이라
 *    이 단계가 프로덕션에서 한 번도 돌지 않았다(P4-C20). 루트는 살아 있을 때만 때린다.
 * 5. 그래도 남으면 pid를 돌려준다. 정리 실패를 조용히 넘기지 않는다.
 *
 * 1·2·3단계의 기다림에서 supervisor가 **끝나면**, 그 자리에서 supervisor의 그룹(-pid)에 SIGTERM을
 * 한 번 보내 같은 그룹에 남은 짧은 자식(capabilities 프로브)을 거둔 뒤 판정한다 (cleanUnlessOrphans).
 * 살아 있는 동안에는 절대 그룹에 보내지 않는다.
 */
/**
 * 신호 뒤 "정말 없어졌나"를 몇 번까지 다시 볼 것인가 — 4단계 SIGKILL 뒤, 그리고 supervisor가
 * 끝난 뒤의 그룹 SIGTERM 뒤. 폴 간격(`pollMs`)마다 한 번씩 보므로 실제 상한은
 * `REAP_CHECKS * pollMs`다(프로덕션의 200ms로 1초). 상한이 있다는 사실이 요구사항이다 — 이
 * 루프가 무한이면 종료가 거둬지지 않는 좀비 하나에 영영 매달린다.
 */
const REAP_CHECKS = 5;

export async function stopWorkerProcess(
  handle: ServiceHandle,
  opts: StopWorkerOptions,
): Promise<StopOutcome> {
  const pid = handle.pid;
  // pid가 없으면 애초에 우리가 띄운 적이 없다. alive()도 같이 본다 — ProcessHandle의 alive()는
  // `code === null`이라 "자식이 끝났고 Node가 'exit'로 거둬들였다" 이후에만 false가 되고,
  // 바로 그 순간부터 OS는 그 pid를 재사용할 수 있다. 며칠씩 켜 두는 앱에서 이미 죽은
  // 핸들에 signal(pid, SIGTERM)을 쏘면 남의 프로세스를 때린다. 이 가드가
  // 정상 종료를 삼키는 것처럼 보였던 것은 테스트 픽스처 쪽 문제였다: 목의
  // `alive: () => ++calls <= aliveFor`에서 handle(0)은 첫 호출부터 false라
  // "이미 죽은 핸들"을 모형화한다 — "SIGTERM을 받고 곧 죽는다"는 handle(1)이다.
  if (pid === undefined) return { stopped: true, leaked: [] };

  /**
   * 주어진 pid 중 살아 있는 것. root는 handle이 권위 있게 답하므로 그쪽을 쓰고(공짜다),
   * 자손은 물어볼 핸들이 없어 존재만 확인한다. 주입이 있으면 그것을 쓴다.
   */
  const survivors = async (pids: number[]): Promise<number[]> => {
    if (pids.length === 0) return [];
    if (opts.stillAlive !== undefined) return opts.stillAlive(pids);
    return pids.filter((p) => (p === pid ? handle.alive() : processExists(p)));
  };

  if (!handle.alive()) {
    // 이 자리에서 자손을 찍어 봐야 소용이 없다 — supervisor가 죽은 순간 그 자식들은 pid 1로
    // 재부모화되어 ppid BFS에서 사라졌다. 그러므로 유일한 단서는 호출자가 **살아 있을 때**
    // 찍어 준 집합이다. Task 11은 여기서 무조건 {stopped:true, leaked:[]}를 돌려줬고, 그것이
    // 이월된 결함 N2다: supervisor가 먼저 죽은 종료는 고아를 남기고도 "깨끗함"으로 보고됐다.
    const known = opts.knownDescendants;
    if (known === undefined) {
      // 호출자가 찍어 두지 못했다. 자손이 없다는 것도 증명하지 못한 것이므로 깨끗하다고
      // 말하지 않는다 — 스냅샷 실패를 "자손 없음"으로 뭉개지 않는 것과 같은 규칙이다.
      return { stopped: false, leaked: [], detail: STOP_DETAIL.diedUnseen };
    }
    const orphans = await survivors([...known]);
    return orphans.length === 0
      ? { stopped: true, leaked: [] }
      : { stopped: false, leaked: orphans, detail: STOP_DETAIL.diedFirst };
  }

  // 자손 스냅샷을 한 곳으로 모은다. 실패(ps가 죽거나 타임아웃)를 "자손 없음"으로 뭉개면
  // 반대 방향의 실수가 된다 — main.ts의 verifyOwnListener가 소유를 증명 못 할 때 "아니오"로
  // 닫는 것과 같은 이유로, 여기서도 "확인 못 함"을 "깨끗함"으로 보고하지 않는다. 실패는
  // 그 자리에서 log()로 남기고, snapshotFailed로 기억해 뒀다가 이 함수가 반환하는 모든
  // "clean" 판정을 무효로 만든다. 사람에게는 STOP_DETAIL.unverifiable이 그 사실을 말한다 —
  // Task 11에는 그 자리가 없어(StopOutcome이 stopped/leaked뿐이었다) 이 상태가 "아무것도
  // 안 남았다"와 같은 값이었고, 기록도 console.error뿐이라 패키징된 .app에서는 받을 곳이
  // 없었다. 지금은 둘 다 호출자가 채운다: detail은 대화상자로, log는 supervisor.log로.
  let snapshotFailed = false;
  const log = opts.log ?? ((line: string) => console.error(line));
  const snapshotDescendants = async (): Promise<Set<number>> => {
    try {
      return await opts.descendants(pid);
    } catch (e) {
      snapshotFailed = true;
      log(
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
   * 살아남은 후보 목록 하나를 결과로 바꾼다. 두 실패 이유가 겹칠 수 있어 한 자리에 모은다 —
   * 고아도 있고 스냅샷도 실패했으면 둘 다 적는다. `detail`은 `stopped:false`일 때만 채운다.
   */
  const verdict = (leaked: number[]): StopOutcome => {
    const why: string[] = [];
    if (leaked.length > 0) why.push(STOP_DETAIL.orphans);
    if (snapshotFailed) why.push(STOP_DETAIL.unverifiable);
    return why.length === 0
      ? { stopped: true, leaked }
      : { stopped: false, leaked, detail: why.join(" ") };
  };

  /**
   * 후보 중 살아 있는 것을 **짧게, 상한을 두고** 다시 본다. 매 바퀴 후보를 직전 생존자로
   * 좁히므로 한 번 죽은 것으로 읽힌 pid를 다시 묻지 않는다(=OS가 그 번호를 재사용해도 안
   * 잡힌다). 한 번만 보면 **거둬지는 중일 뿐인 pid**가 사람에게 누수로 올라간다 — 신호는
   * 커널이 그 프로세스를 다음에 깨울 때 반영되고, 부모가 거둬들이기 전까지 `kill(pid,0)`은
   * 성공한다. 거짓 누수 보고는 진짜 누수와 똑같은 걱정을 사용자에게 지운다.
   */
  const settle = async (candidates: number[]): Promise<number[]> => {
    let left = candidates;
    for (let i = 0; i < REAP_CHECKS && left.length > 0; i += 1) {
      await new Promise((r) => setTimeout(r, opts.pollMs));
      left = await survivors(left);
    }
    return left;
  };

  /**
   * supervisor가 **방금** 끝났다 — 이 호출 안에서 alive()가 false를 읽은 직후에만 온다.
   *
   * 먼저 supervisor의 **프로세스 그룹**(-pid — launchPython의 `detached: true`로 supervisor가 그룹
   * 리더다)에 SIGTERM을 한 번 보내 같은 그룹에 남은 것을 거둔다. supervisor는 `start_new_session`
   * 없이도 짧은 자식을 띄운다 — `capabilities.probe_mps`가 데몬 스레드에서 `subprocess.run`으로
   * torch를 import하는 프로브(수십 초, 상한 120초)다. 1·3단계가 supervisor pid로만 보내므로 그 자식은
   * 신호를 받지 않고 supervisor보다 오래 살아, 기동 직후의 ⌘Q가 그것을 누수로 보고했다(P2-C4는 남은
   * 프로세스 0개를 요구한다). 2026-09-13 장난감 실측(당시 그룹 리더는 uv였다 — 그룹 신호의 커널
   * 의미는 리더가 누구든 같다): 리더가 끝난 뒤 그룹 SIGTERM → 같은 그룹의 자식은 200ms 안에
   * 사라졌고(5/5), `start_new_session` 자식은 그대로였다(1/1).
   *
   * **P4-C17의 프로브 회수는 이 신호 하나에 달려 있다.** 프로브는 `[sys.executable, "-c", …]`라 `-m`
   * 토큰도 `--run-id`도 없다 — 스펙 §6.5의 네 조건 중 둘(모듈·run-id)을 못 채워, argv 표식으로 훑는
   * 기동 시 고아 정리도 앱 종료 회수(B층, "내 run-id만")도 그것을 보지 못한다. 이 신호를 지우면
   * 프로브가 ⌘Q 뒤에 남는다 (tests/services/worker-shutdown.test.ts가 잠근다).
   *
   * 이 신호가 안전한 이유 셋.
   * - **이중 배달이 없다.** supervisor는 이미 끝났으므로 이것을 "두 번째"로 읽을 프로세스가 없다.
   *   살아 있는 동안 그룹에 보내면 안 되는 이유(1단계 주석)가 여기서는 성립하지 않는다.
   * - **우리 것에만 닿는다.** 그룹에 구성원이 하나라도 남아 있는 동안 그 번호는 새 pid로 배정되지
   *   않고, `kill(-pgid)`는 그 그룹 구성원 — 우리가 띄운 supervisor의 자손 중 setsid하지 않은 것 — 에만
   *   닿는다. `--once` 자식(`start_new_session=True`)은 닿지 않으므로 아래의 보고 전용 경로가 그대로
   *   다룬다. 그룹이 이미 비었으면 신호는 ESRCH이고, 그 번호가 풀린 뒤 신호까지의 창은 폴 한 번
   *   (`pollMs`)을 넘지 않는다.
   * - **진입 때 이미 죽어 있던 핸들에는 보내지 않는다.** 그 경로는 언제 죽었는지 모르므로 이 창에
   *   상한이 없다 — 위의 진입 가드가 신호 없이 끝낸다.
   *
   * 그 뒤 찍어 둔 자손이 남아 있으면 깨끗한 종료가 아니다. 스냅샷을 한 번이라도 못 찍었으면
   * (snapshotFailed) 자손이 없다는 것도 증명 못 한 것이므로 "비어 있으니 깨끗하다"고 말하지 않는다.
   * 방금 보낸 신호가 반영될 시간을 settle이 준다 — 같은 실측에서 신호 직후의 `kill(pid,0)`은
   * 5번 모두 아직 성공했다.
   */
  const cleanUnlessOrphans = async ({ reap }: { reap: boolean } = { reap: true }): Promise<StopOutcome> => {
    if (reap) opts.signal(-pid, "SIGTERM");
    const candidates = [...capturedDescendants];
    const first = await survivors(candidates);
    return verdict(await settle(first));
  };

  const waitForExit = async (ms: number): Promise<boolean> => {
    const limit = opts.maxWaits ?? Math.ceil(ms / opts.pollMs);
    for (let i = 0; i < limit; i += 1) {
      if (!handle.alive()) return true;
      await new Promise((r) => setTimeout(r, opts.pollMs));
    }
    return !handle.alive();
  };

  // 1단계. **양수 pid — supervisor에 직접 보낸다.** 중간 전달자가 없으므로 보낸 수가 곧 받는 수다.
  // 그 수가 뜻을 갖는다: supervisor의 핸들러(__main__.py:_on_signal)는 받은 SIGTERM을 세어 첫 번째는
  // --once 자식에 terminate를 전달하고(→ stage boundary에서 requeue_for_shutdown), 두 번째는 "강제"로
  // 읽어 자식을 proc.kill()하고 os._exit(1)한다 — 이 한 번이 두 번이 되면 job이 돌고 있을 때 requeue가
  // 영영 안 돌아 P2-C5가 결정적으로 깨진다.
  //
  // 그룹(-pid)으로 보내지 않는다. supervisor가 살아 있는 동안 그 그룹에는 supervisor가 세션 분리 없이
  // 띄운 짧은 자식(capabilities 프로브)이 함께 있고, 그것을 거두는 자리는 supervisor가 **끝난 뒤**의
  // cleanUnlessOrphans 한 곳이다. --once 자식은 start_new_session이라 원래 그룹 밖이고, LLM 서버는 그
  // 자식의 세션에 있다 — 그룹 신호가 여기서 더 닿게 해 주는 것은 없다.
  // (Phase 2의 uv 런처 시절에는 `pid`가 uv였고, 그룹 신호는 커널이 한 번, uv가 전달해 또 한 번 —
  // supervisor에 두 번 닿았다(2026-09-13 실측 5/5). 전달자가 다시 끼면 그 이유가 되살아난다.)
  opts.signal(pid, "SIGTERM");
  if (await waitForExit(opts.graceMs)) return cleanUnlessOrphans();

  // 2단계. 유예가 지날 때마다 **다시 묻는다.** 사람이 "계속 기다리기"를 고르면 실제로
  // 기다린다 — 유예를 한 번 더 주고, 그 유예도 지나면 또 묻는다. 이 루프가 끝나는 길은
  // 둘뿐이다: 프로세스가 스스로 끝나거나(깨끗), 사람이 강제를 고르거나(3단계). 무한히 도는
  // 것처럼 보이지만 한 바퀴마다 사람의 클릭 한 번이 들어가므로 폭주하지 않는다.
  for (;;) {
    // 재스냅샷. worker의 --once 자식은 job마다 새로 뜨므로 앞선 스냅샷만으로는 그 사이 새로
    // 뜬 자식을 놓친다. 이 자리인 이유는 **방금 waitForExit이 마지막 alive()로 "아직 살아
    // 있다"를 읽고 돌아왔기** 때문이다 — supervisor가 살아 있어야 그 자손이 ppid BFS에
    // 보인다. 바로 아래 onGraceExpired는 사람이 답할 때까지 시간 제한 없이 막히는 네이티브
    // 대화상자라, 그 뒤로 옮기면 이 근거가 사라진다: 대화상자가 떠 있는 동안 supervisor가
    // 죽고 자손이 pid 1로 재부모화되면 OS는 그 pid들을 재사용할 수 있고, 그때 도는 BFS는
    // **남의 프로세스**를 capturedDescendants에 합쳐 5단계가 그것을 "우리가 남긴 pid"라며
    // 사람에게 보여 준다. 매 바퀴 찍는 것도 같은 이유다 — 기다리는 동안에도 시간은 간다.
    // 대화상자 동안 새로 뜨는 --once 자식을 놓치는 것은 감수한다: 그 시점의 supervisor는
    // 이미 SIGTERM을 받아 새 job을 집지 않고 requeue 중이다. 신호를 보내는 게 아니라 뒤의
    // "깨끗함" 판정이 참고할 후보 집합에 합칠 뿐이다 — 실제로 죽일 대상(4단계)은 그 자리에서
    // 다시 걷는 트리를 쓴다.
    capturedDescendants = new Set([...capturedDescendants, ...(await snapshotDescendants())]);

    const askUser = opts.onGraceExpired;
    if (askUser === undefined) {
      // 물어볼 사람이 없다. 여기서 계속 기다리면 기동 실패 정리가 영영 끝나지 않는다.
      // 이 시점의 프로세스는 방금 alive()로 확인한 살아 있는 프로세스이므로 pid를 싣는다 —
      // types.ts가 leaked를 "화면과 로그에 적을 pid"로 정의하는데 빈 배열을 돌려주면
      // 무엇이 남았는지를 말하지 못한다.
      return { stopped: false, leaked: [pid], detail: STOP_DETAIL.unattended };
    }
    const force = await askUser("worker");
    // 대화상자는 시간 상한이 없다. 그동안 supervisor가 스스로 끝났을 수 있고, 그랬다면 **언제**
    // 끝났는지 모른다 — 그룹이 비어 pgid 번호가 풀린 지 오래일 수 있어 그룹 신호의 "폴 한 번 안"이라는
    // 근거가 여기서는 성립하지 않는다(최종 재리뷰 I-A). 3단계의 SIGTERM도 마찬가지로 받을 사람이
    // 없다. 그래서 여기서 죽어 있으면 **아무 신호도 보내지 않고** 찍어 둔 자손의 생존만 보고한다.
    // 루트의 생존은 handle.alive()가 권위 있게 답한다 — 거둬지지 않은 자식의 pid는 재사용되지 않는다.
    if (!handle.alive()) return cleanUnlessOrphans({ reap: false });
    if (force) break;

    // "계속 기다리기". **신호를 다시 보내지 않는다** — 이미 SIGTERM을 받고 stage boundary로
    // 가는 중이고, 두 번째 SIGTERM은 supervisor가 자식을 kill하고 os._exit하게 만드는
    // 강제(3단계)다. 기다리겠다는 답에 그것을 보내면 버튼이 또 거짓말을 하게 된다.
    if (await waitForExit(opts.graceMs)) return cleanUnlessOrphans();
  }

  // 3단계. SIGKILL이 아니라 두 번째 SIGTERM이다. 1단계와 같이 supervisor에 직접 보낸다 — 중간 전달자가
  // 없으므로 보낸 수가 곧 받는 수이고, supervisor가 받는 것이 정확히 "두 번째"다.
  //
  // 그 신호를 보내기 **직전**에 트리를 한 번 더 걷는다. 지금이 supervisor가 살아 있는 마지막
  // 순간이기 때문이다 — 2차 SIGTERM을 받은 supervisor는 자식을 죽이고 `os._exit(1)`하므로
  // **반드시** 즉시 끝나고, 그 뒤의 ppid BFS는 pid 1로 재부모화된 자손을 영영 못 본다.
  // 이 자리가 4단계가 죽일 수 있는 가장 신선한 집합이고, 낡기는 유예(graceMs) 한 번만큼이다.
  const tree = await snapshotDescendants();
  // 판정에도 쓰인다 — cleanUnlessOrphans는 capturedDescendants만 되보므로, 합치지 않으면
  // 여기서 처음 본 자손이 "깨끗함" 판정에서 빠진다.
  capturedDescendants = new Set([...capturedDescendants, ...tree]);
  opts.signal(pid, "SIGTERM");
  const exited = await waitForExit(opts.graceMs);

  // 4단계. 세션이 다른 자손까지 ppid BFS로 찾아 직접 죽인다. 여기서 죽일 대상은 방금 걸은
  // 트리다 — 그보다 앞선 스냅샷들은 유예 두 번과 (시간 제한 없는) 대화상자만큼 낡아서, 그
  // 사이 끝난 pid를 OS가 재사용했다면 SIGKILL이 남의 프로세스로 간다. 낡은 스냅샷은
  // "죽었나"를 읽는 데만 쓰고 죽이지는 않는다.
  //
  // **supervisor가 2차 SIGTERM에 죽었어도 건너뛰지 않는다.** 예전에는 이 자리가
  // `if (await waitForExit(...)) return cleanUnlessOrphans();`였는데, supervisor의 2차
  // 핸들러가 `os._exit`라 그 분기가 **항상** 참이었다 — 4단계는 프로덕션에서 한 번도 돌지
  // 않는 죽은 코드였고, P4-C20이 그것을 실측했다(SIGTERM 무시 자손이 196초+ 생존, ppid=1,
  // 화면에는 "후보 pid"로 보고만 됐다). 그 자손을 거둘 사람이 여기뿐인 이유는 supervisor가
  // 2차 신호에서 `--once` 자식을 SIGKILL하기 때문이다 — 자식이 즉사하면 worker 자신의 정리
  // (`managed_llm_server`의 finally → `_stop`: terminate→wait→kill)가 안 돈다.
  //
  // 루트는 **살아 있을 때만** 때린다. 죽은 뒤에는 Node가 이미 거둬들였고 그 번호는 재사용될 수 있다.
  for (const target of exited ? [...tree] : [pid, ...tree]) opts.signal(target, "SIGKILL");

  // supervisor가 끝났으면 그룹 신호로 같은 그룹의 짧은 자식(capabilities 프로브)까지 거두고
  // 판정한다 — 위 스윕이 세션 밖 자손을 맡고, 이쪽이 그룹 안을 맡는다 (P4-C17).
  if (exited) return cleanUnlessOrphans();

  // 5단계. 지금까지 찍어 둔 스냅샷들도 후보에 넣는다 — 그때 우리 자손이었는데 끝까지
  // 살아 있다면 그 사이 부모를 잃어 BFS에서 사라졌더라도 여전히 우리가 남긴 프로세스다.
  // **한 번만 보지 않는다** — SIGKILL도 반영과 거둬들임에 시간이 든다 (settle 주석).
  return verdict(await settle([...new Set([pid, ...tree, ...capturedDescendants])]));
}

/**
 * 종료 진입 전에 찍어 두는 worker 자손 스냅샷. 마지막으로 **성공한** 집합을 들고 다닌다.
 *
 * 규칙 셋이 전부이고, 셋 다 하중을 받는다.
 * - supervisor가 살아 있을 때만 찍는다. 죽은 뒤의 BFS는 재부모화된 자손을 못 보고, 그
 *   사이 OS가 재사용한 pid를 우리 것이라며 주워 올 수 있다.
 * - 실패(ps 타임아웃)는 **이전 성공을 덮지 않는다.** 덮으면 늦은 실패 하나가 일찍 찍어 둔
 *   유일한 증거를 지운다.
 * - 못 찍었으면 `undefined`를 그대로 유지한다 — stopWorkerProcess가 그것을 "확인 못 함"으로
 *   읽어 깨끗하다고 보고하지 않는다.
 *
 * 두 번 부른다 (quit-flow.ts): 종료 흐름에 들어가자마자 한 번(확인 대화상자는 시간 상한이
 * 없어서, 그 뒤에 찍으면 대화상자가 떠 있는 동안 죽은 supervisor의 자손을 영영 못 본다),
 * 그리고 서비스를 내리기 **직전**에 한 번(가장 새것이라 pid 재사용 위험이 가장 작다).
 */
export async function captureDescendants(
  previous: ReadonlySet<number> | undefined,
  deps: {
    pid(): number | undefined;
    alive(): boolean;
    descendants(rootPid: number): Promise<Set<number>>;
    log(line: string): void;
  },
): Promise<ReadonlySet<number> | undefined> {
  const pid = deps.pid();
  if (pid === undefined || !deps.alive()) return previous;
  try {
    return await deps.descendants(pid);
  } catch (e) {
    deps.log(
      `[shutdown] 종료 전 worker 자손 스냅샷 실패 — ${e instanceof Error ? e.message : String(e)}`,
    );
    return previous;
  }
}
