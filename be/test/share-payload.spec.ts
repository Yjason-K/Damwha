import type { ShareScope } from '@damwha/share-format';
import { buildPayload, SummaryNotReadyError } from '../src/shares/share-payload';
import type { MeetingSnapshot } from '../src/shares/share-snapshot';

const NOW = new Date('2026-10-09T00:00:00.000Z');
const ALL: ShareScope = { summary: true, lenses: true, transcript: true, note: true, anonymize: false };

const snap = (): MeetingSnapshot => ({
  meeting: { title: '주간 회의', recorded_at: new Date('2026-10-08T01:00:00.000Z'), duration_ms: 60_000, processing_version: 2 },
  summary: { status: 'done', topics: ['배포'], segments: [{ start_utterance_id: 'utt_9', end_utterance_id: 'utt_9', start_ms: 1000, end_ms: 3000, title: '배포', bullets: ['화요일'] }] },
  lenses: [
    { kind: 'action', text: '릴리스 노트', completion_status: 'open', due_at: '2026-10-14', assignee_speaker_id: 'spk_1', assignee_name: '김담화', primary: { start_ms: 1000, processing_version: 2, shared: true } },
    { kind: 'decision', text: '화요일 배포', completion_status: 'done', due_at: null, assignee_speaker_id: 'spk_7', assignee_name: '이참석', primary: { start_ms: 500, processing_version: 1, shared: false } },
    { kind: 'promise', text: '근거 없음', completion_status: 'open', due_at: null, assignee_speaker_id: null, assignee_name: null, primary: null },
    { kind: 'action', text: '침묵 근거', completion_status: 'open', due_at: null, assignee_speaker_id: null, assignee_name: null, primary: { start_ms: 6000, processing_version: 2, shared: false } },
  ],
  utterances: [
    { speaker_key: 'spk_1', speaker_name: '김담화', start_ms: 1000, end_ms: 3000, text: '화요일에 하죠' },
    { speaker_key: 'SPEAKER_01', speaker_name: null, start_ms: 4000, end_ms: 5000, text: '좋아요' },
  ],
  note: '## 메모',
});

const build = (scope: Partial<ShareScope>, s = snap()) =>
  buildPayload(s, { ...ALL, ...scope }, { now: NOW, uiLanguage: 'ko' });

it('허용 목록의 키만 나간다 — 내부 id·source·is_me·인용이 없다', () => {
  const p = build({});
  expect(Object.keys(p).sort()).toEqual(['created_at', 'lenses', 'meeting', 'note', 'speakers', 'summary', 'transcript', 'ui_language', 'v']);
  expect(Object.keys(p.meeting).sort()).toEqual(['duration_ms', 'recorded_at', 'title']);
  expect(Object.keys(p.summary!.segments[0]).sort()).toEqual(['bullets', 'end_ms', 'start_ms', 'title']);
  expect(Object.keys(p.lenses![0]).sort()).toEqual(['assignee_ref', 'done', 'due_at', 'kind', 'linkable', 'start_ms', 'text']);
  expect(Object.keys(p.transcript![0]).sort()).toEqual(['end_ms', 'speaker_ref', 'start_ms', 'text']);
  expect(JSON.stringify(p)).not.toMatch(/utt_|spk_|mtg_|lens_|SPEAKER_/);
});

it('화자 ref는 등장 순서 s1, s2… 이고 공유본에 나오는 화자만 담는다', () => {
  const p = build({});
  expect(p.speakers).toEqual([
    { ref: 's1', name: '김담화' },
    { ref: 's2', name: null },
    { ref: 's3', name: '이참석' },
  ]);
  expect(p.transcript!.map((u) => u.speaker_ref)).toEqual(['s1', 's2']);
  expect(p.lenses!.map((l) => l.assignee_ref)).toEqual(['s1', 's3', null, null]);
  expect(build({ transcript: false, lenses: false }).speakers).toEqual([]);
});

it('익명화는 발화 기록의 화자와 렌즈 담당자 두 곳에 같이 걸린다', () => {
  const p = build({ anonymize: true });
  expect(p.speakers.every((s) => s.name === null)).toBe(true);
  expect(JSON.stringify(p)).not.toContain('김담화');
  expect(JSON.stringify(p)).not.toContain('이참석');
});

it('익명화는 자유 텍스트 안의 이름을 바꾸지 않는다 (spec §2.1)', () => {
  const s = snap();
  s.summary!.segments[0].bullets = ['김담화 님이 정리'];
  expect(build({ anonymize: true }, s).summary!.segments[0].bullets).toEqual(['김담화 님이 정리']);
});

it('근거가 공유되는 발화일 때만 linkable — 예전 버전·silence·빈 본문이면 false, 근거가 없으면 start_ms=null', () => {
  const p = build({});
  expect(p.lenses!.map((l) => [l.start_ms, l.linkable])).toEqual([[1000, true], [500, false], [null, false], [6000, false]]);
  expect(p.lenses!.map((l) => l.done)).toEqual([false, true, false, false]);
});

it('발화 기록을 빼면 근거가 공유될 발화여도 linkable=false (시각은 남는다)', () => {
  const p = build({ transcript: false });
  expect(p.lenses!.map((l) => [l.start_ms, l.linkable])).toEqual([[1000, false], [500, false], [null, false], [6000, false]]);
});

it('고르지 않은 섹션은 키째 없다', () => {
  const p = build({ summary: false, lenses: false, transcript: false, note: false });
  expect(p).not.toHaveProperty('summary');
  expect(p).not.toHaveProperty('lenses');
  expect(p).not.toHaveProperty('transcript');
  expect(p).not.toHaveProperty('note');
});

it('요약을 골랐는데 done이 아니거나 없으면 SummaryNotReadyError', () => {
  const s = snap();
  s.summary!.status = 'failed';
  expect(() => build({}, s)).toThrow(SummaryNotReadyError);
  expect(() => build({}, { ...snap(), summary: null })).toThrow(SummaryNotReadyError);
  expect(() => build({ summary: false }, { ...snap(), summary: null })).not.toThrow();
});

it('메모가 없으면 note를 골라도 키가 없다, 발화 0개면 빈 배열', () => {
  const p = build({}, { ...snap(), note: null, utterances: [] });
  expect(p).not.toHaveProperty('note');
  expect(p.transcript).toEqual([]);
});

it('시각과 언어', () => {
  const p = build({});
  expect(p).toMatchObject({ v: 1, created_at: NOW.toISOString(), ui_language: 'ko' });
  expect(p).not.toHaveProperty('expires_at');
  expect(p.meeting.recorded_at).toBe('2026-10-08T01:00:00.000Z');
});
