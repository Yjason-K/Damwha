export type LensKind = "action" | "decision" | "promise";
export type LensSource = "ai" | "user" | "edited";
export type LensCompletionStatus = "open" | "done";
export type EvidenceRelation = "primary" | "supporting";

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
  lifecycle_status: "active" | "archived";
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
