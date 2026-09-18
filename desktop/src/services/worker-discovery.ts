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
 * 모양**이었다(Phase 2 — 앱은 uv를 탐색으로 찾은 절대 경로로 spawn했으므로 앱의 런처 줄은 늘
 * `/opt/homebrew/bin/uv run …`이었고, `^uv\s+run` 앵커는 여기에 매치하지 않았다).
 * 19645는 커맨드 텍스트 안에 `-m damwha_worker`를 그대로 갖고 있어 문자열 기반 필터로는
 * 원리적으로 구분이 안 된다.
 *
 * 오탐의 대가가 비대칭이라 방향을 이렇게 잡는다: 이 함수가 하나라도 반환하면 호출부는
 * "외부 supervisor가 있다"는 부울 판정으로 서고, 앱은 자기 worker를 **영영 띄우지
 * 않는다**. 그래서 "supervisor란 무엇인가"를 적어 두고 그것만 통과시킨다.
 *
 * 2026-09-19(P4-C21) 실측이 **반대 방향의 대가**도 재 봤다. 놓치면 앱이 외부 worker 옆에
 * 자기 worker를 띄워 **두 supervisor가 같은 job 큐를 문다** — 그쪽이 더 비싸다. 그래서
 * 허용 목록의 축을 **이름에서 구조로** 옮겼다(아래 `isWorkerSupervisor`): argv[0]의 이름은
 * 보지 않고, `-m damwha_worker`가 argv[0] **바로 뒤**에 오는가만 본다. 위 세 모양은 그
 * 구조 조건에서 똑같이 갈린다.
 *
 * **이 완화는 이 파일에만 있다.** process/orphans.ts의 조건 1(basename `python3.12`)은 그대로다 —
 * 그쪽 소비자는 **죽이는** 쪽이라, 넓히면 앱이 손댈 의향이 있는 프로세스의 범위가 넓어진다.
 * 여기 소비자는 "우리 것이 아닌 worker가 도는가"만 묻고 신호를 하나도 보내지 않는다 (판정 R-12b).
 */

import { psRows, splitPsArgs } from "../process/orphans";

/**
 * argv[0]의 basename이 python 실행 파일의 이름인가 — `python`, `python3`, `python3.12`.
 *
 * **이것은 더 이상 판정 조건이 아니다.** 아래 `READINGS`에서 argv[0]의 경계를 찾는 **판독**에만
 * 쓴다(가장 정확한 판독이라 맨 먼저 시도한다). 이름이 다른 인터프리터는 뒤의 두 판독이 받는다.
 *
 * 조건에서 내린 까닭 — 2026-09-19 Task 12 P4-C21 실측. 문서가 적은 웹 흐름대로 터미널에서
 * `pnpm worker`를 띄우면 `ps`의 argv[0]이 이렇게 나온다:
 *
 *   /opt/homebrew/Cellar/python@3.12/3.12.14/Frameworks/Python.framework/Versions/3.12/
 *     Resources/Python.app/Contents/MacOS/Python -m damwha_worker
 *
 * `be/worker/.venv/bin/python3`이 **심볼릭 링크**라 커널이 argv[0]에 해결된 실체를 적고, 그 실체의
 * basename은 `Python`(대문자)이다. 이름 규칙은 이 줄을 목록에서 빼 버렸고, 앱은 외부 worker가
 * 이미 큐를 물고 있는데도 자기 worker를 띄웠다 (P2-C6·스펙 §6.5 처분표 3행 위반).
 */
const PYTHON_EXECUTABLE = /^python(\d+(?:\.\d+)*)?$/;

function isPythonExecutable(argv0: string): boolean {
  return PYTHON_EXECUTABLE.test(argv0.slice(argv0.lastIndexOf("/") + 1));
}

/**
 * 조건 1을 대신하는 **구조** 조건. `-m damwha_worker`가 argv[0] **바로 뒤**에 와야 한다 —
 * 사이에는 인터프리터 옵션 플래그(`-E -s -u` 같은 것)만 올 수 있다.
 *
 * 이름 규칙이 하던 일을 그대로 받는다. 이름은 `/bin/zsh -c …`·`…/uv run … python -m …`처럼
 * **인자로** 모듈 토큰을 갖고 있는 줄을 거르려고 있었는데, 그 줄들은 argv[0] 바로 뒤가
 * 옵션 플래그가 아니라는 점에서도 똑같이 갈린다:
 *
 *   /bin/zsh              -c …                → `-c`는 스크립트를 받는다. 그 뒤는 인터프리터 인자가 아니다.
 *   /opt/homebrew/bin/uv  run --directory …   → `run`은 플래그가 아니다.
 *   /usr/bin/grep         -rn damwha_worker … → 패턴 인자가 플래그가 아니다.
 *   /usr/bin/python3      tool.py -m damwha_worker → 스크립트 뒤의 `-m`은 우리 모듈 실행이 아니다.
 *
 * `-c`가 든 플래그 묶음(`-c`, `-sc`)을 거부하는 것과 `-m`을 만나면 그 자리에서 판정하는 것이
 * 이 규칙의 전부다. process/orphans.ts의 `moduleOf`와 같은 뜻인데, 그쪽은 모듈 셋을 보고
 * 여기는 supervisor 모듈 하나만 본다 — **저쪽은 죽이는 경로**라 사본을 합치지 않는다.
 */
function runsWorkerModule(tokens: readonly string[]): boolean {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-m") return tokens[i + 1] === "damwha_worker";
    if (!/^-[A-Za-z]+$/.test(token) || /[cm]/.test(token)) return false;
  }
  return false;
}

/**
 * supervisor 줄의 정의. 세 조건을 모두 만족해야 한다.
 *
 *  - argv[0]이 비어 있지 않다. **이름은 보지 않는다** (위 PYTHON_EXECUTABLE 주석 — P4-C21).
 *  - `-m damwha_worker`가 argv[0] 바로 뒤의 **토큰 쌍**으로 있다(`runsWorkerModule`). 모듈 이름만
 *    언급하는 줄(`grep damwha_worker`)과 그것을 인자로 나르는 셸·uv 줄이 여기서 빠진다.
 *  - `--once` 토큰이 없다. __main__.py:279가 자식을
 *    `[sys.executable, "-m", "damwha_worker", "--once"]`로 띄우므로, 이것을 상시
 *    supervisor로 세면 job 하나를 처리 중인 자식 때문에 앱이 영영 안 띄운다.
 *    토큰 비교라 `--once-ish` 같은 문자열에는 걸리지 않는다.
 */
function isWorkerSupervisor(tokens: readonly string[]): boolean {
  const argv0 = tokens[0];
  if (argv0 === undefined || argv0 === "") return false;
  if (tokens.includes("--once")) return false;
  return runsWorkerModule(tokens);
}

/**
 * `ps`의 평탄한 args 한 줄을 argv로 되돌리는 **판독 셋**. `splitPsArgs`에 넘기는 술어만 다르고,
 * 순서는 정확한 것 → 넓은 것이다. 하나라도 supervisor로 읽히면 supervisor다 (`readsAsSupervisor`).
 *
 *  1. `isPythonExecutable` — 지금까지의 판독 그대로. 아는 번들 접두사(규칙 1)와 공백 든 python* 경로
 *     (규칙 3)가 여기서 정확히 잘린다.
 *  2. `argv0.includes(" ")` — 공백 든 경로인데 이름이 python*이 **아닌** 경우. 술어가 공백 없는
 *     후보를 물리치므로 `splitPsArgs`의 규칙 2가 비켜서고 규칙 3(` -m ` 앞을 읽는다)이 돈다.
 *     규칙 3의 자체 가드(절대 경로여야 하고 ` /`·` -`를 품으면 거부)가 셸·uv·grep 줄을 그대로 막는다.
 *  3. `() => true` — 첫 토큰이 통째로 argv[0]인 줄(공백 없는 경로). **실측한 `…/MacOS/Python`이 여기서
 *     읽힌다.** 이름을 보지 않으므로 어떤 이름의 인터프리터든 들어오고, 걸러 내는 일은 전부
 *     `isWorkerSupervisor`의 구조 조건이 한다.
 *
 * 2번을 3번보다 먼저 두는 이유: 3번은 늘 성공하므로(첫 토큰이 곧 argv[0]) 뒤에 두지 않으면 공백 든
 * 경로가 `/Users/me/My`에서 잘려 영영 안 읽힌다 — 이 판독 규칙이 애초에 생긴 결함이다.
 */
const READINGS: readonly ((argv0: string) => boolean)[] = [
  isPythonExecutable,
  (argv0) => argv0.includes(" "),
  () => true,
];

function readsAsSupervisor(args: string, interpreters: readonly string[]): boolean {
  for (const isInterpreter of READINGS) {
    const tokens = splitPsArgs(args, interpreters, isInterpreter);
    if (tokens !== null && isWorkerSupervisor(tokens)) return true;
  }
  return false;
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
export function parseWorkerProcesses(
  psOutput: string,
  ourPids: ReadonlySet<number>,
  interpreters: readonly string[] = [],
): number[] {
  const out: number[] = [];
  for (const { pid, args } of psRows(psOutput)) {
    // 토큰화는 `READINGS` 셋이 한다 (Phase 4 스펙 §6.5). `args.split(/\s+/)`는 공백 든 설치 경로에서
    // argv[0]을 `/Users/me/My`로 잘라 판정을 **항상 거짓**으로 만들었다 — Task 5 뒤로 앱 worker의
    // argv[0]이 번들 python의 절대 경로라서다. 아는 인터프리터로 먼저 자르고, 모르는 경로는 ` -m `
    // 앞을 읽는다 (process/orphans.ts의 splitPsArgs — 그 규칙과 한계가 거기 있다).
    if (!readsAsSupervisor(args, interpreters)) continue;
    if (ourPids.has(pid)) continue;
    out.push(pid);
  }
  return out;
}

export interface WorkerScanDeps {
  /** `ps -axwwo pid,args`의 출력 (process/process-tree.ts의 psArgs). */
  ps(): Promise<string>;
  /**
   * 앱이 정확히 아는 번들 인터프리터 경로들 (process/orphans.ts의 knownTrees). 공백 든 설치 경로를
   * 접두사로 잘라 읽는 데 쓴다 — 판정은 바꾸지 않는다.
   */
  interpreters: readonly string[];
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
  return parseWorkerProcesses(await deps.ps(), ours, deps.interpreters);
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
