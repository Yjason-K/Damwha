import type { UiLanguage } from '@damwha/contracts';

/** 사용자가 고른 공유 범위 (spec §2.1). anonymize는 구조화된 화자 이름에만 적용된다. */
export type ShareScope = {
  summary: boolean;
  lenses: boolean;
  transcript: boolean;
  note: boolean;
  anonymize: boolean;
};

export type ShareSpeaker = { ref: string; name: string | null };
export type ShareSummarySegment = { title: string; bullets: string[]; start_ms: number; end_ms: number };
export type ShareLens = {
  kind: 'action' | 'decision' | 'promise';
  text: string;
  done: boolean;
  due_at: string | null;
  assignee_ref: string | null;
  start_ms: number | null;
  /** primary 근거가 현재 버전 발화일 때만 true — 그때만 뷰어가 발화 목록으로 스크롤한다 (spec §2.1). */
  linkable: boolean;
};
export type ShareUtterance = { speaker_ref: string | null; start_ms: number; end_ms: number; text: string };

/**
 * 만료 시각은 페이로드에 없다 — 권위는 공유 서버다(spec selfhost-v2 §2.4). 암호화는 업로드 전에 끝나므로 여기 넣으면
 * 서버가 정한 실제 값과 어긋난다. 뷰어는 GET 응답의 `X-Share-Expires-At`으로 받는다.
 */
export type SharePayloadV1 = {
  v: 1;
  created_at: string;
  ui_language: UiLanguage;
  meeting: { title: string | null; recorded_at: string; duration_ms: number | null };
  speakers: ShareSpeaker[];
  summary?: { topics: string[]; segments: ShareSummarySegment[] };
  lenses?: ShareLens[];
  transcript?: ShareUtterance[];
  note?: { body_md: string };
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * 복호화한 값이 v1인지. GCM이 "키를 가진 쪽이 만들었다"는 건 보장하므로 여기서는 버전과 섹션의 큰 모양만 본다 —
 * 렌더러가 배열 대신 객체를 받아 깨지는 일을 막는 정도면 된다.
 */
export function isSharePayloadV1(x: unknown): x is SharePayloadV1 {
  if (!isObj(x)) return false;
  return (
    x.v === 1 &&
    typeof x.created_at === 'string' &&
    (x.ui_language === 'ko' || x.ui_language === 'en') &&
    isObj(x.meeting) &&
    Array.isArray(x.speakers) &&
    (x.summary === undefined || (isObj(x.summary) && Array.isArray(x.summary.topics) && Array.isArray(x.summary.segments))) &&
    (x.lenses === undefined || Array.isArray(x.lenses)) &&
    (x.transcript === undefined || Array.isArray(x.transcript)) &&
    (x.note === undefined || (isObj(x.note) && typeof x.note.body_md === 'string'))
  );
}
