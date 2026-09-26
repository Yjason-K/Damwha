import { useTranslation } from "react-i18next";
import { UI_LANGUAGES, isUiLanguage, type UiLanguage } from "@damwha/contracts";
import { languageStore, useUiLanguage } from "@/shared/i18n";
import { Card } from "@/shared/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";

/** 각 언어의 자기 이름. 사전에 두지 않는다 — 어느 화면 언어에서도 같은 글자여야 한다 (다국어 스펙 §4.3). */
const AUTONYMS: Record<UiLanguage, string> = {
  ko: "한국어", // i18n-allow: autonym
  en: "English",
};

/** 설정 › 일반. 앱 전체에 걸리는 값 — 지금은 화면 언어 하나. */
export function GeneralSettingsSection() {
  const { t } = useTranslation("settings");
  const language = useUiLanguage();
  return (
    <section aria-labelledby="settings-general">
      <Card className="flex flex-col gap-5">
        <header className="flex flex-col gap-1">
          <h2
            id="settings-general"
            className="text-h2 font-semibold text-foreground"
          >
            {t("general.title")}
          </h2>
          <p className="text-sm text-[color:var(--text-muted)]">
            {t("general.description")}
          </p>
        </header>
        <div className="flex flex-col gap-1.5">
          <span
            id="settings-display-language"
            className="text-sm font-medium text-[color:var(--text-secondary)]"
          >
            {t("general.displayLanguage.label")}
          </span>
          <Select
            value={language}
            onValueChange={(v) => {
              if (isUiLanguage(v)) languageStore.choose(v);
            }}
          >
            <SelectTrigger aria-labelledby="settings-display-language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UI_LANGUAGES.map((lang) => (
                <SelectItem key={lang} value={lang}>
                  {AUTONYMS[lang]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-[color:var(--text-muted)]">
            {t("general.displayLanguage.hint")}
          </p>
        </div>
      </Card>
    </section>
  );
}
