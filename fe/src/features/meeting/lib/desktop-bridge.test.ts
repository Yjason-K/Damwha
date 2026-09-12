import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDesktopBridge } from "./desktop-bridge";

const live = vi.hoisted(() => ({
  hasLiveCapture: vi.fn(() => false),
  stopActiveLiveCapture: vi.fn(async () => undefined),
}));

vi.mock("./live-session", () => live);

type Bridge = {
  isRecording(): boolean;
  stopLiveRecording(): Promise<{ stopped: boolean; reason?: string }>;
};

function install(): Bridge {
  const w = {} as Window & { __damwha_desktop?: Bridge };
  installDesktopBridge(w);
  return w.__damwha_desktop!;
}

beforeEach(() => {
  live.hasLiveCapture.mockReset().mockReturnValue(false);
  live.stopActiveLiveCapture.mockReset().mockResolvedValue(undefined);
});

describe("installDesktopBridge", () => {
  it("exposes the two calls the desktop app needs", () => {
    const bridge = install();
    expect(typeof bridge.isRecording).toBe("function");
    expect(typeof bridge.stopLiveRecording).toBe("function");
  });

  it("reports recording from the live-session registry", () => {
    live.hasLiveCapture.mockReturnValue(true);
    expect(install().isRecording()).toBe(true);
  });

  it("stops through the same path the on-screen button uses", async () => {
    live.hasLiveCapture.mockReturnValue(true);
    const r = await install().stopLiveRecording();
    expect(live.stopActiveLiveCapture).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ stopped: true });
  });

  it("is a no-op when nothing is recording", async () => {
    const r = await install().stopLiveRecording();
    expect(live.stopActiveLiveCapture).not.toHaveBeenCalled();
    expect(r).toEqual({ stopped: true, reason: "no-recording" });
  });

  it("reports a stop failure instead of throwing", async () => {
    // main은 이 값을 보고 "그래도 종료할지"를 정한다. 여기서 던지면 executeJavaScript가
    // 거부로 끝나 main이 이유를 못 읽는다.
    live.hasLiveCapture.mockReturnValue(true);
    live.stopActiveLiveCapture.mockRejectedValue(new Error("업로드 실패"));
    const r = await install().stopLiveRecording();
    expect(r.stopped).toBe(false);
    expect(r.reason).toContain("업로드 실패");
  });

  it("does not replace an already-installed bridge", () => {
    const w = {} as Window & { __damwha_desktop?: Bridge };
    installDesktopBridge(w);
    const first = w.__damwha_desktop;
    installDesktopBridge(w);
    expect(w.__damwha_desktop).toBe(first);
  });
});
