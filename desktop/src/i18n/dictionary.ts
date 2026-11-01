import type { UiLanguage } from "./locale";

/**
 * desktop main의 사람용 문구 (다국어 스펙 §4.4). 복수형이 거의 없어 i18next를 들이지 않는다.
 * `ko`가 기준이고 `en`은 같은 키를 **모두** 가져야 한다(Record<DesktopKey, string>).
 * 로그(appendSupervisorLog)로 가는 문구는 여기 두지 않는다 — 번역하지 않는다.
 * 보간은 i18next와 같은 `{{이름}}`.
 */
const ko = {
  "test.echo": "{{value}}",
  "menu.checkForUpdates": "업데이트 확인…",
  "menu.restore": "업데이트 전으로 되돌리기…",
  "menu.meetingDetection": "회의 감지",
  "menu.services": "서비스",
  "menu.serviceStatus": "서비스 상태",
  "menu.retry": "다시 시도",
  "detect.prompt.title": "회의를 기록할까요?",
  "detect.prompt.detail": "녹음은 이 Mac에만 저장돼요",
  "detect.start": "녹음 시작",
  "detect.dismiss": "닫기",
  "detect.recording.title": "녹음 중",
  "detect.recording.micOnly": "마이크만 녹음 중",
  "detect.stop": "중지",
  "detect.open": "회의 보기",
  "detect.done.title": "녹음을 마쳤어요",
  "detect.interrupted.title": "녹음이 중단됐어요",
  "detect.interrupted.detail": "지금까지 녹음된 내용은 남아 있어요",
  "detect.empty.title": "녹음된 내용이 없어요",
  "detect.lost.title": "녹음이 끊겼어요",
  "detect.lost.detail": "담화에서 회의를 확인해 주세요",
  "detect.startFailed.title": "녹음을 시작하지 못했어요",
};

export type DesktopKey = keyof typeof ko;

/** 같은 접두 키를 한꺼번에 검사하는 테스트용. */
export const DESKTOP_KEYS = Object.keys(ko) as DesktopKey[];

const en: Record<DesktopKey, string> = {
  "test.echo": "{{value}}",
  "menu.checkForUpdates": "Check for updates…",
  "menu.restore": "Restore previous version…",
  "menu.meetingDetection": "Meeting detection",
  // "Services"는 macOS 앱 메뉴의 서비스(role: services)와 겹쳐 읽힌다.
  "menu.services": "Status",
  "menu.serviceStatus": "Service status",
  "menu.retry": "Retry",
  "detect.prompt.title": "Record this meeting?",
  "detect.prompt.detail": "Recordings stay on this Mac",
  "detect.start": "Start recording",
  "detect.dismiss": "Dismiss",
  "detect.recording.title": "Recording",
  "detect.recording.micOnly": "Recording microphone only",
  "detect.stop": "Stop",
  "detect.open": "View meeting",
  "detect.done.title": "Recording finished",
  "detect.interrupted.title": "Recording was interrupted",
  "detect.interrupted.detail": "Everything recorded so far is kept",
  "detect.empty.title": "Nothing was recorded",
  "detect.lost.title": "Recording was cut off",
  "detect.lost.detail": "Check the meeting in Damwha",
  "detect.startFailed.title": "Couldn't start recording",
};

const DICT: Record<UiLanguage, Record<DesktopKey, string>> = { ko, en };

export function t(lang: UiLanguage, key: DesktopKey, vars?: Record<string, string | number>): string {
  const text = DICT[lang][key];
  if (vars === undefined) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}
