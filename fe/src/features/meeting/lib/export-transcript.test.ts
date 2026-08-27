import { describe, expect, it } from "vitest";

import type { Meeting, SpeakerRef, UtteranceEntry } from "../model/types";
import {
  buildTranscriptExport,
  exportFilename,
  type ExportSource,
} from "./export-transcript";

function speaker(spk: number, name: string): SpeakerRef {
  return { id: `spk_${spk}`, name, role: "", spk };
}

/** 병합 블록 1개 — sources를 주지 않으면 블록 전체가 발화 1개인 셈으로 만든다. */
function block(
  over: Partial<UtteranceEntry> & { id: string; spk: number; text: string },
): UtteranceEntry {
  const startMs = over.sources?.[0]?.startMs ?? 0;
  return {
    t: "00:00",
    status: "ok",
    sources: [
      { id: over.id, startMs, endMs: startMs + 1_000, text: over.text },
    ],
    ...over,
  };
}

const source: ExportSource = {
  utterances: [
    block({
      id: "u1",
      spk: 1,
      t: "00:12",
      text: "안녕하세요 반갑습니다",
      sources: [
        { id: "u1", startMs: 12_340, endMs: 15_120, text: "안녕하세요" },
        { id: "u2", startMs: 15_500, endMs: 17_000, text: "반갑습니다" },
      ],
    }),
    block({
      id: "u3",
      spk: 2,
      t: "1:00:03",
      text: "시작하죠",
      sources: [
        { id: "u3", startMs: 3_603_000, endMs: 3_605_500, text: "시작하죠" },
      ],
    }),
  ],
  speakers: { 1: speaker(1, "김영재"), 2: speaker(2, "홍길동") },
};

describe("buildTranscriptExport — txt", () => {
  it("시간·화자 둘 다 켜면 [시각] 이름: 본문 꼴로 쓴다", () => {
    expect(
      buildTranscriptExport(source, "txt", {
        timestamps: true,
        speakers: true,
      }),
    ).toBe(
      "[00:12] 김영재: 안녕하세요 반갑습니다\n\n[1:00:03] 홍길동: 시작하죠\n",
    );
  });

  it("시간을 끄면 시각 표기만 빠진다", () => {
    expect(
      buildTranscriptExport(source, "txt", {
        timestamps: false,
        speakers: true,
      }),
    ).toBe("김영재: 안녕하세요 반갑습니다\n\n홍길동: 시작하죠\n");
  });

  it("화자를 끄면 이름 표기만 빠진다", () => {
    expect(
      buildTranscriptExport(source, "txt", {
        timestamps: true,
        speakers: false,
      }),
    ).toBe("[00:12] 안녕하세요 반갑습니다\n\n[1:00:03] 시작하죠\n");
  });

  it("둘 다 끄면 본문만 남는다", () => {
    expect(
      buildTranscriptExport(source, "txt", {
        timestamps: false,
        speakers: false,
      }),
    ).toBe("안녕하세요 반갑습니다\n\n시작하죠\n");
  });

  it("화자 레코드에 없는 spk는 '화자 N'으로 적는다", () => {
    const orphan: ExportSource = {
      utterances: [block({ id: "x1", spk: 7, text: "누구세요" })],
      speakers: {},
    };
    expect(
      buildTranscriptExport(orphan, "txt", {
        timestamps: false,
        speakers: true,
      }),
    ).toBe("화자 7: 누구세요\n");
  });

  it("본문이 빈 블록은 건너뛴다", () => {
    const withEmpty: ExportSource = {
      utterances: [
        block({ id: "e1", spk: 1, text: "" }),
        block({ id: "e2", spk: 1, text: "실제 발언" }),
      ],
      speakers: { 1: speaker(1, "김영재") },
    };
    expect(
      buildTranscriptExport(withEmpty, "txt", {
        timestamps: false,
        speakers: false,
      }),
    ).toBe("실제 발언\n");
  });

  it("발화가 없으면 빈 문자열이다", () => {
    expect(
      buildTranscriptExport({ utterances: [], speakers: {} }, "txt", {
        timestamps: true,
        speakers: true,
      }),
    ).toBe("");
  });
});

describe("buildTranscriptExport — srt", () => {
  it("병합 블록이 아니라 원본 발화 단위로 큐를 만든다", () => {
    expect(
      buildTranscriptExport(source, "srt", {
        timestamps: true,
        speakers: true,
      }),
    ).toBe(
      "1\n00:00:12,340 --> 00:00:15,120\n김영재: 안녕하세요\n\n" +
        "2\n00:00:15,500 --> 00:00:17,000\n김영재: 반갑습니다\n\n" +
        "3\n01:00:03,000 --> 01:00:05,500\n홍길동: 시작하죠\n",
    );
  });

  it("화자를 끄면 본문만 남고 번호·시각은 그대로다", () => {
    expect(
      buildTranscriptExport(source, "srt", {
        timestamps: true,
        speakers: false,
      }),
    ).toBe(
      "1\n00:00:12,340 --> 00:00:15,120\n안녕하세요\n\n" +
        "2\n00:00:15,500 --> 00:00:17,000\n반갑습니다\n\n" +
        "3\n01:00:03,000 --> 01:00:05,500\n시작하죠\n",
    );
  });

  it("시간 토글은 srt에서 무시한다 — 자막 규격상 시각이 필수다", () => {
    const on = buildTranscriptExport(source, "srt", {
      timestamps: true,
      speakers: true,
    });
    const off = buildTranscriptExport(source, "srt", {
      timestamps: false,
      speakers: true,
    });
    expect(off).toBe(on);
  });

  it("본문이 빈 발화는 건너뛰고 번호를 이어 붙인다", () => {
    const withEmpty: ExportSource = {
      utterances: [
        block({
          id: "e1",
          spk: 1,
          text: "앞 뒤",
          sources: [
            { id: "e1", startMs: 0, endMs: 1_000, text: "앞" },
            { id: "e2", startMs: 1_000, endMs: 2_000, text: "   " },
            { id: "e3", startMs: 2_000, endMs: 3_000, text: "뒤" },
          ],
        }),
      ],
      speakers: { 1: speaker(1, "김영재") },
    };
    expect(
      buildTranscriptExport(withEmpty, "srt", {
        timestamps: true,
        speakers: false,
      }),
    ).toBe(
      "1\n00:00:00,000 --> 00:00:01,000\n앞\n\n" +
        "2\n00:00:02,000 --> 00:00:03,000\n뒤\n",
    );
  });

  it("끝이 시작보다 이르거나 같으면 최소 1ms 길이를 준다", () => {
    const degenerate: ExportSource = {
      utterances: [
        block({
          id: "d1",
          spk: 1,
          text: "짧다",
          sources: [{ id: "d1", startMs: 5_000, endMs: 5_000, text: "짧다" }],
        }),
      ],
      speakers: { 1: speaker(1, "김영재") },
    };
    expect(
      buildTranscriptExport(degenerate, "srt", {
        timestamps: true,
        speakers: false,
      }),
    ).toBe("1\n00:00:05,000 --> 00:00:05,001\n짧다\n");
  });

  it("10시간을 넘어도 시 자리가 밀리지 않는다", () => {
    const long: ExportSource = {
      utterances: [
        block({
          id: "l1",
          spk: 1,
          text: "끝",
          sources: [
            { id: "l1", startMs: 36_000_000, endMs: 36_001_000, text: "끝" },
          ],
        }),
      ],
      speakers: { 1: speaker(1, "김영재") },
    };
    expect(
      buildTranscriptExport(long, "srt", {
        timestamps: true,
        speakers: false,
      }),
    ).toBe("1\n10:00:00,000 --> 10:00:01,000\n끝\n");
  });
});

describe("exportFilename", () => {
  const meta = (over: Partial<Pick<Meeting, "title" | "date">> = {}) => ({
    title: "9월 기획 회의",
    date: "2026-08-27",
    ...over,
  });

  it("제목과 날짜를 확장자와 함께 잇는다", () => {
    expect(exportFilename(meta(), "txt")).toBe("9월 기획 회의_2026-08-27.txt");
    expect(exportFilename(meta(), "srt")).toBe("9월 기획 회의_2026-08-27.srt");
  });

  it("파일명에 못 쓰는 문자를 밑줄로 바꾼다", () => {
    expect(exportFilename(meta({ title: 'a/b\\c:d*e?f"g<h>i|j' }), "txt")).toBe(
      "a_b_c_d_e_f_g_h_i_j_2026-08-27.txt",
    );
  });

  it("제목이 비면 '회의'로 대신한다", () => {
    expect(exportFilename(meta({ title: "   " }), "txt")).toBe(
      "회의_2026-08-27.txt",
    );
  });
});
