import type { Pool } from 'pg';
import type { SummarySegment } from '../summary/summary.types';

export type LensKind = 'action' | 'decision' | 'promise';

/** 공유 한 번에 담을 회의의 한 시점. 내부 id는 화자 식별용 speaker_key 말고는 들고 나가지 않는다. */
export interface MeetingSnapshot {
  meeting: { title: string | null; recorded_at: Date; duration_ms: number | null; processing_version: number };
  /** 현재 processing_version의 요약. 없으면 null. */
  summary: { status: string; topics: string[]; segments: SummarySegment[] } | null;
  lenses: {
    kind: LensKind;
    text: string;
    completion_status: 'open' | 'done';
    due_at: string | null;
    assignee_speaker_id: string | null;
    assignee_name: string | null;
    /**
     * primary 근거 발화. 마이그레이션 013 이후 예전 버전 발화일 수 있다. `shared` = 이 발화가 공유본의 발화 기록에
     * 실제로 들어가는가(현재 버전 · status='ok' · 본문 있음) — 아니면 뷰어가 스크롤할 대상이 없다(Codex 계획 리뷰 #8).
     */
    primary: { start_ms: number; processing_version: number; shared: boolean } | null;
  }[];
  /** 현재 버전, status='ok', 본문 있는 발화. speaker_key = speaker_id ?? diar_label (fe mappers와 같은 식별). */
  utterances: { speaker_key: string; speaker_name: string | null; start_ms: number; end_ms: number; text: string }[];
  note: string | null;
}

/**
 * 공유할 내용을 **한 트랜잭션, 한 시점**에서 읽는다 (spec §2.7 2단계). REPEATABLE READ라 첫 쿼리에서 잡힌
 * 스냅샷을 끝까지 본다 — 읽는 도중 재처리·이름 변경·메모 저장이 커밋돼도 서로 다른 시점의 값이 섞이지 않는다.
 * 암호화·업로드는 이 트랜잭션을 닫은 뒤에 한다(외부 요청 동안 연결을 붙잡지 않는다).
 * `hooks.afterFirstRead`는 테스트가 "읽는 도중의 커밋"을 끼워 넣는 자리다.
 */
export async function readSnapshot(
  pool: Pool,
  meetingId: string,
  hooks: { afterFirstRead?: () => Promise<void> } = {},
): Promise<MeetingSnapshot | null> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const m = (
      await c.query<{ title: string | null; recorded_at: Date; duration_ms: number | null; processing_version: number }>(
        `SELECT title, recorded_at, duration_ms, processing_version FROM meeting WHERE id=$1`,
        [meetingId],
      )
    ).rows[0];
    if (!m) {
      await c.query('COMMIT');
      return null;
    }
    await hooks.afterFirstRead?.();
    const summary =
      (
        await c.query<{ status: string; topics: string[]; segments: SummarySegment[] }>(
          `SELECT status, topics, segments FROM meeting_summary WHERE meeting_id=$1 AND processing_version=$2`,
          [meetingId, m.processing_version],
        )
      ).rows[0] ?? null;
    const lensRows = (
      await c.query(
        `SELECT li.kind, li.text, li.completion_status, to_char(li.due_at, 'YYYY-MM-DD') AS due_at,
                li.assignee_speaker_id, s.name AS assignee_name,
                pu.start_ms AS primary_start_ms, pu.processing_version AS primary_version,
                (pu.processing_version = $2 AND pu.status = 'ok' AND btrim(coalesce(pu.text, '')) <> '') AS primary_shared
           FROM lens_item li
           LEFT JOIN speaker s ON s.id = li.assignee_speaker_id
           LEFT JOIN lens_evidence le ON le.lens_item_id = li.id AND le.relation = 'primary'
           LEFT JOIN utterance pu ON pu.id = le.utterance_id
          WHERE li.meeting_id = $1 AND li.lifecycle_status = 'active'
          ORDER BY li.created_at, li.id`,
        [meetingId, m.processing_version],
      )
    ).rows;
    const utterances = (
      await c.query(
        `SELECT COALESCE(u.speaker_id, u.diar_label) AS speaker_key, s.name AS speaker_name, u.start_ms, u.end_ms, u.text
           FROM utterance u LEFT JOIN speaker s ON s.id = u.speaker_id
          WHERE u.meeting_id=$1 AND u.processing_version=$2 AND u.status='ok' AND btrim(coalesce(u.text,'')) <> ''
          ORDER BY u.order_index`,
        [meetingId, m.processing_version],
      )
    ).rows;
    const note = (await c.query<{ body_md: string }>(`SELECT body_md FROM meeting_note WHERE meeting_id=$1`, [meetingId])).rows[0]?.body_md ?? null;
    await c.query('COMMIT');
    return {
      meeting: m,
      summary,
      lenses: lensRows.map((r) => ({
        kind: r.kind,
        text: r.text,
        completion_status: r.completion_status,
        due_at: r.due_at,
        assignee_speaker_id: r.assignee_speaker_id,
        assignee_name: r.assignee_name,
        primary:
          r.primary_start_ms === null
            ? null
            : { start_ms: r.primary_start_ms, processing_version: r.primary_version, shared: r.primary_shared === true },
      })),
      utterances,
      note,
    };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
