# 회의 즐겨찾기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 회의를 별표(즐겨찾기)로 표시/해제하는 멱등 API를 추가하고, 즐겨찾기 상태를 기존 목록·단건 응답에 노출한다.

**Architecture:** `meeting` 테이블에 `is_favorite boolean` 컬럼 1개를 추가한다. 기존 `SELECT *` 조회 경로가 목록·단건 응답에 컬럼을 자동 포함하므로 별도 노출 코드가 없다. 설정/해제는 멱등 `PUT`/`DELETE /meetings/:id/favorite`로, 기존 repository/service/controller 3분할을 그대로 따른다. 백엔드 필터/정렬은 제공하지 않는다(프론트 위임).

**Tech Stack:** NestJS (TypeScript), 원시 SQL(`pg.Pool`, ORM 없음), Postgres, Jest + supertest + Testcontainers.

**관련 문서:** 스펙 `docs/superpowers/specs/2026-06-27-meeting-favorite-design.md`.

## Global Constraints

- Node **22** 필수. npm/node 명령 전 `nvm use` 먼저.
- **ORM 없음** — 모든 DB 접근은 `*.repository.ts`의 원시 SQL(`Queryable` 인자로 `pool` 또는 트랜잭션 클라이언트 주입).
- 마이그레이션은 `src/database/migrations/`의 번호순 SQL 파일. **적용된 파일(`001`,`002`)은 수정 금지**, 새 번호(`003`) 추가만.
- 컬럼/응답 필드는 기존 **snake_case** 관례(`original_filename`, `processing_version`)를 따른다 → `is_favorite`.
- 도메인별 **repository(SQL) / service(오케스트레이션) / controller(HTTP)** 분할 유지.
- 테스트는 **Docker 필요**(Testcontainers가 `damwha/postgres-bigm:pg16` 컨테이너 기동). `npm test`는 `--runInBand` 직렬 실행.
- ML/클라우드 호출을 `src/`에 추가하지 않는다(이 기능과 무관하지만 불변식 유지).

---

### Task 1: 회의 즐겨찾기 (마이그레이션 + 멱등 API + e2e)

단일 deliverable("회의를 즐겨찾기한다")이라 한 태스크로 묶는다. 마이그레이션은 이 기능의 스키마 스캐폴딩이므로 같은 태스크에 포함한다.

**Files:**
- Create: `src/database/migrations/003_meeting_favorite.sql`
- Modify: `src/meetings/meetings.repository.ts` (`MeetingRow` 인터페이스 + `setFavorite` 메서드)
- Modify: `src/meetings/meetings.service.ts` (`setFavorite` 메서드)
- Modify: `src/meetings/meetings.controller.ts` (`PUT`/`DELETE` 라우트 + import)
- Test: `test/meetings.e2e-spec.ts` (즐겨찾기 케이스 추가)

**Interfaces:**
- Produces:
  - `MeetingsRepository.setFavorite(exec: Queryable, id: string, value: boolean): Promise<MeetingRow | null>` — 갱신된 행, 미존재 시 `null`.
  - `MeetingsService.setFavorite(id: string, value: boolean): Promise<MeetingRow>` — 미존재 시 `NotFoundException`.
  - HTTP `PUT /meetings/:id/favorite` (→ `is_favorite=true`), `DELETE /meetings/:id/favorite` (→ `is_favorite=false`). 둘 다 `200` + 갱신된 meeting 행.
- Consumes: 기존 `MeetingRow`, `DatabaseService.pool`, `Queryable` 타입(`src/jobs/jobs.types.ts`).

---

- [ ] **Step 1: 마이그레이션 파일 생성**

`src/database/migrations/003_meeting_favorite.sql`:

```sql
ALTER TABLE meeting ADD COLUMN is_favorite boolean NOT NULL DEFAULT false;
```

- [ ] **Step 2: 실패하는 e2e 테스트 작성**

`test/meetings.e2e-spec.ts`의 마지막 `it(...)` 뒤, 닫는 `});` (describe 종료) 바로 앞에 아래 4개 테스트를 추가한다:

```ts
  it('PUT /meetings/:id/favorite sets is_favorite, reflected in get + list', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    expect(created.body.is_favorite).toBe(false); // 기본값 false

    const put = await request(srv()).put(`/meetings/${mid}/favorite`);
    expect(put.status).toBe(200);
    expect(put.body.is_favorite).toBe(true);

    expect((await request(srv()).get(`/meetings/${mid}`)).body.is_favorite).toBe(true);
    const list = await request(srv()).get('/meetings');
    expect(list.body.find((m: any) => m.id === mid).is_favorite).toBe(true);
  });

  it('DELETE /meetings/:id/favorite clears is_favorite', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    await request(srv()).put(`/meetings/${mid}/favorite`);
    const del = await request(srv()).delete(`/meetings/${mid}/favorite`);
    expect(del.status).toBe(200);
    expect(del.body.is_favorite).toBe(false);
    expect((await request(srv()).get(`/meetings/${mid}`)).body.is_favorite).toBe(false);
  });

  it('favorite PUT/DELETE are idempotent', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    expect((await request(srv()).put(`/meetings/${mid}/favorite`)).body.is_favorite).toBe(true);
    expect((await request(srv()).put(`/meetings/${mid}/favorite`)).body.is_favorite).toBe(true); // PUT 2회
    expect((await request(srv()).delete(`/meetings/${mid}/favorite`)).body.is_favorite).toBe(false);
    expect((await request(srv()).delete(`/meetings/${mid}/favorite`)).body.is_favorite).toBe(false); // 미설정 DELETE
  });

  it('favorite PUT/DELETE → 404 for unknown meeting', async () => {
    const unknown = '99999999-9999-9999-9999-999999999999';
    expect((await request(srv()).put(`/meetings/${unknown}/favorite`)).status).toBe(404);
    expect((await request(srv()).delete(`/meetings/${unknown}/favorite`)).status).toBe(404);
  });
```

- [ ] **Step 3: 테스트 실행 → 실패 확인**

```bash
nvm use
npx jest test/meetings.e2e-spec.ts -t "favorite"
```

Expected: FAIL. PUT/DELETE 라우트가 없어 `put`/`del`이 `404`를 반환 → `expect(put.status).toBe(200)` 등에서 실패. (`created.body.is_favorite`는 마이그레이션 적용으로 이미 `false`라 통과하지만, PUT 단언에서 실패.)

- [ ] **Step 4: repository — `MeetingRow` 필드 + `setFavorite` 추가**

`src/meetings/meetings.repository.ts`의 `MeetingRow` 인터페이스에서 `status: string;` 뒤에 `is_favorite: boolean;`을 추가한다. 결과:

```ts
export interface MeetingRow {
  id: string; title: string | null; original_filename: string | null;
  audio_key: string; normalized_key: string | null; recorded_at: Date | null;
  duration_ms: number | null; status: string; is_favorite: boolean; current_job_id: string | null;
  processing_version: number; error: any; created_at: Date;
}
```

이어서 `MeetingsRepository` 클래스 안(예: `setCurrentJob` 메서드 뒤)에 메서드를 추가한다:

```ts
  async setFavorite(exec: Queryable, id: string, value: boolean): Promise<MeetingRow | null> {
    const { rows } = await exec.query<MeetingRow>(
      `UPDATE meeting SET is_favorite=$2 WHERE id=$1 RETURNING *`,
      [id, value],
    );
    return rows[0] ?? null;
  }
```

- [ ] **Step 5: service — `setFavorite` 추가**

`src/meetings/meetings.service.ts`의 `MeetingsService` 클래스 안(예: `get` 메서드 뒤)에 추가한다. `NotFoundException`은 이미 import되어 있다. 단일 `UPDATE`라 트랜잭션 없이 `this.db.pool`을 직접 쓴다(기존 `list`/`get`과 동일):

```ts
  async setFavorite(id: string, value: boolean): Promise<MeetingRow> {
    const updated = await this.meetings.setFavorite(this.db.pool, id, value);
    if (!updated) throw new NotFoundException('meeting not found');
    return updated;
  }
```

반환 타입 `MeetingRow`를 쓰므로 파일 상단 import에 추가한다. 기존 import 라인:

```ts
import { MeetingsRepository } from './meetings.repository';
```

을 다음으로 바꾼다:

```ts
import { MeetingsRepository, MeetingRow } from './meetings.repository';
```

- [ ] **Step 6: controller — `PUT`/`DELETE` 라우트 추가**

`src/meetings/meetings.controller.ts` 상단 `@nestjs/common` import에 `Delete`, `Put`을 추가한다. 기존:

```ts
import {
  Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
```

를 다음으로 바꾼다:

```ts
import {
  Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
```

그리고 `reprocess` 메서드 뒤(클래스 안, `audio` 핸들러 앞 아무 곳)에 두 라우트를 추가한다. PUT/DELETE는 NestJS 기본 상태코드가 200이라 `@HttpCode`가 불필요하다:

```ts
  @Put(':id/favorite')
  @ApiOperation({ summary: '즐겨찾기 설정' })
  favorite(@Param('id', ParseUUIDPipe) id: string) { return this.service.setFavorite(id, true); }

  @Delete(':id/favorite')
  @ApiOperation({ summary: '즐겨찾기 해제' })
  unfavorite(@Param('id', ParseUUIDPipe) id: string) { return this.service.setFavorite(id, false); }
```

- [ ] **Step 7: 즐겨찾기 테스트 실행 → 통과 확인**

```bash
npx jest test/meetings.e2e-spec.ts -t "favorite"
```

Expected: PASS (4개 테스트 모두 통과).

- [ ] **Step 8: 회귀 확인 — 전체 meetings 스위트 + 타입체크**

```bash
npx jest test/meetings.e2e-spec.ts
npx tsc --noEmit -p tsconfig.build.json
```

Expected: meetings 스위트 전부 PASS(기존 테스트는 `is_favorite` 추가에 영향 없음 — 특정 필드만 단언), 타입 에러 없음.

- [ ] **Step 9: 커밋**

```bash
git add src/database/migrations/003_meeting_favorite.sql src/meetings/meetings.repository.ts src/meetings/meetings.service.ts src/meetings/meetings.controller.ts test/meetings.e2e-spec.ts
git commit -m "feat(api): meeting favorite (idempotent PUT/DELETE) + is_favorite field"
```
