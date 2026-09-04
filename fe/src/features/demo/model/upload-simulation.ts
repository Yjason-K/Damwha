import type { QueryClient } from "@tanstack/react-query";

import { writeTourState } from "./tour-state";

/**
 * 가짜 업로드 파이프라인(투어 설계 §4.1). 워커 없이 브라우저 타이머로 stage를 전진시키고,
 * 전환마다 회의 쿼리를 invalidate해 폴링 주기(2초)를 기다리지 않게 한다. 실제 응답 가공은
 * demo-tour-interceptor가 simulationView()를 읽어서 한다.
 */
export type SimStage =
  | "queued"
  | "vad"
  | "diarize"
  | "identify"
  | "stt"
  | "align"
  | "persist"
  | "embed";

/** 각 stage의 시작 시각(ms). 마지막 stage는 SIM_TOTAL_MS에서 끝난다. */
export const STAGE_TIMELINE: readonly [SimStage, number][] = [
  ["queued", 0],
  ["vad", 1_000],
  ["diarize", 3_000],
  ["identify", 5_000],
  ["stt", 6_000],
  ["align", 9_000],
  ["persist", 10_000],
  ["embed", 11_000],
];
export const SIM_TOTAL_MS = 12_000;

export type SimView = { meetingId: string; stage: SimStage; progress: number };
export type SimPhase = "idle" | "running" | "done";
type Listener = (view: SimView | null, phase: SimPhase) => void;

type State =
  | { phase: "idle" }
  | { phase: "running"; meetingId: string; startedAt: number }
  | { phase: "done"; meetingId: string };

let state: State = { phase: "idle" };
let timers: ReturnType<typeof setTimeout>[] = [];
const listeners = new Set<Listener>();

function stageAt(elapsed: number): { stage: SimStage; progress: number } {
  let idx = 0;
  for (let i = 0; i < STAGE_TIMELINE.length; i++) {
    if (elapsed >= STAGE_TIMELINE[i][1]) idx = i;
  }
  const [stage, start] = STAGE_TIMELINE[idx];
  const end = idx + 1 < STAGE_TIMELINE.length ? STAGE_TIMELINE[idx + 1][1] : SIM_TOTAL_MS;
  const progress = Math.min(1, Math.max(0, (elapsed - start) / (end - start)));
  return { stage, progress };
}

export function simulationView(now = Date.now()): SimView | null {
  if (state.phase !== "running") return null;
  const { stage, progress } = stageAt(now - state.startedAt);
  return { meetingId: state.meetingId, stage, progress };
}

export function simulationPhase(): SimPhase {
  return state.phase;
}

export function subscribeSimulation(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notify() {
  const view = simulationView();
  for (const cb of listeners) cb(view, state.phase);
}

function invalidate(qc: QueryClient, meetingId: string) {
  void qc.invalidateQueries({ queryKey: ["meeting-status", meetingId] });
  void qc.invalidateQueries({ queryKey: ["meeting", meetingId] });
  void qc.invalidateQueries({ queryKey: ["meetings"] });
}

function clearTimers() {
  for (const t of timers) clearTimeout(t);
  timers = [];
}

export function resetSimulation(): void {
  clearTimers();
  state = { phase: "idle" };
}

export function startUploadSimulation(meetingId: string, qc: QueryClient): void {
  clearTimers();
  state = { phase: "running", meetingId, startedAt: Date.now() };
  // 회의가 목록에 "uploaded" 상태로 등장하게 — 인터셉터의 숨김 필터가 풀린다.
  writeTourState({ uploaded: true });
  invalidate(qc, meetingId);

  for (const [, at] of STAGE_TIMELINE.slice(1)) {
    timers.push(
      setTimeout(() => {
        invalidate(qc, meetingId);
        notify();
      }, at),
    );
  }
  timers.push(
    setTimeout(() => {
      state = { phase: "done", meetingId };
      timers = [];
      invalidate(qc, meetingId);
      notify();
    }, SIM_TOTAL_MS),
  );
}
