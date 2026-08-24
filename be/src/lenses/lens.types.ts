export const LENS_KINDS = ['action', 'decision', 'promise'] as const;
export type LensKind = typeof LENS_KINDS[number];
export type LensSource = 'ai' | 'user' | 'edited';
export type LensCompletionStatus = 'open' | 'done';
export type LensLifecycleStatus = 'active' | 'archived';
export type EvidenceRelation = 'primary' | 'supporting';

export type LensListFilters = {
  kind?: LensKind;
  meeting_id?: string;
  speaker_id?: string;
  date_from?: string;
  date_to?: string;
  completion_status?: LensCompletionStatus;
  lifecycle_status?: LensLifecycleStatus;
  limit?: number;
  cursor?: string;
};

// A lens_item row joined with its meeting title (the `_at` timestamps are pg Date
// objects, due_at is cast to text so it serialises as a bare YYYY-MM-DD).
export interface LensItemRow {
  id: string;
  meeting_id: string;
  kind: LensKind;
  text: string;
  assignee_speaker_id: string | null;
  due_at: string | null;
  completion_status: LensCompletionStatus;
  source: LensSource;
  user_modified: boolean;
  lifecycle_status: LensLifecycleStatus;
  created_at: Date;
  updated_at: Date;
  meeting_title: string | null;
}

export interface EvidenceRow {
  lens_item_id: string;
  relation: EvidenceRelation;
  utterance: Record<string, unknown>;
}

// A decoded keyset cursor: { updated_at, id } base64url-encoded as JSON.
export interface LensCursor {
  updated_at: string;
  id: string;
}

// One lens candidate emitted by the AI extractor for a meeting. Evidence is
// referenced by utterance id; the primary anchors the item, supporting adds context.
export type AiLensCandidate = {
  kind: LensKind;
  text: string;
  assignee_speaker_id: string | null;
  due_at: string | null;
  primary_utterance_id: string;
  supporting_utterance_ids: string[];
};

// The minimal existing-item shape classifyAiMerge reasons over: identity, the
// eligibility fields, and the utterance currently in the primary evidence slot.
export interface ExistingLensForMerge {
  id: string;
  kind: LensKind;
  source: LensSource;
  user_modified: boolean;
  lifecycle_status: LensLifecycleStatus;
  completion_status: LensCompletionStatus;
  primary_utterance_id: string | null;
}

// Ordered merge decisions: updates/creates in candidate order, then archives.
export type AiMergeDecision =
  | { type: 'update'; lens_id: string; candidate: AiLensCandidate }
  | { type: 'create'; candidate: AiLensCandidate }
  | { type: 'archive'; lens_id: string };
