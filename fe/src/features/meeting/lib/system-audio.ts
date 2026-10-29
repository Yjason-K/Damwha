import type { OpenSystemAudio } from "./live-recorder";

/**
 * 데스크톱 앱이 여는 시스템 오디오 스킴 (desktop/src/windows/system-audio-protocol.ts와 짝). 브라우저에는 이 스킴이
 * 없어 fetch가 곧바로 거부되므로, `isSystemAudioAvailable()`이 false가 되고 옵션이 화면에서 사라진다.
 */
const BASE = "damwha-audio://system";

/** 데스크톱 헬퍼가 시스템 오디오를 열지 못했다. 마이크 문제와 사용자가 할 일이 달라 타입으로 가른다. */
export class SystemAudioUnavailable extends Error {}

export async function isSystemAudioAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/status`, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

export const openDesktopSystemAudio: OpenSystemAudio = async () => {
  let res: Response;
  try {
    res = await fetch(`${BASE}/pcm`, { cache: "no-store" });
  } catch (err) {
    throw new SystemAudioUnavailable(String(err));
  }
  if (!res.ok || res.body === null) {
    throw new SystemAudioUnavailable(`system audio answered ${res.status}`);
  }
  return res.body;
};

const PREFERENCE_KEY = "damwha:live-system-audio";

/** 기본은 켬 — 실시간 녹음을 여는 가장 흔한 이유가 화상회의다. 대면 회의에서 끈 선택은 기억한다. */
export function readSystemAudioPreference(): boolean {
  try {
    return localStorage.getItem(PREFERENCE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveSystemAudioPreference(on: boolean): void {
  try {
    localStorage.setItem(PREFERENCE_KEY, on ? "on" : "off");
  } catch {
    // 저장소를 쓸 수 없어도 이번 모달의 선택은 유지된다.
  }
}
