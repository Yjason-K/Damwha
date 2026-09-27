import { useSyncExternalStore } from "react";
import type { UiLanguage } from "@damwha/contracts";
import { createAppI18n } from "./create-i18n";
import { browserLanguageEnv, createLanguageStore } from "./language-store";

export const languageStore = createLanguageStore(browserLanguageEnv());
export const i18n = createAppI18n(languageStore.getSnapshot());

// 저장소가 원본, i18n은 따라간다. changeLanguage는 리소스가 번들 안이라 동기로 끝난다.
languageStore.subscribe(() => {
  void i18n.changeLanguage(languageStore.getSnapshot());
});

export function useUiLanguage(): UiLanguage {
  return useSyncExternalStore(languageStore.subscribe, languageStore.getSnapshot);
}
