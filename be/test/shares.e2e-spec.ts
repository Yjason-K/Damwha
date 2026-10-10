import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { decryptShare } from '@damwha/share-format';

import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { SHARE_ENABLED } from '../src/shares/share-enabled.guard';
import { SharesSweeper } from '../src/shares/shares.sweeper';
import { SharesRepository } from '../src/shares/shares.repository';
import { ShareClient } from '../src/shares/share-client';
import net from 'node:net';
import { startTestDb, StartedTestDb } from './db';
import { startFakeShareServer, FakeShareServer } from './fake-share-server';
import { seedSharedMeeting } from './share-fixtures';

const CAPS = { platform: 'darwin', arch: 'arm64', chip: 'test', memory_gb: 32, gpu_eligible: true, recommended_preset: 'standard' };
const SCOPE = { summary: true, lenses: true, transcript: false, note: false, anonymize: false };
const body = (over: Record<string, unknown> = {}) => ({ scope: SCOPE, duration_days: 7, consent_version: 1, ui_language: 'ko', ...over });

/** 공유 활성 여부는 테스트마다 명시한다 — 기본값(HOST)에 기대면 env가 바뀔 때 조용히 꺼진 앱을 시험한다. */
async function makeApp(enabled: boolean, client?: ShareClient) {
  let b = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CAPABILITIES).useValue(CAPS)
    .overrideProvider(SHARE_ENABLED).useValue(enabled);
  if (client) b = b.overrideProvider(ShareClient).useValue(client);
  const app = (await b.compile()).createNestApplication<NestExpressApplication>();
  app.useBodyParser('json', { limit: '1mb' });
  await app.init();
  return app;
}

/** 비동기로 도는 철회를 기다린다. */
async function until(check: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
}

describe('공유 API', () => {
  let db: StartedTestDb;
  let fake: FakeShareServer;
  let app: NestExpressApplication;

  beforeAll(async () => {
    db = await startTestDb();
    fake = await startFakeShareServer();
    process.env.SHARE_API_URL = fake.url;
    app = await makeApp(true);
    await app.get(SharesSweeper).ready;
  });
  afterEach(async () => {
    await db.reset();
    fake.objects.clear();
    fake.requests.length = 0;
    fake.mode = 'ok';
    fake.delayMs = 0;
  });
  afterAll(async () => {
    await app?.close();
    await fake?.close();
    await db?.stop();
    delete process.env.SHARE_API_URL;
  });

  const srv = () => app.getHttpServer();
  const rows = async () => (await db.pool.query(`SELECT * FROM meeting_share ORDER BY id`)).rows;

  describe('미리보기', () => {
    it('업로드도 저장도 하지 않고 페이로드를 돌려준다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      const res = await request(srv()).post(`/meetings/${meetingId}/share/preview`).send({ scope: SCOPE, ui_language: 'ko' }).expect(200);
      expect(res.body.payload).toMatchObject({ v: 1, meeting: { title: '주간 회의' }, summary: { topics: ['배포'] } });
      expect(res.body.payload).not.toHaveProperty('transcript');
      expect(res.body.payload).not.toHaveProperty('expires_at');
      expect(Date.parse(res.body.expires_at_estimate) - Date.now()).toBeGreaterThan(7 * 86_400_000 - 60_000);
      expect(fake.requests).toHaveLength(0);
      expect(await rows()).toEqual([]);
    });
  });

  describe('만들기', () => {
    it('업로드한 봉투를 링크의 키로 풀면 고른 범위가 나온다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      const res = await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201);
      const { share } = res.body;
      expect(share).toMatchObject({ meeting_id: meetingId, status: 'active', duration_days: 7, scope: SCOPE });
      const m = String(share.url).match(/^(http:\/\/127\.0\.0\.1:\d+)\/s\/([^#]+)#(.+)$/)!;
      expect(m[1]).toBe(fake.url);
      const payload = await decryptShare(new Uint8Array(fake.objects.get(m[2])!.body), m[3]);
      expect(payload.summary?.topics).toEqual(['배포']);
      expect(payload.lenses).toHaveLength(1);
      expect(payload.transcript).toBeUndefined();
      expect(share.expires_at).toBe(fake.objects.get(m[2])!.expires_at); // 서버가 정한 만료 시각을 그대로 쓴다
    });

    it.each([
      ['동의 버전이 다름', 'CONSENT_REQUIRED', body({ consent_version: 0 })],
      ['발화 기록인데 책임 확인 없음', 'CONSENT_REQUIRED', body({ scope: { ...SCOPE, transcript: true } })],
      ['내용을 하나도 안 고름', 'EMPTY_SCOPE', body({ scope: { ...SCOPE, summary: false, lenses: false } })],
      ['기간이 목록 밖', 'BAD_REQUEST', body({ duration_days: 3 })],
      ['모르는 키', 'BAD_REQUEST', body({ audio: true })],
    ])('%s → 400 %s', async (_name, code, b) => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      const res = await request(srv()).post(`/meetings/${meetingId}/share`).send(b).expect(400);
      expect(res.body.code).toBe(code);
      expect(fake.requests).toHaveLength(0);
      expect(await rows()).toEqual([]);
    });

    it('발화 기록 + 책임 확인이면 된다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      await request(srv()).post(`/meetings/${meetingId}/share`).send(body({ scope: { ...SCOPE, transcript: true }, transcript_ack: true })).expect(201);
    });

    it('요약이 done이 아닌데 요약을 고르면 400 SUMMARY_NOT_READY', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      await db.pool.query(`UPDATE meeting_summary SET status='failed' WHERE meeting_id=$1`, [meetingId]);
      const res = await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(400);
      expect(res.body.code).toBe('SUMMARY_NOT_READY');
      expect(await rows()).toEqual([]);
    });

    it('없는 회의는 404', async () => {
      await request(srv()).post(`/meetings/mtg_999/share`).send(body()).expect(404);
      await request(srv()).post(`/meetings/not-an-id/share`).send(body()).expect(404);
    });

    it('새 링크를 만들면 응답 시점에 기존 링크는 이미 서버에 없고 행은 revoked다 (교체)', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201);
      const firstRow = (await rows())[0];
      const second = (await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201)).body.share;
      // 기다리지 않는다 — 교체는 업로드 요청 안에서 끝났다
      expect(fake.objects.has(firstRow.remote_id)).toBe(false);
      expect(fake.objects.size).toBe(1);
      const upload = fake.requests.filter((r) => r.method === 'POST')[1];
      expect(upload.headers['x-replace-id']).toBe(firstRow.remote_id);
      expect(upload.headers['x-replace-token']).toBe(firstRow.delete_token);
      const r = await rows();
      expect(r.find((x) => x.id === firstRow.id)).toMatchObject({ status: 'revoked', share_key: null, delete_token: null });
      expect(r.find((x) => x.id === second.id)?.status).toBe('active');
    });

    it('서버가 교체 토큰을 거절하면 새 링크도 없고 기존 링크는 그대로다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      const first = (await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201)).body.share;
      await db.pool.query(`UPDATE meeting_share SET delete_token='tampered' WHERE id=$1`, [first.id]);
      const res = await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(502);
      expect(res.body.code).toBe('SHARE_SERVICE_REJECTED');
      expect((await rows()).map((x) => [x.id, x.status])).toEqual([[first.id, 'active']]);
      expect(fake.objects.size).toBe(1);
    });

    it('업로드가 닿지 않으면 기존 링크는 그대로이고, 시도한 id는 철회 대기열에 남는다(만들어졌을 수도 있어서)', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      const first = (await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201)).body.share;
      fake.mode = 'drop';
      const res = await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(502);
      expect(res.body.code).toBe('SHARE_SERVICE_UNREACHABLE');
      const r = await rows();
      expect(r.map((x) => x.status)).toEqual(['active', 'revoke_pending']);
      expect(r[0].id).toBe(first.id);
      expect(r[1]).toMatchObject({ share_key: null });
      expect(r[1].delete_token).not.toBeNull();
      expect(r.some((x) => x.status === 'creating')).toBe(false);
    });

    it('공유 서버에 닿을 수 없으면(연결 거절 — Tunnel 연결 전) 예약 행을 지우고 502, 회의에는 공유가 없다 (spec §3)', async () => {
      const port = await new Promise<number>((resolve) => {
        const s = net.createServer().listen(0, '127.0.0.1', () => {
          const p = (s.address() as net.AddressInfo).port;
          s.close(() => resolve(p));
        });
      });
      const offline = await makeApp(true, new ShareClient(`http://127.0.0.1:${port}`, 2000));
      try {
        await offline.get(SharesSweeper).ready;
        const { meetingId } = await seedSharedMeeting(db.pool);
        const res = await request(offline.getHttpServer()).post(`/meetings/${meetingId}/share`).send(body()).expect(502);
        expect(res.body.code).toBe('SHARE_SERVICE_UNREACHABLE');
        expect(JSON.stringify(res.body)).not.toMatch(/token|key/i);
        expect(await rows()).toEqual([]);
        expect((await request(offline.getHttpServer()).get(`/meetings/${meetingId}/share`).expect(200)).body).toEqual({ share: null });
      } finally {
        await offline.close();
      }
    });

    it('철회 대기 중인 공유가 있어도 새 링크를 만들 수 있다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      fake.mode = 'drop'; // 결과를 모르는 업로드 → revoke_pending
      await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(502);
      expect((await request(srv()).get(`/meetings/${meetingId}/share`).expect(200)).body.share.status).toBe('revoke_pending');
      fake.mode = 'ok';
      const res = await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201);
      expect(res.body.share.status).toBe('active');
      expect((await request(srv()).get(`/meetings/${meetingId}/share`).expect(200)).body.share.id).toBe(res.body.share.id);
    });

    it('서버가 저장한 뒤 응답을 잃으면 그 객체는 철회되어 서버에 남지 않는다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      fake.mode = 'storeThenDrop';
      await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(502);
      const remoteId = (await rows())[0].remote_id as string;
      // 철회는 응답을 기다리지 않고 돈다 — objects.size를 바로 보면 경합이다. 대신 서버가 받은 요청 순서를 본다:
      // 저장된 업로드(POST) 다음에 같은 id의 철회(DELETE)가 온다.
      await until(async () => fake.requests.some((r) => r.method === 'DELETE'));
      expect(fake.requests.map((r) => [r.method, r.path])).toEqual([
        ['POST', '/api/shares'],
        ['DELETE', `/api/shares/${remoteId}`],
      ]);
      expect(fake.requests[0].headers['x-share-id']).toBe(remoteId);
      await until(async () => (await rows())[0]?.status === 'revoked');
      expect(fake.objects.size).toBe(0);
    });

    it('업로드는 됐는데 확정이 실패하면 예약 행을 지우지 않고 철회한다(삭제 토큰을 잃지 않는다)', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      const repo = app.get(SharesRepository);
      const spy = jest.spyOn(repo, 'activate').mockRejectedValueOnce(new Error('confirm failed'));
      try {
        await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(500);
      } finally {
        spy.mockRestore();
      }
      await until(async () => (await rows())[0]?.status === 'revoked');
      expect(fake.requests.map((r) => r.method)).toEqual(['POST', 'DELETE']);
      expect(fake.objects.size).toBe(0);
    });

    it('업로드하는 사이 기존 링크를 중지해도 새 링크는 활성화된다 (spec selfhost-v2 §2.7 6)', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      const first = (await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201)).body.share;
      fake.delayMs = 200;
      const uploading = fake.nextUpload();
      const pending = request(srv()).post(`/meetings/${meetingId}/share`).send(body()).then((r) => r);
      await uploading;
      await request(srv()).delete(`/meetings/${meetingId}/share`); // 기존 링크 중지
      const res = await pending;
      expect(res.status).toBe(201);
      const r = await rows();
      expect(r.find((x) => x.id === first.id)?.status).toBe('revoked');
      expect(r.find((x) => x.id === res.body.share.id)?.status).toBe('active');
      expect(fake.objects.size).toBe(1);
    });

    it('공유 서비스가 바쁘면 503 SHARE_SERVICE_BUSY', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      fake.mode = 'busy503';
      expect((await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(503)).body.code).toBe('SHARE_SERVICE_BUSY');
    });

    it('동시에 두 번 누르면 하나는 409 SHARE_IN_PROGRESS이고 링크는 하나다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      fake.delayMs = 300;
      const [a, b] = await Promise.all([
        request(srv()).post(`/meetings/${meetingId}/share`).send(body()).then((r) => r),
        request(srv()).post(`/meetings/${meetingId}/share`).send(body()).then((r) => r),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect([a, b].find((r) => r.status === 409)!.body.code).toBe('SHARE_IN_PROGRESS');
      expect(fake.objects.size).toBe(1);
      expect((await rows()).map((x) => x.status)).toEqual(['active']);
    });

    it('업로드하는 사이 회의가 지워지면 410이고 올라간 객체는 철회된다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      fake.delayMs = 300;
      const uploading = fake.nextUpload();
      // supertest는 then/await 전까지 요청을 보내지 않는다 — .then으로 지금 시작시킨다
      const pending = request(srv()).post(`/meetings/${meetingId}/share`).send(body()).then((r) => r);
      await uploading; // 업로드 요청이 공유 서버에 도착했다 = 스냅샷은 끝났고 확정 전이다
      await db.pool.query(`DELETE FROM meeting WHERE id=$1`, [meetingId]);
      const res = await pending;
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('MEETING_DELETED');
      fake.delayMs = 0;
      await until(async () => (await rows())[0]?.status === 'revoked');
      expect(fake.objects.size).toBe(0);
    });

    it('압축·암호화 뒤에도 5MB를 넘으면 413이고 업로드하지 않는다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      // md5 16진수는 gzip으로 절반쯤만 준다 — 10,000행 × 1,280자 ≈ 12.8MB → 봉투 ≈ 6.5MB
      await db.pool.query(
        `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,order_index,processing_version)
         SELECT $1,'SPEAKER_00',g*1000,g*1000+900,
                (SELECT string_agg(md5(random()::text || g::text || i::text), '') FROM generate_series(1,40) i),
                g+10, 1
           FROM generate_series(1,10000) g`,
        [meetingId],
      );
      const res = await request(srv())
        .post(`/meetings/${meetingId}/share`)
        .send(body({ scope: { ...SCOPE, transcript: true }, transcript_ack: true }))
        .expect(413);
      expect(res.body.code).toBe('SHARE_TOO_LARGE');
      expect(fake.requests).toHaveLength(0);
      expect(await rows()).toEqual([]);
    });
  });

  describe('조회·중지·목록', () => {
    it('조회 — 활성 공유, 없으면 null', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      expect((await request(srv()).get(`/meetings/${meetingId}/share`).expect(200)).body).toEqual({ share: null });
      await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201);
      expect((await request(srv()).get(`/meetings/${meetingId}/share`).expect(200)).body.share.status).toBe('active');
    });

    it('조회 — 만료가 지난 공유는 보이지 않지만 GET은 행을 바꾸지 않는다(정리는 스위퍼)', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      const { share } = (await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201)).body;
      await db.pool.query(`UPDATE meeting_share SET expires_at = now() - interval '1 minute' WHERE id=$1`, [share.id]);
      const before = (await rows())[0];
      expect((await request(srv()).get(`/meetings/${meetingId}/share`).expect(200)).body).toEqual({ share: null });
      expect((await request(srv()).get('/shares').expect(200)).body).toEqual({ shares: [] });
      expect((await rows())[0]).toEqual(before);
    });

    it('중지 — 온라인이면 200 revoked, 서버 객체도 사라진다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201);
      const res = await request(srv()).delete(`/meetings/${meetingId}/share`).expect(200);
      expect(res.body.share).toMatchObject({ status: 'revoked', url: null });
      expect(fake.objects.size).toBe(0);
    });

    it('중지 — 오프라인이면 202 revoke_pending, 키는 지우고 삭제 토큰은 남긴다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201);
      fake.mode = 'drop';
      const res = await request(srv()).delete(`/meetings/${meetingId}/share`).expect(202);
      expect(res.body.share).toMatchObject({ status: 'revoke_pending', url: null });
      const r = (await rows())[0];
      expect(r.share_key).toBeNull();
      expect(r.delete_token).not.toBeNull();
      expect(r.revoke_attempts).toBe(1);
    });

    it('중지할 공유가 없으면 404 NO_ACTIVE_SHARE', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      expect((await request(srv()).delete(`/meetings/${meetingId}/share`).expect(404)).body.code).toBe('NO_ACTIVE_SHARE');
    });

    it('목록 — active와 revoke_pending만, 회의 제목과 함께', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201);
      const { shares } = (await request(srv()).get('/shares').expect(200)).body;
      expect(shares).toHaveLength(1);
      expect(shares[0]).toMatchObject({ meeting_title: '주간 회의', status: 'active' });
      expect(shares[0].url).toMatch(/\/s\/7-/);
    });
  });
});

describe('공유가 꺼진 실행 (Docker·데모)', () => {
  let db: StartedTestDb;
  let app: NestExpressApplication;
  beforeAll(async () => { db = await startTestDb(); app = await makeApp(false); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  it('공유 라우트 전부 404', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    const srv = app.getHttpServer();
    await request(srv).get(`/meetings/${meetingId}/share`).expect(404);
    await request(srv).post(`/meetings/${meetingId}/share`).send(body()).expect(404);
    await request(srv).post(`/meetings/${meetingId}/share/preview`).send({ scope: SCOPE, ui_language: 'ko' }).expect(404);
    await request(srv).delete(`/meetings/${meetingId}/share`).expect(404);
    await request(srv).get('/shares').expect(404);
  });
});
