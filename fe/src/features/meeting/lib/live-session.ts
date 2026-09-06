import { postLiveChunk, postLiveStop } from "../api/live";
import type { LiveStopResponse } from "../api/types";
import {
  LiveRecorder,
  type RecorderFailure,
  type RecorderStatus,
} from "./live-recorder";
import { toast } from "@/shared/ui/use-toast";

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

type ActiveCapture = LiveCapture & {
  meetingId: string;
  /** 회의 상세 화면이 마운트돼 있을 때만 존재 — 배너의 실시간 상태(backlogMs/failed) 구독. */
  pageListener: ((status: RecorderStatus) => void) | null;
  /** 실패를 딱 한 번만 토스트한다 — onStatus는 상태가 바뀔 때마다 계속 불린다. */
  toasted: boolean;
};

const FAILURE_MESSAGE: Record<RecorderFailure, string> = {
  buffer_overflow: "업로드가 너무 밀려 더 버틸 수 없었어요.",
  device_ended: "마이크 연결이 끊겼어요.",
  upload_failed: "업로드에 실패했어요.",
};

let active: ActiveCapture | null = null;

/**
 * 새 레코더를 만들어 이 회의 id로 등록한다.
 *
 * 이전 활성 레코더가 있으면 등록을 덮어쓰기 전에 반드시 정리한다 — active는 레코더를
 * 가리키는 유일한 참조라, 그냥 덮어쓰면 그 마이크와 업로드 루프를 멈출 방법이 영영
 * 사라진다. 서버의 단일 recording 회의 제약 때문에 오늘은 도달하지 않는 경로지만,
 * 클라이언트 쪽엔 그 제약을 강제하는 코드가 없다. stop()이 트랙 정지+AudioContext
 * 종료(teardown)까지 하므로 이걸로 충분하고, 그 회의의 종료 POST도 함께 나간다(마지막
 * tail 봉인) — 실패해도 클라이언트 리소스는 이미 풀렸으므로 무시한다.
 */
export function createLiveRecorder(meetingId: string): LiveCapture {
  active?.recorder.stop().catch(() => undefined);

  const stopOutcome: { current: LiveStopResponse | null } = { current: null };
  const recorder = new LiveRecorder({
    postChunk: postLiveChunk,
    postStop: (id, offset, final, body, elapsedMs) =>
      postLiveStop(id, offset, final, body, elapsedMs, (res) => {
        stopOutcome.current = res;
      }),
  });

  const entry: ActiveCapture = {
    meetingId,
    recorder,
    stopOutcome,
    pageListener: null,
    toasted: false,
  };
  // 이 onStatus 슬롯은 여기서 딱 한 번만 세우고 절대 덮어쓰지 않는다 — 실패를 토스트로
  // 알리는 유일한 통로이고, 레코더는 회의 상세 화면보다 오래 산다(다른 페이지로
  // 이동해도 녹음은 계속된다). 배너가 필요로 하는 실시간 상태는 pageListener로 따로
  // 전달한다 — subscribeLiveStatus만 그 필드를 건드린다.
  recorder.onStatus = (status) => {
    if (status.failed && !entry.toasted) {
      entry.toasted = true;
      toast({
        variant: "error",
        title: "녹음이 중단됐어요",
        description: `${FAILURE_MESSAGE[status.failed]} 지금까지 녹음된 내용은 남아 있어요.`,
      });
    }
    entry.pageListener?.(status);
  };

  active = entry;
  return entry;
}

/** 이 회의 id의 활성 레코더. 다른 회의거나 없으면 undefined. */
export function getLiveRecorder(meetingId: string): LiveCapture | undefined {
  return active?.meetingId === meetingId ? active : undefined;
}

/**
 * 회의 상세 화면(배너)이 실시간 상태(backlogMs/failed)를 받을 콜백을 등록/해제한다.
 * recorder.onStatus 자체는 건드리지 않는다 — 그 슬롯은 createLiveRecorder가 실패 토스트용
 * 으로 이미 쓰고 있고, 페이지가 마운트돼 있지 않아도 계속 살아 있어야 한다. 화면이
 * 없어지면(unmount) null로 부른다.
 */
export function subscribeLiveStatus(
  meetingId: string,
  listener: ((status: RecorderStatus) => void) | null,
): void {
  if (active?.meetingId === meetingId) active.pageListener = listener;
}

/** 종료 뒤 정리. 이미 다른 회의로 넘어갔으면(다른 녹음이 새로 시작됐으면) 손대지 않는다. */
export function clearLiveCapture(meetingId: string): void {
  if (active?.meetingId === meetingId) active = null;
}
