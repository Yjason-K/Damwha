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
  "menu.services": "서비스",
  "menu.serviceStatus": "서비스 상태",
  "menu.retry": "다시 시도",
};

export type DesktopKey = keyof typeof ko;

const en: Record<DesktopKey, string> = {
  "test.echo": "{{value}}",
  "menu.checkForUpdates": "Check for updates…",
  "menu.restore": "Restore previous version…",
  // "Services"는 macOS 앱 메뉴의 서비스(role: services)와 겹쳐 읽힌다.
  "menu.services": "Status",
  "menu.serviceStatus": "Service status",
  "menu.retry": "Retry",
};

const DICT: Record<UiLanguage, Record<DesktopKey, string>> = { ko, en };

export function t(lang: UiLanguage, key: DesktopKey, vars?: Record<string, string | number>): string {
  const text = DICT[lang][key];
  if (vars === undefined) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}
