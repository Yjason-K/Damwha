import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';

describe('meetings', () => {
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

  it('POST /meetings stores file, creates meeting + queued job + current_job_id', async () => {
    const res = await request(srv())
      .post('/meetings')
      .field('title', '기획회의')
      .attach('audio', Buffer.from('fake-audio'), { filename: 'rec.m4a', contentType: 'audio/mp4' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('uploaded');
    expect(res.body.title).toBe('기획회의');
    expect(res.body.id).toMatch(/^mtg_[1-9][0-9]*$/);
    expect(res.body.audio_key).toMatch(/^meetings\/mtg_[1-9][0-9]*\/original\.m4a$/);
    expect(res.body.current_job_id).toMatch(/^job_[1-9][0-9]*$/);

    const job = await db.pool.query('SELECT * FROM job WHERE id=$1', [res.body.current_job_id]);
    expect(job.rows[0].type).toBe('process_meeting');
    expect(job.rows[0].status).toBe('queued');
    expect(job.rows[0].payload.audio_key).toBe(res.body.audio_key);
    expect(job.rows[0].payload.processing_version).toBe(0);
  });

  it('POST /meetings preserves a Korean original filename (no mojibake)', async () => {
    // Browsers send the filename as raw UTF-8 bytes in the Content-Disposition
    // header; busboy then decodes them as latin1, producing mojibake. form-data
    // writes the header as UTF-8, so passing the plain Korean name reproduces
    // exactly the bytes a browser puts on the wire.
    const koreanName = '회의록.m4a';
    const res = await request(srv())
      .post('/meetings')
      .attach('audio', Buffer.from('fake-audio'), { filename: koreanName, contentType: 'audio/mp4' });
    expect(res.status).toBe(201);
    expect(res.body.original_filename).toBe(koreanName);

    const row = await db.pool.query('SELECT original_filename FROM meeting WHERE id=$1', [res.body.id]);
    expect(row.rows[0].original_filename).toBe(koreanName);
  });

  it('POST /meetings rejects non-audio mime', async () => {
    const res = await request(srv())
      .post('/meetings')
      .attach('audio', Buffer.from('x'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });

  it('GET /meetings/:id returns meeting with ordered utterances', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,speaker_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES ($1,NULL,'SPEAKER_00',1000,2000,'두번째','ok',1,0),
              ($1,NULL,'SPEAKER_00',0,900,'첫번째','ok',0,0)`,
      [mid],
    );
    const res = await request(srv()).get(`/meetings/${mid}`);
    expect(res.status).toBe(200);
    expect(res.body.utterances.map((u: any) => u.text)).toEqual(['첫번째', '두번째']);
  });

  it('GET /meetings/:id returns only utterances from the current processing version', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    await db.pool.query(`UPDATE meeting SET processing_version=1 WHERE id=$1`, [mid]);
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES ($1,'SPEAKER_00',0,900,'이전 결과','ok',0,0),
              ($1,'SPEAKER_00',0,900,'새 결과','ok',0,1)`,
      [mid],
    );

    const res = await request(srv()).get(`/meetings/${mid}`);
    expect(res.status).toBe(200);
    expect(res.body.utterances.map((u: any) => u.text)).toEqual(['새 결과']);
  });

  it('GET /meetings/:id → 404 for unknown id', async () => {
    const res = await request(srv()).get('/meetings/99999999-9999-9999-9999-999999999999');
    expect(res.status).toBe(404);
  });

  it('GET /meetings/:id/status reflects job stage/progress', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    await db.pool.query(
      `UPDATE job SET status='running', stage='stt', progress=60 WHERE id=$1`,
      [created.body.current_job_id],
    );
    const res = await request(srv()).get(`/meetings/${mid}/status`);
    expect(res.body).toMatchObject({ status: 'uploaded', stage: 'stt', progress: 60 });
  });

  it('POST /meetings/:id/reprocess bumps version + enqueues new job (done only)', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    // not allowed while uploaded
    expect((await request(srv()).post(`/meetings/${mid}/reprocess`)).status).toBe(409);
    await db.pool.query(`UPDATE meeting SET status='done' WHERE id=$1`, [mid]);
    const res = await request(srv()).post(`/meetings/${mid}/reprocess`);
    expect(res.status).toBe(202);
    const mt = await db.pool.query('SELECT processing_version, current_job_id, status FROM meeting WHERE id=$1', [mid]);
    expect(mt.rows[0].processing_version).toBe(1);
    expect(mt.rows[0].status).toBe('uploaded');
    const job = await db.pool.query('SELECT payload, status FROM job WHERE id=$1', [mt.rows[0].current_job_id]);
    expect(job.rows[0].payload.processing_version).toBe(1);
    expect(job.rows[0].payload.reprocess).toBe(true);
  });

  it('POST /meetings — payload가 v2이고 전역 설정(프리셋)을 따른다', async () => {
    await request(srv()).put('/settings/processing').send({ preset: 'light', language: 'ko' });
    const res = await request(srv()).post('/meetings')
      .attach('audio', Buffer.from('a'), { filename: 'a.m4a', contentType: 'audio/mp4' });
    const job = await db.pool.query('SELECT payload FROM job WHERE id=$1', [res.body.current_job_id]);
    expect(job.rows[0].payload.schema_version).toBe(2);
    expect(job.rows[0].payload.models.whisper_model).toBe('small');
    expect(job.rows[0].payload.models.preset).toBe('light');
  });

  it('POST /meetings — processing 오버라이드(JSON 문자열)가 payload에 반영 + custom 전환', async () => {
    const res = await request(srv()).post('/meetings')
      .field('processing', JSON.stringify({ devices: { stt: 'cpu' } }))
      .attach('audio', Buffer.from('a'), { filename: 'a.m4a', contentType: 'audio/mp4' });
    expect(res.status).toBe(201);
    const job = await db.pool.query('SELECT payload FROM job WHERE id=$1', [res.body.current_job_id]);
    expect(job.rows[0].payload.models.devices.stt).toBe('cpu');
    expect(job.rows[0].payload.models.preset).toBe('custom');
  });

  it('POST /meetings — 잘못된 processing → 400 + storage에 파일 미저장 (spec §5)', async () => {
    const res = await request(srv()).post('/meetings')
      .field('processing', '{"nope":1}')
      .attach('audio', Buffer.from('a'), { filename: 'a.m4a', contentType: 'audio/mp4' });
    expect(res.status).toBe(400);
    const meetings = await db.pool.query('SELECT count(*)::int AS n FROM meeting');
    expect(meetings.rows[0].n).toBe(0);
  });

  it('POST /meetings/:id/reprocess — body.processing 반영', async () => {
    const created = await request(srv()).post('/meetings')
      .attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    await db.pool.query(`UPDATE meeting SET status='done' WHERE id=$1`, [mid]);
    const res = await request(srv()).post(`/meetings/${mid}/reprocess`)
      .send({ processing: { preset: 'quality' } });
    expect(res.status).toBe(202);
    const job = await db.pool.query('SELECT payload FROM job WHERE id=$1', [res.body.job_id]);
    expect(job.rows[0].payload.models.whisper_model).toBe('large-v3');
    expect(job.rows[0].payload.models.preset).toBe('quality');
  });

  it('POST /meetings/:id/reindex enqueues an index_meeting job', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    await db.pool.query(`UPDATE meeting SET status='done', processing_version=2 WHERE id=$1`, [mid]);
    const res = await request(srv()).post(`/meetings/${mid}/reindex`);
    expect(res.status).toBe(202);
    const job = await db.pool.query(
      `SELECT type, payload FROM job WHERE meeting_id=$1 AND type='index_meeting'`, [mid],
    );
    expect(job.rowCount).toBe(1);
    expect(job.rows[0].payload.processing_version).toBe(2);
    expect(job.rows[0].payload.search_embedding.model).toBe('BAAI/bge-m3');
  });

  it('POST /meetings/:id/reindex → 404 for unknown meeting', async () => {
    const res = await request(srv()).post('/meetings/99999999-9999-9999-9999-999999999999/reindex');
    expect(res.status).toBe(404);
  });

  it('PUT /meetings/:id/favorite sets is_favorite, reflected in get + list', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    expect(created.body.is_favorite).toBe(false); // 기본값 false

    const put = await request(srv()).put(`/meetings/${mid}/favorite`);
    expect(put.status).toBe(200);
    expect(put.body.is_favorite).toBe(true);

    expect((await request(srv()).get(`/meetings/${mid}`)).body.is_favorite).toBe(true);
    const list = await request(srv()).get('/meetings');
    expect(list.body.find((m: any) => m.id === mid).is_favorite).toBe(true);
  });

  it('DELETE /meetings/:id/favorite clears is_favorite', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    await request(srv()).put(`/meetings/${mid}/favorite`);
    const del = await request(srv()).delete(`/meetings/${mid}/favorite`);
    expect(del.status).toBe(200);
    expect(del.body.is_favorite).toBe(false);
    expect((await request(srv()).get(`/meetings/${mid}`)).body.is_favorite).toBe(false);
  });

  it('favorite PUT/DELETE are idempotent', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    expect((await request(srv()).put(`/meetings/${mid}/favorite`)).body.is_favorite).toBe(true);
    expect((await request(srv()).put(`/meetings/${mid}/favorite`)).body.is_favorite).toBe(true); // PUT 2회
    expect((await request(srv()).delete(`/meetings/${mid}/favorite`)).body.is_favorite).toBe(false);
    expect((await request(srv()).delete(`/meetings/${mid}/favorite`)).body.is_favorite).toBe(false); // 미설정 DELETE
  });

  it('favorite PUT/DELETE → 404 for unknown meeting', async () => {
    const unknown = 'mtg_999999';
    expect((await request(srv()).put(`/meetings/${unknown}/favorite`)).status).toBe(404);
    expect((await request(srv()).delete(`/meetings/${unknown}/favorite`)).status).toBe(404);
  });

  it('favorite PUT/DELETE → 404 for malformed id', async () => {
    // ParseUUIDPipe 제거: 형식 검증 없음 → 존재하지 않는 id는 404 (400 아님)
    expect((await request(srv()).put('/meetings/not-an-id/favorite')).status).toBe(404);
    expect((await request(srv()).delete('/meetings/not-an-id/favorite')).status).toBe(404);
  });

  it('POST /meetings/reindex-missing enqueues only meetings with a missing-embedding indexable utterance', async () => {
    const zeros = '[' + Array(1024).fill(0).join(',') + ']';
    const mk = async () =>
      (await db.pool.query(`INSERT INTO meeting(audio_key,status,processing_version) VALUES('k','done',0) RETURNING id`)).rows[0].id;
    const utt = async (m: string, text: string | null, status: string) =>
      (await db.pool.query(
        `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
         VALUES($1,'S',0,1,$2,$3,0,0) RETURNING id`, [m, text, status],
      )).rows[0].id;

    // A: ok+text utterance, no embedding → MUST enqueue
    const a = await mk(); await utt(a, '안녕', 'ok');
    // B: ok+text utterance WITH current-model embedding → fully indexed, skip
    const b = await mk(); const ub = await utt(b, 'hi', 'ok');
    await db.pool.query(`INSERT INTO utterance_embedding(utterance_id,embedding,model,dimension,processing_version) VALUES($1,$2::vector,'BAAI/bge-m3',1024,0)`, [ub, zeros]);
    // C: only silence/text-NULL utterance → no indexable target, skip (무한루프 방지)
    const c = await mk(); await utt(c, null, 'silence');
    // D: missing embedding BUT in-flight index job exists → skip
    const d = await mk(); await utt(d, 'x', 'ok');
    await db.pool.query(`INSERT INTO job(type,meeting_id,payload,status) VALUES('index_meeting',$1,'{}'::jsonb,'queued')`, [d]);

    const res = await request(srv()).post('/meetings/reindex-missing');
    expect(res.status).toBe(202);
    expect(res.body.enqueued).toBe(1); // only A

    const enq = (await db.pool.query(
      `SELECT meeting_id FROM job WHERE type='index_meeting' AND meeting_id=ANY($1::text[])`, [[a, b, c]],
    )).rows.map((r: any) => r.meeting_id);
    expect(enq).toEqual([a]); // A enqueued; B/C not
  });

  it('GET /meetings/:id includes speaker_name on utterances', async () => {
    const m = await db.pool.query(`INSERT INTO meeting(audio_key,status) VALUES('k','done') RETURNING id`);
    const mid = m.rows[0].id;
    const sp = await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('홍길동','ready') RETURNING id`);
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,speaker_id,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,'S0',$2,0,1000,'안녕','ok',0,0)`,
      [mid, sp.rows[0].id]);
    const res = await request(srv()).get(`/meetings/${mid}`);
    expect(res.status).toBe(200);
    expect(res.body.utterances[0].speaker_name).toBe('홍길동');
    expect(res.body.utterances[0].speaker_status).toBe('ready');
  });

  it('GET /meetings/:id returns clusters (resolved + unresolved) at the current version, ordered by diar_label', async () => {
    const m = await db.pool.query(`INSERT INTO meeting(audio_key,status,processing_version) VALUES('k','done',2) RETURNING id`);
    const mid = m.rows[0].id;
    const sp = await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('홍길동','ready') RETURNING id`);
    const sid = sp.rows[0].id;
    // resolved cluster (S1) + unresolved cluster (S0) at the current version
    const resolved = await db.pool.query(
      `INSERT INTO meeting_cluster(meeting_id,diar_label,resolved_speaker_id,processing_version)
       VALUES($1,'SPEAKER_01',$2,2) RETURNING id`, [mid, sid]);
    const unresolved = await db.pool.query(
      `INSERT INTO meeting_cluster(meeting_id,diar_label,processing_version)
       VALUES($1,'SPEAKER_00',2) RETURNING id`, [mid]);
    // stale-version cluster must be excluded
    await db.pool.query(
      `INSERT INTO meeting_cluster(meeting_id,diar_label,processing_version) VALUES($1,'SPEAKER_09',1)`, [mid]);

    const res = await request(srv()).get(`/meetings/${mid}`);
    expect(res.status).toBe(200);
    expect(res.body.clusters).toEqual([
      { id: unresolved.rows[0].id, diar_label: 'SPEAKER_00', resolved_speaker_id: null, speaker_name: null, speaker_status: null },
      { id: resolved.rows[0].id, diar_label: 'SPEAKER_01', resolved_speaker_id: sid, speaker_name: '홍길동', speaker_status: 'ready' },
    ]);
  });

  it('GET /meetings/:id returns null speaker_name for unattributed utterances', async () => {
    const m = await db.pool.query(`INSERT INTO meeting(audio_key,status) VALUES('k','done') RETURNING id`);
    const mid = m.rows[0].id;
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,'S0',0,1000,'...','ok',0,0)`, [mid]); // no speaker_id → unattributed
    const res = await request(srv()).get(`/meetings/${mid}`);
    expect(res.status).toBe(200);
    expect(res.body.utterances[0].speaker_id).toBeNull();
    expect(res.body.utterances[0].speaker_name).toBeNull();
    expect(res.body.utterances[0].speaker_status).toBeNull();
  });
});
