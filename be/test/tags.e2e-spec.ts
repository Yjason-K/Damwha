import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { startTestDb, StartedTestDb } from './db';

describe('meeting tags api', () => {
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
  const mkMeeting = async () =>
    (await db.pool.query(
      `INSERT INTO meeting(audio_key,status,title) VALUES('audio','done','회의') RETURNING id`,
    )).rows[0].id as string;
  const setTags = (id: string, names: unknown) =>
    request(srv()).put(`/meetings/${id}/tags`).send({ names });

  it('PUT이 태그를 만들어 붙이고, 회의 상세·목록·태그 목록에 나온다', async () => {
    const id = await mkMeeting();
    const put = await setTags(id, ['주간회의', '프로젝트A']).expect(200);
    expect(put.body.tags.map((t: any) => t.name)).toEqual(['주간회의', '프로젝트A']);
    expect(put.body.tags[0].id).toMatch(/^tag_\d+$/);

    const detail = await request(srv()).get(`/meetings/${id}`).expect(200);
    expect(detail.body.tags).toEqual(put.body.tags);
    const list = await request(srv()).get('/meetings').expect(200);
    expect(list.body.find((m: any) => m.id === id).tags).toEqual(put.body.tags);

    const tags = await request(srv()).get('/tags').expect(200);
    expect(tags.body).toEqual([
      { ...put.body.tags[0], meeting_count: 1 },
      { ...put.body.tags[1], meeting_count: 1 },
    ]);
  });

  it('태그는 DB 로캘과 무관하게 가나다순(영문 먼저)으로 나온다', async () => {
    const id = await mkMeeting();
    const put = await setTags(id, ['채용', '프로젝트', '고객', 'b팀', 'A사', '예산']).expect(200);
    const expected = ['A사', 'b팀', '고객', '예산', '채용', '프로젝트'];
    expect(put.body.tags.map((t: any) => t.name)).toEqual(expected);
    const tags = await request(srv()).get('/tags').expect(200);
    expect(tags.body.map((t: any) => t.name)).toEqual(expected);
  });

  it('태그가 없는 회의는 빈 배열을 준다', async () => {
    const id = await mkMeeting();
    expect((await request(srv()).get(`/meetings/${id}`)).body.tags).toEqual([]);
    expect((await request(srv()).get('/meetings')).body[0].tags).toEqual([]);
  });

  it('같은 이름은 대소문자·앞뒤 공백을 가리지 않고 한 태그로 공유된다', async () => {
    const a = await mkMeeting();
    const b = await mkMeeting();
    const first = await setTags(a, ['API']).expect(200);
    const second = await setTags(b, ['  api ', 'Api']).expect(200);
    expect(second.body.tags).toEqual(first.body.tags);
    const tags = await request(srv()).get('/tags').expect(200);
    expect(tags.body).toEqual([{ ...first.body.tags[0], meeting_count: 2 }]);
  });

  it('PUT은 집합을 통째로 바꾸고, 어디에도 안 붙은 태그는 지운다', async () => {
    const id = await mkMeeting();
    await setTags(id, ['남김', '뗌']).expect(200);
    const put = await setTags(id, ['남김']).expect(200);
    expect(put.body.tags.map((t: any) => t.name)).toEqual(['남김']);
    const { rows } = await db.pool.query(`SELECT name FROM tag ORDER BY name`);
    expect(rows.map((r) => r.name)).toEqual(['남김']);

    await setTags(id, []).expect(200);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM tag`)).rows[0].n).toBe(0);
  });

  it('회의를 지워 고아가 된 태그는 태그 목록에 나오지 않는다', async () => {
    const id = await mkMeeting();
    await setTags(id, ['고아']).expect(200);
    await request(srv()).delete(`/meetings/${id}`).expect(204);
    expect((await request(srv()).get('/tags').expect(200)).body).toEqual([]);
  });

  it('잘못된 입력은 400', async () => {
    const id = await mkMeeting();
    await setTags(id, 'x').expect(400);
    await setTags(id, [1]).expect(400);
    await setTags(id, ['   ']).expect(400);
    await setTags(id, ['가'.repeat(31)]).expect(400);
    await setTags(id, Array.from({ length: 21 }, (_, i) => `t${i}`)).expect(400);
    await request(srv()).put(`/meetings/${id}/tags`).send({}).expect(400);
  });

  it('없는 회의·잘못된 id는 404', async () => {
    await setTags('mtg_999', ['a']).expect(404);
    await setTags('nope', ['a']).expect(404);
  });

  it('검색 filters.tagIds가 그 태그 회의의 발화만 남기고, 잘못된 id는 400', async () => {
    const tagged = await mkMeeting();
    const other = await mkMeeting();
    for (const mid of [tagged, other]) {
      await db.pool.query(
        `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
         VALUES($1,'SPEAKER_00',0,1000,'예산 이야기','ok',0,0)`,
        [mid],
      );
    }
    const tagId = (await setTags(tagged, ['예산']).expect(200)).body.tags[0].id;
    const res = await request(srv())
      .post('/search').send({ q: '', filters: { tagIds: [tagId] } }).expect(201);
    expect(res.body.results.map((r: any) => r.meetingId)).toEqual([tagged]);
    await request(srv()).post('/search').send({ filters: { tagIds: ['mtg_1'] } }).expect(400);
  });
});
