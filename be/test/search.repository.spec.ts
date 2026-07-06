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
    // dimension 컬럼은 CHECK(=1024)로 고정 → 저장은 항상 정상(MODEL, 1024).
    // SQL의 e.model=$4 / e.dimension=$5 술어를 쿼리 측 불일치로 검증.
    const m = await seedMeeting('m', null);
    const u = await seedUtterance(m, 0, '내용', 'ok', null);
    await seedEmbedding(u, oneHot(0)); // 정상 저장 (model=MODEL, dimension=1024)
    const byModel = await repo.hybrid(db.pool, {
      q: 'zzz', qvec: oneHot(0), filters: noFilters, limit: 10, candK: 50, rrfK: 60, model: 'other-model', dim: DIM,
    });
    expect(byModel.length).toBe(0); // 모델 불일치로 의미 arm 제외, 키워드도 미매치
    const byDim = await repo.hybrid(db.pool, {
      q: 'zzz', qvec: oneHot(0), filters: noFilters, limit: 10, candK: 50, rrfK: 60, model: MODEL, dim: 512,
    });
    expect(byDim.length).toBe(0); // 차원 불일치로 의미 arm 제외
  });

  it('S4: excludes non-done meetings and stale-version utterances', async () => {
    // (a) 재처리 중(status='processing') 회의의 utterance는 검색에서 제외
    const processing = (await db.pool.query(
      `INSERT INTO meeting(title,audio_key,status,processing_version) VALUES('p','k','processing',1) RETURNING id`,
    )).rows[0].id;
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,'SPEAKER_00',0,1000,'재처리 중 발언','ok',0,1)`,
      [processing],
    );
    // (b) done이지만 utterance.processing_version < meeting.processing_version(구버전) → 제외
    const bumped = (await db.pool.query(
      `INSERT INTO meeting(title,audio_key,status,processing_version) VALUES('b','k','done',2) RETURNING id`,
    )).rows[0].id;
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,'SPEAKER_00',0,1000,'구버전 발언','ok',0,1)`,
      [bumped],
    );
    // (c) 정상(done, pv 일치)만 남음
    const ok = await seedMeeting('ok', null); // status='done', processing_version=0
    await seedUtterance(ok, 0, '확정 발언', 'ok', null); // processing_version=0

    // 공유 filterSql이므로 keyword/browse 두 arm으로 확정본만 반환됨을 확인
    const kw = await repo.keyword(db.pool, { q: '발언', filters: noFilters, limit: 10, candK: 50 });
    expect(kw.map((r) => r.text)).toEqual(['확정 발언']);
    const br = await repo.browse(db.pool, { filters: noFilters, limit: 10 });
    expect(br.map((r) => r.text)).toEqual(['확정 발언']);
  });

  it('S1: hybrid returns filtered matches under tx-local hnsw GUCs', async () => {
    // >40개 임베딩 + 선택적 meetingIds 필터. GUC(strict_order, ef_search>=candK)를
    // 트랜잭션 로컬로 적용한 상태에서 필터에 걸린 발언이 굶지 않고 반환되는지(리콜) 확인.
    const noise = await seedMeeting('noise', '2026-06-20T00:00:00Z');
    const target = await seedMeeting('target', '2026-06-20T00:00:00Z');
    for (let i = 0; i < 50; i++) {
      const u = await seedUtterance(noise, i, `잡음 ${i}`, 'ok', null);
      await seedEmbedding(u, oneHot(i + 1)); // oneHot(0)과 직교
    }
    const tu = await seedUtterance(target, 0, '대상 발언', 'ok', null);
    await seedEmbedding(tu, oneHot(0)); // 쿼리 벡터와 동일(최근접)

    const candK = 100;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('hnsw.iterative_scan','strict_order',true)`);
      await client.query(`SELECT set_config('hnsw.ef_search',$1,true)`, [String(candK)]);
      // GUC가 트랜잭션 로컬로 실제 적용됐는지(= pgvector ≥ 0.8에서 strict_order 허용)
      const ef = await client.query(`SELECT current_setting('hnsw.ef_search') AS v`);
      const it = await client.query(`SELECT current_setting('hnsw.iterative_scan') AS v`);
      expect(Number(ef.rows[0].v)).toBeGreaterThanOrEqual(candK);
      expect(it.rows[0].v).toBe('strict_order');
      const rows = await repo.hybrid(client, {
        q: 'zzz', // 키워드 미매치 → 의미 arm만 기여
        qvec: oneHot(0),
        filters: { dateFrom: null, dateTo: null, speakerIds: null, meetingIds: [target] },
        limit: 10, candK, rrfK: 60, model: MODEL, dim: DIM,
      });
      expect(rows.map((r) => r.utterance_id)).toEqual([tu]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
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
