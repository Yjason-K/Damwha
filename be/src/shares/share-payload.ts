import type { UiLanguage } from '@damwha/contracts';
import type { SharePayloadV1, ShareScope, ShareSpeaker } from '@damwha/share-format';
import type { MeetingSnapshot } from './share-snapshot';

export class SummaryNotReadyError extends Error {
  constructor() {
    super('the summary is not ready to share');
    this.name = 'SummaryNotReadyError';
  }
}

/**
 * 스냅샷 → 공유 페이로드 (spec §2.1·§2.2). 허용 목록으로 **새로 만든다** — DB 행을 펼치지 않으므로 표에 없는
 * 필드(내부 id, source, is_me, 근거 인용)는 나갈 길이 없다. 화자 ref는 발화 기록 → 렌즈 담당자 순서로 처음
 * 나온 차례대로 s1, s2…다. 익명화는 이 ref의 이름만 지운다 — 요약·렌즈 문장 속 이름은 그대로다.
 */
export function buildPayload(
  snap: MeetingSnapshot,
  scope: ShareScope,
  opts: { now: Date; uiLanguage: UiLanguage },
): SharePayloadV1 {
  if (scope.summary && snap.summary?.status !== 'done') throw new SummaryNotReadyError();

  const speakers = new Map<string, ShareSpeaker>();
  const refOf = (key: string, name: string | null): string => {
    let sp = speakers.get(key);
    if (!sp) {
      sp = { ref: `s${speakers.size + 1}`, name: scope.anonymize ? null : name };
      speakers.set(key, sp);
    }
    return sp.ref;
  };

  const payload: SharePayloadV1 = {
    v: 1,
    created_at: opts.now.toISOString(),
    ui_language: opts.uiLanguage,
    meeting: {
      title: snap.meeting.title,
      recorded_at: snap.meeting.recorded_at.toISOString(),
      duration_ms: snap.meeting.duration_ms,
    },
    speakers: [],
  };
  if (scope.summary && snap.summary) {
    payload.summary = {
      topics: snap.summary.topics,
      segments: snap.summary.segments.map((s) => ({ title: s.title, bullets: s.bullets, start_ms: s.start_ms, end_ms: s.end_ms })),
    };
  }
  if (scope.transcript) {
    payload.transcript = snap.utterances.map((u) => ({
      speaker_ref: refOf(u.speaker_key, u.speaker_name),
      start_ms: u.start_ms,
      end_ms: u.end_ms,
      text: u.text,
    }));
  }
  if (scope.lenses) {
    payload.lenses = snap.lenses.map((l) => ({
      kind: l.kind,
      text: l.text,
      done: l.completion_status === 'done',
      due_at: l.due_at,
      assignee_ref: l.assignee_speaker_id === null ? null : refOf(l.assignee_speaker_id, l.assignee_name),
      start_ms: l.primary?.start_ms ?? null,
      // 발화 기록을 빼고 공유하면 스크롤할 대상이 없다 — 근거가 공유되는 발화여도 false.
      linkable: scope.transcript && l.primary?.shared === true,
    }));
  }
  // 빈 메모는 키를 빼야 뷰어가 빈 "메모" 섹션을 그리지 않는다.
  if (scope.note && snap.note !== null && snap.note.trim() !== '') payload.note = { body_md: snap.note };
  payload.speakers = [...speakers.values()];
  return payload;
}
