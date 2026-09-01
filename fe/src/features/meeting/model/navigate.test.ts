import { expect, test } from "vitest";

import {
  adjacentUtterance,
  currentUtterance,
} from "@/features/meeting/model/navigate";
import type { UtteranceEntry } from "@/features/meeting/model/types";

/** 현재 재생 시각 기준 이전/다음 발언 블록 계산. 기준은 블록 첫 원본의 startMs. */

function entry(
  id: string,
  startMs: number,
  more: number[] = [],
): UtteranceEntry {
  return {
    id,
    spk: 1,
    t: "00:00",
    text: id,
    status: "ok",
    sources: [
      { id, startMs, endMs: startMs + 1_000, text: id },
      ...more.map((ms, i) => ({
        id: `${id}_${i}`,
        startMs: ms,
        endMs: ms + 1_000,
        text: id,
      })),
    ],
  };
}

const U = [entry("a", 0), entry("b", 5_000, [12_000]), entry("c", 20_000)];

test("next는 현재 시각보다 뒤에 시작하는 첫 블록", () => {
  expect(adjacentUtterance(U, 6_000, "next")).toBe("c");
  expect(adjacentUtterance(U, 0, "next")).toBe("b");
});

test("next는 마지막 블록 이후면 null", () => {
  expect(adjacentUtterance(U, 20_000, "next")).toBeNull();
});

test("prev는 현재 블록 시작 1.5초 이내면 이전 블록", () => {
  expect(adjacentUtterance(U, 6_000, "prev")).toBe("a");
});

test("prev는 현재 블록 시작 1.5초 이후면 현재 블록 처음", () => {
  expect(adjacentUtterance(U, 13_000, "prev")).toBe("b");
});

test("prev는 첫 블록 시작 직후면 null", () => {
  expect(adjacentUtterance(U, 500, "prev")).toBeNull();
});

test("정렬되지 않은 입력도 startMs 순으로 본다", () => {
  const shuffled = [U[2], U[0], U[1]];
  expect(adjacentUtterance(shuffled, 0, "next")).toBe("b");
});

test("빈 목록은 null", () => {
  expect(adjacentUtterance([], 0, "next")).toBeNull();
});

test("currentUtterance는 현재 시각 이전에 시작한 마지막 블록", () => {
  expect(currentUtterance(U, 0)).toBe("a");
  expect(currentUtterance(U, 13_000)).toBe("b");
  expect(currentUtterance(U, 99_000)).toBe("c");
});

test("currentUtterance는 첫 블록 전이면 null", () => {
  expect(currentUtterance([entry("z", 1_000)], 0)).toBeNull();
});
