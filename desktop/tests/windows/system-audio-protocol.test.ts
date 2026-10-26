import { PassThrough } from "stream";
import { describe, expect, it, vi } from "vitest";
import type { SystemAudioSession } from "../../src/process/system-audio";
import { createSystemAudioProtocol } from "../../src/windows/system-audio-protocol";

const ORIGIN = "http://127.0.0.1:3000";

function fakeSession() {
  const pcm = new PassThrough();
  let exit!: (v: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => (exit = r));
  const stop = vi.fn(() => {
    pcm.end();
    exit({ code: 0, signal: null });
  });
  const session: SystemAudioSession = { pcm, exited, stop };
  return { session, pcm, stop, exit };
}

function protocolWith(start: () => Promise<SystemAudioSession>) {
  return createSystemAudioProtocol({ allowedOrigins: () => [ORIGIN], start, log: () => undefined });
}

const get = (path: string, origin: string | null = ORIGIN) =>
  new Request(`damwha-audio://system${path}`, { headers: origin === null ? {} : { origin } });

describe("system audio protocol", () => {
  it("refuses a page that is not Damwha's own origin, before starting anything", async () => {
    const start = vi.fn();
    const p = protocolWith(start);
    expect((await p.handle(get("/pcm", "http://evil.example"))).status).toBe(403);
    expect((await p.handle(get("/pcm", null))).status).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });

  it("accepts the page's referrer when the renderer sends no Origin header, as Electron 44 does", async () => {
    const p = protocolWith(vi.fn());
    const fromApp = new Request("damwha-audio://system/status", { referrer: `${ORIGIN}/meetings` });
    expect((await p.handle(fromApp)).status).toBe(200);
    const fromElsewhere = new Request("damwha-audio://system/status", { referrer: "http://evil.example/x" });
    expect((await p.handle(fromElsewhere)).status).toBe(403);
  });

  it("answers status so the renderer can tell it runs inside the desktop app", async () => {
    const res = await protocolWith(vi.fn()).handle(get("/status"));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(await res.json()).toEqual({ available: true, busy: false });
  });

  it("streams the helper's PCM as the response body", async () => {
    const s = fakeSession();
    const res = await protocolWith(async () => s.session).handle(get("/pcm"));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    s.pcm.write(Buffer.from([1, 2, 3]));
    expect([...(await reader.read()).value!]).toEqual([1, 2, 3]);
    s.pcm.end();
    expect((await reader.read()).done).toBe(true);
  });

  it("stops the helper when the renderer cancels the body — reload and window close end the tap", async () => {
    const s = fakeSession();
    const res = await protocolWith(async () => s.session).handle(get("/pcm"));
    await res.body!.cancel();
    expect(s.stop).toHaveBeenCalledTimes(1);
  });

  it("runs one helper at a time and frees the slot once it exits", async () => {
    const first = fakeSession();
    const second = fakeSession();
    const start = vi.fn().mockResolvedValueOnce(first.session).mockResolvedValueOnce(second.session);
    const p = protocolWith(start);
    expect((await p.handle(get("/pcm"))).status).toBe(200);
    expect((await p.handle(get("/pcm"))).status).toBe(409);
    first.exit({ code: 0, signal: null });
    await first.session.exited;
    expect((await p.handle(get("/pcm"))).status).toBe(200);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("reports a helper that failed to start as 503 with the reason", async () => {
    const p = protocolWith(() => Promise.reject(new Error("ERROR create-tap -1")));
    const res = await p.handle(get("/pcm"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "start_failed", detail: "ERROR create-tap -1" });
    expect((await p.handle(get("/status"))).status).toBe(200);
  });

  it("stopAll ends the running helper for app quit", async () => {
    const s = fakeSession();
    const p = protocolWith(async () => s.session);
    await p.handle(get("/pcm"));
    p.stopAll();
    expect(s.stop).toHaveBeenCalledTimes(1);
  });
});
