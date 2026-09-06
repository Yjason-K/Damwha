import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { Toaster } from "@/shared/ui/toaster";
import { CHUNK_BYTES, SR } from "./pcm-convert";
import {
  clearLiveCapture,
  createLiveRecorder,
  getLiveRecorder,
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
 * jsdom엔 없는 마이크 관련 전역을 최소한으로 흉내 낸다 — lib/live-recorder.test.ts의
 * "워크릿 실패 정리" 테스트와 같은 수준. getAudioTracks()의 addEventListener를 감시해
 * 테스트가 "ended" 콜백을 손으로 호출할 수 있게 한다(장치 끊김을 흉내).
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
  class FakeAudioContext {
    sampleRate = SR;
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    createMediaStreamSource = vi.fn().mockReturnValue({ connect: vi.fn() });
    close = vi.fn().mockResolvedValue(undefined);
  }
  class FakeAudioWorkletNode {
    port: { onmessage: unknown } = { onmessage: null };
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  return {
    stopTrack,
    endDevice: () => endedCallback?.(),
  };
}

describe("live-session registry", () => {
  afterEach(() => {
    // toast()의 store는 모듈 스코프라 unmount로는 안 비워진다 — 다음 테스트가 새
    // <Toaster/>를 마운트해도 지난 토스트가 같이 그려져 findByText가 여러 매치로
    // 깨진다. 닫기 버튼을 전부 눌러(동기적으로 dismissToast를 태운다) store를 비운다.
    screen
      .queryAllByRole("button", { name: "닫기" })
      .forEach((btn) => fireEvent.click(btn));
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "mediaDevices");
    clearLiveCapture("m1");
    clearLiveCapture("m2");
  });

  it("만든 레코더를 회의 id로 돌려준다", () => {
    const { recorder } = createLiveRecorder("m1");
    expect(getLiveRecorder("m1")?.recorder).toBe(recorder);
  });

  it("다른 회의 id로는 찾지 못한다", () => {
    createLiveRecorder("m1");
    expect(getLiveRecorder("m2")).toBeUndefined();
  });

  it("clear는 일치하는 회의만 지운다", () => {
    createLiveRecorder("m1");
    clearLiveCapture("m2");
    expect(getLiveRecorder("m1")).toBeDefined();
    clearLiveCapture("m1");
    expect(getLiveRecorder("m1")).toBeUndefined();
  });

  // active는 레코더를 가리키는 유일한 참조다 — 정리 없이 덮어쓰면 이전 레코더의
  // 마이크(MediaStreamTrack)와 업로드 루프는 아무도 멈출 수 없는 채로 계속 산다.
  it("새로 만들면 이전 활성 레코더의 마이크를 먼저 정리한다", async () => {
    const mic = stubMic();
    vi.spyOn(apiClient, "post").mockResolvedValue({
      status: 200,
      data: { meeting_id: "m1", job_id: "job_1", outcome: "stopping" },
    } as never);
    const first = createLiveRecorder("m1");
    await first.recorder.start("m1");
    expect(mic.stopTrack).not.toHaveBeenCalled();

    const second = createLiveRecorder("m2");

    // stop()의 teardown()은 자기 자신의 첫 await 이전에 트랙을 정지시키므로
    // (LiveRecorder.stop → teardown → getTracks().forEach(stop)), createLiveRecorder가
    // 동기적으로 반환한 시점에 이미 호출돼 있어야 한다.
    expect(mic.stopTrack).toHaveBeenCalledTimes(1);
    expect(getLiveRecorder("m1")).toBeUndefined();
    expect(getLiveRecorder("m2")?.recorder).toBe(second.recorder);
  });

  it("postChunk는 apiClient를 통해 청크를 올린다", async () => {
    vi.spyOn(apiClient, "post").mockResolvedValue({
      status: 200,
      data: { expected_offset: CHUNK_BYTES },
    } as never);
    const { recorder } = createLiveRecorder("m1");
    // recorder.start()는 실제 마이크가 필요해 여기서는 부르지 않는다 — meetingId는
    // start()가 세우므로 이 레코더는 빈 문자열로 남는다. 그 값 자체는
    // api/live.test.tsx가 덮으므로, 여기서는 postChunk가 실제로 apiClient를
    // 거쳐 헤더/바디를 실어 보내는 배선만 본다.
    recorder.enqueue(new Uint8Array(CHUNK_BYTES));
    await recorder.drain();
    expect(apiClient.post).toHaveBeenCalledWith(
      "/meetings//live/audio",
      expect.any(Uint8Array),
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Audio-Offset": "0" }),
      }),
    );
    expect(recorder.offset).toBe(CHUNK_BYTES);
  });

  it("stop()이 끝나면 서버 응답(outcome)을 stopOutcome으로 읽을 수 있다", async () => {
    vi.spyOn(apiClient, "post").mockResolvedValue({
      status: 200,
      data: { meeting_id: "m1", job_id: "job_1", outcome: "stopping" },
    } as never);
    const { recorder, stopOutcome } = createLiveRecorder("m1");
    expect(stopOutcome.current).toBeNull();
    await recorder.stop();
    expect(stopOutcome.current).toEqual({
      meeting_id: "m1",
      job_id: "job_1",
      outcome: "stopping",
    });
  });

  it("subscribeLiveStatus는 등록된 회의에만 상태를 흘려준다", () => {
    const { recorder } = createLiveRecorder("m1");
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
    const { recorder } = createLiveRecorder("m1");
    await recorder.start("m1");
    mic.endDevice(); // 마이크 연결이 끊김 → status.failed = "device_ended"
    expect(await screen.findByText("녹음이 중단됐어요")).toBeInTheDocument();
    expect(screen.getByText(/마이크 연결이 끊겼어요/)).toBeInTheDocument();
  });

  it("페이지가 구독 중이어도 토스트는 그대로 뜬다 — 배너 갱신에 얹는 것이지 대체가 아니다", async () => {
    const mic = stubMic();
    render(<Toaster />);
    const { recorder } = createLiveRecorder("m1");
    await recorder.start("m1");
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
    const { recorder } = createLiveRecorder("m1");
    await recorder.start("m1");
    mic.endDevice();
    await screen.findByText("녹음이 중단됐어요");
    mic.endDevice(); // 이미 실패한 뒤 다시 이벤트가 와도(예: 리스너 중복) 한 번만.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getAllByText("녹음이 중단됐어요")).toHaveLength(1);
  });
});
