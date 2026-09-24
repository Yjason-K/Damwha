import type { MessageBoxOptions } from "electron";
import { CHECK_TIMEOUT_MS, DEFAULT_RATE_LIMIT_WAIT_MS, type CheckResult } from "./release-check";

/**
 * 새 버전 알림의 대화상자 옵션과 문구 (Phase 6b-1 스펙 §5). 띄우는 것은 main.ts다.
 *
 * `cancelId`를 **반드시** 준다 — 없으면 Electron이 라벨로 취소 버튼을 추정하는데 한국어 라벨은 인식되지
 * 않아 Escape가 0번(다운로드 페이지 열기)을 고를 수 있다 (스펙 §3-11).
 */
export type NewerChoice = "open" | "later" | "skip";

export const NEWER_BUTTONS = ["다운로드 페이지 열기", "나중에", "이 버전 건너뛰기"] as const;

export function newerDialogOptions(current: string, latest: string): MessageBoxOptions {
  return {
    type: "info",
    message: `새 버전 ${latest}이 나왔어요`,
    detail: `지금 ${current}을 쓰고 있어요. 다운로드 페이지에서 DMG를 받아 설치해 주세요.`,
    buttons: [...NEWER_BUTTONS],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
}

export function newerChoice(response: number): NewerChoice {
  if (response === 0) return "open";
  if (response === 2) return "skip";
  return "later";
}

export function currentDialogOptions(current: string): MessageBoxOptions {
  return { type: "info", message: "최신 버전을 쓰고 있어요", detail: `담화 ${current}`, buttons: ["확인"] };
}

export function failedDialogOptions(detail: string): MessageBoxOptions {
  return {
    type: "warning",
    message: "업데이트를 확인하지 못했어요",
    detail: `${detail} 잠시 뒤 다시 시도해 주세요.`,
    buttons: ["확인"],
  };
}

export function failureMessage(r: Extract<CheckResult, { kind: "failed" }>): string {
  switch (r.reason) {
    case "offline":
      return "인터넷에 연결되어 있지 않은 것 같아요.";
    case "timeout":
      return `GitHub이 ${CHECK_TIMEOUT_MS / 1000}초 안에 답하지 않았어요.`;
    case "rate_limited": {
      const minutes = Math.max(1, Math.ceil((r.retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS) / 60_000));
      return `확인 요청이 너무 많았어요. ${minutes}분 뒤에 다시 시도할 수 있어요.`;
    }
    case "http":
      return `GitHub이 오류를 돌려줬어요 (${r.detail}).`;
    case "malformed":
      return "GitHub의 응답을 읽지 못했어요.";
    case "no_release":
      return "받을 수 있는 데스크톱 릴리스를 찾지 못했어요.";
  }
}
