/**
 * 와이어(서버 JSON) 타입 — be-contracts.md 기준.
 *
 * 서버가 timestamptz를 `Date.toJSON()`으로 직렬화하므로 날짜/시각 필드는 모두
 * ISO 8601 문자열이다. 회의/화자 계약은 snake_case, 검색 계약만 camelCase다.
 * 매핑 레이어(`./mappers.ts`)가 이 형태를 `../model/types.ts`의 도메인 형태로
 * 변환한다.
 */

export { ApiError, isApiError } from "@/shared/api/client";

export type MeetingStatus = "uploaded" | "processing" | "done" | "failed";

export type SpeakerStatus = "pending" | "ready" | "provisional" | "failed";

export type UtteranceStatus = "ok" | "silence" | "transcribe_failed";

/** jsonb error 컬럼 — 고정 스키마 없음. 방어적으로 다룬다. */
export type JsonError = {
  code?: string;
  message?: string;
  stage?: string | null;
  [key: string]: unknown;
};

/** meeting row (SELECT * FROM meeting). GET /meetings, upload, favorite 응답. */
export type WireMeeting = {
  id: string;
  title: string | null;
  original_filename: string | null;
  audio_key: string;
  normalized_key: string | null;
  recorded_at: string | null;
  duration_ms: number | null;
  status: MeetingStatus;
  is_favorite: boolean;
  current_job_id: string | null;
  processing_version: number;
  error: JsonError | null;
  created_at: string;
};

/** GET /meetings/:id 응답의 발화(utterance) — speaker 필드 LEFT JOIN 포함. */
export type WireUtterance = {
  id: string;
  meeting_id: string;
  speaker_id: string | null;
  diar_label: string;
  start_ms: number;
  end_ms: number;
  text: string | null;
  confidence: number | null;
  status: UtteranceStatus;
  transcript_error: JsonError | null;
  order_index: number;
  processing_version: number;
  job_id: string | null;
  speaker_name: string | null;
  speaker_status: SpeakerStatus | null;
};

/**
 * GET /meetings/:id 응답의 클러스터(meeting_cluster + speaker LEFT JOIN).
 * 현재 processing_version 행만, diar_label 순으로. id는 실제 clu_<n> PK다.
 */
export type WireCluster = {
  id: string;
  diar_label: string;
  resolved_speaker_id: string | null;
  speaker_name: string | null;
  speaker_status: SpeakerStatus | null;
  /**
   * 성문 점수가 자동 연결 문턱(IDENTIFY_THRESHOLD)에는 못 미치지만 제안 문턱
   * (IDENTIFY_SUGGEST_THRESHOLD)은 넘은 후보. 이 클러스터는 자기 화자를 그대로
   * 갖고 있고, 이 값은 "같은 사람일 수 있다"는 제안일 뿐이다. resolve하면 서버가
   * 지운다. 세 필드는 함께 채워지거나 함께 null이다.
   */
  suggested_speaker_id: string | null;
  suggested_speaker_name: string | null;
  suggested_similarity: number | null;
};

export type SummaryStatus = "queued" | "running" | "done" | "failed";

/** GET /meetings/:id 응답의 요약 — 현재 processing_version이 아니면 서버가 null을 준다. */
export type WireSummarySegment = {
  start_utterance_id: string;
  end_utterance_id: string;
  start_ms: number;
  end_ms: number;
  title: string;
  bullets: string[];
};

export type WireSummary = {
  status: SummaryStatus;
  topics: string[];
  segments: WireSummarySegment[];
};

/** GET /meetings/:id — meeting row + utterances + clusters. */
export type WireMeetingDetail = WireMeeting & {
  utterances: WireUtterance[];
  clusters: WireCluster[];
  summary: WireSummary | null;
};

/** speaker row (SELECT * FROM speaker). enroll, list, get, rename 응답. */
export type WireSpeaker = {
  id: string;
  name: string;
  enrollment_status: SpeakerStatus;
  current_job_id: string | null;
  enrollment_error: JsonError | null;
  created_at: string;
};

/** GET /meetings/:id/status 응답. */
/** GET /meetings/:id/status의 search_index — 해당 회의 최신 index_meeting job 요약. */
export type SearchIndexStatus = {
  status: "queued" | "running" | "done" | "failed";
  error: JsonError | null;
  updated_at: string;
};

export type MeetingStatusResponse = {
  status: MeetingStatus;
  stage: string | null;
  progress: number | null;
  error: JsonError | null;
  summary_status: SummaryStatus | null;
  search_index: SearchIndexStatus | null;
};

/** POST /meetings/:id/clusters/:clusterId/resolve 요청 — 정확히 하나만. */
export type ResolveClusterRequest = {
  speaker_id?: string;
  new_name?: string;
};

/** resolve 응답. */
export type ResolveClusterResponse = {
  speaker_id: string;
  updated_utterances: number;
  merged_speaker_deleted: boolean;
};

/** POST /search 요청 — camelCase, 모든 필드 optional. */
export type SearchRequest = {
  q?: string;
  limit?: number;
  filters?: {
    dateFrom?: string | null;
    dateTo?: string | null;
    speakerIds?: string[] | null;
    meetingIds?: string[] | null;
  };
};

/** 검색 결과 1건 — camelCase, speaker는 중첩 객체. */
export type SearchResult = {
  utteranceId: string;
  meetingId: string;
  meetingTitle: string | null;
  recordedAt: string | null;
  speaker: { id: string; name: string } | null;
  diarLabel: string;
  startMs: number;
  endMs: number;
  text: string | null;
  score: number;
};

/** POST /search 응답. */
export type SearchResponse = {
  mode: "hybrid" | "keyword" | "browse";
  semantic: boolean;
  hasMore: boolean;
  results: SearchResult[];
};

/** 에러 응답 본문(정규화 이전) — NestJS 기본 형태. */
export type WireApiError = {
  statusCode: number;
  message: string;
  error?: string;
};
