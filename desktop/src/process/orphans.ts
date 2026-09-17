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
 * `tree`는 계획의 계약(`pid·module·runId·once·argv0`)에 **더한** 필드다. 계약의 `classify(p, myRunId)`는
 * 트리 목록을 받지 않으므로, 트리를 아는 판독기가 "argv[0]이 어느 트리 아래인가"라는 사실을 여기
 * 적어 두어야 `classify`가 조건 3을 적용할 수 있다. 판정(조건 3)은 여전히 `classify`의 일이다.
 */
export interface DamwhaProcess {
  pid: number;
  module: string;
  /** `--run-id=` 토큰의 값. 토큰이 없으면 null (터미널 `pnpm worker`). */
  runId: string | null;
  once: boolean;
  argv0: string;
  /** argv[0]이 그 아래에 있는 아는 트리의 `root`. 어느 트리 아래도 아니면 null. */
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

function treeOf(argv0: string, trees: readonly KnownTree[]): string | null {
  for (const t of trees) {
    const base = t.root.endsWith("/") ? t.root : `${t.root}/`;
    if (argv0.startsWith(base)) return t.root;
  }
  return null;
}

/**
 * `ps -axwwo pid,args` 출력에서 조건 1·2를 만족하는 줄을 모두 읽는다 — run-id가 없는 줄, 트리 밖의 줄도
 * 담는다(분류는 `classify`). 목록에 넣지 않는 것:
 *  - run-id 없는 번들 프로세스(capabilities 프로브·embed의 resource_tracker — 둘 다 `-c`)
 *  - `--run-id=` 토큰이 있는데 값이 `newRunId`의 모양이 아닌 줄 — 잘린 줄이다. 모듈이 잘린 줄은 조건 2에서
 *    빠진다. 잘린 줄이 빠져 "고아 없음"처럼 보이는 것과 스캔 실패의 구별은 `reapOrphans`가 한다.
 */
export function parseDamwhaProcesses(psText: string, trees: readonly KnownTree[]): DamwhaProcess[] {
  const interpreters = trees.map((t) => t.python);
  const out: DamwhaProcess[] = [];
  for (const { pid, args } of psRows(psText)) {
    const argv = splitPsArgs(args, interpreters, isBundledInterpreterName);
    if (argv === null || !isBundledInterpreterName(argv[0])) continue;
    const found = moduleOf(argv);
    if (found === null) continue;
    const flag = found.rest.find((t) => t.startsWith(RUN_ID_FLAG));
    const runId = flag === undefined ? null : flag.slice(RUN_ID_FLAG.length);
    if (runId !== null && !RUN_ID_SHAPE.test(runId)) continue;
    out.push({
      pid,
      module: found.module,
      runId,
      once: found.rest.includes("--once"),
      argv0: argv[0],
      tree: treeOf(argv[0], trees),
    });
  }
  return out;
}

/**
 * 조건 3·4. `mine`은 이번 실행의 것, `orphan`은 아는 트리에서 다른 run-id를 단 것(이전 실행이 남겼다),
 * `external`은 run-id가 없거나 트리 밖의 것(터미널 `pnpm worker`, Homebrew python, 옮겨 설치한 앱).
 */
export function classify(p: DamwhaProcess, myRunId: string): "mine" | "orphan" | "external" {
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
  /** SIGKILL. 신호가 닿지 않으면(ESRCH·EPERM) **던진다** — 회수 목록에 넣지 않는다. */
  kill(pid: number): void;
  /** 그 pid가 있는가 (신호 0). 신호 직전마다 부른다. */
  exists(pid: number): boolean;
  log(line: string): void;
  /**
   * 계획의 계약에 **더한** 선택 항목. 있으면 SIGKILL 전에 SIGTERM을 보내고 `ORPHAN_TERM_GRACE_MS`를
   * 기다린다 — idle supervisor·LLM 서버·embed가 스스로 정리하고 끝날 기회다. 없으면 기다리지 않고 곧바로
   * SIGKILL한다. 던지는 규칙은 `kill`과 같다.
   */
  terminate?(pid: number): void;
  /** 유예 동안의 폴 간격 대기. 없으면 실제 타이머. 테스트가 시간을 대신 흘린다. */
  sleep?(ms: number): Promise<void>;
}

/**
 * SIGTERM 뒤 SIGKILL까지의 유예. 기동을 붙잡는 시간이라 짧게 둔다 — 고아가 있을 때만(앱이 강제
 * 종료된 다음 실행) 든다. 일하던 `--once` 자식은 stage boundary까지 SIGTERM을 미루므로 이 안에 거의
 * 끝나지 않는다. 그 job은 attempts를 소모하는데, 살려 두면 새 worker와 같은 job을 두고 겹친다(§6.5 처분).
 */
export const ORPHAN_TERM_GRACE_MS = 3_000;
export const ORPHAN_POLL_MS = 100;
/** SIGKILL 뒤 "정말 없어졌나"를 볼 횟수. 포트(8100)와 DB 연결이 풀린 뒤에 새 서비스를 띄운다. */
const KILL_CHECKS = 10;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function label(p: DamwhaProcess): string {
  return `pid ${p.pid} ${p.module}${p.once ? " --once" : ""} (run-id ${p.runId ?? "없음"})`;
}

/**
 * 고아 하나하나의 자손을 **신호 전에** 모두 찍고, 자손이 부모보다 앞서는 한 줄로 편다. 다른 고아의 자손인
 * 고아(`--once` 아래의 `llm_entry`)는 그 위 고아의 목록에서 한 번만 나온다 — 한 스냅샷 안의 BFS 순서라
 * 서로 다른 ps 호출의 순서가 섞이지 않는다.
 */
async function signalOrder(
  roots: readonly DamwhaProcess[],
  d: ReapDeps,
  untouchable: ReadonlySet<number>,
): Promise<Array<{ pid: number; root: DamwhaProcess | null }>> {
  const trees = new Map<number, number[]>();
  for (const r of roots) trees.set(r.pid, await d.descendantsOf(r.pid));
  const covered = new Set<number>();
  for (const desc of trees.values()) for (const pid of desc) covered.add(pid);
  const order: Array<{ pid: number; root: DamwhaProcess | null }> = [];
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
 * 이전 실행이 남긴 고아를 내린다. **서비스 기동 전에** 부른다 (§6.5 — 뒤에 하면 새로 띄운 것과 잠시 공존한다).
 *
 * 1. `ps`가 거부됐거나 프로세스 줄이 하나도 없으면 `{failed:true}` — 신호는 하나도 보내지 않는다. 실제
 *    `ps`는 적어도 launchd와 자기 자신을 내므로 빈 목록은 "고아 없음"이 아니라 스캔 실패다.
 * 2. `mine`은 로그만 남기고 둔다(방금 만든 run-id라 나올 수 없다). `external`은 건드리지 않는다.
 * 3. 고아마다 자손을 먼저 모두 찍는다. 하나라도 실패하면 `{failed:true}` — 이때도 신호는 없다.
 * 4. 자손 → 부모 순서로, 신호 직전마다 `exists`를 다시 보고 보낸다. 스캔 뒤 끝난 pid는 이미 남의
 *    번호일 수 있다. `terminate`가 있으면 SIGTERM 한 바퀴 → 유예 동안 폴 → 남은 것만 같은 순서로 SIGKILL.
 * 5. 신호가 한 번이라도 닿은 pid를 돌려준다. 내린 것은 하나하나 supervisor.log에 남는다.
 *
 * `exists`는 존재만 본다 — 정체성까지 보지는 않는다. SIGTERM은 스캔 직후(밀리초)지만 SIGKILL은 유예
 * 뒤라 그 사이 pid 재사용 창이 유예만큼 있다. 막는 장치는 유예를 짧게 두는 것뿐이다.
 */
export async function reapOrphans(d: ReapDeps): Promise<{ reaped: number[] } | { failed: true }> {
  let text: string;
  try {
    text = await d.ps();
  } catch (e) {
    d.log(`이전 실행의 프로세스를 확인하지 못했어요 — ps: ${reasonOf(e)}`);
    return { failed: true };
  }
  if (psRows(text).length === 0) {
    d.log("이전 실행의 프로세스를 확인하지 못했어요 — ps 출력에 프로세스가 하나도 없어요.");
    return { failed: true };
  }

  const orphans: DamwhaProcess[] = [];
  const untouchable = new Set<number>();
  for (const p of parseDamwhaProcesses(text, d.trees)) {
    const kind = classify(p, d.runId);
    if (kind === "orphan") {
      orphans.push(p);
      continue;
    }
    untouchable.add(p.pid);
    if (kind === "mine") d.log(`이번 실행의 프로세스가 이미 있어요 — ${label(p)}. 건드리지 않았어요.`);
  }
  if (orphans.length === 0) return { reaped: [] };

  let order: Array<{ pid: number; root: DamwhaProcess | null }>;
  try {
    order = await signalOrder(orphans, d, untouchable);
  } catch (e) {
    d.log(`이전 실행의 프로세스를 확인하지 못했어요 — 자손 조회: ${reasonOf(e)}`);
    return { failed: true };
  }

  const reaped: number[] = [];
  const send = (pid: number, how: "SIGTERM" | "SIGKILL", signal: (pid: number) => void): boolean => {
    if (!d.exists(pid)) return false;
    try {
      signal(pid);
    } catch (e) {
      d.log(`이전 실행의 프로세스에 ${how}을 보내지 못했어요 — pid ${pid}: ${reasonOf(e)}`);
      return false;
    }
    if (!reaped.includes(pid)) reaped.push(pid);
    return true;
  };
  const note = (entry: { pid: number; root: DamwhaProcess | null }, how: string) =>
    d.log(
      entry.root === null
        ? `이전 실행이 남긴 프로세스의 자손을 내려요 (${how}) — pid ${entry.pid}`
        : `이전 실행이 남긴 프로세스를 내려요 (${how}) — ${label(entry.root)}`,
    );

  const sleep = d.sleep ?? realSleep;
  let pending = order;
  if (d.terminate !== undefined) {
    const terminate = d.terminate.bind(d);
    // SIGTERM이 닿은 것만 뒤를 잇는다. 그때 이미 없던 번호가 유예 중에 살아 있다면 그것은 재사용된 남의 번호다.
    const termed = order.filter((entry) => send(entry.pid, "SIGTERM", terminate));
    for (const entry of termed) note(entry, "SIGTERM");
    for (let i = 0; i < ORPHAN_TERM_GRACE_MS / ORPHAN_POLL_MS; i++) {
      if (!termed.some((e) => d.exists(e.pid))) break;
      await sleep(ORPHAN_POLL_MS);
    }
    pending = termed.filter((e) => d.exists(e.pid));
  }

  const killed: number[] = [];
  const kill = d.kill.bind(d);
  for (const entry of pending) {
    if (!send(entry.pid, "SIGKILL", kill)) continue;
    killed.push(entry.pid);
    note(entry, d.terminate === undefined ? "SIGKILL" : `${ORPHAN_TERM_GRACE_MS / 1000}초 안에 끝나지 않아 SIGKILL`);
  }
  if (d.terminate !== undefined && killed.length > 0) {
    for (let i = 0; i < KILL_CHECKS && killed.some((pid) => d.exists(pid)); i++) await sleep(ORPHAN_POLL_MS);
    for (const pid of killed.filter((p) => d.exists(p))) d.log(`SIGKILL 뒤에도 남아 있어요 — pid ${pid}`);
  }
  return { reaped };
}
