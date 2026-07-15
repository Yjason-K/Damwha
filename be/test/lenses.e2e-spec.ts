import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { LensesService } from '../src/lenses/lenses.service';
import { AiLensCandidate } from '../src/lenses/lens.types';

describe('lenses schema', () => {
  let db: StartedTestDb;

  beforeAll(async () => { db = await startTestDb(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  it('creates constrained lens records that cascade with the meeting', async () => {
    const { rows: [meeting] } = await db.pool.query(
      `INSERT INTO meeting(audio_key,status) VALUES('audio','done') RETURNING id`,
    );
    const { rows: [item] } = await db.pool.query(
      `INSERT INTO lens_item(meeting_id,kind,text,source,user_modified)
       VALUES($1,'action','문서 작성','user',true) RETURNING id`, [meeting.id],
    );
    expect(item.id).toMatch(/^lens_[1-9][0-9]*$/);
    await expect(db.pool.query(
      `INSERT INTO lens_item(meeting_id,kind,text,source,user_modified)
       VALUES($1,'topic','x','user',true)`, [meeting.id],
    )).rejects.toThrow();
    await db.pool.query(`DELETE FROM meeting WHERE id=$1`, [meeting.id]);
    expect((await db.pool.query(`SELECT 1 FROM lens_item WHERE id=$1`, [item.id])).rowCount).toBe(0);
  });
});

describe('lenses api', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  let service: LensesService;
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
    service = app.get(LensesService);
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  const srv = () => app.getHttpServer();

  // --- seed helpers ---------------------------------------------------------
  const mkMeeting = async (title = '회의') =>
    (await db.pool.query(
      `INSERT INTO meeting(audio_key,status,title) VALUES('k','done',$1) RETURNING id`, [title],
    )).rows[0].id;
  const mkSpeaker = async (name = '홍길동') =>
    (await db.pool.query(
      `INSERT INTO speaker(name,enrollment_status) VALUES($1,'ready') RETURNING id`, [name],
    )).rows[0].id;
  const mkUtt = async (mid: string, order: number, start: number, speaker: string | null = null) =>
    (await db.pool.query(
      `INSERT INTO utterance(meeting_id,speaker_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,$2,'S',$3,$4,'t','ok',$5,0) RETURNING id`, [mid, speaker, start, start + 100, order],
    )).rows[0].id;
  const mkLens = async (
    mid: string,
    opts: {
      kind?: string; source?: string; completion?: string; lifecycle?: string;
      text?: string; assignee?: string | null; due?: string | null; updated?: string;
      primaryUtteranceId?: string;
    } = {},
  ) => {
    const o = {
      kind: 'action', source: 'ai', completion: 'open', lifecycle: 'active',
      text: '문서 작성', assignee: null, due: null, ...opts,
    };
    const updatedSql = o.updated ? `'${o.updated}'::timestamptz` : 'now()';
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const id = (await client.query(
        `INSERT INTO lens_item(meeting_id,kind,text,source,user_modified,completion_status,lifecycle_status,assignee_speaker_id,due_at,updated_at)
         VALUES($1,$2,$3,$4,false,$5,$6,$7,$8,${updatedSql}) RETURNING id`,
        [mid, o.kind, o.text, o.source, o.completion, o.lifecycle, o.assignee, o.due],
      )).rows[0].id;
      if (o.source === 'ai' && o.lifecycle === 'active' && o.primaryUtteranceId) {
        await client.query(
          `INSERT INTO lens_evidence(lens_item_id,utterance_id,relation) VALUES($1,$2,'primary')`,
          [id, o.primaryUtteranceId],
        );
      }
      await client.query('COMMIT');
      return id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  const mkEvidence = async (lensId: string, uttId: string, relation = 'primary') =>
    db.pool.query(
      `INSERT INTO lens_evidence(lens_item_id,utterance_id,relation) VALUES($1,$2,$3)`,
      [lensId, uttId, relation],
    );

  // --- reads ----------------------------------------------------------------
  it('lists active open items newest-first with meeting metadata and evidence', async () => {
    const mid = await mkMeeting();
    const utt = await mkUtt(mid, 0, 0);
    const lens = await mkLens(mid, { kind: 'action', source: 'ai', primaryUtteranceId: utt });

    const res = await request(srv()).get('/lenses');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: expect.any(Array), next_cursor: null });
    expect(res.body.items[0]).toMatchObject({
      id: expect.stringMatching(/^lens_/), kind: 'action', lifecycle_status: 'active',
      meeting: { id: expect.stringMatching(/^mtg_/), title: expect.anything() },
      evidence: [{ relation: 'primary', utterance: { id: expect.stringMatching(/^utt_/), start_ms: 0 } }],
    });
  });

  it('orders evidence primary-first regardless of insert order', async () => {
    const mid = await mkMeeting();
    const u0 = await mkUtt(mid, 0, 0);
    const u1 = await mkUtt(mid, 1, 1000);
    const lens = await mkLens(mid, { source: 'user' });
    await mkEvidence(lens, u0, 'supporting');
    await mkEvidence(lens, u1, 'primary');

    const res = await request(srv()).get('/lenses');
    const ev = res.body.items[0].evidence;
    expect(ev.map((e: any) => e.relation)).toEqual(['primary', 'supporting']);
    expect(ev[0].utterance.id).toBe(u1);
  });

  it('defaults to open + active, excluding done and archived items', async () => {
    const mid = await mkMeeting();
    const open = await mkLens(mid, { source: 'user', completion: 'open', lifecycle: 'active' });
    await mkLens(mid, { source: 'user', completion: 'done', lifecycle: 'active' });
    await mkLens(mid, { source: 'user', completion: 'open', lifecycle: 'archived' });

    const res = await request(srv()).get('/lenses');
    expect(res.body.items.map((i: any) => i.id)).toEqual([open]);
  });

  it('filters by kind, meeting_id, speaker, date range, and status', async () => {
    const m1 = await mkMeeting('A');
    const m2 = await mkMeeting('B');
    const spk = await mkSpeaker();
    await mkUtt(m1, 0, 0, spk);
    const decision = await mkLens(m1, { source: 'user', kind: 'decision' });
    const withAssignee = await mkLens(m1, { source: 'user', assignee: spk, due: '2026-07-10' });
    await mkLens(m2, { source: 'user', kind: 'action' });
    const done = await mkLens(m1, { source: 'user', completion: 'done' });

    expect((await request(srv()).get('/lenses?kind=decision')).body.items.map((i: any) => i.id)).toEqual([decision]);
    expect((await request(srv()).get(`/lenses?meeting_id=${m2}`)).body.items.length).toBe(1);
    expect((await request(srv()).get(`/lenses?speaker_id=${spk}`)).body.items.map((i: any) => i.id)).toEqual([withAssignee]);
    expect((await request(srv()).get('/lenses?date_from=2026-07-01&date_to=2026-07-15')).body.items.map((i: any) => i.id)).toEqual([withAssignee]);
    expect((await request(srv()).get('/lenses?completion_status=done')).body.items.map((i: any) => i.id)).toEqual([done]);
  });

  it('paginates via keyset cursor (limit=1 continuation)', async () => {
    const mid = await mkMeeting();
    const older = await mkLens(mid, { source: 'user', updated: '2026-07-01T00:00:00Z' });
    const newer = await mkLens(mid, { source: 'user', updated: '2026-07-02T00:00:00Z' });

    const p1 = await request(srv()).get('/lenses?limit=1');
    expect(p1.body.items.map((i: any) => i.id)).toEqual([newer]);
    expect(p1.body.next_cursor).toEqual(expect.any(String));

    const p2 = await request(srv()).get(`/lenses?limit=1&cursor=${encodeURIComponent(p1.body.next_cursor)}`);
    expect(p2.body.items.map((i: any) => i.id)).toEqual([older]);
    expect(p2.body.next_cursor).toBeNull();
  });

  it('rejects a malformed cursor with 400', async () => {
    const res = await request(srv()).get('/lenses?cursor=%%%not-base64%%%');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('cursor is invalid');
  });

  it('rejects a structurally valid cursor with invalid timestamp or id', async () => {
    const badTime = Buffer.from(JSON.stringify({ updated_at: 'not-a-time', id: 'lens_1' })).toString('base64url');
    const badId = Buffer.from(JSON.stringify({ updated_at: '2026-07-14T00:00:00.000Z', id: 'wrong' })).toString('base64url');
    expect((await request(srv()).get(`/lenses?cursor=${badTime}`)).status).toBe(400);
    expect((await request(srv()).get(`/lenses?cursor=${badId}`)).status).toBe(400);
  });

  it('lists a meeting’s active items after 404-checking the meeting', async () => {
    const mid = await mkMeeting();
    const active = await mkLens(mid, { source: 'user', lifecycle: 'active' });
    await mkLens(mid, { source: 'user', lifecycle: 'archived' });
    const res = await request(srv()).get(`/meetings/${mid}/lenses`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.id)).toEqual([active]);

    expect((await request(srv()).get('/meetings/mtg_999999/lenses')).status).toBe(404);
  });

  // --- create ---------------------------------------------------------------
  it('creates a user item with trimmed text', async () => {
    const mid = await mkMeeting();
    const res = await request(srv()).post('/lenses').send({ meeting_id: mid, kind: 'action', text: '  문서 작성  ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ source: 'user', user_modified: true, completion_status: 'open', text: '문서 작성' });
  });

  it('rejects invalid kind, date, and text on create', async () => {
    const mid = await mkMeeting();
    expect((await request(srv()).post('/lenses').send({ meeting_id: mid, kind: 'topic', text: 'x' })).status).toBe(400);
    expect((await request(srv()).post('/lenses').send({ meeting_id: mid, kind: 'action', text: 'x', due_at: '2026-13-40' })).status).toBe(400);
    expect((await request(srv()).post('/lenses').send({ meeting_id: mid, kind: 'action', text: '   ' })).status).toBe(400);
    expect((await request(srv()).post('/lenses').send({ meeting_id: mid, kind: 'action', text: 'a'.repeat(1001) })).status).toBe(400);
    expect((await request(srv()).post('/lenses').send({ meeting_id: 'bad', kind: 'action', text: 'x' })).status).toBe(400);
  });

  it('returns 404 creating against an unknown meeting', async () => {
    const res = await request(srv()).post('/lenses').send({ meeting_id: 'mtg_999999', kind: 'action', text: 'x' });
    expect(res.status).toBe(404);
  });

  it('rejects an assignee without an utterance in the meeting (400)', async () => {
    const mid = await mkMeeting();
    const spk = await mkSpeaker(); // speaker exists but has no utterance in this meeting
    const res = await request(srv()).post('/lenses').send({ meeting_id: mid, kind: 'action', text: 'x', assignee_speaker_id: spk });
    expect(res.status).toBe(400);
  });

  // --- edit / complete / reopen --------------------------------------------
  it('patches text, flipping source to edited', async () => {
    const mid = await mkMeeting();
    const userItem = await mkLens(mid, { source: 'user' });
    const res = await request(srv()).patch(`/lenses/${userItem}`).send({ text: '수정된 문서' });
    expect(res.body).toMatchObject({ source: 'edited', user_modified: true, text: '수정된 문서' });
  });

  it('completes and reopens an item', async () => {
    const mid = await mkMeeting();
    const userItem = await mkLens(mid, { source: 'user' });
    expect((await request(srv()).post(`/lenses/${userItem}/complete`)).body)
      .toMatchObject({ completion_status: 'done', user_modified: true });
    expect((await request(srv()).post(`/lenses/${userItem}/reopen`)).body)
      .toMatchObject({ completion_status: 'open', user_modified: true });
  });

  it('deletes a manual item and its evidence on DELETE', async () => {
    const mid = await mkMeeting();
    const utt = await mkUtt(mid, 0, 0);
    const item = await mkLens(mid, { source: 'user' });
    await mkEvidence(item, utt, 'primary');
    expect((await request(srv()).delete(`/lenses/${item}`)).status).toBe(204);
    expect((await request(srv()).get('/lenses')).body.items.length).toBe(0);
    expect((await db.pool.query(`SELECT 1 FROM lens_item WHERE id=$1`, [item])).rowCount).toBe(0);
    expect((await db.pool.query(`SELECT 1 FROM lens_evidence WHERE lens_item_id=$1`, [item])).rowCount).toBe(0);
  });

  it('returns 404 for mutations on unknown items', async () => {
    expect((await request(srv()).post('/lenses/lens_999999/complete')).status).toBe(404);
    expect((await request(srv()).patch('/lenses/lens_999999').send({ text: 'x' })).status).toBe(404);
    expect((await request(srv()).delete('/lenses/lens_999999')).status).toBe(404);
  });

  // --- evidence -------------------------------------------------------------
  it('adds and removes evidence, flagging the item user_modified', async () => {
    const mid = await mkMeeting();
    const utt = await mkUtt(mid, 0, 0);
    const item = await mkLens(mid, { source: 'user' });
    const added = await request(srv()).post(`/lenses/${item}/evidence`).send({ utterance_id: utt, relation: 'primary' });
    expect(added.status).toBe(201);
    expect(added.body.user_modified).toBe(true);
    expect(added.body.evidence.map((e: any) => e.utterance.id)).toEqual([utt]);

    const removed = await request(srv()).delete(`/lenses/${item}/evidence/${utt}`);
    expect(removed.status).toBe(200);
    expect(removed.body.evidence).toEqual([]);
  });

  it('rejects evidence whose utterance is foreign to the item’s meeting (400)', async () => {
    const m1 = await mkMeeting();
    const m2 = await mkMeeting();
    const localUtt = await mkUtt(m1, 0, 0);
    const foreignUtt = await mkUtt(m2, 0, 0);
    const aiItem = await mkLens(m1, { source: 'ai', primaryUtteranceId: localUtt });
    const res = await request(srv()).post(`/lenses/${aiItem}/evidence`).send({ utterance_id: foreignUtt, relation: 'primary' });
    expect(res.status).toBe(400);
    // nothing was written
    expect((await db.pool.query(`SELECT count(*)::int n FROM lens_evidence WHERE lens_item_id=$1`, [aiItem])).rows[0].n).toBe(1);
    expect((await db.pool.query(`SELECT user_modified FROM lens_item WHERE id=$1`, [aiItem])).rows[0].user_modified).toBe(false);
  });

  it('refuses to delete the only primary evidence of an active AI item and rolls back (409)', async () => {
    const mid = await mkMeeting();
    const primaryUtt = await mkUtt(mid, 0, 0);
    const aiItem = await mkLens(mid, { source: 'ai', primaryUtteranceId: primaryUtt });

    const res = await request(srv()).delete(`/lenses/${aiItem}/evidence/${primaryUtt}`);
    expect(res.status).toBe(409);
    // rolled back: the primary evidence still exists
    expect((await db.pool.query(
      `SELECT relation FROM lens_evidence WHERE lens_item_id=$1 AND utterance_id=$2`, [aiItem, primaryUtt],
    )).rows[0].relation).toBe('primary');
  });

  it('allows deleting the primary evidence of a user item', async () => {
    const mid = await mkMeeting();
    const utt = await mkUtt(mid, 0, 0);
    const userItem = await mkLens(mid, { source: 'user' });
    await mkEvidence(userItem, utt, 'primary');
    expect((await request(srv()).delete(`/lenses/${userItem}/evidence/${utt}`)).status).toBe(200);
  });

  it('rejects adding a second primary evidence on a different utterance (409) and leaves the original primary intact', async () => {
    const mid = await mkMeeting();
    const primaryUtt = await mkUtt(mid, 0, 0);
    const otherUtt = await mkUtt(mid, 1, 100);
    const item = await mkLens(mid, { source: 'user' });
    await mkEvidence(item, primaryUtt, 'primary');

    const res = await request(srv()).post(`/lenses/${item}/evidence`)
      .send({ utterance_id: otherUtt, relation: 'primary' });
    expect(res.status).toBe(409);

    // rolled back: original primary unchanged, no evidence row for the other utterance
    expect((await db.pool.query(
      `SELECT relation FROM lens_evidence WHERE lens_item_id=$1 AND utterance_id=$2`, [item, primaryUtt],
    )).rows[0].relation).toBe('primary');
    expect((await db.pool.query(
      `SELECT 1 FROM lens_evidence WHERE lens_item_id=$1 AND utterance_id=$2`, [item, otherUtt],
    )).rowCount).toBe(0);
  });

  it('allows re-posting the existing primary utterance as primary (idempotent) and adding supporting evidence', async () => {
    const mid = await mkMeeting();
    const primaryUtt = await mkUtt(mid, 0, 0);
    const supportingUtt = await mkUtt(mid, 1, 100);
    const item = await mkLens(mid, { source: 'user' });
    await mkEvidence(item, primaryUtt, 'primary');

    const same = await request(srv()).post(`/lenses/${item}/evidence`)
      .send({ utterance_id: primaryUtt, relation: 'primary' });
    expect(same.status).toBe(201);

    const supporting = await request(srv()).post(`/lenses/${item}/evidence`)
      .send({ utterance_id: supportingUtt, relation: 'supporting' });
    expect(supporting.status).toBe(201);
    expect(supporting.body.evidence.map((e: any) => e.relation)).toEqual(['primary', 'supporting']);
  });

  it('refuses to demote the sole primary of an active AI item to supporting (409) and keeps it primary', async () => {
    const mid = await mkMeeting();
    const primaryUtt = await mkUtt(mid, 0, 0);
    const aiItem = await mkLens(mid, { source: 'ai', primaryUtteranceId: primaryUtt });

    const res = await request(srv()).post(`/lenses/${aiItem}/evidence`)
      .send({ utterance_id: primaryUtt, relation: 'supporting' });
    expect(res.status).toBe(409);
    // rolled back: the utterance is still the item's primary evidence
    expect((await db.pool.query(
      `SELECT relation FROM lens_evidence WHERE lens_item_id=$1 AND utterance_id=$2`, [aiItem, primaryUtt],
    )).rows[0].relation).toBe('primary');
  });

  it('allows demoting the primary of a user item to supporting', async () => {
    const mid = await mkMeeting();
    const primaryUtt = await mkUtt(mid, 0, 0);
    const userItem = await mkLens(mid, { source: 'user' });
    await mkEvidence(userItem, primaryUtt, 'primary');

    const res = await request(srv()).post(`/lenses/${userItem}/evidence`)
      .send({ utterance_id: primaryUtt, relation: 'supporting' });
    expect(res.status).toBe(201);
    expect((await db.pool.query(
      `SELECT relation FROM lens_evidence WHERE lens_item_id=$1 AND utterance_id=$2`, [userItem, primaryUtt],
    )).rows[0].relation).toBe('supporting');
  });

  it('allows adding a non-primary utterance as supporting on an active AI item', async () => {
    const mid = await mkMeeting();
    const primaryUtt = await mkUtt(mid, 0, 0);
    const supportingUtt = await mkUtt(mid, 1, 100);
    const aiItem = await mkLens(mid, { source: 'ai', primaryUtteranceId: primaryUtt });

    const res = await request(srv()).post(`/lenses/${aiItem}/evidence`)
      .send({ utterance_id: supportingUtt, relation: 'supporting' });
    expect(res.status).toBe(201);
    expect(res.body.evidence.map((e: any) => e.relation)).toEqual(['primary', 'supporting']);
  });

  it('leaves provenance untouched on an empty PATCH of an AI item', async () => {
    const mid = await mkMeeting();
    const utt = await mkUtt(mid, 0, 0);
    const aiItem = await mkLens(mid, { source: 'ai', primaryUtteranceId: utt });

    const res = await request(srv()).patch(`/lenses/${aiItem}`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'ai', user_modified: false });
    const { rows: [row] } = await db.pool.query(
      `SELECT source, user_modified FROM lens_item WHERE id=$1`, [aiItem],
    );
    expect(row).toMatchObject({ source: 'ai', user_modified: false });
  });

  it('projects only public utterance fields on evidence, not worker-internal columns', async () => {
    const mid = await mkMeeting();
    const spk = await mkSpeaker();
    const utt = await mkUtt(mid, 0, 500, spk);
    const lens = await mkLens(mid, { source: 'ai', primaryUtteranceId: utt });

    const res = await request(srv()).get('/lenses');
    const utterance = res.body.items[0].evidence[0].utterance;
    expect(utterance).toEqual({ id: utt, start_ms: 500, text: 't', speaker_id: spk });
    for (const col of ['status', 'order_index', 'processing_version', 'job_id',
      'transcript_error', 'diar_label', 'confidence', 'end_ms', 'meeting_id']) {
      expect(utterance).not.toHaveProperty(col);
    }
  });

  // --- AI merge -------------------------------------------------------------
  const candidate = (over: Partial<AiLensCandidate> = {}): AiLensCandidate => ({
    kind: 'action', text: 't', assignee_speaker_id: null, due_at: null,
    primary_utterance_id: 'utt_0', supporting_utterance_ids: [], ...over,
  });
  const itemRow = async (id: string) =>
    (await db.pool.query(
      `SELECT kind, text, source, user_modified, completion_status, lifecycle_status FROM lens_item WHERE id=$1`, [id],
    )).rows[0];
  const evidenceOf = async (id: string) =>
    (await db.pool.query(
      `SELECT utterance_id, relation FROM lens_evidence WHERE lens_item_id=$1 ORDER BY relation, utterance_id`, [id],
    )).rows;

  it('merge updates/archives only untouched active AI and leaves user, edited, and completed items unchanged', async () => {
    const mid = await mkMeeting();
    const u1 = await mkUtt(mid, 0, 0);
    const u2 = await mkUtt(mid, 1, 100);
    const u3 = await mkUtt(mid, 2, 200);

    const aiMatch = await mkLens(mid, { kind: 'action', source: 'ai', text: '기존 AI', primaryUtteranceId: u1 });
    const aiArchive = await mkLens(mid, { kind: 'decision', source: 'ai', primaryUtteranceId: u2 });
    const userItem = await mkLens(mid, { kind: 'action', source: 'user' });
    await mkEvidence(userItem, u1, 'primary'); // same key as aiMatch, must stay invisible
    const editedItem = await mkLens(mid, { kind: 'action', source: 'edited' });
    const completedItem = await mkLens(mid, { kind: 'action', source: 'ai', completion: 'done', primaryUtteranceId: u3 });

    const candidates = [
      candidate({ kind: 'action', primary_utterance_id: u1, text: '업데이트됨', supporting_utterance_ids: [u3] }),
      candidate({ kind: 'promise', primary_utterance_id: u3, text: '신규' }),
    ];
    await service.mergeAiExtraction(mid, candidates);

    // matched AI item: updated fields, still active/open AI, evidence replaced
    expect(await itemRow(aiMatch)).toMatchObject({
      kind: 'action', text: '업데이트됨', source: 'ai', user_modified: false,
      completion_status: 'open', lifecycle_status: 'active',
    });
    expect(await evidenceOf(aiMatch)).toEqual([
      { utterance_id: u1, relation: 'primary' },
      { utterance_id: u3, relation: 'supporting' },
    ]);

    // unmatched eligible AI item: archived, evidence untouched
    expect(await itemRow(aiArchive)).toMatchObject({ lifecycle_status: 'archived', source: 'ai', user_modified: false });
    expect(await evidenceOf(aiArchive)).toEqual([{ utterance_id: u2, relation: 'primary' }]);

    // ineligible items untouched
    expect(await itemRow(userItem)).toMatchObject({ source: 'user', user_modified: false, lifecycle_status: 'active' });
    expect(await itemRow(editedItem)).toMatchObject({ source: 'edited', lifecycle_status: 'active' });
    expect(await itemRow(completedItem)).toMatchObject({ source: 'ai', completion_status: 'done', lifecycle_status: 'active' });

    // new candidate created as active unmodified AI with exactly one primary evidence
    const created = (await db.pool.query(
      `SELECT id FROM lens_item WHERE meeting_id=$1 AND text='신규'`, [mid],
    )).rows[0].id;
    expect(await itemRow(created)).toMatchObject({
      kind: 'promise', source: 'ai', user_modified: false, completion_status: 'open', lifecycle_status: 'active',
    });
    expect(await evidenceOf(created)).toEqual([{ utterance_id: u3, relation: 'primary' }]);
  });

  it('merge dedupes a utterance listed as both primary and supporting to a single primary', async () => {
    const mid = await mkMeeting();
    const u1 = await mkUtt(mid, 0, 0);
    const u2 = await mkUtt(mid, 1, 100);

    await service.mergeAiExtraction(mid, [
      candidate({ kind: 'action', primary_utterance_id: u1, text: '중복', supporting_utterance_ids: [u1, u2] }),
    ]);

    const created = (await db.pool.query(
      `SELECT id FROM lens_item WHERE meeting_id=$1 AND text='중복'`, [mid],
    )).rows[0].id;
    expect(await evidenceOf(created)).toEqual([
      { utterance_id: u1, relation: 'primary' },
      { utterance_id: u2, relation: 'supporting' },
    ]);
  });

  it('merge with a foreign-meeting utterance aborts the whole merge, writing nothing', async () => {
    const mid = await mkMeeting();
    const other = await mkMeeting();
    const u1 = await mkUtt(mid, 0, 0);
    const foreign = await mkUtt(other, 0, 0);

    const existing = await mkLens(mid, { kind: 'action', source: 'ai', text: '기존', primaryUtteranceId: u1 });
    const before = (await db.pool.query(`SELECT count(*)::int n FROM lens_item WHERE meeting_id=$1`, [mid])).rows[0].n;

    await expect(service.mergeAiExtraction(mid, [
      candidate({ kind: 'promise', primary_utterance_id: u1, text: '유효' }),
      candidate({ kind: 'action', primary_utterance_id: foreign, text: '외부' }),
    ])).rejects.toThrow();

    // rolled back: no new item, existing item still active with original text and evidence
    expect((await db.pool.query(`SELECT count(*)::int n FROM lens_item WHERE meeting_id=$1`, [mid])).rows[0].n).toBe(before);
    expect(await itemRow(existing)).toMatchObject({ text: '기존', lifecycle_status: 'active' });
    expect(await evidenceOf(existing)).toEqual([{ utterance_id: u1, relation: 'primary' }]);
  });

  it('rejects an AI candidate assigned to a speaker without a meeting utterance', async () => {
    const mid = await mkMeeting();
    const utt = await mkUtt(mid, 0, 0);
    const foreignSpeaker = await mkSpeaker();

    await expect(service.mergeAiExtraction(mid, [
      candidate({ primary_utterance_id: utt, assignee_speaker_id: foreignSpeaker }),
    ])).rejects.toThrow('assignee_speaker_id has no utterance in this meeting');
    expect((await db.pool.query(`SELECT 1 FROM lens_item WHERE meeting_id=$1`, [mid])).rowCount).toBe(0);
  });
});
