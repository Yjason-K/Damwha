import { describe, expect, it } from "vitest";
import { leftoverNotice, runQuitFlow, type QuitFlowDeps, type QuitNotice } from "../../src/app/quit-flow";
import { quitReapDeps, reapOwnedOnQuit, stopThenReap, withReaped } from "../../src/app/reap-on-quit";
import {
  ORPHAN_POLL_MS,
  ORPHAN_TERM_GRACE_MS,
  type DamwhaProcess,
  type KnownTree,
  type ReapDeps,
} from "../../src/process/orphans";
import type { StopOutcome } from "../../src/services/types";
import { STOP_DETAIL } from "../../src/services/worker-shutdown";

// 공백이 든 설치 경로 — 판독기가 아는 접두사로 자르는 경로를 그대로 밟는다.
const ROOT = "/Users/me/My Apps/Damwha.app/Contents/Resources/python";
const PY = `${ROOT}/bin/python3.12`;
const TREES: readonly KnownTree[] = [{ root: ROOT, python: PY }];

const MINE = "desktop-11111111-1111-4111-8111-111111111111";
const OLD = "desktop-22222222-2222-4222-8222-222222222222";

/** 이번 실행이 띄우는 네 모양 (Task 5의 argv — run-id는 런처가 마지막에 붙이고, llm_entry는 뒤에 서버 인자가 온다). */
const MY = {
  worker: ` 8001 ${PY} -m damwha_worker --run-id=${MINE}`,
  once: ` 8002 ${PY} -m damwha_worker --once --run-id=${MINE}`,
  llm: ` 8003 ${PY} -m damwha_worker.llm_entry --run-id=${MINE} --model mlx-community/Qwen3-4B-4bit --host 127.0.0.1 --port 51234`,
  embed: ` 8004 ${PY} -m damwha_worker.embed_service --run-id=${MINE}`,
};

const table = (...rows: string[]) => ["  PID ARGS", "    1 /sbin/launchd", ...rows].join("\n");
const ALL_MINE = table(MY.worker, MY.once, MY.llm, MY.embed);

/**
 * 가짜 커널. `alive`에 든 pid만 산다. SIGKILL은 늘 죽이고 SIGTERM은 `ignoresTerm`이 아니면 죽인다.
 * B층의 실제 배선(systemReapDeps)처럼 terminate·sleep이 있다 — 판정 R-7e.
 */
function kernel(o: {
  ps?: string | (() => Promise<string>);
  alive: number[];
  tree?: Record<number, number[]>;
  ignoresTerm?: number[];
}) {
  const alive = new Set(o.alive);
  const ignores = new Set(o.ignoresTerm ?? []);
  const events: string[] = [];
  const logs: string[] = [];
  const text = o.ps;
  const d: ReapDeps = {
    runId: MINE,
    trees: TREES,
    ps: typeof text === "function" ? text : async () => text ?? ALL_MINE,
    descendantsOf: async (pid) => (o.tree?.[pid] ?? []).filter((p) => alive.has(p)),
    kill: (pid) => {
      events.push(`KILL ${pid}`);
      alive.delete(pid);
    },
    terminate: (pid) => {
      events.push(`TERM ${pid}`);
      if (!ignores.has(pid)) alive.delete(pid);
    },
    exists: (pid) => alive.has(pid),
    log: (line) => logs.push(line),
    sleep: async () => {
      events.push("SLEEP");
    },
  };
  return { d, alive, events, logs };
}

const pids = (list: readonly DamwhaProcess[]) => list.map((p) => p.pid).sort((a, b) => a - b);
const signalled = (events: readonly string[]) => events.filter((e) => e !== "SLEEP");

/** `parent`의 `verb` 사건이 `children`의 것보다 모두 뒤에 있는가. */
function afterDescendants(events: string[], parent: number, children: number[], verb: string) {
  const at = events.indexOf(`${verb} ${parent}`);
  expect(at).toBeGreaterThanOrEqual(0);
  for (const c of children) {
    const ci = events.indexOf(`${verb} ${c}`);
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(ci).toBeLessThan(at);
  }
}

describe("reapOwnedOnQuit — 핸들과 무관한 종료 회수 (B층, 스펙 §6.5)", () => {
  it("reaps every process carrying this run's id with no service handle at all — worker, --once, llm_entry, embed", async () => {
    // worker(8001) → --once(8002) → llm_entry(8003). embed(8004)는 따로. 인자에 핸들이 없다 — ps의 표식만 본다.
    const k = kernel({ alive: [1, 8001, 8002, 8003, 8004], tree: { 8001: [8002, 8003], 8002: [8003] } });
    const { reaped } = await reapOwnedOnQuit(k.d);
    expect(pids(reaped)).toEqual([8001, 8002, 8003, 8004]);
    expect(reaped.find((p) => p.pid === 8002)).toMatchObject({ module: "damwha_worker", once: true, runId: MINE });
    for (const pid of [8001, 8002, 8003, 8004]) expect(k.alive.has(pid)).toBe(false);
    // 자손이 부모보다 먼저다 — 뒤집히면 부모가 사라지며 트리를 잃는다.
    afterDescendants(k.events, 8001, [8002, 8003], "TERM");
    afterDescendants(k.events, 8002, [8003], "TERM");
    expect(k.alive.has(1)).toBe(true);
  });

  it("reaps a lone llm_entry whose worker supervisor and --once are both gone (P4-C19-b)", async () => {
    // supervisor와 --once를 둘 다 kill -9 했다. llm_entry는 launchd 아래로 재부모화됐고 --once 토큰도 없다.
    // 부모 트리에 기대지 않는다 — 자기 argv의 run-id가 소유의 증거다 (스펙 §6.2의 진입 모듈).
    const k = kernel({ ps: table(MY.llm), alive: [1, 8003] });
    const { reaped } = await reapOwnedOnQuit(k.d);
    expect(reaped).toEqual([
      { pid: 8003, module: "damwha_worker.llm_entry", runId: MINE, once: false, argv0: PY, tree: ROOT },
    ]);
    expect(signalled(k.events)).toEqual(["TERM 8003"]);
    expect(k.alive.has(8003)).toBe(false);
  });

  it("leaves another run's processes alone — even when one sits under a process of this run", async () => {
    // 다른 run-id는 기동 시 정리(reapOrphans)의 일이다. 여기서 내리면 동시에 뜬 다른 실행을 죽일 수 있다.
    const ps = table(
      MY.worker,
      ` 5001 ${PY} -m damwha_worker --run-id=${OLD}`,
      ` 5003 ${PY} -m damwha_worker.llm_entry --run-id=${OLD} --port 50000`,
    );
    const k = kernel({ ps, alive: [1, 8001, 5001, 5003], tree: { 8001: [5003] } });
    const { reaped } = await reapOwnedOnQuit(k.d);
    expect(pids(reaped)).toEqual([8001]);
    expect(signalled(k.events)).toEqual(["TERM 8001"]);
    expect(k.alive.has(5001)).toBe(true);
    expect(k.alive.has(5003)).toBe(true);
  });

  it("leaves an external worker without a run-id alone — repo .venv or the bundled python run by hand", async () => {
    const ps = table(
      " 6001 /Users/me/daewha/be/worker/.venv/bin/python3.12 -m damwha_worker",
      ` 6002 ${PY} -m damwha_worker`,
      ` 6003 ${PY} -m damwha_worker.embed_service`,
      ` 6004 /usr/bin/grep --run-id=${MINE} damwha_worker`,
      ` 6005 /bin/zsh -c ${PY} -m damwha_worker --run-id=${MINE}`,
    );
    const k = kernel({ ps, alive: [1, 6001, 6002, 6003, 6004, 6005] });
    expect(await reapOwnedOnQuit(k.d)).toEqual({ reaped: [] });
    expect(k.events).toEqual([]);
  });

  it("does not signal a pid that left between the scan and the signal", async () => {
    // 8002는 스캔 뒤에 끝났다 — 그 번호는 이미 다른 프로세스의 것일 수 있다.
    const k = kernel({ alive: [1, 8001, 8003, 8004] });
    const { reaped } = await reapOwnedOnQuit(k.d);
    expect(k.events).not.toContain("TERM 8002");
    expect(k.events).not.toContain("KILL 8002");
    expect(pids(reaped)).toEqual([8001, 8003, 8004]);
  });

  it("logs each process it reaped and says layer A missed them", async () => {
    const k = kernel({ ps: table(MY.once, MY.embed), alive: [1, 8002, 8004], tree: { 8002: [9100] } });
    k.alive.add(9100); // --once 아래의 표식 없는 자손 (탈출구 LLM 서버) — 계보로 함께 내린다 (판정 R-7i)
    await reapOwnedOnQuit(k.d);
    const log = k.logs.join("\n");
    // 한 프로세스에 한 줄 — pid·모듈·--once·run-id를 싣는다.
    const onceLine = k.logs.find((l) => l.includes("8002"));
    expect(onceLine).toBeDefined();
    expect(onceLine).toContain("damwha_worker --once");
    expect(onceLine).toContain(MINE);
    const embedLine = k.logs.find((l) => l.includes("8004"));
    expect(embedLine).toContain("damwha_worker.embed_service");
    expect(embedLine).toContain(MINE);
    expect(log).toContain("9100");
    // 요약 줄 — 조용히 덮으면 A층의 결함이 영영 안 보인다.
    const summary = k.logs[k.logs.length - 1];
    expect(summary).toMatch(/서비스별 정지/);
    expect(summary).toMatch(/놓친/);
    expect(summary).toContain("8002");
    expect(summary).toContain("8004");
    // 모든 줄이 종료 회수의 것임을 밝힌다 — 같은 supervisor.log에 기동 정리의 줄도 있다.
    for (const line of k.logs) expect(line.startsWith("종료 회수")).toBe(true);
  });

  it("stays silent when there is nothing of this run left", async () => {
    const ps = table(
      ` 5001 ${PY} -m damwha_worker --run-id=${OLD}`,
      " 6001 /Users/me/daewha/be/worker/.venv/bin/python3.12 -m damwha_worker",
      ` 6006 ${PY} -c import json, platform; print(json.dumps({}))`,
    );
    const k = kernel({ ps, alive: [1, 5001, 6001, 6006] });
    expect(await reapOwnedOnQuit(k.d)).toEqual({ reaped: [] });
    expect(k.logs).toEqual([]);
    expect(k.events).toEqual([]);
  });

  describe("polite first signal (판정 R-7e)", () => {
    it("SIGTERMs first and SIGKILLs only what outlives the grace, descendants first", async () => {
      // A층이 핸들을 잃어 SIGTERM을 한 번도 못 받은 것들이다 — 먼저 스스로 끝날 기회를 준다.
      const k = kernel({
        alive: [1, 8001, 8002, 8003, 8004],
        tree: { 8001: [8002, 8003], 8002: [8003] },
        ignoresTerm: [8002, 8003],
      });
      const { reaped } = await reapOwnedOnQuit(k.d);
      const firstKill = k.events.findIndex((e) => e.startsWith("KILL"));
      expect(k.events.slice(0, firstKill).filter((e) => e.startsWith("TERM"))).toHaveLength(4);
      expect(k.events.filter((e) => e.startsWith("KILL"))).toEqual(["KILL 8003", "KILL 8002"]);
      expect(k.events.slice(0, firstKill).filter((e) => e === "SLEEP")).toHaveLength(ORPHAN_TERM_GRACE_MS / ORPHAN_POLL_MS);
      expect(pids(reaped)).toEqual([8001, 8002, 8003, 8004]);
    });

    it("returns what it SIGTERMed when the re-read before SIGKILL fails — and sends no SIGKILL", async () => {
      let scans = 0;
      const k = kernel({
        ps: async () => {
          if (++scans === 1) return ALL_MINE;
          throw new Error("Command failed: /bin/ps (second)");
        },
        alive: [1, 8001, 8002, 8003, 8004],
        ignoresTerm: [8002],
      });
      const { reaped } = await reapOwnedOnQuit(k.d);
      expect(pids(reaped)).toEqual([8001, 8002, 8003, 8004]);
      expect(k.events.filter((e) => e.startsWith("KILL"))).toEqual([]);
      expect(k.logs.join("\n")).toMatch(/second/);
    });
  });

  describe("an unusable scan — one line, no signal, never a throw", () => {
    it.each([
      ["ps exits non-zero", async () => Promise.reject(new Error("Command failed: /bin/ps"))],
      ["ps prints nothing", async () => ""],
      ["ps prints only its header", async () => "  PID ARGS\n"],
    ] as Array<[string, () => Promise<string>]>)("%s", async (_name, ps) => {
      const k = kernel({ ps, alive: [1, 8001] });
      await expect(reapOwnedOnQuit(k.d)).resolves.toEqual({ reaped: [] });
      expect(k.events).toEqual([]);
      expect(k.logs).toHaveLength(1);
      expect(k.logs[0].startsWith("종료 회수")).toBe(true);
    });

    it("sends nothing when one of our lines cannot be read — even to the readable ones — and logs a single line", async () => {
      const ps = table(MY.worker, ` 8101 ${PY} -m damwha_worker --once --run-id=desktop-1111`, ` 8102 ${PY} -m damwha_worker --run-id=`);
      const k = kernel({ ps, alive: [1, 8001, 8101, 8102] });
      expect(await reapOwnedOnQuit(k.d)).toEqual({ reaped: [] });
      expect(k.events).toEqual([]);
      expect(k.logs).toHaveLength(1);
      expect(k.logs[0]).toContain("8101");
      expect(k.logs[0]).toContain("8102");
    });

    it("sends nothing when the descendant lookup fails", async () => {
      const k = kernel({ alive: [1, 8001, 8002, 8003, 8004] });
      k.d.descendantsOf = async () => {
        throw new Error("ps timed out");
      };
      expect(await reapOwnedOnQuit(k.d)).toEqual({ reaped: [] });
      expect(k.events).toEqual([]);
      expect(k.logs).toHaveLength(1);
    });

    it("resolves with what it already signalled when a dependency throws mid-way", async () => {
      // 뿌리는 스캔 순서로 돈다 — embed(8004)에 SIGTERM을 보낸 뒤 worker(8001)의 존재 확인이 던진다.
      const k = kernel({ ps: table(MY.embed, MY.worker), alive: [1, 8001, 8004] });
      const exists = k.d.exists;
      k.d.exists = (pid) => {
        if (pid === 8001) throw new Error("kernel said no");
        return exists(pid);
      };
      const out = await reapOwnedOnQuit(k.d);
      expect(pids(out.reaped)).toEqual([8004]);
      expect(k.logs.join("\n")).toContain("kernel said no");
    });

    it("does not throw even when the log itself throws", async () => {
      const k = kernel({ ps: async () => Promise.reject(new Error("ps gone")), alive: [1] });
      k.d.log = () => {
        throw new Error("disk full");
      };
      await expect(reapOwnedOnQuit(k.d)).resolves.toEqual({ reaped: [] });
    });
  });
});

describe("stopThenReap — main.ts stopServices()의 순서 (A층 → B층)", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("runs B only after A has settled", async () => {
    const a = deferred<StopOutcome>();
    const k = kernel({ ps: table(MY.llm), alive: [1, 8003] });
    const order: string[] = [];
    const ps = k.d.ps;
    k.d.ps = async () => {
      order.push("B:ps");
      return ps();
    };
    const running = stopThenReap(async () => {
      order.push("A:start");
      const out = await a.promise;
      order.push("A:end");
      return out;
    }, k.d);
    await new Promise((r) => setTimeout(r, 10));
    // A가 worker의 90초 유예 안에 있는 동안 B가 SIGTERM→3초→SIGKILL을 걸면 정중한 정지(P2-C5)가 깨진다.
    expect(order).toEqual(["A:start"]);
    a.resolve({ stopped: true, leaked: [] });
    await running;
    expect(order).toEqual(["A:start", "A:end", "B:ps"]);
  });

  it("still runs B when A throws, then rethrows A's error unchanged", async () => {
    const k = kernel({ ps: table(MY.llm), alive: [1, 8003] });
    const boom = new Error("stopAll exploded");
    await expect(
      stopThenReap(async () => {
        throw boom;
      }, k.d),
    ).rejects.toBe(boom);
    expect(signalled(k.events)).toEqual(["TERM 8003"]);
    expect(k.alive.has(8003)).toBe(false);
  });

  it("turns A's clean verdict into not-clean when B had to reap something", async () => {
    const k = kernel({ ps: table(MY.llm), alive: [1, 8003] });
    const out = await stopThenReap(async () => ({ stopped: true, leaked: [] }), k.d);
    expect(out.stopped).toBe(false);
    expect(out.detail).toMatch(/8003/);
    // SIGTERM으로 끝났으니 남은 것은 없다 — 화면이 "살아 있을 수 있다"고 말하지 않는다.
    expect(out.leaked).toEqual([]);
  });

  it("keeps A's verdict untouched when B found nothing", async () => {
    const k = kernel({ ps: table(), alive: [1] });
    const clean: StopOutcome = { stopped: true, leaked: [] };
    expect(await stopThenReap(async () => clean, k.d)).toEqual(clean);
    const dirty: StopOutcome = { stopped: false, leaked: [42], detail: "아직 살아 있어요." };
    expect(await stopThenReap(async () => dirty, k.d)).toEqual(dirty);
  });

  it("skips B when this run never got as far as its trees (quit during onboarding)", async () => {
    const out: StopOutcome = { stopped: true, leaked: [] };
    expect(await stopThenReap(async () => out, null)).toEqual(out);
    const boom = new Error("x");
    await expect(
      stopThenReap(async () => {
        throw boom;
      }, null),
    ).rejects.toBe(boom);
  });

  it("puts B's catch on the quit screen through runQuitFlow's leftover judgment", async () => {
    // "남은 것" 판정은 runQuitFlow(quit-flow.ts)가 stopServices의 StopOutcome으로 내린다. A가 clean이라 해도
    // B가 무언가 내렸으면 경고가 뜬다 — 합치는 자리는 stopServices의 반환값이다.
    const k = kernel({ ps: table(MY.once), alive: [1, 8002], ignoresTerm: [8002] });
    // SIGKILL도 먹지 않는 프로세스 — 남은 것으로 화면에 오른다.
    k.d.kill = (pid) => {
      k.events.push(`KILL ${pid}`);
    };
    const warned: QuitNotice[] = [];
    const deps: QuitFlowDeps = {
      inFlight: async () => ({ recording: false, analysing: false }),
      confirm: async () => true,
      captureDescendants: async () => undefined,
      beginQuit: () => undefined,
      showQuitting: async () => undefined,
      screenTimeoutMs: 50,
      stopRecording: async () => ({ stopped: true }),
      handshakeTimeoutMs: 50,
      stopServices: () => stopThenReap(async () => ({ stopped: true, leaked: [] }), k.d),
      log: () => undefined,
      warn: async (notice) => {
        warned.push(notice);
      },
      quit: () => undefined,
    };
    await runQuitFlow(deps);
    expect(warned).toHaveLength(1);
    expect(warned[0].message).toBe("아직 살아 있을 수 있는 프로세스가 있어요.");
    expect(warned[0].detail).toContain("8002");
  });
});

describe("withReaped — B층의 결과를 A층의 판정에 합친다", () => {
  const p = (pid: number, over: Partial<DamwhaProcess> = {}): DamwhaProcess => ({
    pid,
    module: "damwha_worker",
    runId: MINE,
    once: false,
    argv0: PY,
    tree: ROOT,
    ...over,
  });

  it("returns A's outcome as is when B reaped nothing", () => {
    const out: StopOutcome = { stopped: true, leaked: [] };
    expect(withReaped(out, [], () => true)).toBe(out);
  });

  it("lists only the reaped processes that still exist as leftovers, without duplicating A's", () => {
    const merged = withReaped({ stopped: false, leaked: [8002, 111], detail: "A의 사유" }, [p(8001), p(8002)], (pid) => pid !== 8001);
    expect(merged.stopped).toBe(false);
    expect(merged.leaked).toEqual([8002, 111]);
    expect(merged.detail?.split("\n")[0]).toBe("A의 사유");
    expect(merged.detail).toMatch(/8001/);
  });

  it("keeps what the screen would have said for a not-clean A without its own reason", () => {
    // leftoverNotice는 detail이 없으면 STOP_DETAIL.unverifiable을 쓴다. B의 줄이 그 자리를 빼앗으면 A의 사유가 사라진다.
    const merged = withReaped({ stopped: false, leaked: [] }, [p(8003, { module: "damwha_worker.llm_entry" })], () => false);
    expect(merged.detail).toContain(STOP_DETAIL.unverifiable);
    expect(leftoverNotice(merged).detail).toContain("8003");
  });
});

describe("quitReapDeps — main.ts가 B층에 넘기는 배선", () => {
  it("is null when this run never computed its trees", () => {
    expect(quitReapDeps(null, () => undefined)).toBeNull();
  });

  it("uses this run's id and trees with the polite first signal", () => {
    const d = quitReapDeps({ runId: MINE, trees: TREES }, () => undefined);
    expect(d).not.toBeNull();
    expect(d!.runId).toBe(MINE);
    expect(d!.trees).toBe(TREES);
    expect(typeof d!.terminate).toBe("function");
    expect(typeof d!.sleep).toBe("function");
    expect(d!.exists(process.pid)).toBe(true);
  });
});
