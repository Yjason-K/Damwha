import { Injectable } from '@nestjs/common';
import { JobRow, Queryable } from '../jobs/jobs.types';
import { MeetingRow } from '../meetings/meetings.repository';

export interface LiveUtteranceRow {
  id: string; seq: number; start_ms: number; end_ms: number; text: string;
  speaker_id: string | null; speaker_name: string | null; similarity: number | null;
}
export interface LiveHeadRow { status: string; stage: string | null; heartbeat_at: Date | null }

@Injectable()
export class LiveRepository {
  async findRecording(exec: Queryable): Promise<MeetingRow | null> {
    const { rows } = await exec.query<MeetingRow>(`SELECT * FROM meeting WHERE status='recording' LIMIT 1`);
    return rows[0] ?? null;
  }

  async createRecording(
    exec: Queryable, args: { id: string; audioKey: string; title: string | null },
  ): Promise<MeetingRow> {
    const { rows } = await exec.query<MeetingRow>(
      `INSERT INTO meeting(id, title, audio_key, status) VALUES($1,$2,$3,'recording') RETURNING *`,
      [args.id, args.title, args.audioKey],
    );
    return rows[0];
  }

  /**
   * 세션 job 행을 먼저 잠근다 (job → meeting 순서, 워커 persist와 동일). 회의만 잠그면
   * 그 사이 claim(`FOR UPDATE SKIP LOCKED`, job 행만)이 끼어들어 이미 시작된 세션을
   * 지울 수 있다 — 설계 §4.
   */
  async lockSessionJob(exec: Queryable, meetingId: string): Promise<JobRow | null> {
    const { rows } = await exec.query<JobRow>(
      `SELECT j.* FROM job j JOIN meeting m ON m.current_job_id = j.id
       WHERE m.id=$1 AND j.type='live_session' FOR UPDATE OF j`,
      [meetingId],
    );
    return rows[0] ?? null;
  }

  async requestStop(exec: Queryable, jobId: string): Promise<JobRow> {
    const { rows } = await exec.query<JobRow>(
      `UPDATE job SET stop_requested_at = COALESCE(stop_requested_at, now()), updated_at=now()
       WHERE id=$1 RETURNING *`,
      [jobId],
    );
    return rows[0];
  }

  async findHead(exec: Queryable, meetingId: string): Promise<LiveHeadRow | null> {
    const { rows } = await exec.query<LiveHeadRow>(
      `SELECT m.status, j.stage, j.locked_at AS heartbeat_at
       FROM meeting m LEFT JOIN job j ON j.id = m.current_job_id
       WHERE m.id=$1`,
      [meetingId],
    );
    return rows[0] ?? null;
  }

  async findUtterances(exec: Queryable, meetingId: string, afterSeq: number): Promise<LiveUtteranceRow[]> {
    const { rows } = await exec.query<LiveUtteranceRow>(
      `SELECT lu.id, lu.seq, lu.start_ms, lu.end_ms, lu.text, lu.speaker_id,
              s.name AS speaker_name, lu.similarity
       FROM live_utterance lu LEFT JOIN speaker s ON s.id = lu.speaker_id
       WHERE lu.meeting_id=$1 AND lu.seq > $2
       ORDER BY lu.seq ASC`,
      [meetingId, afterSeq],
    );
    return rows;
  }
}
