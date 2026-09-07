import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { Toaster } from "@/shared/ui/toaster";
import { CHUNK_BYTES, SR } from "./pcm-convert";
import type { WorkletCommand, WorkletEvent } from "./pcm-worklet-protocol";
import {
  beginLiveCapture,
  cancelLivePreparation,
  clearLiveCapture,
  getLiveRecorder,
  LiveCaptureBusy,
  prepareLiveRecorder,
  subscribeLiveStatus,
} from "./live-session";

/**
 * 브라우저 탭 하나가 가지는 활성 녹음 하나를 들고 있는 싱글턴. 다이얼로그(마이크 권한을
 * 그 자리에서 받아야 함)와 회의 상세 화면(종료를 이어받음)이 리마운트를 사이에 두고
 * 같은 LiveRecorder를 공유해야 하므로 존재한다 — postChunk/postStop 배선, registry
 * 동작, 실패 토스트만 검증한다. LiveRecorder 자신의 업로드 루프는
 * lib/live-recorder.test.ts가 덮는다.
 *
 * .tsx인 이유: 실패 토스트가 실제로 사용자에게 보이는지(어느 페이지가 떠 있든)를
 * 검증하려면 <Toaster/>를 렌더해야 한다 — toast()의 store는 모듈 스코프라 스파이로는
 * useToast() 훅을 거치는 내부 호출을 가로챌 수 없다(같은 모듈 내부 참조는 외부
 * vi.spyOn(namespace, 'toast')의 영향을 받지 않는다).
 */

/**
 * jsdom엔 없는 마이크·Worklet 전역을 최소한으로 흉내 낸다 — lib/live-recorder.test.ts의
 * stubWorkletGlobals와 같은 수준. getAudioTracks()의 addEventListener를 감시해 테스트가
 * "ended" 콜백을 손으로 호출할 수 있게 한다(장치 끊김을 흉내).
 */
function stubMic() {
  const stopTrack = vi.fn();
  let endedCallback: (() => void) | null = null;
  const stream = {
    getTracks: () => [{ stop: stopTrack }],
    getAudioTracks: () => [
      {
        addEventListener: (_event: string, cb: () => void) => {
          endedCallback = cb;
        },
      },
    ],
  };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });

  const posted: WorkletCommand[] = [];
  const port = {
    onmessage: null as ((e: MessageEvent<WorkletEvent>) => void) | null,
    postMessage(message: WorkletCommand) {
      posted.push(message);
      if (message.type === "begin") emit({ type: "begun" });
      if (message.type === "flush") emit({ type: "flushed" });
    },
  };
  const emit = (event: WorkletEvent) =>
    port.onmessage?.({ data: event } as MessageEvent<WorkletEvent>);

  class FakeAudioContext {
    sampleRate = SR;
    destination = {};
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    createMediaStreamSource = vi.fn().mockReturnValue({ connect: vi.fn() });
    createGain = vi
      .fn()
      .mockReturnValue({ gain: { value: 1 }, connect: vi.fn() });
    close = vi.fn().mockResolvedValue(undefined);
    resume = vi.fn(async () => emit({ type: "ready" }));
  }
  class FakeAudioWorkletNode {
    port = port;
    connect = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  return { stopTrack, posted, endDevice: () => endedCallback?.() };
}

/** prepare → 회의 생성 → begin까지 태운, 이 탭의 활성 녹음. */
async function startCapture(meetingId: string) {
  const capture = await prepareLiveRecorder();
  await beginLiveCapture(capture, meetingId);
  return capture;
}

describe("live-session registry", () => {
  afterEach(async () => {
    // toast()의 store는 모듈 스코프라 unmount로는 안 비워진다 — 다음 테스트가 새
    // <Toaster/>를 마운트해도 지난 토스트가 같이 그려져 findByText가 여러 매치로
    // 깨진다. 닫기 버튼을 전부 눌러(동기적으로 dismissToast를 태운다) store를 비운다.
    screen
      .queryAllByRole("button", { name: "닫기" })
      .forEach((btn) => fireEvent.click(btn));
    cleanup();
    clearLiveCapture("m1");
    clearLiveCapture("m2");
    // 회의에 붙지 않은 준비가 남아 있으면 다음 테스트의 소유자를 밀어낸다.
    await cancelLivePreparation();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("준비한 캡처를 회의 id로 돌려준다", async () => {
    stubMic();
    const capture = await startCapture("m1");
    expect(getLiveRecorder("m1")?.recorder).toBe(capture.recorder);
  });

  it("다른 회의 id로는 찾지 못한다", async () => {
    stubMic();
    await startCapture("m1");
    expect(getLiveRecorder("m2")).toBeUndefined();
  });

  // 회의를 만들기 전(prepared)에는 붙일 id가 없다. 이 사이에 상세 화면이 레코더를
  // 찾을 수 있으면, 아직 존재하지도 않는 회의의 종료 버튼이 살아 있는 셈이 된다.
  it("준비만 된 캡처는 아직 어떤 회의로도 조회되지 않는다", async () => {
    stubMic();
    await prepareLiveRecorder();
    expect(getLiveRecorder("m1")).toBeUndefined();
  });

  it("clear는 일치하는 회의만 지운다", async () => {
    stubMic();
    await startCapture("m1");
    clearLiveCapture("m2");
    expect(getLiveRecorder("m1")).toBeDefined();
    clearLiveCapture("m1");
    expect(getLiveRecorder("m1")).toBeUndefined();
  });

  /**
   * 설계 §6 — "이전 레코더를 fire-and-forget stop하면서 새 녹음을 만들지 않는다."
   * 옛 createLiveRecorder는 정확히 그것을 했고, 그 stop의 실패는 아무도 보지 못했다.
   */
  it("이미 녹음 중이면 새 준비를 시작하지 않는다", async () => {
    const mic = stubMic();
    const first = await startCapture("m1");
    // 문구가 아니라 타입으로 거절한다 — 사용자에게 보일 문장은 화면이 정한다.
    await expect(prepareLiveRecorder()).rejects.toBeInstanceOf(LiveCaptureBusy);
    // 진행 중인 녹음은 그대로다 — 마이크도 살아 있고 registry도 그대로다.
    expect(mic.stopTrack).not.toHaveBeenCalled();
    expect(getLiveRecorder("m1")?.recorder).toBe(first.recorder);
  });

  /**
   * 수용 테스트 R9. 서버가 4시간 상한에서 스스로 봉인하면 회의가 recording을 벗어나
   * 배너와 종료 버튼이 사라진다 — `clearLiveCapture`를 부르는 유일한 자리인
   * `pages/meeting.tsx`의 종료 성공 핸들러에 아무도 닿지 못한다. 소유자 판정이
   * `meetingId`만 봤을 때는 `active`가 영원히 남아, 그 탭의 모든 새 녹음이 "진행 중인
   * 녹음을 먼저 종료해 주세요."로 거절됐다(새로고침 전까지).
   */
  it("서버가 스스로 봉인한 뒤에도 그 탭에서 새 녹음을 시작할 수 있다", async () => {
    stubMic();
    vi.spyOn(apiClient, "post").mockResolvedValue({
      status: 409,
      data: { expected_offset: 460800000, code: "duration_limit" },
    } as never);
    const sealed = await startCapture("m1");
    sealed.recorder.enqueue(new Uint8Array(CHUNK_BYTES));
    await sealed.recorder.drain();
    expect(sealed.recorder.status.sealed).toBe("duration_limit");

    const next = await prepareLiveRecorder();
    expect(next.recorder).not.toBe(sealed.recorder);
    expect(next.recorder.status.phase).toBe("prepared");
  });

  /**
   * 같은 잠김의 다른 문: 종료 mutation이 실패해 `clearLiveCapture`가 불리지 않으면
   * 레코더는 stopped인데 registry에는 남는다. 죽은 캡처는 새 녹음을 막지 않아야 한다.
   */
  it("종료된 캡처가 registry에 남아 있어도 새 녹음을 막지 않는다", async () => {
    stubMic();
    vi.spyOn(apiClient, "post").mockResolvedValue({
      status: 200,
      data: { meeting_id: "m1", job_id: "job_1", outcome: "stopping" },
    } as never);
    const finished = await startCapture("m1");
    await finished.recorder.stop();
    expect(finished.recorder.status.phase).toBe("stopped");
    // clearLiveCapture를 일부러 부르지 않는다 — 종료 요청이 실패한 탭의 상태다.
    const next = await prepareLiveRecorder();
    expect(next.recorder).not.toBe(finished.recorder);
  });

  it("회의에 붙지 않은 이전 준비는 새 준비가 정리한다", async () => {
    const mic = stubMic();
    const abandoned = await prepareLiveRecorder();
    const next = await prepareLiveRecorder();
    expect(next.recorder).not.toBe(abandoned.recorder);
    expect(mic.stopTrack).toHaveBeenCalledTimes(1); // 버려진 준비의 마이크
    expect(abandoned.recorder.status.phase).toBe("stopped");
  });

  it("postChunk는 apiClient를 통해 청크를 올린다", async () => {
    stubMic();
    vi.spyOn(apiClient, "post").mockResolvedValue({
      status: 200,
      data: { expected_offset: CHUNK_BYTES },
    } as never);
    const { recorder } = await startCapture("m1");
    recorder.enqueue(new Uint8Array(CHUNK_BYTES));
    await recorder.drain();
    expect(apiClient.post).toHaveBeenCalledWith(
      "/meetings/m1/live/audio",
      expect.any(Uint8Array),
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Audio-Offset": "0" }),
      }),
    );
    expect(recorder.offset).toBe(CHUNK_BYTES);
  });

  it("stop()이 끝나면 서버 응답(outcome)을 stopOutcome으로 읽을 수 있다", async () => {
    stubMic();
    vi.spyOn(apiClient, "post").mockResolvedValue({
      status: 200,
      data: { meeting_id: "m1", job_id: "job_1", outcome: "stopping" },
    } as never);
    const { recorder, stopOutcome } = await startCapture("m1");
    expect(stopOutcome.current).toBeNull();
    await recorder.stop();
    expect(stopOutcome.current).toEqual({
      meeting_id: "m1",
      job_id: "job_1",
      outcome: "stopping",
    });
  });

  /**
   * 설계 §6 — 201을 받은 뒤 begin이 실패하면 회의 id를 이미 알고 있으므로 0바이트
   * stop으로 그 자리에서 지운다. 이게 없으면 아무도 쓰지 않는 recording 회의가 남아,
   * 부분 유일 인덱스가 다음 녹음까지 막는다.
   */
  it("begin이 실패하면 그 회의를 0바이트 stop으로 정리하고 소유권을 놓는다", async () => {
    stubMic();
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({
      status: 200,
      data: { meeting_id: "m1", job_id: "job_1", outcome: "discarded" },
    } as never);
    const capture = await prepareLiveRecorder();
    vi.spyOn(capture.recorder, "begin").mockRejectedValue(new Error("no ack"));

    await expect(beginLiveCapture(capture, "m1")).rejects.toThrow("no ack");
    expect(post).toHaveBeenCalledWith(
      "/meetings/m1/live/stop",
      expect.any(Uint8Array),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Audio-Offset": "0",
          "X-Final-Offset": "0",
        }),
      }),
    );
    expect((post.mock.calls[0][1] as Uint8Array).byteLength).toBe(0);
    expect(getLiveRecorder("m1")).toBeUndefined();
  });

  /**
   * 라우트 전환이 녹음을 끝내면 안 된다 (설계 §6). cancelLivePreparation은 "아직 회의가
   * 없는 준비"만 놓아 준다 — 활성 녹음에는 손대지 않는다.
   */
  it("취소는 준비 중인 캡처만 놓고 활성 녹음은 건드리지 않는다", async () => {
    const mic = stubMic();
    const capture = await startCapture("m1");
    await cancelLivePreparation();
    expect(getLiveRecorder("m1")?.recorder).toBe(capture.recorder);
    expect(mic.stopTrack).not.toHaveBeenCalled();
  });

  it("subscribeLiveStatus는 등록된 회의에만 상태를 흘려준다", async () => {
    stubMic();
    const { recorder } = await startCapture("m1");
    const seen: unknown[] = [];
    subscribeLiveStatus("m1", (s) => seen.push(s));
    // 다른 회의 id로는 아무 효과가 없다 — 지금은 활성 레코더가 m1뿐이다.
    subscribeLiveStatus("m2", () => seen.push("should-not-happen"));
    recorder.enqueue(new Uint8Array(1));
    expect(seen).toHaveLength(1);
    subscribeLiveStatus("m1", null);
    recorder.enqueue(new Uint8Array(1));
    expect(seen).toHaveLength(1); // 해제 뒤엔 더 안 들어온다.
  });

  // 팀장 정정 — pages/meeting.tsx가 unmount 시 recorder.onStatus를 지워버려서,
  // 다른 화면을 보는 동안 레코더가 실패해도 아무도 모르는 문제였다. 이 테스트는
  // 페이지(subscribeLiveStatus)를 아예 부르지 않은 채로 실패시켜, 그래도 토스트가
  // 뜨는지를 본다 — <Toaster/>만 렌더하고 회의 상세 화면(pages/meeting.tsx)은
  // 마운트하지 않는다.
  it("아무 페이지도 구독하지 않아도 레코더 실패를 토스트로 알린다", async () => {
    const mic = stubMic();
    render(<Toaster />);
    await startCapture("m1");
    mic.endDevice(); // 마이크 연결이 끊김 → status.failed = "device_ended"
    expect(await screen.findByText("녹음이 중단됐어요")).toBeInTheDocument();
    expect(screen.getByText(/마이크 연결이 끊겼어요/)).toBeInTheDocument();
  });

  it("페이지가 구독 중이어도 토스트는 그대로 뜬다 — 배너 갱신에 얹는 것이지 대체가 아니다", async () => {
    const mic = stubMic();
    render(<Toaster />);
    await startCapture("m1");
    const seen: unknown[] = [];
    subscribeLiveStatus("m1", (s) => seen.push(s));
    mic.endDevice();
    expect(await screen.findByText("녹음이 중단됐어요")).toBeInTheDocument();
    expect(
      seen.some((s) => (s as { failed: string }).failed === "device_ended"),
    ).toBe(true);
  });

  it("실패는 한 번만 토스트한다", async () => {
    const mic = stubMic();
    render(<Toaster />);
    await startCapture("m1");
    mic.endDevice();
    await screen.findByText("녹음이 중단됐어요");
    mic.endDevice(); // 이미 실패한 뒤 다시 이벤트가 와도(예: 리스너 중복) 한 번만.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getAllByText("녹음이 중단됐어요")).toHaveLength(1);
  });
});
