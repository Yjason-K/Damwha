import { Pool } from 'pg';

export type Queryable = Pick<Pool, 'query'>;
export type JobType =
  | 'process_meeting'
  | 'enroll_speaker'
  | 'index_meeting'
  | 'extract_lenses'
  | 'summarize_meeting'
  | 'live_session';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface JobRow {
  id: string;
  type: JobType;
  meeting_id: string | null;
  payload: any;
  status: JobStatus;
  stage: string | null;
  progress: number;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: Date | null;
  next_attempt_at: Date | null;
  stop_requested_at: Date | null;
  error: any;
  created_at: Date;
  updated_at: Date;
  /** 봉인된 최종 PCM 바이트 수. bigint라 pg가 문자열로 돌려준다. 미봉인이면 null (마이그레이션 023). */
  sealed_bytes: string | null;
  /** producer(브라우저 append) 생존 신호. 워커 heartbeat(locked_at)와는 별개다 (마이그레이션 023). */
  last_input_at: Date | null;
  /** fdatasync 완료 후 커밋된 연속 prefix 길이. bigint라 pg가 문자열로 돌려준다.
   *  live_session이 아니거나 아직 시작 전이면 null (마이그레이션 024). */
  committed_bytes: string | null;
}
