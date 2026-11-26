import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { buildMenuTemplate, type MenuHandlers } from "../../src/windows/menu-template";

function handlers() {
  return { onRetry: vi.fn(), onShowStatus: vi.fn(), onCheckForUpdates: vi.fn(), onRestore: vi.fn(), onToggleMeetingDetection: vi.fn() };
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
      "checkbox",
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

  it("나머지 메뉴는 File·서비스·Edit·View·Window 순서다", () => {
    const t = buildMenuTemplate(handlers(), "Damwha");
    expect(t.slice(1).map((m) => m.role ?? m.label)).toEqual(["fileMenu", "서비스", "editMenu", "viewMenu", "windowMenu"]);
  });

  it("⌘W를 받을 창 닫기 항목이 있다 — 앱 메뉴 바로 뒤의 fileMenu (이슈 148)", () => {
    // macOS의 단축키는 그 단축키를 가진 메뉴 항목이 있어야 동작한다. windowMenu role은 macOS에서 Close를 넣지 않아
    // (실측: Minimize·Zoom·Fill… 뿐) ⌘W가 아무 일도 하지 않았다. fileMenu role이 macOS에서 Close Window(⌘W)를
    // 담고, 그 항목은 빨간 버튼과 같은 performClose라 기존 닫기 흐름(decideCloseEvent·runCloseFlow)을 탄다.
    const t = buildMenuTemplate(handlers(), "Damwha");
    expect(t[1]).toEqual({ role: "fileMenu" });
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
    onToggleMeetingDetection: () => undefined,
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

it("language: en이면 앱이 만든 항목이 영어다 (role 항목은 macOS가 붙인다)", () => {
  const tpl = buildMenuTemplate(handlers(), "Damwha", { restoreEnabled: false, language: "en" });
  const labels = JSON.stringify(
    tpl.map((m) => [m.label, Array.isArray(m.submenu) ? (m.submenu as { label?: string }[]).map((i) => i.label) : []]),
  );
  expect(labels).toContain("Check for updates…");
  expect(labels).toContain("Service status");
  expect(labels).not.toMatch(/\p{Script=Hangul}/u);
});

describe("회의 감지 메뉴 항목", () => {
  const item = (opts?: { restoreEnabled: boolean; meetingDetection?: boolean }, h = handlers()) =>
    (buildMenuTemplate(h, "Damwha", opts)[0].submenu as MenuItemConstructorOptions[]).find((i) => i.label === "회의 감지")!;

  it("체크 항목이 앱 메뉴의 되돌리기 아래에 있고 기본은 켜짐이다", () => {
    const i = item();
    expect(i.type).toBe("checkbox");
    expect(i.checked).toBe(true);
  });

  it("meetingDetection을 따른다", () => {
    expect(item({ restoreEnabled: false, meetingDetection: false }).checked).toBe(false);
  });

  it("누르면 새 값을 핸들러에 넘긴다", () => {
    const h = handlers();
    const i = item({ restoreEnabled: false, meetingDetection: true }, h);
    (i.click as (m: { checked: boolean }) => void)({ checked: false });
    expect(h.onToggleMeetingDetection).toHaveBeenCalledWith(false);
  });

  it("en이면 영어 라벨이다", () => {
    const sub = buildMenuTemplate(handlers(), "Damwha", { restoreEnabled: false, language: "en" })[0].submenu as MenuItemConstructorOptions[];
    expect(sub.some((i) => i.label === "Meeting detection")).toBe(true);
  });
});
