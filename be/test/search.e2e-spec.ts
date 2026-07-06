import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { EmbedClient } from '../src/search/embed.client';
import { DatabaseService } from '../src/database/database.service';

describe('search', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  const DIM = 1024;
  const oneHot = (i: number) => { const a = Array(DIM).fill(0); a[i] = 1; return a; };
  const fakeEmbed = { embed: async (_t: string): Promise<number[] | null> => oneHot(0) };

  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmbedClient).useValue(fakeEmbed)
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(async () => { jest.restoreAllMocks(); await db.reset(); fakeEmbed.embed = async () => oneHot(0); });
  afterAll(async () => { await app?.close(); await db?.stop(); });
  const srv = () => app.getHttpServer();

  async function seed() {
    const m = (await db.pool.query(
      `INSERT INTO meeting(title,audio_key,recorded_at,status) VALUES('기획','k','2026-06-20T00:00:00Z','done') RETURNING id`,
    )).rows[0].id;
    const u = (await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,'SPEAKER_00',0,1000,'UI 개선안 논의','ok',0,0) RETURNING id`, [m],
    )).rows[0].id;
    await db.pool.query(
      `INSERT INTO utterance_embedding(utterance_id,embedding,model,dimension,processing_version)
       VALUES($1,$2::vector,'BAAI/bge-m3',1024,0)`, [u, '[' + oneHot(0).join(',') + ']'],
    );
    return { m, u };
  }

  it('POST /search hybrid returns matching utterance', async () => {
    const { u } = await seed();
    const res = await request(srv()).post('/search').send({ q: 'UI 개선' });
    expect(res.status).toBe(201);
    expect(res.body.mode).toBe('hybrid');
    expect(res.body.semantic).toBe(true);
    expect(res.body.results[0].utteranceId).toBe(u);
    expect(res.body.results[0].meetingTitle).toBe('기획');
  });

  it('degrades to keyword when embed returns null', async () => {
    await seed();
    fakeEmbed.embed = async () => null;
    const res = await request(srv()).post('/search').send({ q: 'UI 개선' });
    expect(res.body.mode).toBe('keyword');
    expect(res.body.semantic).toBe(false);
    expect(res.body.results.length).toBe(1);
  });

  it('browse mode when q empty', async () => {
    await seed();
    const res = await request(srv()).post('/search').send({ filters: {} });
    expect(res.body.mode).toBe('browse');
    expect(res.body.semantic).toBe(false);
    expect(res.body.results.length).toBe(1);
  });

  it('hasMore true when more than limit', async () => {
    const m = (await db.pool.query(
      `INSERT INTO meeting(title,audio_key,status) VALUES('m','k','done') RETURNING id`,
    )).rows[0].id;
    for (let i = 0; i < 3; i++) {
      await db.pool.query(
        `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
         VALUES($1,'SPEAKER_00',0,1,'회의 ${i}','ok',${i},0)`, [m],
      );
    }
    const res = await request(srv()).post('/search').send({ filters: {}, limit: 2 });
    expect(res.body.results.length).toBe(2);
    expect(res.body.hasMore).toBe(true);
  });

  it('S1: hybrid runs in a transaction and sets hnsw GUCs', async () => {
    await seed();
    const dbSvc = app.get(DatabaseService);
    const seen: string[] = [];
    const orig = dbSvc.withTransaction.bind(dbSvc);
    jest.spyOn(dbSvc, 'withTransaction').mockImplementation((fn: any) =>
      orig(async (client: any) => {
        const q = client.query.bind(client);
        jest.spyOn(client, 'query').mockImplementation((...a: any[]) => {
          seen.push(String(a[0]));
          return (q as any)(...a);
        });
        return fn(client);
      }),
    );
    const res = await request(srv()).post('/search').send({ q: 'UI 개선' });
    expect(res.body.mode).toBe('hybrid');
    expect(seen.some((s) => s.includes('hnsw.iterative_scan'))).toBe(true);
    expect(seen.some((s) => s.includes('hnsw.ef_search'))).toBe(true);
  });

  it('S4: excludes utterances of non-done / stale-version meetings', async () => {
    await seed(); // done, pv=0, 'UI 개선안 논의'
    const proc = (await db.pool.query(
      `INSERT INTO meeting(title,audio_key,status,processing_version) VALUES('처리중','k','processing',1) RETURNING id`,
    )).rows[0].id;
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,'SPEAKER_00',0,1000,'UI 재처리 중','ok',0,1)`,
      [proc],
    );
    const res = await request(srv()).post('/search').send({ q: 'UI' });
    expect(res.body.results.map((r: { text: string }) => r.text)).toEqual(['UI 개선안 논의']);
  });

  it('S5: rejects malformed input with 400', async () => {
    const bad = [
      { q: 'x', filters: { dateFrom: '언제인가' } }, // 비 ISO 날짜
      { filters: { dateFrom: '2026/07/03' } }, // 슬래시 구분자 (비 ISO-8601)
      { q: 'x', filters: { dateTo: 'July 3 2026' } }, // Date.parse는 통과하나 비 ISO-8601
      { filters: { dateFrom: '2026-07-01T00:00:00Z', dateTo: '2026-06-01T00:00:00Z' } }, // from >= to
      { filters: { meetingIds: ['bad-id'] } }, // 잘못된 회의 ID 형식
      { filters: { speakerIds: ['spk_0'] } }, // 잘못된 화자 ID 형식
      { q: 'a'.repeat(501) }, // 검색어 최대 길이 초과
    ];
    for (const body of bad) {
      const res = await request(srv()).post('/search').send(body);
      expect(res.status).toBe(400);
    }
  });
});
