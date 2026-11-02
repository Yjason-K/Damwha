import { LiveCaptureCancelled, type OpenSystemAudio } from "./live-recorder";
import {
  beginLiveCapture,
  cancelLivePreparation,
  discardMeeting,
  prepareLiveRecorder,
  reserveLiveStart,
} from "./live-session";

/**
 * 실시간 녹음 시작의 공용 흐름 (설계 §6). 준비 → 회의 생성 → 캡처 붙이기 순서다 —
 * 준비가 먼저여야 권한 거절·장치 부재가 빈 회의를 남기지 않는다. 모달과 회의 감지 카드가
 * 같이 쓰며, 시작 예약(`reserveLiveStart`)이 둘의 동시 시작을 막는다.
 *
 * `createMeeting`은 준비가 성공한 뒤에만 불린다. 어느 단계에서든 실패하면 준비만 된 캡처와
 * 예약을 놓고 다시 던진다. `signal`이 abort되면 `LiveCaptureCancelled`다 — 준비 중이면
 * 준비가 끝난 뒤 캡처를 놓고, 생성 POST 중이면 응답 뒤 그 회의를 0바이트 stop으로 지운다.
 * 오류별 안내(토스트)는 호출자가 정한다.
 */
export async function startLiveRecording(args: {
  deviceId?: string;
  openSystemAudio?: OpenSystemAudio;
  createMeeting: () => Promise<{ id: string }>;
  signal?: AbortSignal;
}): Promise<string> {
  const release = reserveLiveStart();
  try {
    const capture = await prepareLiveRecorder(
      args.deviceId,
      args.openSystemAudio,
    );
    try {
      if (args.signal?.aborted) throw new LiveCaptureCancelled();
      const meeting = await args.createMeeting();
      if (args.signal?.aborted) {
        await discardMeeting(capture, meeting.id);
        throw new LiveCaptureCancelled();
      }
      await beginLiveCapture(capture, meeting.id);
      return meeting.id;
    } catch (error) {
      // 회의에 이미 붙은 녹음은 건드리지 않는다 — 준비만 된 캡처와 예약만 놓는다.
      await cancelLivePreparation();
      throw error;
    }
  } finally {
    release();
  }
}
