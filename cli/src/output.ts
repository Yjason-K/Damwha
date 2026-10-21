import type { LensItem, MeetingDetail, MeetingListItem, SearchResult, TranscriptUtterance } from './api-types';
import { msg, type Lang } from './messages';

export interface Out {
  write(s: string): unknown;
}

export function printJson(out: Out, value: unknown): void {
  out.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printLine(out: Out, line: string): void {
  out.write(`${line}\n`);
}

const date = (iso: string) => iso.slice(0, 10);

export function mmss(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 제목 없이 올린 회의는 title이 null이다. 텍스트 출력에 "null"을 찍지 않고 앱과 같은 이름을 쓴다. */
export const titleOf = (title: string | null, lang: Lang) => title || msg(lang, 'untitledMeeting');

export const meetingLine = (m: MeetingListItem, lang: Lang) => `${m.id}  ${date(m.recorded_at)}  ${titleOf(m.title, lang)}`;

export function meetingDetailLines(m: MeetingDetail, lang: Lang): string[] {
  const lines = [titleOf(m.title, lang), `${m.id}  ${date(m.recorded_at)}`];
  const summary = m.summary;
  if (typeof summary === 'string') lines.push('', summary);
  else if (summary) lines.push('', JSON.stringify(summary, null, 2));
  return lines;
}

export const lensLine = (l: LensItem, lang: Lang) => {
  const state = l.completion_status ? ` [${l.completion_status}]` : '';
  const due = l.due_at ? `  due ${date(l.due_at)}` : '';
  return `${l.id}  ${l.kind}${state}${due}  ${l.text}  (${titleOf(l.meeting.title, lang)}, ${l.meeting_id})`;
};

export const searchLine = (r: SearchResult, lang: Lang) =>
  `${r.meetingId}  ${date(r.recordedAt)}  ${mmss(r.startMs)}  ${r.speaker?.name ?? '-'}: ${r.text}  (${titleOf(r.meetingTitle, lang)})`;

export const utteranceLine = (u: TranscriptUtterance) =>
  `[${mmss(u.start_ms)}] ${u.speaker_name ?? '-'}: ${u.text}`;
