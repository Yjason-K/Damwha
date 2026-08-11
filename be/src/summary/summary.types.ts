export type SummaryStatus = 'queued' | 'running' | 'done' | 'failed';

export interface SummarySegment {
  start_utterance_id: string;
  end_utterance_id: string;
  start_ms: number;
  end_ms: number;
  title: string;
  bullets: string[];
}

export interface SummaryRow {
  meeting_id: string;
  processing_version: number;
  status: SummaryStatus;
  model: string;
  topics: string[];
  segments: SummarySegment[];
  error: unknown;
}
