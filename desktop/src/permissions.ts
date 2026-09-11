import { session, shell, type BrowserWindow } from "electron";
import { isAllowedOrigin } from "./origin";

/**
 * 마이크만 허용하고 자기 origin에만 허용한다. 자동 부여라 포트가 바뀌어도 사용자가
 * 권한을 다시 묻지 않는다 — macOS TCC 권한은 .app 단위라 그대로 유지된다 (스펙 §6.4).
 */
export function applyPermissionBoundary(allowedOrigins: () => string[]): void {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === "media" && isAllowedOrigin(contents.getURL(), allowedOrigins()));
  });
  // requestingOrigin을 그대로 믿는다 — 이 앱은 프레임이 하나뿐이라 위 핸들러가 보는
  // contents.getURL()의 origin과 언제나 같다. iframe이 생기면 둘이 갈라질 수 있다.
  s.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return permission === "media" && allowedOrigins().includes(requestingOrigin);
  });
}

export function applyNavigationBoundary(win: BrowserWindow, allowedOrigins: () => string[]): void {
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedOrigin(url, allowedOrigins())) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // 새 창을 만들지 않는다. 외부 링크는 기본 브라우저가 연다.
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}
