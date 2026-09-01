import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { startTestDb, StartedTestDb } from './db';

describe('meeting note api', () => {
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
    // 프로덕션 main.ts와 같은 상한을 걸어야 한다 — Express 기본(100kb)으로는
    // 100,000자 상한(UTF-8로 ~300KB) 근처의 케이스를 파서 단계에서 잘못 잘라낸다.
    app.useBodyParser('json', { limit: '1mb' });
    await app.init();
  });

  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  const srv = () => app.getHttpServer();
  const mkMeeting = async () =>
    (await db.pool.query(
      `INSERT INTO meeting(audio_key,status,title) VALUES('audio','done','회의') RETURNING id`,
    )).rows[0].id as string;

  it('메모가 없으면 note는 null이다', async () => {
    const id = await mkMeeting();
    const { body } = await request(srv()).get(`/meetings/${id}/note`).expect(200);
    expect(body).toEqual({ note: null });
  });

  it('PUT이 메모를 만들고 GET이 그대로 돌려준다', async () => {
    const id = await mkMeeting();
    const put = await request(srv())
      .put(`/meetings/${id}/note`)
      .send({ body_md: '## 결정사항\n- 배포는 다음 주' })
      .expect(200);
    expect(put.body.note.body_md).toBe('## 결정사항\n- 배포는 다음 주');
    expect(typeof put.body.note.updated_at).toBe('string');

    const { body } = await request(srv()).get(`/meetings/${id}/note`).expect(200);
    expect(body.note.body_md).toBe('## 결정사항\n- 배포는 다음 주');
  });

  it('두 번째 PUT은 행을 늘리지 않고 갱신한다', async () => {
    const id = await mkMeeting();
    await request(srv()).put(`/meetings/${id}/note`).send({ body_md: '첫 줄' }).expect(200);
    await request(srv()).put(`/meetings/${id}/note`).send({ body_md: '고친 줄' }).expect(200);

    const { rows } = await db.pool.query('SELECT body_md FROM meeting_note WHERE meeting_id=$1', [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].body_md).toBe('고친 줄');
  });

  it('본문 앞뒤 공백을 다듬지 않는다 — 줄 끝 두 칸은 마크다운 줄바꿈이다', async () => {
    const id = await mkMeeting();
    const body_md = '첫 줄  \n둘째 줄\n';
    await request(srv()).put(`/meetings/${id}/note`).send({ body_md }).expect(200);
    const { body } = await request(srv()).get(`/meetings/${id}/note`).expect(200);
    expect(body.note.body_md).toBe(body_md);
  });

  it('공백만 보내면 204와 함께 행이 사라진다', async () => {
    const id = await mkMeeting();
    await request(srv()).put(`/meetings/${id}/note`).send({ body_md: '지울 메모' }).expect(200);
    await request(srv()).put(`/meetings/${id}/note`).send({ body_md: '   \n  ' }).expect(204);

    const { body } = await request(srv()).get(`/meetings/${id}/note`).expect(200);
    expect(body).toEqual({ note: null });
  });

  it('없는 회의는 404다', async () => {
    await request(srv()).get('/meetings/mtg_999999/note').expect(404);
    await request(srv()).put('/meetings/mtg_999999/note').send({ body_md: '가' }).expect(404);
  });

  it('문자열이 아니거나 상한을 넘으면 400이다', async () => {
    const id = await mkMeeting();
    await request(srv()).put(`/meetings/${id}/note`).send({ body_md: 42 }).expect(400);
    // 파서 상한(1mb)을 함께 올려뒀으므로 이 요청은 파서가 아니라 서비스의
    // 길이 검사에서 400을 받는다 — 파서 상한 그대로였다면 413이었을 것.
    await request(srv()).put(`/meetings/${id}/note`).send({ body_md: 'ㄱ'.repeat(100001) }).expect(400);
  });

  it('정확히 100000자는 저장되고 그대로 돌아온다', async () => {
    const id = await mkMeeting();
    const body_md = 'ㄱ'.repeat(100000);
    const put = await request(srv()).put(`/meetings/${id}/note`).send({ body_md }).expect(200);
    expect(put.body.note.body_md).toHaveLength(100000);

    const { body } = await request(srv()).get(`/meetings/${id}/note`).expect(200);
    expect(body.note.body_md).toHaveLength(100000);
    expect(body.note.body_md).toBe(body_md);
  });

  it('회의를 지우면 메모도 사라진다', async () => {
    const id = await mkMeeting();
    await request(srv()).put(`/meetings/${id}/note`).send({ body_md: '메모' }).expect(200);
    await db.pool.query('DELETE FROM meeting WHERE id=$1', [id]);
    const { rows } = await db.pool.query('SELECT 1 FROM meeting_note WHERE meeting_id=$1', [id]);
    expect(rows).toHaveLength(0);
  });
});
