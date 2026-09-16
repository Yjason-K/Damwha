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
  // 실측(2026-09-11, pnpm desktop:dev + CDP): 렌더러가 실제로 묻는 requestingOrigin은
  // "http://localhost:5173/"처럼 끝에 슬래시가 붙어 오는데, allowedOrigins()는
  // "http://localhost:5173"처럼 슬래시 없는 origin 문자열을 담고 있다. 원문 그대로
  // .includes()로 비교하던 예전 코드는 이 두 문자열이 절대 같을 수 없어서
  // permissions.query가 항상 "denied"를 돌려줬다 — getUserMedia는 위 요청 핸들러(origin을
  // isAllowedOrigin으로 정규화해서 비교)를 타서 성공하는데 조회만 거부되는 불일치가
  // 여기서 생겼다. 또한 페이지가 아직 커밋되기 전의 내부 호출에서는 requestingOrigin이
  // 빈 문자열로 오는 것도 실측했으므로, 그때는 contents.getURL()로 대체한다.
  // 요청 핸들러와 같은 isAllowedOrigin을 타게 해서 두 핸들러가 우연이 아니라 구조로
  // 일치하게 만든다.
  s.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    const origin = requestingOrigin !== "" ? requestingOrigin : (contents?.getURL() ?? "");
    return permission === "media" && isAllowedOrigin(origin, allowedOrigins());
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
