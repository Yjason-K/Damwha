import { app, type BrowserWindow } from "electron";
import * as path from "path";

// electron을 값으로 import하는 이 파일은 vitest가 못 불러온다. lastMeaningfulLine()의
// 순수 로직은 desktop/src/stderr.ts에 있다 — 여기서는 기존 호출부를 위해 재노출만 한다.
export { lastMeaningfulLine } from "./stderr";

export type ShellState = "starting" | "db-unreachable" | "failed";

export interface ShellStatus {
  state: ShellState;
  /** API stderr의 마지막 줄 같은 원인 원문 */
  detail?: string;
  retryInSeconds?: number;
  logPath?: string;
}

function shellFile(): string {
  // app.getAppPath()는 dev에서 desktop/, packaged에서 app.asar을 가리킨다.
  return path.join(app.getAppPath(), "shell", "status.html");
}

export function showStatus(win: BrowserWindow, status: ShellStatus): Promise<void> {
  const query: Record<string, string> = { state: status.state };
  if (status.detail !== undefined) query.detail = status.detail;
  if (status.retryInSeconds !== undefined) query.retryInSeconds = String(status.retryInSeconds);
  if (status.logPath !== undefined) query.logPath = status.logPath;
  return win.loadFile(shellFile(), { query });
}

