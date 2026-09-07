import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { LiveAudioService } from '../src/storage/live-audio.service';

const CHUNK = 32768;
const chunk = (fill: number) => Buffer.alloc(CHUNK, fill);

describe('live audio append', () => {
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
  afterEach(async () => { jest.restoreAllMocks(); await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  const srv = () => app.getHttpServer();
  const start = (body: object = {}) => request(srv()).post('/meetings/live').send(body);

  const send = (id: string, offset: number, body: Buffer, elapsed?: number) => {
    let req = request(srv()).post(`/meetings/${id}/live/audio`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Audio-Offset', String(offset));
    if (elapsed !== undefined) req = req.set('X-Capture-Elapsed', String(elapsed));
    return req.send(body);
  };

  /** 워커의 claim을 SQL로 흉내 낸다. */
  const claim = (jobId: string) =>
    db.pool.query(
      `UPDATE job SET status='running', locked_by='w1', locked_at=now(), attempts=1, stage='capture' WHERE id=$1`,
      [jobId],
    );

  const stop = (id: string, offset: number, final: number, body = Buffer.alloc(0)) =>
    request(srv()).post(`/meetings/${id}/live/stop`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Audio-Offset', String(offset))
      .set('X-Final-Offset', String(final))
      .send(body);

  it('accepts sequential chunks and reports the next expected offset', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200)
      .expect((r) => expect(r.body).toEqual({ accepted_offset: CHUNK, expected_offset: CHUNK }));
    await send(m.id, CHUNK, chunk(2)).expect(200)
      .expect((r) => expect(r.body.expected_offset).toBe(CHUNK * 2));
  });

  it('409 carries expected_offset so a lost ACK can resync', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    // 클라이언트가 200을 못 받고 같은 청크를 다시 보낸다
    await send(m.id, 0, chunk(1)).expect(409)
      .expect((r) => expect(r.body.expected_offset).toBe(CHUNK));
    // 그 값으로 재동기화하면 이어진다
    await send(m.id, CHUNK, chunk(2)).expect(200);
  });

  it('409 on a gap — a skipped chunk never becomes a silent hole', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, CHUNK * 5, chunk(1)).expect(409)
      .expect((r) => expect(r.body.expected_offset).toBe(0));
  });

  it('400 on odd offset, wrong body length — before touching file or DB', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 1, chunk(1)).expect(400);
    await send(m.id, 0, Buffer.alloc(100)).expect(400);
    // 아무것도 안 쓰였다
    await send(m.id, 0, chunk(1)).expect(200)
      .expect((r) => expect(r.body.expected_offset).toBe(CHUNK));
  });

  it('the first chunk stamps recorded_at', async () => {
    const { body: m } = await start().expect(201);
    const before = await db.pool.query(`SELECT recorded_at FROM meeting WHERE id=$1`, [m.id]);
    await send(m.id, 0, chunk(1)).expect(200);
    const after = await db.pool.query(`SELECT recorded_at FROM meeting WHERE id=$1`, [m.id]);
    expect(after.rows[0].recorded_at.getTime()).toBeGreaterThanOrEqual(before.rows[0].recorded_at.getTime());
  });

  it('every accepted chunk advances last_input_at', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    const { rows } = await db.pool.query(
      `SELECT j.last_input_at FROM job j JOIN meeting m ON m.current_job_id=j.id WHERE m.id=$1`, [m.id]);
    expect(rows[0].last_input_at).not.toBeNull();
  });

  it('records a capture gap when elapsed runs ahead of the audio', async () => {
    const { body: m } = await start().expect(201);
    // 1.024초치 오디오인데 클라이언트는 10초가 흘렀다고 말한다 — 맥이 잤다
    await send(m.id, 0, chunk(1), 10_000).expect(200);
    const { rows } = await db.pool.query(`SELECT capture_error FROM meeting WHERE id=$1`, [m.id]);
    expect(rows[0].capture_error?.code).toBe('capture_gap');
  });

  it('rejects appends after the session is sealed', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    await db.pool.query(
      `UPDATE job SET sealed_bytes=$2 WHERE id=(SELECT current_job_id FROM meeting WHERE id=$1)`,
      [m.id, CHUNK]);
    // 409에 실린 오프셋이 곧 ACK 프로토콜이다 — 상태 코드만 보면 재동기화의 근거를
    // 안 보는 셈이다. 봉인된 세션은 sealed_bytes가 그 값이다.
    const res = await send(m.id, CHUNK, chunk(2)).expect(409);
    expect(res.body.expected_offset).toBe(CHUNK);
    expect(res.body.code).toBe('sealed');
  });

  // 설계 §3.4가 stop에도 X-Capture-Elapsed를 싣게 한 이유 — 꼬리 구간의 불연속은
  // append의 갭 검사가 볼 수 없다(그 청크는 애초에 오지 않았다).
  it('stop detects a gap at the tail from X-Capture-Elapsed', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    // 1.024초를 올렸는데 캡처는 20초 지났다 — 19초가 사라졌다.
    await request(srv()).post(`/meetings/${m.id}/live/stop`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Audio-Offset', String(CHUNK)).set('X-Final-Offset', String(CHUNK))
      .set('X-Capture-Elapsed', '20000')
      .send(Buffer.alloc(0)).expect(200);
    const { rows } = await db.pool.query('SELECT capture_error FROM meeting WHERE id=$1', [m.id]);
    expect(rows[0].capture_error.code).toBe('capture_gap');
    expect(rows[0].capture_error.gap_ms).toBe(20000 - CHUNK / 32);
  });

  it('two concurrent appends at the same offset — exactly one wins', async () => {
    const { body: m } = await start().expect(201);
    const [a, b] = await Promise.all([send(m.id, 0, chunk(1)), send(m.id, 0, chunk(2))]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]);
    const { rows } = await db.pool.query(`SELECT audio_key FROM meeting WHERE id=$1`, [m.id]);
    const size = fs.statSync(path.join(db.storageRoot, rows[0].audio_key)).size;
    expect(size).toBe(44 + CHUNK);   // 둘 다 쓰였으면 44 + 65536이다
  });

  // 브리프에는 없는 회귀 테스트. appendAudio의 io_error 분기는 실패 마킹(job.fail +
  // meeting.markFailed)을 append 트랜잭션 *밖의* 새 트랜잭션에서 커밋해야 한다 — 안에서
  // 하고 던지면 그 트랜잭션 자체가 롤백돼 마킹이 통째로 사라진다(원래 브리프의 버그).
  // 이 테스트는 append(디스크 쓰기)가 실패하는 정확히 그 경로를 때려, 507과 함께
  // job/meeting이 실제로 failed로 커밋됐는지 직접 확인한다.
  it('507 on a disk write failure — job and meeting are actually marked failed, not rolled back', async () => {
    const { body: m } = await start().expect(201);
    jest.spyOn(app.get(LiveAudioService), 'append').mockRejectedValueOnce(new Error('ENOSPC'));
    await send(m.id, 0, chunk(1)).expect(507)
      .expect((r) => expect(r.body).toEqual({ code: 'io_error' }));
    const { rows } = await db.pool.query(
      `SELECT m.status AS meeting_status, m.error AS meeting_error,
              j.status AS job_status, j.error AS job_error
       FROM meeting m JOIN job j ON j.id = m.current_job_id WHERE m.id=$1`, [m.id]);
    expect(rows[0].meeting_status).toBe('failed');
    expect(rows[0].meeting_error.code).toBe('io_error');
    expect(rows[0].job_status).toBe('failed');
    expect(rows[0].job_error.code).toBe('io_error');
    // 세션이 닫혔으니 재시도는 더 이상 recording이 아니라 409다 — 워커가 영원히 tail하지 않는다
    await send(m.id, 0, chunk(1)).expect(409);
  });

  // fix round 1: 위 507 테스트는 "다른 append가 끼어들지 않은" 단순한 경우만 본다. 회복
  // 트랜잭션이 job → meeting을 다시 잠근 뒤 (1) meeting.status='recording' (2)
  // meeting.current_job_id===jobId (3) job.sealed_bytes===null (4) 파일이 우리가 쓰려던
  // 오프셋에서 전진하지 않았음을 전부 재확인하지 않으면, 롤백으로 잠금이 풀린 사이 같은
  // 오프셋의 정당한 재시도(잃어버린 ACK 재전송)가 먼저 커밋해 세션을 살려 놨을 때 그 세션을
  // 죽인다 — meeting.status는 성공한 재시도 뒤에도 여전히 'recording'이라 (1)만으로는
  // 구별이 안 된다. 판별 신호는 오직 (4), 파일 위치뿐이다.
  //
  // 두 개의 실제 동시 HTTP 요청으로 이 경쟁을 재현하려면 "패자가 잠금을 넘겨받아 커밋을
  // 마치는 시점"과 "승자가 롤백 후 회복 트랜잭션의 pcmSize를 확인하는 시점" 사이의 순서를
  // 결정론적으로 강제할 손잡이가 프로덕션 코드에 없다 — 둘 다 승자의 ROLLBACK이 끝난 뒤에야
  // 풀리는 별개의 pg 소켓 이벤트라, 이벤트 루프 스케줄링에 맡기면 테스트가 가끔씩만
  // 통과하는 결과가 된다(실측: 콜 카운트로 lockJobById/pcmSize를 게이팅해 봤지만 "회복의
  // 몇 번째 호출인지"가 그 자체로 같은 종류의 경쟁이었다). 그래서 팀리드가 제안한 대안대로
  // "파일이 이미 전진해 있는 상태에서 회복 경로를 직접 태운다" — append가 실패를 보고하기
  // *전에* 진짜 두 번째 write로 파일을 실제로 전진시켜, 그 다음에 실패를 던진다. 모킹은
  // 순서(전진이 먼저, 실패 보고가 나중)만 강제하고, 그 뒤 회복 트랜잭션의 잠금 재획득·
  // 네 가지 검증·pcmSize 읽기는 전부 진짜 코드가 진짜 DB·진짜 파일에 대해 수행한다.
  it('a disk write failure whose file already advanced past the target offset skips the failure marking', async () => {
    const { body: m } = await start().expect(201);
    const liveAudio = app.get(LiveAudioService);
    const realAppend = liveAudio.append.bind(liveAudio);
    jest.spyOn(liveAudio, 'append').mockImplementationOnce(async (key: string, _pcm: Buffer) => {
      // "다른 요청이 먼저 이 오프셋에 커밋했다"는 사실만 진짜로 만든다 — 그 뒤에야 우리
      // 자신의 쓰기가 실패를 보고한다. 두 번째 호출은 이 mockImplementationOnce가 이미
      // 소진된 뒤라 진짜 append로 떨어진다(재귀 아님).
      await realAppend(key, chunk(9));
      throw new Error('ENOSPC');
    });

    await send(m.id, 0, chunk(1)).expect(507);

    const { rows } = await db.pool.query(
      `SELECT m.status AS meeting_status, m.error AS meeting_error, m.audio_key,
              j.status AS job_status, j.error AS job_error
       FROM meeting m JOIN job j ON j.id = m.current_job_id WHERE m.id=$1`, [m.id]);
    // 누군가(시뮬레이션된 재시도) 이겼다 — 회복 트랜잭션은 마킹을 건너뛰어야 한다
    expect(rows[0].meeting_status).toBe('recording');
    expect(rows[0].meeting_error).toBeNull();
    expect(rows[0].job_status).not.toBe('failed');
    expect(rows[0].job_error).toBeNull();
    // 파일은 실제로 전진해 있다 — 우리가 강제한 전제가 그대로 남아 있음을 확인
    const size = fs.statSync(path.join(db.storageRoot, rows[0].audio_key)).size;
    expect(size).toBe(44 + CHUNK);
    // 세션이 안 죽었으니 그 "재시도"의 진짜 다음 청크는 정상적으로 이어진다
    await send(m.id, CHUNK, chunk(2)).expect(200);
  });

  it('closes the session when the audio file cannot be created', async () => {
    jest.spyOn(app.get(LiveAudioService), 'create').mockRejectedValueOnce(new Error('ENOSPC'));
    await start().expect(500);
    const { rows } = await db.pool.query(
      `SELECT status, error FROM meeting WHERE status IN ('recording','failed') ORDER BY created_at DESC LIMIT 1`);
    // recording으로 갇히지 않는다 — 다음 녹음이 막히면 안 된다
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error.code).toBe('io_error');
  });

  it('a failed start does not block the next recording', async () => {
    jest.spyOn(app.get(LiveAudioService), 'create').mockRejectedValueOnce(new Error('ENOSPC'));
    await start().expect(500);
    await start().expect(201);   // meeting_single_recording_idx에 걸리지 않는다
  });

  it('stop appends the tail, seals, and rewrites the header', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    const tail = Buffer.alloc(1024, 9);
    await stop(m.id, CHUNK, CHUNK + 1024, tail).expect(200)
      .expect((r) => expect(r.body.sealed_bytes).toBe(CHUNK + 1024));

    // job.meeting_id로 찾는다 — job이 'queued'였으므로 이 stop은 API finalize까지 겸해
    // meeting.current_job_id를 다음(process_meeting) job으로 옮긴다. m.current_job_id로
    // join하면 방금 봉인한 live_session job이 아니라 그 다음 job을 보게 된다.
    const { rows } = await db.pool.query(
      `SELECT j.sealed_bytes, j.stop_requested_at, m.audio_key FROM job j
       JOIN meeting m ON m.id=j.meeting_id WHERE j.meeting_id=$1 AND j.type='live_session'`, [m.id]);
    expect(Number(rows[0].sealed_bytes)).toBe(CHUNK + 1024);
    expect(rows[0].stop_requested_at).not.toBeNull();
    const buf = fs.readFileSync(path.join(process.env.STORAGE_ROOT!, rows[0].audio_key));
    expect(buf.readUInt32LE(40)).toBe(CHUNK + 1024);   // 헤더가 확정됐다
  });

  it('stop resumes the seal when the tail is already on disk (crash before commit)', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    const tail = Buffer.alloc(1024, 9);
    // ③ 직전 크래시를 흉내 낸다: 꼬리는 파일에 있고 DB는 아직 봉인 전
    const { rows } = await db.pool.query(`SELECT audio_key FROM meeting WHERE id=$1`, [m.id]);
    fs.appendFileSync(path.join(process.env.STORAGE_ROOT!, rows[0].audio_key), tail);

    // 재시도 stop은 원래 offset을 보낸다. append 없이 봉인만 재개해야 한다.
    await stop(m.id, CHUNK, CHUNK + 1024, tail).expect(200);
    const size = fs.statSync(path.join(process.env.STORAGE_ROOT!, rows[0].audio_key)).size;
    expect(size).toBe(44 + CHUNK + 1024);   // 꼬리가 두 번 붙지 않았다
  });

  it('stop is idempotent once sealed, and 409s on a different final offset', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    await stop(m.id, CHUNK, CHUNK).expect(200);
    await stop(m.id, CHUNK, CHUNK).expect(200);
    // 2바이트 꼬리를 실제로 실어 보내야 헤더 검증(X-Final-Offset === X-Audio-Offset + body
    // 길이)을 통과해 sealed_bytes 불일치 409에 도달한다 — 빈 바디로 CHUNK+2를 주장하면
    // 헤더 검증 자체에서 먼저 400이 난다.
    await stop(m.id, CHUNK, CHUNK + 2, Buffer.alloc(2)).expect(409);
  });

  it('stop 409s when chunks are missing', async () => {
    const { body: m } = await start().expect(201);
    await stop(m.id, CHUNK * 3, CHUNK * 3).expect(409)
      .expect((r) => expect(r.body.code).toBe('missing_chunk'));
  });

  it('the API finalizes itself when the worker never claimed the job', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    await stop(m.id, CHUNK, CHUNK).expect(200)
      .expect((r) => expect(r.body.outcome).toBe('finalized'));

    const { rows } = await db.pool.query(
      `SELECT status, duration_ms FROM meeting WHERE id=$1`, [m.id]);
    expect(rows[0].status).toBe('uploaded');
    expect(rows[0].duration_ms).toBe(CHUNK / 32);
    const { rows: jobs } = await db.pool.query(
      `SELECT type, status FROM job WHERE meeting_id=$1 ORDER BY created_at`, [m.id]);
    expect(jobs.map((j) => `${j.type}:${j.status}`)).toEqual(['live_session:done', 'process_meeting:queued']);
  });

  it('a running worker gets stopping, not finalized', async () => {
    const { body: m } = await start().expect(201);
    const { rows } = await db.pool.query(`SELECT current_job_id FROM meeting WHERE id=$1`, [m.id]);
    await claim(rows[0].current_job_id);
    await send(m.id, 0, chunk(1)).expect(200);
    await stop(m.id, CHUNK, CHUNK).expect(200)
      .expect((r) => expect(r.body.outcome).toBe('stopping'));
    // 워커가 finalize한다 — 회의는 아직 recording이다
    const after = await db.pool.query(`SELECT status FROM meeting WHERE id=$1`, [m.id]);
    expect(after.rows[0].status).toBe('recording');
  });
});
