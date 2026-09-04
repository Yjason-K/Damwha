import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  TOUR_STORAGE_KEY,
  readTourState,
  subscribeTourState,
  writeTourState,
} from "./tour-state";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

test("저장된 것이 없으면 둘 다 false다", () => {
  expect(readTourState()).toEqual({ uploaded: false, noticeSeen: false });
});

test("patch로 일부만 바꾸고 나머지는 유지한다", () => {
  writeTourState({ noticeSeen: true });
  writeTourState({ uploaded: true });
  expect(readTourState()).toEqual({ uploaded: true, noticeSeen: true });
  expect(JSON.parse(localStorage.getItem(TOUR_STORAGE_KEY)!)).toEqual({
    uploaded: true,
    noticeSeen: true,
  });
});

test("깨진 JSON이나 읽기 실패는 기본값으로 떨어진다", () => {
  localStorage.setItem(TOUR_STORAGE_KEY, "{not json");
  expect(readTourState()).toEqual({ uploaded: false, noticeSeen: false });

  const original = Storage.prototype.getItem;
  Storage.prototype.getItem = () => {
    throw new Error("blocked");
  };
  try {
    expect(readTourState()).toEqual({ uploaded: false, noticeSeen: false });
  } finally {
    Storage.prototype.getItem = original;
  }
});

test("쓰기 실패는 예외를 던지지 않고 구독자에게는 알린다", () => {
  const cb = vi.fn();
  subscribeTourState(cb);
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = () => {
    throw new Error("quota");
  };
  try {
    expect(() => writeTourState({ uploaded: true })).not.toThrow();
  } finally {
    Storage.prototype.setItem = original;
  }
  expect(cb).toHaveBeenCalledTimes(1);
});

test("구독자는 쓰기마다 새 상태를 받고, 해지하면 더 받지 않는다", () => {
  const cb = vi.fn();
  const off = subscribeTourState(cb);
  writeTourState({ uploaded: true });
  expect(cb).toHaveBeenLastCalledWith({ uploaded: true, noticeSeen: false });
  off();
  writeTourState({ noticeSeen: true });
  expect(cb).toHaveBeenCalledTimes(1);
});
