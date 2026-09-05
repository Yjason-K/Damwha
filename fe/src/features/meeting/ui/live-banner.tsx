import * as React from "react";

import { Button } from "@/shared/ui/button";

import { formatClock } from "../api/mappers";
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
}: LiveBannerProps) {
  const queued = stage === null;
  const nowMs = useTick(now, !queued);
  const stale = !queued && isHeartbeatStale(heartbeatAt, nowMs);
  const started = new Date(recordedAtIso).getTime();
  const elapsed = Number.isNaN(started) ? 0 : Math.max(0, nowMs - started);

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
          ? "워커가 마이크를 열면 녹음이 시작돼요."
          : formatClock(elapsed)}
      </span>
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
