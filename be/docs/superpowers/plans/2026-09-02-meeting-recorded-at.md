# 회의 기준일시(recorded_at) 필수화 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `meeting.recorded_at`을 NOT NULL 기준일시로 승격하고, 그 날짜를 렌즈 추출 프롬프트에 실어 LLM이 상대 날짜를 절대 날짜로 환산하게 한다.

**Architecture:** 마이그레이션이 기존 NULL을 `created_at`으로 백필한 뒤 NOT NULL을 건다. API는 미지정 업로드를 SQL `COALESCE`로 등록 시각에 채우고, PATCH의 null 해제를 400으로 막는다. 워커는 payload를 바꾸지 않고 `meeting.recorded_at`을 DB에서 직접 읽어 `Asia/Seoul` 날짜로 환산해 프롬프트에 싣고, `due_at` 검증을 항목 단위로 관대화한다.

**Tech Stack:** NestJS 10 + 원시 SQL(pg), Postgres 16, Python 3.12 + pydantic v2 + httpx, React 19 + Tailwind 4. 테스트는 jest + supertest + testcontainers(BE), pytest + pytest-httpx + testcontainers(워커), vitest + testing-library(FE).

**Spec:** `be/docs/superpowers/specs/2026-09-02-meeting-recorded-at-design.md`

## Global Constraints

- 모노레포 루트에서 패키지를 직접 실행하지 않는다. BE 테스트는 `pnpm be test`, 워커 테스트는 `pnpm worker:test`, FE 테스트는 `pnpm fe test`.
- `be/` 안에서 `npm install` 금지.
- 워커 타임존 기본값은 `Asia/Seoul`. 환경변수 이름은 `MEETING_TIMEZONE`.
- `extract_lenses` job payload의 `schema_version`은 **1로 유지한다.** 필드를 추가하지 않는다.
- `COALESCE(recorded_at, created_at)` / `NULLS LAST` 정렬 SQL은 그대로 둔다. 바꾸는 것은 그 가지를 검증하던 **테스트**뿐이다.
- 마이그레이션 파일명은 `021_meeting_recorded_at_not_null.sql`.
- 커밋 메시지는 한국어 현재형 한 줄 요약 + 필요한 경우 본문. 마지막 줄에 `Claude-Session: https://claude.ai/code/session_01AGsQWhdXuStcCHWiied6bc`.

---

### Task 1: NULL을 전제하던 기존 테스트를 DEFAULT 전제로 바꾼다

021 적용 전에 먼저 한다. 이 작업만으로도 테스트는 마이그레이션 전후 모두 통과한다 — 헬퍼가 명시적 NULL 대신 `COALESCE(..., now())`를 쓰게 하는 준비 작업이다.

**Files:**
- Modify: `be/test/lenses.e2e-spec.ts:58-61`, `be/test/lenses.e2e-spec.ts:160`
- Modify: `be/test/saved-utterances.e2e-spec.ts:30-34`, `be/test/saved-utterances.e2e-spec.ts:92`
- Modify: `be/test/search.repository.spec.ts:15-21`, `be/test/search.repository.spec.ts:151-153`

**Interfaces:**
- Consumes: 없음
- Produces: `mkMeeting(title, recordedAt)` / `seedMeeting(title, recordedAt)` 헬퍼가 `recordedAt === null`을 "미지정"으로 해석해 `now()`를 넣는다. Task 2의 마이그레이션이 들어와도 이 헬퍼들은 그대로 통과한다.

- [ ] **Step 1: `lenses.e2e-spec.ts`의 헬퍼와 테스트 이름을 고친다**

`be/test/lenses.e2e-spec.ts:58-61`을 아래로 바꾼다.

```ts
  // recorded_at은 NOT NULL(마이그레이션 021)이다. null을 넘기는 것은 "미지정"이라는
  // 뜻이고, 컬럼 기본값과 같은 규칙으로 등록 시각이 채워진다.
  const mkMeeting = async (title = '회의', recordedAt: string | null = null) =>
    (await db.pool.query(
      `INSERT INTO meeting(audio_key,status,title,recorded_at)
       VALUES('k','done',$1,COALESCE($2::timestamptz, now())) RETURNING id`,
      [title, recordedAt],
    )).rows[0].id;
```

`be/test/lenses.e2e-spec.ts:160`의 테스트 이름을 바꾼다. 기대값은 그대로다 — 미지정 회의의 `recorded_at`이 `now()`가 되어 여전히 가장 최근이다.

```ts
  it('sorts a meeting with an unset recorded_at by its registration time', async () => {
```

- [ ] **Step 2: `saved-utterances.e2e-spec.ts`를 같은 방식으로 고친다**

`be/test/saved-utterances.e2e-spec.ts:30-34`:

```ts
  // recorded_at은 NOT NULL(마이그레이션 021) — null은 "미지정"이고 등록 시각이 채워진다.
  const mkMeeting = async (title = '회의', recordedAt: string | null = null) =>
    (await db.pool.query(
      `INSERT INTO meeting(audio_key,status,title,recorded_at)
       VALUES('audio','done',$1,COALESCE($2::timestamptz, now())) RETURNING id`,
      [title, recordedAt],
    )).rows[0].id as string;
```

`be/test/saved-utterances.e2e-spec.ts:92`:

```ts
  it('sorts a meeting with an unset recorded_at by its registration time', async () => {
```

- [ ] **Step 3: `search.repository.spec.ts`를 고친다**

`be/test/search.repository.spec.ts:15-21`:

```ts
  // recorded_at은 NOT NULL(마이그레이션 021) — null은 "미지정"이고 등록 시각이 채워진다.
  async function seedMeeting(title: string, recordedAt: string | null) {
    const r = await db.pool.query(
      `INSERT INTO meeting(title, audio_key, recorded_at, status)
       VALUES($1,'k',COALESCE($2::timestamptz, now()),'done') RETURNING id`,
      [title, recordedAt],
    );
    return r.rows[0].id as string;
  }
```

`be/test/search.repository.spec.ts:151-153`의 테스트는 기대값이 뒤집힌다 — 미지정 회의가 `now()`를 받아 가장 최근이 되기 때문이다. NULL 정렬이 아니라 순서 자체를 검증하도록 명시적 과거 날짜를 준다.

```ts
  it('browse orders recorded_at DESC and excludes non-ok', async () => {
    const m1 = await seedMeeting('dated', '2026-06-20T00:00:00Z');
    const m2 = await seedMeeting('older', '2020-01-01T00:00:00Z');
```

같은 테스트의 나머지 줄(`seedUtterance`, `expect`)은 그대로 둔다.

- [ ] **Step 4: 테스트를 돌려 전부 통과하는지 본다**

Run: `pnpm be test -- lenses.e2e-spec saved-utterances.e2e-spec search.repository.spec`
Expected: PASS (마이그레이션 021은 아직 없다 — 헬퍼 변경만으로 통과해야 한다)

- [ ] **Step 5: 커밋**

```bash
git add be/test/lenses.e2e-spec.ts be/test/saved-utterances.e2e-spec.ts be/test/search.repository.spec.ts
git commit -m "$(cat <<'EOF'
test(be): 회의 시드 헬퍼가 NULL 대신 등록 시각을 쓰게 한다

recorded_at이 NOT NULL이 되면 명시적 NULL INSERT는 제약 위반이 된다.
헬퍼가 COALESCE로 미지정을 등록 시각으로 채우게 바꿔, 마이그레이션 전후
모두 통과하는 상태로 먼저 옮겨 둔다.

Claude-Session: https://claude.ai/code/session_01AGsQWhdXuStcCHWiied6bc
EOF
)"
```

---

### Task 2: recorded_at을 NOT NULL로 승격한다

마이그레이션·업로드 INSERT·PATCH를 한 덩어리로 간다. 셋 중 하나만 넣으면 테스트 스위트가 빨갛게 남는다 — 마이그레이션만 넣으면 미지정 업로드가 죽고, INSERT만 고치면 검증할 제약이 없다.

**Files:**
- Create: `be/src/database/migrations/021_meeting_recorded_at_not_null.sql`
- Modify: `be/src/meetings/meetings.service.ts:84-88` (업로드 INSERT), `be/src/meetings/meetings.service.ts:137-156` (update)
- Modify: `be/src/meetings/meetings.repository.ts:23-33` (죽은 `create`), `be/src/meetings/meetings.repository.ts:43-47` (patch 타입)
- Test: `be/test/migration.spec.ts`, `be/test/meetings.e2e-spec.ts`, `be/test/meetings-management.e2e-spec.ts:56-68`

**Interfaces:**
- Consumes: Task 1의 시드 헬퍼
- Produces: `meeting.recorded_at`이 NOT NULL이고 기본값이 `now()`. `MeetingsService.update`의 patch 타입이 `{ title?: string | null; recorded_at?: string }` — `recorded_at`에서 `| null`이 빠진다.

- [ ] **Step 1: 실패하는 테스트를 쓴다 — 마이그레이션 백필**

`be/test/migration.spec.ts`의 마지막 `it(...)` 뒤에 넣는다. 이 파일은 `fs`·`path`를 이미 import 하고 있고 `afterEach` 리셋이 없으므로, 제약을 풀었다가 마이그레이션이 다시 걸어 복구한다.

```ts
  it('021 backfills a null recorded_at from created_at and makes the column NOT NULL', async () => {
    // startTestDb()는 항상 모든 마이그레이션을 적용한 DB를 준다. 021 이전 상태를
    // 재현하려면 제약을 잠깐 풀어야 한다 — 021을 다시 실행하면 복구된다.
    await db.pool.query(`ALTER TABLE meeting ALTER COLUMN recorded_at DROP NOT NULL`);
    const seeded = await db.pool.query(
      `INSERT INTO meeting(audio_key, status, recorded_at, created_at)
       VALUES('k','uploaded', NULL, '2026-01-02T03:04:05Z') RETURNING id`,
    );
    const id = seeded.rows[0].id;

    const sql = fs.readFileSync(
      path.join(__dirname, '../src/database/migrations/021_meeting_recorded_at_not_null.sql'),
      'utf8',
    );
    await db.pool.query(sql);

    const row = await db.pool.query(
      `SELECT recorded_at, created_at FROM meeting WHERE id=$1`,
      [id],
    );
    expect(row.rows[0].recorded_at.toISOString()).toBe(row.rows[0].created_at.toISOString());

    const col = await db.pool.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name='meeting' AND column_name='recorded_at'`,
    );
    expect(col.rows[0].is_nullable).toBe('NO');
  });
```

- [ ] **Step 2: 실패하는 테스트를 쓴다 — 업로드 기본값**

`be/test/meetings.e2e-spec.ts`의 첫 `it(...)` 뒤에 넣는다.

```ts
  it('POST /meetings without recorded_at records the upload time', async () => {
    const before = Date.now();
    const res = await request(srv())
      .post('/meetings')
      .attach('audio', Buffer.from('fake-audio'), { filename: 'rec.m4a', contentType: 'audio/mp4' });
    expect(res.status).toBe(201);
    expect(res.body.recorded_at).not.toBeNull();
    const recorded = new Date(res.body.recorded_at).getTime();
    expect(recorded).toBeGreaterThanOrEqual(before - 1000);
    expect(recorded).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('POST /meetings keeps an explicit recorded_at', async () => {
    const res = await request(srv())
      .post('/meetings')
      .field('recorded_at', '2026-07-03T09:00:00Z')
      .attach('audio', Buffer.from('fake-audio'), { filename: 'rec.m4a', contentType: 'audio/mp4' });
    expect(res.status).toBe(201);
    expect(new Date(res.body.recorded_at).toISOString()).toBe('2026-07-03T09:00:00.000Z');
  });
```

- [ ] **Step 3: 실패하는 테스트를 쓴다 — PATCH null 거부**

`be/test/meetings-management.e2e-spec.ts:56-68`의 `it('PATCH /meetings/:id accepts a date-only recorded_at and null clears', ...)` 전체를 아래 두 개로 교체한다.

```ts
  it('PATCH /meetings/:id accepts a date-only recorded_at', async () => {
    const mid = (await upload()).body.id;
    const dateOnly = await request(srv()).patch(`/meetings/${mid}`).send({ recorded_at: '2026-07-03' });
    expect(dateOnly.status).toBe(200);
    expect(dateOnly.body.recorded_at).not.toBeNull();

    const cleared = await request(srv()).patch(`/meetings/${mid}`).send({ title: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.title).toBeNull();
  });

  it('PATCH /meetings/:id → 400 when recorded_at is null', async () => {
    // 모든 회의는 기준일시를 갖는다 — 해제할 수단을 남기면 NOT NULL이 뚫린다.
    const mid = (await upload()).body.id;
    const res = await request(srv()).patch(`/meetings/${mid}`).send({ recorded_at: null });
    expect(res.status).toBe(400);
    const row = await db.pool.query('SELECT recorded_at FROM meeting WHERE id=$1', [mid]);
    expect(row.rows[0].recorded_at).not.toBeNull();
  });
```

- [ ] **Step 4: 테스트를 돌려 실패를 확인한다**

Run: `pnpm be test -- migration.spec meetings.e2e-spec meetings-management.e2e-spec`
Expected: FAIL — 백필 테스트는 021 파일이 없어 `ENOENT`, PATCH null 테스트는 400 대신 200.

- [ ] **Step 5: 마이그레이션 파일을 만든다**

Create `be/src/database/migrations/021_meeting_recorded_at_not_null.sql`:

```sql
-- 모든 회의에 기준일시를 보장한다. 렌즈 추출이 "오늘"·"다음 주 목요일" 같은 상대
-- 날짜를 절대 날짜로 환산하려면 기준이 되는 날짜가 반드시 있어야 한다.
--
-- 순서가 중요하다: 백필이 먼저다. SET NOT NULL을 먼저 걸면 기존 NULL 행 때문에
-- 실패한다. 백필 값은 created_at — 등록 시각은 이 회의에 대해 시스템이 아는 유일한
-- 시점이고, 미지정 업로드의 기본값과 같은 규칙이라 신·구 데이터가 같은 의미를 갖는다.
UPDATE meeting SET recorded_at = created_at WHERE recorded_at IS NULL;
ALTER TABLE meeting ALTER COLUMN recorded_at SET DEFAULT now();
ALTER TABLE meeting ALTER COLUMN recorded_at SET NOT NULL;
```

- [ ] **Step 6: 업로드 INSERT를 COALESCE로 바꾼다**

`be/src/meetings/meetings.service.ts:84-88`을 아래로 바꾼다. Postgres의 `DEFAULT`는 컬럼이 **생략됐을 때만** 적용되고 명시적 NULL에는 적용되지 않는다 — 지금 코드가 넘기는 `?? null`이 정확히 그 경우다.

```ts
      const meeting = await c.query(
        // DEFAULT는 컬럼을 생략했을 때만 걸린다. 값 바인딩을 유지하려면 COALESCE로
        // "미지정 = 등록 시각" 규칙을 SQL 한 곳에 둔다 (문장을 두 벌로 나누면
        // 파라미터 번호가 갈라진다).
        `INSERT INTO meeting(id, title, original_filename, audio_key, recorded_at, status)
         VALUES($1,$2,$3,$4,COALESCE($5::timestamptz, now()),'uploaded') RETURNING *`,
        [meetingId, body.title ?? null, originalName, audioKey, body.recorded_at ?? null],
      );
```

- [ ] **Step 7: 죽은 `MeetingsRepository.create`에도 같은 규칙을 넣는다**

이 메서드는 현재 호출되지 않지만, 그대로 두면 NOT NULL 아래에서 터지는 지뢰가 된다.

`be/src/meetings/meetings.repository.ts:28-31`:

```ts
      `INSERT INTO meeting(title, original_filename, audio_key, recorded_at, status)
       VALUES($1,$2,$3,COALESCE($4::timestamptz, now()),'uploaded') RETURNING *`,
```

- [ ] **Step 8: PATCH의 null 해제를 막는다**

`be/src/meetings/meetings.service.ts:137-156`의 주석과 `recorded_at` 분기를 바꾼다.

```ts
  // Manual validation (no global ValidationPipe): title must be string|null,
  // recorded_at must be an ISO-8601 datetime. null is rejected — the column is
  // NOT NULL since migration 021 and every meeting keeps a reference time.
  async update(id: string, body: { title?: unknown; recorded_at?: unknown }): Promise<MeetingRow> {
    const patch: { title?: string | null; recorded_at?: string } = {};
    if ('title' in body) {
      if (body.title !== null && typeof body.title !== 'string') {
        throw new BadRequestException('title must be a string or null');
      }
      patch.title = body.title as string | null;
    }
    if ('recorded_at' in body) {
      if (typeof body.recorded_at !== 'string' || !isIso8601(body.recorded_at)) {
        throw new BadRequestException(
          'recorded_at must be an ISO-8601 datetime (null is not accepted — every meeting has a reference time)',
        );
      }
      patch.recorded_at = body.recorded_at;
    }
```

`be/src/meetings/meetings.repository.ts:43-47`의 patch 타입에서도 `| null`을 뺀다.

```ts
  async update(
    exec: Queryable,
    id: string,
    patch: { title?: string | null; recorded_at?: string },
  ): Promise<MeetingRow | null> {
```

- [ ] **Step 9: 테스트를 돌려 통과를 확인한다**

Run: `pnpm be test`
Expected: PASS — 전체 스위트가 통과해야 한다. Task 1에서 시드 헬퍼를 미리 고쳤으므로 `lenses`·`saved-utterances`·`search` 스펙도 녹색이다.

- [ ] **Step 10: 커밋**

```bash
git add be/src/database/migrations/021_meeting_recorded_at_not_null.sql \
        be/src/meetings/meetings.service.ts be/src/meetings/meetings.repository.ts \
        be/test/migration.spec.ts be/test/meetings.e2e-spec.ts be/test/meetings-management.e2e-spec.ts
git commit -m "$(cat <<'EOF'
feat(be): 회의 기준일시를 NOT NULL로 승격한다

기존 NULL 행은 created_at으로 백필하고, 미지정 업로드는 INSERT의 COALESCE가
등록 시각으로 채운다. Postgres의 DEFAULT는 컬럼을 생략했을 때만 걸리므로
명시적 NULL을 넘기던 기존 코드로는 기본값이 잡히지 않는다.

PATCH의 recorded_at: null은 400이 된다 — 해제 수단을 남기면 NOT NULL이 뚫린다.

Claude-Session: https://claude.ai/code/session_01AGsQWhdXuStcCHWiied6bc
EOF
)"
```

---

### Task 3: 업로드의 recorded_at을 검증한다

지금은 업로드 경로에 검증이 아예 없어 잘못된 문자열이 `$::timestamptz` 캐스트까지 내려가 500이 된다. 빈 문자열도 같은 경로로 터진다 — multipart 필드는 비워도 `''`로 도착한다.

**Files:**
- Modify: `be/src/meetings/meetings.service.ts:47-75` (upload 검증 블록), 새 private 메서드 추가
- Modify: `be/src/meetings/meetings.controller.ts:30` (Swagger 설명)
- Test: `be/test/meetings.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 2의 `COALESCE` INSERT
- Produces: `MeetingsService.parseRecordedAt(s: string | undefined): string | undefined` — 빈 값은 `undefined`, 비 ISO 값은 `BadRequestException`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/test/meetings.e2e-spec.ts`의 Task 2에서 추가한 두 테스트 뒤에 넣는다.

```ts
  it('POST /meetings → 400 for a non-ISO recorded_at and stores nothing', async () => {
    const res = await request(srv())
      .post('/meetings')
      .field('recorded_at', 'not-a-date')
      .attach('audio', Buffer.from('fake-audio'), { filename: 'rec.m4a', contentType: 'audio/mp4' });
    expect(res.status).toBe(400);
    const rows = await db.pool.query('SELECT count(*)::int AS n FROM meeting');
    expect(rows.rows[0].n).toBe(0);
  });

  it('POST /meetings treats an empty recorded_at as unset', async () => {
    // multipart 필드는 비워도 ''로 도착한다 — 정규화하지 않으면 ''::timestamptz가 500이다.
    const res = await request(srv())
      .post('/meetings')
      .field('recorded_at', '')
      .attach('audio', Buffer.from('fake-audio'), { filename: 'rec.m4a', contentType: 'audio/mp4' });
    expect(res.status).toBe(201);
    expect(res.body.recorded_at).not.toBeNull();
  });
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run: `pnpm be test -- meetings.e2e-spec`
Expected: FAIL — 두 케이스 다 500.

- [ ] **Step 3: 검증을 구현한다**

`be/src/meetings/meetings.service.ts`의 upload 안, 검증 블록에 `recordedAt`을 추가한다 (`be/src/meetings/meetings.service.ts:57-75` 근처).

```ts
    let processing: ProcessingConfig;
    let followups: Followups;
    let speakers: SpeakerBounds | undefined;
    let recordedAt: string | undefined;
    try {
      recordedAt = this.parseRecordedAt(body.recorded_at);
      const override = this.parseOverrideString(body.processing); // JSON.parse + zod, 오류는 BadRequest
```

같은 파일의 `parseDeferFlag` 옆에 메서드를 추가한다.

```ts
  // 생략과 빈 문자열은 둘 다 "미지정"이다 — INSERT의 COALESCE가 등록 시각으로
  // 채운다. multipart 필드는 비워도 ''로 도착하므로 정규화하지 않으면
  // ''::timestamptz가 캐스트 에러(500)를 낸다.
  private parseRecordedAt(s: string | undefined): string | undefined {
    if (s === undefined || s === '') return undefined;
    if (!isIso8601(s)) throw new BadRequestException('recorded_at must be an ISO-8601 datetime');
    return s;
  }
```

INSERT의 파라미터를 검증된 값으로 바꾼다.

```ts
        [meetingId, body.title ?? null, originalName, audioKey, recordedAt ?? null],
```

- [ ] **Step 4: Swagger 설명을 고친다**

`be/src/meetings/meetings.controller.ts:30`:

```ts
        recorded_at: {
          type: 'string', format: 'date-time',
          description: '녹음 시각 ISO8601 (선택). 생략하면 업로드 시각으로 기록된다.',
        },
```

- [ ] **Step 5: 테스트를 돌려 통과를 확인한다**

Run: `pnpm be test -- meetings.e2e-spec meetings-management.e2e-spec`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add be/src/meetings/meetings.service.ts be/src/meetings/meetings.controller.ts be/test/meetings.e2e-spec.ts
git commit -m "$(cat <<'EOF'
fix(be): 업로드의 recorded_at을 검증한다

검증이 없어 잘못된 문자열이 timestamptz 캐스트까지 내려가 500이 됐다.
storage 저장 전에 ISO-8601을 확인해 400으로 막고, multipart가 빈 필드로
보내는 ''는 미지정으로 정규화한다.

Claude-Session: https://claude.ai/code/session_01AGsQWhdXuStcCHWiied6bc
EOF
)"
```

---

### Task 4: 워커에 meeting_timezone 설정을 추가한다

**Files:**
- Modify: `be/worker/damwha_worker/config.py`
- Test: `be/worker/tests/test_config.py`

**Interfaces:**
- Consumes: 없음
- Produces: `Settings.meeting_timezone: str` (기본값 `"Asia/Seoul"`, 환경변수 `MEETING_TIMEZONE`). 알 수 없는 IANA 존이면 `load_settings()`가 `pydantic.ValidationError`를 던진다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_config.py` 끝에 추가한다.

```python
def test_meeting_timezone_defaults_to_seoul():
    assert load_settings().meeting_timezone == "Asia/Seoul"


def test_unknown_meeting_timezone_fails_at_startup(monkeypatch):
    # 오타를 렌즈 job claim 이후에 터뜨리면 설정 오류가 job 실패로 분류돼 나타난다.
    monkeypatch.setenv("MEETING_TIMEZONE", "Asia/Seuol")
    with pytest.raises(pydantic.ValidationError):
        load_settings()
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run: `pnpm worker:test -- tests/test_config.py -k meeting_timezone`
Expected: FAIL with `AttributeError: 'Settings' object has no attribute 'meeting_timezone'`

- [ ] **Step 3: 설정과 검증기를 구현한다**

`be/worker/damwha_worker/config.py` 맨 위 import를 바꾼다.

```python
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
```

`default_speaker_prefix` 아래에 필드를 추가한다.

```python
    # 렌즈 프롬프트의 "Meeting date"를 렌더하는 존. recorded_at은 timestamptz라
    # 존을 고정하지 않으면 오전 이른 회의가 UTC로 전날이 되어 due_at이 하루씩 밀린다.
    meeting_timezone: str = "Asia/Seoul"
```

`_non_empty_prefix` 옆에 검증기를 추가한다.

```python
    @field_validator("meeting_timezone")
    @classmethod
    def _known_timezone(cls, v: str) -> str:
        # 기동 시점에 막는다. 폴백은 두지 않는다 — 잘못된 존으로 조용히 UTC를 쓰면
        # 하루 어긋난 due_at이 저장되고, 그건 기동 실패보다 훨씬 늦게 발견된다.
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"unknown IANA timezone {v!r}") from exc
        return v
```

- [ ] **Step 4: 테스트를 돌려 통과를 확인한다**

Run: `pnpm worker:test -- tests/test_config.py`
Expected: PASS

- [ ] **Step 5: `.env.example`에 키를 적는다**

`be/worker/.env.example`의 `DEFAULT_SPEAKER_PREFIX` 근처에 아래를 추가한다.

```
# 렌즈 프롬프트의 기준일을 렌더하는 IANA 타임존. 잘못된 값이면 워커가 뜨지 않는다.
MEETING_TIMEZONE=Asia/Seoul
```

- [ ] **Step 6: 커밋**

```bash
git add be/worker/damwha_worker/config.py be/worker/tests/test_config.py be/worker/.env.example
git commit -m "$(cat <<'EOF'
feat(worker): 회의 기준일을 렌더할 타임존 설정을 추가한다

recorded_at은 timestamptz고 Postgres는 UTC, 호스트는 KST다. 존을 고정하지
않으면 오전 이른 회의가 전날로 렌더돼 due_at이 하루씩 밀린다. 알 수 없는
존은 기동 시점에 ValidationError로 막는다 — 폴백을 두면 어긋난 날짜가
조용히 저장된다.

Claude-Session: https://claude.ai/code/session_01AGsQWhdXuStcCHWiied6bc
EOF
)"
```

---

### Task 5: due_at 파싱을 항목 단위로 관대화한다

job_3을 죽인 직접 원인이다. 이 작업만으로 실패한 추출이 되살아난다.

**Files:**
- Modify: `be/worker/damwha_worker/lens_client.py:1-6` (import), `:53-63` (`_LlmLensItem`)
- Test: `be/worker/tests/test_lens_client.py`

**Interfaces:**
- Consumes: 없음
- Produces: `_LlmLensItem.due_at`이 파싱 불가 문자열을 `None`으로 흡수한다. `LensClient.extract`의 반환 타입(`list[LensCandidate]`)은 그대로다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_lens_client.py` 맨 위 import에 `from datetime import date`를 추가하고, 파일 끝에 테스트를 넣는다.

```python
def test_client_drops_an_unparseable_due_at_but_keeps_the_item(httpx_mock):
    # 모델은 "오늘"·"22 일" 같은 상대 표현을 그대로 낸다. 예전에는 pydantic 검증이
    # all-or-nothing이라 날짜 하나가 추출 run 전체를 llm_invalid_response로 죽였다
    # (mtg_1의 job_3: 날짜 6개가 항목 10건을 날렸다).
    httpx_mock.add_response(
        json={
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "items": [
                                    {
                                        "kind": "action",
                                        "text": "보고서 보내기",
                                        "due_at": "오늘",
                                        "primary_index": 1,
                                        "supporting_indexes": [],
                                    },
                                    {
                                        "kind": "action",
                                        "text": "회의록 정리",
                                        "due_at": "2026-09-22",
                                        "primary_index": 1,
                                        "supporting_indexes": [],
                                    },
                                ]
                            }
                        )
                    }
                }
            ]
        }
    )

    items = LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
        model="job-model", utterances=[{"id": "utt_1", "text": "오늘까지 보내주세요."}]
    )

    assert [i.due_at for i in items] == [None, date(2026, 9, 22)]
    assert [i.text for i in items] == ["보고서 보내기", "회의록 정리"]
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run: `pnpm worker:test -- tests/test_lens_client.py -k unparseable_due_at`
Expected: FAIL — `WorkerError`(`llm_invalid_response`)가 던져진다.

- [ ] **Step 3: BeforeValidator를 구현한다**

`be/worker/damwha_worker/lens_client.py`의 import를 바꾼다.

```python
from typing import Annotated, Any, Literal

import httpx
from pydantic import BaseModel, BeforeValidator, ConfigDict, ValidationError
```

`_SPEAKER_KEYS` 아래, `_LlmLensItem` 위에 함수를 넣는다.

```python
def _due_at_or_none(v: Any) -> Any:
    """파싱되지 않는 마감일은 그 항목만 마감일 없음으로 떨군다.

    모델은 "오늘"·"목요일"·"22 일" 같은 상대 표현을 그대로 낸다. 예전에는 이 한
    필드가 _LlmLensResponse 전체 검증을 깨서 추출 run이 통째로
    llm_invalid_response(PERMANENT)로 죽었다.

    관대화는 due_at에만 준다. kind·text·primary_index가 틀린 항목은 애초에 의미가
    없고, 인덱스 조작은 없는 발화를 근거로 지목하는 문제라 조용히 넘기면 안 된다.
    """
    if v is None or isinstance(v, date):
        return v
    if isinstance(v, str):
        try:
            return date.fromisoformat(v.strip())
        except ValueError:
            return None
    return None
```

`_LlmLensItem`의 필드를 바꾼다.

```python
    due_at: Annotated[date | None, BeforeValidator(_due_at_or_none)] = None
```

- [ ] **Step 4: 테스트를 돌려 통과를 확인한다**

Run: `pnpm worker:test -- tests/test_lens_client.py`
Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 5: 커밋**

```bash
git add be/worker/damwha_worker/lens_client.py be/worker/tests/test_lens_client.py
git commit -m "$(cat <<'EOF'
fix(worker): 파싱 안 되는 due_at이 추출 전체를 떨구지 않게 한다

모델이 "오늘"·"22 일" 같은 상대 표현을 due_at에 그대로 넣으면 pydantic
검증이 all-or-nothing이라 추출 run이 통째로 죽었다 — mtg_1에서 날짜 6개가
항목 10건을 날렸다. BeforeValidator로 그 항목만 마감일 없음으로 떨군다.

관대화는 due_at에만 준다. 인덱스 조작은 없는 발화를 근거로 지목하는
문제라 조용히 넘기면 안 된다.

Claude-Session: https://claude.ai/code/session_01AGsQWhdXuStcCHWiied6bc
EOF
)"
```

---

### Task 6: 렌즈 프롬프트에 기준일과 due_at 포맷 규칙을 싣는다

**Files:**
- Modify: `be/worker/damwha_worker/lens_client.py:16-28` (`_EXTRACTION_SYSTEM_PROMPT`), `:119-125` (`_render_prompt`), `LensClient.extract` 시그니처
- Test: `be/worker/tests/test_lens_client.py:80-124` (기존 계약 테스트 갱신), 새 테스트 2개

**Interfaces:**
- Consumes: 없음
- Produces: `LensClient.extract(*, model: str, utterances: list[dict], meeting_date: date | None = None) -> list[LensCandidate]`. `meeting_date`가 있으면 user 메시지가 `Meeting date: YYYY-MM-DD\n\n`로 시작한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_lens_client.py` 끝에 추가한다.

```python
def test_client_puts_the_meeting_date_at_the_top_of_the_prompt(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": '{"items": []}'}}]})
    utterances = [
        {"id": "utt_1", "speaker_id": "spk_1", "speaker_name": "Ada", "text": "오늘까지 보낼게요."}
    ]

    LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
        model="job-model", utterances=utterances, meeting_date=date(2026, 9, 2)
    )

    user = json.loads(httpx_mock.get_request().content)["messages"][1]["content"]
    assert user == "Meeting date: 2026-09-02\n\nSpeakers:\nspk_1 Ada\n\n1 Ada: 오늘까지 보낼게요."


def test_client_omits_the_meeting_date_line_when_it_is_unknown(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": '{"items": []}'}}]})

    LensClient("http://localhost:11434/v1", None, 12.0, 8192).extract(
        model="job-model", utterances=[{"id": "utt_1", "text": "hi"}]
    )

    user = json.loads(httpx_mock.get_request().content)["messages"][1]["content"]
    assert "Meeting date" not in user
```

- [ ] **Step 2: 기존 계약 테스트의 시스템 프롬프트 기대값을 갱신한다**

`be/worker/tests/test_lens_client.py:80`의 `test_client_sends_the_lens_extraction_contract_prompt_and_utterances` 안, system 메시지의 `content`를 아래로 바꾼다. 이 테스트는 프롬프트 전문을 그대로 비교하므로 Step 3의 문구와 **글자까지 같아야** 한다.

```python
            "content": (
                "You are given a meeting transcript. The Speakers section lists one speaker per "
                "line as `<speaker_id> <name>`. After it, each transcript line is one utterance, "
                "formatted as `<index> <speaker name>: <text>`, in chronological order. "
                "Return a JSON object with only an items array. Each item must be an action, "
                "decision, or promise and have exactly these fields: kind, text, "
                "assignee_speaker_id (nullable), due_at (nullable), primary_index, "
                "supporting_indexes. Choose the exact primary utterance. primary_index and "
                "every supporting index must be index values from the transcript, and "
                "assignee_speaker_id must be a speaker_id from the Speakers section (not a "
                "name) or null. Write due_at as a YYYY-MM-DD calendar date. When an utterance "
                "states a relative deadline (\"today\", \"next Thursday\"), resolve it against "
                "the Meeting date line at the top of the transcript; if it cannot be resolved, "
                "use null. Do not "
                "speculate or return duplicates. Write text in the language of the transcript."
            ),
```

- [ ] **Step 3: 테스트를 돌려 실패를 확인한다**

Run: `pnpm worker:test -- tests/test_lens_client.py`
Expected: FAIL — `meeting_date` 인자를 받지 못한다는 `TypeError`, 그리고 시스템 프롬프트 불일치.

- [ ] **Step 4: 시스템 프롬프트를 고친다**

`be/worker/damwha_worker/lens_client.py:16-28`의 `_EXTRACTION_SYSTEM_PROMPT`를 아래로 바꾼다.

```python
_EXTRACTION_SYSTEM_PROMPT = (
    "You are given a meeting transcript. The Speakers section lists one speaker per "
    "line as `<speaker_id> <name>`. After it, each transcript line is one utterance, "
    "formatted as `<index> <speaker name>: <text>`, in chronological order. "
    "Return a JSON object with only an items array. Each item must be an action, "
    "decision, or promise and have exactly these fields: kind, text, "
    "assignee_speaker_id (nullable), due_at (nullable), primary_index, "
    "supporting_indexes. Choose the exact primary utterance. primary_index and "
    "every supporting index must be index values from the transcript, and "
    "assignee_speaker_id must be a speaker_id from the Speakers section (not a "
    "name) or null. Write due_at as a YYYY-MM-DD calendar date. When an utterance "
    "states a relative deadline (\"today\", \"next Thursday\"), resolve it against "
    "the Meeting date line at the top of the transcript; if it cannot be resolved, "
    "use null. Do not "
    "speculate or return duplicates. Write text in the language of the transcript."
)
```

- [ ] **Step 5: 프롬프트 렌더러와 extract 시그니처를 고친다**

`be/worker/damwha_worker/lens_client.py`의 `_render_prompt`를 바꾼다.

```python
def _render_prompt(utterances: list[dict[str, Any]], meeting_date: date | None) -> str:
    transcript = _render_transcript(utterances)
    speakers = _render_speakers(utterances)
    body = f"Speakers:\n{speakers}\n\n{transcript}" if speakers else transcript
    if meeting_date is None:
        return body
    # 존 이름은 싣지 않는다 — 날짜는 이미 meeting_timezone으로 환산돼서 온다.
    return f"Meeting date: {meeting_date.isoformat()}\n\n{body}"
```

`LensClient.extract`의 시그니처와 호출부를 바꾼다.

```python
    def extract(
        self,
        *,
        model: str,
        utterances: list[dict[str, Any]],
        meeting_date: date | None = None,
    ) -> list[LensCandidate]:
```

같은 메서드 안의 user 메시지를 바꾼다.

```python
                {"role": "user", "content": _render_prompt(utterances, meeting_date)},
```

- [ ] **Step 6: 테스트를 돌려 통과를 확인한다**

Run: `pnpm worker:test -- tests/test_lens_client.py`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add be/worker/damwha_worker/lens_client.py be/worker/tests/test_lens_client.py
git commit -m "$(cat <<'EOF'
feat(worker): 렌즈 프롬프트에 회의 기준일을 싣는다

프롬프트가 due_at을 nullable이라고만 하고 포맷도 기준일도 주지 않아,
모델에게 "오늘"을 날짜로 바꿀 근거 자체가 없었다. 기준일을 맨 앞 줄에
싣고 YYYY-MM-DD 환산 규칙을 명시한다.

존 이름은 프롬프트에 넣지 않는다 — 날짜는 이미 환산돼서 오므로 모델이
쓸 곳이 없다.

Claude-Session: https://claude.ai/code/session_01AGsQWhdXuStcCHWiied6bc
EOF
)"
```

---

### Task 7: 추출 파이프라인이 meeting.recorded_at을 읽어 넘긴다

**Files:**
- Modify: `be/worker/damwha_worker/pipeline/extract_lenses.py`
- Modify: `be/worker/damwha_worker/__main__.py:68-86` (`handle_job` 시그니처), `:132-137` (extract_lenses 분기), `:201-237` (`run_once`), `:240-279` (`dispatch_claimed_job`)
- Test: `be/worker/tests/test_extract_lenses.py`

**Interfaces:**
- Consumes: Task 4의 `Settings.meeting_timezone`, Task 6의 `LensClient.extract(..., meeting_date=)`
- Produces: `run_extract_lenses(conn, job, payload, client, *, worker_id, shutdown_event=None, meeting_timezone: str = "Asia/Seoul")`. `handle_job`·`run_once`도 같은 이름의 kwarg를 같은 기본값으로 받는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_extract_lenses.py` 맨 위 import에 `from datetime import date`를 추가하고, 파일 끝에 테스트를 넣는다.

```python
def test_extract_passes_the_meeting_date_in_the_configured_timezone(conn, extraction_job):
    job, ids = extraction_job
    conn.execute(
        "UPDATE meeting SET recorded_at='2026-09-02T23:30:00+00:00' WHERE id=%s",
        (ids["meeting_id"],),
    )
    seen: dict = {}

    def _extract(**kwargs):
        seen.update(kwargs)
        return []

    run_extract_lenses(
        conn,
        job,
        _payload(job),
        SimpleNamespace(extract=_extract),
        worker_id="w",
        meeting_timezone="Asia/Seoul",
    )

    # 23:30 UTC == 다음날 08:30 KST. 존을 고정하지 않으면 하루 어긋난다.
    assert seen["meeting_date"] == date(2026, 9, 3)
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run: `pnpm worker:test -- tests/test_extract_lenses.py -k meeting_date`
Expected: FAIL — `run_extract_lenses()`가 `meeting_timezone` kwarg를 모른다는 `TypeError`.

- [ ] **Step 3: 파이프라인을 고친다**

`be/worker/damwha_worker/pipeline/extract_lenses.py`의 import와 시그니처를 바꾼다.

```python
import threading
from zoneinfo import ZoneInfo

from .. import db
from ..contracts import ExtractLensesPayload
from .stage import enter_stage
from .timing import timed_stage


def run_extract_lenses(
    conn,
    job: dict,
    payload: ExtractLensesPayload,
    client,
    *,
    worker_id: str,
    shutdown_event: threading.Event | None = None,
    meeting_timezone: str = "Asia/Seoul",
) -> str:
```

발화를 읽는 `rows = conn.execute(...)` 바로 뒤에 기준일 조회를 넣는다.

```python
    # payload가 아니라 DB에서 읽는다 — recorded_at은 enqueue 시점의 결정이 아니라
    # 사실이고, 사용자가 PATCH로 고친 뒤 재추출하면 고친 값이 반영돼야 한다.
    # 021 이후 NOT NULL이라 None 분기가 없다.
    recorded_at = conn.execute(
        "SELECT recorded_at FROM meeting WHERE id=%s", (payload.meeting_id,)
    ).fetchone()["recorded_at"]
    meeting_date = recorded_at.astimezone(ZoneInfo(meeting_timezone)).date()
```

`client.extract` 호출에 인자를 더한다.

```python
        candidates = client.extract(
            model=payload.model,
            utterances=[dict(row) for row in rows],
            meeting_date=meeting_date,
        )
```

- [ ] **Step 4: 디스패치 경로에 설정을 흘린다**

`be/worker/damwha_worker/__main__.py`의 `handle_job` 시그니처에 kwarg를 추가한다 (`summary_llm_model=None` 다음 줄).

```python
    summary_llm_model=None,
    meeting_timezone="Asia/Seoul",
    llm_server=None,
```

`extract_lenses` 분기의 호출을 바꾼다.

```python
        if job["type"] == "extract_lenses":
            with llm_server(payload.model) as proc, _llm_abort_hook(register_abort, proc):
                client = build_lens_client()
                return run_extract_lenses(
                    conn,
                    job,
                    payload,
                    client,
                    worker_id=worker_id,
                    shutdown_event=shutdown_event,
                    meeting_timezone=meeting_timezone,
                )
```

`run_once`에도 같은 kwarg를 추가하고(`summary_llm_model=None` 다음), `handle_job` 호출에 전달한다.

```python
    summary_llm_model=None,
    meeting_timezone="Asia/Seoul",
```

```python
        summary_llm_model=summary_llm_model,
        meeting_timezone=meeting_timezone,
```

`dispatch_claimed_job`의 `handle_job` 호출에 설정값을 넘긴다 (`summary_llm_model=settings.summary_llm_model,` 다음 줄).

```python
            meeting_timezone=settings.meeting_timezone,
```

- [ ] **Step 5: 테스트를 돌려 통과를 확인한다**

Run: `pnpm worker:test`
Expected: PASS — 워커 스위트 전체가 통과해야 한다.

- [ ] **Step 6: 커밋**

```bash
git add be/worker/damwha_worker/pipeline/extract_lenses.py be/worker/damwha_worker/__main__.py be/worker/tests/test_extract_lenses.py
git commit -m "$(cat <<'EOF'
feat(worker): 추출이 회의 기준일을 DB에서 읽어 프롬프트에 넘긴다

payload는 그대로 둔다 — recorded_at은 enqueue 시점의 결정이 아니라 사실이고,
schema_version을 올리면 zod/pydantic 계약과 픽스처를 모두 손대야 한다.
DB에서 읽으면 사용자가 날짜를 고친 뒤 재추출할 때 고친 값이 반영된다.

Claude-Session: https://claude.ai/code/session_01AGsQWhdXuStcCHWiied6bc
EOF
)"
```

---

### Task 8: 업로드 폼에 기본값 안내를 넣는다

**Files:**
- Modify: `fe/src/features/meeting/ui/upload-dialog.tsx:243-266`
- Test: `fe/src/features/meeting/ui/upload-dialog.test.tsx`

**Interfaces:**
- Consumes: 없음
- Produces: 없음 (표시 전용)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`fe/src/features/meeting/ui/upload-dialog.test.tsx` 끝에 추가한다. 이 파일은 `describe` 없이 최상위 `test(...)`를 쓰고, 다이얼로그는 `renderWithFile()` 헬퍼로 띄운다.

```tsx
test("녹음 일시를 비웠을 때 어떻게 되는지 알려준다", () => {
  renderWithFile();
  expect(
    screen.getByText("비우면 업로드 시각으로 기록됩니다."),
  ).toBeInTheDocument();
});
```

`screen`이 아직 import돼 있지 않으면 파일 상단의 `@testing-library/react` import에 추가한다.

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run: `pnpm fe test -- upload-dialog`
Expected: FAIL — 해당 문구를 찾지 못한다.

- [ ] **Step 3: 안내 문구를 넣는다**

`fe/src/features/meeting/ui/upload-dialog.tsx`의 녹음 일시 `<div role="group">`가 닫힌 직후, 감싸는 `</div>` 앞에 넣는다.

```tsx
            <p className="text-sm text-[color:var(--text-muted)]">
              비우면 업로드 시각으로 기록됩니다.
            </p>
```

- [ ] **Step 4: 테스트를 돌려 통과를 확인한다**

Run: `pnpm fe test -- upload-dialog`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add fe/src/features/meeting/ui/upload-dialog.tsx fe/src/features/meeting/ui/upload-dialog.test.tsx
git commit -m "$(cat <<'EOF'
feat(fe): 녹음 일시를 비웠을 때의 기본값을 안내한다

Claude-Session: https://claude.ai/code/session_01AGsQWhdXuStcCHWiied6bc
EOF
)"
```

---

### Task 9: 전체 검증과 데모 브랜치 반영

**Files:**
- 변경 없음 (검증과 병합만)

**Interfaces:**
- Consumes: Task 1-8 전부
- Produces: `dev`에 병합된 기능, 데모 브랜치에 반영된 상태

- [ ] **Step 1: 전체 스위트를 돌린다**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: PASS. 실패하면 여기서 멈추고 고친다 — 아래 스텝은 전부 녹색을 전제한다.

- [ ] **Step 2: PR을 연다**

```bash
git push -u origin feat/meeting-recorded-at
gh pr create --base dev --title "회의 기준일시(recorded_at)를 필수화한다" --body "$(cat <<'EOF'
## 무엇을

`meeting.recorded_at`을 NOT NULL 기준일시로 승격하고, 그 날짜를 렌즈 추출
프롬프트에 실어 LLM이 "오늘"·"다음 주 목요일" 같은 상대 표현을 절대 날짜로
환산하게 한다.

## 왜

데모 시드 회의(mtg_1)의 extract_lenses job이 llm_invalid_response로 죽었다.
모델이 due_at에 "오늘"·"22 일"·"목요일"을 그대로 넣었고, pydantic 검증이
all-or-nothing이라 날짜 6개가 추출 10건 전체를 날렸다.

## 깨는 변경

`PATCH /meetings/:id`의 `recorded_at: null`이 400이 된다. 모든 회의가 기준일시를
가지므로 해제 수단을 남기면 NOT NULL이 뚫린다.

## 설계

`be/docs/superpowers/specs/2026-09-02-meeting-recorded-at-design.md`

https://claude.ai/code/session_01AGsQWhdXuStcCHWiied6bc
EOF
)"
```

- [ ] **Step 3: PR 병합 후 dev를 받는다**

```bash
git switch dev && git pull --ff-only origin dev
```

- [ ] **Step 4: 데모 브랜치에 반영한다**

```bash
git switch feat/public-demo-deployment
git merge dev
```

충돌이 나면 데모 브랜치 쪽 커밋과의 충돌 지점을 확인하고 해결한다. 데모 브랜치는 `dev`보다 8커밋 앞서 있으므로 머지 커밋이 생긴다.

- [ ] **Step 5: 데모 DB에 마이그레이션을 적용하고 실패한 job을 되살린다**

```bash
pnpm be migrate
docker exec damwha-postgres psql -U postgres -d damwha -c \
  "UPDATE job SET status='queued', locked_by=NULL, locked_at=NULL, next_attempt_at=NULL, attempts=0, progress=0, error=NULL WHERE id='job_3';"
docker exec damwha-postgres psql -U postgres -d damwha -c \
  "UPDATE lens_extraction_run SET status='queued', error=NULL WHERE job_id='job_3';"
```

- [ ] **Step 6: 재추출이 통과하는지 확인한다**

워커가 도는 상태에서 job_3이 `done`이 될 때까지 기다린 뒤 확인한다.

```bash
docker exec damwha-postgres psql -U postgres -d damwha -c \
  "SELECT id, status, progress, left(coalesce(error::text,''),120) FROM job WHERE id='job_3';"
docker exec damwha-postgres psql -U postgres -d damwha -c \
  "SELECT count(*) FILTER (WHERE due_at IS NOT NULL) AS with_due, count(*) AS total FROM lens_item;"
```

Expected: job_3이 `done`, `lens_item`에 행이 있고 일부는 `due_at`이 채워져 있다.
