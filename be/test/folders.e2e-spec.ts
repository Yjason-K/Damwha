import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { startTestDb, StartedTestDb } from './db';

describe('meeting folders api', () => {
  let db: StartedTestDb;
  let app: NestExpressApplication;

  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CAPABILITIES)
      .useValue({
        platform: 'darwin', arch: 'arm64', chip: 'test', memory_gb: 32,
        gpu_eligible: true, recommended_preset: 'standard',
      })
      .compile();
    app = mod.createNestApplication<NestExpressApplication>();
    await app.init();
  });

  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  const srv = () => app.getHttpServer();
  const create = (name: unknown) => request(srv()).post('/folders').send({ name });
  const defaultId = async () =>
    (await db.pool.query(`SELECT id FROM folder WHERE is_default`)).rows[0].id as string;
  const mkMeeting = async (folderId: string) =>
    (await db.pool.query(
      `INSERT INTO meeting(audio_key,status,folder_id) VALUES('audio','done',$1) RETURNING id`,
      [folderId],
    )).rows[0].id as string;

  it('GET /folders는 기본 폴더 하나로 시작한다', async () => {
    const res = await request(srv()).get('/folders').expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toEqual({
      id: expect.stringMatching(/^fld_[1-9][0-9]*$/),
      name: '기본 폴더',
      is_default: true,
      created_at: expect.any(String),
    });
  });

  it('POST /folders는 이름을 다듬어 만들고 201을 준다', async () => {
    const res = await create('  프로젝트A ').expect(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^fld_[1-9][0-9]*$/),
      name: '프로젝트A',
      is_default: false,
      created_at: expect.any(String),
    });
  });

  it('대소문자만 다른 이름은 409', async () => {
    await create('Alpha').expect(201);
    await create('alpha').expect(409);
    await create(' ALPHA ').expect(409);
  });

  it('이름 규칙을 어기면 400', async () => {
    await create('').expect(400);
    await create('   ').expect(400);
    await create('가'.repeat(31)).expect(400);
    await create(123).expect(400);
    await request(srv()).post('/folders').send({}).expect(400);
    await create('가'.repeat(30)).expect(201);
  });

  it('목록은 기본 폴더가 먼저, 나머지는 이름순', async () => {
    for (const n of ['채용', 'b팀', '고객', 'A사']) await create(n).expect(201);
    const res = await request(srv()).get('/folders').expect(200);
    expect(res.body.map((f: any) => f.name)).toEqual(['기본 폴더', 'A사', 'b팀', '고객', '채용']);
  });

  it('PATCH /folders/:id는 이름을 바꾸고, 중복은 409', async () => {
    const a = (await create('하나').expect(201)).body;
    await create('둘').expect(201);
    const renamed = await request(srv()).patch(`/folders/${a.id}`).send({ name: ' 셋 ' }).expect(200);
    expect(renamed.body).toEqual({ ...a, name: '셋' });
    await request(srv()).patch(`/folders/${a.id}`).send({ name: '둘' }).expect(409);
    await request(srv()).patch(`/folders/${a.id}`).send({ name: '' }).expect(400);
  });

  it('기본 폴더는 이름을 바꿀 수 없다 (400)', async () => {
    const id = await defaultId();
    const res = await request(srv()).patch(`/folders/${id}`).send({ name: '다른 이름' }).expect(400);
    expect(res.body.message).toBe('default folder cannot be renamed');
    const row = await db.pool.query(`SELECT name FROM folder WHERE id=$1`, [id]);
    expect(row.rows[0].name).toBe('기본 폴더');
  });

  it('없는·잘못된 id의 PATCH는 404', async () => {
    await request(srv()).patch('/folders/fld_999').send({ name: 'x' }).expect(404);
    await request(srv()).patch('/folders/nope').send({ name: 'x' }).expect(404);
  });

  it('DELETE /folders/:id는 그 폴더의 회의를 기본 폴더로 옮기고 회의는 남긴다', async () => {
    const def = await defaultId();
    const folder = (await create('지울 폴더').expect(201)).body;
    const keep = (await create('남길 폴더').expect(201)).body;
    const moved = [await mkMeeting(folder.id), await mkMeeting(folder.id)];
    const untouched = await mkMeeting(keep.id);
    const before = (await db.pool.query(`SELECT count(*)::int AS n FROM meeting`)).rows[0].n;

    await request(srv()).delete(`/folders/${folder.id}`).expect(204);

    const after = (await db.pool.query(`SELECT count(*)::int AS n FROM meeting`)).rows[0].n;
    expect(after).toBe(before);
    const { rows } = await db.pool.query(
      `SELECT id, folder_id FROM meeting WHERE id = ANY($1::text[]) ORDER BY id`, [moved],
    );
    expect(rows.map((r) => r.folder_id)).toEqual([def, def]);
    const other = await db.pool.query(`SELECT folder_id FROM meeting WHERE id=$1`, [untouched]);
    expect(other.rows[0].folder_id).toBe(keep.id);
    expect((await db.pool.query(`SELECT 1 FROM folder WHERE id=$1`, [folder.id])).rowCount).toBe(0);
  });

  it('기본 폴더는 지울 수 없다 (400)', async () => {
    const id = await defaultId();
    const res = await request(srv()).delete(`/folders/${id}`).expect(400);
    expect(res.body.message).toBe('default folder cannot be deleted');
    expect((await db.pool.query(`SELECT 1 FROM folder WHERE id=$1`, [id])).rowCount).toBe(1);
  });

  it('없는·잘못된 id의 DELETE는 404', async () => {
    await request(srv()).delete('/folders/fld_999').expect(404);
    await request(srv()).delete('/folders/nope').expect(404);
  });

  it('folder_id를 생략한 raw INSERT는 컬럼 DEFAULT로 기본 폴더에 들어간다', async () => {
    const def = await defaultId();
    const { rows } = await db.pool.query(`INSERT INTO meeting(audio_key) VALUES('k') RETURNING folder_id`);
    expect(rows[0].folder_id).toBe(def);
  });

  it('업로드한 회의는 기본 폴더에 들어가고, folder_id는 NOT NULL이다', async () => {
    const def = await defaultId();
    const res = await request(srv())
      .post('/meetings')
      .attach('audio', Buffer.from('fake-audio'), { filename: 'rec.m4a', contentType: 'audio/mp4' })
      .expect(201);
    expect(res.body.folder_id).toBe(def);
    await expect(
      db.pool.query(`INSERT INTO meeting(audio_key,status,folder_id) VALUES('k','done',NULL)`),
    ).rejects.toThrow(/folder_id/);
    const nulls = await db.pool.query(`SELECT count(*)::int AS n FROM meeting WHERE folder_id IS NULL`);
    expect(nulls.rows[0].n).toBe(0);
  });

  it('회의가 남은 폴더는 옮기지 않고 지우면 FK가 막는다', async () => {
    const folder = (await create('FK').expect(201)).body;
    await mkMeeting(folder.id);
    await expect(db.pool.query(`DELETE FROM folder WHERE id=$1`, [folder.id])).rejects.toThrow(/foreign key/);
  });
});
