import { app, type BrowserWindow } from "electron";
import * as path from "path";

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

// NestJS Logger는 stderr가 TTY가 아니어도 ANSI 색상 escape를 쓴다. textContent로
// 넣으면 그 제어문자가 글자 그대로 남아, 원인을 알려 주는 화면이 깨져 보인다.
// eslint-disable-next-line no-control-regex
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

/** API stderr에서 사람에게 보여줄 마지막 의미 있는 줄. */
export function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .replace(ANSI_SGR, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}
