import { describe, expect, it } from "vitest";
import { ANSI_SGR, BLOCK_MAX_CHARS, exitCauseBlock, failureBlock, lastMeaningfulLine } from "../../src/diagnostics/stderr";

const RED = "\x1b[31m";
const RESET = "\x1b[39m";

describe("lastMeaningfulLine", () => {
  it("picks the startup-failed line, not the trailing bracket, from a multi-line zod error", () => {
    // be/src/main.ts: Logger.error(`startup failed: ${e.message}`) — e.message는
    // zod ZodError의 JSON.stringify pretty-print라 마지막 줄이 `]`뿐이다. 실측
    // (Fix round 1): be/dist/main.js에 SUMMARY_LLM_MODEL=not-in-the-catalog로
    // 재현한 실제 stderr 형태.
    const stderr = [
      `${RED}[Nest] 70201  - ${RESET}09/11/2026, 4:09:17 PM ${RED}  ERROR${RESET} [Bootstrap] ${RED}startup failed: [`,
      "  {",
      '    "received": "not-in-the-catalog",',
      '    "code": "invalid_enum_value",',
      '    "options": [',
      '      "mlx-community/Qwen3.5-4B-8bit"',
      "    ],",
      '    "path": [',
      '      "SUMMARY_LLM_MODEL"',
      "    ],",
      '    "message": "Invalid enum value. Expected \'mlx-community/Qwen3.5-4B-8bit\', received \'not-in-the-catalog\'"',
      "  }",
      `]${RESET}`,
      "",
    ].join("\n");

    const result = lastMeaningfulLine(stderr);
    expect(result).not.toBe("]");
    expect(result).toContain("startup failed:");
  });

  it("returns a single-line startup-failed message (database unreachable) verbatim", () => {
    const stderr =
      "[Nest] 12345  - 09/11/2026, 4:00:00 PM   ERROR [Bootstrap] startup failed: database unreachable at postgres://postgres:***@localhost:5432/damwha\n";
    expect(lastMeaningfulLine(stderr)).toBe(
      "[Nest] 12345  - 09/11/2026, 4:00:00 PM   ERROR [Bootstrap] startup failed: database unreachable at postgres://postgres:***@localhost:5432/damwha",
    );
  });

  it("returns an empty string for empty input", () => {
    expect(lastMeaningfulLine("")).toBe("");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(lastMeaningfulLine("   \n\t\n   \n")).toBe("");
  });

  it("strips ANSI escapes even without a startup-failed line, falling back to the last real-content line", () => {
    const stderr = `${RED}some warning${RESET}\n${RED}}${RESET}\n`;
    const result = lastMeaningfulLine(stderr);
    expect(result).toBe("some warning");
    expect(result).not.toMatch(ANSI_SGR);
  });

  it("skips bracket/punctuation-only trailing lines when there is no startup-failed line", () => {
    const stderr = ["Error: something broke", "  at Object.<anonymous> (/app/dist/main.js:1:1)", "]", "}"].join(
      "\n",
    );
    expect(lastMeaningfulLine(stderr)).toBe("at Object.<anonymous> (/app/dist/main.js:1:1)");
  });
});

describe("failureBlock", () => {
  it("keeps every line of a multi-line cause", () => {
    // Phase 1의 lastMeaningfulLine은 한 줄만 골라 zod 원인이 `startup failed: [`까지만 보였다.
    const stderr = [
      "[Nest] LOG starting",
      "startup failed: [",
      '  { "path": ["SUMMARY_LLM_MODEL"], "message": "Invalid input" }',
      "]",
    ].join("\n");
    const block = failureBlock(stderr);
    expect(block).toContain("startup failed:");
    expect(block).toContain("SUMMARY_LLM_MODEL");
    expect(block.endsWith("]")).toBe(true);
  });

  it("falls back to the last meaningful line when there is no startup failure", () => {
    expect(failureBlock("[Nest] LOG a\nsomething broke")).toBe("something broke");
  });

  it("caps the block so a runaway stderr cannot fill the screen", () => {
    const stderr = [
      "startup failed: [",
      ...Array.from({ length: 200 }, (_, i) => `  line ${i}`),
    ].join("\n");
    expect(failureBlock(stderr, 10).split("\n")).toHaveLength(10);
  });

  it("strips ANSI from the whole block", () => {
    expect(failureBlock("\x1b[31mstartup failed: nope\x1b[39m")).toBe("startup failed: nope");
  });

  it("returns an empty string for empty input", () => {
    expect(failureBlock("")).toBe("");
    expect(failureBlock("   \n  ")).toBe("");
  });
});

describe("exitCauseBlock", () => {
  it("uses failureBlock when there is a startup failure", () => {
    const stderr = "[Nest] LOG a\nstartup failed: [\n  {}\n]\nnoise after";
    expect(exitCauseBlock(stderr)).toBe(failureBlock(stderr));
    expect(exitCauseBlock(stderr).startsWith("startup failed: [")).toBe(true);
  });

  it("keeps the last lines of a traceback instead of only the exception line", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    expect(exitCauseBlock(lines.join("\n"))).toBe(lines.slice(-12).join("\n"));
    expect(exitCauseBlock(lines.join("\n"), 3)).toBe("line 17\nline 18\nline 19");
  });

  it("strips ANSI and blank lines, and is empty for empty input", () => {
    expect(exitCauseBlock("\x1b[31mboom\x1b[39m\n\n  \n")).toBe("boom");
    expect(exitCauseBlock("")).toBe("");
  });
});

describe("원인 블록의 글자 상한 (Task 14 D3)", () => {
  // 줄 수 상한만으로는 줄바꿈 없는 한 줄이 stderr 꼬리 8KB를 통째로 화면에 싣는다.
  const huge = "x".repeat(8_000);

  it("bounds a startup-failed block by characters and keeps its head, where the cause is", () => {
    const block = failureBlock(`startup failed: ${huge}`);
    expect(block.length).toBe(BLOCK_MAX_CHARS + 1);
    expect(block.startsWith("startup failed: x")).toBe(true);
    expect(block.endsWith("…")).toBe(true);
  });

  it("bounds a tail by characters and keeps its end, where a traceback's cause is", () => {
    const block = exitCauseBlock(`${huge}\nRuntimeError: boom`);
    expect(block.length).toBeLessThanOrEqual(BLOCK_MAX_CHARS + 1);
    expect(block.startsWith("…")).toBe(true);
    expect(block.endsWith("RuntimeError: boom")).toBe(true);
  });

  it("bounds a single enormous line with no startup failure", () => {
    expect(exitCauseBlock(huge).length).toBe(BLOCK_MAX_CHARS + 1);
    expect(failureBlock(huge).length).toBe(BLOCK_MAX_CHARS + 1);
  });

  it("keeps the end of a single enormous line with no startup failure, not its start (리뷰 M-3)", () => {
    // startup failed가 없으면 원인이 줄 앞에 있다는 계약이 없다. 한 줄로 뭉친 진행 바·로그의 최신 내용은 끝에
    // 있고, 같은 경우 exitCauseBlock도 끝을 남긴다 — 둘이 같은 글자를 보여야 한다.
    const line = `START${huge}END`;
    const block = failureBlock(line);
    expect(block.startsWith("…")).toBe(true);
    expect(block.endsWith("END")).toBe(true);
    expect(block).toBe(exitCauseBlock(line));
  });

  it("leaves a block under the limit alone", () => {
    expect(exitCauseBlock("a\nb")).toBe("a\nb");
  });
});
