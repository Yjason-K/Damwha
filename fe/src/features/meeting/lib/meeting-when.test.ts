import { expect, test } from "vitest";

import { dueDateLabel, meetingWhenLabel } from "./meeting-when";

const now = new Date(2026, 9, 4, 18, 0);
const iso = (...args: [number, number, number, number, number]) =>
  new Date(...args).toISOString();

test("오늘·어제는 시각까지, 올해는 날짜만, 다른 해는 연도를 붙인다", () => {
  expect(meetingWhenLabel(iso(2026, 9, 4, 14, 30), now)).toBe("오늘 14:30");
  expect(meetingWhenLabel(iso(2026, 9, 3, 9, 5), now)).toBe("어제 09:05");
  expect(meetingWhenLabel(iso(2026, 3, 2, 10, 0), now)).toBe("4월 2일");
  expect(meetingWhenLabel(iso(2025, 11, 31, 23, 0), now)).toBe(
    "2025년 12월 31일",
  );
});

test("어제 판정은 달이 바뀌어도 맞는다", () => {
  const first = new Date(2026, 10, 1, 9, 0);
  expect(meetingWhenLabel(iso(2026, 9, 31, 22, 15), first)).toBe("어제 22:15");
});

test("기한은 시간대를 타지 않고 M월 D일로 읽는다", () => {
  expect(dueDateLabel("2026-04-02")).toBe("4월 2일");
});
