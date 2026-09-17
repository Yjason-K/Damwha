import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SpawnOptions } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { childEnv, llmBaseUrl } from "../../src/config/config";
import { CAUSES } from "../../src/diagnostics/causes";
import { launchPython } from "../../src/process/python-launcher";
import type { LaunchContext } from "../../src/services/types";
import { fakeChild } from "../fake-child";

/**
 * worker·embed 어댑터 테스트는 대부분 가짜 handle을 주입해 런처 자체를 부르지 않는다 — Phase 2 리뷰가
 * 실측한 두 구멍(detached: true, 'error' 리스너)이 그래서 전체 테스트를 통과한 채 숨어 있었다. 여기서는
 * spawnFn을 주입해 진짜 child_process.spawn 없이 런처가 넘기는 인자·옵션과 다는 리스너를 직접 본다.
 */

const PY = "/b/python/bin/python3.12";
const FF = "/b/ffmpeg/bin/ffmpeg";
const PY_BIN = "/b/python/bin";
const FF_BIN = "/b/ffmpeg/bin";

let tmpDir: string | undefined;

function ctx(over: Partial<LaunchContext> = {}): LaunchContext {
  const dir = tmpDir ?? (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-pylaunch-")));
  return {
    repoRoot: "/r",
    userData: "/u",
    packaged: false,
    databaseMode: "embedded",
    env: { LENS_LLM_BASE_URL: llmBaseUrl(51234), DATABASE_URL: "postgres://x" },
    bins: { python: PY, ffmpeg: FF, ffprobe: "/b/ffmpeg/bin/ffprobe" },
    runId: "desktop-test",
    // 앱 자신의 도구 탐색 목록. 자식 PATH에 한 조각도 들어가면 안 된다 (스펙 §6.2).
    searchDirs: ["/opt/homebrew/bin", "/usr/local/bin", "/Users/me/.local/bin", "/x/extra"],
    logFile: (id) => path.join(dir, `${id}.log`),
    signal: new AbortController().signal,
    ...over,
  };
}

function spawned() {
  const child = fakeChild();
  const spawnFn = vi.fn().mockReturnValue(child);
  const call = () => {
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnFn.mock.calls[0] as [string, string[], SpawnOptions];
    return { command, args, options, env: options.env as Record<string, string> };
  };
  return { child, spawnFn, call };
}

afterEach(() => {
  vi.unstubAllEnvs();
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe("launchPython — 실행 계약 (스펙 §6.2)", () => {
  it("enters by module with the bundled python3.12 itself, run-id last: `<python> -m <module> --run-id=<runId>`", () => {
    const { child, spawnFn, call } = spawned();
    launchPython({ ctx: ctx(), module: "damwha_worker", logId: "worker", spawnFn });
    const { command, args } = call();
    // 콘솔 스크립트(셔뱅)도 bin/python·python3 링크도 아니다 — argv[0]이 실체 이름으로 남아야 §6.5 조건 1이 선다.
    expect(command).toBe(PY);
    expect(args).toEqual(["-m", "damwha_worker", "--run-id=desktop-test"]);
    child.emit("exit", 0);
  });

  it("puts extra args after the module and before --run-id", () => {
    const { child, spawnFn, call } = spawned();
    launchPython({
      ctx: ctx(),
      module: "damwha_worker.embed_service",
      args: ["--flag", "value"],
      logId: "embed",
      spawnFn,
    });
    const { args } = call();
    expect(args).toEqual(["-m", "damwha_worker.embed_service", "--flag", "value", "--run-id=desktop-test"]);
    expect(args[args.length - 1]).toBe("--run-id=desktop-test");
    child.emit("exit", 0);
  });

  it("gives the child exactly `<python>/bin:<ffmpeg>/bin` as PATH — no inherited PATH, no Homebrew, no searchDirs", () => {
    vi.stubEnv("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    const { child, spawnFn, call } = spawned();
    const c = ctx();
    launchPython({ ctx: c, module: "damwha_worker", logId: "worker", spawnFn });
    const { env } = call();
    expect(env.PATH).toBe(`${PY_BIN}:${FF_BIN}`);
    const entries = env.PATH.split(":");
    for (const entry of entries) {
      expect(entry).not.toMatch(/^\/opt\/homebrew|^\/usr\/local/);
      expect(c.searchDirs).not.toContain(entry);
    }
    child.emit("exit", 0);
  });

  it("builds the rest of the env with childEnv(ctx) alone — the one composition rule — and only sets PATH on top", () => {
    // 상속과 config.json 양쪽에 금지 키를 둔다. 런처가 합성을 스스로 다시 짜면(예: 상속을 뒤에 펼치거나
    // 씻기 전에 앱 값을 얹으면) 아래 동치가 깨진다.
    vi.stubEnv("PYTHONHOME", "/evil/home");
    vi.stubEnv("PYTHONPATH", "/evil/path");
    vi.stubEnv("HF_HOME", "/Users/me/.cache/huggingface");
    const { child, spawnFn, call } = spawned();
    const c = ctx({ env: { ...ctx().env, VIRTUAL_ENV: "/evil/venv" } });
    launchPython({ ctx: c, module: "damwha_worker", logId: "worker", spawnFn });
    const { env } = call();
    expect(env).toEqual({ ...childEnv(c), PATH: `${PY_BIN}:${FF_BIN}` });
    // 동치만으로는 childEnv 자체가 틀려도 초록이다 — 이 실행에서 중요한 결과 넷을 직접 본다.
    expect(env.PYTHONPATH).toBe("/r/be/worker");
    expect(env.HF_HOME).toBe("/u/models");
    expect("PYTHONHOME" in env).toBe(false);
    expect("VIRTUAL_ENV" in env).toBe(false);
    child.emit("exit", 0);
  });

  it("runs in userData — the worker no longer has a checkout to sit in", () => {
    const { child, spawnFn, call } = spawned();
    launchPython({ ctx: ctx({ repoRoot: null, packaged: true }), module: "damwha_worker", logId: "worker", spawnFn });
    expect(call().options.cwd).toBe("/u");
    child.emit("exit", 0);
  });

  it("does not spawn a dev child without a checkout — childEnv's PYTHONPATH rule refuses first", () => {
    const { spawnFn } = spawned();
    expect(() =>
      launchPython({ ctx: ctx({ repoRoot: null, packaged: false }), module: "damwha_worker", logId: "worker", spawnFn }),
    ).toThrow(CAUSES.repoRootMissing.text);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  for (const [label, python] of [
    ["empty", ""],
    ["relative", "python3.12"],
  ] as const) {
    it(`refuses a ${label} python path and says why, without spawning`, () => {
      const { spawnFn } = spawned();
      expect(() =>
        launchPython({ ctx: ctx({ bins: { ...ctx().bins, python } }), module: "damwha_worker", logId: "worker", spawnFn }),
      ).toThrow(/Python/);
      expect(spawnFn).not.toHaveBeenCalled();
    });
  }
});

describe("launchPython — 프로세스 배선", () => {
  it("spawns detached with stdin ignored and both output streams piped", () => {
    // detached가 없으면 python이 Electron의 그룹에 들어가, dev 터미널의 그룹 신호(Ctrl-C)가 종료 절차를
    // 거치지 않고 곧바로 닿는다. detached는 또한 python을 자기 그룹의 리더로 만든다 — worker-shutdown.ts의
    // 그룹 SIGTERM(-pid)이 그 사실에 기댄다.
    const { child, spawnFn, call } = spawned();
    launchPython({ ctx: ctx(), module: "damwha_worker", logId: "worker", spawnFn });
    const { options } = call();
    expect(options.detached).toBe(true);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    child.emit("exit", 0);
  });

  it("keeps stdout and stderr in separate tails, and hands only stderr to onStderr", () => {
    const { child, spawnFn } = spawned();
    const seen: string[] = [];
    const { handle } = launchPython({
      ctx: ctx(),
      module: "damwha_worker.embed_service",
      logId: "embed",
      spawnFn,
      onStderr: (t) => seen.push(t),
    });
    if (handle === null) throw new Error("handle이 없다");
    child.stdout.emit("data", Buffer.from("GET /health 200 OK\n"));
    child.stderr.emit("data", Buffer.from("Traceback: 실패\n"));

    expect(handle.stdoutTail()).toContain("GET /health 200 OK");
    expect(handle.stdoutTail()).not.toContain("Traceback");
    expect(handle.stderrTail()).toContain("Traceback");
    expect(handle.stderrTail()).not.toContain("GET /health");
    expect(seen).toEqual(["Traceback: 실패\n"]);
    child.emit("exit", 0);
  });

  it("writes both streams to the service's log file", async () => {
    const { child, spawnFn } = spawned();
    const c = ctx();
    launchPython({ ctx: c, module: "damwha_worker", logId: "worker", spawnFn });
    child.stdout.emit("data", Buffer.from("out line\n"));
    child.stderr.emit("data", Buffer.from("err line\n"));
    child.emit("exit", 0);
    await vi.waitFor(() => {
      const text = fs.readFileSync(c.logFile("worker"), "utf8");
      expect(text).toContain("out line");
      expect(text).toContain("err line");
    });
  });

  it("folds a spawn 'error' into exitCode() === -1 instead of crashing main", () => {
    const { child, spawnFn } = spawned();
    const { handle, owned } = launchPython({ ctx: ctx(), module: "damwha_worker", logId: "worker", spawnFn });
    if (handle === null) throw new Error("handle이 없다");
    expect(owned).toBe(true);
    const exits: number[] = [];
    handle.onExit((c) => exits.push(c));
    // 리스너가 없으면 EventEmitter가 'error'를 동기로 다시 던진다 — Electron main이 통째로 죽는다.
    expect(() => child.emit("error", Object.assign(new Error(`spawn ${PY} ENOENT`), { code: "ENOENT" }))).not.toThrow();
    expect(handle.exitCode()).toBe(-1);
    expect(handle.alive()).toBe(false);
    expect(exits).toEqual([-1]);
    // 감독자가 죽은 핸들의 꼬리에서 원인을 올린다 (causes.ts의 spawnNotFound).
    expect(handle.stderrTail()).toContain(`spawn failed: spawn ${PY} ENOENT`);
    // 뒤따르는 'exit'가 결과를 덮지 않는다.
    child.emit("exit", 0);
    expect(handle.exitCode()).toBe(-1);
    expect(exits).toEqual([-1]);
  });

  it("reports the exit code once, also to a listener that registers after the exit", () => {
    const { child, spawnFn } = spawned();
    const { handle } = launchPython({ ctx: ctx(), module: "damwha_worker", logId: "worker", spawnFn });
    if (handle === null) throw new Error("handle이 없다");
    expect(handle.pid).toBe(4242);
    expect(handle.alive()).toBe(true);
    child.emit("exit", 3);
    const late: number[] = [];
    handle.onExit((c) => late.push(c));
    expect(late).toEqual([3]);
    expect(handle.alive()).toBe(false);
  });

  it("stop() sends one SIGTERM straight to the python pid — no forwarder in between, no group", async () => {
    // 진짜 신호가 나가지 않게 process.kill을 가로챈다 — 4242는 이 기계에 실재할 수 있는 pid다.
    const { child, spawnFn } = spawned();
    const kills: Array<[number, string | number | undefined]> = [];
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      kills.push([pid, sig]);
      return true;
    });
    try {
      const { handle } = launchPython({ ctx: ctx(), module: "damwha_worker.embed_service", logId: "embed", spawnFn });
      if (handle === null) throw new Error("handle이 없다");
      // 신호를 받자마자 끝나는 자식을 흉내 낸다. 유예 루프가 한 바퀴 안에 빠져나온다.
      const stopping = handle.stop(1_000);
      child.emit("exit", 0);
      await stopping;
      // 이미 끝난 핸들에는 다시 보내지 않는다 — 그 pid는 이제 남의 것일 수 있다.
      await handle.stop(1_000);
    } finally {
      spy.mockRestore();
    }
    expect(kills).toEqual([[4242, "SIGTERM"]]);
  });
});
