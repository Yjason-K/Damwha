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

  async findHead(exec: Queryable, meetingId: string): Promise<LiveHeadRow | null> {
    const { rows } = await exec.query<LiveHeadRow>(
      `SELECT m.status, j.stage, j.locked_at AS heartbeat_at
       FROM meeting m LEFT JOIN job j ON j.id = m.current_job_id
       WHERE m.id=$1`,
      [meetingId],
    );
    return rows[0] ?? null;
  }

  /**
   * 잠그지 않는 사전 조회. 잠금 순서가 job → meeting이라 job id를 먼저 알아야 한다.
   *
   * meeting_id로 찾는다 — meeting.current_job_id가 아니다. stop()의 멱등 재시도(설계 §3.4)는
   * API가 이미 finalize해 current_job_id가 다음(process_meeting) job으로 넘어간 뒤에도 원래
   * live_session job을 찾아 sealed_bytes를 비교해야 한다. "이 job이 지금도 meeting을 대표하는가"는
   * 호출자가 필요할 때 meeting.current_job_id와 직접 비교한다(append/stop 모두 그렇게 한다).
   */
  async findLiveJob(exec: Queryable, meetingId: string): Promise<{ job_id: string } | null> {
    const { rows } = await exec.query<{ job_id: string }>(
      `SELECT id AS job_id FROM job WHERE meeting_id=$1 AND type='live_session'`, [meetingId]);
    return rows[0] ?? null;
  }

  async lockJobById(exec: Queryable, jobId: string): Promise<JobRow | null> {
    const { rows } = await exec.query<JobRow>(`SELECT * FROM job WHERE id=$1 FOR UPDATE`, [jobId]);
    return rows[0] ?? null;
  }

  /** 봉인. sealed_bytes와 stop_requested_at을 같은 트랜잭션에서 쓴다 — 워커가 한 SELECT로
   *  둘을 읽으므로 따로 쓰면 신호는 왔는데 길이가 없는 순간이 생긴다 (설계 §4.4). */
  async seal(exec: Queryable, jobId: string, sealedBytes: number): Promise<void> {
    await exec.query(
      `UPDATE job SET sealed_bytes=$2, stop_requested_at=COALESCE(stop_requested_at, now()),
                      updated_at=now() WHERE id=$1`, [jobId, sealedBytes],
    );
  }

  /** producer 생존 신호. 워커 heartbeat(locked_at)는 tail 대기 중에도 뛰므로 별개다. */
  async markInput(exec: Queryable, jobId: string): Promise<void> {
    await exec.query(`UPDATE job SET last_input_at=now(), updated_at=now() WHERE id=$1`, [jobId]);
  }

  async setCaptureError(exec: Queryable, meetingId: string, err: object): Promise<void> {
    await exec.query(`UPDATE meeting SET capture_error=$2::jsonb WHERE id=$1`,
      [meetingId, JSON.stringify(err)]);
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
