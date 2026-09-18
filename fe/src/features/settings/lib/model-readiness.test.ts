import { describe, expect, it } from "vitest";

import {
  MODEL_STALL_MS,
  downloadingNow,
  isDownloadingModel,
  modelProgressLabel,
  searchIsKeywordOnly,
} from "./model-readiness";
import type { ModelReadiness, ModelReadinessEntry } from "../api/types";

const NOW = Date.parse("2026-09-18T01:02:03.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const entry = (over: Partial<ModelReadinessEntry> = {}): ModelReadinessEntry => ({
  key: "BAAI/bge-m3",
  state: "downloading",
  bytesDone: 0,
  bytesTotal: 0,
  startedAt: iso(10_000),
  updatedAt: iso(1_000),
  writer: "embed",
  attempt: 1,
  error: null,
  errorKind: null,
  ...over,
});

const readiness = (entries: ModelReadinessEntry[]): ModelReadiness => ({
  updatedAt: iso(0),
  entries,
});

describe("isDownloadingModel", () => {
  it("진행이 갱신되고 있는 downloading만 '받는 중'이다", () => {
    expect(isDownloadingModel(entry(), NOW)).toBe(true);
    expect(isDownloadingModel(entry({ state: "ready" }), NOW)).toBe(false);
    expect(isDownloadingModel(entry({ state: "failed" }), NOW)).toBe(false);
  });

  it("무진행이 한계를 넘으면 더는 '받는 중'이 아니다 — 앱 상태 창과 같은 규칙", () => {
    expect(isDownloadingModel(entry({ updatedAt: iso(MODEL_STALL_MS) }), NOW)).toBe(true);
    expect(isDownloadingModel(entry({ updatedAt: iso(MODEL_STALL_MS + 1) }), NOW)).toBe(false);
  });

  it("시각을 읽을 수 없으면 '받는 중'으로 치지 않는다 — 유예를 늘리는 쪽으로 기울지 않는다", () => {
    expect(isDownloadingModel(entry({ updatedAt: null }), NOW)).toBe(false);
    expect(isDownloadingModel(entry({ updatedAt: "어제" }), NOW)).toBe(false);
  });
});

describe("searchIsKeywordOnly", () => {
  it("검색 임베딩 모델이 준비되지 않은 동안 참이다", () => {
    expect(searchIsKeywordOnly(readiness([entry()]))).toBe(true);
    expect(searchIsKeywordOnly(readiness([entry({ state: "failed" })]))).toBe(true);
  });

  it("준비됐으면 거짓이다", () => {
    expect(searchIsKeywordOnly(readiness([entry({ state: "ready" })]))).toBe(false);
  });

  it("행이 없으면 거짓이다 — 모르는 것을 '안 된다'로 말하지 않는다", () => {
    expect(searchIsKeywordOnly(readiness([]))).toBe(false);
    expect(searchIsKeywordOnly(undefined)).toBe(false);
  });

  it("다른 서비스가 받는 모델은 검색과 무관하다 — writer로 가른다", () => {
    const whisper = entry({ key: "mlx-community/whisper-large-v3", writer: "worker-1" });
    expect(searchIsKeywordOnly(readiness([whisper]))).toBe(false);
    expect(searchIsKeywordOnly(readiness([whisper, entry()]))).toBe(true);
  });
});

describe("downloadingNow", () => {
  it("지금 받는 중인 것만 돌려준다", () => {
    const list = downloadingNow(
      readiness([
        entry({ key: "a" }),
        entry({ key: "b", state: "ready" }),
        entry({ key: "c", updatedAt: iso(MODEL_STALL_MS + 1) }),
      ]),
      NOW,
    );
    expect(list.map((e) => e.key)).toEqual(["a"]);
  });

  it("행이 없으면 빈 목록이다", () => {
    expect(downloadingNow(undefined, NOW)).toEqual([]);
  });
});

describe("modelProgressLabel", () => {
  it("총량을 알면 퍼센트를 말한다", () => {
    expect(modelProgressLabel(entry({ bytesDone: 512, bytesTotal: 2048 }))).toBe(
      "BAAI/bge-m3 25%",
    );
  });

  it("총량을 모르면 퍼센트를 지어내지 않는다 (스펙 §6.9)", () => {
    expect(modelProgressLabel(entry({ bytesDone: 99, bytesTotal: 0 }))).toBe("BAAI/bge-m3");
  });

  it("퍼센트는 100을 넘지 않는다", () => {
    expect(modelProgressLabel(entry({ bytesDone: 4096, bytesTotal: 2048 }))).toBe(
      "BAAI/bge-m3 100%",
    );
  });
});
