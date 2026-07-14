# Lens Foundation Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and manage action, decision, and promise lens items with evidence links and global/meeting read APIs.

**Architecture:** A NestJS `LensesModule` owns normalized lens persistence. `LensesService` performs validation, transaction boundaries, cursor pagination, and the worker-facing AI merge; `LensesRepository` contains parameterized SQL. This plan excludes enqueueing, LLM invocation, and UI.

**Tech Stack:** NestJS 10, TypeScript 5, PostgreSQL 16, Jest, Supertest, Testcontainers.

## Global Constraints

- API JSON uses snake_case.
- Persist only `action`, `decision`, `promise`; topic lenses are separate work.
- An active AI item has exactly one primary evidence; a manual item can have none.
- User-created, edited, and completed items are never automatically archived.
- Migration is additive: `008_lens_foundation.sql`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/database/migrations/008_lens_foundation.sql` | Tables, checks, FKs, and indexes. |
| `src/lenses/lens.types.ts` | Literal unions, request and merge types. |
| `src/lenses/lenses.repository.ts` | All lens SQL. |
| `src/lenses/lenses.service.ts` | Validation, commands, reads, AI merge. |
| `src/lenses/lenses.controller.ts` | HTTP and Swagger routes. |
| `src/lenses/lenses.module.ts` | Provider/controller wiring. |
| `src/app.module.ts` | Module import. |
| `test/db.ts` | Lens test cleanup. |
| `test/lenses.service.spec.ts` | Merge classification unit tests. |
| `test/lenses.e2e-spec.ts` | API and persistence E2E tests. |

### Task 1: Add schema and reset coverage

**Files:**
- Create: `src/database/migrations/008_lens_foundation.sql`
- Modify: `test/db.ts:25-29`
- Create: `test/lenses.e2e-spec.ts`

**Produces:** `lens_item`, `lens_evidence`, `lens_extraction_run`, with IDs `lens_<n>` and `ler_<n>`.

- [ ] **Step 1: Write the failing migration test**

```ts
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
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm run test:e2e -- test/lenses.e2e-spec.ts`

Expected: FAIL because relation `lens_item` does not exist.

- [ ] **Step 3: Implement the additive migration**

```sql
CREATE SEQUENCE lens_id_seq;
CREATE TABLE lens_item (
  id text PRIMARY KEY DEFAULT 'lens_' || nextval('lens_id_seq') CHECK (id ~ '^lens_[1-9][0-9]*$'),
  meeting_id text NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('action','decision','promise')),
  text text NOT NULL CHECK (char_length(btrim(text)) BETWEEN 1 AND 1000),
  assignee_speaker_id text REFERENCES speaker(id), due_at date,
  completion_status text NOT NULL DEFAULT 'open' CHECK (completion_status IN ('open','done')),
  source text NOT NULL CHECK (source IN ('ai','user','edited')),
  user_modified boolean NOT NULL DEFAULT false,
  lifecycle_status text NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER SEQUENCE lens_id_seq OWNED BY lens_item.id;
CREATE INDEX lens_item_active_updated_idx ON lens_item(lifecycle_status, completion_status, updated_at DESC, id DESC);
CREATE TABLE lens_evidence (
  lens_item_id text NOT NULL REFERENCES lens_item(id) ON DELETE CASCADE,
  utterance_id text NOT NULL REFERENCES utterance(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN ('primary','supporting')),
  PRIMARY KEY (lens_item_id, utterance_id)
);
CREATE UNIQUE INDEX lens_evidence_one_primary_idx ON lens_evidence(lens_item_id) WHERE relation='primary';
CREATE SEQUENCE ler_id_seq;
CREATE TABLE lens_extraction_run (
  id text PRIMARY KEY DEFAULT 'ler_' || nextval('ler_id_seq') CHECK (id ~ '^ler_[1-9][0-9]*$'),
  meeting_id text NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  processing_version int NOT NULL, status text NOT NULL CHECK (status IN ('queued','running','done','failed')),
  model text, error jsonb, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
ALTER SEQUENCE ler_id_seq OWNED BY lens_extraction_run.id;
```

Extend the `TRUNCATE` in `test/db.ts` to include `lens_evidence, lens_item, lens_extraction_run` before their parent tables.

- [ ] **Step 4: Verify and commit the schema**

Run: `npm run test:e2e -- test/lenses.e2e-spec.ts && npm run test:e2e && npm run build`

Expected: all commands exit 0.

```bash
git add src/database/migrations/008_lens_foundation.sql test/db.ts test/lenses.e2e-spec.ts
git commit -m "feat: add lens persistence schema"
```

### Task 2: Implement validated read and manual command APIs

**Files:**
- Create: `src/lenses/lens.types.ts`
- Create: `src/lenses/lenses.repository.ts`
- Create: `src/lenses/lenses.service.ts`
- Create: `src/lenses/lenses.controller.ts`
- Create: `src/lenses/lenses.module.ts`
- Modify: `src/app.module.ts:4-24`
- Modify: `test/lenses.e2e-spec.ts`

**Produces:** `GET /lenses`, `GET /meetings/:id/lenses`, item CRUD, complete/reopen, evidence add/remove.

- [ ] **Step 1: Write the failing endpoint tests**

```ts
it('lists active open items newest-first with meeting metadata and evidence', async () => {
  const res = await request(srv()).get('/lenses');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ items: expect.any(Array), next_cursor: null });
  expect(res.body.items[0]).toMatchObject({
    id: expect.stringMatching(/^lens_/), kind: 'action', lifecycle_status: 'active',
    meeting: { id: expect.stringMatching(/^mtg_/), title: expect.anything() },
    evidence: [{ relation: 'primary', utterance: { id: expect.stringMatching(/^utt_/), start_ms: 0 } }],
  });
});

expect((await request(srv()).post('/lenses').send({ meeting_id: mid, kind: 'action', text: '  문서 작성  ' })).body)
  .toMatchObject({ source: 'user', user_modified: true, completion_status: 'open', text: '문서 작성' });
expect((await request(srv()).post(`/lenses/${aiItem}/evidence`).send({ utterance_id: foreignUtt, relation: 'primary' })).status).toBe(400);
expect((await request(srv()).delete(`/lenses/${aiItem}/evidence/${primaryUtt}`)).status).toBe(409);
expect((await request(srv()).post(`/lenses/${userItem}/complete`)).body).toMatchObject({ completion_status: 'done', user_modified: true });
expect((await request(srv()).patch(`/lenses/${userItem}`).send({ text: '수정된 문서' })).body)
  .toMatchObject({ source: 'edited', user_modified: true, text: '수정된 문서' });
```

Also cover all list filters, default `open`/`active`, `limit=1` cursor continuation, invalid cursor 400, unknown IDs 404, invalid kind/date/text 400, assignee without a meeting utterance 400, and transaction rollback after rejected evidence.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm run test:e2e -- test/lenses.e2e-spec.ts -t "lists active|creates|evidence|complete|patches"`

Expected: FAIL with 404 because no lens controller is registered.

- [ ] **Step 3: Implement types, repository, module, controller, and service**

```ts
export const LENS_KINDS = ['action', 'decision', 'promise'] as const;
export type LensKind = typeof LENS_KINDS[number];
export type LensSource = 'ai' | 'user' | 'edited';
export type LensCompletionStatus = 'open' | 'done';
export type LensLifecycleStatus = 'active' | 'archived';
export type EvidenceRelation = 'primary' | 'supporting';
export type LensListFilters = { kind?: LensKind; meeting_id?: string; speaker_id?: string; date_from?: string; date_to?: string; completion_status?: LensCompletionStatus; lifecycle_status?: LensLifecycleStatus; limit?: number; cursor?: string };
```

Repository list SQL joins `meeting`, optional assignee `speaker`, `lens_evidence`, and `utterance`; it orders evidence primary first and uses `(li.updated_at, li.id) < ($updatedAt, $id)`, `updated_at DESC, id DESC`, and `limit + 1`. `GET /lenses` defaults to `open`, `active`, `limit=20` and returns `{ items, next_cursor }`; `GET /meetings/:id/lenses` returns active items after checking the meeting exists. Cursors are base64url JSON `{ updated_at, id }`, rejected with `BadRequestException('cursor is invalid')` when malformed.

Use manual validators matching current services: trim text (1–1,000), IDs `^mtg_[1-9][0-9]*$`, `^spk_[1-9][0-9]*$`, `^utt_[1-9][0-9]*$`, valid `YYYY-MM-DD`, and max limit 100. Every mutation runs in `db.withTransaction`; verify assignee membership with a meeting utterance and evidence ownership with a meeting-scoped utterance query. Edits set `source='edited', user_modified=true`; completion and evidence changes set `user_modified=true`; reject deleting the only primary evidence of an active AI item with `ConflictException`. Register the module in `AppModule` and use `@ApiTags('lenses')`.

- [ ] **Step 4: Verify and commit the API**

Run: `npm run test:e2e -- test/lenses.e2e-spec.ts && npm run test:e2e && npm run build`

Expected: all commands exit 0.

```bash
git add src/lenses src/app.module.ts test/lenses.e2e-spec.ts
git commit -m "feat: add lens CRUD and evidence APIs"
```

### Task 3: Implement the worker-facing AI merge boundary

**Files:**
- Create: `test/lenses.service.spec.ts`
- Modify: `src/lenses/lens.types.ts`
- Modify: `src/lenses/lenses.repository.ts`
- Modify: `src/lenses/lenses.service.ts`
- Modify: `test/lenses.e2e-spec.ts`

**Produces:** `mergeAiExtraction(meetingId: string, candidates: AiLensCandidate[]): Promise<void>`; no HTTP route.

- [ ] **Step 1: Write failing merge tests**

```ts
expect(classifyAiMerge(existing, candidates)).toEqual([
  { type: 'update', lens_id: 'lens_1', candidate: candidates[0] },
  { type: 'create', candidate: candidates[1] },
  { type: 'archive', lens_id: 'lens_2' },
]);
```

In E2E create untouched active AI, user-created, edited, and completed records. Verify a merge updates/archives only untouched active AI and leaves the other three active and unchanged.

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test -- lenses.service.spec.ts && npm run test:e2e -- test/lenses.e2e-spec.ts -t "merge"`

Expected: FAIL because merge functions do not exist.

- [ ] **Step 3: Implement deterministic merge in one transaction**

```ts
export type AiLensCandidate = {
  kind: LensKind; text: string; assignee_speaker_id: string | null; due_at: string | null;
  primary_utterance_id: string; supporting_utterance_ids: string[];
};
const eligible = existing.filter((item) =>
  item.source === 'ai' && !item.user_modified && item.lifecycle_status === 'active' && item.completion_status === 'open',
);
const key = (kind: LensKind, utteranceId: string) => `${kind}:${utteranceId}`;
```

Export pure `classifyAiMerge`. For each candidate, validate all distinct evidence utterances belong to the meeting; match eligible items by kind and primary utterance, update matches and replace their evidence, create unmatched candidates as active unmodified AI, and archive unmatched eligible rows. Do not mutate user-created, edited, user-modified, or completed rows. Ensure exactly one primary evidence on every created/updated active AI item before committing.

- [ ] **Step 4: Verify and commit the merge boundary**

Run: `npm test -- lenses.service.spec.ts && npm run test:e2e -- test/lenses.e2e-spec.ts && npm run test:e2e && npm run build`

Expected: all commands exit 0.

```bash
git add src/lenses/lens.types.ts src/lenses/lenses.repository.ts src/lenses/lenses.service.ts test/lenses.service.spec.ts test/lenses.e2e-spec.ts
git commit -m "feat: add lens AI merge policy"
```

## Plan Self-Review

- Tasks 1–3 cover every approved requirement: persistence, extraction-run records, evidence ownership, reads, commands, filters, cursor paging, transactions, and all merge preservation rules.
- The plan excludes worker jobs, LLM calls, UI, and saved topic lenses.
- Types, literal values, IDs, routes, cursor ordering, and merge keys are consistent across tasks.
- No unresolved implementation or test step remains.
