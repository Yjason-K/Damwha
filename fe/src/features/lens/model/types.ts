export type LensKind = "action" | "decision" | "promise";
export type LensSource = "ai" | "user" | "edited";
export type LensCompletionStatus = "open" | "done";
export type EvidenceRelation = "primary" | "supporting";
/** 추출 모델이 매긴 확신도 — 막지 않는 힌트. low는 워커가 저장 전에 버린다. */
export type LensConfidence = "high" | "medium" | "low";

export type WireUtterance = {
  id: string;
  start_ms: number;
  text: string;
  speaker_id: string | null;
};

export type WireEvidence = {
  relation: EvidenceRelation;
  utterance: WireUtterance;
};

export type LensWireItem = {
  id: string;
  kind: LensKind;
  text: string;
  source: LensSource;
  user_modified: boolean;
  completion_status: LensCompletionStatus;
  lifecycle_status: "active" | "archived" | "dismissed";
  /** AI 항목의 확신도. 사용자 항목·예전 추출·옛 서버는 null/없음. */
  confidence?: LensConfidence | null;
  meeting_id: string;
  assignee_speaker_id: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  meeting: { id: string; title: string | null; recorded_at: string | null };
  evidence: WireEvidence[];
};

export type LensListPage = {
  items: LensWireItem[];
  next_cursor: string | null;
  /** 커서와 상관없는 같은 필터의 전체 건수. 옛 서버는 주지 않는다. */
  total?: number;
};

export type LensFilters = {
  kind: LensKind;
  completion_status: LensCompletionStatus;
  speaker_id?: string;
  meeting_id?: string;
  date_from?: string;
  date_to?: string;
};

export type ExtractionStatus = {
  running: number;
  failed: { meeting_id: string; title: string | null }[];
};
