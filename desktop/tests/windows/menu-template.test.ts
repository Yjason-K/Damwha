import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { buildMenuTemplate, type MenuHandlers } from "../../src/windows/menu-template";

function handlers() {
  return { onRetry: vi.fn(), onShowStatus: vi.fn(), onCheckForUpdates: vi.fn(), onRestore: vi.fn() };
}

describe("buildMenuTemplate", () => {
  it("앱 메뉴가 appMenu role이 내던 항목을 그대로 두고 업데이트 확인과 되돌리기를 더한다", () => {
    const t = buildMenuTemplate(handlers(), "Damwha");
    const app = t[0];
    expect(app.label).toBe("Damwha");
    const items = app.submenu as MenuItemConstructorOptions[];
    expect(items.map((i) => i.role ?? i.type ?? i.label)).toEqual([
      "about",
      "업데이트 확인…",
      "업데이트 전으로 되돌리기…",
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

const restoreHandlers = (): MenuHandlers & { restored: number } => {
  const h = {
    restored: 0,
    onRetry: () => undefined,
    onShowStatus: () => undefined,
    onCheckForUpdates: () => undefined,
    onRestore: () => {
      h.restored += 1;
    },
  };
  return h;
};
const restoreItem = (enabled?: boolean) => {
  const app = buildMenuTemplate(restoreHandlers(), "Damwha", enabled === undefined ? undefined : { restoreEnabled: enabled })[0];
  return (app.submenu as Array<{ label?: string; enabled?: boolean }>).find((i) => i.label === "업데이트 전으로 되돌리기…");
};

describe("restore menu item", () => {
  it("sits in the app menu, disabled by default", () => expect(restoreItem()?.enabled).toBe(false));
  it("follows restoreEnabled", () => expect(restoreItem(true)?.enabled).toBe(true));
  it("calls onRestore", () => {
    const h = restoreHandlers();
    const app = buildMenuTemplate(h, "Damwha", { restoreEnabled: true })[0];
    const item = (app.submenu as Array<{ label?: string; click?: () => void }>).find((i) => i.label === "업데이트 전으로 되돌리기…");
    item?.click?.();
    expect(h.restored).toBe(1);
  });
});
