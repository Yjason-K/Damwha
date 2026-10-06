import { afterEach, expect, test, vi } from "vitest";

import {
  RECENT_MEETINGS_KEY,
  RECENT_MEETINGS_LIMIT,
  recentMeetings,
} from "./recent-meetings";

afterEach(() => localStorage.clear());

test("연 회의를 맨 앞에 올리고, 다시 열면 중복 없이 앞으로 옮긴다", () => {
  recentMeetings.visit("m1");
  recentMeetings.visit("m2");
  recentMeetings.visit("m1");
  expect(recentMeetings.getSnapshot()).toEqual(["m1", "m2"]);
  expect(JSON.parse(localStorage.getItem(RECENT_MEETINGS_KEY)!)).toEqual([
    "m1",
    "m2",
  ]);
});

test(`최대 ${RECENT_MEETINGS_LIMIT}개까지만 남긴다`, () => {
  for (let i = 1; i <= RECENT_MEETINGS_LIMIT + 3; i++)
    recentMeetings.visit(`m${i}`);
  const ids = recentMeetings.getSnapshot();
  expect(ids).toHaveLength(RECENT_MEETINGS_LIMIT);
  expect(ids[0]).toBe(`m${RECENT_MEETINGS_LIMIT + 3}`);
  expect(ids).not.toContain("m1");
});

test("remove는 그 회의만 지우고 구독자에게 알린다", () => {
  recentMeetings.visit("m1");
  recentMeetings.visit("m2");
  const listener = vi.fn();
  const unsubscribe = recentMeetings.subscribe(listener);
  recentMeetings.remove("m1");
  expect(recentMeetings.getSnapshot()).toEqual(["m2"]);
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
});

test("스냅샷은 바뀌지 않으면 같은 참조를 돌려준다", () => {
  recentMeetings.visit("m1");
  expect(recentMeetings.getSnapshot()).toBe(recentMeetings.getSnapshot());
});

test("깨진 저장값은 빈 목록으로 본다", () => {
  localStorage.setItem(RECENT_MEETINGS_KEY, "{not json");
  expect(recentMeetings.getSnapshot()).toEqual([]);
  localStorage.setItem(RECENT_MEETINGS_KEY, JSON.stringify([1, "m1", null]));
  expect(recentMeetings.getSnapshot()).toEqual(["m1"]);
});
