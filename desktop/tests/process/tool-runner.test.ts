import { describe, expect, it, vi } from "vitest";
import { describeToolFailure, runTool, toolOk } from "../../src/process/tool-runner";

const env = { PATH: "/usr/bin:/bin", LC_ALL: "C" };

describe("runTool", () => {
  it("collects exit code and both streams separately", async () => {
    const r = await runTool("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"], { env });
    expect(r).toMatchObject({ code: 3, stdout: "out\n", stderr: "err\n", timedOut: false, aborted: false });
    expect(toolOk(r)).toBe(false);
    expect(toolOk(await runTool("/usr/bin/true", [], { env }))).toBe(true);
  });

  it("ends a tool that outlives its deadline", async () => {
    const started = Date.now();
    const r = await runTool("/bin/sleep", ["5"], { env, deadlineMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(toolOk(r)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("ends a tool when the signal aborts — this is what lets ⌘Q through a hung initdb", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const r = await runTool("/bin/sleep", ["5"], { env, signal: ac.signal });
    expect(r.aborted).toBe(true);
  });

  it("does not spawn at all when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const spawnFn = vi.fn();
    const r = await runTool("/bin/sleep", ["5"], { env, signal: ac.signal, spawnFn: spawnFn as never });
    expect(r.aborted).toBe(true);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("escalates to SIGKILL for a tool that ignores SIGTERM", async () => {
    const started = Date.now();
    const r = await runTool("/bin/sh", ["-c", 'trap "" TERM; while :; do :; done'], { env, deadlineMs: 100, killGraceMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("reports a missing binary instead of throwing", async () => {
    const r = await runTool("/nowhere/initdb", [], { env });
    expect(r.spawnError).toMatch(/ENOENT/);
    expect(describeToolFailure("initdb", r)).toMatch(/^initdb: 실행하지 못했어요/);
  });

  it("describes a failure with its reason and the tail of stderr", async () => {
    const r = await runTool("/bin/sh", ["-c", "echo 'FATAL: boom' >&2; exit 1"], { env });
    expect(describeToolFailure("pg_dump", r)).toBe("pg_dump: 종료 코드 1\nFATAL: boom");
  });
});
