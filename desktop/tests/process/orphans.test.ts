import { describe, expect, it } from "vitest";
import {
  classify,
  knownTrees,
  newRunId,
  ORPHAN_POLL_MS,
  ORPHAN_TERM_GRACE_MS,
  parseDamwhaProcesses,
  parseDamwhaScan,
  reapOrphans,
  reapOwnOnceChildren,
  splitPsArgs,
  type DamwhaProcess,
  type KnownTree,
  type ReapDeps,
} from "../../src/process/orphans";
import type { LaunchContext } from "../../src/services/types";

// 앱이 아는 두 트리 (runtime-paths.ts의 knownBundleDirs — dev 실행이면 [packaged, dev]).
const REPO = "/Users/me/daewha";
const PKG_ROOT = `${REPO}/desktop/out/mac-arm64/Damwha.app/Contents/Resources/python`;
const DEV_ROOT = `${REPO}/desktop/build/python`;
const PKG = `${PKG_ROOT}/bin/python3.12`;
const DEV = `${DEV_ROOT}/bin/python3.12`;
const TREES: readonly KnownTree[] = [
  { root: PKG_ROOT, python: PKG },
  { root: DEV_ROOT, python: DEV },
];

const MINE = "desktop-11111111-1111-4111-8111-111111111111";
const OLD = "desktop-22222222-2222-4222-8222-222222222222";

// Task 5가 띄우는 네 모양(run-id의 자리까지 그대로)과, 목록에 들면 안 되는 이웃들.
const PS = [
  "  PID ARGS",
  "    1 /sbin/launchd",
  ` 5001 ${DEV} -m damwha_worker --run-id=${OLD}`,
  ` 5002 ${DEV} -m damwha_worker --once --run-id=${OLD}`,
  ` 5003 ${DEV} -m damwha_worker.llm_entry --run-id=${OLD} --model mlx-community/Qwen3-4B-4bit --host 127.0.0.1 --port 51234`,
  ` 5004 ${DEV} -m damwha_worker.embed_service --run-id=${OLD}`,
  // run-id 없는 번들 프로세스 둘 — embed의 resource_tracker, worker의 capabilities 프로브. 목록에 들지 않는다.
  ` 5005 ${DEV} -c from multiprocessing.resource_tracker import main;main(6)`,
  ` 5006 ${DEV} -c import json, platform; print(json.dumps({}))`,
  // 저장소 .venv의 터미널 worker — 조건 1·2만 만족한다.
  ` 6001 ${REPO}/be/worker/.venv/bin/python3.12 -m damwha_worker`,
  ` 6002 /opt/homebrew/bin/uv run --directory ${REPO}/be/worker python -m damwha_worker`,
  ` 6003 /usr/bin/grep --run-id=${OLD} damwha_worker`,
  ` 6004 /bin/zsh -c ${DEV} -m damwha_worker --run-id=${OLD}`,
  // LENS_LLM_SERVER_BIN 탈출구 — 표식이 없다.
  " 6005 /Users/me/.local/bin/mlx_lm.server --model x --port 8000",
].join("\n");

const pidsOf = (list: readonly DamwhaProcess[]) => list.map((p) => p.pid);

describe("parseDamwhaProcesses — 조건 1·2로 목록에 넣는다", () => {
  it("reads the four launch shapes with their module, --once and run-id", () => {
    const list = parseDamwhaProcesses(PS, TREES);
    const bundled = list.filter((p) => p.pid >= 5000 && p.pid < 6000);
    expect(bundled).toEqual([
      { pid: 5001, module: "damwha_worker", runId: OLD, once: false, argv0: DEV, tree: DEV_ROOT },
      { pid: 5002, module: "damwha_worker", runId: OLD, once: true, argv0: DEV, tree: DEV_ROOT },
      { pid: 5003, module: "damwha_worker.llm_entry", runId: OLD, once: false, argv0: DEV, tree: DEV_ROOT },
      { pid: 5004, module: "damwha_worker.embed_service", runId: OLD, once: false, argv0: DEV, tree: DEV_ROOT },
    ]);
  });

  it("lists the repo .venv worker without a run-id and outside any tree — classify then calls it external", () => {
    const venv = parseDamwhaProcesses(PS, TREES).find((p) => p.pid === 6001);
    expect(venv).toEqual({
      pid: 6001,
      module: "damwha_worker",
      runId: null,
      once: false,
      argv0: `${REPO}/be/worker/.venv/bin/python3.12`,
      tree: null,
    });
    expect(classify(venv!, MINE)).toBe("external");
  });

  it("does not list the uv launcher, a grep naming the run-id, a shell line, the run-id-less -c children, or the escape-hatch server", () => {
    expect(pidsOf(parseDamwhaProcesses(PS, TREES))).toEqual([5001, 5002, 5003, 5004, 6001]);
  });

  it("reads an install path with spaces by cutting the known interpreter prefix first", () => {
    // `split(/\s+/)`이면 argv[0]이 `/Users/me/My`로 잘려 조건 1에서 빠진다 — 고아 정리가 조용히 생략된다.
    const root = "/Users/me/My Apps/Damwha.app/Contents/Resources/python";
    const python = `${root}/bin/python3.12`;
    const ps = `  PID ARGS\n 7001 ${python} -m damwha_worker --once --run-id=${OLD}`;
    expect(parseDamwhaProcesses(ps, [{ root, python }])).toEqual([
      { pid: 7001, module: "damwha_worker", runId: OLD, once: true, argv0: python, tree: root },
    ]);
  });

  it("reads a known install path that no guess could — ` -` or ` -m ` inside a folder name", () => {
    for (const root of ["/Users/me/Apps - Work/Damwha.app/Contents/Resources/python", "/Volumes/x -m y/Damwha.app/Contents/Resources/python"]) {
      const python = `${root}/bin/python3.12`;
      const ps = `  PID ARGS\n 7003 ${python} -m damwha_worker.llm_entry --run-id=${OLD} --model m`;
      expect(parseDamwhaProcesses(ps, [{ root, python }])).toEqual([
        { pid: 7003, module: "damwha_worker.llm_entry", runId: OLD, once: false, argv0: python, tree: root },
      ]);
      expect(parseDamwhaProcesses(ps, [])).toEqual([]);
    }
  });

  it("still reads a spaced interpreter path it does not know (text before ` -m `) — and leaves it outside every tree", () => {
    const python = "/Users/me/My Projects/daewha/be/worker/.venv/bin/python3.12";
    const ps = `  PID ARGS\n 7002 ${python} -m damwha_worker`;
    expect(parseDamwhaProcesses(ps, TREES)).toEqual([
      { pid: 7002, module: "damwha_worker", runId: null, once: false, argv0: python, tree: null },
    ]);
  });

  it("judges each line by its own tree when both the dev and packaged trees are live", () => {
    const ps = [
      "  PID ARGS",
      ` 7101 ${PKG} -m damwha_worker --run-id=${OLD}`,
      ` 7102 ${DEV} -m damwha_worker.embed_service --run-id=${OLD}`,
    ].join("\n");
    expect(parseDamwhaProcesses(ps, TREES).map((p) => [p.pid, p.tree])).toEqual([
      [7101, PKG_ROOT],
      [7102, DEV_ROOT],
    ]);
  });

  it("lists a python3.12 of a tree it does not know but places it in no tree — it is never an orphan", () => {
    // 예: /Applications로 옮긴 packaged 사본 (knownBundleDirs의 한계). 조건 3에서 빠진다.
    const other = "/Applications/Damwha.app/Contents/Resources/python/bin/python3.12";
    const ps = `  PID ARGS\n 7201 ${other} -m damwha_worker --run-id=${OLD}`;
    const [p] = parseDamwhaProcesses(ps, TREES);
    expect(p).toMatchObject({ pid: 7201, tree: null, runId: OLD });
    expect(classify(p, MINE)).toBe("external");
  });

  it("does not list a bundled interpreter launched through its symlink name, a bare name, or a lookalike file", () => {
    // 조건 1은 basename `python3.12`의 절대 경로다 (runtime-paths.ts — 링크 이름으로 띄우면 빠진다).
    const ps = [
      "  PID ARGS",
      ` 7301 ${DEV_ROOT}/bin/python3 -m damwha_worker --run-id=${OLD}`,
      ` 7302 python3.12 -m damwha_worker --run-id=${OLD}`,
      ` 7303 ${DEV}x -m damwha_worker --run-id=${OLD}`,
    ].join("\n");
    expect(parseDamwhaProcesses(ps, TREES)).toEqual([]);
  });

  it("keeps condition 1 strict for the kill path — the P4-C21 argv stays invisible here", () => {
    // 2026-09-19 P4-C21의 실측 argv. services/worker-discovery.ts는 이 줄을 보라고 이름 조건을
    // 풀었지만(그쪽은 신호를 하나도 보내지 않고 stand-down만 한다), **이 파일은 죽이는 경로**라
    // 조건 1을 그대로 둔다 — 넓히면 앱이 SIGTERM·SIGKILL을 보낼 의향이 있는 범위가 넓어진다
    // (판정 R-12b). 트리 밖이라 어차피 `external`로 갈리지만, 목록에조차 들이지 않는 것이 계약이다.
    const measured =
      "/opt/homebrew/Cellar/python@3.12/3.12.14/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python";
    const ps = [
      "  PID ARGS",
      ` 7601 ${measured} -m damwha_worker`,
      ` 7602 ${measured} -m damwha_worker --run-id=${OLD}`,
    ].join("\n");
    const scan = parseDamwhaScan(ps, TREES);
    expect(scan.processes).toEqual([]);
    expect(scan.unreadable).toEqual([]);
  });

  it("wants the module right after -m, and only one of the three", () => {
    const ps = [
      "  PID ARGS",
      ` 7401 ${DEV} script.py -m damwha_worker --run-id=${OLD}`,
      ` 7402 ${DEV} -m damwha_worker.jobs --run-id=${OLD}`,
      ` 7403 ${DEV} -m damwha_worker_extra --run-id=${OLD}`,
      ` 7404 ${DEV} -E -s -m damwha_worker --run-id=${OLD}`,
    ].join("\n");
    expect(pidsOf(parseDamwhaProcesses(ps, TREES))).toEqual([7404]);
  });

  it("does not list a truncated line under a known tree — it surfaces it as unreadable instead", () => {
    // 잘린 run-id를 그대로 읽으면 "내 것이 아닌 run-id"라 **내 프로세스를 고아로** 내린다. 조용히 빼면
    // 고아가 "없음"으로 보인다 — 스펙 §6.5 "판독 실패를 '고아 없음'으로 처리하지 않는다".
    const ps = [
      "  PID ARGS",
      ` 7501 ${DEV} -m damwha_wor`,
      ` 7502 ${DEV} -m damwha_worker --once --run-id=${MINE.slice(0, 20)}`,
      ` 7503 ${DEV_ROOT}/bin/pyth`,
      ` 7504 ${DEV} -m`,
      ` 7505 ${PKG} -m damwha_worker.embed_serv`,
      ` 7506 ${DEV} -m damwha_worker --once --run-id`,
      ` 7507 ${DEV} -m damwha_worker --on`,
    ].join("\n");
    expect(parseDamwhaProcesses(ps, TREES)).toEqual([]);
    const scan = parseDamwhaScan(ps, TREES);
    expect(scan.processes).toEqual([]);
    expect(scan.unreadable.map((r) => r.pid)).toEqual([7501, 7502, 7503, 7504, 7505, 7506, 7507]);
    expect(scan.unreadable[1].args).toContain("--run-id=desktop-1111");
  });

  it("treats an empty or detached --run-id= under a known tree as unreadable", () => {
    const ps = [
      "  PID ARGS",
      ` 7511 ${DEV} -m damwha_worker --run-id=`,
      ` 7512 ${DEV} -m damwha_worker --once --run-id= ${OLD}`,
      ` 7513 ${DEV} -m damwha_worker.llm_entry --run-id= --model mlx-community/Qwen3-4B-4bit`,
      ` 7514 ${DEV} -m damwha_worker.embed_service --run-id=DESKTOP-${OLD.slice(8)}`,
    ].join("\n");
    const scan = parseDamwhaScan(ps, TREES);
    expect(scan.processes).toEqual([]);
    expect(scan.unreadable.map((r) => r.pid)).toEqual([7511, 7512, 7513, 7514]);
  });

  it("does not call a readable known-tree line, or a line it cannot place in a tree, unreadable", () => {
    const ps = [
      "  PID ARGS",
      // 개발자가 번들 python으로 연 REPL, run-id 없이 손으로 띄운 worker — 둘 다 잘림과 구별되는 모양이다.
      ` 7521 ${DEV}`,
      ` 7524 ${DEV_ROOT}/bin/python3`,
      ` 7522 ${DEV} -m damwha_worker`,
      // 트리 밖의 망가진 run-id는 어차피 external이라 스캔을 세우지 않는다.
      ` 7523 ${REPO}/be/worker/.venv/bin/python3.12 -m damwha_worker --run-id=garbled`,
    ].join("\n");
    const scan = parseDamwhaScan(ps, TREES);
    expect(scan.unreadable).toEqual([]);
    expect(scan.processes.map((p) => [p.pid, p.runId])).toEqual([[7522, null]]);
  });

  it("reads the first --run-id= when there are two, as the worker does", () => {
    const ps = `  PID ARGS\n 7531 ${DEV} -m damwha_worker --run-id=${OLD} --run-id=${MINE}`;
    expect(parseDamwhaProcesses(ps, TREES)[0].runId).toBe(OLD);
    const unreadableFirst = `  PID ARGS\n 7532 ${DEV} -m damwha_worker --run-id= --run-id=${MINE}`;
    expect(parseDamwhaScan(unreadableFirst, TREES).unreadable.map((r) => r.pid)).toEqual([7532]);
  });

  it("places only an interpreter matched by the known prefix in a tree — a guessed argv[0] inside a tree is external", () => {
    // 규칙 3(` -m ` 앞)이 추측한 argv[0]이 우연히 아는 트리 아래에 있어도 그 트리의 인터프리터가 아니다.
    const guessed = `${DEV_ROOT}/bin/foo bar/python3.12`;
    const ps = `  PID ARGS\n 7541 ${guessed} -m damwha_worker --run-id=${OLD}`;
    const [p] = parseDamwhaProcesses(ps, TREES);
    expect(p).toMatchObject({ pid: 7541, argv0: guessed, tree: null });
    expect(classify(p, MINE)).toBe("external");
  });

  it("counts --once only as a whole token", () => {
    const ps = `  PID ARGS\n 7601 ${DEV} -m damwha_worker --once-ish --run-id=${OLD}`;
    expect(parseDamwhaProcesses(ps, TREES)[0].once).toBe(false);
  });

  it("reads back the run-id the app mints", () => {
    const id = newRunId();
    const ps = `  PID ARGS\n 7701 ${DEV} -m damwha_worker --run-id=${id}`;
    expect(parseDamwhaProcesses(ps, TREES)[0].runId).toBe(id);
    expect(newRunId()).not.toBe(id);
  });

  it("returns nothing for empty or header-only input", () => {
    expect(parseDamwhaProcesses("", TREES)).toEqual([]);
    expect(parseDamwhaProcesses("  PID ARGS", TREES)).toEqual([]);
  });
});

describe("splitPsArgs", () => {
  const isPython = (argv0: string) => /^python[\d.]*$/.test(argv0.slice(argv0.lastIndexOf("/") + 1));

  it("refuses a candidate argv[0] that swallowed another program's options or path", () => {
    // ` -m ` 앞을 argv[0]로 읽는 규칙이 셸·grep 줄을 인터프리터로 만들지 않게 막는 두 조건.
    expect(splitPsArgs("/bin/zsh -c /usr/bin/python3 -m damwha_worker", [], isPython)).toBeNull();
    expect(splitPsArgs("/usr/bin/grep /usr/bin/python3 -m damwha_worker", [], isPython)).toBeNull();
    // 상대 경로 venv를 부르는 셸 줄 — ` /`는 없고 ` -`만 있다.
    expect(splitPsArgs("/bin/zsh -c .venv/bin/python -m damwha_worker", [], isPython)).toBeNull();
  });

  it("keeps the whitespace-free argv[0] reading, bare names included", () => {
    expect(splitPsArgs("python -m damwha_worker", [], isPython)).toEqual(["python", "-m", "damwha_worker"]);
  });

  it("prefers the known interpreter even when its path contains ` -m `", () => {
    const python = "/Users/me/x -m y/python/bin/python3.12";
    expect(splitPsArgs(`${python} -m damwha_worker`, [python], isPython)).toEqual([python, "-m", "damwha_worker"]);
  });
});

describe("classify — 조건 3·4로 딱지를 붙인다", () => {
  const p = (over: Partial<DamwhaProcess>): DamwhaProcess => ({
    pid: 1,
    module: "damwha_worker",
    runId: OLD,
    once: false,
    argv0: DEV,
    tree: DEV_ROOT,
    ...over,
  });

  it("is mine when the run-id is this run's", () => {
    expect(classify(p({ runId: MINE }), MINE)).toBe("mine");
  });

  it("is an orphan when a known tree carries another run-id — llm_entry by the same rule", () => {
    expect(classify(p({}), MINE)).toBe("orphan");
    expect(classify(p({ module: "damwha_worker.llm_entry" }), MINE)).toBe("orphan");
    expect(classify(p({ once: true }), MINE)).toBe("orphan");
  });

  it("is external without a run-id, or outside the known trees", () => {
    expect(classify(p({ runId: null }), MINE)).toBe("external");
    expect(classify(p({ tree: null }), MINE)).toBe("external");
    expect(classify(p({ tree: null, runId: MINE }), MINE)).toBe("external");
  });
});

describe("knownTrees", () => {
  it("applies pythonBinaries to each bundle dir the app knows", () => {
    const ctx: Pick<LaunchContext, "bins" | "repoRoot"> = {
      repoRoot: REPO,
      bins: { python: DEV, ffmpeg: "/f/bin/ffmpeg", ffprobe: "/f/bin/ffprobe" },
    };
    expect(knownTrees(ctx)).toEqual(TREES);
  });
});

/**
 * 가짜 커널. `alive`에 든 pid만 산다. kill(SIGKILL)은 늘 죽이고, terminate(SIGTERM)는 `ignoresTerm`이
 * 아니면 죽인다. 사건은 순서대로 `events`에 남는다.
 */
function fakeKernel(o: {
  ps?: () => Promise<string>;
  alive: number[];
  tree?: Record<number, number[]>;
  ignoresTerm?: number[];
  runId?: string;
  descendantsOf?: (pid: number) => Promise<number[]>;
  kill?: (pid: number) => void;
}) {
  const alive = new Set(o.alive);
  const events: string[] = [];
  const logs: string[] = [];
  const deps: ReapDeps = {
    runId: o.runId ?? MINE,
    trees: TREES,
    ps: o.ps ?? (async () => PS),
    descendantsOf: o.descendantsOf ?? (async (pid) => o.tree?.[pid] ?? []),
    kill:
      o.kill ??
      ((pid) => {
        events.push(`KILL ${pid}`);
        alive.delete(pid);
      }),
    exists: (pid) => alive.has(pid),
    log: (line) => logs.push(line),
  };
  return { deps, alive, events, logs };
}

/** 그 pid의 사건이 자손들의 사건보다 모두 뒤에 있는가. */
function afterDescendants(events: string[], parent: number, children: number[], verb: string) {
  const at = events.indexOf(`${verb} ${parent}`);
  expect(at).toBeGreaterThanOrEqual(0);
  for (const c of children) {
    const ci = events.indexOf(`${verb} ${c}`);
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(ci).toBeLessThan(at);
  }
}

describe("reapOrphans", () => {
  const ALL = [1, 5001, 5002, 5003, 5004, 5005, 5006, 6001, 6002, 6003, 6004, 6005];

  it("takes down every orphan and touches nothing external", async () => {
    const k = fakeKernel({ alive: ALL });
    const out = await reapOrphans(k.deps);
    expect(out).toEqual({ reaped: expect.arrayContaining([5001, 5002, 5003, 5004]) });
    expect("reaped" in out && out.reaped).toHaveLength(4);
    for (const pid of [1, 6001, 6002, 6003, 6004, 6005]) expect(k.alive.has(pid)).toBe(true);
  });

  it("kills descendants before their parents — run-id-less children included", async () => {
    // worker(5001) → --once(5002) → llm_entry(5003), 그리고 프로브(5006). embed(5004) → resource_tracker(5005).
    // descendantsOf는 BFS 순서(부모가 자식보다 앞)다 — process-tree.ts의 descendantPids.
    const k = fakeKernel({
      alive: ALL,
      tree: { 5001: [5002, 5006, 5003], 5002: [5003], 5004: [5005] },
    });
    const out = await reapOrphans(k.deps);
    afterDescendants(k.events, 5001, [5002, 5003, 5006], "KILL");
    afterDescendants(k.events, 5002, [5003], "KILL");
    afterDescendants(k.events, 5004, [5005], "KILL");
    expect("reaped" in out && [...out.reaped].sort()).toEqual([5001, 5002, 5003, 5004, 5005, 5006]);
    // 한 pid에 두 번 쏘지 않는다 — 5003은 5001과 5002 양쪽의 자손이다.
    expect(k.events.filter((e) => e === "KILL 5003")).toHaveLength(1);
  });

  it("re-checks each pid right before signalling it", async () => {
    // 5002는 스캔과 신호 사이에 끝났다 — 그 번호는 이미 다른 프로세스의 것일 수 있다.
    const k = fakeKernel({ alive: ALL.filter((p) => p !== 5002) });
    const out = await reapOrphans(k.deps);
    expect(k.events).not.toContain("KILL 5002");
    expect("reaped" in out && out.reaped).not.toContain(5002);
  });

  it("ignores a process of this run and says so in the log", async () => {
    const ps = `  PID ARGS\n 8001 ${DEV} -m damwha_worker --run-id=${MINE}`;
    const k = fakeKernel({ ps: async () => ps, alive: [8001] });
    expect(await reapOrphans(k.deps)).toEqual({ reaped: [] });
    expect(k.events).toEqual([]);
    expect(k.logs.join("\n")).toMatch(/8001/);
  });

  it("never signals a descendant that the scan judged external or mine", async () => {
    const k = fakeKernel({ alive: ALL, tree: { 5001: [6001] } });
    await reapOrphans(k.deps);
    expect(k.events).not.toContain("KILL 6001");
  });

  it("logs each reaped process with its pid, module and run-id", async () => {
    const k = fakeKernel({ alive: ALL, tree: { 5004: [5005] } });
    await reapOrphans(k.deps);
    const log = k.logs.join("\n");
    for (const pid of [5001, 5002, 5003, 5004]) expect(log).toContain(String(pid));
    expect(log).toContain("damwha_worker.llm_entry");
    expect(log).toContain("damwha_worker.embed_service");
    expect(log).toContain(OLD);
    expect(log).toContain("5005");
  });

  it("stays quiet when there is nothing to reap", async () => {
    const k = fakeKernel({ ps: async () => "  PID ARGS\n    1 /sbin/launchd", alive: [1] });
    expect(await reapOrphans(k.deps)).toEqual({ reaped: [] });
    expect(k.logs).toEqual([]);
  });

  it("fails without signalling anything when ps exits non-zero", async () => {
    const k = fakeKernel({
      ps: async () => {
        throw Object.assign(new Error("Command failed: /bin/ps -axwwo pid,args"), { code: 1 });
      },
      alive: ALL,
    });
    expect(await reapOrphans(k.deps)).toEqual({ failed: true });
    expect(k.events).toEqual([]);
    expect(k.logs.join("\n")).toMatch(/Command failed/);
  });

  it("fails on empty ps output — and on a header with no rows — instead of reading it as “no orphans”", async () => {
    for (const text of ["", "\n", "  PID ARGS\n"]) {
      const k = fakeKernel({ ps: async () => text, alive: ALL });
      expect(await reapOrphans(k.deps)).toEqual({ failed: true });
      expect(k.events).toEqual([]);
    }
  });

  it("fails without signalling anything when one of our lines cannot be read, and logs each", async () => {
    const ps = `${PS}\n 5101 ${DEV} -m damwha_worker --once --run-id=desktop-2222\n 5102 ${PKG} -m damwha_worker --run-id=`;
    const k = fakeKernel({ ps: async () => ps, alive: [...ALL, 5101, 5102] });
    expect(await reapOrphans(k.deps)).toEqual({ failed: true });
    expect(k.events).toEqual([]);
    const log = k.logs.join("\n");
    expect(log).toContain("5101");
    expect(log).toContain("5102");
  });

  it("does not let a guessed argv[0] inside a known tree be reaped", async () => {
    const ps = `  PID ARGS\n    1 /sbin/launchd\n 5201 ${DEV_ROOT}/bin/foo bar/python3.12 -m damwha_worker --run-id=${OLD}`;
    const k = fakeKernel({ ps: async () => ps, alive: [1, 5201] });
    expect(await reapOrphans(k.deps)).toEqual({ reaped: [] });
    expect(k.events).toEqual([]);
  });

  it("takes down an unmarked escape-hatch LLM server when it is a descendant of a proven orphan", async () => {
    // 스펙 §6.5의 "LENS_LLM_SERVER_BIN 서버는 손대지 않는다"는 **맨 위에서 알아보는** 규칙이다. 고아 --once의
    // 자손이라는 계보 자체가 소유의 증명이고, A층(stopWorkerProcess)도 자손을 SIGKILL한다 (판정 R-7i).
    const k = fakeKernel({ alive: ALL, tree: { 5002: [6005] } });
    const out = await reapOrphans(k.deps);
    expect(k.events).toContain("KILL 6005");
    afterDescendants(k.events, 5002, [6005], "KILL");
    expect("reaped" in out && out.reaped).toContain(6005);
  });

  it("does not SIGKILL a descendant the first scan never saw", async () => {
    // 첫 스캔 뒤에 생긴 번호는 "그때와 같은 프로세스인가"를 댈 근거가 없다 (판정 R-7g).
    const k = fakeKernel({ alive: [...ALL, 9999], tree: { 5001: [9999] } });
    await reapOrphans(k.deps);
    expect(k.events).not.toContain("KILL 9999");
    expect(k.events).toContain("KILL 5001");
    expect(k.logs.join("\n")).toMatch(/9999/);
  });

  it("fails before any signal when the descendant scan fails", async () => {
    const k = fakeKernel({
      alive: ALL,
      descendantsOf: async (pid) => {
        if (pid === 5004) throw new Error("ps timed out");
        return [];
      },
    });
    expect(await reapOrphans(k.deps)).toEqual({ failed: true });
    expect(k.events).toEqual([]);
  });

  it("does not count a pid whose signal was refused, and carries on with the rest", async () => {
    const k = fakeKernel({ alive: ALL });
    const killed: number[] = [];
    k.deps.kill = (pid) => {
      if (pid === 5003) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      killed.push(pid);
      k.alive.delete(pid);
    };
    const out = await reapOrphans(k.deps);
    expect("reaped" in out && [...out.reaped].sort()).toEqual([5001, 5002, 5004]);
    expect(killed.sort()).toEqual([5001, 5002, 5004]);
    expect(k.logs.join("\n")).toMatch(/5003.*EPERM|EPERM.*5003/);
  });

  describe("with a polite first signal (terminate + sleep)", () => {
    function graceful(o: Parameters<typeof fakeKernel>[0]) {
      const k = fakeKernel(o);
      const sleeps: number[] = [];
      const ignores = new Set(o.ignoresTerm ?? []);
      const deps: ReapDeps = {
        ...k.deps,
        terminate: (pid) => {
          k.events.push(`TERM ${pid}`);
          if (!ignores.has(pid)) k.alive.delete(pid);
        },
        sleep: async (ms) => {
          sleeps.push(ms);
          k.events.push("SLEEP");
        },
      };
      return { ...k, deps, sleeps };
    }

    it("sends SIGTERM first and does not wait or SIGKILL when everything leaves", async () => {
      const k = graceful({ alive: ALL, tree: { 5001: [5002, 5003], 5002: [5003] } });
      const out = await reapOrphans(k.deps);
      expect(k.events.filter((e) => e.startsWith("KILL"))).toEqual([]);
      expect(k.sleeps).toEqual([]);
      afterDescendants(k.events, 5001, [5002, 5003], "TERM");
      expect("reaped" in out && [...out.reaped].sort()).toEqual([5001, 5002, 5003, 5004]);
    });

    it("SIGKILLs only what outlives the grace, descendants first, within the bounded grace", async () => {
      // 5002(--once)와 5003(llm_entry)이 SIGTERM을 무시한다 — P4-C20의 SIG_IGN fixture와 같은 모양.
      const k = graceful({
        alive: ALL,
        tree: { 5001: [5002, 5003], 5002: [5003] },
        ignoresTerm: [5002, 5003],
      });
      await reapOrphans(k.deps);
      const firstKill = k.events.findIndex((e) => e.startsWith("KILL"));
      expect(k.events.slice(0, firstKill).filter((e) => e.startsWith("TERM"))).toHaveLength(4);
      expect(k.events.filter((e) => e.startsWith("KILL"))).toEqual(["KILL 5003", "KILL 5002"]);
      const waitedBeforeKill = k.events.slice(0, firstKill).filter((e) => e === "SLEEP").length;
      expect(waitedBeforeKill * ORPHAN_POLL_MS).toBe(ORPHAN_TERM_GRACE_MS);
      expect(k.sleeps.every((ms) => ms === ORPHAN_POLL_MS)).toBe(true);
    });

    it("re-checks right before each SIGKILL too", async () => {
      // 둘 다 유예를 넘겼다. 자식(5003)을 SIGKILL하자 부모(5002)가 스스로 끝났다 — 그 번호에는 쏘지 않는다.
      const k = graceful({ alive: ALL, tree: { 5002: [5003] }, ignoresTerm: [5002, 5003] });
      k.deps.kill = (pid) => {
        k.events.push(`KILL ${pid}`);
        k.alive.delete(pid);
        if (pid === 5003) k.alive.delete(5002);
      };
      const out = await reapOrphans(k.deps);
      expect(k.events.filter((e) => e.startsWith("KILL"))).toEqual(["KILL 5003"]);
      // SIGTERM은 닿았으니 5002도 신호를 받은 pid다.
      expect("reaped" in out && out.reaped).toContain(5002);
    });

    it("never SIGKILLs a number it did not SIGTERM — a pid reused during the grace is a stranger", async () => {
      // 5002는 스캔 뒤 SIGTERM 전에 끝났다. 유예 중에 그 번호를 다른 프로세스가 받았다.
      const k = graceful({ alive: ALL.filter((p) => p !== 5002), ignoresTerm: [5001] });
      k.deps.sleep = async () => {
        k.alive.add(5002);
      };
      const out = await reapOrphans(k.deps);
      expect(k.events).not.toContain("TERM 5002");
      expect(k.events).not.toContain("KILL 5002");
      expect(k.events).toContain("KILL 5001");
      expect("reaped" in out && out.reaped).not.toContain(5002);
    });

    it("re-reads ps before SIGKILL and spares a number whose command changed; the same command is killed", async () => {
      // 5002·5003 둘 다 SIGTERM을 무시했다. 유예 동안 5003은 끝나고 그 번호를 전혀 다른 프로세스가 받았다.
      const reused = PS.replace(/^ 5003 .*$/m, " 5003 /usr/bin/caffeinate -i");
      let scans = 0;
      const k = graceful({
        alive: ALL,
        ignoresTerm: [5002, 5003],
        ps: async () => (++scans === 1 ? PS : reused),
      });
      await reapOrphans(k.deps);
      expect(scans).toBe(2);
      expect(k.events).toContain("KILL 5002");
      expect(k.events).not.toContain("KILL 5003");
      expect(k.logs.join("\n")).toMatch(/5003/);
    });

    it("skips a number the second scan no longer lists", async () => {
      let scans = 0;
      const k = graceful({
        alive: ALL,
        ignoresTerm: [5002],
        ps: async () => (++scans === 1 ? PS : PS.replace(/^ 5002 .*\n/m, "")),
      });
      await reapOrphans(k.deps);
      expect(k.events).not.toContain("KILL 5002");
    });

    it("sends no SIGKILL and reports failure when the second scan fails while orphans remain", async () => {
      let scans = 0;
      const k = graceful({
        alive: ALL,
        ignoresTerm: [5002],
        ps: async () => {
          if (++scans === 1) return PS;
          throw new Error("Command failed: /bin/ps (second)");
        },
      });
      expect(await reapOrphans(k.deps)).toEqual({ failed: true });
      expect(k.events.filter((e) => e.startsWith("KILL"))).toEqual([]);
      expect(k.events.filter((e) => e.startsWith("TERM"))).toHaveLength(4);
      expect(k.logs.join("\n")).toMatch(/second/);
    });

    it("does not read ps a second time when SIGTERM was enough", async () => {
      let scans = 0;
      const k = graceful({ alive: ALL, ps: async () => (++scans, PS) });
      await reapOrphans(k.deps);
      expect(scans).toBe(1);
    });

    it("keeps the startup delay small", () => {
      expect(ORPHAN_TERM_GRACE_MS).toBeLessThanOrEqual(5_000);
      expect(ORPHAN_TERM_GRACE_MS % ORPHAN_POLL_MS).toBe(0);
    });
  });
});

describe("reapOwnOnceChildren", () => {
  it("reapOwnOnceChildren는 이번 실행의 --once 자식만 내린다", async () => {
    const ps = [
      "  PID ARGS",
      `  101 ${DEV} -m damwha_worker --run-id=${MINE}`,
      `  102 ${DEV} -m damwha_worker --run-id=${MINE} --once`,
      `  103 ${DEV} -m damwha_worker --run-id=${OLD} --once`,
    ].join("\n");
    const k = fakeKernel({ alive: [101, 102, 103], ps: async () => ps });

    const out = await reapOwnOnceChildren(k.deps);

    expect(out).toEqual({ reaped: [102] });
    expect(k.alive.has(101)).toBe(true);
    expect(k.alive.has(103)).toBe(true);
  });
});
