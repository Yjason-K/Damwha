import type { UiLanguage } from "@damwha/contracts";

export function formatShareDate(iso: string, lang: UiLanguage): string {
  return new Intl.DateTimeFormat(lang === "ko" ? "ko-KR" : "en-US", {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** 남은 날(올림). 경고 문구의 "N일 남음". */
export function daysLeft(iso: string, now: Date = new Date()): number {
  return Math.max(1, Math.ceil((Date.parse(iso) - now.getTime()) / 86_400_000));
}
