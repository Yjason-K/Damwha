# Saved Utterances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist selected transcript utterances, browse them across meetings, and return to the exact audio position.

**Architecture:** A small NestJS `saved-utterances` domain owns snapshot persistence and REST endpoints. A React `features/saved-utterance` module owns TanStack Query data access and list UI. A merged block saves under its first source ID while preserving all visible text as a snapshot.

**Tech Stack:** PostgreSQL/raw SQL, NestJS, Jest/Supertest/Testcontainers, React 19, React Router, TanStack Query, Vitest, Testing Library, Tailwind.

**Spec:** `docs/superpowers/specs/2026-08-24-saved-utterances-design.md`

## Global Constraints

- Server persistence only: no `localStorage`.
- Saving accepts only an `ok` utterance on the meeting's current `processing_version`.
- Deleted utterances preserve their snapshots; deleted meetings cascade their snapshots.
- Valid jumps always use `/meetings/:meetingId?u=:utteranceId`.
- Keep Korean UI copy and do not modify existing worker changes.

---

### Task 1: Add persisted saved-utterance REST API

**Files:**

- Create: `be/src/database/migrations/019_saved_utterance.sql`
- Create: `be/src/saved-utterances/saved-utterances.types.ts`
- Create: `be/src/saved-utterances/saved-utterances.repository.ts`
- Create: `be/src/saved-utterances/saved-utterances.service.ts`
- Create: `be/src/saved-utterances/saved-utterances.controller.ts`
- Create: `be/src/saved-utterances/saved-utterances.module.ts`
- Modify: `be/src/app.module.ts`
- Test: `be/test/saved-utterances.e2e-spec.ts`

**Interfaces:**

- Produces `GET /saved-utterances`, `GET /saved-utterances/ids`, `PUT /saved-utterances/:utteranceId`, and `DELETE /saved-utterances/:utteranceId`.
- List result: `{ items: SavedUtteranceResponse[]; next_cursor: string | null }`.
- A response item has `id`, `utterance_id`, `text`, `speaker_name`, `start_ms`, `created_at`, and `meeting: { id, title, recorded_at }`.

- [ ] **Step 1: Write a failing saved-utterance e2e suite**

Follow the real-app/Testcontainers setup in `be/test/lenses.e2e-spec.ts`; add helpers for a done meeting and current-version utterance. Write the following test first:

```ts
it('saves a visible snapshot and reports the saved source ID', async () => {
  const mid = await mkMeeting('로드맵 회의');
  const uid = await mkUtterance(mid, 0, 65_000, '원문 첫 문장');
  const res = await request(srv()).put(`/saved-utterances/${uid}`)
    .send({ text_snapshot: '원문 첫 문장 두 번째 문장' });

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    utterance_id: uid,
    text: '원문 첫 문장 두 번째 문장',
    start_ms: 65_000,
    meeting: { id: mid, title: '로드맵 회의' },
  });
  expect((await request(srv()).get(`/saved-utterances/ids?utterance_ids=${uid}`)).body)
    .toEqual({ utterance_ids: [uid] });
});
```

Add independent tests for duplicate PUT idempotence, idempotent DELETE, stale-version and `transcribe_failed` 404s, invalid snapshots, newest-first keyset pagination, utterance deletion snapshot fallback, and meeting deletion cascade. These catch broken ownership, snapshot, pagination, and toggle semantics.

- [ ] **Step 2: Verify the test fails for the missing behavior**

Run: `nvm use 22 && pnpm --dir be exec jest test/saved-utterances.e2e-spec.ts --runInBand`

Expected: FAIL because no migration/module/routes exist.

- [ ] **Step 3: Implement migration and NestJS domain**

Use this exact migration core:

```sql
CREATE SEQUENCE sav_id_seq;
CREATE TABLE saved_utterance (
  id text PRIMARY KEY DEFAULT 'sav_' || nextval('sav_id_seq') CHECK (id ~ '^sav_[1-9][0-9]*$'),
  meeting_id text NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  utterance_id text REFERENCES utterance(id) ON DELETE SET NULL,
  text_snapshot text NOT NULL CHECK (char_length(btrim(text_snapshot)) BETWEEN 1 AND 4000),
  speaker_name_snapshot text,
  start_ms_snapshot int NOT NULL CHECK (start_ms_snapshot >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (utterance_id)
);
CREATE INDEX saved_utterance_created_idx ON saved_utterance(created_at DESC, id DESC);
```

The repository selects a save candidate with `u.status='ok' AND u.processing_version=m.processing_version`. Insert with `ON CONFLICT (utterance_id) DO UPDATE SET utterance_id=EXCLUDED.utterance_id RETURNING id` so duplicates return the same record without replacing the first snapshot. Hydrate with a live utterance/speaker `LEFT JOIN` and `COALESCE` snapshots on historical rows. Use `(created_at,id)` keyset ordering, `limit+1`, and a base64url `{ created_at, id }` cursor. Validate `utt_` IDs, 1–4,000 trimmed text, cursor shape, and at most 100 IDs. Register the module in `AppModule`.

- [ ] **Step 4: Verify the e2e suite passes**

Run: `nvm use 22 && pnpm --dir be exec jest test/saved-utterances.e2e-spec.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit the API slice**

```bash
git add be/src/app.module.ts be/src/database/migrations/019_saved_utterance.sql be/src/saved-utterances be/test/saved-utterances.e2e-spec.ts
git commit -m "feat: persist saved utterances"
```

### Task 2: Add frontend query and mutation contracts

**Files:**

- Create: `fe/src/features/saved-utterance/api/types.ts`
- Create: `fe/src/features/saved-utterance/api/saved-utterances.ts`
- Test: `fe/src/features/saved-utterance/api/saved-utterances.test.tsx`

**Interfaces:**

- Produces `useSavedUtteranceIds(ids)`, `useSavedUtterances()`, `useSaveUtterance()`, and `useRemoveSavedUtterance()`.
- Maps wire fields to `SavedUtterance { utteranceId, text, speakerName, startMs, createdAt, meeting }`.

- [ ] **Step 1: Write failing hook tests**

Render hooks under a real `QueryClientProvider`, mock only `apiClient`, and test a state consumers use:

```tsx
test('saving marks the transcript ID and prepends the returned card', async () => {
  apiClient.put.mockResolvedValueOnce({ data: savedWire('utt_2', '두 문장') });
  const { result } = renderHook(() => ({ ids: useSavedUtteranceIds(['utt_2']), save: useSaveUtterance() }), { wrapper });
  await act(() => result.current.save.mutateAsync({ utteranceId: 'utt_2', text: '두 문장' }));
  expect(result.current.ids.data?.has('utt_2')).toBe(true);
});
```

Also cover save rollback, remove removing a cached card, no request for empty IDs, and forwarding the pagination cursor. These tests catch stale UI state after mutation and incorrect cache keys.

- [ ] **Step 2: Verify the hook test fails**

Run: `nvm use 22 && pnpm --dir fe vitest run src/features/saved-utterance/api/saved-utterances.test.tsx`

Expected: FAIL because the hooks do not exist.

- [ ] **Step 3: Implement canonical queries and rollback-safe mutations**

Canonicalize IDs before creating the query key:

```ts
const canonicalIds = [...new Set(ids)].sort();
useQuery({
  queryKey: ['saved-utterance-ids', canonicalIds],
  enabled: canonicalIds.length > 0,
  queryFn: async () => new Set((await apiClient.get('/saved-utterances/ids', {
    params: { utterance_ids: canonicalIds.join(',') },
  })).data.utterance_ids),
});
```

For save/remove, cancel saved queries, snapshot both ID-set and infinite-list cache values, optimistically update them, restore them in `onError`, and invalidate saved prefixes in `onSettled`. Do not invalidate meeting detail data.

- [ ] **Step 4: Verify the hook test passes**

Run: `nvm use 22 && pnpm --dir fe vitest run src/features/saved-utterance/api/saved-utterances.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the frontend data slice**

```bash
git add fe/src/features/saved-utterance/api
git commit -m "feat: add saved utterance queries"
```

### Task 3: Add the transcript bookmark control

**Files:**

- Modify: `fe/src/shared/ui/utterance.tsx`
- Modify: `fe/src/features/meeting/ui/transcript-pane.tsx`
- Test: `fe/src/features/meeting/ui/transcript-pane.test.tsx`

**Interfaces:**

- Consumes Task 2 hooks and `UtteranceEntry.sources`.
- Produces a button labelled `발언 저장` or `저장 해제` beside `원문 보기`.

- [ ] **Step 1: Write failing transcript behavior tests**

Mock the hook boundary with a real `Set` and verify the selected visual block maps to its first source:

```tsx
test('saving a merged block uses its first source and complete visible text', () => {
  renderPane({ activeId: 'u2', utterances: [mergedUtterance('u1', ['u1', 'u2'], '첫 문장 두 번째 문장')] });
  fireEvent.click(screen.getByRole('button', { name: '발언 저장' }));
  expect(saveMutate).toHaveBeenCalledWith({ utteranceId: 'u1', text: '첫 문장 두 번째 문장' }, expect.anything());
});
```

Add a saved-set case asserting `저장 해제` appears. These tests catch a wrong source ID, partial text snapshot, or missing accessible toggle.

- [ ] **Step 2: Verify the transcript test fails**

Run: `nvm use 22 && pnpm --dir fe vitest run src/features/meeting/ui/transcript-pane.test.tsx`

Expected: FAIL because no bookmark action is present.

- [ ] **Step 3: Implement control props and transcript integration**

Add `saved`, `onSaveToggle`, and `savePending` props to `Utterance`; add the icon button to the existing absolute original-view action cluster and reserve active-line space for both. Its label is `발언 저장` or `저장 해제`, and it disables only for its pending request. In `TranscriptPane`, query representative source IDs and call save with `{ utteranceId: u.sources[0].id, text: u.text }`, otherwise remove that ID. Use the project's existing Korean error toast style and never call `onJump` from this handler.

- [ ] **Step 4: Verify transcript tests pass**

Run: `nvm use 22 && pnpm --dir fe vitest run src/features/meeting/ui/transcript-pane.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the transcript slice**

```bash
git add fe/src/shared/ui/utterance.tsx fe/src/features/meeting/ui/transcript-pane.tsx fe/src/features/meeting/ui/transcript-pane.test.tsx
git commit -m "feat: save transcript utterances"
```

### Task 4: Build saved list screen and navigation

**Files:**

- Create: `fe/src/features/saved-utterance/ui/saved-utterance-list.tsx`
- Create: `fe/src/features/saved-utterance/ui/saved-utterance-dashboard.tsx`
- Create: `fe/src/pages/saved-utterances.tsx`
- Modify: `fe/src/app/router.tsx`
- Modify: `fe/src/features/meeting/ui/left-nav.tsx`
- Test: `fe/src/pages/saved-utterances.test.tsx`
- Test: `fe/src/features/meeting/ui/left-nav.test.tsx`

**Interfaces:**

- Consumes Task 2 hooks and `formatClock`.
- Produces lazy `/saved-utterances` and active left navigation.

- [ ] **Step 1: Write failing screen and navigation tests**

```tsx
test('a saved card displays context and jumps via the common utterance URL', async () => {
  renderSavedRoute([savedItem({ utteranceId: 'utt_4', meetingId: 'mtg_2', text: '결정은 다음 주에 합니다.', startMs: 73_000 })]);
  expect(await screen.findByText('결정은 다음 주에 합니다.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '원문으로 이동' }));
  expect(screen.getByText('경로: /meetings/mtg_2?u=utt_4')).toBeInTheDocument();
});
```

Add independent checks for empty copy, retryable error state, immediate removal, historical cards with a disabled jump button, and `LeftNav` active state at `/saved-utterances`.

- [ ] **Step 2: Verify screen tests fail**

Run: `nvm use 22 && pnpm --dir fe vitest run src/pages/saved-utterances.test.tsx src/features/meeting/ui/left-nav.test.tsx`

Expected: FAIL because the route and dashboard do not exist.

- [ ] **Step 3: Implement dashboard, list, route, and link**

Mirror the global lens dashboard shell without tabs/filters. Use an IntersectionObserver sentinel only when `hasNextPage && !isFetchingNextPage`. Cards show meeting/date, speaker/time, quote snapshot, jump, and removal. Navigate only when `item.utteranceId` exists:

```tsx
if (item.utteranceId) navigate(`/meetings/${item.meeting.id}?u=${item.utteranceId}`);
```

Add a lazy child route. Replace the nav placeholder with `Link to="/saved-utterances"` and use `useMatch('/saved-utterances')` for its active state.

- [ ] **Step 4: Verify screen tests pass**

Run: `nvm use 22 && pnpm --dir fe vitest run src/pages/saved-utterances.test.tsx src/features/meeting/ui/left-nav.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the saved-list slice**

```bash
git add fe/src/features/saved-utterance/ui fe/src/pages/saved-utterances.tsx fe/src/pages/saved-utterances.test.tsx fe/src/app/router.tsx fe/src/features/meeting/ui/left-nav.tsx fe/src/features/meeting/ui/left-nav.test.tsx
git commit -m "feat: browse saved utterances"
```

### Task 5: Verify the integrated feature

**Files:**

- Modify: `graphify-out/` only (generated and ignored)

**Interfaces:**

- Consumes all preceding contracts.
- Produces fresh test/build evidence.

- [ ] **Step 1: Run focused frontend tests**

Run: `nvm use 22 && pnpm --dir fe vitest run src/features/saved-utterance/api/saved-utterances.test.tsx src/features/meeting/ui/transcript-pane.test.tsx src/pages/saved-utterances.test.tsx src/features/meeting/ui/left-nav.test.tsx`

Expected: PASS.

- [ ] **Step 2: Run backend test and both builds**

Run: `nvm use 22 && pnpm --dir be exec jest test/saved-utterances.e2e-spec.ts --runInBand && pnpm --dir be build && pnpm --dir fe build`

Expected: exit `0` and fresh migration coverage in Testcontainers.

- [ ] **Step 3: Refresh graph and inspect diff**

Run: `graphify update . && git diff --check && git status --short`

Expected: graph update exits `0`, no whitespace errors, and existing worker edits remain untouched.

- [ ] **Step 4: Commit only the feature files if tasks 1–4 were not committed separately**

```bash
git add be/src/app.module.ts be/src/database/migrations/019_saved_utterance.sql be/src/saved-utterances be/test/saved-utterances.e2e-spec.ts fe/src/features/saved-utterance fe/src/shared/ui/utterance.tsx fe/src/features/meeting/ui/transcript-pane.tsx fe/src/features/meeting/ui/transcript-pane.test.tsx fe/src/pages/saved-utterances.tsx fe/src/pages/saved-utterances.test.tsx fe/src/app/router.tsx fe/src/features/meeting/ui/left-nav.tsx fe/src/features/meeting/ui/left-nav.test.tsx
git commit -m "feat: add saved utterances"
```
