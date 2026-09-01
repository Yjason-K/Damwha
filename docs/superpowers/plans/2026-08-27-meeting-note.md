# 회의 메모 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 인사이트 패널의 빈 `메모` 탭을 회의당 마크다운 1장의 편집·자동저장·표시 기능으로 채운다.

**Architecture:** Postgres `meeting_note` 테이블(회의당 UNIQUE 1행) + NestJS `notes` 모듈이 `GET`/`PUT /meetings/:id/note` 두 엔드포인트를 제공한다. 프론트는 별도 쿼리 키(`["meeting-note", id]`)로 읽고, 800ms debounce 자동저장으로 쓴다. 편집기는 `<textarea>` + 툴바이며 툴바 로직은 DOM을 모르는 순수 함수로 분리한다. 렌더링은 `react-markdown`이고 raw HTML은 통과시키지 않는다.

**Tech Stack:** NestJS 10 / raw SQL (`pg`) / jest + supertest + testcontainers · React 19 / TanStack Query 5 / Vite 8 / Tailwind 4 / vitest + Testing Library · 신규 의존성 `react-markdown`, `remark-gfm`

**Spec:** `docs/superpowers/specs/2026-08-27-meeting-note-design.md`

## Global Constraints

- **루트에서 패키지를 실행하지 않는다.** `pnpm be <script>` / `pnpm fe <script>`만 쓴다 (cwd가 틀어지면 `STORAGE_ROOT`가 빈 디렉터리를 가리킨다).
- **`be/`에서 `npm install` 금지.** 의존성 추가는 `pnpm --filter damwha-fe add <pkg>`.
- **ORM 없음.** 모든 DB 접근은 `DatabaseService`(`pg.Pool` 래퍼)를 통한 raw SQL.
- **BE 도메인 분할:** `*.repository.ts`(SQL) / `*.service.ts`(검증·트랜잭션) / `*.controller.ts`(HTTP).
- **TypeScript strict + `verbatimModuleSyntax`** — 타입 전용 import는 반드시 `import type { ... }`.
- **Prettier:** 큰따옴표, 세미콜론, trailing comma `all`, printWidth 80. FE 작업 후 `pnpm fe format`.
- **UI 문구·커밋 메시지·문서는 한국어.**
- **raw hex 금지.** 색은 `--surface-*` / `--text-*` / `--border-*` semantic 토큰만 사용 (`fe/DESIGN.md`).
- **레일 폭은 픽셀 직접 사용 금지** — `w-[var(--rail-insight)]`처럼 변수 참조.
- **`meeting_note`에 `processing_version`을 두지 않는다.** 어떤 쿼리도 버전으로 필터하지 않는다.
- **`rehype-raw`를 추가하지 않는다.** `dangerouslySetInnerHTML`도 쓰지 않는다.
- 본문 길이 상한 **100000자**. debounce **800ms**.

---

## File Structure

**생성**

| 파일 | 책임 |
| --- | --- |
| `be/src/database/migrations/020_meeting_note.sql` | 테이블 |
| `be/src/notes/notes.repository.ts` | SQL 3개 (조회/업서트/삭제) |
| `be/src/notes/notes.service.ts` | 입력 검증, 공백→삭제 판정 |
| `be/src/notes/notes.controller.ts` | 라우트 2개 |
| `be/src/notes/notes.module.ts` | DI 묶음 |
| `be/test/notes.e2e-spec.ts` | 엔드포인트 e2e |
| `fe/src/features/meeting/lib/md-commands.ts` | 툴바 텍스트 변환 순수 함수 |
| `fe/src/features/meeting/lib/md-commands.test.ts` | 위 단위 테스트 |
| `fe/src/features/meeting/api/notes.ts` | 쿼리·뮤테이션·자동저장 훅 |
| `fe/src/features/meeting/api/notes.test.tsx` | 훅 테스트 |
| `fe/src/features/meeting/ui/markdown.tsx` | `react-markdown` + 토큰 매핑 렌더러 |
| `fe/src/features/meeting/ui/note-pane.tsx` | 읽기/편집 2모드 패널 |
| `fe/src/features/meeting/ui/note-pane.test.tsx` | 패널 테스트 |

**수정**

| 파일 | 변경 |
| --- | --- |
| `be/src/app.module.ts` | `NotesModule` 등록 |
| `fe/src/features/meeting/ui/icons.tsx` | 툴바 아이콘 path 7개 추가 |
| `fe/src/features/meeting/ui/insight-pane.tsx:535-549` | `Notes()` 제거 → `<NotePane meetingId={meeting.id} />` |
| `fe/src/features/meeting/api/meetings.ts:185-188` | 삭제 시 `["meeting-note", id]` 캐시 제거 |
| `fe/src/index.css:153` | `--rail-insight: 320px` → `420px` |
| `fe/src/app/app-shell.tsx:106` | `min-w-[1160px]` → `min-w-[1260px]` |
| `fe/DESIGN.md:156` 부근 | 레일 다이어그램 주석 갱신 |

---

## Task 1: 서버 — 테이블과 엔드포인트

**Files:**
- Create: `be/src/database/migrations/020_meeting_note.sql`
- Create: `be/src/notes/notes.repository.ts`
- Create: `be/src/notes/notes.service.ts`
- Create: `be/src/notes/notes.controller.ts`
- Create: `be/src/notes/notes.module.ts`
- Modify: `be/src/app.module.ts`
- Test: `be/test/notes.e2e-spec.ts`

**Interfaces:**
- Consumes: `DatabaseService`(`.pool`), 기존 `meeting` 테이블.
- Produces: HTTP `GET /meetings/:id/note` → `{ note: { body_md: string; updated_at: string } | null }`, `PUT /meetings/:id/note` (body `{ body_md: string }`) → 같은 shape 또는 `204`. Task 3이 이 shape에 의존한다.

- [ ] **Step 1: 실패하는 e2e 테스트 작성**

`be/test/notes.e2e-spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { startTestDb, StartedTestDb } from './db';

describe('meeting note api', () => {
  let db: StartedTestDb;
  let app: INestApplication;

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
  });

  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  const srv = () => app.getHttpServer();
  const mkMeeting = async () =>
    (await db.pool.query(
      `INSERT INTO meeting(audio_key,status,title) VALUES('audio','done','회의') RETURNING id`,
    )).rows[0].id as string;

  it('메모가 없으면 note는 null이다', async () => {
    const id = await mkMeeting();
    const { body } = await request(srv()).get(`/meetings/${id}/note`).expect(200);
    expect(body).toEqual({ note: null });
  });

  it('PUT이 메모를 만들고 GET이 그대로 돌려준다', async () => {
    const id = await mkMeeting();
    const put = await request(srv())
      .put(`/meetings/${id}/note`)
      .send({ body_md: '## 결정사항\n- 배포는 다음 주' })
      .expect(200);
    expect(put.body.note.body_md).toBe('## 결정사항\n- 배포는 다음 주');
    expect(typeof put.body.note.updated_at).toBe('string');

    const { body } = await request(srv()).get(`/meetings/${id}/note`).expect(200);
    expect(body.note.body_md).toBe('## 결정사항\n- 배포는 다음 주');
  });

  it('두 번째 PUT은 행을 늘리지 않고 갱신한다', async () => {
    const id = await mkMeeting();
    await request(srv()).put(`/meetings/${id}/note`).send({ body_md: '첫 줄' }).expect(200);
    await request(srv()).put(`/meetings/${id}/note`).send({ body_md: '고친 줄' }).expect(200);

    const { rows } = await db.pool.query('SELECT body_md FROM meeting_note WHERE meeting_id=$1', [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].body_md).toBe('고친 줄');
  });

  it('본문 앞뒤 공백을 다듬지 않는다 — 줄 끝 두 칸은 마크다운 줄바꿈이다', async () => {
    const id = await mkMeeting();
    const body_md = '첫 줄  \n둘째 줄\n';
    await request(srv()).put(`/meetings/${id}/note`).send({ body_md }).expect(200);
    const { body } = await request(srv()).get(`/meetings/${id}/note`).expect(200);
    expect(body.note.body_md).toBe(body_md);
  });

  it('공백만 보내면 204와 함께 행이 사라진다', async () => {
    const id = await mkMeeting();
    await request(srv()).put(`/meetings/${id}/note`).send({ body_md: '지울 메모' }).expect(200);
    await request(srv()).put(`/meetings/${id}/note`).send({ body_md: '   \n  ' }).expect(204);

    const { body } = await request(srv()).get(`/meetings/${id}/note`).expect(200);
    expect(body).toEqual({ note: null });
  });

  it('없는 회의는 404다', async () => {
    await request(srv()).get('/meetings/mtg_999999/note').expect(404);
    await request(srv()).put('/meetings/mtg_999999/note').send({ body_md: '가' }).expect(404);
  });

  it('문자열이 아니거나 상한을 넘으면 400이다', async () => {
    const id = await mkMeeting();
    await request(srv()).put(`/meetings/${id}/note`).send({ body_md: 42 }).expect(400);
    await request(srv()).put(`/meetings/${id}/note`).send({ body_md: 'ㄱ'.repeat(100001) }).expect(400);
  });

  it('회의를 지우면 메모도 사라진다', async () => {
    const id = await mkMeeting();
    await request(srv()).put(`/meetings/${id}/note`).send({ body_md: '메모' }).expect(200);
    await db.pool.query('DELETE FROM meeting WHERE id=$1', [id]);
    const { rows } = await db.pool.query('SELECT 1 FROM meeting_note WHERE meeting_id=$1', [id]);
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `pnpm be test -- notes.e2e-spec`
Expected: FAIL — `Cannot GET /meetings/mtg_1/note` (404 Nest 기본 라우팅) 또는 `relation "meeting_note" does not exist`

- [ ] **Step 3: 마이그레이션 작성**

`be/src/database/migrations/020_meeting_note.sql`:

```sql
-- 회의당 마크다운 메모 1장.
-- processing_version이 없다: 사람이 쓴 글은 재처리로 낡지 않으므로
-- utterance/lens_item/meeting_summary의 버전 규칙 밖에 둔다.
-- 빈 본문 행은 존재하지 않는다 — 서비스가 공백 PUT을 DELETE로 처리하므로
-- "메모 없음" 상태는 '행이 없음' 하나뿐이다.
CREATE SEQUENCE note_id_seq;

CREATE TABLE meeting_note (
  id          text PRIMARY KEY DEFAULT 'note_' || nextval('note_id_seq')
              CHECK (id ~ '^note_[1-9][0-9]*$'),
  meeting_id  text NOT NULL UNIQUE REFERENCES meeting(id) ON DELETE CASCADE,
  body_md     text NOT NULL CHECK (char_length(body_md) BETWEEN 1 AND 100000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

마이그레이션 러너(`be/src/database/migrate.ts`)는 디렉터리를 파일명 정렬로 훑으므로 별도 등록이 필요 없다.

- [ ] **Step 4: repository 작성**

`be/src/notes/notes.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

type Exec = Pool | PoolClient;

export type NoteRow = { body_md: string; updated_at: Date };

@Injectable()
export class NotesRepository {
  async meetingExists(exec: Exec, meetingId: string): Promise<boolean> {
    const { rowCount } = await exec.query('SELECT 1 FROM meeting WHERE id=$1', [meetingId]);
    return rowCount === 1;
  }

  async find(exec: Exec, meetingId: string): Promise<NoteRow | null> {
    const { rows } = await exec.query<NoteRow>(
      'SELECT body_md, updated_at FROM meeting_note WHERE meeting_id=$1',
      [meetingId],
    );
    return rows[0] ?? null;
  }

  // 회의당 1행이 UNIQUE로 보장되므로 업서트는 단일 문장이면 충분하다 —
  // 읽고-쓰는 트랜잭션이 필요 없다.
  async upsert(exec: Exec, meetingId: string, bodyMd: string): Promise<NoteRow> {
    const { rows } = await exec.query<NoteRow>(
      `INSERT INTO meeting_note(meeting_id, body_md) VALUES($1,$2)
       ON CONFLICT (meeting_id)
       DO UPDATE SET body_md=EXCLUDED.body_md, updated_at=now()
       RETURNING body_md, updated_at`,
      [meetingId, bodyMd],
    );
    return rows[0];
  }

  async remove(exec: Exec, meetingId: string): Promise<void> {
    await exec.query('DELETE FROM meeting_note WHERE meeting_id=$1', [meetingId]);
  }
}
```

- [ ] **Step 5: service 작성**

`be/src/notes/notes.service.ts`:

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { NotesRepository, NoteRow } from './notes.repository';

const MEETING_ID_RE = /^mtg_[1-9][0-9]*$/;
const MAX_LENGTH = 100000;

function map(row: NoteRow) {
  return { body_md: row.body_md, updated_at: row.updated_at };
}

@Injectable()
export class NotesService {
  constructor(private readonly db: DatabaseService, private readonly repo: NotesRepository) {}

  private async assertMeeting(meetingId: string) {
    if (!MEETING_ID_RE.test(meetingId)) throw new NotFoundException('meeting not found');
    if (!(await this.repo.meetingExists(this.db.pool, meetingId))) {
      throw new NotFoundException('meeting not found');
    }
  }

  async get(meetingId: string) {
    await this.assertMeeting(meetingId);
    const row = await this.repo.find(this.db.pool, meetingId);
    // null을 그대로 반환하면 NestJS가 빈 본문을 보내고 axios가 ""로 받는다.
    // 객체로 감싸야 "메모 없음"과 "파싱 실패"가 구분된다.
    return { note: row ? map(row) : null };
  }

  /** 저장된 경우 `{ note }`, 지운 경우 `null`(컨트롤러가 204로 변환). */
  async put(meetingId: string, body: { body_md?: unknown }) {
    await this.assertMeeting(meetingId);
    if (typeof body.body_md !== 'string') throw new BadRequestException('body_md must be a string');
    if (body.body_md.length > MAX_LENGTH) {
      throw new BadRequestException(`body_md must be at most ${MAX_LENGTH} characters`);
    }
    // trim은 "다 지웠는가" 판정에만 쓴다. 저장은 원문 그대로 — 줄 끝 공백
    // 두 칸은 마크다운에서 줄바꿈이라 다듬으면 사용자의 글이 바뀐다.
    if (body.body_md.trim().length === 0) {
      await this.repo.remove(this.db.pool, meetingId);
      return null;
    }
    return { note: map(await this.repo.upsert(this.db.pool, meetingId, body.body_md)) };
  }
}
```

- [ ] **Step 6: controller와 module 작성**

`be/src/notes/notes.controller.ts`:

```ts
import { Body, Controller, Get, HttpCode, Param, Put, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { NotesService } from './notes.service';

@ApiTags('notes')
@Controller('meetings/:id/note')
export class NotesController {
  constructor(private readonly service: NotesService) {}

  @Get()
  @ApiOperation({ summary: '회의 메모 조회 (없으면 note: null)' })
  get(@Param('id') id: string) { return this.service.get(id); }

  @Put()
  @ApiOperation({ summary: '회의 메모 저장 (공백 본문이면 삭제 후 204)' })
  async put(
    @Param('id') id: string,
    @Body() body: { body_md?: unknown },
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.put(id, body);
    if (result === null) { res.status(204); return; }
    return result;
  }
}
```

`be/src/notes/notes.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { NotesController } from './notes.controller';
import { NotesRepository } from './notes.repository';
import { NotesService } from './notes.service';

@Module({
  controllers: [NotesController],
  providers: [NotesRepository, NotesService],
})
export class NotesModule {}
```

- [ ] **Step 7: `app.module.ts`에 등록**

`be/src/app.module.ts`의 import 목록 마지막 줄(`SavedUtterancesModule` 다음)에 추가:

```ts
import { NotesModule } from './notes/notes.module';
```

그리고 `@Module({ imports: [...] })` 배열에서 `SavedUtterancesModule` 다음 줄에 `NotesModule,`을 넣는다.

- [ ] **Step 8: 테스트 통과 확인**

Run: `pnpm be test -- notes.e2e-spec`
Expected: PASS — 8개 전부

- [ ] **Step 9: 커밋**

```bash
git add be/src/database/migrations/020_meeting_note.sql be/src/notes be/src/app.module.ts be/test/notes.e2e-spec.ts
git commit -m "feat(be): 회의당 마크다운 메모 1장 저장

meeting_note는 processing_version을 쓰지 않는다 — 사람이 쓴 글은
재처리로 낡지 않으므로 utterance/lens/summary의 버전 규칙 밖에 둔다.

공백만 PUT하면 행을 지운다. '메모 없음' 상태를 '행이 없음' 하나로
유지해 서버 응답과 프론트 빈 화면 분기가 갈라지지 않게 한다. 저장은
원문 그대로 — trim은 판정에만 쓴다(줄 끝 두 칸이 마크다운 줄바꿈).

응답을 { note } 로 감싼 이유는 NestJS가 null 반환 시 빈 본문을 보내
axios가 ''로 받기 때문이다."
```

---

## Task 2: 툴바 텍스트 변환 순수 함수

**Files:**
- Create: `fe/src/features/meeting/lib/md-commands.ts`
- Test: `fe/src/features/meeting/lib/md-commands.test.ts`

**Interfaces:**
- Consumes: 없음 (독립).
- Produces: `type Selection = { text: string; start: number; end: number }`, `toggleWrap(sel, marker)`, `toggleLinePrefix(sel, prefix)`, `insertLink(sel)` — 전부 `Selection`을 받아 `Selection`을 돌려준다. Task 4가 이 세 함수를 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성**

`fe/src/features/meeting/lib/md-commands.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { insertLink, toggleLinePrefix, toggleWrap } from "./md-commands";

describe("toggleWrap", () => {
  it("선택 영역을 마커로 감싸고 선택을 유지한다", () => {
    const out = toggleWrap({ text: "배포는 다음 주", start: 0, end: 3 }, "**");
    expect(out.text).toBe("**배포는** 다음 주");
    expect(out.text.slice(out.start, out.end)).toBe("배포는");
  });

  it("이미 감싸져 있으면 벗긴다", () => {
    const out = toggleWrap({ text: "**배포는** 다음 주", start: 2, end: 5 }, "**");
    expect(out.text).toBe("배포는 다음 주");
    expect(out.text.slice(out.start, out.end)).toBe("배포는");
  });

  it("선택이 없으면 마커만 넣고 커서를 그 사이에 둔다", () => {
    const out = toggleWrap({ text: "", start: 0, end: 0 }, "**");
    expect(out.text).toBe("****");
    expect(out.start).toBe(2);
    expect(out.end).toBe(2);
  });
});

describe("toggleLinePrefix", () => {
  it("커서가 놓인 줄에 접두사를 붙인다", () => {
    const out = toggleLinePrefix({ text: "첫 줄\n둘째 줄", start: 7, end: 7 }, "- ");
    expect(out.text).toBe("첫 줄\n- 둘째 줄");
  });

  it("선택이 걸친 모든 줄에 붙인다", () => {
    const out = toggleLinePrefix({ text: "가\n나", start: 0, end: 3 }, "- ");
    expect(out.text).toBe("- 가\n- 나");
  });

  it("걸친 줄이 모두 접두사를 가지면 벗긴다", () => {
    const out = toggleLinePrefix({ text: "- 가\n- 나", start: 0, end: 7 }, "- ");
    expect(out.text).toBe("가\n나");
  });

  it("일부만 가진 경우는 붙이는 쪽으로 통일한다", () => {
    const out = toggleLinePrefix({ text: "- 가\n나", start: 0, end: 5 }, "- ");
    expect(out.text).toBe("- - 가\n- 나");
  });

  it("빈 줄은 건드리지 않는다", () => {
    const out = toggleLinePrefix({ text: "가\n\n나", start: 0, end: 4 }, "- ");
    expect(out.text).toBe("- 가\n\n- 나");
  });
});

describe("insertLink", () => {
  it("선택을 링크 텍스트로 쓰고 url 자리를 선택해 둔다", () => {
    const out = insertLink({ text: "담화 문서", start: 0, end: 2 });
    expect(out.text).toBe("[담화](url) 문서");
    expect(out.text.slice(out.start, out.end)).toBe("url");
  });

  it("선택이 없으면 빈 링크를 넣고 텍스트 자리를 선택한다", () => {
    const out = insertLink({ text: "", start: 0, end: 0 });
    expect(out.text).toBe("[텍스트](url)");
    expect(out.text.slice(out.start, out.end)).toBe("텍스트");
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `pnpm fe vitest run src/features/meeting/lib/md-commands.test.ts`
Expected: FAIL — `Failed to resolve import "./md-commands"`

- [ ] **Step 3: 구현 작성**

`fe/src/features/meeting/lib/md-commands.ts`:

```ts
/**
 * 툴바 명령 — textarea의 (본문, 선택 시작, 선택 끝)을 받아 새 상태를 돌려주는
 * 순수 함수. DOM도 React도 모르므로 테스트가 값 비교로 끝나고, 나중에 "발언
 * 링크 삽입" 같은 명령을 더할 자리도 여기다.
 */
export type Selection = { text: string; start: number; end: number };

/** `**굵게**`, `*기울임*`, `` `코드` `` 처럼 선택 영역을 마커로 감싸거나 벗긴다. */
export function toggleWrap(sel: Selection, marker: string): Selection {
  const { text, start, end } = sel;
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);

  if (before.endsWith(marker) && after.startsWith(marker)) {
    const head = before.slice(0, before.length - marker.length);
    return {
      text: head + selected + after.slice(marker.length),
      start: head.length,
      end: head.length + selected.length,
    };
  }

  const text2 = `${before}${marker}${selected}${marker}${after}`;
  const start2 = start + marker.length;
  return { text: text2, start: start2, end: start2 + selected.length };
}

/**
 * `- `, `- [ ] `, `## ` 처럼 줄 단위 접두사를 토글한다. 선택이 걸친 모든
 * (비어 있지 않은) 줄이 이미 접두사를 가질 때만 벗기고, 아니면 전부 붙인다 —
 * 섞인 상태에서 벗기면 사용자가 방금 만든 목록이 반쯤 풀린다.
 */
export function toggleLinePrefix(sel: Selection, prefix: string): Selection {
  const { text, start, end } = sel;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = text.indexOf("\n", end);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;

  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const targets = lines.filter((line) => line.trim().length > 0);
  const stripping =
    targets.length > 0 && targets.every((line) => line.startsWith(prefix));

  const next = lines
    .map((line) => {
      if (line.trim().length === 0) return line;
      return stripping ? line.slice(prefix.length) : prefix + line;
    })
    .join("\n");

  return {
    text: text.slice(0, lineStart) + next + text.slice(lineEnd),
    start: lineStart,
    end: lineStart + next.length,
  };
}

const LINK_TEXT_PLACEHOLDER = "텍스트";
const LINK_URL_PLACEHOLDER = "url";

/**
 * `[텍스트](url)`을 넣는다. 선택이 있으면 그것을 링크 텍스트로 삼고 커서를
 * url 자리에, 없으면 텍스트 자리에 둔다 — 어느 쪽이든 바로 타이핑하면 된다.
 */
export function insertLink(sel: Selection): Selection {
  const { text, start, end } = sel;
  const selected = text.slice(start, end);
  const label = selected.length > 0 ? selected : LINK_TEXT_PLACEHOLDER;
  const snippet = `[${label}](${LINK_URL_PLACEHOLDER})`;
  const next = text.slice(0, start) + snippet + text.slice(end);

  const cursor =
    selected.length > 0
      ? start + label.length + 3 // "[label](" 다음 = url 시작
      : start + 1; // "[" 다음 = 텍스트 시작
  const length = selected.length > 0 ? LINK_URL_PLACEHOLDER.length : label.length;
  return { text: next, start: cursor, end: cursor + length };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm fe vitest run src/features/meeting/lib/md-commands.test.ts`
Expected: PASS — 10개 전부

- [ ] **Step 5: 커밋**

```bash
git add fe/src/features/meeting/lib/md-commands.ts fe/src/features/meeting/lib/md-commands.test.ts
git commit -m "feat(fe): 메모 툴바 텍스트 변환 순수 함수

툴바가 하는 일은 결국 선택 영역 앞뒤에 문자열을 끼우고 커서를 옮기는
것뿐이다. DOM을 모르는 순수 함수로 떼어내면 편집기가 얇아지고 테스트가
값 비교로 끝난다.

줄 접두사 토글은 걸친 줄이 모두 접두사를 가질 때만 벗긴다 — 섞인
상태에서 벗기면 방금 만든 목록이 반쯤 풀린다."
```

---

## Task 3: 프론트 데이터 레이어와 자동저장

**Files:**
- Create: `fe/src/features/meeting/api/notes.ts`
- Modify: `fe/src/features/meeting/api/meetings.ts:185-188`
- Test: `fe/src/features/meeting/api/notes.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `GET`/`PUT /meetings/:id/note` 응답 shape `{ note: { body_md, updated_at } | null }`.
- Produces:
  - `type SaveState = "idle" | "saving" | "saved" | "error"`
  - `useMeetingNote(meetingId?: string)` — `UseQueryResult<{ body_md: string; updated_at: string } | null>`
  - `useAutosaveNote(meetingId?: string)` — `{ body: string; isLoading: boolean; state: SaveState; change(next: string): void; flush(): void; retry(): void }`. Task 4가 이걸 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성**

`fe/src/features/meeting/api/notes.test.tsx`:

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { useAutosaveNote, useMeetingNote } from "./notes";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

test("useMeetingNote가 GET /meetings/:id/note를 조회한다", async () => {
  const get = vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { note: { body_md: "## 메모", updated_at: "2026-08-27T00:00:00.000Z" } },
  } as never);
  const { result } = renderHook(() => useMeetingNote("mtg_1"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(get).toHaveBeenCalledWith("/meetings/mtg_1/note");
  expect(result.current.data?.body_md).toBe("## 메모");
});

test("메모가 없으면 data는 null이다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { note: null } } as never);
  const { result } = renderHook(() => useMeetingNote("mtg_1"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toBeNull();
});

test("연속 입력은 800ms 뒤 한 번만 저장한다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { note: null } } as never);
  const put = vi.spyOn(apiClient, "put").mockResolvedValue({
    data: { note: { body_md: "가나", updated_at: "2026-08-27T00:00:00.000Z" } },
  } as never);
  vi.useFakeTimers({ shouldAdvanceTime: true });

  const { result } = renderHook(() => useAutosaveNote("mtg_1"), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  act(() => result.current.change("가"));
  act(() => result.current.change("가나"));
  expect(put).not.toHaveBeenCalled();

  await act(async () => { vi.advanceTimersByTime(800); });
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  expect(put).toHaveBeenCalledWith("/meetings/mtg_1/note", { body_md: "가나" });
});

test("언마운트 시 대기 중인 입력을 flush한다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { note: null } } as never);
  const put = vi.spyOn(apiClient, "put").mockResolvedValue({
    data: { note: { body_md: "날리면 안 됨", updated_at: "2026-08-27T00:00:00.000Z" } },
  } as never);
  vi.useFakeTimers({ shouldAdvanceTime: true });

  const { result, unmount } = renderHook(() => useAutosaveNote("mtg_1"), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  act(() => result.current.change("날리면 안 됨"));
  unmount();

  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  expect(put).toHaveBeenCalledWith("/meetings/mtg_1/note", { body_md: "날리면 안 됨" });
});

test("저장이 실패하면 state가 error이고 retry가 다시 보낸다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { note: null } } as never);
  const put = vi.spyOn(apiClient, "put").mockRejectedValue(new Error("boom"));
  vi.useFakeTimers({ shouldAdvanceTime: true });

  const { result } = renderHook(() => useAutosaveNote("mtg_1"), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  act(() => result.current.change("실패할 메모"));
  await act(async () => { vi.advanceTimersByTime(800); });
  await waitFor(() => expect(result.current.state).toBe("error"));

  act(() => result.current.retry());
  await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `pnpm fe vitest run src/features/meeting/api/notes.test.tsx`
Expected: FAIL — `Failed to resolve import "./notes"`

- [ ] **Step 3: 구현 작성**

`fe/src/features/meeting/api/notes.ts`:

```ts
import * as React from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";

export type MeetingNote = { body_md: string; updated_at: string };
export type SaveState = "idle" | "saving" | "saved" | "error";

const DEBOUNCE_MS = 800;

export function noteQueryKey(meetingId: string | undefined) {
  return ["meeting-note", meetingId] as const;
}

/**
 * 회의 메모 1장 (GET /meetings/:id/note). 회의 상세(`["meeting", id]`)와
 * 분리된 키를 쓰는 이유는 자동저장이다 — 상세 캐시를 800ms마다 건드리면
 * 그 캐시를 구독하는 전사 패널 전체가 함께 리렌더된다.
 */
export function useMeetingNote(
  meetingId: string | undefined,
): UseQueryResult<MeetingNote | null> {
  return useQuery({
    queryKey: noteQueryKey(meetingId),
    queryFn: async () => {
      const { data } = await apiClient.get<{ note: MeetingNote | null }>(
        `/meetings/${meetingId}/note`,
      );
      return data.note;
    },
    enabled: !!meetingId,
  });
}

/**
 * 저장 뮤테이션. 응답으로 본문을 되받지 않고 낙관적으로만 캐시를 갱신한다 —
 * 타이핑 중에 서버 응답이 본문을 덮으면 커서가 튄다.
 */
export function useSaveMeetingNote(meetingId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (bodyMd: string) => {
      const { data } = await apiClient.put<{ note: MeetingNote } | "">(
        `/meetings/${meetingId}/note`,
        { body_md: bodyMd },
      );
      // 공백 본문은 서버가 204(빈 본문)로 답한다.
      return typeof data === "string" || !data ? null : data.note;
    },
    onSuccess: (note) => {
      queryClient.setQueryData(noteQueryKey(meetingId), note);
    },
  });
}

/**
 * 로컬 draft + debounce 자동저장. 언마운트와 회의 전환 시 flush하지 않으면
 * 마지막 타이핑이 debounce 창 안에서 사라진다.
 */
export function useAutosaveNote(meetingId: string | undefined) {
  const query = useMeetingNote(meetingId);
  const mutation = useSaveMeetingNote(meetingId);
  const [draft, setDraft] = React.useState<string | null>(null);

  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = React.useRef<string | null>(null);
  const lastSent = React.useRef<string | null>(null);
  const { mutate } = mutation;

  const flush = React.useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const value = pending.current;
    pending.current = null;
    if (value === null) return;
    lastSent.current = value;
    mutate(value);
  }, [mutate]);

  const change = React.useCallback(
    (next: string) => {
      setDraft(next);
      pending.current = next;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        flush();
      }, DEBOUNCE_MS);
    },
    [flush],
  );

  const retry = React.useCallback(() => {
    if (lastSent.current !== null) mutate(lastSent.current);
  }, [mutate]);

  // 회의가 바뀌면 이전 회의의 draft가 새 회의에 새어 들어가면 안 된다.
  React.useEffect(() => {
    setDraft(null);
    pending.current = null;
    lastSent.current = null;
  }, [meetingId]);

  React.useEffect(() => flush, [flush]);

  const state: SaveState = mutation.isPending
    ? "saving"
    : mutation.isError
      ? "error"
      : mutation.isSuccess
        ? "saved"
        : "idle";

  return {
    body: draft ?? query.data?.body_md ?? "",
    isLoading: query.isPending,
    state,
    change,
    flush,
    retry,
  };
}
```

- [ ] **Step 4: 회의 삭제 시 메모 캐시 제거**

`fe/src/features/meeting/api/meetings.ts`의 `removeQueries` 블록(현재 185–188행)에서
`["meeting-lenses", vars.id]` 다음 줄에 추가:

```ts
      queryClient.removeQueries({ queryKey: ["meeting-note", vars.id] });
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm fe vitest run src/features/meeting/api/notes.test.tsx`
Expected: PASS — 5개 전부

- [ ] **Step 6: 커밋**

```bash
git add fe/src/features/meeting/api/notes.ts fe/src/features/meeting/api/notes.test.tsx fe/src/features/meeting/api/meetings.ts
git commit -m "feat(fe): 회의 메모 조회와 debounce 자동저장

회의 상세(['meeting', id])와 분리된 쿼리 키를 쓴다 — 자동저장이 상세
캐시를 800ms마다 건드리면 그 캐시를 구독하는 전사 패널 전체가 함께
리렌더된다.

언마운트와 회의 전환에서 flush한다. 없으면 마지막 타이핑이 debounce
창 안에서 사라진다. 저장 응답으로 본문을 되받지 않는 것도 같은 이유로,
타이핑 중 서버 응답이 본문을 덮으면 커서가 튄다."
```

---

## Task 4: NotePane — 읽기/편집 2모드 패널

**Files:**
- Create: `fe/src/features/meeting/ui/markdown.tsx`
- Create: `fe/src/features/meeting/ui/note-pane.tsx`
- Modify: `fe/src/features/meeting/ui/icons.tsx`
- Modify: `fe/src/features/meeting/ui/insight-pane.tsx:535-549, 682-684`
- Test: `fe/src/features/meeting/ui/note-pane.test.tsx`

**Interfaces:**
- Consumes: Task 2의 `toggleWrap` / `toggleLinePrefix` / `insertLink` / `Selection`, Task 3의 `useAutosaveNote`.
- Produces: `<NotePane meetingId={string} />`. `insight-pane.tsx`가 `메모` 탭에서 이걸 그린다.

- [ ] **Step 1: 의존성 추가**

```bash
pnpm --filter damwha-fe add react-markdown remark-gfm
```

`rehype-raw`는 **넣지 않는다.** `react-markdown`은 기본적으로 HTML을 텍스트로 취급하므로, 붙이지 않는 것이 곧 XSS 방어다.

- [ ] **Step 2: 실패하는 테스트 작성**

`fe/src/features/meeting/ui/note-pane.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { NotePane } from "./note-pane";

afterEach(() => vi.restoreAllMocks());

function renderPane() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NotePane meetingId="mtg_1" />
    </QueryClientProvider>,
  );
}

test("메모가 없으면 빈 상태와 '메모 쓰기'를 보여 준다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { note: null } } as never);
  renderPane();
  expect(await screen.findByText("아직 메모가 없어요.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "메모 쓰기" })).toBeInTheDocument();
});

test("메모가 있으면 마크다운을 렌더한다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { note: { body_md: "## 결정사항", updated_at: "2026-08-27T00:00:00.000Z" } },
  } as never);
  renderPane();
  expect(
    await screen.findByRole("heading", { name: "결정사항", level: 2 }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

test("raw HTML은 태그가 아니라 텍스트로 나온다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      note: { body_md: "<img src=x onerror=alert(1)>", updated_at: "2026-08-27T00:00:00.000Z" },
    },
  } as never);
  const { container } = renderPane();
  await screen.findByText(/onerror/);
  expect(container.querySelector("img")).toBeNull();
});

test("'편집'을 누르면 textarea가 열린다", async () => {
  const user = userEvent.setup();
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { note: { body_md: "본문", updated_at: "2026-08-27T00:00:00.000Z" } },
  } as never);
  renderPane();
  await user.click(await screen.findByRole("button", { name: "편집" }));
  expect(screen.getByRole("textbox", { name: "메모 본문" })).toHaveValue("본문");
});

test("툴바 '굵게'가 선택 영역을 감싼다", async () => {
  const user = userEvent.setup();
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { note: null } } as never);
  vi.spyOn(apiClient, "put").mockResolvedValue({
    data: { note: { body_md: "**가나**", updated_at: "2026-08-27T00:00:00.000Z" } },
  } as never);
  renderPane();
  await user.click(await screen.findByRole("button", { name: "메모 쓰기" }));

  const box = screen.getByRole("textbox", { name: "메모 본문" }) as HTMLTextAreaElement;
  await user.type(box, "가나");
  box.setSelectionRange(0, 2);
  await user.click(screen.getByRole("button", { name: "굵게" }));

  expect(box).toHaveValue("**가나**");
});

test("'완료'를 누르면 읽기모드로 돌아온다", async () => {
  const user = userEvent.setup();
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { note: { body_md: "본문", updated_at: "2026-08-27T00:00:00.000Z" } },
  } as never);
  vi.spyOn(apiClient, "put").mockResolvedValue({
    data: { note: { body_md: "본문", updated_at: "2026-08-27T00:00:00.000Z" } },
  } as never);
  renderPane();
  await user.click(await screen.findByRole("button", { name: "편집" }));
  await user.click(screen.getByRole("button", { name: "완료" }));
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "메모 본문" })).not.toBeInTheDocument(),
  );
});

test("저장이 실패하면 편집기 안에 다시 시도 버튼이 뜬다", async () => {
  const user = userEvent.setup();
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { note: null } } as never);
  vi.spyOn(apiClient, "put").mockRejectedValue(new Error("boom"));
  renderPane();
  await user.click(await screen.findByRole("button", { name: "메모 쓰기" }));
  await user.type(screen.getByRole("textbox", { name: "메모 본문" }), "가");

  expect(
    await screen.findByRole("button", { name: "다시 시도" }, { timeout: 3000 }),
  ).toBeInTheDocument();
});
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `pnpm fe vitest run src/features/meeting/ui/note-pane.test.tsx`
Expected: FAIL — `Failed to resolve import "./note-pane"`

- [ ] **Step 4: 아이콘 path 추가**

`fe/src/features/meeting/ui/icons.tsx`의 `PATHS` 객체에 (`x` 항목 앞에) 추가:

```ts
  bold: "M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z",
  italic: "M15 4h-6M15 20H9M14 4L10 20",
  heading: "M6 4v16M18 4v16M6 12h12",
  bulletList: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  checkSquare: "M9 11l2 2 4-4M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
  link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5",
  code: "M9 18l-6-6 6-6M15 6l6 6-6 6",
```

- [ ] **Step 5: 마크다운 렌더러 작성**

`fe/src/features/meeting/ui/markdown.tsx`:

```tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 메모 본문 렌더러. `rehype-raw`를 붙이지 않으므로 raw HTML은 살아나지 않고
 * 텍스트로 남는다 — 별도 sanitizer도 dangerouslySetInnerHTML도 쓰지 않는
 * 이유가 이것이다.
 *
 * @tailwindcss/typography 대신 컴포넌트 매핑으로 Timbre semantic 토큰을 직접
 * 적용한다. 플러그인의 자체 색·간격 스케일이 토큰과 경쟁하는 상황을 피한다.
 */
function SafeLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  // javascript: 같은 스킴을 링크로 만들지 않는다. 통과한 것만 새 탭으로.
  const safe = href && /^https?:\/\//i.test(href);
  if (!safe) return <span>{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 hover:no-underline"
    >
      {children}
    </a>
  );
}

export function Markdown({ body }: { body: string }) {
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-base font-semibold text-foreground">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-sm font-semibold text-foreground">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-medium text-[color:var(--text-muted)]">
              {children}
            </h3>
          ),
          p: ({ children }) => <p className="text-sm">{children}</p>,
          ul: ({ children }) => (
            <ul className="flex list-disc flex-col gap-1 pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="flex list-decimal flex-col gap-1 pl-5">{children}</ol>
          ),
          li: ({ children }) => <li className="text-sm">{children}</li>,
          a: SafeLink,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-3 text-[color:var(--text-muted)]">
              {children}
            </blockquote>
          ),
          code: ({ children }) => (
            <code className="rounded-sm bg-[var(--surface-hover)] px-1 py-0.5 font-mono text-2xs">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-sm bg-[var(--surface-hover)] p-2 font-mono text-2xs">
              {children}
            </pre>
          ),
          hr: () => <hr className="border-border" />,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-2xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border px-2 py-1 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border px-2 py-1">{children}</td>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 6: NotePane 작성**

`fe/src/features/meeting/ui/note-pane.tsx`:

```tsx
import * as React from "react";

import { Button } from "@/shared/ui/button";
import { IconButton } from "@/shared/ui/icon-button";

import { useAutosaveNote } from "../api/notes";
import {
  insertLink,
  toggleLinePrefix,
  toggleWrap,
  type Selection,
} from "../lib/md-commands";
import { Icon, type IconName } from "./icons";
import { Markdown } from "./markdown";

type Command = {
  label: string;
  icon: IconName;
  run: (sel: Selection) => Selection;
};

const COMMANDS: Command[] = [
  { label: "굵게", icon: "bold", run: (s) => toggleWrap(s, "**") },
  { label: "기울임", icon: "italic", run: (s) => toggleWrap(s, "*") },
  { label: "제목", icon: "heading", run: (s) => toggleLinePrefix(s, "## ") },
  { label: "목록", icon: "bulletList", run: (s) => toggleLinePrefix(s, "- ") },
  { label: "체크박스", icon: "checkSquare", run: (s) => toggleLinePrefix(s, "- [ ] ") },
  { label: "링크", icon: "link", run: insertLink },
  { label: "코드", icon: "code", run: (s) => toggleWrap(s, "`") },
];

const SAVE_LABEL: Record<string, string> = {
  idle: "",
  saving: "저장 중",
  saved: "저장됨",
  error: "저장 실패",
};

/**
 * 인사이트 레일의 메모 탭. 읽기모드와 편집모드를 오간다 — 렌더된 문서를
 * 클릭하는 것만으로 편집이 시작되면 문서 안의 링크·체크박스와 편집 진입이
 * 섞인다.
 */
export function NotePane({ meetingId }: { meetingId: string }) {
  const { body, isLoading, state, change, flush, retry } = useAutosaveNote(meetingId);
  const [editing, setEditing] = React.useState(false);
  const boxRef = React.useRef<HTMLTextAreaElement | null>(null);

  const done = React.useCallback(() => {
    flush();
    setEditing(false);
  }, [flush]);

  const apply = React.useCallback(
    (command: Command) => {
      const box = boxRef.current;
      if (!box) return;
      const next = command.run({
        text: box.value,
        start: box.selectionStart,
        end: box.selectionEnd,
      });
      change(next.text);
      // 값이 리렌더로 반영된 뒤에 선택을 복원해야 커서가 끝으로 튀지 않는다.
      requestAnimationFrame(() => {
        box.focus();
        box.setSelectionRange(next.start, next.end);
      });
    },
    [change],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") { event.preventDefault(); done(); return; }
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key === "Enter") { event.preventDefault(); done(); return; }
    const key = event.key.toLowerCase();
    if (key === "b") { event.preventDefault(); apply(COMMANDS[0]); }
    if (key === "i") { event.preventDefault(); apply(COMMANDS[1]); }
  };

  if (isLoading) {
    return (
      <div className="px-4 py-10 text-center" role="status" aria-busy="true">
        <p className="text-sm text-[color:var(--text-muted)]">메모를 불러오는 중…</p>
      </div>
    );
  }

  if (!editing) {
    if (body.trim().length === 0) {
      return (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <Icon name="pencil" size={20} className="text-[color:var(--text-faint)]" />
          <p className="text-sm text-[color:var(--text-muted)]">아직 메모가 없어요.</p>
          <p className="text-xs text-[color:var(--text-faint)]">
            회의 중 남긴 메모가 여기에 모여요.
          </p>
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            메모 쓰기
          </Button>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex items-center justify-end">
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            편집
          </Button>
        </div>
        <Markdown body={body} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border pb-2">
        {COMMANDS.map((command) => (
          <IconButton
            key={command.label}
            size="sm"
            aria-label={command.label}
            title={command.label}
            onClick={() => apply(command)}
          >
            <Icon name={command.icon} size={15} />
          </IconButton>
        ))}
      </div>

      <textarea
        ref={boxRef}
        aria-label="메모 본문"
        value={body}
        onChange={(event) => change(event.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
        className="min-h-64 w-full resize-y rounded-sm border border-border bg-[var(--surface-app)] p-2 font-mono text-sm leading-relaxed text-foreground outline-none focus-visible:border-primary"
      />

      <div className="flex items-center justify-between gap-2">
        <span
          className="text-2xs text-[color:var(--text-faint)]"
          role="status"
          aria-live="polite"
        >
          {SAVE_LABEL[state]}
        </span>
        <div className="flex items-center gap-1">
          {state === "error" ? (
            <Button variant="outline" size="sm" onClick={retry}>
              다시 시도
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={done}>
            완료
          </Button>
        </div>
      </div>
    </div>
  );
}
```

참고 — 이 파일이 쓰는 shadcn/CVA props는 실제 정의와 맞춰 둔 값이다. `Button`의 variant는 `primary | secondary | ghost | danger`이고 size는 `sm | md | lg`다 (`fe/src/shared/ui/button.tsx`). **`outline` variant는 존재하지 않는다.** `IconButton`(`fe/src/shared/ui/icon-button.tsx`)은 `aria-label`을 **필수**로 받고 기본값이 `ghost`/`md`이므로, 촘촘한 툴바에는 `size="sm"`(26px)을 준다.

저장 상태 문구는 `저장됨`까지만 쓴다. 스펙 §4.2는 "저장됨 · 방금"이라고 적었지만 이 저장소에는 상대 시각 포맷 유틸이 없고, 자동저장은 800ms마다 도는 터라 "방금"이 사실상 항상 "방금"이다. 상대 시각을 위해 유틸을 새로 들이는 것은 이 기능이 요구하는 바가 아니다.

- [ ] **Step 7: `insight-pane.tsx` 연결**

기존 `function Notes() { ... }` 블록(535–549행)을 **삭제**하고, 파일 상단 import에 추가:

```ts
import { NotePane } from "./note-pane";
```

그리고 `<TabsContent value="notes">` 안의 `<Notes />`를 바꾼다:

```tsx
          <TabsContent value="notes" className="mt-0">
            <NotePane meetingId={meeting.id} />
          </TabsContent>
```

- [ ] **Step 8: 테스트 통과 확인**

Run: `pnpm fe vitest run src/features/meeting/ui/note-pane.test.tsx src/features/meeting/ui/insight-pane.test.tsx`
Expected: PASS — note-pane 7개 + 기존 insight-pane 전부. 특히 "탭은 요약·파일·메모 세 개다"가 그대로 통과해야 한다.

- [ ] **Step 9: 타입체크와 린트**

Run: `pnpm fe build && pnpm fe lint && pnpm fe format`
Expected: 오류 없음. (`tsc -b`가 타입 오류의 source of truth다 — Vite는 타입을 보지 않는다.)

- [ ] **Step 10: 커밋**

```bash
git add fe/package.json fe/src/features/meeting/ui/note-pane.tsx fe/src/features/meeting/ui/note-pane.test.tsx fe/src/features/meeting/ui/markdown.tsx fe/src/features/meeting/ui/icons.tsx fe/src/features/meeting/ui/insight-pane.tsx pnpm-lock.yaml
git commit -m "feat(fe): 메모 탭을 마크다운 편집기로 채운다

읽기모드와 편집모드를 명시적으로 나눈다 — 렌더된 문서를 클릭하는 것만으로
편집이 시작되면 문서 안의 링크·체크박스와 편집 진입이 섞인다.

rehype-raw를 붙이지 않으므로 raw HTML은 텍스트로 남는다. 링크는 http(s)만
통과시키고 그 외 스킴은 링크로 만들지 않는다.

@tailwindcss/typography 대신 컴포넌트 매핑으로 Timbre 토큰을 직접 적용한다.
플러그인의 자체 색·간격 스케일이 토큰과 경쟁하는 상황을 피한다."
```

---

## Task 5: 인사이트 레일 폭 확대

**Files:**
- Modify: `fe/src/index.css:153`
- Modify: `fe/src/app/app-shell.tsx:106`
- Modify: `fe/DESIGN.md` (레일 다이어그램 부근, 156행 근처)

**Interfaces:**
- Consumes: 없음 (Task 1–4와 독립하게 적용 가능).
- Produces: 없음.

- [ ] **Step 1: 토큰 값 변경**

`fe/src/index.css`의 `--rail-insight: 320px;`를 다음으로 바꾼다:

```css
  --rail-insight: 420px;
```

- [ ] **Step 2: 셸 최소폭 상향**

`fe/src/app/app-shell.tsx:106`의 `min-w-[1160px]`를 `min-w-[1260px]`로 바꾼다.

레일은 전사 패널과 같은 flex 행에 있어 넓어지는 만큼 전사가 줄어든다. 최소폭을 100px 함께 올려야 최소 창에서 전사 패널이 지금보다 좁아지지 않는다.

- [ ] **Step 3: DESIGN.md 갱신**

`fe/DESIGN.md`의 레일 다이어그램(152–160행)을 아래로 교체한다. `<aside>` 칸을 넓히고 메모를 그 역할에 더한다. **값(픽셀)은 적지 않는다** — DESIGN.md는 토큰 이름만 담고 값은 `index.css`가 단일 SoT라는 기존 규칙 그대로다.

````markdown
```
┌────────────┬──────────────────┬────────────────────┐
│  <nav>     │  <main>          │  <aside>           │
│  회의·폴더 │  발화 타임라인   │  렌즈(인사이트)·메모│
│  --rail-nav│  (가변 폭)       │   --rail-insight   │
└────────────┴──────────────────┴────────────────────┘
   surface-panel    surface-app        surface-panel
     border-r                            border-l
```
````

이어지는 문단("양쪽 레일은 …")의 끝에 한 문장을 더한다:

```markdown
인사이트 레일은 마크다운 메모 편집을 담을 수 있는 폭으로 잡혀 있다 —
탭에 따라 폭이 변하지는 않는다(탭 전환마다 전사 패널이 리플로우된다).
```

- [ ] **Step 4: 회귀 확인**

Run: `pnpm fe test`
Expected: PASS — 전체 통과. 레일 폭은 jsdom 레이아웃에 영향이 없으므로 기존 테스트가 깨지면 안 된다.

- [ ] **Step 5: 커밋**

```bash
git add fe/src/index.css fe/src/app/app-shell.tsx fe/DESIGN.md
git commit -m "feat(fe): 인사이트 레일을 메모가 들어갈 폭으로 넓힌다

--rail-insight를 상향하고 셸 최소폭도 함께 올린다. 레일은 전사 패널과
같은 flex 행이라 넓어지는 만큼 전사가 줄어들기 때문이다.

탭에 따라 폭을 바꾸지 않는다 — 탭 전환마다 전사 패널이 리플로우된다."
```

---

## 통합 확인

전 태스크 완료 후:

- [ ] `pnpm be test` — 전체 통과
- [ ] `pnpm fe test` — 전체 통과
- [ ] `pnpm build` — 두 패키지 모두 통과
- [ ] `pnpm lint` — 통과
- [ ] 수동 확인: `pnpm db:up && pnpm be migrate` 후 `pnpm dev` → 회의 상세 → 메모 탭 → 쓰기 → 새로고침 후에도 남아 있는지, 전부 지우면 빈 상태로 돌아가는지
