# 렌즈 직접 DB 쓰기 불변식 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 직접 SQL 경로도 활성 AI 렌즈가 primary evidence 하나 없이 commit되지 않도록 한다.

**Architecture:** 기존 partial unique index는 primary evidence의 최대 하나를 보장한다. 새 PostgreSQL deferred constraint trigger는 commit 시 활성 AI item의 primary evidence 존재를 검사해 최소 하나를 보장하며, 기존 회의 소속 trigger와 함께 동작한다.

**Tech Stack:** PostgreSQL PL/pgSQL, SQL migrations, Jest migration/E2E, pytest worker regression.

## Global Constraints

- active AI item은 commit 시 primary evidence를 정확히 하나 가져야 한다.
- user·edited·archived item은 primary evidence 없이 허용한다.
- trigger는 `DEFERRABLE INITIALLY DEFERRED`여서 정상 다단계 쓰기는 한 transaction 안에서 가능해야 한다.
- evidence 회의 소속 검증은 기존 trigger를 유지한다.
- API·worker 기능 변경은 범위에 포함하지 않는다.

---

### Task 1: Deferred primary-evidence DB constraint

**Files:**
- Create: `src/database/migrations/014_active_ai_lens_primary_evidence.sql`
- Modify: `test/migration.spec.ts`

**Interfaces:**
- Produces `active_ai_lens_has_primary()` deferred trigger function.
- Produces triggers for `lens_item` and `lens_evidence`.

- [ ] **Step 1: Write failing migration tests**

Add direct SQL tests that force transaction commit with `SET CONSTRAINTS ALL IMMEDIATE`.

```ts
it('rejects commit of active AI lens without primary evidence', async () => {
  await db.pool.query('BEGIN');
  const item = await db.pool.query(
    `INSERT INTO lens_item(meeting_id,kind,text,source,user_modified)
     VALUES($1,'action','x','ai',false) RETURNING id`, [meetingId],
  );
  await expect(db.pool.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toThrow(/primary evidence/i);
  await db.pool.query('ROLLBACK');
});
```

Add success cases: create AI item + primary in one transaction; replace primary in one transaction; user, edited, archived AI without primary.

- [ ] **Step 2: Run test to verify RED**

Run: `npm test -- --runInBand test/migration.spec.ts`

Expected: the no-primary commit test fails because no trigger exists.

- [ ] **Step 3: Implement migration**

```sql
CREATE FUNCTION active_ai_lens_has_primary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id text := COALESCE(NEW.lens_item_id, OLD.lens_item_id, NEW.id, OLD.id);
BEGIN
  IF EXISTS (
    SELECT 1 FROM lens_item li
    WHERE li.id=target_id AND li.source='ai' AND li.lifecycle_status='active'
      AND NOT EXISTS (
        SELECT 1 FROM lens_evidence le
        WHERE le.lens_item_id=li.id AND le.relation='primary'
      )
  ) THEN
    RAISE EXCEPTION 'active AI lens item must have primary evidence'
      USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
```

Create deferred constraint triggers for lens item INSERT/UPDATE OF source,lifecycle_status and lens evidence INSERT/UPDATE OF lens_item_id,relation/DELETE. Use trigger-specific functions or separate functions where OLD/NEW shape requires it; never reference a nonexistent record field.

- [ ] **Step 4: Run GREEN tests**

Run: `npm test -- --runInBand test/migration.spec.ts`

Expected: all migration tests pass; invalid direct writes fail only at constraint check/commit.

- [ ] **Step 5: Commit**

```bash
git add src/database/migrations/014_active_ai_lens_primary_evidence.sql test/migration.spec.ts
git commit -m "feat: enforce active AI lens primary evidence"
```

### Task 2: Existing writer compatibility and regression verification

**Files:**
- Modify only if tests expose a compatibility defect: `src/lenses/lenses.repository.ts`, `worker/damwha_worker/db.py`
- Test: `test/lenses.e2e-spec.ts`, `worker/tests/test_extract_lenses.py`

**Interfaces:**
- Consumes Task 1 deferred DB constraint.
- Preserves existing API and worker transaction boundaries.

- [ ] **Step 1: Run existing writer regression tests**

Run: `npm run test:e2e -- --runInBand test/lenses.e2e-spec.ts && cd worker && uv run pytest tests/test_extract_lenses.py -q`

Expected: any failure identifies an existing transaction that commits active AI item before its primary evidence.

- [ ] **Step 2: Make only the minimal transaction-boundary fix if RED**

If a writer fails, put its AI item insert/update and primary evidence write in the same existing transaction. Do not weaken or defer the DB constraint.

- [ ] **Step 3: Verify full required suite**

Run:

```bash
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run build
cd worker && uv run pytest -q
cd worker && uv run ruff check . && uv run ruff format --check .
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 4: Commit compatibility changes only when needed**

```bash
git add src/lenses/lenses.repository.ts worker/damwha_worker/db.py test/lenses.e2e-spec.ts worker/tests/test_extract_lenses.py
git commit -m "fix: keep lens writers compatible with DB invariant"
```

## Plan Self-Review

- Spec coverage: Task 1 creates and directly tests the deferred invariant; Task 2 verifies API/worker writers and all required suites.
- Placeholder scan: no deferred implementation markers remain.
- Type consistency: all SQL uses `lens_item_id` only on evidence records and `id` only on lens items.

