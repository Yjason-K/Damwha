import * as React from "react";

import { Button } from "@/shared/ui/button";

import { formatClock } from "../api/mappers";
import type { JsonError } from "../api/types";
import { BACKLOG_WARN_MS, type RecorderFailure } from "../lib/live-recorder";
import { Icon } from "./icons";

/**
 * LiveBanner — 녹음 중인 회의의 상단 배너. ProcessingBanner 자리에 선다.
 * 경과 시간은 워커가 첫 샘플 시각으로 찍은 recorded_at 기준이고, heartbeat(세션 job의
 * locked_at)가 STALE_MS 넘게 멈추면 "신호 끊김"으로 바뀐다 — reaper의 stale 창(30분)이
 * 닫히기 전까지 거짓 "녹음 중"을 보여주지 않기 위한 최소 장치다 (설계 §8).
 */

/**
 * 워커의 heartbeat 주기(`be/worker/damwha_worker/config.py`의
 * `heartbeat_interval_seconds`, 기본 30초)의 **3배**다. 둘 중 하나를 바꾸면 반드시
 * 다른 쪽을 같이 본다.
 *
 * 임계값이 주기와 같으면 안 된다: 워커는 한 주기를 **기다린 뒤** 첫 박을 찍으므로
 * locked_at은 매 박 직전 정확히 주기만큼 늙는다. 여기에 1초 폴링 지연과 브라우저
 * 시계(Date.now)와 DB 시계의 오차가 얹혀, 건강한 녹음에서도 30초마다 빨간 "신호가
 * 끊겼어요"가 1초쯤 번쩍인다. 매번 늑대를 부르는 경고는 없느니만 못하다 — 이 배너는
 * 초록 상태를 믿게 하려고 있다. 3배면 박 하나를 통째로 놓쳐도(GC, 순간적인 DB 지연)
 * 조용하고, 진짜 죽음은 여전히 90~120초 안에 잡아 reaper의 30분보다 한참 빠르다.
 */
const STALE_MS = 90_000;

export function isHeartbeatStale(
  heartbeatAt: string | null,
  nowMs: number,
  thresholdMs: number = STALE_MS,
): boolean {
  if (!heartbeatAt) return false;
  const t = new Date(heartbeatAt).getTime();
  if (Number.isNaN(t)) return false;
  return nowMs - t > thresholdMs;
}

function useTick(now: () => number, active: boolean): number {
  const [tick, setTick] = React.useState(() => now());
  React.useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick(now()), 1000);
    return () => window.clearInterval(id);
  }, [active, now]);
  return tick;
}

type LiveBannerProps = {
  recordedAtIso: string;
  /** 세션 job의 stage. null이면 워커가 아직 claim하지 않았다. */
  stage: string | null;
  heartbeatAt: string | null;
  onStop: () => void;
  /**
   * 워커가 죽은 상태의 유일한 탈출구 — POST /meetings/:id/cancel.
   * stop은 job에 플래그만 찍으므로 읽어 줄 워커가 없으면 아무 일도 일어나지 않는다.
   */
  onCancel: () => void;
  stopping: boolean;
  cancelling?: boolean;
  /** 테스트용 시계. */
  now?: () => number;
  /** LiveRecorder.status.backlogMs — 미전송 업로드 큐 길이(ms). */
  backlogMs?: number;
  /** LiveRecorder가 캡처를 멈췄으면 사유. 서버엔 이미 그때까지의 녹음이 있다. */
  failed?: RecorderFailure | null;
};

export function LiveBanner({
  recordedAtIso,
  stage,
  heartbeatAt,
  onStop,
  onCancel,
  stopping,
  cancelling = false,
  now = Date.now,
  backlogMs = 0,
  failed = null,
}: LiveBannerProps) {
  const queued = stage === null;
  const nowMs = useTick(now, !queued);
  const stale = !queued && isHeartbeatStale(heartbeatAt, nowMs);
  const started = new Date(recordedAtIso).getTime();
  const elapsed = Number.isNaN(started) ? 0 : Math.max(0, nowMs - started);

  // 레코더가 스스로 멈춘 경우(버퍼 폭주·장치 끊김) — 워커 heartbeat는 여전히 정상일 수
  // 있으므로 stale보다 먼저 본다. 서버엔 이미 그때까지의 녹음이 있으니 종료(stop)가
  // 여전히 맞는 동작이다 — 큐를 비우고(이미 실패했으니 빈 큐) 꼬리를 봉인한다.
  if (failed) {
    return (
      <div
        role="alert"
        className="flex items-center gap-2.5 border-b border-[color:var(--red-9)] bg-[var(--red-bg)] px-7 py-2.5 text-sm"
      >
        <Icon
          name="mic"
          size={15}
          className="shrink-0 text-[color:var(--red-text)]"
        />
        <span className="font-semibold text-[color:var(--red-text)]">
          녹음이 중단됐어요
        </span>
        <span className="text-[color:var(--text-secondary)]">
          {failed === "buffer_overflow"
            ? "업로드가 너무 밀려 더 버틸 수 없었어요."
            : failed === "device_ended"
              ? "마이크 연결이 끊겼어요."
              : "업로드에 실패했어요."}{" "}
          지금까지 녹음된 내용은 남아 있어요.
        </span>
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto shrink-0"
          loading={stopping}
          disabled={stopping}
          onClick={onStop}
        >
          {stopping ? "종료 중…" : "종료"}
        </Button>
      </div>
    );
  }

  if (stale) {
    return (
      <div
        role="alert"
        className="flex items-center gap-2.5 border-b border-[color:var(--red-9)] bg-[var(--red-bg)] px-7 py-2.5 text-sm"
      >
        <Icon
          name="mic"
          size={15}
          className="shrink-0 text-[color:var(--red-text)]"
        />
        <span className="font-semibold text-[color:var(--red-text)]">
          워커 신호가 끊겼어요
        </span>
        <span className="text-[color:var(--text-secondary)]">
          녹음 파일은 디스크에 남아 있어요. 지금 취소하면 파일을 그대로 둔 채
          회의를 닫고, 재처리로 그 파일을 처리할 수 있어요.
        </span>
        {/* 여기서 '종료'를 부르면 안 된다 — stop은 job에 stop_requested_at을 찍고
            워커가 읽어 주기를 기다리는 신호인데, 그 워커가 없어서 이 상태다.
            회의는 reaper의 stale 창(30분)까지 recording으로 남고, 그동안
            meeting_single_recording_idx가 새 녹음을 막는다. cancel은 워커 없이
            job과 회의를 그 자리에서 닫는다 (설계 §2.5, §8의 'API cancel' 행). */}
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto shrink-0"
          loading={cancelling}
          disabled={cancelling}
          onClick={onCancel}
        >
          {cancelling ? "취소 중…" : "녹음 취소"}
        </Button>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-label="녹음 상태"
      aria-busy="true"
      className="flex items-center gap-2.5 border-b border-[color:var(--accent-6)] bg-[var(--accent-1)] px-7 py-2.5 text-sm"
    >
      <span
        aria-hidden="true"
        className={
          queued
            ? "size-2.5 shrink-0 rounded-full bg-[var(--text-faint)]"
            : "size-2.5 shrink-0 animate-pulse rounded-full bg-[var(--red-9)]"
        }
      />
      <span className="font-semibold text-[color:var(--accent-text)]">
        {queued ? "워커를 기다리는 중" : "녹음 중"}
      </span>
      <span className="text-[color:var(--text-secondary)]">
        {queued
          ? "브라우저가 녹음하고 있어요. 워커가 붙으면 발화가 흘러와요."
          : formatClock(elapsed)}
      </span>
      {!queued && backlogMs > BACKLOG_WARN_MS ? (
        <span className="text-[color:var(--red-text)]">
          업로드가 밀리고 있어요
        </span>
      ) : null}
      <Button
        variant="secondary"
        size="sm"
        className="ml-auto shrink-0"
        loading={stopping}
        disabled={stopping}
        onClick={onStop}
      >
        {stopping ? "종료 중…" : queued ? "취소" : "종료"}
      </Button>
    </div>
  );
}

/**
 * 캡처 이력 문구. 전부 "이 녹음을 어떻게 얻었는가"를 말하고, 하나같이 "그래도 여기까지는
 * 남아 있다"로 끝난다 — 이 배너가 뜨는 시점엔 이미 정본이 저장돼 있고 최종 처리도 보통
 * 성공한다. 사용자가 알아야 하는 건 실패 자체가 아니라 **녹음이 예상보다 짧을 수 있다**는
 * 것이다.
 *
 * 코드는 두 곳에서 온다 — 서버가 스스로 붙이는 것(producer_abandoned, capture_gap)과
 * 브라우저가 stop의 X-Capture-Error로 실어 보내는 것(device_ended, buffer_overflow,
 * upload_failed, capture_failed). `live.service.ts`의 CAPTURE_FAILURES와 같은 집합이다.
 */
const CAPTURE_ERROR_MESSAGE: Record<string, string> = {
  producer_abandoned: "브라우저 연결이 끊겨 여기까지 녹음됐어요.",
  device_ended: "마이크 연결이 끊겨 여기까지 녹음됐어요.",
  buffer_overflow: "업로드가 너무 밀려 여기까지만 녹음됐어요.",
  upload_failed: "업로드가 거절돼 여기까지만 녹음됐어요.",
  capture_failed: "녹음이 중간에 멈춰 여기까지만 녹음됐어요.",
  capture_gap: "녹음 중 일부 구간이 기록되지 않았어요.",
  preview_worker_lost: "실시간 자막 서버가 끊겨 자막 없이 녹음됐어요. 녹음 자체는 온전해요.",
};

/**
 * 캡처 이력 알림 — meeting.captureError. error(회의 처리 실패)와는 별개 필드라
 * 최종 처리가 성공해 회의가 done이 된 뒤에도 계속 보여야 한다(그것이 두 필드를
 * 나눈 이유다).
 */
export function CaptureErrorNotice({
  error,
}: {
  error: JsonError | null | undefined;
}) {
  const message = error?.code ? CAPTURE_ERROR_MESSAGE[error.code] : undefined;
  if (!message) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2.5 border-b border-[color:var(--border-subtle)] bg-[var(--surface-panel)] px-7 py-2.5 text-sm"
    >
      <Icon
        name="mic"
        size={15}
        className="shrink-0 text-[color:var(--text-faint)]"
      />
      <span className="text-[color:var(--text-secondary)]">{message}</span>
    </div>
  );
}
