/**
 * worker는 포트가 없어 Phase 1의 소유 판정 기구(isPortOccupied / verifyOwnListener)를 쓸 수
 * 없다. 대신 ps의 커맨드라인을 본다 (스펙 §6.5).
 *
 * 판정은 **허용 목록**이다. 처음 구현은 `damwha_worker`를 포함한 줄을 모두 잡고 잡음을
 * 하나씩 빼는 거부 목록(`--once`, `grep|ps`, `^uv\s+run`)이었는데, 거부 목록은 브리프가
 * 문자 그대로 지목한 두 모양만 막고 나머지는 샜다. 2026-09-12 실측으로 확인한 누수:
 *
 *   19645 /bin/zsh -c … eval '/opt/homebrew/bin/uv run … python -m damwha_worker' …
 *   19651 /opt/homebrew/bin/uv run --directory …/be/worker python -m damwha_worker
 *   19652 …/be/worker/.venv/bin/python3 -m damwha_worker          ← 이것만 supervisor다
 *
 * 거부 목록은 셋을 다 반환했다. 19651이 특히 나쁘다 — **앱이 자기 worker를 띄우는 기본
 * 모양**이다. Task 2의 findExecutable은 언제나 절대 경로를 돌려주고 Task 8의
 * launchWithUv는 그 절대 경로(`ctx.bins.uv`)로 spawn하므로 앱의 런처 줄은 늘
 * `/opt/homebrew/bin/uv run …`이고, `^uv\s+run` 앵커는 여기에 매치하지 않는다.
 * 19645는 커맨드 텍스트 안에 `-m damwha_worker`를 그대로 갖고 있어 문자열 기반 필터로는
 * 원리적으로 구분이 안 된다.
 *
 * 오탐의 대가가 비대칭이라 방향을 이렇게 잡는다: 이 함수가 하나라도 반환하면 호출부는
 * "외부 supervisor가 있다"는 부울 판정으로 서고, 앱은 자기 worker를 **영영 띄우지
 * 않는다**. 그래서 "supervisor란 무엇인가"를 적어 두고 그것만 통과시킨다.
 */

/**
 * argv[0]의 basename이 이 모양이어야 supervisor다 — `python`, `python3`, `python3.12`.
 *
 * Phase 4 주의: 번들 Python 런타임이 venv의 python을 대체하면 그 실행 파일 이름도
 * 반드시 `python*`이어야 한다. 이름이 바뀌는 순간 이 감지는 supervisor를 하나도 못
 * 알아보고, 앱은 외부 worker가 이미 돌고 있는데도 그 옆에 두 번째 worker를 띄운다.
 */
const PYTHON_EXECUTABLE = /^python(\d+(?:\.\d+)*)?$/;

/** `ps -axo pid,command`의 한 줄. 헤더("  PID COMMAND")와 빈 줄은 여기서 걸러진다. */
const PS_ROW = /^\s*(\d+)\s+(\S.*?)\s*$/;

/**
 * supervisor 줄의 정의. 세 조건을 모두 만족해야 한다 — 위 실측 모양들과 브리프가 적은
 * 두 모양(`/opt/homebrew/bin/python3.12 -m damwha_worker`, `… --once`) 전부 대조했다.
 *
 *  - argv[0]의 basename이 python 실행 파일이다. uv 런처(`…/uv run … python -m …`)와
 *    텍스트로만 모듈을 언급하는 셸 줄(`/bin/zsh -c … damwha_worker …`)이 여기서 빠진다.
 *    둘 다 인자로 `-m damwha_worker`를 그대로 갖고 있어 다른 조건으로는 못 거른다.
 *  - `-m damwha_worker`가 **토큰 쌍**으로 있다. `grep damwha_worker`처럼 모듈 이름만
 *    언급하는 줄이 빠진다.
 *  - `--once` 토큰이 없다. __main__.py:279가 자식을
 *    `[sys.executable, "-m", "damwha_worker", "--once"]`로 띄우므로, 이것을 상시
 *    supervisor로 세면 job 하나를 처리 중인 자식 때문에 앱이 영영 안 띄운다.
 *    토큰 비교라 `--once-ish` 같은 문자열에는 걸리지 않는다.
 */
function isWorkerSupervisor(tokens: readonly string[]): boolean {
  const argv0 = tokens[0];
  if (argv0 === undefined) return false;
  if (!PYTHON_EXECUTABLE.test(argv0.slice(argv0.lastIndexOf("/") + 1))) return false;
  if (tokens.includes("--once")) return false;
  return tokens.some((token, i) => token === "-m" && tokens[i + 1] === "damwha_worker");
}

/**
 * `ps -axo pid,command` 출력에서 **우리 것이 아닌** worker supervisor의 pid를 고른다.
 *
 * `ourPids`는 "우리가 띄운 프로세스 전부"다 — 자손만이 아니다. process/process-tree.ts의
 * `descendantPids(root)`는 frontier를 `[root]`로 시작해 **자식만** result에 넣으므로
 * root 자신은 반환값에 들어 있지 않다. `verifyOwnListener`도 그것을
 * 알고 호출부에서 root를 도로 합친다 — `pid === childPid || descendants.has(pid)`
 * (process/own-listener.ts). 이 함수의 호출부(Task 12)도 똑같이 해야 한다:
 *
 *     const ours = await descendantPids(handle.pid);
 *     ours.add(handle.pid);        // ← 이 줄이 없으면 런처 root가 안 빠진다
 *     parseWorkerProcesses(psText, ours);
 *
 * 지금은 root가 uv라서 위 허용 목록이 어차피 걸러 주지만 그것은 우연이다. 앱이 python을
 * 직접 spawn하는 순간(Phase 4의 번들 런타임) root 자신이 supervisor 줄이 되고, 그때
 * `ourPids`에 root가 없으면 앱은 **자기가 띄운 worker를 외부 인스턴스로 보고** 스스로
 * 서서 worker를 영영 안 띄운다. bringOnce가 detectExternal을 다시 도는 경로(준비 실패
 * 정리, exit/재시작 타이머)가 이 판정을 되풀이하므로 한 번 어긋나면 영구적이다.
 */
export function parseWorkerProcesses(psOutput: string, ourPids: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (const line of psOutput.split("\n")) {
    const row = PS_ROW.exec(line);
    if (row === null) continue;
    const pid = Number(row[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!isWorkerSupervisor(row[2].split(/\s+/))) continue;
    if (ourPids.has(pid)) continue;
    out.push(pid);
  }
  return out;
}

export interface WorkerScanDeps {
  /** `ps -axo pid,command`의 출력. */
  ps(): Promise<string>;
  /** 우리가 띄운 worker 런처의 pid. 아직 안 띄웠으면 undefined. */
  ownPid(): number | undefined;
  /** process/process-tree.ts의 descendantPids. root는 **빼고** 자손만 돌려준다. */
  descendants(rootPid: number): Promise<Set<number>>;
}

/**
 * 지금 돌고 있는 **우리 것이 아닌** worker supervisor의 pid.
 *
 * 배선(ps 실행, 자손 조회)이 아니라 판정이 여기 있는 이유: ourPids를 채우는 두 줄이 이
 * 판정의 전부인데, 그 두 줄을 main.ts에 두면 어떤 테스트도 그것을 부를 수 없다 —
 * main.ts는 electron을 값으로 import해 vitest가 못 불러온다(shell-window.ts:1). 그러면
 * `ours.add(pid)`를 지워도 위 parseWorkerProcesses 테스트는 전부 초록으로 남는다. 그
 * 테스트들은 ourPids를 **손으로** 받으므로 집합을 누가 채우는지는 보지 않기 때문이다.
 */
export async function listExternalWorkers(deps: WorkerScanDeps): Promise<number[]> {
  const ours = new Set<number>();
  const pid = deps.ownPid();
  if (pid !== undefined) {
    // root 자신을 반드시 넣는다. descendants(root)는 자식만 돌려주므로 이 줄이 없으면
    // 우리가 띄운 supervisor가 "외부 worker"로 분류되고, 스펙 §6.5의 stand-down이 우리
    // 자신을 향해 발화해 앱이 worker를 영영 띄우지 않는다 (P2-C6). verifyOwnListener가
    // main.ts에서 `pid === childPid || descendants.has(pid)`로 하는 것과 같은 보정이다.
    ours.add(pid);
    for (const d of await deps.descendants(pid)) ours.add(d);
  }
  return parseWorkerProcesses(await deps.ps(), ours);
}

/**
 * "분석 중"의 판정 그 자체. `ps -axo pid,command` 출력과 우리 worker의 자손 집합을 받아,
 * 그중에 `--once` 자식이 있는가를 본다 (스펙 §6.9 — 새 API 엔드포인트를 만들지 않는다).
 *
 * `tree`에 없는 pid는 보지 않는 것이 이 함수의 절반이다. 명령줄만 훑으면 **외부** worker의
 * `--once` 자식도 잡히는데, 그 job은 우리가 소유하지 않으므로 우리 종료가 확인을 받을
 * 이유가 없다. 나머지 절반은 `--once`를 낱말 경계로 보는 것이다 — `--once-only` 같은 다른
 * 인자나 경로 문자열 안의 `--once`를 부분 문자열로 잡으면 진행 중이 아닌 종료가 매번
 * 확인을 묻는다.
 *
 * main.ts가 아니라 여기 있는 이유: electron을 값으로 import하는 파일은 vitest가 못 불러온다
 * (shell-window.ts:1). 저 자리에 두면 정규식을 `/--once/`로 넓히는 변이도, `tree.has` 한 줄을
 * 지우는 변이도 초록불로 살아남는다 — listExternalWorkers·verifyOwnListener를 모듈로 뺀 것과
 * 같은 분리다.
 */
export function hasOnceChild(psOutput: string, tree: ReadonlySet<number>): boolean {
  for (const line of psOutput.split("\n")) {
    const t = line.trim();
    const space = t.indexOf(" ");
    if (space <= 0) continue;
    if (!tree.has(Number(t.slice(0, space)))) continue;
    if (/(^|\s)--once(\s|$)/.test(t.slice(space + 1))) return true;
  }
  return false;
}
