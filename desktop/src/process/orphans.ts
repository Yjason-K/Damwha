import { randomUUID } from "crypto";
import type { LaunchContext } from "../services/types";
import { knownBundleDirs, pythonBinaries, PY_MINOR } from "./runtime-paths";

/**
 * 담화 Python 프로세스의 판독·분류·회수 (Phase 4 스펙 §6.5). 표식은 env가 아니라 argv에 있다 —
 * `ps eww`는 SIP 때문에 남의 env를 주지 않는다.
 *
 * 네 조건의 분담:
 *  - `parseDamwhaProcesses`가 **조건 1·2**로 목록에 넣는다 — argv[0]이 절대 경로이고 basename이
 *    `python3.12`, `-m` 다음 토큰이 우리 모듈 셋 중 하나. 이 둘이 `grep --run-id=…`·`zsh -c "…"`·
 *    `uv run …` 같은 줄을 거른다(run-id만 보면 그런 줄이 걸린다).
 *  - `classify`가 **조건 3·4**로 딱지를 붙인다 — argv[0]이 앱이 아는 트리 아래인가, run-id가 있는가.
 *    그래서 저장소 `.venv`의 worker는 목록에 들어온 뒤 조건 3에서 `external`로 갈린다 (P4-C21).
 *
 * 회수 절차는 한 벌(`reapByKind`)이고, 두 단계가 대상 딱지만 달리해 쓴다 — 기동 전 정리(`reapOrphans`,
 * `orphan`)와 앱 종료 회수(app/reap-on-quit.ts, `mine`).
 *
 * electron을 import하지 않는다. `ps` 왕복 같은 실제 의존은 부르는 쪽이 넣는다(app/reap-on-start.ts).
 */

/** 조건 2 — `-m` 다음에 올 수 있는 모듈. `llm_entry`도 같은 규칙이다(§6.2의 진입 모듈이 run-id를 싣는다). */
export const DAMWHA_MODULES: readonly string[] = [
  "damwha_worker",
  "damwha_worker.embed_service",
  "damwha_worker.llm_entry",
];

/** `be/worker/damwha_worker/runtime_report.py`의 `RUN_ID_PREFIX`와 짝이다. 그쪽도 첫 토큰만 읽는다. */
export const RUN_ID_FLAG = "--run-id=";

/** 조건 1 — 런처가 명시하는 실체 이름 (runtime-paths.ts). `python`·`python3` 링크로 뜬 것은 빠진다. */
const INTERPRETER = `python${PY_MINOR}`;

/**
 * 앱이 만드는 run-id의 모양. 판독은 이 모양이 아닌 run-id 줄을 **목록에서 뺀다** — 잘린 줄의 run-id
 * (`desktop-1111…`에서 끊긴 것)를 그대로 읽으면 "내 것이 아닌 run-id"가 되어 **이번 실행의 프로세스를
 * 고아로 내린다.** 모양을 만드는 쪽과 읽는 쪽이 갈리지 않게 `newRunId`가 여기 있다.
 */
const RUN_ID_SHAPE = /^desktop-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 이 실행의 식별자. main.ts가 실행마다 한 번 만든다. */
export function newRunId(): string {
  return `desktop-${randomUUID()}`;
}

/** 앱이 자기 것으로 알아볼 수 있는 번들 python 트리 하나. `python`은 `<root>/bin/python3.12`. */
export interface KnownTree {
  root: string;
  python: string;
}

/**
 * `ps` 한 줄에서 읽은 담화 Python 프로세스 (조건 1·2를 만족한 줄).
 *
 * `tree`는 계획의 계약(`pid·module·runId·once·argv0`)에 **더한** 필드다(판정 R-7c). 계약의
 * `classify(p, myRunId)`는 트리 목록을 받지 않으므로, 트리를 아는 판독기가 "argv[0]이 어느 트리의
 * 인터프리터인가"라는 사실을 여기 적어 두어야 `classify`가 조건 3을 적용할 수 있다. 판정(조건 3)은 여전히
 * `classify`의 일이다.
 */
export interface DamwhaProcess {
  pid: number;
  module: string;
  /** `--run-id=` 토큰의 값. 토큰이 없으면 null (터미널 `pnpm worker`). */
  runId: string | null;
  once: boolean;
  argv0: string;
  /**
   * argv[0]을 **아는 접두사로 잘라** 얻었을 때(= 그 트리의 `python`과 같을 때) 그 트리의 `root`. 아니면 null.
   * ` -m ` 앞을 추측한 argv[0]은 우연히 트리 아래 경로여도(`<root>/bin/foo bar/python3.12`) 트리에 넣지
   * 않는다 — 추측은 소유의 증거가 아니다 (판정 R-7h).
   */
  tree: string | null;
}

/** `knownBundleDirs(ctx)`의 각 bundleDir에 `pythonBinaries()`를 적용한다. 순서는 `[packaged, dev]`. */
export function knownTrees(ctx: Pick<LaunchContext, "bins" | "repoRoot">): KnownTree[] {
  return knownBundleDirs(ctx).map((dir) => ({ root: dir, python: pythonBinaries(dir).python }));
}

/** `ps -axwwo pid,args`의 한 줄. 헤더("  PID ARGS")와 빈 줄은 여기서 걸러진다. */
const PS_ROW = /^\s*(\d+)\s+(\S.*?)\s*$/;

export interface PsRow {
  pid: number;
  args: string;
}

export function psRows(psText: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of psText.split("\n")) {
    const m = PS_ROW.exec(line);
    if (m === null) continue;
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ pid, args: m[2] });
  }
  return rows;
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function tokens(rest: string): string[] {
  const t = rest.trim();
  return t === "" ? [] : t.split(/\s+/);
}

/**
 * `ps`의 args 한 줄을 argv로 되돌린다. 인터프리터 줄이 아니면 null.
 *
 * `ps`는 argv를 공백 하나로 이어 붙이므로 원래 경계를 알 수 없다. 공백이 든 설치 경로
 * (`/Users/me/My Apps/Damwha.app/…`)는 흔하고, 단순 `split(/\s+/)`는 argv[0]을 `/Users/me/My`로 잘라
 * 정상 프로세스를 판정에서 누락시킨다. 그래서 argv[0]을 세 규칙으로, 이 순서대로 정한다:
 *
 *  1. **아는 접두사.** `args`가 `interpreters` 중 하나 + 공백으로 시작하면(또는 그것과 같으면) 그 문자열이
 *     argv[0]이다. 경로에 공백이나 ` -m `이 들어 있어도 정확하다. 긴 것부터 본다.
 *  2. **공백 없는 argv[0].** 첫 공백 앞이 `isInterpreter`를 만족하면 그것이다 — 예전 `split` 판독과 같다.
 *  3. **` -m ` 앞.** 모르는 경로에 공백이 있을 때(`.venv`를 공백 든 폴더에 둔 저장소). 첫 ` -m ` 앞
 *     문자열이 절대 경로이고, **그 안에 ` /`도 ` -`도 없고**, `isInterpreter`를 만족하면 argv[0]이다.
 *     두 금지가 없으면 `/bin/zsh -c /usr/bin/python3 -m …`·`/usr/bin/grep /x/python3 -m …`의 앞부분이
 *     그대로 python 경로로 읽힌다.
 *
 * 규칙 3의 한계 — 판독이 틀리는 모양(규칙 1이 받는 아는 트리에는 해당하지 않는다):
 *  - 경로 자체에 ` -m `이 있으면 그 앞에서 잘려 argv[0]이 python으로 끝나지 않는다 → 목록에서 빠진다.
 *  - 경로의 공백 바로 뒤가 `/`나 `-`인 폴더 이름(`My -Apps`, 끝이 공백인 폴더)은 거부된다 → 빠진다.
 *  - 옵션도 절대 경로도 아닌 인자를 먼저 받는 다른 프로그램(`/bin/echo x/python3 -m damwha_worker`)은
 *    인터프리터 줄로 읽힌다. 그런 줄은 분류에서 트리 밖(`external`)이라 신호를 받지 않는다.
 * 빠지는 방향은 "그 프로세스를 모른다"이고, 이 판독의 소비자 둘은 그것을 "손대지 않는다"로 읽는다.
 */
export function splitPsArgs(
  args: string,
  interpreters: readonly string[],
  isInterpreter: (argv0: string) => boolean,
): string[] | null {
  const known = [...interpreters].filter((p) => p !== "").sort((a, b) => b.length - a.length);
  for (const p of known) {
    if (args === p || args.startsWith(`${p} `)) return [p, ...tokens(args.slice(p.length))];
  }
  const space = args.search(/\s/);
  const first = space < 0 ? args : args.slice(0, space);
  if (isInterpreter(first)) return [first, ...tokens(args.slice(first.length))];
  const cut = args.indexOf(" -m ");
  if (cut <= 0) return null;
  const candidate = args.slice(0, cut);
  if (!candidate.startsWith("/") || candidate.includes(" /") || candidate.includes(" -")) return null;
  if (!isInterpreter(candidate)) return null;
  return [candidate, ...tokens(args.slice(cut))];
}

/** 조건 1. */
function isBundledInterpreterName(argv0: string): boolean {
  return argv0.startsWith("/") && basename(argv0) === INTERPRETER;
}

/**
 * 조건 2 — `-m` 다음 모듈. 인터프리터 옵션(`-E -s` 같은 것)만 그 앞에 올 수 있다. `-c`나 스크립트
 * 경로가 먼저 나오면 그 뒤의 `-m`은 우리 모듈 실행이 아니다(`python3.12 script.py -m damwha_worker`).
 */
function moduleOf(argv: readonly string[]): { module: string; rest: readonly string[] } | null {
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === "-m") {
      const module = argv[i + 1];
      if (module === undefined || !DAMWHA_MODULES.includes(module)) return null;
      return { module, rest: argv.slice(i + 2) };
    }
    if (!/^-[A-Za-z]+$/.test(t) || /[cm]/.test(t)) return null;
  }
  return null;
}

/**
 * argv[0]이 아는 트리의 인터프리터와 **같으면** 그 트리. splitPsArgs는 아는 접두사를 먼저 보므로, argv[0]이 그
 * 인터프리터와 같다는 것은 곧 규칙 1(접두사 절단)로 얻었다는 뜻이다.
 */
function treeOf(argv0: string, trees: readonly KnownTree[]): KnownTree | null {
  return trees.find((t) => t.python === argv0) ?? null;
}

function under(root: string, p: string): boolean {
  return p.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** `a`가 `b`의 비어 있지 않은 **진부분** 접두사인가. */
function properPrefix(a: string, b: string): boolean {
  return a !== "" && a !== b && b.startsWith(a);
}

/** 번들 `bin/`에 실제로 있는 링크 이름. 그것으로 연 REPL은 잘린 인터프리터 경로가 아니다. */
const INTERPRETER_LINKS = new Set(["python", "python3"]);

/** 아는 트리의 인터프리터 경로가 줄 끝에서 잘렸다 — `<root>/bin/pyth`. */
function cutInterpreter(args: string, trees: readonly KnownTree[]): boolean {
  return trees.some(
    (t) => properPrefix(args, t.python) && under(t.root, args) && !INTERPRETER_LINKS.has(basename(args)),
  );
}

/** 인터프리터 뒤가 `-m <우리 모듈>`의 앞부분에서 끝났다 — `-`, `-m`, `-m damwha_wor`. */
function cutBeforeModule(argv: readonly string[]): boolean {
  const rest = argv.slice(1).join(" ");
  return DAMWHA_MODULES.some((m) => properPrefix(rest, `-m ${m}`));
}

/** 마지막 토큰이 우리 플래그의 앞부분에서 끝났다 — `--run-id`, `--on`. */
function cutFlag(rest: readonly string[]): boolean {
  const last = rest[rest.length - 1];
  return last !== undefined && [RUN_ID_FLAG, "--once"].some((flag) => properPrefix(last, flag));
}

export interface DamwhaScan {
  /** 조건 1·2를 만족하고 읽을 수 있는 줄. */
  processes: DamwhaProcess[];
  /**
   * **아는 트리의 인터프리터 줄인데 읽을 수 없는 것** — 잘렸거나 망가진 줄. 조용히 빼면 그 고아가 "없음"으로
   * 보인다(스펙 §6.5 "판독 실패를 '고아 없음'으로 처리하지 않는다"). 부르는 쪽이 스캔 실패로 다룬다 (판정 R-7f).
   */
  unreadable: PsRow[];
}

/**
 * `ps -axwwo pid,args` 출력을 한 번에 판독한다. `processes`는 조건 1·2를 만족하는 줄 전부다 — run-id가 없는 줄,
 * 트리 밖의 줄도 담는다(분류는 `classify`). run-id 없는 번들 프로세스(capabilities 프로브·embed의
 * resource_tracker — 둘 다 `-c`)는 담지 않는다.
 *
 * `unreadable`에 드는 것 — 전부 **아는 트리의 인터프리터**(접두사 절단으로 얻은 argv[0]) 줄이다:
 *  - `--run-id=` 첫 토큰의 값이 `newRunId`의 모양이 아니다 — 비었거나(`--run-id=`, 값이 다음 토큰으로 떨어진
 *    `--run-id= <uuid>`), 잘렸거나, 망가졌다. 그대로 읽으면 잘린 run-id가 "내 것이 아닌 run-id"가 되어 이번
 *    실행의 프로세스를 고아로 내린다.
 *  - 인터프리터 뒤가 `-m <우리 모듈>`의 앞부분에서 끝났다, 또는 마지막 토큰이 `--run-id=`·`--once`의 앞부분이다.
 *  - 줄 전체가 인터프리터 경로의 앞부분이다(`<root>/bin/pyth`). 링크 이름(`bin/python`·`bin/python3`)은 뺀다.
 *
 * 구별하지 못하는 것: 토큰 경계에서 정확히 잘려 `--run-id=` 토큰이 통째로 사라진 줄은 run-id 없는 줄과 같다
 * (`external`, 손대지 않는다). 번들 python으로 연 REPL(`<root>/bin/python3.12` 한 줄)도 잘림으로 보지 않는다.
 * 트리 밖 줄의 망가진 run-id는 어차피 `external`이라 목록에서만 빠진다. 실제 스캔은 `-ww`라 잘리지 않는다.
 */
export function parseDamwhaScan(psText: string, trees: readonly KnownTree[]): DamwhaScan {
  const interpreters = trees.map((t) => t.python);
  const processes: DamwhaProcess[] = [];
  const unreadable: PsRow[] = [];
  for (const row of psRows(psText)) {
    const argv = splitPsArgs(row.args, interpreters, isBundledInterpreterName);
    if (argv === null || !isBundledInterpreterName(argv[0])) {
      if (cutInterpreter(row.args, trees)) unreadable.push(row);
      continue;
    }
    const tree = treeOf(argv[0], trees);
    const found = moduleOf(argv);
    if (found === null) {
      if (tree !== null && cutBeforeModule(argv)) unreadable.push(row);
      continue;
    }
    // 첫 토큰만 읽는다 — worker의 run_id_arg와 같다.
    const flag = found.rest.find((t) => t.startsWith(RUN_ID_FLAG));
    const runId = flag === undefined ? null : flag.slice(RUN_ID_FLAG.length);
    const readable = runId === null ? !cutFlag(found.rest) : RUN_ID_SHAPE.test(runId);
    if (!readable) {
      if (tree !== null) unreadable.push(row);
      continue;
    }
    processes.push({
      pid: row.pid,
      module: found.module,
      runId,
      once: found.rest.includes("--once"),
      argv0: argv[0],
      tree: tree === null ? null : tree.root,
    });
  }
  return { processes, unreadable };
}

/** 조건 1·2를 만족하고 읽을 수 있는 줄. 읽을 수 없는 우리 줄까지 봐야 하는 쪽은 `parseDamwhaScan`을 쓴다. */
export function parseDamwhaProcesses(psText: string, trees: readonly KnownTree[]): DamwhaProcess[] {
  return parseDamwhaScan(psText, trees).processes;
}

export type ProcessKind = "mine" | "orphan" | "external";

/**
 * 조건 3·4. `mine`은 이번 실행의 것, `orphan`은 아는 트리에서 다른 run-id를 단 것(이전 실행이 남겼다),
 * `external`은 run-id가 없거나 트리 밖의 것(터미널 `pnpm worker`, Homebrew python, 옮겨 설치한 앱).
 */
export function classify(p: DamwhaProcess, myRunId: string): ProcessKind {
  if (p.tree === null || p.runId === null) return "external";
  return p.runId === myRunId ? "mine" : "orphan";
}

export interface ReapDeps {
  runId: string;
  trees: readonly KnownTree[];
  /** `ps -axwwo pid,args`. 비영 종료는 거부로 온다. */
  ps(): Promise<string>;
  /**
   * 그 pid의 자손 — root는 빼고, **부모가 자식보다 앞선** 순서(process-tree.ts의 descendantPids BFS).
   * 이 순서를 뒤집어 자손을 부모보다 먼저 내린다.
   */
  descendantsOf(pid: number): Promise<number[]>;
  /**
   * SIGKILL. 신호가 닿지 않으면(ESRCH·EPERM) **던진다** — 회수 목록에 넣지 않는다. SIGKILL 직전에는 `ps`를 한 번 더
   * 읽어 첫 스캔과 args가 같은 pid에만 보낸다.
   */
  kill(pid: number): void;
  /** 그 pid가 있는가 (신호 0). 신호 직전마다 부른다. */
  exists(pid: number): boolean;
  log(line: string): void;
  /**
   * 계획의 계약에 **더한** 선택 항목(판정 R-7c). 있으면 SIGKILL 전에 SIGTERM을 보내고 `ORPHAN_TERM_GRACE_MS`를
   * 기다린다 — idle supervisor·LLM 서버·embed가 스스로 정리하고 끝날 기회다. 없으면 기다리지 않고 곧바로
   * SIGKILL한다. 던지는 규칙은 `kill`과 같다. 기동 정리와 종료 회수가 모두 이 모드를 쓴다(판정 R-7e).
   */
  terminate?(pid: number): void;
  /** 유예 동안의 폴 간격 대기. 없으면 실제 타이머. 테스트가 시간을 대신 흘린다. */
  sleep?(ms: number): Promise<void>;
}

/**
 * SIGTERM 뒤 SIGKILL까지의 유예. 기동을 붙잡는 시간이라 짧게 둔다 — 고아가 있을 때만(앱이 강제
 * 종료된 다음 실행) 든다. 일하던 `--once` 자식은 stage boundary까지 SIGTERM을 미루므로 이 안에 거의
 * 끝나지 않는다. 그 job은 회수되며 interruptions를 소모하는데, 살려 두면 새 worker와 같은 job을 두고 겹친다(§6.5 처분).
 */
export const ORPHAN_TERM_GRACE_MS = 3_000;
export const ORPHAN_POLL_MS = 100;
/** SIGKILL 뒤 "정말 없어졌나"를 볼 횟수. 포트(8100)와 DB 연결이 풀린 뒤에 새 서비스를 띄운다. */
const KILL_CHECKS = 10;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 예외를 로그 한 줄의 까닭으로. 종료 회수(app/reap-on-quit.ts)도 이것을 쓴다. */
export function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 로그에 싣는 args의 상한. 우리 argv에는 비밀이 없지만(토큰은 env로 간다) 한 줄이 한없이 길어지지 않게 한다. */
const ARGS_LOG_MAX = 300;

export function clipArgs(args: string): string {
  return args.length <= ARGS_LOG_MAX ? args : `${args.slice(0, ARGS_LOG_MAX)}…`;
}

function argsByPid(psText: string): Map<number, string> {
  return new Map(psRows(psText).map((r) => [r.pid, r.args]));
}

/** 로그 한 줄에 싣는 프로세스의 정체 — pid·모듈·`--once`·run-id. */
export function processLabel(p: DamwhaProcess): string {
  return `pid ${p.pid} ${p.module}${p.once ? " --once" : ""} (run-id ${p.runId ?? "없음"})`;
}

/** 신호 순서의 한 칸. `root`는 그 pid가 판독된 담화 프로세스일 때 그것, 표식 없는 자손이면 null. */
export interface ReapEntry {
  pid: number;
  root: DamwhaProcess | null;
}

/**
 * 고아 하나하나의 자손을 **신호 전에** 모두 찍고, 자손이 부모보다 앞서는 한 줄로 편다. 다른 고아의 자손인
 * 고아(`--once` 아래의 `llm_entry`)는 그 위 고아의 목록에서 한 번만 나온다 — 한 스냅샷 안의 BFS 순서라
 * 서로 다른 ps 호출의 순서가 섞이지 않는다.
 *
 * 자손은 표식이 없어도 함께 내린다 — 증명된 고아의 자손이라는 계보가 곧 소유의 증거다(A층의
 * stopWorkerProcess도 자손을 SIGKILL한다). 스펙 §6.5 처분표의 "`LENS_LLM_SERVER_BIN` 서버는 손대지 않는다"는
 * **맨 위에서 알아보는** 규칙이라, 고아 `--once` 아래에 뜬 그 서버는 여기서 함께 내려간다 (판정 R-7i). 판독이
 * 대상과 다른 딱지로 가른 pid만은 자손이어도 건드리지 않는다.
 */
async function signalOrder(
  roots: readonly DamwhaProcess[],
  d: ReapDeps,
  untouchable: ReadonlySet<number>,
): Promise<ReapEntry[]> {
  const trees = new Map<number, number[]>();
  for (const r of roots) trees.set(r.pid, await d.descendantsOf(r.pid));
  const covered = new Set<number>();
  for (const desc of trees.values()) for (const pid of desc) covered.add(pid);
  const order: ReapEntry[] = [];
  const seen = new Set<number>();
  const push = (pid: number, root: DamwhaProcess | null) => {
    if (seen.has(pid) || untouchable.has(pid) || pid <= 1) return;
    seen.add(pid);
    order.push({ pid, root });
  };
  const byPid = new Map(roots.map((r) => [r.pid, r]));
  for (const r of roots) {
    if (covered.has(r.pid)) continue;
    for (const pid of [...(trees.get(r.pid) ?? [])].reverse()) push(pid, byPid.get(pid) ?? null);
    push(r.pid, r);
  }
  // 두 스냅샷이 어긋나 서로를 자손으로 본 고아가 있으면 위에서 둘 다 건너뛴다. 조용히 빠뜨리지 않는다.
  for (const r of roots) push(r.pid, r);
  return order;
}

/**
 * 회수 한 판을 로그에 **어떤 말로** 적는가. 절차는 기동 정리와 종료 회수가 같고(스펙 §6.5 "같은 코드를 쓰되
 * 대상이 '내 run-id'인 점만 다르다"), 말만 다르다 — 종료 회수의 줄을 "이전 실행이 남긴"으로 적으면 거짓이다.
 */
export interface ReapWords {
  /** 모든 줄의 머리. 같은 supervisor.log에 두 단계의 줄이 섞이므로 종료 회수는 자기 이름을 붙인다. */
  prefix: string;
  /** 확인·신호 실패 줄의 주어("이전 실행의 프로세스"). 뒤에 "를"·"에"가 붙는다. */
  subject: string;
  /** 아는 트리의 읽을 수 없는 줄(스캔 실패)을 적는 줄들. 신호는 하나도 가지 않는다. */
  unreadable(rows: readonly PsRow[]): string[];
  /** 대상이 아닌 담화 프로세스를 적을 줄. 적지 않으면 null. */
  bystander(p: DamwhaProcess, kind: ProcessKind): string | null;
  /** 신호 한 번(`how` = SIGTERM, SIGKILL…)을 적는 줄. `root`가 null이면 표식 없는 자손이다. */
  sent(entry: ReapEntry, how: string): string;
}

/** 무엇을 내리는가. 나머지 딱지(`mine`·`orphan`·`external` 중 대상이 아닌 것)는 자손이어도 건드리지 않는다. */
export interface ReapPlan {
  target: Exclude<ProcessKind, "external">;
  words: ReapWords;
  /**
   * 딱지가 맞아도 이 술어가 거짓이면 **건드리지 않는다**(untouchable). worker 재시작이
   * 이번 실행의 `--once` 자식만 거두기 위한 좁힘이다 — 같은 run-id의 supervisor 자신과
   * embed는 재시작 절차가 따로 다룬다.
   */
  only?(p: DamwhaProcess): boolean;
}

export interface ReapRun {
  /** 스캔(첫 `ps`·판독·자손 조회·SIGKILL 전 재확인)을 끝내지 못해 멈췄다. 이유는 로그에 있다. */
  failed: boolean;
  /** 신호가 한 번이라도 닿은 칸 — 첫 신호의 순서대로, pid마다 한 번. */
  signalled: ReapEntry[];
}

/**
 * 기동 정리(`reapOrphans`, 대상 `orphan`)와 종료 회수(`reapOwnedOnQuit`, 대상 `mine`)가 함께 쓰는 한 판.
 *
 * 1. `ps`가 거부됐거나 프로세스 줄이 하나도 없으면 실패 — 신호는 하나도 보내지 않는다. 실제 `ps`는 적어도
 *    launchd와 자기 자신을 내므로 빈 목록은 "대상 없음"이 아니라 스캔 실패다.
 * 2. 아는 트리의 줄인데 읽을 수 없는 것(`parseDamwhaScan`의 `unreadable`)이 하나라도 있으면 실패 — 신호 없음
 *    (판정 R-7f). 어떻게 적을지는 `words.unreadable`이 정한다.
 * 3. `plan.target` 딱지만 대상이다. 나머지는 `untouchable` — 대상의 자손이어도 신호를 받지 않는다.
 * 4. 대상마다 자손을 먼저 모두 찍는다. 하나라도 실패하면 실패 — 이때도 신호는 없다.
 * 5. 자손 → 부모 순서로, 신호 직전마다 `exists`를 다시 보고 보낸다. `terminate`가 있으면 SIGTERM 한 바퀴 →
 *    유예 동안 폴 → SIGTERM이 닿았는데 남은 것만 SIGKILL 단계로 간다.
 * 6. **SIGKILL 단계 앞에서 `ps`를 한 번 더 읽는다** (판정 R-7g). 첫 스캔과 args가 글자 그대로 같은 pid에만
 *    보낸다 — 유예만큼 낡은 번호를 OS가 다른 프로세스에 줬을 수 있다(worker-shutdown.ts 4단계와 같은 취지).
 *    첫 스캔에 없던 번호(그 뒤에 생긴 자손), 다시 본 목록에 없거나 args가 달라진 번호는 로그만 남기고 건너뛴다.
 *    두 번째 `ps`가 실패하면(또는 빈 목록이면) SIGKILL을 하나도 보내지 않고 실패 — 그 전에 보낸 SIGTERM은
 *    `signalled`와 로그에 있다.
 * 7. 신호가 한 번이라도 닿은 칸을 `signalled`에 쌓는다. 신호마다 `words.sent`의 줄이 남는다.
 *
 * `signalled`를 부르는 쪽이 넘기면 이 함수가 도중에 던져도 그때까지 보낸 것이 거기 남는다 — 던지지 않아야 하는
 * 종료 회수가 "보낸 것"을 잃지 않게 한다.
 *
 * `exists`·args 대조로도 막지 못하는 창: 두 번째 `ps`와 SIGKILL 사이(밀리초), 그리고 같은 args로 다시 뜬
 * 프로세스(우리 argv에는 run-id가 있어 같은 줄은 그 프로세스 자신뿐이다).
 */
export async function reapByKind(d: ReapDeps, plan: ReapPlan, signalled: ReapEntry[] = []): Promise<ReapRun> {
  const { words } = plan;
  const say = (line: string) => d.log(`${words.prefix}${line}`);
  const failed = (): ReapRun => ({ failed: true, signalled });

  let text: string;
  try {
    text = await d.ps();
  } catch (e) {
    say(`${words.subject}를 확인하지 못했어요 — ps: ${reasonOf(e)}`);
    return failed();
  }
  if (psRows(text).length === 0) {
    say(`${words.subject}를 확인하지 못했어요 — ps 출력에 프로세스가 하나도 없어요.`);
    return failed();
  }

  const scan = parseDamwhaScan(text, d.trees);
  if (scan.unreadable.length > 0) {
    for (const line of words.unreadable(scan.unreadable)) say(line);
    return failed();
  }

  const targets: DamwhaProcess[] = [];
  const untouchable = new Set<number>();
  for (const p of scan.processes) {
    const kind = classify(p, d.runId);
    if (kind === plan.target && (plan.only === undefined || plan.only(p))) {
      targets.push(p);
      continue;
    }
    untouchable.add(p.pid);
    const line = words.bystander(p, kind);
    if (line !== null) say(line);
  }
  if (targets.length === 0) return { failed: false, signalled };

  let order: ReapEntry[];
  try {
    order = await signalOrder(targets, d, untouchable);
  } catch (e) {
    say(`${words.subject}를 확인하지 못했어요 — 자손 조회: ${reasonOf(e)}`);
    return failed();
  }

  const send = (entry: ReapEntry, how: "SIGTERM" | "SIGKILL", signal: (pid: number) => void): boolean => {
    if (!d.exists(entry.pid)) return false;
    try {
      signal(entry.pid);
    } catch (e) {
      say(`${words.subject}에 ${how}을 보내지 못했어요 — pid ${entry.pid}: ${reasonOf(e)}`);
      return false;
    }
    if (!signalled.some((s) => s.pid === entry.pid)) signalled.push(entry);
    return true;
  };

  const sleep = d.sleep ?? realSleep;
  let pending = order;
  if (d.terminate !== undefined) {
    const terminate = d.terminate.bind(d);
    // SIGTERM이 닿은 것만 뒤를 잇는다. 그때 이미 없던 번호가 유예 중에 살아 있다면 그것은 재사용된 남의 번호다.
    const termed = order.filter((entry) => send(entry, "SIGTERM", terminate));
    for (const entry of termed) say(words.sent(entry, "SIGTERM"));
    for (let i = 0; i < ORPHAN_TERM_GRACE_MS / ORPHAN_POLL_MS; i++) {
      if (!termed.some((e) => d.exists(e.pid))) break;
      await sleep(ORPHAN_POLL_MS);
    }
    pending = termed.filter((e) => d.exists(e.pid));
  }

  if (pending.length === 0) return { failed: false, signalled };
  const first = argsByPid(text);
  let again: Map<number, string>;
  try {
    again = argsByPid(await d.ps());
  } catch (e) {
    say(`SIGKILL 전에 프로세스를 다시 확인하지 못해 보내지 않았어요 — ps: ${reasonOf(e)}`);
    return failed();
  }
  if (again.size === 0) {
    say("SIGKILL 전에 다시 읽은 ps 출력에 프로세스가 하나도 없어 보내지 않았어요.");
    return failed();
  }

  const killed: number[] = [];
  const kill = d.kill.bind(d);
  for (const entry of pending) {
    const was = first.get(entry.pid);
    const now = again.get(entry.pid);
    if (was === undefined || now !== was) {
      const why =
        was === undefined ? "첫 스캔에 없던 번호예요" : now === undefined ? "다시 본 목록에 없어요" : "그 번호의 명령이 바뀌었어요";
      say(`SIGKILL을 보내지 않았어요 — pid ${entry.pid}: ${why}`);
      continue;
    }
    if (!send(entry, "SIGKILL", kill)) continue;
    killed.push(entry.pid);
    say(words.sent(entry, d.terminate === undefined ? "SIGKILL" : `${ORPHAN_TERM_GRACE_MS / 1000}초 안에 끝나지 않아 SIGKILL`));
  }
  if (d.terminate !== undefined && killed.length > 0) {
    for (let i = 0; i < KILL_CHECKS && killed.some((pid) => d.exists(pid)); i++) await sleep(ORPHAN_POLL_MS);
    for (const pid of killed.filter((p) => d.exists(p))) say(`SIGKILL 뒤에도 남아 있어요 — pid ${pid}`);
  }
  return { failed: false, signalled };
}

/** 기동 정리의 말. 이 문구들은 Task 7이 정한 그대로다. */
const ORPHAN_PLAN: ReapPlan = {
  target: "orphan",
  words: {
    prefix: "",
    subject: "이전 실행의 프로세스",
    unreadable: (rows) =>
      rows.map((row) => `이전 실행의 프로세스인지 읽을 수 없는 줄이 있어요 — pid ${row.pid}: ${clipArgs(row.args)}`),
    // 방금 만든 run-id라 나올 수 없다. 나왔다면 적어 둔다.
    bystander: (p, kind) =>
      kind === "mine" ? `이번 실행의 프로세스가 이미 있어요 — ${processLabel(p)}. 건드리지 않았어요.` : null,
    sent: (entry, how) =>
      entry.root === null
        ? `이전 실행이 남긴 프로세스의 자손을 내려요 (${how}) — pid ${entry.pid}`
        : `이전 실행이 남긴 프로세스를 내려요 (${how}) — ${processLabel(entry.root)}`,
  },
};

/**
 * 이전 실행이 남긴 고아를 내린다. **서비스 기동 전에** 부른다 (§6.5 — 뒤에 하면 새로 띄운 것과 잠시 공존한다).
 *
 * 절차는 `reapByKind`에 있다(대상 `orphan`). 스캔이 실패하면 `{failed:true}` — 부르는 쪽(reap-on-start.ts)이
 * 기동을 멈춘다. `mine`은 로그만 남기고 두고, `external`은 건드리지 않는다. 신호가 한 번이라도 닿은 pid를
 * 돌려준다. 내린 것은 하나하나 supervisor.log에 남는다.
 */
export async function reapOrphans(d: ReapDeps): Promise<{ reaped: number[] } | { failed: true }> {
  const run = await reapByKind(d, ORPHAN_PLAN);
  return run.failed ? { failed: true } : { reaped: run.signalled.map((e) => e.pid) };
}

/**
 * 회수 **뒤** 다시 스캔해 아직 남은 앞 실행의 앱 소유 프로세스 (Phase 6b-2 스펙 §5.2-2). reapOrphans는 SIGKILL 뒤
 * 생존자를 로그로만 남긴다. `exists`로 한 번 더 거른다 — 방금 죽인 pid가 스캔과 신호 사이에 남아 보이는 것을 빼고,
 * 정말 살아 있는 것만 센다.
 */
export async function survivingOrphans(d: Pick<ReapDeps, "ps" | "trees" | "runId" | "exists">): Promise<number[]> {
  return parseDamwhaProcesses(await d.ps(), d.trees)
    .filter((p) => classify(p, d.runId) === "orphan" && d.exists(p.pid))
    .map((p) => p.pid);
}

const OWN_ONCE_PLAN: ReapPlan = {
  target: "mine",
  only: (p) => p.once,
  words: {
    prefix: "worker 재시작 — ",
    subject: "이번 실행의 --once 자식",
    unreadable: (rows) => [
      `이번 실행의 --once 자식인지 읽을 수 없는 줄이 있어 아무것도 내리지 않았어요 — ${rows
        .map((row) => `pid ${row.pid}: ${clipArgs(row.args)}`)
        .join(" / ")}`,
    ],
    bystander: () => null,
    sent: (entry, how) =>
      entry.root === null
        ? `앞 supervisor의 --once 자손을 내려요 (${how}) — pid ${entry.pid}`
        : `앞 supervisor의 --once 자식을 내려요 (${how}) — ${processLabel(entry.root)}`,
  },
};

/**
 * worker를 다시 띄우기 **전에** 이번 실행의 `--once` 자식을 거둔다 (Phase 5 스펙 §8).
 *
 * 크래시로 사라진 supervisor의 `--once` 자식은 아무도 추적하지 않는다 — `start_new_session=True`라
 * 부모가 먼저 사라지면 자손 SIGKILL이 훑을 트리가 없다(Phase 2 이월). run-id는 **이번 실행**이므로
 * 기동 정리(`reapOrphans`, 대상 `orphan`)는 이 프로세스를 보지 않는다.
 */
export async function reapOwnOnceChildren(d: ReapDeps): Promise<{ reaped: number[] } | { failed: true }> {
  const run = await reapByKind(d, OWN_ONCE_PLAN);
  return run.failed ? { failed: true } : { reaped: run.signalled.map((e) => e.pid) };
}
