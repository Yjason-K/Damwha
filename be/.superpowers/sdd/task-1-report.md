# Task 1 report — execution-history schema and Nest job contract

Commit: `f931d7a feat: add lens extraction job contract`

## RED

Command:

```sh
npm test -- --runInBand test/job-payload.spec.ts
```

Result: failed as intended before production changes. TypeScript reported that
`ExtractLensesPayloadSchema` and `buildExtractLensesPayload` were not exported,
and that `LENS_LLM_MODEL` was absent from the environment type.

## GREEN and verification

Commands:

```sh
npm test -- --runInBand test/job-payload.spec.ts && npm test -- --runInBand test/lens-extraction.e2e-spec.ts
npm run build
git diff --check
```

Results:

- `test/job-payload.spec.ts`: 11/11 tests passed.
- `test/lens-extraction.e2e-spec.ts`: 1/1 test passed. It verifies that a duplicate queued run for the same meeting/version violates the partial unique index, and that a done run permits another done history row.
- `npm run build`: exited 0.
- `git diff --check`: exited 0 before commit.

## Files changed

- `src/database/migrations/010_lens_extraction_jobs.sql`
- `src/contracts/job-payload.schema.ts`
- `src/jobs/jobs.types.ts`
- `src/config/env.ts`
- `test/job-payload.spec.ts`
- `test/lens-extraction.e2e-spec.ts`

## Scope and concerns

- The migration adds `lens_extraction_run.job_id` with `ON DELETE SET NULL`, the one-active-run partial unique index, and the meeting/created-at index.
- The Nest contract exports the strict v1 extract-lenses payload schema, inferred type, builder, `extract_lenses` job type, and `LENS_LLM_MODEL` default (`qwen2.5:14b-instruct`).
- The database `job_type_check` is not changed here: the task brief explicitly limits this migration to execution-history schema changes and asks only for the Nest `JobType` union update. A later task that enqueues `extract_lenses` must extend the database CHECK constraint before writing that job type.

## Review fix — strict extract-lenses contract

The v1 `ExtractLensesPayloadSchema` now uses `.strict()`, so it rejects keys
outside its five contract fields: `schema_version`, `meeting_id`,
`processing_version`, `extraction_run_id`, and `model`. A regression test
supplies an `unexpected` key and asserts that parsing throws.

Focused verification command and output:

```sh
npm test -- --runInBand test/job-payload.spec.ts
```

```text
PASS test/job-payload.spec.ts
Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total
Snapshots:   0 total
```

Self-review: inspected the diff to confirm it changes only the extract-lenses
schema strictness, its regression test, and this report. No later-task behavior
or unrelated contracts were modified.
