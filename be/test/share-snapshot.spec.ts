import { readSnapshot } from '../src/shares/share-snapshot';
import { buildPayload } from '../src/shares/share-payload';
import { startTestDb, StartedTestDb } from './db';
import { seedSharedMeeting } from './share-fixtures';

describe('readSnapshot', () => {
  let db: StartedTestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  it('현재 버전의 ok 발화·요약·active 렌즈·메모를 읽는다', async () => {
    const { meetingId, speakerId } = await seedSharedMeeting(db.pool);
    const snap = (await readSnapshot(db.pool, meetingId))!;
    expect(snap.meeting).toMatchObject({ title: '주간 회의', duration_ms: 60000, processing_version: 1 });
    expect(snap.utterances).toEqual([
      { speaker_key: speakerId, speaker_name: '김담화', start_ms: 1000, end_ms: 3000, text: '화요일에 배포하죠' },
      { speaker_key: 'SPEAKER_01', speaker_name: null, start_ms: 4000, end_ms: 5000, text: '좋아요' },
    ]);
    expect(snap.summary).toMatchObject({ status: 'done', topics: ['배포'] });
    expect(snap.lenses).toEqual([
      expect.objectContaining({ kind: 'action', due_at: '2026-10-14', assignee_name: '김담화', primary: { start_ms: 1000, processing_version: 1, shared: true } }),
    ]);
    expect(snap.note).toBe('## 메모');
  });

  it('없는 회의는 null', async () => {
    expect(await readSnapshot(db.pool, 'mtg_999')).toBeNull();
  });

  it('재처리로 버전이 오르면 새 버전 발화만, 요약은 없음, 렌즈 근거는 옛 버전을 가리킨다', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    await db.pool.query(`UPDATE meeting SET processing_version=2 WHERE id=$1`, [meetingId]);
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,order_index,processing_version)
       VALUES($1,'SPEAKER_00',1200,3100,'재처리된 발화',0,2)`,
      [meetingId],
    );
    const snap = (await readSnapshot(db.pool, meetingId))!;
    expect(snap.utterances.map((u) => u.text)).toEqual(['재처리된 발화']);
    expect(snap.summary).toBeNull();
    expect(snap.lenses[0].primary).toEqual({ start_ms: 1000, processing_version: 1, shared: false });
  });

  it('근거 발화가 silence면 shared=false', async () => {
    const { meetingId, lensId } = await seedSharedMeeting(db.pool);
    const silent = (await db.pool.query(
      `SELECT id FROM utterance WHERE meeting_id=$1 AND status='silence'`, [meetingId],
    )).rows[0].id;
    await db.pool.query(`UPDATE lens_evidence SET utterance_id=$1 WHERE lens_item_id=$2`, [silent, lensId]);
    const snap = (await readSnapshot(db.pool, meetingId))!;
    expect(snap.lenses[0].primary).toEqual({ start_ms: 6000, processing_version: 1, shared: false });
  });

  it('한 시점의 값만 담는다 — 읽는 도중 커밋된 이름·메모 변경은 보이지 않는다', async () => {
    const { meetingId, speakerId } = await seedSharedMeeting(db.pool);
    const snap = (await readSnapshot(db.pool, meetingId, {
      afterFirstRead: async () => {
        await db.pool.query(`UPDATE speaker SET name='바뀐 이름' WHERE id=$1`, [speakerId]);
        await db.pool.query(`UPDATE meeting_note SET body_md='바뀐 메모' WHERE meeting_id=$1`, [meetingId]);
      },
    }))!;
    expect(snap.utterances[0].speaker_name).toBe('김담화');
    expect(snap.lenses[0].assignee_name).toBe('김담화');
    expect(snap.note).toBe('## 메모');
  });

  it('읽는 도중 다른 연결이 재처리 결과를 커밋해도 페이로드는 한 버전만 담는다 (spec §3)', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    const snap = (await readSnapshot(db.pool, meetingId, {
      afterFirstRead: async () => {
        // 재처리 한 번을 그대로 흉내 낸다: bumpVersionForReprocess(버전 +1) → worker persist(새 버전 발화 INSERT,
        // 옛 버전 발화는 남김 — 마이그레이션 013) → summarize_meeting(meeting_summary UPSERT, 회의당 1행).
        const other = await db.pool.connect();
        try {
          await other.query('BEGIN');
          await other.query(`UPDATE meeting SET processing_version=2, status='done' WHERE id=$1`, [meetingId]);
          await other.query(
            `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,order_index,processing_version)
             VALUES($1,'SPEAKER_00',1200,3100,'재처리된 발화',0,2)`,
            [meetingId],
          );
          await other.query(
            `INSERT INTO meeting_summary(meeting_id,processing_version,model,status,topics,segments)
             VALUES($1,2,'m','done','["재처리 주제"]'::jsonb,'[]'::jsonb)
             ON CONFLICT (meeting_id) DO UPDATE
               SET processing_version=EXCLUDED.processing_version, status=EXCLUDED.status,
                   topics=EXCLUDED.topics, segments=EXCLUDED.segments`,
            [meetingId],
          );
          await other.query('COMMIT');
        } finally {
          other.release();
        }
      },
    }))!;
    // 커밋은 실제로 끝났다 — 스냅샷 밖에서는 새 버전이 보인다.
    expect((await db.pool.query(`SELECT processing_version FROM meeting WHERE id=$1`, [meetingId])).rows[0].processing_version).toBe(2);

    expect(snap.meeting.processing_version).toBe(1);
    expect(snap.utterances.map((u) => u.text)).toEqual(['화요일에 배포하죠', '좋아요']);
    expect(snap.summary).toMatchObject({ status: 'done', topics: ['배포'] });
    expect(snap.lenses[0].primary).toEqual({ start_ms: 1000, processing_version: 1, shared: true });

    const p = buildPayload(
      snap,
      { summary: true, lenses: true, transcript: true, note: true, anonymize: false },
      { now: new Date('2026-10-09T00:00:00.000Z'), uiLanguage: 'ko' },
    );
    const json = JSON.stringify(p);
    expect(json).not.toContain('재처리');
    expect(p.summary!.topics).toEqual(['배포']);
    expect(p.transcript!.map((u) => u.text)).toEqual(['화요일에 배포하죠', '좋아요']);
    expect(p.lenses!.map((l) => l.linkable)).toEqual([true]);
  });
});
