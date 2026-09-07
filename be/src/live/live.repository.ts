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
      `SELECT id AS job_id FROM job WHERE meeting_id=$1 AND type='live_session'
       ORDER BY created_at DESC LIMIT 1`, [meetingId]);
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

  /** 확정 경계 전진. fdatasync 완료 후에만 부른다 — last_input_at도 같이 갱신한다,
   *  경계가 전진했다는 사실 자체가 producer가 방금 살아 있었다는 증거이기 때문이다
   *  (설계 §3.3 ④). 신규 job 생성 TX에서 bytes=0으로도 부른다. */
  async setCommitted(exec: Queryable, jobId: string, bytes: number): Promise<void> {
    await exec.query(
      `UPDATE job SET committed_bytes=$2, last_input_at=now(), updated_at=now() WHERE id=$1`,
      [jobId, bytes],
    );
  }

  async setCaptureError(exec: Queryable, meetingId: string, err: object): Promise<void> {
    await exec.query(`UPDATE meeting SET capture_error=$2::jsonb WHERE id=$1`,
      [meetingId, JSON.stringify(err)]);
  }

  /** 먼저 기록된 사유를 덮지 않는다. 브라우저가 보낸 "마이크가 끊겼다"가 API가 나중에
   *  덧붙이는 "미리보기 워커를 잃었다"보다 사용자에게 훨씬 중요하다. */
  async setCaptureErrorIfUnset(exec: Queryable, meetingId: string, err: object): Promise<void> {
    await exec.query(`UPDATE meeting SET capture_error=$2::jsonb WHERE id=$1 AND capture_error IS NULL`,
      [meetingId, JSON.stringify(err)]);
  }

  /**
   * 스위퍼가 손봐야 할 라이브 세션. 두 종류다.
   *
   * (a) 봉인 전 — 버려진 producer. 두 번째 갈래가 필수다: 브라우저가 /meetings/live 성공
   *     뒤 첫 POST 전에 죽으면 last_input_at이 NULL이라 첫 갈래에 영원히 안 걸린다.
   *
   * (b) 봉인 후 — 마무리할 워커가 없다. 봉인은 됐는데 회의가 아직 'recording'이고 job이
   *     더는 running이 아니면, 그 job을 끝낼 워커는 존재하지 않는다. 이 상태는 워커가
   *     claim한 뒤 죽고(그래서 stop/스위퍼가 봉인만 하고 워커에게 맡겼는데) reaper가
   *     뒤늦게 그 job을 failed로 내린 뒤에 생긴다. 여기서 안 집으면 회의가 'recording'에
   *     영원히 갇히고 부분 유일 인덱스가 다음 녹음까지 막는다.
   *
   *     워커 생존 판정을 여기서 새로 하지 않고 job.status에 맡기는 것이 핵심이다 —
   *     "이 워커는 죽었다"를 정하는 임계값은 이미 reaper 하나뿐이어야 한다.
   */
  async findOrphanCandidates(exec: Queryable, seconds: number): Promise<Array<{ job_id: string; meeting_id: string }>> {
    const { rows } = await exec.query<{ job_id: string; meeting_id: string }>(
      `SELECT j.id AS job_id, m.id AS meeting_id
       FROM job j JOIN meeting m ON m.current_job_id = j.id
       WHERE j.type='live_session' AND m.status='recording'
         AND ( ( j.sealed_bytes IS NULL
                 AND ( j.last_input_at <  now() - ($1||' seconds')::interval
                    OR (j.last_input_at IS NULL AND j.created_at < now() - ($1||' seconds')::interval) ) )
            OR ( j.sealed_bytes IS NOT NULL AND j.status <> 'running' ) )`,
      [String(seconds)]);
    return rows;
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
