import * as React from "react";

import { Button } from "@/shared/ui/button";

import { formatClock } from "../api/mappers";
import { Icon } from "./icons";

/**
 * LiveBanner — 녹음 중인 회의의 상단 배너. ProcessingBanner 자리에 선다.
 * 경과 시간은 워커가 첫 샘플 시각으로 찍은 recorded_at 기준이고, heartbeat(세션 job의
 * locked_at)가 30초 넘게 멈추면 "신호 끊김"으로 바뀐다 — reaper의 stale 창(30분)이
 * 닫히기 전까지 거짓 "녹음 중"을 보여주지 않기 위한 최소 장치다 (설계 §8).
 */

const STALE_MS = 30_000;

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
  stopping: boolean;
  /** 테스트용 시계. */
  now?: () => number;
};

export function LiveBanner({
  recordedAtIso,
  stage,
  heartbeatAt,
  onStop,
  stopping,
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
          녹음은 디스크에 남아 있어요. 워커가 돌아오지 않으면 잠시 뒤 실패로
          정리되고, 재처리로 그 파일을 처리할 수 있어요.
        </span>
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto shrink-0"
          disabled={stopping}
          onClick={onStop}
        >
          종료
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
