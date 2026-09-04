import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

import { buildTourSteps, stageNarration } from "./tour-steps";
import { STAGE_TIMELINE } from "../model/upload-simulation";

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(readFileSync(p, "utf8"));
  }
  return out;
}

const SRC = sources(join(__dirname, "../../../"));

test("모든 단계의 data-tour 타깃이 소스에 실제로 존재한다", () => {
  const steps = buildTourSteps({ navigate: () => {}, searchQuery: "x", hasUpload: true, suppressExit: (fn) => fn() });
  for (const s of steps) {
    const needle = `data-tour="${s.target}"`;
    const dynamic = `"data-tour": "${s.target}"`;
    expect(
      SRC.some((src) => src.includes(needle) || src.includes(dynamic)),
      `${s.id}: ${needle}`,
    ).toBe(true);
  }
});

test("업로드 회의가 없으면 업로드 관련 단계가 빠지고 순서는 유지된다", () => {
  const withUpload = buildTourSteps({ navigate: () => {}, searchQuery: "", hasUpload: true, suppressExit: (fn) => fn() }).map((s) => s.id);
  const without = buildTourSteps({ navigate: () => {}, searchQuery: "", hasUpload: false, suppressExit: (fn) => fn() }).map((s) => s.id);
  expect(withUpload).toEqual([
    "list", "new", "upload", "processing", "utterance", "player", "summary", "lens", "search", "note",
  ]);
  expect(without).toEqual(["list", "utterance", "player", "summary", "lens", "search", "note"]);
});

test("모든 시뮬레이션 stage에 서술 문구가 있다", () => {
  for (const [stage] of STAGE_TIMELINE) {
    expect(stageNarration(stage).length).toBeGreaterThan(10);
  }
});
