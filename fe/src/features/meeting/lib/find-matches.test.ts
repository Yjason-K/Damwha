import { describe, expect, it } from "vitest";

import type { UtteranceEntry } from "../model/types";
import { findMatches, foldCase } from "./find-matches";

function utt(over: Partial<UtteranceEntry> = {}): UtteranceEntry {
  const id = over.id ?? "u1";
  return {
    id,
    spk: 1,
    t: "00:00",
    text: "",
    status: "ok",
    sources: [{ id, startMs: 0, endMs: 1_000, text: over.text ?? "" }],
    ...over,
  };
}

describe("foldCase", () => {
  it("ASCII 영문을 소문자로 접는다", () => {
    expect(foldCase("Odysseus")).toBe("odysseus");
  });

  it("한글·ASCII 혼합에서 길이를 보존한다", () => {
    const s = "오디세우스 Lotus 이야기";
    expect(foldCase(s)).toHaveLength(s.length);
  });

  it("폴딩이 길이를 바꾸는 문자(U+0130)에서도 길이를 보존한다", () => {
    // "İstanbul".toLowerCase()는 9자가 된다 — 그대로 쓰면 오프셋이 밀린다.
    const s = "İstanbul";
    expect(s.toLowerCase()).toHaveLength(9);
    expect(foldCase(s)).toHaveLength(8);
  });

  it("서로게이트 페어(이모지)에서도 길이를 보존한다", () => {
    const s = "a\u{1F600}B";
    expect(foldCase(s)).toHaveLength(s.length);
  });
});

describe("findMatches", () => {
  it("빈 질의는 빈 배열", () => {
    expect(findMatches([utt({ text: "로터스" })], "")).toEqual([]);
    expect(findMatches([utt({ text: "로터스" })], "   ")).toEqual([]);
  });

  it("한 발화 안의 모든 출현을 오프셋 순으로 찾는다", () => {
    const u = utt({ text: "로터스와 로터스" });
    expect(findMatches([u], "로터스")).toEqual([
      { uid: "u1", start: 0, end: 3 },
      { uid: "u1", start: 5, end: 8 },
    ]);
  });

  it("대소문자를 무시한다", () => {
    const u = utt({ text: "the Lotus eaters" });
    expect(findMatches([u], "LOTUS")).toEqual([
      { uid: "u1", start: 4, end: 9 },
    ]);
  });

  it("오프셋이 원문 인덱스를 가리킨다 (길이 변하는 폴딩 회귀)", () => {
    // 순진하게 toLowerCase()를 쓰면 İ가 2자로 늘어 오프셋이 1 밀린다.
    const text = "İstanbul 로터스 lotus";
    const [m] = findMatches([utt({ text })], "lotus");
    expect(text.slice(m.start, m.end)).toBe("lotus");
  });

  it("전사 실패 발화는 건너뛴다", () => {
    const failed = utt({ id: "u2", text: "구간", status: "transcribe_failed" });
    expect(findMatches([failed], "구간")).toEqual([]);
  });

  it("여러 발화를 배열 순서대로 이어붙인다", () => {
    const a = utt({ id: "a", text: "로터스" });
    const b = utt({ id: "b", text: "또 로터스" });
    expect(findMatches([a, b], "로터스")).toEqual([
      { uid: "a", start: 0, end: 3 },
      { uid: "b", start: 2, end: 5 },
    ]);
  });
});
