import { startTestDb, StartedTestDb } from './db';
import { SearchRepository } from '../src/search/search.repository';

const MODEL = 'BAAI/bge-m3';
const DIM = 1024; // embedding 컬럼은 vector(1024) 고정 → 테스트 벡터도 1024차원
const oneHot = (i: number) => { const a = Array(DIM).fill(0); a[i] = 1; return a; };

describe('SearchRepository', () => {
  let db: StartedTestDb;
  let repo: SearchRepository;
  beforeAll(async () => { db = await startTestDb(); repo = new SearchRepository(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  async function seedMeeting(title: string, recordedAt: string | null) {
    const r = await db.pool.query(
      `INSERT INTO meeting(title, audio_key, recorded_at, status) VALUES($1,'k',$2,'done') RETURNING id`,
      [title, recordedAt],
    );
    return r.rows[0].id as string;
  }
  async function seedUtterance(
    meetingId: string, oi: number, text: string | null, status: string, speakerId: string | null,
  ) {
    const r = await db.pool.query(
      `INSERT INTO utterance(meeting_id,speaker_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,$2,'SPEAKER_00',0,1000,$3,$4,$5,0) RETURNING id`,
      [meetingId, speakerId, text, status, oi],
    );
    return r.rows[0].id as string;
  }
  async function seedEmbedding(utteranceId: string, vec: number[], dimCol = DIM) {
    await db.pool.query(
      `INSERT INTO utterance_embedding(utterance_id,embedding,model,dimension,processing_version)
       VALUES($1,$2::vector,$3,$4,0)`,
      [utteranceId, '[' + vec.join(',') + ']', MODEL, dimCol],
    );
  }
  const noFilters = { dateFrom: null, dateTo: null, speakerIds: null, meetingIds: null };

  it('keyword arm: bigm matches Korean substrings', async () => {
    const m = await seedMeeting('기획회의', '2026-06-20T00:00:00Z');
    await seedUtterance(m, 0, '새 UI 개선안을 논의했다', 'ok', null);
    await seedUtterance(m, 1, '점심 메뉴 이야기', 'ok', null);
    const rows = await repo.keyword(db.pool, { q: 'UI 개선', filters: noFilters, limit: 10, candK: 50 });
    expect(rows.map((r) => r.text)).toContain('새 UI 개선안을 논의했다');
    expect(rows.map((r) => r.text)).not.toContain('점심 메뉴 이야기');
  });

  it('keyword arm excludes silence/null-text utterances', async () => {
    const m = await seedMeeting('m', null);
    await seedUtterance(m, 0, null, 'silence', null);
    const rows = await repo.keyword(db.pool, { q: '회의', filters: noFilters, limit: 10, candK: 50 });
    expect(rows.length).toBe(0);
  });

  it('hybrid RRF fuses keyword + semantic', async () => {
    const m = await seedMeeting('m', '2026-06-20T00:00:00Z');
    const u1 = await seedUtterance(m, 0, '쿠버네티스 배포 전략', 'ok', null);
    const u2 = await seedUtterance(m, 1, '회의록 정리', 'ok', null);
    await seedEmbedding(u1, oneHot(0));
    await seedEmbedding(u2, oneHot(1));
    const rows = await repo.hybrid(db.pool, {
      q: '배포', qvec: oneHot(0), filters: noFilters, limit: 10, candK: 50, rrfK: 60, model: MODEL, dim: DIM,
    });
    expect(rows[0].utterance_id).toBe(u1); // 키워드+의미 둘 다 1등 → 최상위
  });

  it('semantic arm filters by model AND dimension', async () => {
    const m = await seedMeeting('m', null);
    const u = await seedUtterance(m, 0, '내용', 'ok', null);
    await seedEmbedding(u, oneHot(0), 999); // dimension 컬럼만 다르게 (벡터는 1024차원)
    const rows = await repo.hybrid(db.pool, {
      q: 'zzz', qvec: oneHot(0), filters: noFilters, limit: 10, candK: 50, rrfK: 60, model: MODEL, dim: DIM,
    });
    expect(rows.length).toBe(0); // dim 불일치로 의미 arm 제외, 키워드도 미매치
  });

  it('browse orders recorded_at DESC NULLS LAST and excludes non-ok', async () => {
    const m1 = await seedMeeting('dated', '2026-06-20T00:00:00Z');
    const m2 = await seedMeeting('undated', null);
    await seedUtterance(m2, 0, '미상정', 'ok', null);
    await seedUtterance(m1, 0, '최신', 'ok', null);
    await seedUtterance(m1, 1, null, 'silence', null);
    const rows = await repo.browse(db.pool, { filters: noFilters, limit: 10 });
    expect(rows.map((r) => r.text)).toEqual(['최신', '미상정']); // dated first, silence excluded
  });

  it('date + speaker filters apply', async () => {
    const m = await seedMeeting('m', '2026-06-20T00:00:00Z');
    const sp = (await db.pool.query(`INSERT INTO speaker(name) VALUES('김') RETURNING id`)).rows[0].id;
    await seedUtterance(m, 0, '대상 발언', 'ok', sp);
    await seedUtterance(m, 1, '다른 발언', 'ok', null);
    const rows = await repo.keyword(db.pool, {
      q: '발언',
      filters: { dateFrom: '2026-06-01T00:00:00Z', dateTo: '2026-07-01T00:00:00Z', speakerIds: [sp], meetingIds: null },
      limit: 10, candK: 50,
    });
    expect(rows.map((r) => r.text)).toEqual(['대상 발언']);
  });
});
