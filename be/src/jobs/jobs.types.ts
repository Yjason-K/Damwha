import { Pool } from 'pg';

export type Queryable = Pick<Pool, 'query'>;
export type JobType = 'process_meeting' | 'enroll_speaker' | 'index_meeting' | 'extract_lenses';
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
  error: any;
  created_at: Date;
  updated_at: Date;
}
