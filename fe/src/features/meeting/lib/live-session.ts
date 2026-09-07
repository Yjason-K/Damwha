import { postLiveChunk, postLiveStop } from "../api/live";
import type { LiveStopResponse } from "../api/types";
import {
  LiveCaptureCancelled,
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
export type LiveCapture = {
  recorder: LiveRecorder;
  /**
   * POST .../live/stop의 응답(outcome). LiveRecorder.stop()의 postStop 계약은
   * Promise<void>라 반환값을 보지 않으므로, stop()이 끝난 뒤 이 값을 읽어
   * discarded/stopping을 가른다.
   */
  stopOutcome: { current: LiveStopResponse | null };
};

type ActiveCapture = LiveCapture & {
  /** 준비만 된 캡처는 아직 회의가 없다 — 회의는 준비가 끝난 뒤에야 만들어진다 (설계 §6). */
  meetingId: string | null;
  /** 회의 상세 화면이 마운트돼 있을 때만 존재 — 배너의 실시간 상태(backlogMs/failed) 구독. */
  pageListener: ((status: RecorderStatus) => void) | null;
  /** 실패를 딱 한 번만 토스트한다 — onStatus는 상태가 바뀔 때마다 계속 불린다. */
  toasted: boolean;
};

const FAILURE_MESSAGE: Record<RecorderFailure, string> = {
  buffer_overflow: "업로드가 너무 밀려 더 버틸 수 없었어요.",
  device_ended: "마이크 연결이 끊겼어요.",
  upload_failed: "업로드에 실패했어요.",
  capture_flush_failed: "마지막 오디오를 받아 오지 못했어요.",
};

let active: ActiveCapture | null = null;

/**
 * 이 캡처가 아직 **살아 있는** 녹음인가 — 새 녹음을 막을 근거가 되는 유일한 조건이다.
 *
 * `meetingId`만 보면 안 된다: 서버가 4시간 상한에서 스스로 봉인하면(`duration_limit`)
 * 회의가 recording을 벗어나 배너와 종료 버튼이 사라지고, `clearLiveCapture`를 부르는
 * 유일한 자리(`pages/meeting.tsx`의 종료 성공 핸들러)에 아무도 닿지 못한다. 그러면
 * `active`는 영원히 남아 그 탭의 모든 새 녹음이 "진행 중인 녹음을 먼저 종료해 주세요."로
 * 거절된다 — 새로고침 전까지. (수용 테스트 R9.)
 *
 * 캡처가 끝났다는 신호는 둘이고 서로 독립적이다: 레코더가 `stopped`로 수렴했거나(설계 §6),
 * 서버가 봉인했거나(설계 §4.2). 둘 중 하나면 죽은 것이다.
 */
/**
 * 이 탭에 이미 살아 있는 녹음이 있어 새 준비를 거절했다.
 *
 * 문구가 아니라 **타입**으로 알리는 이유: 화면에 보일 문장은 화면이 정한다
 * (`fe/CLAUDE.md` — UI 문구는 한국어). 데이터 레이어가 한국어 문장을 던지면, 화면은
 * "이 Error.message는 사용자에게 보여도 되는가"를 구별할 방법이 없어 결국 레코더의
 * 진단용 영어까지 같이 토스트에 싣게 된다.
 */
export class LiveCaptureBusy extends Error {
  constructor() {
    super("a live capture is already running in this tab");
  }
}

function isLiveCapture(entry: ActiveCapture): boolean {
  return (
    entry.meetingId !== null &&
    entry.recorder.status.phase !== "stopped" &&
    entry.recorder.status.sealed === null
  );
}

/**
 * 캡처를 준비하고 **그 순간부터** 모듈 소유자로 예약한다 (설계 §6).
 *
 * 예약이 준비보다 먼저인 이유: getUserMedia가 답하기까지 몇 초가 걸리고 그 사이 버튼을
 * 다시 누를 수 있다. 예약이 없으면 두 번째 prepare가 첫 번째를 모른 채 마이크를 하나 더
 * 열고, 둘 중 하나는 아무도 멈출 수 없는 채로 남는다.
 *
 * 이미 녹음 중이면 시작하지 않는다 — 이전 레코더를 fire-and-forget stop하면서 새 녹음을
 * 만들면 그 stop의 실패가 조용히 사라지고 두 회의가 겹친다 (설계 §6).
 */
export async function prepareLiveRecorder(
  deviceId?: string,
): Promise<LiveCapture> {
  if (active && isLiveCapture(active)) throw new LiveCaptureBusy();
  // 이전 예약 — 회의에 붙지 않은 준비이거나, 이미 끝난(봉인·실패·종료) 캡처다.
  // 새 예약을 세운 뒤에 정리한다.
  const previous = active;

  const stopOutcome: { current: LiveStopResponse | null } = { current: null };
  const recorder = new LiveRecorder({
    postChunk: postLiveChunk,
    postStop: (id, offset, final, body, elapsedMs, failure) =>
      postLiveStop(id, offset, final, body, elapsedMs, failure, (res) => {
        stopOutcome.current = res;
      }),
  });

  const entry: ActiveCapture = {
    meetingId: null,
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

  // 예약은 **첫 await 이전에** 끝낸다. 이 함수의 비동기 앞부분에서 예약하면 같은 tick의
  // 두 번째 클릭이 예약을 못 보고 마이크를 하나 더 연다.
  active = entry;
  if (previous) await previous.recorder.dispose();
  try {
    await recorder.prepare(deviceId);
  } finally {
    // 준비에 실패했거나, 준비 중에 다른 시작이 소유권을 가져갔으면 예약을 놓는다.
    if (active === entry && recorder.status.phase !== "prepared") active = null;
  }
  return entry;
}

/**
 * 준비된 캡처를 방금 만들어진 회의에 붙인다 (설계 §6.5).
 *
 * 실패하면 서버에 남은 그 회의를 0바이트 stop으로 정리한다 — id를 알고 있으므로
 * orphan 스캐너를 90초 기다릴 이유가 없다. 생성 POST는 재시도하지 않는다 (설계 §6).
 */
export async function beginLiveCapture(
  capture: LiveCapture,
  meetingId: string,
): Promise<void> {
  const entry = active;
  if (!entry || entry.recorder !== capture.recorder) {
    // 이 캡처는 이미 다른 시작에 밀렸다. 방금 만든 회의만 정리하고 끝낸다.
    await discardMeeting(capture, meetingId);
    throw new LiveCaptureCancelled(
      "this capture was superseded by another start",
    );
  }
  entry.meetingId = meetingId;
  try {
    await capture.recorder.begin(meetingId);
  } catch (err) {
    if (active === entry) active = null;
    await discardMeeting(capture, meetingId);
    throw err;
  }
}

/**
 * 준비만 하고 회의에 붙지 않은 캡처를 취소한다. 활성 녹음(회의가 있는 캡처)은 건드리지
 * 않는다 — 라우트 전환이나 모달 닫기가 진행 중인 녹음을 끝내면 안 된다 (설계 §6).
 */
export async function cancelLivePreparation(): Promise<void> {
  const entry = active;
  if (!entry || entry.meetingId !== null) return;
  active = null;
  await entry.recorder.dispose();
}

/** 붙이지 못한 회의를 0바이트 stop으로 지운다. 실패해도 orphan 스캐너가 회수한다. */
async function discardMeeting(capture: LiveCapture, meetingId: string) {
  await postLiveStop(meetingId, 0, 0, new Uint8Array(0), 0, null, (res) => {
    capture.stopOutcome.current = res;
  }).catch(() => undefined);
}

/** 이 회의 id의 활성 레코더. 다른 회의거나 없으면 undefined. */
export function getLiveRecorder(meetingId: string): LiveCapture | undefined {
  return active?.meetingId === meetingId ? active : undefined;
}

/**
 * 회의 상세 화면(배너)이 실시간 상태(backlogMs/failed)를 받을 콜백을 등록/해제한다.
 * recorder.onStatus 자체는 건드리지 않는다 — 그 슬롯은 prepareLiveRecorder가 실패 토스트용
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
