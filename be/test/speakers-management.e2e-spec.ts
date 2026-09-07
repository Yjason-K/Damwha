import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('speakers management (DELETE)', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  let storageRoot: string;

  beforeAll(async () => {
    db = await startTestDb();
    storageRoot = db.storageRoot;
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
    const lens = await db.pool.query(
      `INSERT INTO lens_item(meeting_id,kind,text,source,user_modified,assignee_speaker_id)
       VALUES($1,'action','문서 작성','user',true,$2) RETURNING id`,
      [mid, sid],
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
    const lensRow = await db.pool.query('SELECT assignee_speaker_id FROM lens_item WHERE id=$1', [lens.rows[0].id]);
    expect(lensRow.rowCount).toBe(1);
    expect(lensRow.rows[0].assignee_speaker_id).toBeNull();
    // on-disk directory removed
    expect(fs.existsSync(speakerDir(sid))).toBe(false);
  });

  it('DELETE /speakers/:id clears a pending merge suggestion pointing at it, score and all', async () => {
    // The FK is ON DELETE SET NULL, which would blank the id and strand the score.
    // The delete path must clear both so no scoreless half-suggestion survives.
    const created = await enroll('제안대상');
    const sid = created.body.id;
    await db.pool.query(`UPDATE job SET status='done' WHERE id=$1`, [created.body.current_job_id]);
    await db.pool.query(`UPDATE speaker SET enrollment_status='ready' WHERE id=$1`, [sid]);

    const m = await db.pool.query(`INSERT INTO meeting(audio_key,status) VALUES('k','done') RETURNING id`);
    const own = await db.pool.query(
      `INSERT INTO speaker(name,enrollment_status) VALUES('Speaker_901','provisional') RETURNING id`);
    const cluster = await db.pool.query(
      `INSERT INTO meeting_cluster(meeting_id,diar_label,resolved_speaker_id,
         suggested_speaker_id,suggested_similarity,processing_version)
       VALUES($1,'S0',$2,$3,0.66,0) RETURNING id`,
      [m.rows[0].id, own.rows[0].id, sid],
    );

    expect((await request(srv()).delete(`/speakers/${sid}`)).status).toBe(204);

    const row = await db.pool.query(
      'SELECT resolved_speaker_id, suggested_speaker_id, suggested_similarity FROM meeting_cluster WHERE id=$1',
      [cluster.rows[0].id],
    );
    expect(row.rows[0].suggested_speaker_id).toBeNull();
    expect(row.rows[0].suggested_similarity).toBeNull();
    // The cluster and its own speaker are untouched — a suggestion is only a hint.
    expect(row.rows[0].resolved_speaker_id).toBe(own.rows[0].id);
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

  it('GET /speakers hides a provisional speaker nothing references any more', async () => {
    // 재처리는 meeting_cluster를 통째로 갈아끼우지만 utterance는 보존한다(013).
    // 그 사이 아무것도 안 가리키게 된 provisional은 워커의 persist GC가 지울
    // 대상인데, 다음 persist까지는 남아 "말한 적 없는 화자"로 목록에 떴다.
    const orphan = await db.pool.query(
      `INSERT INTO speaker(name, enrollment_status) VALUES('Speaker_099','provisional') RETURNING id`,
    );
    const res = await request(srv()).get('/speakers').expect(200);
    expect(res.body.map((s: { id: string }) => s.id)).not.toContain(orphan.rows[0].id);
  });

  it('GET /speakers keeps a provisional speaker that still has utterances or a cluster', async () => {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key,status) VALUES('k','done') RETURNING id`,
    );
    const mid = m.rows[0].id;
    const withUtterance = await db.pool.query(
      `INSERT INTO speaker(name, enrollment_status) VALUES('Speaker_001','provisional') RETURNING id`,
    );
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,speaker_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,$2,'S0',0,1000,'안녕','ok',0,0)`,
      [mid, withUtterance.rows[0].id],
    );
    const withCluster = await db.pool.query(
      `INSERT INTO speaker(name, enrollment_status) VALUES('Speaker_002','provisional') RETURNING id`,
    );
    await db.pool.query(
      `INSERT INTO meeting_cluster(meeting_id,diar_label,resolved_speaker_id,processing_version)
       VALUES($1,'S1',$2,0)`,
      [mid, withCluster.rows[0].id],
    );
    const suggested = await db.pool.query(
      `INSERT INTO speaker(name, enrollment_status) VALUES('Speaker_003','provisional') RETURNING id`,
    );
    // 미응답 제안도 참조로 친다 — 워커 GC와 같은 규칙
    await db.pool.query(
      `INSERT INTO meeting_cluster(meeting_id,diar_label,suggested_speaker_id,suggested_similarity,processing_version)
       VALUES($1,'S2',$2,0.7,0)`,
      [mid, suggested.rows[0].id],
    );

    const res = await request(srv()).get('/speakers').expect(200);
    const ids = res.body.map((s: { id: string }) => s.id);
    expect(ids).toContain(withUtterance.rows[0].id);
    expect(ids).toContain(withCluster.rows[0].id);
    expect(ids).toContain(suggested.rows[0].id);
  });

  it('GET /speakers keeps an enrolled speaker even with no cluster at all', async () => {
    // 등록 화자는 음성 샘플로 만들어져 클러스터가 없는 게 정상이다
    const ready = await db.pool.query(
      `INSERT INTO speaker(name, enrollment_status) VALUES('김영재','ready') RETURNING id`,
    );
    const pending = await db.pool.query(
      `INSERT INTO speaker(name, enrollment_status) VALUES('대기','pending') RETURNING id`,
    );
    const res = await request(srv()).get('/speakers').expect(200);
    const ids = res.body.map((s: { id: string }) => s.id);
    expect(ids).toContain(ready.rows[0].id);
    expect(ids).toContain(pending.rows[0].id);
  });

  it('DELETE /speakers/:id → 404 for unknown id', async () => {
    const res = await request(srv()).delete('/speakers/spk_999999');
    expect(res.status).toBe(404);
  });
});
