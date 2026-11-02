import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDesktopBridge } from "./desktop-bridge";

const live = vi.hoisted(() => ({
  hasLiveCapture: vi.fn(() => false),
  stopActiveLiveCapture: vi.fn(async () => undefined),
  finishLiveCapture: vi.fn(async () => undefined),
  isLiveStarting: vi.fn(() => false),
  awaitLiveStart: vi.fn(async (): Promise<void> => undefined),
  getLiveRecorder: vi.fn<(id: string) => unknown>(() => undefined),
  liveSessionSnapshot: vi.fn(() => ({ phase: "idle" })),
}));
const start = vi.hoisted(() => ({ startLiveRecording: vi.fn() }));
const api = vi.hoisted(() => ({ postLiveStart: vi.fn() }));

// LiveCaptureBusy 같은 실제 클래스는 살리고 함수만 갈아 끼운다.
vi.mock("./live-session", async (orig) => ({
  ...(await orig<typeof import("./live-session")>()),
  ...live,
}));
vi.mock("./start-live", () => start);
vi.mock("../api/live", async (orig) => ({
  ...(await orig<typeof import("../api/live")>()),
  ...api,
}));

type StartResult = { started: boolean; meetingId?: string; reason?: string };
type Bridge = {
  isRecording(): boolean;
  stopLiveRecording(): Promise<{ stopped: boolean; reason?: string }>;
  startDetectedRecording(): Promise<StartResult>;
  cancelDetectedRecording(): Promise<void>;
  recordingStatus(): unknown;
  finishRecording(): Promise<void>;
  openMeeting(id: string): void;
};

function install(): Bridge {
  const w = {} as Window & { __damwha_desktop?: Bridge };
  installDesktopBridge(w);
  return w.__damwha_desktop!;
}

beforeEach(() => {
  live.hasLiveCapture.mockReset().mockReturnValue(false);
  live.stopActiveLiveCapture.mockReset().mockResolvedValue(undefined);
  live.finishLiveCapture.mockReset().mockResolvedValue(undefined);
  live.isLiveStarting.mockReset().mockReturnValue(false);
  live.awaitLiveStart.mockReset().mockResolvedValue(undefined);
  live.getLiveRecorder.mockReset().mockReturnValue(undefined);
  start.startLiveRecording.mockReset();
  api.postLiveStart.mockReset().mockResolvedValue({ id: "m1" });
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

  it("has no hfToken field", () => {
    const w = {} as Window & { __damwha_desktop?: Bridge };
    installDesktopBridge(w);
    expect("hfToken" in w.__damwha_desktop!).toBe(false);
  });

  it("uiLanguage 브리지를 건다 — main이 이 이름으로 부른다", () => {
    const w = {} as Window;
    installDesktopBridge(w);
    expect(typeof w.__damwha_desktop?.uiLanguage.next).toBe("function");
    expect(typeof w.__damwha_desktop?.uiLanguage.show).toBe("function");
  });
});

/**
 * connect 전후를 가르려면 모듈 상태(deps)가 새로여야 해서 매번 모듈을 다시 올린다.
 * vi.mock은 resetModules 뒤에도 그대로 적용된다.
 */
async function load(connect = true) {
  vi.resetModules();
  const bridgeMod = await import("./desktop-bridge");
  const navigate = vi.fn();
  const invalidateMeetings = vi.fn();
  if (connect) bridgeMod.connectDesktopBridge({ navigate, invalidateMeetings });
  const w = {} as Window;
  bridgeMod.installDesktopBridge(w);
  const bridge = w.__damwha_desktop as unknown as Bridge;
  // resetModules 뒤의 클래스는 정적 import의 것과 다른 정체다 — 같은 모듈 그래프에서 다시 꺼낸다.
  const session = await import("./live-session");
  const recorder = await import("./live-recorder");
  const audio = await import("./system-audio");
  return { bridge, navigate, invalidateMeetings, session, recorder, audio };
}

describe("감지 녹음 다리", () => {
  it("connect 전이면 startDetectedRecording은 not_ready다", async () => {
    const { bridge } = await load(false);
    expect(await bridge.startDetectedRecording()).toEqual({
      started: false,
      reason: "not_ready",
    });
    expect(start.startLiveRecording).not.toHaveBeenCalled();
  });

  it("시스템 오디오를 항상 열고 defer를 보내지 않는다", async () => {
    const { bridge, invalidateMeetings, audio } = await load();
    start.startLiveRecording.mockImplementation(async (args) => {
      const meeting = await args.createMeeting();
      return meeting.id;
    });
    const r = await bridge.startDetectedRecording();
    expect(r).toEqual({ started: true, meetingId: "m1" });
    const args = start.startLiveRecording.mock.calls[0][0];
    expect(args.openSystemAudio).toBe(audio.openDesktopSystemAudio);
    expect(api.postLiveStart).toHaveBeenCalledTimes(1);
    const body = api.postLiveStart.mock.calls[0][0];
    expect(Object.keys(body)).toEqual(["title"]);
    expect(body.title).toMatch(/^녹음 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(invalidateMeetings).toHaveBeenCalled();
  });

  it("이미 녹음이 있으면 busy다", async () => {
    const { bridge, session } = await load();
    start.startLiveRecording.mockRejectedValue(new session.LiveCaptureBusy());
    expect(await bridge.startDetectedRecording()).toEqual({
      started: false,
      reason: "busy",
    });
  });

  it("system_audio·permission 실패를 reason으로 돌려주고 던지지 않는다", async () => {
    const { bridge, audio } = await load();
    start.startLiveRecording.mockRejectedValueOnce(
      new audio.SystemAudioUnavailable("x"),
    );
    expect(await bridge.startDetectedRecording()).toEqual({
      started: false,
      reason: "system_audio",
    });
    start.startLiveRecording.mockRejectedValueOnce(
      new DOMException("denied", "NotAllowedError"),
    );
    expect(await bridge.startDetectedRecording()).toEqual({
      started: false,
      reason: "permission",
    });
  });

  it("회의 생성 실패는 create_failed다", async () => {
    const { bridge } = await load();
    api.postLiveStart.mockRejectedValue(new Error("500"));
    start.startLiveRecording.mockImplementation(
      async (args) => (await args.createMeeting()).id,
    );
    expect(await bridge.startDetectedRecording()).toEqual({
      started: false,
      reason: "create_failed",
    });
  });

  it("시작 중에는 isRecording이 참이다", async () => {
    const { bridge } = await load();
    live.isLiveStarting.mockReturnValue(true);
    expect(bridge.isRecording()).toBe(true);
  });

  it("stopLiveRecording은 시작이 끝나기를 기다린 뒤 멈춘다", async () => {
    const { bridge } = await load();
    let finish!: () => void;
    live.isLiveStarting.mockReturnValue(true);
    live.awaitLiveStart.mockReturnValue(
      new Promise<void>((r) => {
        finish = () => {
          live.hasLiveCapture.mockReturnValue(true);
          live.isLiveStarting.mockReturnValue(false);
          r();
        };
      }),
    );
    const stopping = bridge.stopLiveRecording();
    await Promise.resolve();
    expect(live.stopActiveLiveCapture).not.toHaveBeenCalled();
    finish();
    expect(await stopping).toEqual({ stopped: true });
    expect(live.stopActiveLiveCapture).toHaveBeenCalledTimes(1);
  });

  it("시작 중이면 cancelDetectedRecording이 signal로 무른다", async () => {
    const { bridge, recorder } = await load();
    start.startLiveRecording.mockImplementation(
      (args: { signal: AbortSignal }) =>
        new Promise((_, reject) =>
          args.signal.addEventListener("abort", () =>
            reject(new recorder.LiveCaptureCancelled()),
          ),
        ),
    );
    const starting = bridge.startDetectedRecording();
    await bridge.cancelDetectedRecording();
    expect(await starting).toEqual({ started: false, reason: "cancelled" });
    expect(live.stopActiveLiveCapture).not.toHaveBeenCalled();
  });

  it("이미 시작됐으면 cancelDetectedRecording은 그 녹음을 멈춘다", async () => {
    const { bridge } = await load();
    start.startLiveRecording.mockResolvedValue("m9");
    await bridge.startDetectedRecording();
    live.getLiveRecorder.mockImplementation((id: string) =>
      id === "m9" ? {} : undefined,
    );
    await bridge.cancelDetectedRecording();
    expect(live.stopActiveLiveCapture).toHaveBeenCalledTimes(1);
  });

  it("cancelDetectedRecording은 모달로 시작한 녹음을 멈추지 않는다", async () => {
    const { bridge } = await load();
    live.hasLiveCapture.mockReturnValue(true);
    live.getLiveRecorder.mockReturnValue({});
    await bridge.cancelDetectedRecording();
    expect(live.stopActiveLiveCapture).not.toHaveBeenCalled();
  });

  it("recordingStatus는 세션 스냅숏을 그대로 돌려준다", async () => {
    const { bridge } = await load();
    live.liveSessionSnapshot.mockReturnValue({ phase: "starting" });
    expect(bridge.recordingStatus()).toEqual({ phase: "starting" });
  });

  it("finishRecording은 서버 마감을 부르고 실패해도 던지지 않는다", async () => {
    const { bridge } = await load();
    live.finishLiveCapture.mockRejectedValue(new Error("boom"));
    await expect(bridge.finishRecording()).resolves.toBeUndefined();
    expect(live.finishLiveCapture).toHaveBeenCalledTimes(1);
  });

  it("openMeeting은 /meetings/:id로 이동한다", async () => {
    const { bridge, navigate } = await load();
    bridge.openMeeting("m7");
    expect(navigate).toHaveBeenCalledWith("/meetings/m7");
  });
});
