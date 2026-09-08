import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { readTourState } from "./tour-state";
import {
  SIM_TOTAL_MS,
  resetSimulation,
  simulationPhase,
  simulationView,
  startUploadSimulation,
  subscribeSimulation,
} from "./upload-simulation";

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  resetSimulation();
});
afterEach(() => {
  vi.useRealTimers();
});

function qc() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  return { client, invalidate };
}

test("시작하면 uploaded=true를 저장하고 queued에서 시작한다", () => {
  const { client, invalidate } = qc();
  startUploadSimulation("mtg_7", client);
  expect(readTourState().uploaded).toBe(true);
  expect(simulationPhase()).toBe("running");
  expect(simulationView()).toEqual({ meetingId: "mtg_7", stage: "queued", progress: 0 });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["meetings"] });
});

test("stage가 전진해도 progress는 전체 기준으로 한 번만 올라간다", () => {
  const { client } = qc();
  startUploadSimulation("mtg_7", client);
  vi.advanceTimersByTime(2_500);
  expect(simulationView()).toMatchObject({ stage: "vad", progress: 15 });
  vi.advanceTimersByTime(3_500); // t=6s
  expect(simulationView()).toMatchObject({ stage: "diarize", progress: 35 });
  vi.advanceTimersByTime(3_500); // t=9.5s
  expect(simulationView()).toMatchObject({ stage: "identify", progress: 50 });
  vi.advanceTimersByTime(5_000); // t=14.5s — stt(12~17s)의 절반
  expect(simulationView()).toMatchObject({ stage: "stt", progress: 83 }); // 75→90을 채운다
  vi.advanceTimersByTime(7_500); // t=22s
  expect(simulationView()).toMatchObject({ stage: "embed", progress: 98 });
});

test("전환마다 구독자와 네 쿼리 키를 알리고, 24초에 done이 된다", () => {
  const { client, invalidate } = qc();
  const cb = vi.fn();
  subscribeSimulation(cb);
  startUploadSimulation("mtg_7", client);
  invalidate.mockClear();
  vi.advanceTimersByTime(SIM_TOTAL_MS);
  expect(simulationPhase()).toBe("done");
  expect(simulationView()).toBeNull();
  // queued→vad→diarize→identify→stt→align→persist→embed→done = 8 transitions
  expect(cb).toHaveBeenCalledTimes(8);
  expect(cb).toHaveBeenLastCalledWith(null, "done");
  const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
  expect(keys).toContain(JSON.stringify(["meeting-status", "mtg_7"]));
  expect(keys).toContain(JSON.stringify(["meeting", "mtg_7"]));
  // done 전엔 인터셉터가 렌즈를 빈 queued로 덮으므로, 끝날 때 다시 읽어야 진짜 렌즈가 뜬다
  expect(keys).toContain(JSON.stringify(["meeting-lenses", "mtg_7"]));
  expect(keys).toContain(JSON.stringify(["meetings"]));
});

test("다시 시작하면 이전 타이머를 버리고 처음부터 돈다", () => {
  const { client } = qc();
  startUploadSimulation("mtg_7", client);
  vi.advanceTimersByTime(13_000);
  expect(simulationView()?.stage).toBe("stt");
  startUploadSimulation("mtg_7", client);
  expect(simulationView()?.stage).toBe("queued");
  vi.advanceTimersByTime(13_000);
  expect(simulationView()?.stage).toBe("stt"); // 옛 타이머가 살아 있었다면 이미 done
  expect(simulationPhase()).toBe("running");
});

test("구독 해지 후에는 알림을 받지 않는다", () => {
  const { client } = qc();
  const cb = vi.fn();
  const off = subscribeSimulation(cb);
  startUploadSimulation("mtg_7", client);
  off();
  vi.advanceTimersByTime(SIM_TOTAL_MS);
  expect(cb).not.toHaveBeenCalled();
});
