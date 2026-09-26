import { startTestDb, StartedTestDb } from './db';

/**
 * `model_job_refs` — "그 모델을 쓰는 queued/running job" 판정 (스펙 §5.4). API와 worker가 같은 함수를
 * 부르므로 규칙은 여기 한 곳에서만 고정한다.
 */
describe('model_job_refs', () => {
  let db: StartedTestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db?.stop(); });

  const LENS = ['mlx-community/Qwen3.5-4B-8bit'];
  const FALLBACK = 'mlx-community/Qwen3.5-4B-8bit';

  async function job(type: string, payload: unknown, status = 'queued'): Promise<string> {
    const r = await db.pool.query(
      `INSERT INTO job(type, payload, status) VALUES($1, $2::jsonb, $3) RETURNING id`,
      [type, JSON.stringify(payload), status],
    );
    return r.rows[0].id;
  }
  async function refs(role: string, name: string, backend: string | null, exclude: string | null = null) {
    const r = await db.pool.query(
      `SELECT * FROM model_job_refs($1, $2, $3, $4::text[], $5, $6) AS id`,
      [role, name, backend, LENS, FALLBACK, exclude],
    );
    return r.rows.map((x) => x.id).sort();
  }

  const v5 = (over: Record<string, unknown> = {}) => ({
    schema_version: 5,
    models: { whisper_model: 'small', devices: { diarization: 'gpu', stt: 'cpu' }, summary_model: 'mlx-community/Qwen3.5-9B-8bit' },
    followups: { lens: true, summary: true },
    ...over,
  });

  it('v5: 전사는 이름과 백엔드가 모두 맞아야 한다', async () => {
    const id = await job('process_meeting', v5());
    expect(await refs('stt', 'small', 'faster')).toEqual([id]);
    expect(await refs('stt', 'small', 'mlx')).toEqual([]);
    expect(await refs('stt', 'medium', 'faster')).toEqual([]);
  });

  it('v1: device mps→mlx, cpu·cuda→faster, schema_version 없어도 v1', async () => {
    const mps = await job('process_meeting', { models: { whisper_model: 'large-v3', device: 'mps' } });
    const cuda = await job('process_meeting', { schema_version: 1, models: { whisper_model: 'large-v3', device: 'cuda' } });
    expect(await refs('stt', 'large-v3', 'mlx')).toEqual([mps]);
    expect(await refs('stt', 'large-v3', 'faster')).toEqual([cuda]);
  });

  it('요약: summary_model, 없으면(v1·v2) 대체값, followups.summary false면 안 씀', async () => {
    const withModel = await job('process_meeting', v5());
    const v2 = await job('process_meeting', { schema_version: 2, models: { whisper_model: 'small', devices: { diarization: 'gpu', stt: 'gpu' } } });
    await job('process_meeting', v5({ followups: { lens: false, summary: false } }));
    expect(await refs('summary', 'mlx-community/Qwen3.5-9B-8bit', null)).toEqual([withModel]);
    // v2는 요약 대체값(4B)과 렌즈(v1~v4는 항상 참, 4B)로 4B를 쓴다
    expect(await refs('summary', 'mlx-community/Qwen3.5-4B-8bit', null)).toEqual([withModel, v2].sort());
  });

  it('렌즈: followups.lens가 참이거나 필드가 없으면 렌즈 모델을 쓴다', async () => {
    const off = await job('process_meeting', v5({ followups: { lens: false, summary: true } }));
    const on = await job('process_meeting', v5());
    const r = await refs('summary', 'mlx-community/Qwen3.5-4B-8bit', null);
    expect(r).toContain(on);
    expect(r).not.toContain(off);
  });

  it('summarize_meeting·extract_lenses의 model', async () => {
    const s = await job('summarize_meeting', { schema_version: 1, model: 'mlx-community/Qwen3.5-27B-8bit' });
    const l = await job('extract_lenses', { schema_version: 1, model: 'mlx-community/Qwen3.5-27B-8bit' });
    expect(await refs('summary', 'mlx-community/Qwen3.5-27B-8bit', null)).toEqual([s, l].sort());
  });

  it('live_session은 process 블록의 전사·요약을 본다', async () => {
    const id = await job('live_session', { schema_version: 1, process: v5() });
    expect(await refs('stt', 'small', 'faster')).toEqual([id]);
    expect(await refs('summary', 'mlx-community/Qwen3.5-9B-8bit', null)).toEqual([id]);
  });

  it('done·failed job은 세지 않고, p_exclude_job은 뺀다', async () => {
    await job('process_meeting', v5(), 'done');
    await job('process_meeting', v5(), 'failed');
    const running = await job('process_meeting', v5(), 'running');
    expect(await refs('stt', 'small', 'faster')).toEqual([running]);
    expect(await refs('stt', 'small', 'faster', running)).toEqual([]);
  });

  it('고정 역할은 아무것도 돌려주지 않는다 (삭제 대상이 아니다)', async () => {
    await job('process_meeting', v5());
    expect(await refs('diarization', 'pyannote/speaker-diarization-community-1', null)).toEqual([]);
  });
});
