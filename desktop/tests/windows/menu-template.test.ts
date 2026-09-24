import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { buildMenuTemplate } from "../../src/windows/menu-template";

function handlers() {
  return { onRetry: vi.fn(), onShowStatus: vi.fn(), onCheckForUpdates: vi.fn() };
}

describe("buildMenuTemplate", () => {
  it("앱 메뉴가 appMenu role이 내던 항목을 그대로 두고 업데이트 확인을 더한다", () => {
    const t = buildMenuTemplate(handlers(), "Damwha");
    const app = t[0];
    expect(app.label).toBe("Damwha");
    const items = app.submenu as MenuItemConstructorOptions[];
    expect(items.map((i) => i.role ?? i.type ?? i.label)).toEqual([
      "about",
      "업데이트 확인…",
      "separator",
      "services",
      "separator",
      "hide",
      "hideOthers",
      "unhide",
      "separator",
      "quit",
    ]);
  });

  it("업데이트 확인을 누르면 핸들러를 부른다", () => {
    const h = handlers();
    const items = buildMenuTemplate(h, "Damwha")[0].submenu as MenuItemConstructorOptions[];
    const item = items.find((i) => i.label === "업데이트 확인…")!;
    (item.click as () => void)();
    expect(h.onCheckForUpdates).toHaveBeenCalledTimes(1);
  });

  it("나머지 메뉴는 그대로다", () => {
    const t = buildMenuTemplate(handlers(), "Damwha");
    expect(t.slice(1).map((m) => m.role ?? m.label)).toEqual(["서비스", "editMenu", "viewMenu", "windowMenu"]);
  });
});
