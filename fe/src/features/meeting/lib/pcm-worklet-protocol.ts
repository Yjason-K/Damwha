/**
 * Worklet 종료 프로토콜 (설계 §7). 메인 스레드와 Worklet이 같은 MessagePort로 주고받는
 * 메시지 타입만 담는다 — 둘 다 이 파일을 import해서 값을 복제하지 않는다.
 */

/** 메인 스레드 → Worklet. */
export type WorkletCommand = { type: "begin" } | { type: "flush" };

/** Worklet → 메인 스레드. */
export type WorkletEvent =
  | { type: "ready" }
  | { type: "begun" }
  | { type: "pcm"; pcm: ArrayBuffer }
  | { type: "flushed" };
