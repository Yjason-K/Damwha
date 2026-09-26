import i18next, { type i18n } from "i18next";
import { initReactI18next } from "react-i18next";
import { UI_LANGUAGES, type UiLanguage } from "@damwha/contracts";
import { en } from "./locales/en";
import { ko } from "./locales/ko";

export const NAMESPACES = ["common", "settings"] as const;

/**
 * 앱의 i18next 인스턴스. **동기로** 초기화한다(`initAsync: false`) — 리소스가 번들 안에 있으니
 * 기다릴 것이 없고, 비동기면 첫 렌더가 키 문자열을 한 번 그린다.
 * `initReactI18next`가 이 인스턴스를 react-i18next의 전역으로 걸어, Provider 없이도
 * `useTranslation`이 이것을 쓴다(테스트의 개별 렌더 포함).
 */
export function createAppI18n(lng: UiLanguage): i18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng,
    fallbackLng: "ko",
    supportedLngs: [...UI_LANGUAGES],
    ns: [...NAMESPACES],
    defaultNS: "common",
    resources: { ko, en },
    initAsync: false,
    // React가 텍스트를 이스케이프한다 — 여기서도 하면 `&lt;`가 화면에 보인다.
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance;
}
