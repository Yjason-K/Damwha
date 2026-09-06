import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { CHUNK_BYTES } from "./pcm-convert";
import {
  clearLiveCapture,
  createLiveRecorder,
  getLiveRecorder,
} from "./live-session";

/**
 * 브라우저 탭 하나가 가지는 활성 녹음 하나를 들고 있는 싱글턴. 다이얼로그(마이크 권한을
 * 그 자리에서 받아야 함)와 회의 상세 화면(종료를 이어받음)이 리마운트를 사이에 두고
 * 같은 LiveRecorder를 공유해야 하므로 존재한다 — postChunk/postStop 배선과 registry
 * 동작만 검증한다. LiveRecorder 자신의 업로드 루프는 lib/live-recorder.test.ts가 덮는다.
 */
describe("live-session registry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("새로 만들면 이전 활성 레코더를 대체한다", () => {
    createLiveRecorder("m1");
    const second = createLiveRecorder("m2");
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
});
