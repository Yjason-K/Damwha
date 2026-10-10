import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Logger } from '@nestjs/common';

import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { SHARE_ENABLED } from '../src/shares/share-enabled.guard';
import { SharesRepository } from '../src/shares/shares.repository';
import { SharesSweeper } from '../src/shares/shares.sweeper';
import { startTestDb, StartedTestDb } from './db';
import { startFakeShareServer, FakeShareServer } from './fake-share-server';
import { seedSharedMeeting } from './share-fixtures';
import { newDeleteToken, newShareId } from '@damwha/share-format';

const CAPS = { platform: 'darwin', arch: 'arm64', chip: 'test', memory_gb: 32, gpu_eligible: true, recommended_preset: 'standard' };
const BODY = { scope: { summary: true, lenses: false, transcript: false, note: false, anonymize: false }, duration_days: 7, consent_version: 1, ui_language: 'ko' };

describe('공유 수명 주기', () => {
  let db: StartedTestDb;
  let fake: FakeShareServer;
  let app: NestExpressApplication;
  let sweeper: SharesSweeper;

  beforeAll(async () => {
    db = await startTestDb();
    fake = await startFakeShareServer();
    process.env.SHARE_API_URL = fake.url;
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(CAPABILITIES).useValue(CAPS).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    await app.init();
    sweeper = app.get(SharesSweeper);
    await sweeper.ready; // 기동 스위프가 끝난 뒤에 시작한다 — 테스트의 행과 겹치지 않게
  });
  afterEach(async () => {
    await db.reset();
    fake.objects.clear();
    fake.requests.length = 0;
    fake.mode = 'ok';
  });
  afterAll(async () => { await app?.close(); await fake?.close(); await db?.stop(); delete process.env.SHARE_API_URL; });

  const srv = () => app.getHttpServer();
  const row = async () => (await db.pool.query(`SELECT * FROM meeting_share ORDER BY id DESC LIMIT 1`)).rows[0];
  const share = async (meetingId: string) => (await request(srv()).post(`/meetings/${meetingId}/share`).send(BODY).expect(201)).body.share;

  it('회의 삭제 — 온라인이면 공유도 철회되고 응답이 revoked', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    await share(meetingId);
    const res = await request(srv()).delete(`/meetings/${meetingId}`).expect(200);
    expect(res.body).toEqual({ share_revoke: 'revoked', share_expires_at: null });
    expect(await row()).toMatchObject({ meeting_id: null, status: 'revoked', delete_token: null });
    expect(fake.objects.size).toBe(0);
  });

  it('회의 삭제 — 오프라인이어도 회의는 지워지고, 응답이 pending과 만료 시각을 준다', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    const s = await share(meetingId);
    fake.mode = 'drop';
    const res = await request(srv()).delete(`/meetings/${meetingId}`).expect(200);
    expect(res.body).toEqual({ share_revoke: 'pending', share_expires_at: s.expires_at });
    expect((await db.pool.query(`SELECT 1 FROM meeting WHERE id=$1`, [meetingId])).rowCount).toBe(0);
    expect(await row()).toMatchObject({ meeting_id: null, status: 'revoke_pending' });
    expect((await row()).delete_token).not.toBeNull();
  });

  it('다시 연결되면 스위퍼가 철회를 끝낸다 (간격이 지난 행만)', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    await share(meetingId);
    fake.mode = 'drop';
    await request(srv()).delete(`/meetings/${meetingId}`).expect(200);
    fake.mode = 'ok';
    fake.requests.length = 0;
    await sweeper.tick();
    expect(fake.requests).toHaveLength(0); // 방금 실패했다 — 5분이 안 됐다
    await db.pool.query(`UPDATE meeting_share SET revoke_attempted_at = now() - interval '6 minutes'`);
    await sweeper.tick();
    expect(await row()).toMatchObject({ status: 'revoked' });
    expect(fake.objects.size).toBe(0);
  });

  /**
   * 공유 확정 트랜잭션(회의 FOR UPDATE → 기존 active 내림 → 새 행 activate)을 다른 연결에서 열어 둔 채로 `run`을
   * 시작하고, `run`이 잠금을 기다리기 시작하면 확정을 커밋한다. 확정이 회의 잠금을 쥐고 있는 동안 끼어든 쓰기가
   * 새 active를 놓치는지 본다.
   */
  async function raceWithConfirm(meetingId: string, run: () => Promise<request.Response>) {
    const mk = async (status: string) => (await db.pool.query(
      `INSERT INTO meeting_share(meeting_id,status,remote_id,delete_token,scope,duration_days,consent_version,consented_at,share_key,expires_at)
       VALUES($1,$2,$3,$4,'{}',7,1,now(),$5, now() + interval '7 days') RETURNING id`,
      [meetingId, status, newShareId(7), newDeleteToken(), status === 'active' ? 'OLD-KEY' : null],
    )).rows[0].id as string;
    const creating = await mk('creating');
    const confirm = await db.pool.connect();
    try {
      await confirm.query('BEGIN');
      await confirm.query('SELECT 1 FROM meeting WHERE id=$1 FOR UPDATE', [meetingId]);
      await confirm.query(`UPDATE meeting_share SET status='revoke_pending', share_key=NULL WHERE meeting_id=$1 AND status='active'`, [meetingId]);
      await confirm.query(`UPDATE meeting_share SET status='active', share_key='NEW-KEY' WHERE id=$1`, [creating]);
      const pending = run();
      const end = Date.now() + 3000;
      for (;;) { // 요청이 잠금을 기다리기 시작할 때까지
        const waiting = await db.pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()`);
        if (waiting.rowCount) break;
        if (Date.now() > end) throw new Error('the request never waited on the confirm transaction');
        await new Promise((r) => setTimeout(r, 10));
      }
      await confirm.query('COMMIT');
      return { res: await pending, creating };
    } finally {
      confirm.release();
    }
  }

  it('회의 삭제가 진행 중인 공유 확정과 겹쳐도 새 링크가 주인 없는 active로 남지 않는다', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    const { res, creating } = await raceWithConfirm(meetingId, () => request(srv()).delete(`/meetings/${meetingId}`).then((r) => r));
    expect(res.status).toBe(200);
    const r = (await db.pool.query(`SELECT * FROM meeting_share WHERE id=$1`, [creating])).rows[0];
    expect(r).toMatchObject({ meeting_id: null, share_key: null });
    expect(r.status).not.toBe('active');
    expect((await db.pool.query(`SELECT 1 FROM meeting_share WHERE status='active'`)).rowCount).toBe(0);
  });

  it('공유 중지가 진행 중인 공유 확정과 겹치면 확정을 기다렸다가 새 링크를 중지한다(404가 아니다)', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    await db.pool.query(
      `INSERT INTO meeting_share(meeting_id,status,remote_id,delete_token,scope,duration_days,consent_version,consented_at,share_key,expires_at)
       VALUES($1,'active',$2,$3,'{}',7,1,now(),'OLD-KEY', now() + interval '7 days')`,
      [meetingId, newShareId(7), newDeleteToken()],
    );
    const { res, creating } = await raceWithConfirm(meetingId, () => request(srv()).delete(`/meetings/${meetingId}/share`).then((r) => r));
    expect(res.status).toBe(200);
    expect(res.body.share.id).toBe(creating);
    expect((await db.pool.query(`SELECT 1 FROM meeting_share WHERE status='active'`)).rowCount).toBe(0);
  });

  it('철회 재시도 간격은 5분 틱이 몇 ms 늦게 찍은 시도 시각 때문에 한 틱을 건너뛰지 않는다(30초 여유)', async () => {
    const mk = async (attempts: number, ago: string) => (await db.pool.query(
      `INSERT INTO meeting_share(meeting_id,status,remote_id,delete_token,scope,duration_days,consent_version,consented_at,expires_at,
                                 revoke_attempts,revoke_attempted_at)
       VALUES(NULL,'revoke_pending',$1,$2,'{}',7,1,now(), now() + interval '7 days', $3, now() - $4::interval) RETURNING id`,
      [newShareId(7), newDeleteToken(), attempts, ago],
    )).rows[0].id as string;
    // 다음 틱은 지난 시도 + 5분(1회 실패)·10분(2회)보다 몇 ms 이르게 온다 — 그 틱에 잡혀야 한다
    const due1 = await mk(1, '4 minutes 59 seconds');
    const due2 = await mk(2, '9 minutes 59 seconds');
    // 여유는 30초뿐이다 — 한 틱 이른 시도는 아직이다
    await mk(1, '4 minutes');
    await mk(2, '9 minutes');
    const ids = (await app.get(SharesRepository).listRevokeDue(db.pool)).map((r) => r.id).sort();
    expect(ids).toEqual([due1, due2].sort());
  });

  it('공유가 없는 회의 삭제는 none', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    expect((await request(srv()).delete(`/meetings/${meetingId}`).expect(200)).body).toEqual({ share_revoke: 'none', share_expires_at: null });
  });

  it('스위퍼 — 만료된 행은 expired, 10분 넘은 creating은 철회해서 서버에 남기지 않는다', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    await share(meetingId);
    await db.pool.query(`UPDATE meeting_share SET expires_at = now() - interval '1 second'`);
    // 확정 전에 죽은 업로드: 서버에는 객체가 있고, 로컬에는 creating 행(id·토큰)만 남았다
    const staleId = newShareId(7);
    const staleToken = newDeleteToken();
    fake.objects.set(staleId, { body: Buffer.from([1]), token: staleToken, expires_at: new Date(Date.now() + 86_400_000).toISOString() });
    await db.pool.query(
      `INSERT INTO meeting_share(meeting_id,status,remote_id,delete_token,scope,duration_days,consent_version,consented_at,created_at)
       VALUES(NULL,'creating',$1,$2,'{}',7,1,now(), now() - interval '11 minutes')`,
      [staleId, staleToken],
    );
    const fresh = (await db.pool.query(
      `INSERT INTO meeting_share(meeting_id,status,remote_id,delete_token,scope,duration_days,consent_version,consented_at)
       VALUES($1,'creating',$2,$3,'{}',7,1,now()) RETURNING id`,
      [meetingId, newShareId(7), newDeleteToken()],
    )).rows[0].id;
    await sweeper.tick();
    const r = (await db.pool.query(`SELECT id, status, share_key, remote_id FROM meeting_share ORDER BY id`)).rows;
    expect(r.map((x) => x.status)).toEqual(['expired', 'revoked', 'creating']);
    expect(r[0].share_key).toBeNull();
    expect(r[2].id).toBe(fresh);
    expect(fake.objects.has(staleId)).toBe(false);
  });
  it('결과를 모르는 업로드(끊김)로 철회 대기가 된 행도 로컬 만료 시각이 지나면 스위퍼가 expired로 닫는다', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    fake.mode = 'drop';
    await request(srv()).post(`/meetings/${meetingId}/share`).send(BODY).expect(502);
    const r = await row();
    expect(r.status).toBe('revoke_pending');
    expect(r.expires_at).not.toBeNull(); // created_at + duration_days
    expect(new Date(r.expires_at).getTime() - new Date(r.created_at).getTime()).toBe(7 * 86_400_000);
    await db.pool.query(`UPDATE meeting_share SET expires_at = now() - interval '1 second'`); // 그 시각이 지났다
    await sweeper.tick();
    expect(await row()).toMatchObject({ status: 'expired', delete_token: null, share_key: null });
  });

  it('스위퍼 로그에는 오류 이름만 — 오류 메시지(값이 섞일 수 있다)는 싣지 않는다', async () => {
    const repo = app.get(SharesRepository);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const s1 = jest.spyOn(repo, 'expireDue').mockRejectedValueOnce(new Error('SECRET-KEY-abc detail'));
    const s2 = jest.spyOn(repo, 'listRevokeDue').mockRejectedValueOnce(new Error('SECRET-TOKEN-xyz detail'));
    try {
      await sweeper.tick();
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toMatch(/cleanup failed \(Error\)/);
      expect(logged).toMatch(/retry failed \(Error\)/);
      expect(logged).not.toMatch(/SECRET/);
    } finally { s1.mockRestore(); s2.mockRestore(); warn.mockRestore(); }
  });
});

describe('공유가 꺼진 실행의 스위퍼', () => {
  let db: StartedTestDb;
  let fake: FakeShareServer;
  let app: NestExpressApplication;
  beforeAll(async () => {
    db = await startTestDb();
    fake = await startFakeShareServer();
    process.env.SHARE_API_URL = fake.url;
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CAPABILITIES).useValue(CAPS)
      .overrideProvider(SHARE_ENABLED).useValue(false)
      .compile();
    app = mod.createNestApplication<NestExpressApplication>();
    await app.init();
  });
  afterAll(async () => { await app?.close(); await fake?.close(); await db?.stop(); delete process.env.SHARE_API_URL; });

  it('아무것도 하지 않는다', async () => {
    await db.pool.query(
      `INSERT INTO meeting_share(meeting_id,status,remote_id,delete_token,scope,duration_days,expires_at,consent_version,consented_at)
       VALUES(NULL,'revoke_pending','7-AAAAAAAAAAAAAAAAAAAAA1','t','{}',7, now() + interval '1 day',1,now())`,
    );
    await app.get(SharesSweeper).tick();
    expect(fake.requests).toHaveLength(0);
  });
});
