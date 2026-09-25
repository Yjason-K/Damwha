import { hasLiveCapture, stopActiveLiveCapture } from "./live-session";
import { hfTokenStore, type HfTokenBridge } from "@/features/hf-token/lib/bridge-store";

export interface DesktopBridge {
  isRecording(): boolean;
  stopLiveRecording(): Promise<{ stopped: boolean; reason?: string }>;
  /** HF 토큰 (스펙 2026-09-25 §4). main의 token-bridge.ts가 이 이름으로 부른다 — 이름을 바꾸면 조용히 끊긴다. */
  hfToken: HfTokenBridge;
}

declare global {
  interface Window {
    __damwha_desktop?: DesktopBridge;
  }
}

/**
 * main → 렌더러 한 방향이다. 렌더러가 먼저 부를 수 있는 채널은 생기지 않으므로 Phase 1의
 * "렌더러에서 main을 부를 경로를 새로 만들지 않는다"는 계약이 그대로 산다 (스펙 §6.11).
 * 웹 배포에서는 아무도 부르지 않아 무해하고, fe는 이 객체 없이도 그대로 동작한다.
 */
export function installDesktopBridge(w: Window = window): void {
  // 두 번 설치하지 않는다 — HMR이나 StrictMode의 이중 마운트에서 훅이 갈리면
  // main이 낡은 레지스트리를 보는 쪽을 잡을 수 있다.
  if (w.__damwha_desktop !== undefined) return;
  w.__damwha_desktop = {
    isRecording: () => hasLiveCapture(),
    async stopLiveRecording() {
      if (!hasLiveCapture()) return { stopped: true, reason: "no-recording" };
      try {
        await stopActiveLiveCapture();
        return { stopped: true };
      } catch (e) {
        // 여기서 던지면 executeJavaScript가 거부로 끝나 main이 이유를 못 읽는다.
        return {
          stopped: false,
          reason: e instanceof Error ? e.message : String(e),
        };
      }
    },
    hfToken: hfTokenStore.bridge,
  };
}
