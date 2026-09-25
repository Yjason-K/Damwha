import { app, BrowserWindow, nativeTheme } from "electron";
import * as path from "path";
import { applyNavigationBoundary } from "./permissions";
import { isSameShellPage } from "./shell-url";
import { windowBackground } from "./window-background";

// electron을 값으로 import하는 이 파일은 vitest가 못 불러온다. lastMeaningfulLine()의
// 순수 로직은 desktop/src/diagnostics/stderr.ts에 있다 — 여기서는 기존 호출부를 위해 재노출만 한다.
export { lastMeaningfulLine } from "../diagnostics/stderr";

export type ShellState = "starting" | "quitting" | "failed";

export interface ShellStatus {
  state: ShellState;
  /** API stderr의 마지막 줄 같은 원인 원문 */
  detail?: string;
  retryInSeconds?: number;
  logPath?: string;
}

function shellFileOf(name: "status.html" | "services.html"): string {
  // app.getAppPath()는 dev에서 desktop/, packaged에서 app.asar을 가리킨다.
  return path.join(app.getAppPath(), "shell", name);
}

export function showStatus(win: BrowserWindow, status: ShellStatus): Promise<void> {
  const query: Record<string, string> = { state: status.state };
  if (status.detail !== undefined) query.detail = status.detail;
  if (status.retryInSeconds !== undefined) query.retryInSeconds = String(status.retryInSeconds);
  if (status.logPath !== undefined) query.logPath = status.logPath;
  const file = shellFileOf("status.html");
  // 건강 검사(10초 간격)처럼 값이 하나도 안 바뀐 갱신은 loadFile을 건너뛴다 — 안 그러면
  // 상태가 그대로인데도 매번 페이지를 통째로 다시 로드해 실패 화면이 깜빡인다. 의심스러우면
  // (창이 파괴됐거나 getURL이 던지면) 그냥 아래로 흘러 다시 그린다 — isSameShellPage는 그런
  // 경우를 안 보고 넘겨받은 두 URL만 비교한다.
  try {
    if (!win.isDestroyed() && isSameShellPage(win.webContents.getURL(), file, query)) {
      return Promise.resolve();
    }
  } catch {
    // 의심스러우면 다시 그린다 — 아래 loadFile로 흘러간다.
  }
  return win.loadFile(file, { query });
}

/**
 * 서비스 상태 창을 만든다 (잎 — 수명과 갱신 규칙은 status-window.ts에 있다).
 *
 * 메인 창과 같은 webPreferences다 (스펙 §6.11). preload가 없으므로 이 창에서 main을 부를 길이 없고,
 * main은 executeJavaScript 한 방향으로만 그린다.
 *
 * `focus`가 false면 포커스를 뺏지 않고 띄운다. 앱이 스스로 여는 경우(실패 알림)가 그렇다 — 사용자는
 * 녹음 중이거나 무언가를 입력하는 중일 수 있다.
 */
export function createServicesWindow(focus: boolean, onLoadError: (e: unknown) => void): BrowserWindow {
  const win = new BrowserWindow({
    width: 640,
    height: 560,
    minWidth: 420,
    minHeight: 320,
    title: "서비스 상태",
    show: false,
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // 이 창은 file:// 한 장만 쓴다. 허용 목록이 비어 있으므로 사용자가 끌어다 놓은 링크·파일로도
  // 다른 곳으로 가지 못한다 — 갔다면 main의 다음 갱신이 그 낯선 페이지에 로그 경로와 stderr를 싣는다.
  applyNavigationBoundary(win, () => []);
  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    if (focus) win.show();
    else win.showInactive();
  });
  win.loadFile(shellFileOf("services.html")).catch(onLoadError);
  return win;
}
