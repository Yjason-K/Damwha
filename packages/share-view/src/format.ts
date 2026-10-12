import type { UiLanguage } from '@damwha/contracts';

/** 65_000 → "1:05", 3_725_000 → "1:02:05". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function dateTime(iso: string, lang: UiLanguage): string {
  return new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso));
}
