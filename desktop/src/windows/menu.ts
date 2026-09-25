import { app, Menu } from "electron";
import { buildMenuTemplate, type MenuHandlers } from "./menu-template";

export type { MenuHandlers };

/** 템플릿과 그 이유는 menu-template.ts에 있다. 여기는 electron에 닿는 잎뿐이다. */
export function installMenu(handlers: MenuHandlers, opts?: { restoreEnabled: boolean }): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(handlers, app.name, opts)));
}
