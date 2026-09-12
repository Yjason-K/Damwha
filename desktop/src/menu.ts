import { Menu, type MenuItemConstructorOptions } from "electron";

/**
 * 메뉴에 두는 이유: preload가 없어 렌더러에서 main을 부를 경로가 없다 (스펙 §6.5·§6.11).
 * 메뉴는 main 프로세스 소유라 IPC가 필요 없다. 담화 화면이 붙은 뒤에는 준비 화면이 더
 * 이상 그려지지 않으므로, 서비스 상태를 볼 채널도 여기뿐이다.
 */
export interface MenuHandlers {
  onRetry(): void;
  /** 서비스 상태를 사람에게 보인다. 창 자체는 Task 14가 만든다. */
  onShowStatus(): void;
}

export function installMenu(handlers: MenuHandlers): void {
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "서비스",
      submenu: [
        {
          label: "서비스 상태",
          accelerator: "CmdOrCtrl+Alt+S",
          click: () => handlers.onShowStatus(),
        },
        {
          label: "다시 시도",
          accelerator: "CmdOrCtrl+Alt+R",
          click: () => handlers.onRetry(),
        },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
