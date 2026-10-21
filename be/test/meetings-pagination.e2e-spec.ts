import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';

describe('GET /meetings (keyset page)', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CAPABILITIES)
      .useValue({
        platform: 'darwin', arch: 'arm64', chip: 'test', memory_gb: 32,
        gpu_eligible: true, recommended_preset: 'standard',
      })
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  const srv = () => app.getHttpServer();
  const mk = async (recordedAt: string) =>
    (await db.pool.query(
      `INSERT INTO meeting(audio_key,status,recorded_at) VALUES('k','done',$1) RETURNING id`, [recordedAt],
    )).rows[0].id as string;
  const seed3 = async () => {
    const a = await mk('2026-01-01T00:00:00Z');
    const b = await mk('2026-01-02T00:00:00Z');
    const c = await mk('2026-01-03T00:00:00Z');
    return { a, b, c };
  };

  it('no query keeps array response', async () => {
    await seed3();
    const res = await request(srv()).get('/meetings').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
  });

  it('limit=2 returns page and cursor', async () => {
    const { b, c } = await seed3();
    const res = await request(srv()).get('/meetings?limit=2').expect(200);
    expect(res.body.items.map((m: { id: string }) => m.id)).toEqual([c, b]);
    expect(typeof res.body.next_cursor).toBe('string');
    expect(res.body.items[0]).not.toHaveProperty('sort_at');
    expect(res.body.items[0]).toHaveProperty('participant_count');
  });

  it('cursor continues without overlap', async () => {
    const { a } = await seed3();
    const p1 = await request(srv()).get('/meetings?limit=2').expect(200);
    const p2 = await request(srv()).get(`/meetings?limit=2&cursor=${p1.body.next_cursor}`).expect(200);
    expect(p2.body.items.map((m: { id: string }) => m.id)).toEqual([a]);
    expect(p2.body.next_cursor).toBeNull();
  });

  it('same recorded_at is split by id without loss', async () => {
    const ids = [await mk('2026-02-01T00:00:00Z'), await mk('2026-02-01T00:00:00Z'), await mk('2026-02-01T00:00:00Z')];
    const seen: string[] = [];
    let cursor = '';
    for (let i = 0; i < 5; i++) {
      const res = await request(srv()).get(`/meetings?limit=1${cursor}`).expect(200);
      seen.push(...res.body.items.map((m: { id: string }) => m.id));
      if (!res.body.next_cursor) break;
      cursor = `&cursor=${res.body.next_cursor}`;
    }
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('bad cursor 400', async () => {
    await request(srv()).get('/meetings?cursor=not-a-cursor').expect(400);
    const wrongShape = Buffer.from(JSON.stringify({ sort_at: 'x', id: 1 })).toString('base64url');
    await request(srv()).get(`/meetings?cursor=${wrongShape}`).expect(400);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    await request(srv()).get(`/meetings?cursor=${enc({ sort_at: '2026', id: 'mtg_1' })}`).expect(400);
    await request(srv()).get(`/meetings?cursor=${enc({ sort_at: '2026-01-01 00:00:00+00', id: 'x' })}`).expect(400);
    await request(srv()).get(`/meetings?cursor=${enc({ sort_at: '2026-02-31 00:00:00+00', id: 'mtg_1' })}`).expect(400);
  });

  it('bad limit 400', async () => {
    await request(srv()).get('/meetings?limit=0').expect(400);
  });
});
