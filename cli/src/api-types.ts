// be 응답에서 CLI·MCP가 쓰는 최소 필드만 옮긴 타입. be가 바뀌면 여기를 맞춘다.

export type LensKind = string;
export type StageState = 'pending' | 'queued' | 'running' | 'done' | 'failed' | 'skipped';

export interface Health {
  status: 'ok';
  db: 'ok';
  instance: string | null;
}

export interface LensEvidence {
  relation: string;
  utterance: { id: string; start_ms: number; text: string; speaker_id: string | null };
}

export interface LensItem {
  id: string;
  kind: LensKind;
  text: string;
  source: string;
  user_modified: boolean;
  completion_status: 'open' | 'done' | null;
  lifecycle_status: string;
  confidence: number | null;
  meeting_id: string;
  assignee_speaker_id: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  meeting: { id: string; title: string; recorded_at: string };
  evidence: LensEvidence[];
}

export interface LensPage {
  items: LensItem[];
  next_cursor: string | null;
  total: number;
}

/** due_from/due_to는 렌즈 due_at 범위다. API 쿼리로는 date_from/date_to가 된다. */
export interface LensQuery {
  kind?: LensKind;
  meeting_id?: string;
  folder_id?: string;
  speaker_id?: string;
  due_from?: string;
  due_to?: string;
  completion_status?: 'open' | 'done';
  lifecycle_status?: string;
  limit?: number;
  cursor?: string;
}

export interface MeetingListItem {
  id: string;
  title: string;
  recorded_at: string;
  [key: string]: unknown;
}

export interface MeetingPage {
  items: MeetingListItem[];
  next_cursor: string | null;
}

/** GET /meetings/:id — 발화·요약·태그 등 본문 필드는 호출부가 쓰는 만큼만 좁힌다. */
export interface MeetingDetail {
  id: string;
  title: string;
  recorded_at: string;
  [key: string]: unknown;
}

export interface TranscriptUtterance {
  id: string;
  start_ms: number;
  end_ms: number;
  speaker_id: string | null;
  speaker_name: string | null;
  text: string;
}

export interface TranscriptPage {
  meeting_id: string;
  processing_version: number;
  total: number;
  offset: number;
  limit: number;
  next_offset: number | null;
  utterances: TranscriptUtterance[];
}

export interface MeetingStatus {
  stages: { process: StageState; summary: StageState; lens: StageState };
  [key: string]: unknown;
}

export interface SearchBody {
  q?: string;
  limit?: number;
  filters?: {
    dateFrom?: string;
    dateTo?: string;
    speakerIds?: string[];
    meetingIds?: string[];
    tagIds?: string[];
    folderIds?: string[];
  };
}

export interface SearchResult {
  utteranceId: string;
  meetingId: string;
  meetingTitle: string;
  recordedAt: string;
  speaker: { id: string; name: string } | null;
  startMs: number;
  endMs: number;
  text: string;
  score: number;
}

export interface SearchResponse {
  mode: string;
  semantic: boolean;
  hasMore: boolean;
  results: SearchResult[];
}

export interface Speaker {
  id: string;
  name: string;
  is_me: boolean;
  [key: string]: unknown;
}

export interface Folder {
  id: string;
  name: string;
  [key: string]: unknown;
}

/** GET /models — upload의 준비 경고가 읽는 필드만. */
export interface ModelInfo {
  models: { role: string; name: string; inUseFor: string[]; installed: 'yes' | 'no' | 'partial' | 'unknown' }[];
  [key: string]: unknown;
}
