import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { LiveAudioService } from '../src/storage/live-audio.service';
import { StorageService } from '../src/storage/storage.service';
import { LiveRepository } from '../src/live/live.repository';
import { JobsRepository } from '../src/jobs/jobs.repository';
import { LiveService } from '../src/live/live.service';
import { MeetingsRepository } from '../src/meetings/meetings.repository';
import { DatabaseService } from '../src/database/database.service';

const CHUNK = 32768;
const chunk = (fill: number) => Buffer.alloc(CHUNK, fill);
/** 설계 §4.2의 4시간 상한. 리터럴로 둔다 — 구현이 아니라 wire 계약을 검사한다. */
const MAX_PCM = 460800000;

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

  /** 캡처 실패 사유를 실은 빈 stop. 브라우저가 끝까지 캡처하지 못했을 때의 모양이다. */
  const stopWithError = (id: string, offset: number, final: number, code: string) =>
    request(srv()).post(`/meetings/${id}/live/stop`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Audio-Offset', String(offset))
      .set('X-Final-Offset', String(final))
      .set('X-Capture-Error', code)
      .send(Buffer.alloc(0));

  const audioPath = async (id: string) => {
    const { rows } = await db.pool.query(`SELECT audio_key FROM meeting WHERE id=$1`, [id]);
    return app.get(StorageService).resolve(rows[0].audio_key);
  };

  /**
   * finalizeByApi를 호출자(stop·스위퍼)의 앞선 검사 없이 **직접** 때린다.
   *
   * stop은 job.status==='running'을 자기 분기에서 이미 거르므로, HTTP 경로만으로는 이
   * 메서드의 소유권 가드에 닿지 못한다 — 가드 자체가 검사 대상일 때는 여기로 부른다.
   */
  const finalizeDirect = (meetingId: string, jobId: string, sealedBytes: number) =>
    app.get(DatabaseService).withTransaction(async (c) => {
      const job = await app.get(LiveRepository).lockJobById(c, jobId);
      const meeting = await app.get(MeetingsRepository).lockById(c, meetingId);
      return app.get(LiveService).finalizeByApi(c, job!, meeting!, sealedBytes);
    });

  const liveJobId = async (meetingId: string) => {
    const { rows } = await db.pool.query(
      `SELECT current_job_id FROM meeting WHERE id=$1`, [meetingId]);
    return rows[0].current_job_id as string;
  };

  const processJobs = async (meetingId: string) => {
    const { rows } = await db.pool.query(
      `SELECT 1 FROM job WHERE meeting_id=$1 AND type='process_meeting'`, [meetingId]);
    return rows.length;
  };

  /** 이 회의의 live job이 가진 확정 경계. pg bigint라 문자열로 온다. */
  const committed = async (id: string) => {
    const { rows } = await db.pool.query(
      `SELECT committed_bytes FROM job WHERE meeting_id=$1 AND type='live_session'`, [id]);
    return Number(rows[0].committed_bytes);
  };

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

  // ── 확정 경계 (설계 §3.2·3.3) ────────────────────────────────────────────
  //
  // 파일 길이가 아니라 job.committed_bytes가 append 오프셋의 진실이다. 아래 셋은 그
  // 차이가 실제로 드러나는 지점만 때린다 — 미확정 꼬리, 롤백된 commit, 부분 쓰기.

  it('does not acknowledge PCM written before a rolled-back commit', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    const { rows } = await db.pool.query(
      "SELECT audio_key FROM meeting WHERE id=$1",
      [m.id],
    );
    const storage = app.get(StorageService);
    fs.appendFileSync(storage.resolve(rows[0].audio_key), Buffer.alloc(401, 9));
    await stop(m.id, CHUNK, CHUNK + 1000, Buffer.alloc(1000, 2)).expect(200);
    expect(
      fs.readFileSync(storage.resolve(rows[0].audio_key)).subarray(44),
    ).toEqual(Buffer.concat([chunk(1), Buffer.alloc(1000, 2)]));
  });

  // 파일 sync는 끝났는데 그 뒤 TX가 롤백된 경우 — 설계 §3.4 크래시 표의 "PCM sync 후
  // commit 전" 줄이다. 디스크에 전부 있어도 확정이 아니므로 경계는 그대로여야 하고,
  // 무엇보다 **세션이 닫히면 안 된다**: 디스크는 멀쩡하니 같은 요청을 다시 보내면
  // 회복된다. io_error(디스크 실패)와 DB TX 실패를 구별해야 하는 이유가 이것이다.
  it('a rolled-back commit neither confirms the bytes nor closes the session', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    jest.spyOn(app.get(LiveRepository), 'setCommitted')
      .mockRejectedValueOnce(new Error('connection reset by peer'));

    await send(m.id, CHUNK, chunk(2)).expect(500);
    expect(await committed(m.id)).toBe(CHUNK);
    const { rows } = await db.pool.query(
      `SELECT m.status, j.status AS job_status FROM meeting m
       JOIN job j ON j.meeting_id=m.id AND j.type='live_session' WHERE m.id=$1`, [m.id]);
    expect(rows[0].status).toBe('recording');
    expect(rows[0].job_status).not.toBe('failed');

    // 같은 요청을 그대로 재전송하면 미확정 꼬리를 잘라내고 다시 써 정확히 같은 PCM이 된다
    await send(m.id, CHUNK, chunk(2)).expect(200)
      .expect((r) => expect(r.body.expected_offset).toBe(CHUNK * 2));
    expect(fs.readFileSync(await audioPath(m.id)).subarray(44))
      .toEqual(Buffer.concat([chunk(1), chunk(2)]));
  });

  // 부분 쓰기 뒤 진짜 디스크 실패 — 예외를 정상적으로 catch하는 경로다(SIGKILL이 아니다).
  // 세션은 io_error로 닫히되, **확정 경계는 한 바이트도 전진하지 않아야 한다**. 홀수
  // 401바이트를 남기는 것은 프레임 경계조차 안 맞는 꼬리를 정본으로 인정하지 않는지 보기 위함이다.
  it('a partial write leaves the committed boundary exactly where it was', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    const liveAudio = app.get(LiveAudioService);
    const storage = app.get(StorageService);
    jest.spyOn(liveAudio, 'writeAt').mockImplementationOnce(
      async (key: string, offset: number, pcm: Buffer) => {
        const fh = await fs.promises.open(storage.resolve(key), 'r+');
        try {
          await fh.write(pcm, 0, 401, 44 + offset);
          await fh.datasync();
        } finally { await fh.close(); }
        throw new Error('ENOSPC');
      });

    await send(m.id, CHUNK, chunk(2)).expect(507);
    expect(await committed(m.id)).toBe(CHUNK);
    // 꼬리는 디스크에 남아 있다 — 그것이 "파일 길이는 진실이 아니다"의 전부다
    expect(fs.statSync(await audioPath(m.id)).size).toBe(44 + CHUNK + 401);
  });

  // 설계 §4.2. 실제로 4시간을 기다리지 않는다 — sparse 파일과 맞는 DB 경계를 만들어
  // 상한을 걸치는 청크 하나만 보낸다.
  it('seals at the four-hour cap, writes only the prefix, and refuses the next chunk', async () => {
    const { body: m } = await start().expect(201);
    const path_ = await audioPath(m.id);
    const boundary = MAX_PCM - 1024;
    fs.truncateSync(path_, 44 + boundary);   // sparse — 460 MB를 실제로 쓰지 않는다
    await db.pool.query(
      `UPDATE job SET committed_bytes=$2 WHERE meeting_id=$1 AND type='live_session'`,
      [m.id, boundary]);

    await send(m.id, boundary, chunk(7)).expect(409)
      .expect((r) => {
        expect(r.body.code).toBe('duration_limit');
        expect(r.body.expected_offset).toBe(MAX_PCM);
      });
    expect(fs.statSync(path_).size).toBe(44 + MAX_PCM);
    expect(await committed(m.id)).toBe(MAX_PCM);
    const { rows } = await db.pool.query(
      `SELECT sealed_bytes FROM job WHERE meeting_id=$1 AND type='live_session'`, [m.id]);
    expect(Number(rows[0].sealed_bytes)).toBe(MAX_PCM);

    // 봉인된 뒤라 다음 청크는 거절된다 — 상한이 실제로 세션을 끝냈다는 뜻이다
    await send(m.id, MAX_PCM, chunk(8)).expect(409)
      .expect((r) => expect(r.body.code).toBe('sealed'));
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
    jest.spyOn(app.get(LiveAudioService), 'writeAt').mockRejectedValueOnce(new Error('ENOSPC'));
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

  // 위 507 테스트는 "다른 append가 끼어들지 않은" 단순한 경우만 본다. 회복 트랜잭션이
  // job → meeting을 다시 잠근 뒤 (1) meeting.status='recording' (2)
  // meeting.current_job_id===jobId (3) job.sealed_bytes===null (4) **확정 경계가 실패 전
  // 값 그대로인지**를 전부 재확인하지 않으면, 롤백으로 잠금이 풀린 사이 같은 오프셋의
  // 정당한 재시도(잃어버린 ACK 재전송)가 먼저 커밋해 세션을 살려 놨을 때 그 세션을 죽인다 —
  // meeting.status는 성공한 재시도 뒤에도 여전히 'recording'이라 (1)만으로는 구별이 안 된다.
  //
  // (4)의 근거가 **파일 길이여서는 안 된다**는 것이 이번 계약의 핵심이다: 우리 자신의 부분
  // 쓰기가 남긴 미확정 꼬리도 파일을 늘리므로, 파일 길이는 "남이 이겼다"와 "내가 절반만
  // 썼다"를 구별하지 못한다. 확정 경계(job.committed_bytes)만이 그 신호다.
  //
  // 두 개의 실제 동시 HTTP 요청으로 이 경쟁을 재현하려면 "패자가 잠금을 넘겨받아 커밋을
  // 마치는 시점"과 "승자가 회복 트랜잭션에서 경계를 확인하는 시점" 사이의 순서를 결정론적으로
  // 강제할 손잡이가 프로덕션 코드에 없다 — 이벤트 루프 스케줄링에 맡기면 가끔만 통과한다.
  // 그래서 그 사건을 정확히 한 순간에 **진짜로** 일으킨다: append TX가 롤백해 잠금을 반납한
  // 직후, 회복 TX가 job을 다시 잠그기 직전. 그 시점엔 어떤 TX도 job 행을 잡고 있지 않아
  // 교착이 없다. 그 뒤의 재잠금·네 가지 재검증·경계 비교는 전부 진짜 코드가 진짜 DB·진짜
  // 파일에 대해 수행한다.
  it('a disk write failure whose committed boundary was advanced by another request skips the failure marking', async () => {
    const { body: m } = await start().expect(201);
    const liveAudio = app.get(LiveAudioService);
    const repo = app.get(LiveRepository);
    const key = (await db.pool.query(
      `SELECT audio_key FROM meeting WHERE id=$1`, [m.id])).rows[0].audio_key;
    jest.spyOn(liveAudio, 'writeAt').mockRejectedValueOnce(new Error('ENOSPC'));

    const realLock = repo.lockJobById.bind(repo);
    let locks = 0;
    jest.spyOn(repo, 'lockJobById').mockImplementation(async (exec, jobId) => {
      locks += 1;
      // 1번은 실패하는 append TX, 2번은 그 롤백 뒤의 회복 TX다.
      if (locks === 2) {
        await liveAudio.writeAt(key, 0, chunk(9));   // mockRejectedValueOnce는 이미 소진됐다
        await db.pool.query(`UPDATE job SET committed_bytes=$2 WHERE id=$1`, [jobId, CHUNK]);
      }
      return realLock(exec, jobId);
    });

    await send(m.id, 0, chunk(1)).expect(507);

    const { rows } = await db.pool.query(
      `SELECT m.status AS meeting_status, m.error AS meeting_error,
              j.status AS job_status, j.error AS job_error
       FROM meeting m JOIN job j ON j.id = m.current_job_id WHERE m.id=$1`, [m.id]);
    // 누군가(시뮬레이션된 재시도) 이겼다 — 회복 트랜잭션은 마킹을 건너뛰어야 한다
    expect(rows[0].meeting_status).toBe('recording');
    expect(rows[0].meeting_error).toBeNull();
    expect(rows[0].job_status).not.toBe('failed');
    expect(rows[0].job_error).toBeNull();
    expect(await committed(m.id)).toBe(CHUNK);
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

  // 설계 §3.3: TX 안에서 예외를 던져 실패 마킹을 롤백하지 않는다. 오프셋이 어긋난 stop도
  // 그 요청이 실어 온 캡처 실패 사유는 남겨야 한다 — 그 헤더가 "이 회의는 마이크를 잃었다"를
  // 탭 밖으로 내보내는 유일한 통로이고, ACK를 잃은 stop이 바로 그 헤더가 도착하는 경로다.
  it('a missing_chunk stop still commits the capture error it carried', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    // 브라우저는 첫 청크의 ACK를 잃어 여전히 0에 있다고 믿는다.
    await stopWithError(m.id, 0, 0, 'device_ended').expect(409)
      .expect((r) => {
        expect(r.body.code).toBe('missing_chunk');
        expect(r.body.expected_offset).toBe(CHUNK);
      });
    const { rows } = await db.pool.query(`SELECT capture_error FROM meeting WHERE id=$1`, [m.id]);
    expect(rows[0].capture_error.code).toBe('device_ended');
    // 그리고 서버가 알려준 경계에서의 재시도가 실제로 봉인한다 (설계 §7).
    await stopWithError(m.id, CHUNK, CHUNK, 'device_ended').expect(200);
  });

  it('a sealed stop with the wrong final still commits the capture error it carried', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    await stop(m.id, CHUNK, CHUNK).expect(200);
    await stopWithError(m.id, 0, 0, 'buffer_overflow').expect(409)
      .expect((r) => expect(r.body.expected_offset).toBe(CHUNK));
    const { rows } = await db.pool.query(`SELECT capture_error FROM meeting WHERE id=$1`, [m.id]);
    expect(rows[0].capture_error.code).toBe('buffer_overflow');
  });

  // 설계 §3.4: "0바이트 사용자 stop은 worker 상태와 무관하게 job을 종료 처리한 뒤 회의를
  // 폐기한다." 워커에게 맡기면 그 워커가 duration 0짜리 회의를 finalize하고 정본 처리까지
  // 큐잉한다 — 넘길 오디오가 한 바이트도 없는데.
  it('a zero-byte user stop discards the meeting even while a worker holds the job', async () => {
    const { body: m } = await start().expect(201);
    const { rows: before } = await db.pool.query(
      `SELECT current_job_id FROM meeting WHERE id=$1`, [m.id]);
    await claim(before[0].current_job_id);

    await stop(m.id, 0, 0).expect(200)
      .expect((r) => expect(r.body.outcome).toBe('discarded'));

    expect((await db.pool.query(`SELECT 1 FROM meeting WHERE id=$1`, [m.id])).rows).toHaveLength(0);
    // job은 meeting FK의 ON DELETE CASCADE로 함께 사라진다 — 워커는 다음 폴링에서 lost다.
    expect((await db.pool.query(`SELECT 1 FROM job WHERE id=$1`, [before[0].current_job_id])).rows)
      .toHaveLength(0);
    // 이 테스트의 진짜 목적: 다음 녹음이 막히지 않는다.
    await start().expect(201);
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

  /**
   * 수용 테스트 R1 — 워커를 잃어도 녹음은 계속된다 (설계 §4.1·§4.2).
   *
   * SQL로 job을 failed로 찍어 두고 그 뒤를 검사하면 "reaper가 회의까지 닫는가"라는 진짜
   * 질문을 건너뛴다. 그래서 실제 reapStale을 부른다 — 워커 쪽 db.reap_stale에도 같은 짝이
   * 있고(be/worker/tests/test_db_lifecycle.py), 두 CTE가 어긋나면 어느 한쪽 프로세스가
   * 진행 중인 녹음을 죽인다.
   */
  it('a reaped preview worker never stops the recording — append keeps working, stop finalizes once', async () => {
    const { body: m } = await start().expect(201);
    const { rows: before } = await db.pool.query(
      `SELECT current_job_id FROM meeting WHERE id=$1`, [m.id]);
    const jobId = before[0].current_job_id as string;
    await claim(jobId);
    await send(m.id, 0, chunk(1)).expect(200);

    // 워커가 OOM으로 사라져 heartbeat가 멎었다. 30분 뒤 reaper가 그 잠금을 회수한다.
    await db.pool.query(`UPDATE job SET locked_at=now() - interval '45 minutes' WHERE id=$1`, [jobId]);
    expect(await app.get(JobsRepository).reapStale(db.pool, 30)).toEqual({ requeued: 0, failed: 1 });

    const reaped = await db.pool.query(`SELECT status FROM job WHERE id=$1`, [jobId]);
    expect(reaped.rows[0].status).toBe('failed');
    const during = await db.pool.query(`SELECT status, error FROM meeting WHERE id=$1`, [m.id]);
    expect(during.rows[0].status).toBe('recording');
    expect(during.rows[0].error).toBeNull();

    // 브라우저는 아무것도 못 느낀다 — 다음 청크가 그대로 받아들여진다.
    await send(m.id, CHUNK, chunk(2)).expect(200)
      .expect((r) => expect(r.body.expected_offset).toBe(CHUNK * 2));

    // 마무리는 API가 한 번만 한다.
    await stop(m.id, CHUNK * 2, CHUNK * 2).expect(200)
      .expect((r) => expect(r.body.outcome).toBe('finalized'));
    const { rows } = await db.pool.query(
      `SELECT status, duration_ms, capture_error FROM meeting WHERE id=$1`, [m.id]);
    expect(rows[0].status).toBe('uploaded');
    expect(rows[0].duration_ms).toBe((CHUNK * 2) / 32);
    // jobs.complete가 job.error를 덮으므로 "미리보기 없이 얻은 녹음"은 capture_error로 남는다.
    expect(rows[0].capture_error.code).toBe('preview_worker_lost');
    const { rows: jobs } = await db.pool.query(
      `SELECT type, status FROM job WHERE meeting_id=$1 ORDER BY created_at`, [m.id]);
    expect(jobs.map((j) => `${j.type}:${j.status}`))
      .toEqual(['live_session:done', 'process_meeting:queued']);
  });

  // 브라우저가 실제로 겪은 일이 API의 일반적인 사유보다 사용자에게 쓸모 있다 (설계 §7).
  it('a reaped worker does not overwrite the capture error the browser reported', async () => {
    const { body: m } = await start().expect(201);
    const { rows: before } = await db.pool.query(
      `SELECT current_job_id FROM meeting WHERE id=$1`, [m.id]);
    await claim(before[0].current_job_id);
    await send(m.id, 0, chunk(1)).expect(200);
    await db.pool.query(
      `UPDATE job SET locked_at=now() - interval '45 minutes' WHERE id=$1`, [before[0].current_job_id]);
    await app.get(JobsRepository).reapStale(db.pool, 30);

    await stopWithError(m.id, CHUNK, CHUNK, 'device_ended').expect(200)
      .expect((r) => expect(r.body.outcome).toBe('finalized'));

    const { rows } = await db.pool.query(`SELECT capture_error FROM meeting WHERE id=$1`, [m.id]);
    expect(rows[0].capture_error.code).toBe('device_ended');
  });

  /**
   * 살아 있는 워커의 잠금을 API가 훔치지 않는다 (설계 §4.1 "봉인 + 정상 워커" 행).
   *
   * stop 경로만으로는 이것을 확인할 수 없다 — running은 stop 자신의 분기가 앞에서 걸러
   * finalizeByApi에 닿지도 않는다(그 동작은 아래 'a running worker gets stopping' 이 본다).
   * API가 worker_id를 가장하지 않는다는 것이 이 태스크의 요점이므로 가드를 직접 때린다.
   */
  it('finalizeByApi refuses a sealed session a worker still holds', async () => {
    const { body: m } = await start().expect(201);
    const jobId = await liveJobId(m.id);
    await claim(jobId);
    await send(m.id, 0, chunk(1)).expect(200);
    await stop(m.id, CHUNK, CHUNK).expect(200)
      .expect((r) => expect(r.body.outcome).toBe('stopping'));

    // 봉인도 됐고 길이도 맞지만 그 job은 워커의 것이다 — 마무리는 그 워커의 몫이다.
    expect(await finalizeDirect(m.id, jobId, CHUNK)).toBe(false);
    expect(await processJobs(m.id)).toBe(0);
    const meeting = await db.pool.query(`SELECT status FROM meeting WHERE id=$1`, [m.id]);
    expect(meeting.rows[0].status).toBe('recording');
  });

  /**
   * duration의 근거는 잠금 아래 읽은 sealed_bytes다 (설계 §4.1의 floor(sealed_bytes / 32)).
   * 호출자가 다른 길이를 들고 오면 마무리하지 않는다 — 스위퍼는 아직 파일 크기에서 봉인
   * 길이를 유도하므로, 그 값이 확정 경계와 어긋나면 미확정 꼬리가 정본 길이가 된다.
   */
  it('finalizeByApi refuses a sealed length that disagrees with the row', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    const jobId = await liveJobId(m.id);
    // 스위퍼가 하는 일: 확정 경계에서 봉인하고 워커 없는 job을 API가 마무리한다.
    await db.pool.query(
      `UPDATE job SET stop_requested_at=now(), sealed_bytes=$2 WHERE id=$1`, [jobId, CHUNK]);

    expect(await finalizeDirect(m.id, jobId, CHUNK * 2)).toBe(false);
    expect(await processJobs(m.id)).toBe(0);
    expect((await db.pool.query(`SELECT status FROM meeting WHERE id=$1`, [m.id])).rows[0].status)
      .toBe('recording');

    // 행과 같은 길이면 마무리하고, duration은 그 행의 값에서 나온다.
    expect(await finalizeDirect(m.id, jobId, CHUNK)).toBe(true);
    const { rows } = await db.pool.query(
      `SELECT status, duration_ms FROM meeting WHERE id=$1`, [m.id]);
    expect(rows[0]).toMatchObject({ status: 'uploaded', duration_ms: CHUNK / 32 });
    expect(await processJobs(m.id)).toBe(1);
  });

  /**
   * API finalize의 허용 상태는 queued 또는 failed이고, 선행 조건은 봉인이다 (설계 §4.1).
   * 호출자(stop·스위퍼)가 앞에서 거른다고 이 가드를 생략하면, 두 actor가 process job을
   * 두 번 만들거나 자라는 중인 파일의 길이로 duration을 정하는 길이 열린다.
   */
  it('finalizeByApi refuses an unsealed session and refuses to finalize a done job twice', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    const jobId = await liveJobId(m.id);

    // 아직 봉인되지 않았다 — 끝 길이를 정한 사람이 없다.
    expect(await finalizeDirect(m.id, jobId, CHUNK)).toBe(false);
    expect(await processJobs(m.id)).toBe(0);
    expect((await db.pool.query(`SELECT status FROM meeting WHERE id=$1`, [m.id])).rows[0].status)
      .toBe('recording');

    // 봉인 뒤 stop이 스스로 마무리한다. 같은 job을 다시 finalize하지는 않는다.
    await stop(m.id, CHUNK, CHUNK).expect(200)
      .expect((r) => expect(r.body.outcome).toBe('finalized'));
    expect(await finalizeDirect(m.id, jobId, CHUNK)).toBe(false);
    expect(await processJobs(m.id)).toBe(1);
  });

  // ── 경합 (설계 §4.1·§4.3·§5) ──────────────────────────────────────────
  //
  // 순서는 전부 DB 잠금으로 강제한다. 게이트는 트랜잭션이 잠금을 쥔 채 멈추게 할 뿐이고,
  // 누가 이기는지는 임의 sleep이 아니라 pg_locks가 확인한 실제 대기가 정한다.

  /** supertest 요청은 await(=then)하기 전에는 전송되지 않는다. 경합 테스트는 상대를
   *  기다리기 전에 요청이 이미 나가 있어야 하므로 여기서 전송을 시작한다. */
  const fire = <T>(req: PromiseLike<T>): Promise<T> => Promise.resolve(req);

  /**
   * 트랜잭션 안에서 잠금을 쥔 채 멈추게 하는 게이트. withBarrier와 같은 모양이다 —
   * `held()`가 finally에서 반드시 열어 주므로, 안에서 단언이 실패해도 잠금이 남지 않는다.
   * 안 열면 스파이가 붙잡은 트랜잭션이 job 행을 쥔 채로 남아, 실패한 단언이 보고되는 대신
   * 스위트가 테스트 타임아웃까지 매달린다 — 진짜 원인이 가려진다.
   */
  const gate = () => {
    let arrive!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => { arrive = r; });
    const open = new Promise<void>((r) => { release = r; });
    return {
      arrive,
      open,
      /**
       * 게이트에 도달할 때까지 기다렸다가 fn을 돌리고, 어떻게 끝나든 연다.
       *
       * fn은 값을 돌려주지 않는다. async 함수는 반환한 promise를 풀어 기다리므로, 진행
       * 중인 요청을 여기서 돌려주면 게이트가 그 요청의 완료를 기다리는 교착이 된다 —
       * 그 요청은 게이트가 열려야 진행할 수 있다. 필요한 promise는 바깥 변수로 내보낸다.
       */
      held: async (fn: () => Promise<void>): Promise<void> => {
        await reached;
        try {
          await fn();
        } finally {
          release();
        }
      },
    };
  };

  /** 별도 커넥션이 job 행을 잠근 채 fn을 돌린다. 실패해도 finally에서 반드시 반납한다. */
  const withBarrier = async <T>(jobId: string, fn: (barrier: Client) => Promise<T>): Promise<T> => {
    const barrier = new Client({ connectionString: db.url });
    await barrier.connect();
    try {
      await barrier.query('BEGIN');
      await barrier.query(`SELECT id FROM job WHERE id=$1 FOR UPDATE`, [jobId]);
      return await fn(barrier);
    } finally {
      await barrier.query('ROLLBACK').catch(() => undefined);
      await barrier.end();
    }
  };

  /**
   * `job` 행에서 잠금을 기다리는 백엔드가 n개가 될 때까지 기다린다. sleep이 아니라
   * pg_locks가 판정한다.
   *
   * 클러스터 전체의 `NOT granted`를 세면 안 된다 — 무관한 백엔드 하나로도 조건이 차서,
   * 정작 기다리던 대기자가 큐에 들어가기 전에 테스트가 진행된다. 그러면 경합 테스트가
   * 엉뚱한 이유로 통과하고, 순서를 고정한다는 목적 자체가 사라진다. 그래서 대상을
   * "무언가를 기다리는 중이면서 `job` 릴레이션 잠금을 이미 쥔" 백엔드로 좁힌다 —
   * `SELECT … FROM job … FOR UPDATE`는 행을 기다리는 내내 job에 RowShareLock을 들고 있다.
   */
  const awaitWaiters = async (n: number) => {
    const deadline = Date.now() + 15000;
    for (;;) {
      const { rows } = await db.pool.query(
        `SELECT count(DISTINCT w.pid)::int AS n
           FROM pg_locks w
          WHERE NOT w.granted
            AND EXISTS (SELECT 1 FROM pg_locks h
                         WHERE h.pid = w.pid AND h.granted
                           AND h.locktype = 'relation' AND h.relation = 'job'::regclass)`);
      if (rows[0].n >= n) return;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${n} backend(s) blocked on the job row`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  // queued API finalize ↔ claim, ①: stop이 job 행을 먼저 잠갔다. claim은 SKIP LOCKED라
  // 기다리지 않고 건너뛴다 — 워커가 봉인 중인 세션을 가로채 두 종결자가 생기지 않는다.
  it('a claim skips the job row a stop is holding, and the stop finalizes exactly once', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    const live = app.get(LiveRepository);
    const realSeal = live.seal.bind(live);
    const g = gate();
    jest.spyOn(live, 'seal').mockImplementationOnce(async (exec, id, bytes) => {
      g.arrive();          // job 행을 잠근 채 멈춘다
      await g.open;
      return realSeal(exec, id, bytes);
    });

    const stopping = fire(stop(m.id, CHUNK, CHUNK));
    await g.held(async () => {
      // stop이 job 행을 잠근 채 멈춰 있다. claim은 기다리지 않고 건너뛴다.
      expect(await app.get(JobsRepository).claim(db.pool, 'w1')).toBeNull();
    });

    const res = await stopping;
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('finalized');
    expect(await processJobs(m.id)).toBe(1);
  });

  // queued API finalize ↔ claim, ②: claim이 먼저 commit했다. 잠금을 기다리던 stop은
  // 잠근 뒤 다시 읽은 행에서 running을 보고 워커에게 인계한다 — API는 finalize하지 않는다.
  it('a stop that waited behind a claim hands the sealed session to the worker', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    const jobId = await liveJobId(m.id);

    await withBarrier(jobId, async (barrier) => {
      const stopping = fire(stop(m.id, CHUNK, CHUNK));
      await awaitWaiters(1);         // stop이 job 행에서 대기 중이다
      const claimed = await app.get(JobsRepository).claim(barrier, 'w1');
      expect(claimed?.id).toBe(jobId);
      await barrier.query('COMMIT');

      const res = await stopping;
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('stopping');
    });

    expect(await processJobs(m.id)).toBe(0);   // 워커의 몫이다 — process job은 아직 없다
    const { rows } = await db.pool.query(
      `SELECT status, locked_by, sealed_bytes FROM job WHERE id=$1`, [jobId]);
    expect(rows[0].status).toBe('running');
    expect(rows[0].locked_by).toBe('w1');
    expect(Number(rows[0].sealed_bytes)).toBe(CHUNK);
  });

  // cancel ↔ append, ①: cancel이 job → meeting을 먼저 잠갔다. append는 그 행에서 기다린
  // 뒤 409로 거절된다 — deadlock도 500도 아니고, 파일은 한 바이트도 자라지 않는다.
  it('an append that waited behind a cancel is refused and never grows the file', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    const before = fs.statSync(await audioPath(m.id)).size;
    const meetingsRepo = app.get(MeetingsRepository);
    const realCancel = meetingsRepo.markCancelled.bind(meetingsRepo);
    const g = gate();
    jest.spyOn(meetingsRepo, 'markCancelled').mockImplementationOnce(async (exec, id, err) => {
      g.arrive();          // job과 meeting을 모두 잠근 상태다
      await g.open;
      return realCancel(exec, id, err);
    });

    const cancelling = fire(request(srv()).post(`/meetings/${m.id}/cancel`).send());
    // 진행 중인 요청은 콜백 **밖으로** 내보낸다 — async 콜백이 promise를 반환하면 그것을
    // 풀어 기다리게 되고, 게이트가 그 요청의 완료를 기다리는 교착이 된다.
    let appending!: Promise<request.Response>;
    await g.held(async () => {
      appending = fire(send(m.id, CHUNK, chunk(2)));  // cancel이 job과 meeting을 쥔 상태다
      await awaitWaiters(1);         // append가 job 행에서 대기 중이다
    });

    const [c, a] = await Promise.all([cancelling, appending]);
    expect(c.status).toBe(200);
    expect(a.status).toBe(409);
    expect(fs.statSync(await audioPath(m.id)).size).toBe(before);
    expect(await committed(m.id)).toBe(CHUNK);
  });

  // cancel ↔ append, ②: append가 먼저 잠갔다. cancel은 기다렸다가 그 청크를 확정한
  // 세션을 닫는다. 그 뒤로는 append가 거절되고 파일도 더는 자라지 않는다.
  it('a cancel that waited behind an append closes the session and stops the growth', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    const live = app.get(LiveRepository);
    const realCommit = live.setCommitted.bind(live);
    const g = gate();
    jest.spyOn(live, 'setCommitted').mockImplementationOnce(async (exec, id, bytes) => {
      g.arrive();          // job 행을 잠근 채 멈춘다
      await g.open;
      return realCommit(exec, id, bytes);
    });

    const appending = fire(send(m.id, CHUNK, chunk(2)));
    let cancelling!: Promise<request.Response>;
    await g.held(async () => {
      cancelling = fire(request(srv()).post(`/meetings/${m.id}/cancel`).send());
      await awaitWaiters(1);         // cancel이 job 행에서 대기 중이다
    });

    const [a, c] = await Promise.all([appending, cancelling]);
    expect(a.status).toBe(200);
    expect(c.status).toBe(200);
    const grown = fs.statSync(await audioPath(m.id)).size;
    expect(grown).toBe(44 + CHUNK * 2);

    await send(m.id, CHUNK * 2, chunk(3)).expect(409);
    expect(fs.statSync(await audioPath(m.id)).size).toBe(grown);
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
