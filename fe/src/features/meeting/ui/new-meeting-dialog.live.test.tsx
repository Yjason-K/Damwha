import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";

import { ApiError, apiClient } from "@/shared/api/client";
import { Toaster } from "@/shared/ui/toaster";
import {
  cancelLivePreparation,
  clearLiveCapture,
  getLiveRecorder,
} from "../lib/live-session";
import { SR } from "../lib/pcm-convert";
import type { WorkletCommand, WorkletEvent } from "../lib/pcm-worklet-protocol";
import { NewMeetingDialog } from "./new-meeting-dialog";
import { defaultLiveTitle } from "../lib/default-live-title";

afterEach(async () => {
  clearLiveCapture("m7");
  // 준비만 하고 회의에 붙지 않은 캡처가 남으면 다음 테스트의 소유자를 밀어낸다.
  await cancelLivePreparation();
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
  Reflect.deleteProperty(navigator, "permissions");
});

const WIRE = {
  id: "m7",
  title: "녹음",
  original_filename: null,
  audio_key: "meetings/m7/original.wav",
  normalized_key: null,
  recorded_at: "2026-09-05T10:00:00.000Z",
  duration_ms: null,
  status: "recording",
  is_favorite: false,
  current_job_id: "job_1",
  processing_version: 0,
  error: null,
  created_at: "2026-09-05T10:00:00.000Z",
};

/** 즉시 settle하지 않는 Promise — 아직 답하지 않은 권한 프롬프트를 흉내낸다. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type CaptureStubOptions = {
  permission?: "granted" | "denied";
  devices?: Array<{ deviceId: string; label: string }>;
  /** 권한 프롬프트를 테스트가 직접 settle한다. 없으면 즉시 스트림을 준다. */
  micPrompt?: Promise<MediaStream>;
  /** getUserMedia 자체가 거부되는 경우(사용자가 프롬프트에서 거부). */
  micRejects?: unknown;
  addModuleRejects?: unknown;
  /** Worklet이 첫 유효 입력에서 ready를 보내는가 (설계 §6.3). */
  ready?: boolean;
  /** Worklet이 begin에 begun으로 답하는가 (설계 §7). */
  begun?: boolean;
};

/**
 * 다이얼로그가 회의를 만들기 **전에** 태우는 브라우저 준비 경로 전체를 흉내낸다 —
 * jsdom엔 mediaDevices도 AudioContext도 AudioWorkletNode도 없다. 이 파일이 보는 것은
 * 오디오가 아니라 **순서**다: 어떤 준비 실패가 /meetings/live를 못 가게 막는가,
 * 그리고 열린 트랙이 남는가.
 */
function stubCapture(options: CaptureStubOptions = {}) {
  const devices = (
    options.devices ?? [{ deviceId: "default", label: "내장 마이크" }]
  ).map((d) => ({ kind: "audioinput" as const, ...d }));

  const stopTrack = vi.fn();
  const stream = {
    getTracks: () => [{ stop: stopTrack }],
    getAudioTracks: () => [{ addEventListener: vi.fn() }],
  } as unknown as MediaStream;

  const getUserMedia = vi.fn(() => {
    if (options.micRejects !== undefined)
      return Promise.reject(options.micRejects);
    return options.micPrompt ?? Promise.resolve(stream);
  });

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi.fn().mockResolvedValue(devices),
    },
  });
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: {
      query: vi
        .fn()
        .mockResolvedValue({ state: options.permission ?? "granted" }),
    },
  });

  const posted: WorkletCommand[] = [];
  const port = {
    onmessage: null as ((e: MessageEvent<WorkletEvent>) => void) | null,
    postMessage(message: WorkletCommand) {
      posted.push(message);
      if (message.type === "begin" && options.begun !== false)
        emit({ type: "begun" });
      if (message.type === "flush") emit({ type: "flushed" });
    },
  };
  const emit = (event: WorkletEvent) =>
    port.onmessage?.({ data: event } as MessageEvent<WorkletEvent>);

  const close = vi.fn().mockResolvedValue(undefined);
  class FakeAudioContext {
    sampleRate = SR;
    destination = {};
    audioWorklet = {
      addModule: vi.fn(() =>
        options.addModuleRejects !== undefined
          ? Promise.reject(options.addModuleRejects)
          : Promise.resolve(undefined),
      ),
    };
    createMediaStreamSource = vi.fn().mockReturnValue({ connect: vi.fn() });
    createGain = vi
      .fn()
      .mockReturnValue({ gain: { value: 1 }, connect: vi.fn() });
    close = close;
    // 실제 브라우저에서 오디오가 흐르기 시작하는 지점 — Worklet의 ready는 그 뒤에 온다.
    resume = vi.fn(async () => {
      if (options.ready !== false) emit({ type: "ready" });
    });
  }
  class FakeAudioWorkletNode {
    port = port;
    connect = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);

  return { stopTrack, close, stream, posted, getUserMedia };
}

function renderDialog(onStarted = vi.fn()) {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      preset: "standard",
      preset_revision: null,
      language: "ko",
      whisper_model: "large-v3-turbo",
      devices: { diarization: "gpu", stt: "gpu" },
    },
  } as never);
  const post = vi
    .spyOn(apiClient, "post")
    .mockResolvedValue({ status: 201, data: WIRE } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Toaster />
      <NewMeetingDialog open onOpenChange={() => {}} onCreated={onStarted} />
    </QueryClientProvider>,
  );
  fireEvent.mouseDown(screen.getByRole("tab", { name: "실시간 녹음" }), {
    button: 0,
    ctrlKey: false,
  });
  return { post, onStarted };
}

const startCalls = (post: { mock: { calls: unknown[][] } }) =>
  post.mock.calls.filter((c) => c[0] === "/meetings/live");
const stopCalls = (post: { mock: { calls: unknown[][] } }) =>
  post.mock.calls.filter((c) => c[0] === "/meetings/m7/live/stop");

const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));

/** 게이트(1번째 클릭)를 통과시켜 장치 목록을 띄운다. 실제 시작은 2번째 클릭이다. */
async function passGate() {
  click("녹음 시작");
  await screen.findByLabelText("마이크");
}

test("기본 제목은 '녹음 YYYY-MM-DD HH:mm'이다", () => {
  expect(defaultLiveTitle(new Date(2026, 8, 5, 14, 7))).toBe(
    "녹음 2026-09-05 14:07",
  );
});

// 설계 §5.2 — 원 설계에서 회의 중간에 audio_device_failed로 터지던 실패를 전부 시작
// 전으로 옮긴다. insecure context에서는 navigator.mediaDevices 자체가 없다 —
// jsdom의 기본 상태가 정확히 그 상태라 아무것도 stub하지 않는다.
test("insecure context에서는 녹음을 막고 회의를 만들지 않는다", async () => {
  const { post } = renderDialog();
  click("녹음 시작");
  expect(await screen.findByText(/HTTPS/)).toBeInTheDocument();
  expect(startCalls(post)).toHaveLength(0);
});

test("마이크 권한이 거부됐으면 녹음을 막는다", async () => {
  stubCapture({ permission: "denied" });
  const { post } = renderDialog();
  click("녹음 시작");
  expect(await screen.findByText(/마이크 권한/)).toBeInTheDocument();
  expect(startCalls(post)).toHaveLength(0);
});

test("입력 장치가 없으면 녹음을 막는다", async () => {
  stubCapture({ devices: [] });
  renderDialog();
  click("녹음 시작");
  expect(
    await screen.findByText("입력 장치를 찾지 못했어요."),
  ).toBeInTheDocument();
});

test("게이트를 통과하면 enumerateDevices가 돌려준 입력 장치를 보여준다", async () => {
  stubCapture({ devices: [{ deviceId: "a", label: "내장 마이크" }] });
  renderDialog();
  click("녹음 시작");
  expect(await screen.findByText("내장 마이크")).toBeInTheDocument();
});

/**
 * 설계 §6 — 준비가 끝난 뒤에만 `/meetings/live`를 보낸다. 아래 네 개는 "준비 실패"의
 * 네 모양이고, 전부 같은 두 가지를 요구한다: 회의를 만들지 않았을 것, 그리고 열린
 * 트랙을 남기지 않았을 것. 순서가 뒤집혀 있던 옛 코드에서는 전부 빈 회의가 남았다.
 */
test("권한 프롬프트에서 거부하면 회의를 만들지 않는다", async () => {
  const mic = stubCapture({
    micRejects: new DOMException("denied", "NotAllowedError"),
  });
  const { post, onStarted } = renderDialog();
  await passGate();
  click("녹음 시작");

  expect(await screen.findByText("마이크를 열지 못했어요")).toBeInTheDocument();
  expect(startCalls(post)).toHaveLength(0);
  expect(onStarted).not.toHaveBeenCalled();
  expect(screen.queryByText("발화가 실시간으로 표시돼요.")).toBeNull();
  // 스트림을 얻지도 못했으니 정리할 트랙도 없다.
  expect(mic.stopTrack).not.toHaveBeenCalled();
});

test("마이크는 얻었지만 Worklet 로딩이 실패하면 트랙을 닫고 회의를 만들지 않는다", async () => {
  const mic = stubCapture({
    addModuleRejects: new Error("worklet load failed"),
  });
  const { post, onStarted } = renderDialog();
  await passGate();
  click("녹음 시작");

  await waitFor(() => expect(mic.stopTrack).toHaveBeenCalledTimes(1));
  expect(startCalls(post)).toHaveLength(0);
  expect(onStarted).not.toHaveBeenCalled();
});

test("ready ACK가 5초 안에 오지 않으면 마이크·컨텍스트를 닫고 회의를 만들지 않는다", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const mic = stubCapture({ ready: false });
  const { post, onStarted } = renderDialog();
  await passGate();
  click("녹음 시작");

  await vi.advanceTimersByTimeAsync(5000);
  await waitFor(() => expect(mic.stopTrack).toHaveBeenCalledTimes(1));
  expect(mic.close).toHaveBeenCalledTimes(1);
  expect(startCalls(post)).toHaveLength(0);
  expect(onStarted).not.toHaveBeenCalled();
});

test("ready ACK 뒤에야 회의를 만들고, begun ACK 뒤에 상세로 이동한다", async () => {
  const mic = stubCapture();
  const { post, onStarted } = renderDialog();
  const title = screen.getByLabelText("제목 (선택)") as HTMLInputElement;
  fireEvent.change(title, { target: { value: "주간 회의" } });
  fireEvent.click(screen.getByRole("radio", { name: "요약 나중에 실행" }));
  await passGate();
  expect(startCalls(post)).toHaveLength(0);

  click("녹음 시작");
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith("m7"));

  expect(post).toHaveBeenCalledWith("/meetings/live", {
    title: "주간 회의",
    defer_summary: true,
  });
  // 준비(마이크·Worklet)가 회의 생성보다 먼저다 — 이 순서가 이 태스크의 핵심이다.
  expect(mic.getUserMedia).toHaveBeenCalled();
  expect(mic.posted).toContainEqual({ type: "begin" });
  // 성공하면 브라우저 레코더를 이 회의 id로 등록한다 — 종료가 이 인스턴스를 찾아야 한다.
  expect(getLiveRecorder("m7")).toBeDefined();
  expect(mic.stopTrack).not.toHaveBeenCalled();
});

test("생성 요청이 409면 준비한 캡처를 정리하고 begin을 보내지 않는다", async () => {
  const mic = stubCapture();
  const { onStarted } = renderDialog();
  await passGate();
  vi.spyOn(apiClient, "post").mockRejectedValue(
    new ApiError(409, "a recording is already in progress"),
  );
  click("녹음 시작");

  expect(await screen.findByText("이미 녹음 중이에요")).toBeInTheDocument();
  // dispose — 준비한 마이크를 반드시 닫는다. 여기서 새지 않는 것이 순서를 뒤집은 이유다.
  await waitFor(() => expect(mic.stopTrack).toHaveBeenCalledTimes(1));
  expect(mic.posted).not.toContainEqual({ type: "begin" });
  expect(onStarted).not.toHaveBeenCalled();
  // 레코더 자원만 놓고 live-session의 예약(active)을 그대로 두면 죽은 캡처가 남는다 —
  // 짝이 맞는 호출은 dispose가 아니라 cancelLivePreparation이다.
  expect(getLiveRecorder("m7")).toBeUndefined();
});

test("생성 요청이 409로 실패한 뒤에도 같은 다이얼로그에서 다시 시작할 수 있다", async () => {
  const mic = stubCapture();
  const { onStarted } = renderDialog();
  await passGate();
  const conflict = vi
    .spyOn(apiClient, "post")
    .mockRejectedValue(new ApiError(409, "a recording is already in progress"));
  click("녹음 시작");
  await screen.findByText("이미 녹음 중이에요");

  // 진행 중인 녹음을 종료한 뒤의 재시도 — 준비부터 다시 돈다.
  conflict.mockResolvedValue({ status: 201, data: WIRE } as never);
  click("녹음 시작");
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith("m7"));
  expect(mic.getUserMedia).toHaveBeenCalledTimes(2);
  expect(getLiveRecorder("m7")).toBeDefined();
});

test("201 뒤 begin이 실패하면 0바이트 stop으로 그 회의를 정리하고 성공을 알리지 않는다", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const mic = stubCapture({ begun: false });
  const { post, onStarted } = renderDialog();
  await passGate();
  click("녹음 시작");

  // begun ACK 5초 초과 (설계 §6.6).
  await vi.advanceTimersByTimeAsync(5000);
  await waitFor(() => expect(stopCalls(post)).toHaveLength(1));

  // 회의 id는 이미 알고 있다 — 0바이트 stop이 그 회의를 서버에서 지운다 (설계 §6).
  const [, body, config] = stopCalls(post)[0] as [
    string,
    Uint8Array,
    { headers: Record<string, string> },
  ];
  expect(body.byteLength).toBe(0);
  expect(config.headers["X-Audio-Offset"]).toBe("0");
  expect(config.headers["X-Final-Offset"]).toBe("0");
  expect(onStarted).not.toHaveBeenCalled();
  expect(startCalls(post)).toHaveLength(1); // 생성을 다시 시도하지 않는다 (설계 §6)
  await waitFor(() => expect(mic.stopTrack).toHaveBeenCalledTimes(1));
});

/**
 * `fe/CLAUDE.md` — UI 문구는 한국어다. 레코더가 던지는 메시지는 전부 진단용 영어라
 * ("the capture worklet never acknowledged begun") 토스트에 그대로 실으면 안 된다.
 * begun ACK 타임아웃은 그 영어가 사용자에게 닿는 가장 쉬운 길이었다.
 */
test("레코더의 진단용 영어 메시지는 토스트에 새지 않는다", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  stubCapture({ begun: false });
  renderDialog();
  await passGate();
  click("녹음 시작");

  await vi.advanceTimersByTimeAsync(5000);
  expect(
    await screen.findByText("녹음을 시작하지 못했어요"),
  ).toBeInTheDocument();
  expect(screen.queryByText(/acknowledged begun/)).toBeNull();
  expect(screen.getByText("잠시 후 다시 시도해 주세요.")).toBeInTheDocument();
});

test("준비 실패도 사용자가 할 수 있는 일을 한국어로 말한다", async () => {
  stubCapture({ addModuleRejects: new Error("worklet load failed") });
  renderDialog();
  await passGate();
  click("녹음 시작");

  expect(await screen.findByText("마이크를 열지 못했어요")).toBeInTheDocument();
  expect(screen.queryByText(/worklet load failed/)).toBeNull();
  expect(
    screen.getByText("마이크 권한과 연결을 확인한 뒤 다시 시도해 주세요."),
  ).toBeInTheDocument();
});

/**
 * `dispose()`와 `cancelLivePreparation()`은 짝이 다르다: dispose는 레코더 자원만 놓고
 * live-session의 예약(`active`)은 그대로 두며, **회의에 이미 붙은 녹음도 죽인다**.
 * begin이 성공한 뒤의 예외(여기서는 상세 이동 콜백)가 그 차이를 드러낸다 — 녹음은
 * 서버에서 이미 시작됐고 오디오가 흐르고 있는데, 잘못된 정리가 마이크를 꺼 버린다.
 */
test("시작에 성공한 뒤의 예외가 이미 시작된 녹음을 죽이지 않는다", async () => {
  const mic = stubCapture();
  const onStarted = vi.fn(() => {
    throw new Error("navigation blew up");
  });
  renderDialog(onStarted);
  await passGate();
  click("녹음 시작");

  await waitFor(() => expect(onStarted).toHaveBeenCalledWith("m7"));
  // 녹음은 살아 있어야 한다 — 마이크도, 이 탭의 활성 캡처 등록도.
  expect(mic.stopTrack).not.toHaveBeenCalled();
  expect(getLiveRecorder("m7")).toBeDefined();
  expect(getLiveRecorder("m7")?.recorder.status.phase).toBe("recording");
});

test("준비 중에 취소하면 늦게 도착한 스트림을 즉시 닫고 회의를 만들지 않는다", async () => {
  const prompt = deferred<MediaStream>();
  const mic = stubCapture({ micPrompt: prompt.promise });
  const { post, onStarted } = renderDialog();
  await passGate();
  click("녹음 시작"); // 권한 프롬프트가 뜬 채로 멈춘다

  click("취소"); // 사용자가 기다리다 그만둔다
  prompt.resolve(mic.stream); // 프롬프트가 뒤늦게 허용으로 끝난다

  // 늦게 온 스트림의 주인은 아무도 아니다 — 붙들고 있으면 녹음 표시등만 켜진 채 남는다.
  await waitFor(() => expect(mic.stopTrack).toHaveBeenCalledTimes(1));
  expect(startCalls(post)).toHaveLength(0);
  expect(onStarted).not.toHaveBeenCalled();
});

/**
 * 설계 §6.4 — "권한 프롬프트 자체에는 제한을 두지 않는다." 사용자가 프롬프트를 30초
 * 들여다보다 허용을 눌러도 녹음은 시작돼야 한다. ready·begun의 5초와 달리 이 대기에는
 * 타이머가 없다는 것을, 5초를 훌쩍 넘겨 놓고도 성공하는 것으로 확인한다.
 */
test("권한 프롬프트 대기에는 시간 제한이 없다", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const prompt = deferred<MediaStream>();
  const mic = stubCapture({ micPrompt: prompt.promise });
  const { post, onStarted } = renderDialog();
  await passGate();
  click("녹음 시작");

  await vi.advanceTimersByTimeAsync(30_000); // ready/begun 제한의 6배
  expect(startCalls(post)).toHaveLength(0); // 아직 준비 중이라 회의도 없다
  expect(mic.stopTrack).not.toHaveBeenCalled(); // 그리고 포기하지도 않았다

  prompt.resolve(mic.stream);
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith("m7"));
});

test("시작 요청이 도는 동안 버튼을 다시 눌러도 회의를 두 번 만들지 않는다", async () => {
  const prompt = deferred<MediaStream>();
  const mic = stubCapture({ micPrompt: prompt.promise });
  const { post, onStarted } = renderDialog();
  await passGate();
  click("녹음 시작");
  click("녹음 시작"); // 연타
  click("녹음 시작");

  prompt.resolve(mic.stream);
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith("m7"));
  expect(startCalls(post)).toHaveLength(1);
  expect(mic.getUserMedia).toHaveBeenCalledTimes(1);
});
