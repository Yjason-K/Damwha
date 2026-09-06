import { postLiveChunk, postLiveStop } from "../api/live";
import type { LiveStopResponse } from "../api/types";
import { LiveRecorder } from "./live-recorder";

/**
 * 브라우저 탭 하나가 가지는 활성 녹음 하나. 다이얼로그("녹음 시작"을 누른 자리라 마이크
 * 권한을 그 자리에서 받아야 한다)가 만들고, 회의 상세 화면(`pages/meeting.tsx`)이
 * 리마운트를 사이에 두고 이어받아 상태를 배너에 잇고 종료를 부른다. 서버가 'recording'
 * 회의를 하나로 제한하므로(설계 §10.2) 탭 하나에 활성 레코더 하나면 충분해 모듈 스코프
 * 싱글턴에 둔다.
 */
type LiveCapture = {
  recorder: LiveRecorder;
  /**
   * POST .../live/stop의 응답(outcome). LiveRecorder.stop()의 postStop 계약은
   * Promise<void>라 반환값을 보지 않으므로, stop()이 끝난 뒤 이 값을 읽어
   * discarded/stopping을 가른다.
   */
  stopOutcome: { current: LiveStopResponse | null };
};

let active: (LiveCapture & { meetingId: string }) | null = null;

/** 새 레코더를 만들어 이 회의 id로 등록한다. 기존 활성 레코더가 있으면 대체한다. */
export function createLiveRecorder(meetingId: string): LiveCapture {
  const stopOutcome: { current: LiveStopResponse | null } = { current: null };
  const recorder = new LiveRecorder({
    postChunk: postLiveChunk,
    postStop: (id, offset, final, body, elapsedMs) =>
      postLiveStop(id, offset, final, body, elapsedMs, (res) => {
        stopOutcome.current = res;
      }),
  });
  active = { meetingId, recorder, stopOutcome };
  return active;
}

/** 이 회의 id의 활성 레코더. 다른 회의거나 없으면 undefined. */
export function getLiveRecorder(meetingId: string): LiveCapture | undefined {
  return active?.meetingId === meetingId ? active : undefined;
}

/** 종료 뒤 정리. 이미 다른 회의로 넘어갔으면(다른 녹음이 새로 시작됐으면) 손대지 않는다. */
export function clearLiveCapture(meetingId: string): void {
  if (active?.meetingId === meetingId) active = null;
}
