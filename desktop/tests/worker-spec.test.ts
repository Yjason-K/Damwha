import { describe, expect, it, vi } from "vitest";
import { workerDegraded, workerReady, workerSpec } from "../src/services/worker";
import type { LaunchContext, ServiceHandle } from "../src/services/types";

const READY = "INFO supervisor desktop-7 ready (db connected)";
const STARTED = "INFO supervisor desktop-7 started";
const RECONNECT_FAILED = "WARNING reconnect failed — retry in 2s";

function ctx(over: Partial<LaunchContext> = {}): LaunchContext {
  return {
    repoRoot: "/r",
    userData: "/u",
    packaged: true,
    env: { DATABASE_URL: "postgres://x", STORAGE_ROOT: "/u/storage" },
    bins: { uv: "/opt/homebrew/bin/uv", docker: "/usr/local/bin/docker" },
    searchDirs: ["/opt/homebrew/bin"],
    logFile: (id) => `/u/logs/${id}.log`,
    ...over,
  };
}

function handle(tail: string, alive = true): ServiceHandle {
  return {
    pid: 4242,
    alive: () => alive,
    stderrTail: () => tail,
    exitCode: () => (alive ? null : 1),
    onExit: () => undefined,
    stop: async () => undefined,
  } as unknown as ServiceHandle;
}

describe("workerReady", () => {
  it("is false for the pre-connect line", () => {
    // __main__.py:296은 DB에 붙기 전에 찍힌다. 이 줄을 준비로 읽으면 화면은
    // "준비됨"인데 큐는 영원히 안 돈다.
    expect(workerReady(STARTED)).toBe(false);
  });

  it("is true once the post-connect line appears", () => {
    expect(workerReady(`${STARTED}\n${READY}`)).toBe(true);
  });

  it("survives a worker id with dashes and digits", () => {
    expect(workerReady("INFO supervisor desktop-1757600000-99 ready (db connected)")).toBe(true);
  });
});

describe("workerDegraded", () => {
  it("is true when a reconnect failure follows the last ready line", () => {
    expect(workerDegraded(`${READY}\n${RECONNECT_FAILED}`)).toBe(true);
  });

  it("is false when a ready line follows the failure — that is recovery", () => {
    expect(workerDegraded(`${READY}\n${RECONNECT_FAILED}\n${READY}`)).toBe(false);
  });

  it("is false before the first ready line", () => {
    expect(workerDegraded(`${STARTED}\n${RECONNECT_FAILED}`)).toBe(false);
  });
});

describe("workerSpec", () => {
  const deps = (over = {}) => ({
    listExternal: async () => [] as number[],
    ...over,
  });

  it("depends on postgres and is not a gate", () => {
    const spec = workerSpec(deps() as never);
    expect(spec.dependsOn).toContain("postgres");
    expect(spec.gate).toBe(false);
  });

  it("stands down when an external supervisor is running", async () => {
    const spec = workerSpec(deps({ listExternal: async () => [4101] }) as never);
    const ext = await spec.detectExternal(ctx());
    expect(ext.kind).toBe("stand-down");
    // env를 읽을 수 없으므로(ps eww는 SIP가 막는다) 채택을 증명할 수 없다 — 경고한다.
    expect(ext.kind === "stand-down" && ext.detail).toMatch(/STORAGE_ROOT/);
  });

  it("launches when nothing external is running", async () => {
    expect((await workerSpec(deps() as never).detectExternal(ctx())).kind).toBe("absent");
  });

  it("refuses to launch without uv and names the fix", async () => {
    const spec = workerSpec(deps() as never);
    await expect(spec.launch(ctx({ bins: { uv: null, docker: null } }))).rejects.toThrow(/uv/);
  });

  it("refuses to launch when the worker .env is missing", async () => {
    // be/.gitignore:7이 be/worker/.env를 무시하므로 새 체크아웃에는 없다. 없으면
    // LENS_LLM_BASE_URL이 비어 worker가 로그 한 줄 전에 죽는다 (config.py:34-39).
    const spec = workerSpec(deps({ exists: () => false }) as never);
    await expect(spec.launch(ctx())).rejects.toThrow(/\.env/);
  });

  it("reads ready from stderr, not from the process being alive", async () => {
    const spec = workerSpec(deps() as never);
    const notYet = await spec.readiness({ handle: handle(STARTED), owned: true }, ctx());
    expect(notYet.kind).toBe("not-ready");
    const yes = await spec.readiness({ handle: handle(`${STARTED}\n${READY}`), owned: true }, ctx());
    expect(yes.kind).toBe("ready");
  });

  it("reports degraded when the DB drops after ready", async () => {
    const spec = workerSpec(deps() as never);
    const r = await spec.readiness(
      { handle: handle(`${READY}\n${RECONNECT_FAILED}`), owned: true },
      ctx(),
    );
    expect(r.kind).toBe("degraded");
  });

  it("keeps watching health after it is ready", () => {
    // worker도 ready 뒤 DB가 끊기면 _reconnect 루프에 들어가 프로세스는 살고 큐만 멈춘다.
    // stderr 꼬리를 읽을 뿐이라 주기가 짧아도 값싸다.
    expect(workerSpec(deps() as never).healthIntervalMs).toBeGreaterThan(0);
  });

  it("reports failed when the process died", async () => {
    const spec = workerSpec(deps() as never);
    const r = await spec.readiness({ handle: handle("boom", false), owned: true }, ctx());
    expect(r.kind).toBe("failed");
  });
});
