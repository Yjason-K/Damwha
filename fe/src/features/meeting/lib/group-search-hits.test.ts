import { expect, test } from "vitest";

import type { SearchHit } from "../api/search";
import { groupSearchHits } from "./group-search-hits";

const hit = (
  meetingId: string,
  utteranceId: string,
  text: string,
): SearchHit => ({
  meetingId,
  utteranceId,
  text,
  meetingTitle: `회의 ${meetingId}`,
  startMs: 0,
  speakerName: null,
});

test("내용이 같은 회의 3건의 같은 문장은 한 번만 남고 나머지는 alsoIn으로 센다", () => {
  const groups = groupSearchHits([
    hit("mtg_1", "utt_1", "설득은 결국 신뢰다"),
    hit("mtg_2", "utt_9", "설득은  결국 신뢰다 "),
    hit("mtg_3", "utt_5", "설득은 결국 신뢰다"),
    hit("mtg_2", "utt_10", "설득하려면 먼저 듣는다"),
  ]);
  expect(groups.map((g) => g.meetingId)).toEqual(["mtg_1", "mtg_2"]);
  expect(groups[0].hits).toEqual([
    expect.objectContaining({ utteranceId: "utt_1", alsoIn: 2 }),
  ]);
  expect(groups[1].hits.map((h) => h.utteranceId)).toEqual(["utt_10"]);
});

test("전사가 끝을 조금 다르게 자른 같은 발언도 접고, 짧은 말은 포함만으로 접지 않는다", () => {
  const groups = groupSearchHits([
    hit(
      "mtg_41",
      "a",
      "판사들 설득해야 되는 일을 하니까 말이 너무 지쳐 있어요.",
    ),
    hit(
      "mtg_25",
      "b",
      "판사들 설득해야 되는 일을 하니까 말이 너무 지쳐 있어요. 요점만",
    ),
    hit("mtg_25", "c", "설득"),
    hit("mtg_26", "d", "설득이란 결국 무엇인가"),
  ]);
  expect(
    groups.map((g) => [
      g.meetingId,
      g.hits.map((h) => [h.utteranceId, h.alsoIn]),
    ]),
  ).toEqual([
    ["mtg_41", [["a", 1]]],
    ["mtg_25", [["c", 0]]],
    ["mtg_26", [["d", 0]]],
  ]);
});

test("회의 안에서는 순위 순서를 지키고 회의당·회의 수 상한을 지킨다", () => {
  const groups = groupSearchHits(
    [
      hit("mtg_1", "a", "하나"),
      hit("mtg_2", "b", "둘"),
      hit("mtg_1", "c", "셋"),
      hit("mtg_1", "d", "넷"),
      hit("mtg_3", "e", "다섯"),
    ],
    { maxMeetings: 2, perMeeting: 2 },
  );
  expect(
    groups.map((g) => [g.meetingId, g.hits.map((h) => h.utteranceId)]),
  ).toEqual([
    ["mtg_1", ["a", "c"]],
    ["mtg_2", ["b"]],
  ]);
});
