import { expect, test } from "vitest";
import { mapItemView } from "./map-item";
import type { LensWireItem } from "../model/types";

const base: LensWireItem = {
  id: "lens_1",
  kind: "action",
  text: "문서 작성",
  source: "ai",
  user_modified: false,
  completion_status: "open",
  lifecycle_status: "active",
  meeting_id: "mtg_1",
  assignee_speaker_id: null,
  due_at: null,
  created_at: "",
  updated_at: "",
  meeting: { id: "mtg_1", title: "회의" },
  evidence: [],
};

test("primary 근거가 있으면 timecode와 primary를 만든다", () => {
  const v = mapItemView({
    ...base,
    evidence: [
      {
        relation: "primary",
        utterance: {
          id: "utt_9",
          start_ms: 65000,
          text: "x",
          speaker_id: null,
        },
      },
    ],
  });
  expect(v.source).toBe("ai");
  expect(v.primary).toEqual({ utteranceId: "utt_9", startMs: 65000 });
  expect(v.timecode).toBe("01:05");
});

test("AI 출처인데 primary 근거가 없으면 hint(확인 필요)", () => {
  const v = mapItemView({ ...base, source: "ai", evidence: [] });
  expect(v.source).toBe("hint");
  expect(v.primary).toBeNull();
  expect(v.timecode).toBeNull();
});

test("사용자 출처는 근거 없어도 hint가 아니다", () => {
  const v = mapItemView({ ...base, source: "user", evidence: [] });
  expect(v.source).toBe("user");
});
