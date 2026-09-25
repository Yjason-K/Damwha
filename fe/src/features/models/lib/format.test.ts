import { expect, test } from "vitest";
import { formatBytes } from "./format";

test("1000 기준, 소수 한 자리 — worker disk.py format_bytes와 같은 규칙", () => {
  expect(formatBytes(999)).toBe("999 B");
  expect(formatBytes(1000)).toBe("1.0 KB");
  expect(formatBytes(486_212_372)).toBe("486.2 MB");
  expect(formatBytes(1_613_979_758)).toBe("1.6 GB");
  expect(formatBytes(29_528_168_817)).toBe("29.5 GB");
});
