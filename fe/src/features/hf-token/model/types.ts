/**
 * 데스크톱 main과 주고받는 HF 토큰 모양 (스펙 2026-09-25 §4.1). 원본은 desktop/src/windows/token-bridge.ts다 —
 * 두 패키지는 import를 나눌 수 없어 손으로 맞춘다. 한쪽을 바꾸면 다른 쪽도 바꾼다.
 */
export type HfTokenStatus = "present" | "absent" | "unreadable" | "unavailable";

export interface HfTokenMessage {
  tone: "info" | "warn" | "error";
  text: string;
}

export interface HfTokenState {
  status: HfTokenStatus;
  masked: string | null;
  account: string | null;
  onboardingDismissed: boolean;
  busy: boolean;
  message: HfTokenMessage | null;
}

export type HfTokenAction =
  | { kind: "submit"; token: string }
  | { kind: "clear" }
  | { kind: "dismissOnboarding" }
  | { kind: "open"; link: "accept" | "tokens" };

/** web = 데스크톱 다리 없음(게이트 통과) · pending = Electron인데 main의 첫 상태를 아직 못 받음 · ready. */
export type HfTokenView =
  | { kind: "web" }
  | { kind: "pending" }
  | { kind: "ready"; state: HfTokenState };
