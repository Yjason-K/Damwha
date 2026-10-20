import type { LensItem, MeetingDetail, MeetingListItem, SearchResult, TranscriptUtterance } from './api-types';

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

export const meetingLine = (m: MeetingListItem) => `${m.id}  ${date(m.recorded_at)}  ${m.title}`;

export function meetingDetailLines(m: MeetingDetail): string[] {
  const lines = [m.title, `${m.id}  ${date(m.recorded_at)}`];
  const summary = m.summary;
  if (typeof summary === 'string') lines.push('', summary);
  else if (summary) lines.push('', JSON.stringify(summary, null, 2));
  return lines;
}

export const lensLine = (l: LensItem) => {
  const state = l.completion_status ? ` [${l.completion_status}]` : '';
  const due = l.due_at ? `  due ${date(l.due_at)}` : '';
  return `${l.id}  ${l.kind}${state}${due}  ${l.text}  (${l.meeting.title}, ${l.meeting_id})`;
};

export const searchLine = (r: SearchResult) =>
  `${r.meetingId}  ${date(r.recordedAt)}  ${mmss(r.startMs)}  ${r.speaker?.name ?? '-'}: ${r.text}  (${r.meetingTitle})`;

export const utteranceLine = (u: TranscriptUtterance) =>
  `[${mmss(u.start_ms)}] ${u.speaker_name ?? '-'}: ${u.text}`;
