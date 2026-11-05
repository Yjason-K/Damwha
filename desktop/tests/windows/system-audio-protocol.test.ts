import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { describe, expect, it, vi } from "vitest";
import type { SystemAudioSession } from "../../src/process/system-audio";
import {
  createSystemAudioProtocol,
  stopOnRendererReset,
  SYSTEM_AUDIO_MAX_QUEUED_BYTES,
} from "../../src/windows/system-audio-protocol";

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

  it("ignores data and end that arrive after the renderer cancelled, and keeps draining the helper's stdout", async () => {
    const pcm = new PassThrough();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => undefined);
    // 헬퍼는 stop() 뒤에도 종료할 때까지 계속 쓴다 — 여기서는 pcm을 닫지 않는다.
    const stop = vi.fn();
    const session: SystemAudioSession = { pcm, exited, stop };
    const res = await protocolWith(async () => session).handle(get("/pcm"));
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);
    try {
      await res.body!.cancel();
      expect(stop).toHaveBeenCalledTimes(1);
      pcm.write(Buffer.from([1, 2, 3]));
      pcm.write(Buffer.from([4, 5, 6]));
      pcm.end();
      await new Promise((r) => setTimeout(r, 20));
      expect(uncaught).not.toHaveBeenCalled();
      // 읽는 쪽이 없으면 파이프가 차서 헬퍼가 멈춘다 — 버려지더라도 흘러야 한다.
      expect(pcm.readableLength).toBe(0);
      expect(pcm.readableEnded).toBe(true);
    } finally {
      process.off("uncaughtException", uncaught);
    }
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

  describe("소비가 멈추면 큐가 상한에서 멈춘다 (#85)", () => {
    const KIB = new Uint8Array(1024);
    function writeKib(pcm: PassThrough, n: number) {
      for (let i = 0; i < n; i += 1) pcm.write(KIB);
    }

    it("lets a slow reader catch up as long as the queue stays under the cap", async () => {
      const s = fakeSession();
      const res = await protocolWith(async () => s.session).handle(get("/pcm"));
      const reader = res.body!.getReader();
      const half = SYSTEM_AUDIO_MAX_QUEUED_BYTES / 1024 / 2;
      let got = 0;
      for (let round = 0; round < 4; round += 1) {
        writeKib(s.pcm, half); // 상한의 절반씩 쌓였다가
        await vi.waitFor(() => expect(s.pcm.readableLength).toBe(0));
        while (got < (round + 1) * half * 1024) got += (await reader.read()).value!.length; // 따라잡는다
      }
      expect(got).toBe(4 * half * 1024);
      expect(s.stop).not.toHaveBeenCalled();
      await reader.cancel();
    });

    it("fails the body and stops the helper instead of queueing past the cap when the reader stalls", async () => {
      const pcm = new PassThrough();
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => undefined);
      // 헬퍼는 stop() 뒤에도 종료할 때까지 쓴다 — 여기서는 pcm을 닫지 않는다.
      const stop = vi.fn();
      const session: SystemAudioSession = { pcm, exited, stop };
      const log: string[] = [];
      const p = createSystemAudioProtocol({
        allowedOrigins: () => [ORIGIN],
        start: async () => session,
        log: (l) => void log.push(l),
      });
      const res = await p.handle(get("/pcm"));
      const reader = res.body!.getReader();

      writeKib(pcm, SYSTEM_AUDIO_MAX_QUEUED_BYTES / 1024); // 상한까지는 받는다
      await vi.waitFor(() => expect(pcm.readableLength).toBe(0));
      expect(stop).not.toHaveBeenCalled();

      writeKib(pcm, 1); // 넘치는 첫 조각
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
      await expect(reader.read()).rejects.toThrow();
      expect(log.some((l) => l.includes("상한"))).toBe(true);

      // 헬퍼가 쓰기에서 막히지 않게 계속 흘려 버린다 — 종료가 막히지 않는다.
      writeKib(pcm, 64);
      pcm.end();
      await vi.waitFor(() => expect(pcm.readableEnded).toBe(true));
      expect(pcm.readableLength).toBe(0);
      expect(stop).toHaveBeenCalledTimes(1);
      p.stopAll(); // 앱 종료도 그대로 끝난다
    });
  });

  it("stopAll also stops a helper that was still starting — its request has no renderer left to cancel it", async () => {
    const s = fakeSession();
    let resolveStart!: (v: SystemAudioSession) => void;
    const p = protocolWith(() => new Promise((r) => (resolveStart = r)));
    const pending = p.handle(get("/pcm"));
    p.stopAll();
    resolveStart(s.session);
    expect((await pending).status).toBe(503);
    expect(s.stop).toHaveBeenCalledTimes(1);
  });
});

describe("stopOnRendererReset", () => {
  // 요청이 끊겨도 Electron이 응답 본문을 cancel한다는 보장이 없다 — 렌더러 쪽 사건으로 직접 끈다.
  function wired() {
    const contents = new EventEmitter();
    const stop = vi.fn();
    stopOnRendererReset(contents, stop);
    return { contents, stop };
  }

  it("stops on a main-frame document change (reload, shell screen)", () => {
    const { contents, stop } = wired();
    contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("keeps recording across in-app routes and subframe loads", () => {
    const { contents, stop } = wired();
    contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    contents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    expect(stop).not.toHaveBeenCalled();
  });

  it("stops when the renderer dies or the window's contents are destroyed", () => {
    const { contents, stop } = wired();
    contents.emit("render-process-gone");
    contents.emit("destroyed");
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
