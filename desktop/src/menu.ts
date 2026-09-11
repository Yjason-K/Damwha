import { Menu, type MenuItemConstructorOptions } from "electron";

/**
 * 재시도를 메뉴에 두는 이유: preload가 없어 렌더러에서 main을 부를 경로가 없다 (스펙 §6.5).
 * 메뉴는 main 프로세스 소유라 IPC가 필요 없다.
 */
export function installMenu(onRetry: () => void): void {
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "서비스",
      submenu: [
        {
          label: "다시 시도",
          accelerator: "CmdOrCtrl+Alt+R",
          click: () => onRetry(),
        },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
