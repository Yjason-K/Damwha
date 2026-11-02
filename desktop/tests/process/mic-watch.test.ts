import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PassThrough } from "stream";
import { afterAll, describe, expect, it } from "vitest";
import { micWatchHelperPath, parseMicWatchLine, startMicWatch, type MicWatchEvent } from "../../src/process/mic-watch";
import type { SpawnFn } from "../../src/process/tool-runner";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mic-watch-test-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function fakeHelper(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

/** stdout·stdin을 손으로 흘릴 수 있는 가짜 자식. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stdin: PassThrough; kill: () => boolean };
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  const spawnFn = (() => child) as unknown as SpawnFn;
  return { child, spawnFn };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("parseMicWatchLine", () => {
  it("parses a snapshot", () =>
    expect(parseMicWatchLine('{"input":["us.zoom.xos"]}')).toEqual({ kind: "snapshot", input: ["us.zoom.xos"] }));
  it("an empty snapshot is a snapshot", () =>
    expect(parseMicWatchLine('{"input":[]}')).toEqual({ kind: "snapshot", input: [] }));
  it("an error line is not an empty list", () =>
    expect(parseMicWatchLine('{"error":"list -1"}')).toEqual({ kind: "error", detail: "list -1" }));
  it("garbage is ignored", () => expect(parseMicWatchLine("not json")).toBeNull());
  it("a wrongly shaped object is ignored", () => expect(parseMicWatchLine('{"input":[1]}')).toBeNull());
});

describe("startMicWatch", () => {
  it("joins a line split across stdout chunks into one event", async () => {
    const { child, spawnFn } = fakeChild();
    const events: MicWatchEvent[] = [];
    startMicWatch("x", (e) => events.push(e), { spawnFn });
    child.stdout.write('{"input":["us.zo');
    await tick();
    expect(events).toEqual([]);
    child.stdout.write('om.xos"]}\n{"input":[]}\n');
    await tick();
    expect(events).toEqual([
      { kind: "snapshot", input: ["us.zoom.xos"] },
      { kind: "snapshot", input: [] },
    ]);
  });

  it("reports exit once on close and after a spawn error", async () => {
    const { child, spawnFn } = fakeChild();
    const events: MicWatchEvent[] = [];
    startMicWatch("x", (e) => events.push(e), { spawnFn });
    child.emit("error", new Error("ENOENT"));
    child.emit("close", 1, null);
    await tick();
    expect(events).toEqual([{ kind: "exit" }]);
  });

  it("survives a stdin EPIPE after the helper died", () => {
    const { child, spawnFn } = fakeChild();
    startMicWatch("x", () => {}, { spawnFn });
    expect(() => child.stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
  });

  it("delivers snapshots from a real process and then exit", async () => {
    const bin = fakeHelper("real", 'echo \'{"input":["a"]}\'; exit 1');
    const events: MicWatchEvent[] = [];
    const done = new Promise<void>((r) => startMicWatch(bin, (e) => (events.push(e), e.kind === "exit" && r())));
    await done;
    expect(events).toEqual([{ kind: "snapshot", input: ["a"] }, { kind: "exit" }]);
  });

  it("stop closes stdin, then escalates to SIGTERM", async () => {
    const bin = fakeHelper("stubborn", 'trap "" TERM; echo \'{"input":[]}\'; while :; do sleep 1; done');
    let child: ChildProcess | undefined;
    const spawnFn: SpawnFn = (cmd, args, options) => (child = spawn(cmd, args, options));
    const exited = new Promise<void>((r) => {
      // trap을 건 뒤에야 스냅숏 한 줄을 찍는다 — 그 줄을 받은 다음에 stop해야 SIGTERM이 무시되는 게 보장된다.
      const w: { stop(): void } = startMicWatch(
        bin,
        (e) => {
          if (e.kind === "snapshot") {
            w.stop();
            w.stop();
          }
          if (e.kind === "exit") r();
        },
        { spawnFn, stopGraceMs: 100 },
      );
    });
    await exited;
    expect(child?.signalCode).toBe("SIGKILL");
  });

  it("stop ends a helper that exits on stdin EOF without signals", async () => {
    const bin = fakeHelper("polite", "cat >/dev/null; exit 0");
    let child: ChildProcess | undefined;
    const spawnFn: SpawnFn = (cmd, args, options) => (child = spawn(cmd, args, options));
    const exited = new Promise<void>((r) => {
      const w = startMicWatch(bin, (e) => e.kind === "exit" && r(), { spawnFn, stopGraceMs: 1000 });
      w.stop();
    });
    await exited;
    expect(child?.exitCode).toBe(0);
  });
});

describe("micWatchHelperPath", () => {
  it("names the binary build-system-audio.sh stages", () => {
    const script = fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "build-system-audio.sh"), "utf8");
    expect(script).toContain('"$STAGED/damwha-mic-watch"');
    expect(micWatchHelperPath("/b")).toBe("/b/damwha-mic-watch");
  });
});
