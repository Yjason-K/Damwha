import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

// shell-window.ts는 electron을 값으로 import해 vitest가 못 불러온다 — 소스 글자를 읽어 지킨다.
const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "windows", "shell-window.ts"), "utf8");

describe("회의 감지 카드 창", () => {
  // 이 옵션이 없으면 Electron이 앱을 UIElement로 바꿔 담화가 Dock에서 사라진다
  // (Electron 44.3 실측: 호출 뒤 app.dock.isVisible()이 false).
  it("setVisibleOnAllWorkspaces가 프로세스 타입을 바꾸지 않는다", () => {
    const calls = source.match(/setVisibleOnAllWorkspaces\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain("skipTransformProcessType: true");
  });
});
