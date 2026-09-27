import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// --text-muted(text-ink-3)는 라이트 바탕에서 3.31:1로 WCAG AA(본문 4.5:1)에 못 미친다(2026-09-27 계산).
// 그래서 사람이 읽어야 하는 글자에는 쓰지 않고, aria-hidden 장식(화살표·+)에만 남긴다(코덱스 리뷰 #5).
const dir = new URL("../src/components/", import.meta.url).pathname;

describe("명도 대비", () => {
  it("text-ink-3는 aria-hidden 장식에만 쓴다", () => {
    const offenders = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".astro"))) {
      readFileSync(join(dir, f), "utf8").split("\n").forEach((line, i) => {
        if (/\btext-ink-3\b/.test(line) && !/aria-hidden="true"/.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
