import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isUiLanguage, pickUiLanguage, type UiLanguage } from '@damwha/contracts';

/** 사용자용 메시지의 언어는 앱 UI 언어를 따른다 (spec §2.4). MCP 도구 이름·스키마는 영어 고정이라 여기 오지 않는다. */
export type Lang = UiLanguage;

export const MESSAGES = {
  ko: {
    notRunning: '담화가 실행 중이 아닙니다. 담화를 실행하면 사용할 수 있습니다.',
    starting: '담화가 아직 준비 중입니다. 잠시 후 다시 시도하세요.',
    noMeSpeaker: '담화에서 본인 화자를 지정해야 합니다(화자 → 나로 표시)',
    alreadyDone: '이미 완료된 항목입니다.',
    completeConfirm: '"{title}" 항목을 완료로 표시할까요?',
    completeDeclined: '완료 처리하지 않았습니다.',
    modelsNotReady: '모델이 아직 준비되지 않았습니다. 업로드는 진행하며, 처리는 모델이 준비된 뒤 시작됩니다.',
    waitInterrupted: '기다리기만 중단했습니다. 서버 처리는 계속됩니다.',
    invalidOption: '--{option} 값이 올바르지 않습니다. 허용 값: {allowed}',
  },
  en: {
    notRunning: 'Damwha is not running. Start Damwha to use this.',
    starting: 'Damwha is still starting up. Try again in a moment.',
    noMeSpeaker: 'Mark yourself as a speaker in Damwha first (Speakers → mark as Me).',
    alreadyDone: 'This item is already completed.',
    completeConfirm: 'Mark "{title}" as completed?',
    completeDeclined: 'Not marked as completed.',
    modelsNotReady: 'Models are not ready yet. The upload proceeds; processing starts once they are ready.',
    waitInterrupted: 'Stopped waiting only. Server-side processing continues.',
    invalidOption: 'Invalid value for --{option}. Allowed: {allowed}',
  },
} as const;

export type MessageKey = keyof (typeof MESSAGES)['ko'];

export function msg(lang: Lang, key: MessageKey, params: Record<string, string | number> = {}): string {
  return MESSAGES[lang][key].replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m,
  );
}

/**
 * `<userData>/ui-language.json`(`{ "language": "ko" }`)이 원본이다. 없거나 깨졌으면 시스템 로캘에서 고른다.
 * 메시지 언어를 못 읽는다고 CLI가 죽을 이유는 없어 읽기는 던지지 않는다.
 */
export async function detectLang(userDataDir: string): Promise<Lang> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(userDataDir, 'ui-language.json'), 'utf8'));
    const lang = (parsed as { language?: unknown } | null)?.language;
    if (isUiLanguage(lang)) return lang;
  } catch {
    // 파일 없음·깨진 JSON은 로캘 폴백으로 간다.
  }
  return pickUiLanguage([Intl.DateTimeFormat().resolvedOptions().locale]);
}
