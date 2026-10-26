import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { startSystemAudio, SystemAudioStartError, systemAudioHelperPath } from "../../src/process/system-audio";
import type { SpawnFn } from "../../src/process/tool-runner";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "system-audio-test-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function fakeHelper(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

describe("startSystemAudio", () => {
  it("resolves on READY, streams stdout as PCM and ends when stop closes stdin", async () => {
    const bin = fakeHelper("ok", 'echo READY >&2; printf "\\001\\002\\003\\004"; cat >/dev/null; exit 0');
    const session = await startSystemAudio(bin);
    const chunks: Buffer[] = [];
    session.pcm.on("data", (b: Buffer) => chunks.push(b));
    const ended = new Promise<void>((r) => session.pcm.once("end", () => r()));
    session.stop();
    await ended;
    expect(await session.exited).toEqual({ code: 0, signal: null });
    expect([...Buffer.concat(chunks)]).toEqual([1, 2, 3, 4]);
  });

  it("rejects with the helper's stage and status when it reports ERROR before READY", async () => {
    const bin = fakeHelper("error", 'echo "ERROR create-tap -1" >&2; exit 1');
    await expect(startSystemAudio(bin)).rejects.toThrow(/create-tap -1/);
  });

  it("rejects when the helper exits before READY", async () => {
    const bin = fakeHelper("exit", "exit 3");
    await expect(startSystemAudio(bin)).rejects.toBeInstanceOf(SystemAudioStartError);
  });

  it("rejects instead of throwing when the binary is missing", async () => {
    await expect(startSystemAudio(path.join(dir, "nowhere"))).rejects.toThrow(/실행하지 못했어요|준비 전에 끝났어요/);
  });

  it("rejects only after a helper that never gets ready is gone, so no tap is left open", async () => {
    const bin = fakeHelper("hang", 'trap "" TERM; while :; do sleep 1; done');
    let child: ChildProcess | undefined;
    const spawnFn: SpawnFn = (cmd, args, options) => (child = spawn(cmd, args, options));
    await expect(startSystemAudio(bin, { spawnFn, readyTimeoutMs: 100, stopGraceMs: 100 })).rejects.toThrow(/시간 안에/);
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
  });

  it("escalates to signals for a helper that ignores stdin EOF", async () => {
    const bin = fakeHelper("stubborn", 'echo READY >&2; trap "" TERM; while :; do sleep 1; done');
    const session = await startSystemAudio(bin, { stopGraceMs: 100 });
    session.pcm.resume();
    session.stop();
    expect((await session.exited).signal).toBe("SIGKILL");
  });
});

describe("systemAudioHelperPath", () => {
  it("names the binary build-system-audio.sh stages", () => {
    const script = fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "build-system-audio.sh"), "utf8");
    expect(script).toContain('"$STAGED/damwha-system-audio"');
    expect(systemAudioHelperPath("/b")).toBe("/b/damwha-system-audio");
  });
});
