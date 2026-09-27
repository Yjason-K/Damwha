import { en, type Dictionary } from "./en";
import { ko } from "./ko";

export type Lang = "en" | "ko";
export type { Dictionary };

const DICTS: Record<Lang, Dictionary> = { en, ko };

export function getDictionary(lang: Lang): Dictionary {
  return DICTS[lang];
}

export function otherLang(lang: Lang): Lang {
  return lang === "en" ? "ko" : "en";
}
