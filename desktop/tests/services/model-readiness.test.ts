import { describe, expect, it } from "vitest";
import {
  downloadInProgress,
  parseModelReadiness,
  STALL_MS,
  type ReadinessEntry,
} from "../../src/services/model-readiness";

/** worker가 쓰는 고정 정밀도 UTC 문자열 (db/core.py의 `_ISO_FORMAT`). */
function iso(ms: number): string {
  return new Date(ms).toISOString().replace("Z", "000Z");
}

function row(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    state: "downloading",
    bytes_done: 100,
    bytes_total: 200,
    writer: "embed",
    attempt: 1,
    started_at: iso(1_000),
    updated_at: iso(2_000),
    error: null,
    error_kind: null,
    ...over,
  };
}

function entry(over: Partial<ReadinessEntry> = {}): ReadinessEntry {
  return {
    key: "BAAI/bge-m3",
    state: "downloading",
    bytesDone: 100,
    bytesTotal: 200,
    startedAt: 1_000,
    updatedAt: 2_000,
    writer: "embed",
    attempt: 1,
    error: null,
    errorKind: null,
    ...over,
  };
}

describe("parseModelReadiness", () => {
  it("turns the worker's snake_case row into the camelCase contract, ISO into ms", () => {
    const out = parseModelReadiness({
      updated_at: iso(2_000),
      entries: { "BAAI/bge-m3": row() },
    });
    expect(out).toEqual([entry()]);
  });

  it("accepts the reader's raw text — psql hands back the jsonb as a string", () => {
    const text = JSON.stringify({ updated_at: iso(2_000), entries: { "BAAI/bge-m3": row() } });
    expect(parseModelReadiness(text)).toEqual([entry()]);
  });

  it("keeps microsecond timestamps to the millisecond", () => {
    const out = parseModelReadiness({
      entries: { m: row({ updated_at: "2026-09-18T01:02:03.456789Z" }) },
    });
    expect(out[0].updatedAt).toBe(Date.parse("2026-09-18T01:02:03.456Z"));
  });

  it("answers with an empty list for anything that is not the contract's shape", () => {
    for (const bad of [null, undefined, 3, "not json", "", [], { entries: 7 }, { entries: [] }]) {
      expect(parseModelReadiness(bad)).toEqual([]);
    }
  });

  it("drops an entry that is not an object or has an unknown state, and keeps the rest", () => {
    const out = parseModelReadiness({
      entries: { a: row(), b: 7, c: row({ state: "paused" }), d: row({ state: "ready" }) },
    });
    expect(out.map((e) => [e.key, e.state])).toEqual([
      ["a", "downloading"],
      ["d", "ready"],
    ]);
  });

  it("coerces missing or wrong-typed fields instead of throwing", () => {
    const out = parseModelReadiness({
      entries: { m: { state: "failed", bytes_done: "x", updated_at: 5, error_kind: "WEIRD" } },
    });
    expect(out).toEqual([
      {
        key: "m",
        state: "failed",
        bytesDone: 0,
        bytesTotal: 0,
        startedAt: 0,
        updatedAt: 0,
        writer: "",
        attempt: 1,
        error: null,
        errorKind: null,
      },
    ]);
  });

  it("carries a real failure's error and kind through", () => {
    const out = parseModelReadiness({
      entries: { m: row({ state: "failed", error: "hf_403: gated", error_kind: "PERMANENT" }) },
    });
    expect(out[0]).toMatchObject({ error: "hf_403: gated", errorKind: "PERMANENT" });
  });
});

describe("downloadInProgress", () => {
  // 스펙 §6.9 — "진행이 갱신되고 있으면 유예를 소모하지 않고, 무진행 120초면 실패로 본다."
  const now = 1_000_000;

  it("is the spec's 120s", () => {
    expect(STALL_MS).toBe(120_000);
  });

  it("says yes while the progress is being updated", () => {
    const e = [entry({ updatedAt: now - 3_000 })];
    expect(downloadInProgress(e, "embed", now, STALL_MS)).toBe(true);
  });

  it("says no once the progress has stood still for the stall limit", () => {
    const e = [entry({ updatedAt: now - STALL_MS - 1 })];
    expect(downloadInProgress(e, "embed", now, STALL_MS)).toBe(false);
  });

  it("says no when nothing is downloading", () => {
    const e = [entry({ state: "ready", updatedAt: now }), entry({ state: "failed", updatedAt: now })];
    expect(downloadInProgress(e, "embed", now, STALL_MS)).toBe(false);
  });

  it("says no for another writer's download — it must not stop this service's clock", () => {
    // embed가 죽어 가는 동안 worker가 whisper를 받고 있으면 embed의 유예가 영영 안 끝난다.
    const e = [entry({ writer: "desktop-1111", updatedAt: now })];
    expect(downloadInProgress(e, "embed", now, STALL_MS)).toBe(false);
    expect(downloadInProgress(e, "desktop-1111", now, STALL_MS)).toBe(true);
  });

  it("says yes for a download whose total is unknown — the judgment is updatedAt, not bytesDone", () => {
    const e = [entry({ bytesDone: 0, bytesTotal: 0, updatedAt: now - 500 })];
    expect(downloadInProgress(e, "embed", now, STALL_MS)).toBe(true);
  });

  it("says no when an unreadable timestamp left the entry at 0", () => {
    const e = parseModelReadiness({ entries: { m: row({ updated_at: null, writer: "embed" }) } });
    expect(downloadInProgress(e, "embed", now, STALL_MS)).toBe(false);
  });
});
