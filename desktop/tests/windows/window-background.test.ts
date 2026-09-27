import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { WINDOW_BACKGROUND, windowBackground } from "../../src/windows/window-background";

/** 창 바탕은 첫 페인트 전 잠깐 보이는 면이다 — fe의 앱 바탕(--surface-app = --gray-2)과 달라지면 번쩍인다. */
describe("windowBackground", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "..", "fe", "src", "index.css"), "utf8");
  const gray2Of = (block: RegExp) => /--gray-2:\s*([^;]+);/.exec(block.exec(css)![1])![1].trim();

  it("macOS 설정에 따라 두 값 중 하나를 고른다", () => {
    expect(windowBackground(false)).toBe(WINDOW_BACKGROUND.light);
    expect(windowBackground(true)).toBe(WINDOW_BACKGROUND.dark);
  });

  it("fe의 라이트·다크 --gray-2와 같다", () => {
    expect(WINDOW_BACKGROUND.light).toBe(gray2Of(/^:root\s*\{([^}]*)\}/m));
    expect(WINDOW_BACKGROUND.dark).toBe(gray2Of(/^\.dark\s*\{([^}]*)\}/m));
  });
});
