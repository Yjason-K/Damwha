import { Injectable } from '@nestjs/common';
import { Queryable } from '../jobs/jobs.types';

export interface SpeakerRow {
  id: string; name: string; enrollment_status: string;
  current_job_id: string | null; enrollment_error: any; created_at: Date;
  /** '나'로 지정된 화자 (031). 최대 한 명 — speaker_single_me_idx. */
  is_me: boolean;
}

// 목록/단건에만 실리는 미리듣기 좌표. 셋은 함께 오거나 함께 null이다.
// meetings·suggestion은 화자 관리의 "확인 필요" 섹션이 쓴다(UX 리뷰 2026-10-15).
export interface SpeakerWithSample extends SpeakerRow {
  sample_meeting_id: string | null;
  sample_start_ms: number | null;
  sample_end_ms: number | null;
  /** 현재 처리 버전에서 이 화자에 묶인 클러스터가 있는 회의, 최신순. */
  meetings: { id: string; title: string | null }[];
  /** 이 화자로 묶인 클러스터에 남은 "같은 사람일 수 있음" 후보 중 유사도가 가장 높은 것. */
  suggestion: { id: string; name: string; similarity: number } | null;
}

// 화자를 알아듣게 해줄 발화 한 개를 고른다 — 저장된 샘플 파일이 아니라 회의
// 오디오의 한 구간이라, 등록 화자든 회의에서 자동 생성된 provisional이든 똑같이
// 커버된다. 프런트는 이 좌표를 /meetings/:id/audio#t=start,end 로 재생한다.
//   status='ok'  — silence/transcribe_failed 구간은 들려줄 소리가 없다.
//   m.status='done' — 처리 중 회의의 오디오는 워커가 os.replace로 갈아치운다.
//                     그 파일을 겨눈 미리듣기는 재생 도중 끊긴다.
const SAMPLE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT u.meeting_id, u.start_ms, u.end_ms
      FROM utterance u
      JOIN meeting m ON m.id = u.meeting_id
     WHERE u.speaker_id = s.id AND u.status = 'ok' AND m.status = 'done'
     ORDER BY (u.end_ms - u.start_ms) DESC, u.id
     LIMIT 1
  ) smp ON true`;

const SAMPLE_COLUMNS = `s.*,
         smp.meeting_id AS sample_meeting_id,
         smp.start_ms   AS sample_start_ms,
         smp.end_ms     AS sample_end_ms,
         (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', m.id, 'title', m.title)
                                    ORDER BY m.created_at DESC), '[]'::jsonb)
            FROM meeting m
           WHERE EXISTS (SELECT 1 FROM meeting_cluster c
                          WHERE c.meeting_id = m.id AND c.resolved_speaker_id = s.id
                            AND c.processing_version = m.processing_version)
         ) AS meetings,
         (SELECT jsonb_build_object('id', sg.id, 'name', sg.name, 'similarity', c.suggested_similarity)
            FROM meeting_cluster c JOIN speaker sg ON sg.id = c.suggested_speaker_id
           WHERE c.resolved_speaker_id = s.id
           ORDER BY c.suggested_similarity DESC NULLS LAST, c.id
           LIMIT 1
         ) AS suggestion`;

@Injectable()
export class SpeakersRepository {
  async create(exec: Queryable, id: string, name: string): Promise<SpeakerRow> {
    const { rows } = await exec.query<SpeakerRow>(
      `INSERT INTO speaker(id, name, enrollment_status) VALUES($1,$2,'pending') RETURNING *`,
      [id, name],
    );
    return rows[0];
  }
  async setCurrentJob(exec: Queryable, id: string, jobId: string): Promise<SpeakerRow> {
    const { rows } = await exec.query<SpeakerRow>(
      `UPDATE speaker SET current_job_id=$2 WHERE id=$1 RETURNING *`, [id, jobId],
    );
    return rows[0];
  }
  // Provisional speakers survive only while something still points at them. The
  // predicate mirrors the worker's persist-time GC (db.py) exactly, so the list
  // hides precisely the rows that GC would delete — a provisional speaker whose
  // meeting was reprocessed keeps its old utterances but loses its cluster, and
  // until the next persist runs it lingers as a speaker who never said anything.
  // 'ready'/'pending'/'failed' are never filtered: an enrolled speaker is built
  // from a voice sample and legitimately has no cluster.
  async list(exec: Queryable): Promise<SpeakerWithSample[]> {
    const { rows } = await exec.query<SpeakerWithSample>(
      `SELECT ${SAMPLE_COLUMNS}
         FROM speaker s${SAMPLE_LATERAL}
        WHERE s.enrollment_status <> 'provisional'
           OR EXISTS (SELECT 1 FROM utterance WHERE speaker_id = s.id)
           OR EXISTS (SELECT 1 FROM meeting_cluster WHERE resolved_speaker_id = s.id)
           OR EXISTS (SELECT 1 FROM meeting_cluster WHERE suggested_speaker_id = s.id)
        ORDER BY s.created_at DESC`,
    );
    return rows;
  }
  async findById(exec: Queryable, id: string): Promise<SpeakerWithSample | null> {
    const { rows } = await exec.query<SpeakerWithSample>(
      `SELECT ${SAMPLE_COLUMNS} FROM speaker s${SAMPLE_LATERAL} WHERE s.id=$1`, [id],
    );
    return rows[0] ?? null;
  }
  async rename(exec: Queryable, id: string, name: string): Promise<SpeakerRow | null> {
    const { rows } = await exec.query<SpeakerRow>(
      `UPDATE speaker
       SET name=$2,
           enrollment_status = CASE WHEN enrollment_status='provisional' THEN 'ready'
                                    ELSE enrollment_status END
       WHERE id=$1 RETURNING *`,
      [id, name],
    );
    return rows[0] ?? null;
  }
  // 기존 '나'를 먼저 내려야 speaker_single_me_idx가 두 번째 true를 막지 않는다.
  // 호출자가 같은 트랜잭션 안에서 화자 존재를 확인한 뒤 부른다.
  async setMe(exec: Queryable, id: string): Promise<SpeakerRow | null> {
    await exec.query(`UPDATE speaker SET is_me=false WHERE is_me AND id<>$1`, [id]);
    const { rows } = await exec.query<SpeakerRow>(
      `UPDATE speaker SET is_me=true WHERE id=$1 RETURNING *`, [id],
    );
    return rows[0] ?? null;
  }
  // 이미 '나'가 아니어도 행이 있으면 true — 멱등 해제. false는 없는 화자다.
  async clearMe(exec: Queryable, id: string): Promise<boolean> {
    const res = await exec.query(`UPDATE speaker SET is_me=false WHERE id=$1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }
  async lockById(exec: Queryable, id: string): Promise<SpeakerRow | null> {
    const { rows } = await exec.query<SpeakerRow>(`SELECT * FROM speaker WHERE id=$1 FOR UPDATE`, [id]);
    return rows[0] ?? null;
  }
  // True while the speaker's current enroll job is queued/running (no FK job→speaker,
  // so we join via speaker.current_job_id).
  async hasActiveEnrollJob(exec: Queryable, id: string): Promise<boolean> {
    const res = await exec.query(
      `SELECT 1 FROM speaker s JOIN job j ON j.id = s.current_job_id
       WHERE s.id=$1 AND j.type='enroll_speaker' AND j.status IN ('queued','running')`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }
  // True while ANY process_meeting job is queued/running. Broad by design: the
  // worker's identify stage can bind THIS speaker to utterances minutes before
  // persist inserts them, so we cannot tell in advance which speaker a running
  // pipeline will pick. Deleting mid-pipeline would FK-violate at persist and
  // trigger a retry storm. Acceptable for a single-user tool.
  async hasActiveProcessMeetingJob(exec: Queryable): Promise<boolean> {
    const res = await exec.query(
      `SELECT 1 FROM job WHERE type='process_meeting' AND status IN ('queued','running') LIMIT 1`,
    );
    return (res.rowCount ?? 0) > 0;
  }
  // NO ACTION FKs (utterance.speaker_id, meeting_cluster.resolved_speaker_id) block a
  // raw DELETE, so clear them first; voiceprints then cascade on DELETE speaker.
  async unreferenceUtterances(exec: Queryable, id: string): Promise<void> {
    await exec.query(`UPDATE utterance SET speaker_id=NULL WHERE speaker_id=$1`, [id]);
  }
  async unreferenceClusters(exec: Queryable, id: string): Promise<void> {
    await exec.query(`UPDATE meeting_cluster SET resolved_speaker_id=NULL WHERE resolved_speaker_id=$1`, [id]);
  }
  // The FK on suggested_speaker_id is ON DELETE SET NULL, which would clear the id
  // and leave the score dangling. Clear both so no half-suggestion survives the
  // speaker it pointed at.
  async unreferenceSuggestions(exec: Queryable, id: string): Promise<void> {
    await exec.query(
      `UPDATE meeting_cluster SET suggested_speaker_id=NULL, suggested_similarity=NULL
       WHERE suggested_speaker_id=$1`,
      [id],
    );
  }
  // 병합: from이 가리키던 모든 것을 into로 옮긴다. 발화는 옛 처리 버전까지 옮긴다 — 렌즈
  // 근거가 옛 버전 발화를 가리킬 수 있고, 남겨 두면 NO ACTION FK가 from 삭제를 막는다.
  // 성문도 옮겨 into가 다음 회의에서 from의 목소리까지 알아보게 한다. from 쪽 클러스터의
  // 제안은 지운다 — 사람이 정체를 정했으니 "같은 사람일 수 있음"은 더 물을 게 없고, 남기면
  // meeting_cluster_suggestion_not_self를 어길 수 있다. 호출자가 둘을 잠근 뒤 부른다.
  async mergeInto(exec: Queryable, from: string, into: string): Promise<{ utterances: number }> {
    const moved = await exec.query(`UPDATE utterance SET speaker_id=$2 WHERE speaker_id=$1`, [from, into]);
    await exec.query(`UPDATE live_utterance SET speaker_id=$2 WHERE speaker_id=$1`, [from, into]);
    await exec.query(`UPDATE lens_item SET assignee_speaker_id=$2 WHERE assignee_speaker_id=$1`, [from, into]);
    await exec.query(
      `UPDATE meeting_cluster
          SET resolved_speaker_id=$2, suggested_speaker_id=NULL, suggested_similarity=NULL
        WHERE resolved_speaker_id=$1`,
      [from, into],
    );
    await exec.query(
      `UPDATE meeting_cluster SET suggested_speaker_id=NULL, suggested_similarity=NULL
        WHERE suggested_speaker_id=$1`,
      [from],
    );
    await exec.query(`UPDATE voiceprint SET speaker_id=$2 WHERE speaker_id=$1`, [from, into]);
    return { utterances: moved.rowCount ?? 0 };
  }
  async deleteById(exec: Queryable, id: string): Promise<boolean> {
    const res = await exec.query(`DELETE FROM speaker WHERE id=$1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
