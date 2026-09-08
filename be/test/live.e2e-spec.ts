import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { JobsRepository } from '../src/jobs/jobs.repository';
import { LiveRepository } from '../src/live/live.repository';
import { LiveSessionPayloadSchema } from '../src/contracts/job-payload.schema';

describe('live session api', () => {
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
    // live-orphan.e2e-spec.ts와 같은 이유 — 이 스위트도 job 행을 직접 SQL로 조작해 결정적인
    // 상태를 기대하므로, AppModule이 등록한 30초 주기 LiveOrphanService.sweepScheduled를 끈다.
    app.get(SchedulerRegistry).getCronJobs().forEach((job) => job.stop());
  });
  afterEach(async () => { jest.restoreAllMocks(); await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  const srv = () => app.getHttpServer();
  const start = (body: object = {}) => request(srv()).post('/meetings/live').send(body);

  /** 워커의 claim을 SQL로 흉내 낸다. */
  const claim = (jobId: string) =>
    db.pool.query(
      `UPDATE job SET status='running', locked_by='w1', locked_at=now(), attempts=1, stage='capture' WHERE id=$1`,
      [jobId],
    );

  // 기본값 offset=final=0, 빈 바디는 "오디오를 한 번도 안 보낸" 0바이트 세션이다.
  // 설계 §3.4대로 그 stop은 **워커 상태와 무관하게 회의를 폐기**하므로, 봉인 뒤에도
  // 회의가 남아 있어야 하는 테스트는 아래 sendChunk로 먼저 오디오를 올린다.
  const stop = (id: string, offset = 0, final = 0, body = Buffer.alloc(0)) =>
    request(srv()).post(`/meetings/${id}/live/stop`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Audio-Offset', String(offset))
      .set('X-Final-Offset', String(final))
      .send(body);

  const CHUNK = 32768;
  const sendChunk = (id: string) =>
    request(srv()).post(`/meetings/${id}/live/audio`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Audio-Offset', '0')
      .send(Buffer.alloc(CHUNK, 1));

  it('POST /meetings/live creates a recording meeting and a live_session job with max_attempts=1', async () => {
    const res = await start({ title: '오늘 회의', defer_summary: true, speakers: { min: 2 } });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('recording');
    expect(res.body.title).toBe('오늘 회의');
    // liveKey()가 만드는 실제 경로다 — spec §2.2/§4와 SMOKE.md가 가정하는 파일이다
    // (LiveService.start()가 meetingKey()를 잘못 쓰던 버그, review finding 4).
    expect(res.body.audio_key).toMatch(/^meetings\/mtg_[1-9][0-9]*\/live\.wav$/);
    const job = (await db.pool.query('SELECT * FROM job WHERE id=$1', [res.body.current_job_id])).rows[0];
    expect(job.type).toBe('live_session');
    expect(job.max_attempts).toBe(1);
    expect(job.stop_requested_at).toBeNull();
    const payload = LiveSessionPayloadSchema.parse(job.payload);
    expect(payload.audio_key).toBe(res.body.audio_key);
    expect(payload.process.followups).toEqual({ lens: true, summary: false });
    expect(payload.process.models.diarization.min_speakers).toBe(2);
    expect(payload.process.processing_version).toBe(0);
  });

  // 신규 browser live job은 파일(PCM 0바이트)과 같은 사실을 committed_bytes=0으로
  // 들고 태어난다 — NULL이면 "아직 시작 전"과 구별이 안 된다 (설계 §3.2).
  it('POST /meetings/live creates the job with committed_bytes=0', async () => {
    const created = await start().expect(201);
    const { rows } = await db.pool.query(
      'SELECT committed_bytes FROM job WHERE id=$1', [created.body.current_job_id],
    );
    expect(rows[0].committed_bytes).toBe('0');
  });

  // 024의 CHECK 제약: committed_bytes는 live_session이고, 0 이상 짝수이며, sealed_bytes가
  // 있으면 그와 같아야 한다. 과거(023 이전) 종료 job과 다른 타입의 NULL은 그대로 허용된다.
  describe('024_live_committed_bytes CHECK', () => {
    it('rejects a negative committed_bytes', async () => {
      await expect(
        db.pool.query(`INSERT INTO job(type, payload, committed_bytes) VALUES('live_session','{}'::jsonb,-2)`),
      ).rejects.toThrow(/check constraint/i);
    });

    it('rejects an odd committed_bytes', async () => {
      await expect(
        db.pool.query(`INSERT INTO job(type, payload, committed_bytes) VALUES('live_session','{}'::jsonb,3)`),
      ).rejects.toThrow(/check constraint/i);
    });

    it('rejects sealed_bytes and committed_bytes disagreeing', async () => {
      await expect(
        db.pool.query(
          `INSERT INTO job(type, payload, sealed_bytes, committed_bytes) VALUES('live_session','{}'::jsonb,10,8)`,
        ),
      ).rejects.toThrow(/check constraint/i);
    });

    it('rejects a non-live_session job carrying committed_bytes', async () => {
      await expect(
        db.pool.query(
          `INSERT INTO job(type, payload, committed_bytes) VALUES('process_meeting','{}'::jsonb,0)`,
        ),
      ).rejects.toThrow(/check constraint/i);
    });

    it('allows a NULL committed_bytes (past sessions, other job types)', async () => {
      await expect(
        db.pool.query(`INSERT INTO job(type, payload) VALUES('live_session','{}'::jsonb)`),
      ).resolves.toBeDefined();
      await expect(
        db.pool.query(`INSERT INTO job(type, payload) VALUES('process_meeting','{}'::jsonb)`),
      ).resolves.toBeDefined();
    });

    it('allows matching sealed_bytes and committed_bytes', async () => {
      await expect(
        db.pool.query(
          `INSERT INTO job(type, payload, sealed_bytes, committed_bytes) VALUES('live_session','{}'::jsonb,10,10)`,
        ),
      ).resolves.toBeDefined();
    });
  });

  it('POST /meetings/live → 409 while another recording exists', async () => {
    await start().expect(201);
    const res = await start();
    expect(res.status).toBe(409);
  });

  it('two simultaneous starts yield exactly one 201 and one 409 (unique index)', async () => {
    const [a, b] = await Promise.all([start(), start()]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM meeting WHERE status='recording'`);
    expect(rows[0].n).toBe(1);
  });

  it('POST /meetings/live → 400 for a bad override or flag, and creates nothing', async () => {
    expect((await start({ processing: { preset: 'huge' } })).status).toBe(400);
    expect((await start({ defer_lens: 'maybe' })).status).toBe(400);
    expect((await start({ title: 42 })).status).toBe(400);
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM meeting');
    expect(rows[0].n).toBe(0);
  });

  it('stop on a queued session discards the meeting and job', async () => {
    const created = await start().expect(201);
    const res = await stop(created.body.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      meeting_id: created.body.id, job_id: created.body.current_job_id,
      sealed_bytes: 0, outcome: 'discarded',
    });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM meeting')).rows[0].n).toBe(0);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM job')).rows[0].n).toBe(0);
  });

  it('stop on a running session sets stop_requested_at once and is idempotent', async () => {
    const created = await start().expect(201);
    await claim(created.body.current_job_id);
    await sendChunk(created.body.id).expect(200);
    const first = await stop(created.body.id, CHUNK, CHUNK).expect(200);
    expect(first.body.outcome).toBe('stopping');
    const at1 = (await db.pool.query('SELECT stop_requested_at FROM job WHERE id=$1', [created.body.current_job_id])).rows[0].stop_requested_at;
    expect(at1).not.toBeNull();
    const second = await stop(created.body.id, CHUNK, CHUNK).expect(200);
    expect(second.body.outcome).toBe('stopping');
    const at2 = (await db.pool.query('SELECT stop_requested_at FROM job WHERE id=$1', [created.body.current_job_id])).rows[0].stop_requested_at;
    expect(new Date(at2).getTime()).toBe(new Date(at1).getTime());
  });

  // 브라우저가 캡처를 끝까지 못 했다는 사실이 탭 밖에 남는 유일한 통로다 (설계 §5.3·§7).
  // 이게 없으면 3분 만에 마이크를 잃은 회의와 깨끗한 회의가 서버에서 구별되지 않는다.
  // 0바이트가 아니라 청크 하나를 올린 뒤 종료한다 — 0바이트 stop은 회의를 폐기하므로
  // (설계 §3.4) capture_error를 읽을 회의 자체가 남지 않는다.
  const stopWithCaptureError = (id: string, code: string) =>
    request(srv()).post(`/meetings/${id}/live/stop`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Audio-Offset', String(CHUNK)).set('X-Final-Offset', String(CHUNK))
      .set('X-Capture-Error', code)
      .send(Buffer.alloc(0));

  it('stop records X-Capture-Error in meeting.capture_error', async () => {
    const created = await start().expect(201);
    await claim(created.body.current_job_id);
    await sendChunk(created.body.id).expect(200);
    await stopWithCaptureError(created.body.id, 'device_ended').expect(200);
    const { rows } = await db.pool.query('SELECT capture_error FROM meeting WHERE id=$1', [created.body.id]);
    expect(rows[0].capture_error).toEqual({
      code: 'device_ended', message: 'the microphone stopped before the user did',
    });
  });

  it('stop still seals on an unknown X-Capture-Error, recording it as capture_failed', async () => {
    const created = await start().expect(201);
    await claim(created.body.current_job_id);
    await sendChunk(created.body.id).expect(200);
    // 진단 헤더가 봉인을 막으면 회의가 recording에 갇히고 부분 유일 인덱스가 다음
    // 녹음까지 막는다 — 400이 아니라 200이어야 한다.
    const res = await stopWithCaptureError(created.body.id, 'wat').expect(200);
    expect(res.body.outcome).toBe('stopping');
    const { rows } = await db.pool.query('SELECT capture_error FROM meeting WHERE id=$1', [created.body.id]);
    expect(rows[0].capture_error.code).toBe('capture_failed');
  });

  it('a clean stop leaves capture_error null', async () => {
    const created = await start().expect(201);
    await claim(created.body.current_job_id);
    await sendChunk(created.body.id).expect(200);
    await stop(created.body.id, CHUNK, CHUNK).expect(200);
    const { rows } = await db.pool.query('SELECT capture_error FROM meeting WHERE id=$1', [created.body.id]);
    expect(rows[0].capture_error).toBeNull();
  });

  it('stop → 409 when the meeting is not recording, 404 when missing', async () => {
    const done = await db.pool.query(`INSERT INTO meeting(audio_key,status) VALUES('k','done') RETURNING id`);
    expect((await stop(done.rows[0].id)).status).toBe(409);
    expect((await stop('mtg_999')).status).toBe(404);
  });

  it('a claim skips the session job while stop holds its row lock', async () => {
    const created = await start().expect(201);
    const jobId = created.body.current_job_id;
    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT * FROM job WHERE id=$1 FOR UPDATE', [jobId]);
      const repo = new JobsRepository();
      expect(await repo.claim(db.pool, 'w1')).toBeNull(); // SKIP LOCKED
      await holder.query('ROLLBACK');
      const claimed = await repo.claim(db.pool, 'w1');
      expect(claimed!.id).toBe(jobId);
    } finally {
      holder.release();
    }
    await sendChunk(created.body.id).expect(200);
    const res = await stop(created.body.id, CHUNK, CHUNK).expect(200);
    expect(res.body.outcome).toBe('stopping');
  });

  // fix round 1, finding 1: 위 테스트는 claim()이 SKIP LOCKED로 건너뛰는지만 보고
  // stop()을 잠금 경쟁 중에 호출하지 않는다 — FOR UPDATE OF j를 통째로 빼도 통과한다.
  // 이 테스트는 실제로 잠금이 걸린 상태에서 stop()을 호출해, 그것이 끝나지 못하고
  // 대기하다가 잠금이 풀린 뒤에야 완료됨을 직접 증명한다.
  //
  // job.status를 일부러 'done'으로 만든다 — running/queued 분기는 이 job 행에
  // UPDATE(stop_requested_at)나 DELETE(meeting cascade)를 뒤이어 쓰므로, 그 쓰기 자체가
  // holder의 FOR UPDATE와 부딪혀 lockSessionJob의 SELECT가 FOR UPDATE OF j를 갖든 안
  // 갖든 항상 대기하게 된다 — 실측으로 확인함(아래 "제거 검증" 참고). done은 두 분기
  // 어느 쪽도 아니라 최종 409로 떨어지는 순수 읽기 경로라, 대기가 있다면 그건 오직
  // lockSessionJob 자신의 FOR UPDATE OF j에서 나온 것이다. Postgres 행 잠금 대기는
  // 결정적이라 타이밍에 기대는 게 아니다 — 짧은 유예 후에도 안 끝났다는 사실 자체가
  // 신호이고, 회귀가 있으면(잠금이 빠지면) 그 유예 안에 즉시 끝나버려 실패한다.
  // 새 stop()은 가드를 통과하면 항상 seal()로 job 행에 쓴다(§3.4/§4.4) — 옛 stop()의
  // "running도 queued도 아니면 409"라는 세 번째 분기가 사라졌으므로, job.status='done'은
  // 더 이상 "다운스트림 쓰기가 없는 순수 읽기 경로"를 만들지 않는다(그 상태로도 seal이
  // 실행돼 200 stopping이 나간다 — 실측 확인). 아래 주석에 적힌 원래 의도(대기가
  // lockSessionJob 자신의 FOR UPDATE에서 나온다는 것을 증명)를 지키려면 가드에서 먼저
  // 막히는 상태가 필요하다 — meeting.status를 바꾸면 job → meeting 잠금 순서(§4.3)는
  // 그대로 유지하면서 job 행 잠금 경합 지점도 동일하게 lockJobById(구 lockSessionJob)가
  // 된다.
  it('POST /meetings/:id/live/stop blocks on lockSessionJob while another transaction holds the job row, then completes once it releases', async () => {
    const created = await start().expect(201);
    const jobId = created.body.current_job_id;
    await db.pool.query(`UPDATE meeting SET status='failed' WHERE id=$1`, [created.body.id]);
    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT * FROM job WHERE id=$1 FOR UPDATE', [jobId]);

      let settled = false;
      const stopReq = stop(created.body.id).then((res) => { settled = true; return res; });

      await new Promise((r) => setTimeout(r, 500));
      expect(settled).toBe(false); // stop()의 lockJobById가 holder 뒤에서 여전히 대기 중이어야 한다

      await holder.query('COMMIT'); // 잠금을 풀어준다
      const res = await stopReq;
      expect(settled).toBe(true);
      expect(res.status).toBe(409); // meeting.status='failed' — 'recording'이 아니라 409
      expect(res.body.message).toBe('meeting is not recording');
    } finally {
      holder.release();
    }
  });

  // fix round 1, finding 2: 'two simultaneous starts...'는 최종 HTTP 상태·개수만
  // 보고, 그 409가 사전 조회에서 왔는지 catch 블록의 유일 인덱스 위반 번역에서
  // 왔는지는 타이밍에 달려 있다 — 결정적으로 catch 블록만 겨냥한다. findRecording을
  // 딱 한 번 "없음"으로 속여 사전 조회가 실제로 놓치는 바로 그 경쟁을 재현하면,
  // INSERT가 진짜 유일 인덱스 위반을 던지고 catch가 그것을 사전 조회와 같은 409로
  // 번역해야 한다. 인덱스 이름이 바뀌거나 catch가 더 넓게/좁게 잡히면 이 409는
  // 500(미번역 예외)이나 잘못된 메시지로 바뀌어 이 테스트가 잡아낸다.
  it('a start that dodges the pre-check still trips the unique index, and gets the identical 409', async () => {
    await start().expect(201); // 진짜 recording 회의가 이미 있다

    const repo = app.get(LiveRepository);
    const spy = jest.spyOn(repo, 'findRecording').mockResolvedValueOnce(null); // 사전 조회를 한 번 속인다

    const res = await start();

    expect(spy).toHaveBeenCalledTimes(1); // 속임수가 실제로 이 요청 경로를 탔는지 확인
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('a recording is already in progress'); // 사전 조회 409와 동일한 응답

    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM meeting WHERE status='recording'`);
    expect(rows[0].n).toBe(1); // 두 번째 INSERT는 실제로 죽었다 — 유일 인덱스가 진짜로 막았다
  });

  it('GET /meetings/:id/live returns rows after the cursor with speaker names, stage and heartbeat', async () => {
    const created = await start().expect(201);
    const mid = created.body.id;
    await claim(created.body.current_job_id);
    const sp = await db.pool.query(`INSERT INTO speaker(name, enrollment_status) VALUES('영재','ready') RETURNING id`);
    const ins = (seq: number, text: string, speaker: string | null) =>
      db.pool.query(
        `INSERT INTO live_utterance(meeting_id, job_id, seq, start_ms, end_ms, text, speaker_id, similarity)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [mid, created.body.current_job_id, seq, seq * 1000, seq * 1000 + 800, text, speaker, speaker ? 0.82 : null],
      );
    await ins(0, '첫 줄', sp.rows[0].id);
    await ins(1, '둘째 줄', null);
    await ins(2, '셋째 줄', null);

    const all = await request(srv()).get(`/meetings/${mid}/live`).expect(200);
    expect(all.body.status).toBe('recording');
    expect(all.body.stage).toBe('capture');
    expect(all.body.heartbeat_at).not.toBeNull();
    expect(all.body.stop_requested_at).toBeNull(); // 아직 종료를 부르지 않았다
    expect(all.body.items.map((i: { seq: number }) => i.seq)).toEqual([0, 1, 2]);
    expect(all.body.items[0]).toMatchObject({ text: '첫 줄', speaker_name: '영재', similarity: 0.82 });
    expect(all.body.items[1]).toMatchObject({ speaker_id: null, speaker_name: null, similarity: null });

    const after = await request(srv()).get(`/meetings/${mid}/live?after=1`).expect(200);
    expect(after.body.items.map((i: { seq: number }) => i.seq)).toEqual([2]);

    expect((await request(srv()).get(`/meetings/${mid}/live?after=x`)).status).toBe(400);
    expect((await request(srv()).get(`/meetings/mtg_999/live`)).status).toBe(404);
  });

  it('GET /meetings/:id/live still serves rows for a failed meeting', async () => {
    const created = await start().expect(201);
    const mid = created.body.id;
    await db.pool.query(
      `INSERT INTO live_utterance(meeting_id, job_id, seq, start_ms, end_ms, text) VALUES($1,$2,0,0,500,'남는다')`,
      [mid, created.body.current_job_id],
    );
    await db.pool.query(`UPDATE meeting SET status='failed' WHERE id=$1`, [mid]);
    const res = await request(srv()).get(`/meetings/${mid}/live`).expect(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.items).toHaveLength(1);
  });

  // 워커가 running이면 stop은 봉인만 하고 마무리는 워커 몫이다 — 그동안 회의는 계속
  // 'recording'이다. FE 배너가 "녹음 중"과 "마무리 중"을 가르는 근거가 이 필드뿐이라,
  // 응답에서 빠지면 종료 버튼이 되살아난 것처럼 보인다.
  it('GET /meetings/:id/live exposes stop_requested_at while the worker is still finalizing', async () => {
    const created = await start().expect(201);
    const mid = created.body.id;
    await claim(created.body.current_job_id);
    await sendChunk(mid).expect(200);

    const stopped = await stop(mid, CHUNK, CHUNK).expect(200);
    expect(stopped.body.outcome).toBe('stopping'); // 워커가 들고 있으니 API는 마무리하지 않는다

    const live = await request(srv()).get(`/meetings/${mid}/live`).expect(200);
    expect(live.body.status).toBe('recording'); // 아직 recording — 배너는 그대로 서 있다
    expect(live.body.stop_requested_at).not.toBeNull();
  });
});
