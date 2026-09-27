import type { MenuItemConstructorOptions } from "electron";
import type { UiLanguage } from "../i18n/locale";
import { t } from "../i18n/dictionary";

/**
 * 앱 메뉴 템플릿 — 순수 함수라 시험할 수 있다. 설치는 menu.ts가 한다.
 *
 * 메뉴에 두는 이유: preload가 없어 렌더러에서 main을 부를 경로가 없다 (스펙 §6.5·§6.11).
 * 메뉴는 main 프로세스 소유라 IPC가 필요 없다. 담화 화면이 붙은 뒤에는 준비 화면이 더
 * 이상 그려지지 않으므로, 서비스 상태를 볼 채널도 여기뿐이다.
 *
 * 앱 메뉴는 `{ role: "appMenu" }` 대신 명시 템플릿이다 — "업데이트 확인…"을 넣을 자리가 필요해서다.
 * Electron 44.3.0의 appMenu가 내던 항목(about·services·hide·hideOthers·unhide·quit과 구분선)을
 * 그대로 재현한다 (Phase 6b-1 스펙 §4.4). `quit` role은 app.quit()을 거쳐 before-quit 흐름에 닿는다.
 *
 * role 항목(about·hide·quit·editMenu…)의 이름은 macOS가 시스템 언어로 붙인다 — 화면 언어를 따르지 않는다.
 */
export interface MenuHandlers {
  onRetry(): void;
  /** 서비스 상태 창을 연다 (status-window.ts). 이미 열려 있으면 앞으로 가져온다. */
  onShowStatus(): void;
  /** 새 버전을 지금 확인한다 (update/update-flow.ts의 manualCheck). */
  onCheckForUpdates(): void;
  /** 업데이트 전으로 되돌리기 (Phase 6b-2 스펙 §7.1). */
  onRestore(): void;
}

export function buildMenuTemplate(
  handlers: MenuHandlers,
  appName: string,
  opts: { restoreEnabled: boolean; language?: UiLanguage } = { restoreEnabled: false },
): MenuItemConstructorOptions[] {
  const lang = opts.language ?? "ko";
  return [
    {
      label: appName,
      submenu: [
        { role: "about" },
        { label: t(lang, "menu.checkForUpdates"), click: () => handlers.onCheckForUpdates() },
        { label: t(lang, "menu.restore"), enabled: opts.restoreEnabled, click: () => handlers.onRestore() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: t(lang, "menu.services"),
      submenu: [
        {
          label: t(lang, "menu.serviceStatus"),
          accelerator: "CmdOrCtrl+Alt+S",
          click: () => handlers.onShowStatus(),
        },
        {
          label: t(lang, "menu.retry"),
          accelerator: "CmdOrCtrl+Alt+R",
          click: () => handlers.onRetry(),
        },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}
