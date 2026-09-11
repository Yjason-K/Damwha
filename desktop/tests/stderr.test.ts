import { describe, expect, it } from "vitest";
import { ANSI_SGR, lastMeaningfulLine } from "../src/stderr";

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
