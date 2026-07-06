import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('speakers management (DELETE)', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  let storageRoot: string;

  beforeAll(async () => {
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-spk-mgmt-'));
    process.env.STORAGE_ROOT = storageRoot;
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => {
    await app?.close();
    await db?.stop();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  const srv = () => app.getHttpServer();
  const speakerDir = (id: string) => path.join(storageRoot, 'speakers', id);

  // Enroll writes the sample file + a queued enroll_speaker job (status 'pending').
  const enroll = async (name: string) =>
    request(srv())
      .post('/speakers')
      .field('name', name)
      .attach('audio', Buffer.from('sample'), { filename: 'voice.wav', contentType: 'audio/wav' });

  it('DELETE /speakers/:id un-references utterances/clusters, cascades voiceprints, removes files, 204', async () => {
    const created = await enroll('홍길동');
    const sid = created.body.id;
    expect(fs.existsSync(speakerDir(sid))).toBe(true);
    // settle the enroll job so it no longer blocks deletion
    await db.pool.query(
      `UPDATE job SET status='done' WHERE id=$1`, [created.body.current_job_id],
    );
    await db.pool.query(`UPDATE speaker SET enrollment_status='ready' WHERE id=$1`, [sid]);

    // references that would otherwise block the DELETE (NO ACTION FKs)
    const m = await db.pool.query(`INSERT INTO meeting(audio_key,status) VALUES('k','done') RETURNING id`);
    const mid = m.rows[0].id;
    const utt = await db.pool.query(
      `INSERT INTO utterance(meeting_id,speaker_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,$2,'S0',0,1000,'안녕','ok',0,0) RETURNING id`,
      [mid, sid],
    );
    const cluster = await db.pool.query(
      `INSERT INTO meeting_cluster(meeting_id,diar_label,resolved_speaker_id,processing_version)
       VALUES($1,'S0',$2,0) RETURNING id`,
      [mid, sid],
    );
    const vp = '[' + Array(192).fill(0).join(',') + ']';
    await db.pool.query(
      `INSERT INTO voiceprint(speaker_id,embedding,model,dimension) VALUES($1,$2::vector,'m',192)`,
      [sid, vp],
    );

    const res = await request(srv()).delete(`/speakers/${sid}`);
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});

    // speaker gone, voiceprints cascaded
    expect((await db.pool.query('SELECT 1 FROM speaker WHERE id=$1', [sid])).rowCount).toBe(0);
    expect((await db.pool.query('SELECT 1 FROM voiceprint WHERE speaker_id=$1', [sid])).rowCount).toBe(0);
    // references un-set, not deleted
    const uRow = await db.pool.query('SELECT speaker_id FROM utterance WHERE id=$1', [utt.rows[0].id]);
    expect(uRow.rowCount).toBe(1);
    expect(uRow.rows[0].speaker_id).toBeNull();
    const cRow = await db.pool.query('SELECT resolved_speaker_id FROM meeting_cluster WHERE id=$1', [cluster.rows[0].id]);
    expect(cRow.rowCount).toBe(1);
    expect(cRow.rows[0].resolved_speaker_id).toBeNull();
    // on-disk directory removed
    expect(fs.existsSync(speakerDir(sid))).toBe(false);
  });

  it('DELETE /speakers/:id → 409 (Korean message) while an enroll job is queued/running', async () => {
    const created = await enroll('진행중화자');
    const sid = created.body.id;
    const jobId = created.body.current_job_id;

    // queued
    const queued = await request(srv()).delete(`/speakers/${sid}`);
    expect(queued.status).toBe(409);
    expect(queued.body.message).toContain('진행 중인 화자 등록');
    expect((await db.pool.query('SELECT 1 FROM speaker WHERE id=$1', [sid])).rowCount).toBe(1);

    // running
    await db.pool.query(`UPDATE job SET status='running' WHERE id=$1`, [jobId]);
    const running = await request(srv()).delete(`/speakers/${sid}`);
    expect(running.status).toBe(409);
    expect((await db.pool.query('SELECT 1 FROM speaker WHERE id=$1', [sid])).rowCount).toBe(1);

    // once done, deletion is allowed
    await db.pool.query(`UPDATE job SET status='done' WHERE id=$1`, [jobId]);
    expect((await request(srv()).delete(`/speakers/${sid}`)).status).toBe(204);
  });

  it('DELETE /speakers/:id → 409 (Korean message) while a process_meeting job is queued/running', async () => {
    const created = await enroll('처리중대상');
    const sid = created.body.id;
    // settle the enroll job so only the process_meeting guard is under test
    await db.pool.query(`UPDATE job SET status='done' WHERE id=$1`, [created.body.current_job_id]);
    await db.pool.query(`UPDATE speaker SET enrollment_status='ready' WHERE id=$1`, [sid]);

    // an unrelated meeting whose pipeline is in flight (may bind this speaker at persist)
    const m = await db.pool.query(`INSERT INTO meeting(audio_key,status) VALUES('k','processing') RETURNING id`);
    const proc = await db.pool.query(
      `INSERT INTO job(type,meeting_id,payload,status) VALUES('process_meeting',$1,'{}'::jsonb,'queued') RETURNING id`,
      [m.rows[0].id],
    );

    // queued
    const queued = await request(srv()).delete(`/speakers/${sid}`);
    expect(queued.status).toBe(409);
    expect(queued.body.message).toContain('회의 처리가 진행 중');
    expect((await db.pool.query('SELECT 1 FROM speaker WHERE id=$1', [sid])).rowCount).toBe(1);

    // running
    await db.pool.query(`UPDATE job SET status='running' WHERE id=$1`, [proc.rows[0].id]);
    expect((await request(srv()).delete(`/speakers/${sid}`)).status).toBe(409);
    expect((await db.pool.query('SELECT 1 FROM speaker WHERE id=$1', [sid])).rowCount).toBe(1);

    // once the pipeline finishes, deletion is allowed
    await db.pool.query(`UPDATE job SET status='done' WHERE id=$1`, [proc.rows[0].id]);
    expect((await request(srv()).delete(`/speakers/${sid}`)).status).toBe(204);
  });

  it('DELETE /speakers/:id → 404 for unknown id', async () => {
    const res = await request(srv()).delete('/speakers/spk_999999');
    expect(res.status).toBe(404);
  });
});
