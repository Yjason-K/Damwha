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

/**
 * 각 stage의 시작 시각(ms)과 그 시점의 **전체** 진행률(%). 진행률은 워커가 실제로 쓰는 값
 * 그대로다(`process_meeting.py`의 enter_stage: vad 15 · diarize 35 · identify 50 · stt 75 ·
 * align 90 · persist 95) — 그래서 배너의 %가 stage마다 0→100을 반복하지 않고 파이프라인
 * 전체에서 한 번만 올라간다. 마지막 stage는 SIM_TOTAL_MS에서 끝난다.
 *
 * 간격은 narration 한 줄을 읽을 시간(stage당 2.5초 이상)에 맞춰 잡았다.
 */
export const STAGE_TIMELINE: readonly [SimStage, number, number][] = [
  ["queued", 0, 0],
  ["vad", 2_500, 15],
  ["diarize", 6_000, 35],
  ["identify", 9_500, 50],
  ["stt", 12_000, 75],
  ["align", 17_000, 90],
  ["persist", 19_500, 95],
  ["embed", 22_000, 98],
];
export const SIM_TOTAL_MS = 24_000;

/** progress는 파이프라인 전체 기준 0~100 — 상태 API가 내려주는 값과 같은 눈금이다. */
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

/**
 * 워커는 stage에 들어갈 때 progress를 한 번 쓰고 그 안에서는 고정이다. 예외는 가장 긴 stt로,
 * clip마다 75→90 구간을 채운다(`pipeline/progress.py`). 데모도 같은 모양으로 움직인다 —
 * stt는 timeline상 마지막이 아니므로 다음 항목이 항상 있다.
 */
function stageAt(elapsed: number): { stage: SimStage; progress: number } {
  let idx = 0;
  for (let i = 0; i < STAGE_TIMELINE.length; i++) {
    if (elapsed >= STAGE_TIMELINE[i][1]) idx = i;
  }
  const [stage, start, progress] = STAGE_TIMELINE[idx];
  if (stage !== "stt") return { stage, progress };
  const [, end, next] = STAGE_TIMELINE[idx + 1];
  const ratio = Math.min(1, Math.max(0, (elapsed - start) / (end - start)));
  return { stage, progress: Math.round(progress + (next - progress) * ratio) };
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
  void qc.invalidateQueries({ queryKey: ["meeting-lenses", meetingId] });
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
