import {
  LiveCaptureCancelled,
  type OpenSystemAudio,
  withTimeout,
} from "./live-recorder";
import {
  beginLiveCapture,
  cancelLivePreparation,
  discardMeeting,
  prepareLiveRecorder,
  reserveLiveStart,
} from "./live-session";

/**
 * 회의 생성 POST의 상한 (이슈 139). 같은 맥의 API라 실측 ≤72ms이고, 녹음 청크·종료 요청의 상한(`REQUEST_TIMEOUT_MS`)과
 * 같은 10초다. `apiClient`에는 timeout이 없어 이것이 유일한 바운드다.
 */
export const CREATE_MEETING_TIMEOUT_MS = 10_000;

/**
 * `work`를 기다리되 `signal`이 abort되면 그 자리에서 `LiveCaptureCancelled`로 끝낸다 (이슈 139). 예전에는 단계가 끝난
 * 뒤에야 abort를 봐서, 응답 없는 단계에 걸린 시작은 취소해도 예약이 풀리지 않았다. `work`의 늦은 결말은 부르는
 * 쪽이 정리한다.
 */
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new LiveCaptureCancelled());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * 실시간 녹음 시작의 공용 흐름 (설계 §6). 준비 → 회의 생성 → 캡처 붙이기 순서다 —
 * 준비가 먼저여야 권한 거절·장치 부재가 빈 회의를 남기지 않는다. 모달과 회의 감지 카드가
 * 같이 쓰며, 시작 예약(`reserveLiveStart`)이 둘의 동시 시작을 막는다.
 *
 * `createMeeting`은 준비가 성공한 뒤에만 불린다. 어느 단계에서든 실패하면 준비만 된 캡처와
 * 예약을 놓고 다시 던진다. 회의가 붙기 전 단계(마이크·시스템 오디오·생성 POST)에는 상한이 있다 (이슈 139).
 * `signal`이 abort되면 기다리던 단계를 버리고 곧바로 `LiveCaptureCancelled`다 — 준비 중이면 늦게 온 자원을
 * 레코더가 닫고, 생성 POST 중이면 늦게 온 회의를 0바이트 stop으로 지운다.
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
    const preparing = prepareLiveRecorder(args.deviceId, args.openSystemAudio);
    let capture: Awaited<typeof preparing>;
    try {
      capture = await untilAborted(preparing, args.signal);
    } catch (error) {
      if (args.signal?.aborted) {
        // 준비를 버린다. 레코더의 세대가 바뀌어, 늦게 온 마이크·시스템 오디오는 레코더가 그 자리에서 닫는다.
        void preparing.catch(() => undefined);
        await cancelLivePreparation();
      }
      throw error;
    }
    try {
      if (args.signal?.aborted) throw new LiveCaptureCancelled();
      const creating = args.createMeeting();
      let meeting: { id: string };
      try {
        meeting = await untilAborted(
          withTimeout(
            creating,
            CREATE_MEETING_TIMEOUT_MS,
            "creating the meeting did not finish in time",
          ),
          args.signal,
        );
      } catch (error) {
        // 응답이 늦게 오면 그 회의는 주인이 없다 — 붙이지 못한 회의처럼 0바이트 stop으로 지운다.
        void creating.then(
          (late) => discardMeeting(capture, late.id),
          () => undefined,
        );
        throw error;
      }
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
