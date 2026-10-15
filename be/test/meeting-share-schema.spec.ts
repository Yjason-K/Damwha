import { startTestDb, StartedTestDb } from './db';

describe('meeting_share 스키마', () => {
  let db: StartedTestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  const mkMeeting = async () =>
    (await db.pool.query(`INSERT INTO meeting(audio_key,status) VALUES('a','done') RETURNING id`)).rows[0].id as string;
  const insert = (meetingId: string, status: string) =>
    db.pool.query(
      `INSERT INTO meeting_share(meeting_id,status,scope,duration_days,consent_version,consented_at)
       VALUES($1,$2,'{}'::jsonb,7,1,now()) RETURNING id`,
      [meetingId, status],
    );

  it('id는 shr_<n>', async () => {
    const { rows } = await insert(await mkMeeting(), 'creating');
    expect(rows[0].id).toMatch(/^shr_[1-9][0-9]*$/);
  });

  it('회의당 active는 하나, creating도 하나', async () => {
    const m = await mkMeeting();
    await insert(m, 'active');
    await expect(insert(m, 'active')).rejects.toMatchObject({ constraint: 'meeting_share_one_active_idx' });
    await insert(m, 'creating');
    await expect(insert(m, 'creating')).rejects.toMatchObject({ constraint: 'meeting_share_one_creating_idx' });
    await insert(m, 'revoke_pending');
    await insert(m, 'revoke_pending');
  });

  it('회의를 지워도 행은 남고 meeting_id만 NULL이 된다 — 삭제 토큰을 잃지 않는다', async () => {
    const m = await mkMeeting();
    const { rows } = await insert(m, 'revoke_pending');
    await db.pool.query(`DELETE FROM meeting WHERE id=$1`, [m]);
    const after = await db.pool.query(`SELECT meeting_id FROM meeting_share WHERE id=$1`, [rows[0].id]);
    expect(after.rows).toEqual([{ meeting_id: null }]);
  });

  it('status는 다섯 값만', async () => {
    await expect(insert(await mkMeeting(), 'deleted')).rejects.toMatchObject({ code: '23514' });
  });
});
