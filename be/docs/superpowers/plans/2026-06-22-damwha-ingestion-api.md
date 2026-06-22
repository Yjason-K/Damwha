# Damwha 인제스션 API (Plan 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Damwha 인제스션 백엔드의 NestJS/Postgres 기반 — 스키마·작업 큐·스토리지·REST API·작업 payload 계약 — 을 구축한다. Python ML 워커(Plan 2) 없이도 SQL 계약 레벨에서 완전히 테스트 가능한 상태가 산출물이다.

**Architecture:** 세 프로세스(NestJS API / Postgres / Python 워커) 중 NestJS와 Postgres를 만든다. API는 ML을 모르고 `job` 테이블에 작업을 enqueue하고 상태/결과를 서빙한다. 워커가 아직 없으므로 워커가 쓸 결과(utterance/meeting_cluster) row는 테스트에서 시드해 검증한다. 작업 큐는 Postgres `FOR UPDATE SKIP LOCKED` 기반이며, claim 시 attempts를 증가시키고 stale lock reaper가 죽은 워커의 job을 회수한다.

**Tech Stack:** Node 22 (`.nvmrc`로 고정, `package.json` engines `>=22 <23`), NestJS 10 (TypeScript 5), Postgres 16 + pgvector(`pgvector/pgvector:pg16` 이미지), `pg`(node-postgres) 직접 사용(raw SQL — `SKIP LOCKED`·vector 타입 때문에 ORM 미사용), zod(payload/env 검증), `@nestjs/schedule`(reaper cron), multer **diskStorage**(대용량 업로드를 메모리에 적재하지 않음), Jest + supertest + `@testcontainers/postgresql`(통합 테스트).

## Global Constraints

스펙(`docs/superpowers/specs/2026-06-22-damwha-ingestion-backend-design.md`)의 프로젝트 전역 요구사항. 모든 태스크에 암묵적으로 적용된다.

- **단일 사용자·자체서버·로컬 전용** — 인증/권한 없음. 외부 네트워크 송출 없음(이 plan에 ML/클라우드 호출 없음).
- **enum은 text + CHECK** (네이티브 enum 금지). 정확한 값:
  - `meeting.status`: `uploaded | processing | done | failed`
  - `speaker.enrollment_status`: `pending | ready | failed`
  - `utterance.status`: `ok | silence | transcribe_failed`
  - `job.type`: `process_meeting | enroll_speaker`
  - `job.status`: `queued | running | done | failed`
  - `job.stage`: `vad | diarize | identify | stt | align | persist | extract_embedding | enroll_persist` (NULL 허용; type↔stage 유효 조합은 앱 계층 검증)
- **attempts 증가 시점 = claim(queued→running) 시점.** claim은 `stage`를 고정하지 않는다(워커가 단계 진입 시 갱신).
- **파일 경로**: DB엔 상대 스토리지 키만(`meetings/<uuid>/...`, `speakers/<uuid>/...`). 업로드 원본 파일명은 `original_filename`에 표시용으로만. 키→경로 해석은 StorageService 한 곳에서만, `STORAGE_ROOT` 밖이면 거부.
- **persist stale 가드(워커가 쓸 규칙, 이 plan에선 reprocess enqueue 측만 구현)**: 결과 반영은 `meeting.processing_version = payload.processing_version AND meeting.current_job_id = job.id`일 때만.
- **스탬프 FK**: `meeting.current_job_id`, `speaker.current_job_id`, `meeting_cluster.job_id`, `utterance.job_id` → `job(id)` `ON DELETE SET NULL`.
- **vector 차원 192 고정.** 식별/voiceprint는 `model`+`dimension` 메타로 필터.
- **Phase 1 재처리 = 현재 결과 덮어쓰기, 과거 미보존.**
- **입력 검증 범위 (이 plan)**: 업로드는 **MIME(`audio/*`) + 확장자 + 크기 한도**만 검증한다. 스펙 §7의 "ffmpeg probe로 실제 오디오 여부 확인"은 **Plan 2 워커의 정규화 단계로 이월**한다(여기서 손상/위장 파일이 최종 차단됨). ⚠️ 따라서 Plan 1 테스트가 더미 바이트를 `audio/*` MIME로 업로드해 201을 받는 것은 *의도된 약한 계약*이며, 실제 오디오 무결성은 Plan 2에서 강제된다.
- **정상 완료/실패 시 연관 엔티티 상태 전이는 워커 책임(Plan 2)**: `JobsRepository.complete()`/`fail()`는 **job만** 갱신한다. 정상 처리 완료 시 `meeting.status='done'`(persist TX 내) / `enroll` 완료 시 `speaker.enrollment_status='ready'`, 정상 실패 시 각각 `failed` 전이는 **Plan 2 워커가 같은 트랜잭션에서** 수행하고 거기서 계약 테스트로 검증한다. Plan 1은 **크래시 경로(reaper)** 의 상태 전파만 책임진다(Task 6).

---

## File Structure

> 모든 경로는 리포 루트 `/Users/jason/projects/Damwha/be`(= 현재 워크스페이스) 기준이다. 모든 명령은 이 디렉터리에서 실행한다.

```
<repo root = be/>
  .nvmrc                          Node 22 고정
  package.json
  tsconfig.json
  tsconfig.build.json
  nest-cli.json
  jest.config.js
  .env.example
  src/
    main.ts                         앱 부트스트랩
    app.module.ts                   루트 모듈
    config/env.ts                   zod 검증 env (타입 안전)
    database/
      database.module.ts            DatabaseService 전역 제공
      database.service.ts           pg.Pool 래퍼: query, withTransaction
      migrate.ts                    마이그레이션 러너 + CLI
      migrations/001_init.sql       전체 스키마
    storage/
      storage.module.ts
      storage.service.ts            UUID 키, traversal 가드, save/saveFromTemp/resolve/stat/stream
      upload-options.ts             공유 multer diskStorage 설정(임시파일, 메모리 미적재)
    contracts/job-payload.schema.ts zod: process_meeting / enroll_speaker payload + 빌더
    jobs/
      jobs.module.ts
      jobs.types.ts                 JobRow, JobType, Queryable
      jobs.repository.ts            enqueue/claim/heartbeat/setStage/complete/fail/reapStale
      reaper.service.ts             @Cron → reapStale
    meetings/
      meetings.module.ts
      meetings.controller.ts        POST/GET/status/reprocess/audio
      meetings.service.ts           업로드·재처리·조회·resolve 트랜잭션
      meetings.repository.ts        meeting/utterance/cluster SQL
    speakers/
      speakers.module.ts
      speakers.controller.ts        POST/GET/GET:id
      speakers.service.ts           등록 트랜잭션
      speakers.repository.ts        speaker/voiceprint SQL
    health/health.controller.ts     GET /health (SELECT 1)
  test/
    db.ts                           Testcontainers 헬퍼 + 시드 유틸
    *.spec.ts / *.e2e-spec.ts
```

각 파일은 단일 책임을 가진다. 컨트롤러=HTTP, 서비스=트랜잭션/오케스트레이션, 리포지토리=SQL. ML 지식은 어디에도 없다.

---

## Task 1: 프로젝트 스캐폴드 + env + health

**Files:**
- Create: `.nvmrc`, `package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `jest.config.js`, `.env.example`
- Create: `src/config/env.ts`, `src/main.ts`, `src/app.module.ts`, `src/health/health.controller.ts`
- Test: `test/health.e2e-spec.ts`

**Interfaces:**
- Produces: `ENV` (typed config object) with fields `PORT:number`, `DATABASE_URL:string`, `STORAGE_ROOT:string`, `MAX_UPLOAD_BYTES:number`, `REAPER_STALE_MINUTES:number`, `WHISPER_MODEL:'large-v3-turbo'|'large-v3'`, `WHISPER_DEVICE:'mps'|'cpu'|'cuda'`, `STT_LANGUAGE:string`, `DIARIZATION_MODEL:string`, `EMBEDDING_MODEL:string`, `EMBEDDING_DIM:number`, `IDENTIFY_THRESHOLD:number`. `loadEnv():Env` re-reads `process.env` (tests set `DATABASE_URL` at runtime).
- Produces: `AppModule` (root Nest module).

- [ ] **Step 1: Write package.json and tooling configs**

`.nvmrc`:
```
22
```

`package.json`:
```json
{
  "name": "damwha-be",
  "version": "0.1.0",
  "private": true,
  "engines": { "node": ">=22 <23" },
  "scripts": {
    "build": "nest build && cp -r src/database/migrations dist/database/migrations",
    "start": "node dist/main.js",
    "start:dev": "nest start --watch",
    "migrate": "ts-node src/database/migrate.ts",
    "test": "jest --runInBand",
    "test:e2e": "jest --runInBand --config ./jest.config.js"
  },
  "dependencies": {
    "@nestjs/common": "^10.3.0",
    "@nestjs/core": "^10.3.0",
    "@nestjs/platform-express": "^10.3.0",
    "@nestjs/schedule": "^4.0.0",
    "pg": "^8.11.3",
    "reflect-metadata": "^0.2.1",
    "rxjs": "^7.8.1",
    "zod": "^3.22.4"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.3.0",
    "@nestjs/testing": "^10.3.0",
    "@testcontainers/postgresql": "^10.7.0",
    "@types/express": "^4.17.21",
    "@types/jest": "^29.5.11",
    "@types/multer": "^1.4.11",
    "@types/node": "^22.10.0",
    "@types/pg": "^8.11.0",
    "@types/supertest": "^6.0.2",
    "jest": "^29.7.0",
    "supertest": "^6.3.4",
    "testcontainers": "^10.7.0",
    "ts-jest": "^29.1.2",
    "ts-node": "^10.9.2",
    "typescript": "^5.3.3"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "lib": ["ES2023"],
    "moduleResolution": "node",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "strict": true,
    "strictPropertyInitialization": false,
    "skipLibCheck": true
  }
}
```

`tsconfig.build.json`:
```json
{ "extends": "./tsconfig.json", "exclude": ["node_modules", "test", "dist", "**/*.spec.ts"] }
```

`nest-cli.json`:
```json
{ "$schema": "https://json.schemastore.org/nest-cli", "collection": "@nestjs/schematics", "sourceRoot": "src" }
```

`jest.config.js`:
```js
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  testEnvironment: 'node',
  testTimeout: 180000,
};
```

`.env.example`:
```
PORT=3000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/damwha
STORAGE_ROOT=./storage
MAX_UPLOAD_BYTES=1073741824
REAPER_STALE_MINUTES=30
WHISPER_MODEL=large-v3-turbo
WHISPER_DEVICE=mps
STT_LANGUAGE=ko
DIARIZATION_MODEL=pyannote/speaker-diarization-3.1
EMBEDDING_MODEL=speechbrain/spkrec-ecapa-voxceleb
EMBEDDING_DIM=192
IDENTIFY_THRESHOLD=0.70
```

- [ ] **Step 2: Write env loader and write the failing health test**

`src/config/env.ts`:
```ts
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string(),
  STORAGE_ROOT: z.string().default('./storage'),
  MAX_UPLOAD_BYTES: z.coerce.number().default(1_073_741_824),
  REAPER_STALE_MINUTES: z.coerce.number().default(30),
  WHISPER_MODEL: z.enum(['large-v3-turbo', 'large-v3']).default('large-v3-turbo'),
  WHISPER_DEVICE: z.enum(['mps', 'cpu', 'cuda']).default('mps'),
  STT_LANGUAGE: z.string().default('ko'),
  DIARIZATION_MODEL: z.string().default('pyannote/speaker-diarization-3.1'),
  EMBEDDING_MODEL: z.string().default('speechbrain/spkrec-ecapa-voxceleb'),
  EMBEDDING_DIM: z.coerce.number().default(192),
  IDENTIFY_THRESHOLD: z.coerce.number().default(0.7),
});

export type Env = z.infer<typeof EnvSchema>;
export function loadEnv(): Env {
  return EnvSchema.parse(process.env);
}
export const ENV = new Proxy({} as Env, {
  get: (_t, prop: string) => loadEnv()[prop as keyof Env],
});

// Narrow reader used in decorator/module metadata (evaluated at import time,
// BEFORE tests set DATABASE_URL). MUST NOT call loadEnv() — parsing the full
// schema there would throw on the missing DATABASE_URL during module import.
export function maxUploadBytes(): number {
  const v = Number(process.env.MAX_UPLOAD_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 1_073_741_824;
}
```

> Why `maxUploadBytes` exists: test files `import { AppModule }` at top level. Any `loadEnv()` evaluated inside a `@UseInterceptors(FileInterceptor(...))` decorator runs at import time, before `beforeAll()` sets `DATABASE_URL`, and `EnvSchema.parse` would throw. `DatabaseService`/`StorageService` read `loadEnv()` only in their **constructors** (instantiated at `app.init()`, after env is set), so they are fine.

`test/health.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('health', () => {
  let db: StartedTestDb;
  let app: INestApplication;

  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  it('GET /health → 200 ok', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
```

> Note: `test/db.ts` (`startTestDb`) is created in Task 2. This test will not run until then — that is expected; run it at the end of Task 2.

- [ ] **Step 3: Implement app module, main, health controller**

`src/health/health.controller.ts` (no DB dependency — `DatabaseService` does not exist until Task 2; keeping health self-contained lets Task 1 build and DI cleanly):
```ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}
```

`src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module';
import { StorageModule } from './storage/storage.module';
import { JobsModule } from './jobs/jobs.module';
import { MeetingsModule } from './meetings/meetings.module';
import { SpeakersModule } from './speakers/speakers.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DatabaseModule,
    StorageModule,
    JobsModule,
    MeetingsModule,
    SpeakersModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
```

`src/main.ts`:
```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
  await app.listen(env.PORT);
}
bootstrap();
```

> `AppModule` imports modules built in later tasks. To keep this task's build green, create **stub modules** now and flesh them out later:
> `src/database/database.module.ts`, `src/storage/storage.module.ts`, `src/jobs/jobs.module.ts`, `src/meetings/meetings.module.ts`, `src/speakers/speakers.module.ts` — each `@Module({})` exporting an empty class of the right name. They are replaced in their tasks. (Database/Storage are completed in Tasks 2–3 before any test runs.)

- [ ] **Step 4: Install deps and verify build**

Run: `npm install && npx tsc --noEmit -p tsconfig.json`
Expected: PASS (no type errors). The health e2e test runs in Task 2 once `test/db.ts` exists.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig*.json nest-cli.json jest.config.js .env.example src
git commit -m "feat: NestJS scaffold, env loader, health endpoint"
```

---

## Task 2: Database service + migration + 전체 스키마

**Files:**
- Create: `src/database/database.service.ts`, `src/database/database.module.ts`, `src/database/migrate.ts`, `src/database/migrations/001_init.sql`
- Create: `test/db.ts`
- Test: `test/migration.spec.ts`

**Interfaces:**
- Produces: `DatabaseService` with `pool: Pool`, `query<T>(text, params?): Promise<QueryResult<T>>`, `withTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>`.
- Produces: `runMigrations(pool: Pool): Promise<void>`.
- Produces (test util): `startTestDb(): Promise<StartedTestDb>` where `StartedTestDb = { pool: Pool; url: string; stop(): Promise<void>; reset(): Promise<void> }`.

- [ ] **Step 1: Write the failing migration test**

`test/db.ts`:
```ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migrate';

export interface StartedTestDb {
  pool: Pool;
  url: string;
  stop(): Promise<void>;
  reset(): Promise<void>;
}

let container: StartedPostgreSqlContainer;

export async function startTestDb(): Promise<StartedTestDb> {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url; // AppModule / DatabaseService read this
  const pool = new Pool({ connectionString: url });
  await runMigrations(pool);
  return {
    pool,
    url,
    stop: async () => { await pool.end(); await container.stop(); },
    reset: async () => {
      await pool.query(
        `TRUNCATE job, utterance, meeting_cluster, voiceprint, meeting, speaker RESTART IDENTITY CASCADE`,
      );
    },
  };
}
```

`test/migration.spec.ts`:
```ts
import { startTestDb, StartedTestDb } from './db';

describe('migration', () => {
  let db: StartedTestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db?.stop(); });

  it('creates all tables', async () => {
    const { rows } = await db.pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' ORDER BY table_name`,
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'job', 'meeting', 'meeting_cluster', 'speaker', 'utterance', 'voiceprint',
      ]),
    );
  });

  it('enables pgvector and accepts a 192-dim vector', async () => {
    const sp = await db.pool.query(`INSERT INTO speaker(name) VALUES('t') RETURNING id`);
    const vec = '[' + Array(192).fill(0.1).join(',') + ']';
    await expect(
      db.pool.query(
        `INSERT INTO voiceprint(speaker_id, embedding, model, dimension)
         VALUES($1, $2::vector, 'm', 192)`,
        [sp.rows[0].id, vec],
      ),
    ).resolves.toBeDefined();
  });

  it('enforces utterance UNIQUE(meeting_id, order_index)', async () => {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key) VALUES('k') RETURNING id`,
    );
    const mid = m.rows[0].id;
    const ins = (i: number) =>
      db.pool.query(
        `INSERT INTO utterance(meeting_id, diar_label, start_ms, end_ms, order_index, processing_version)
         VALUES($1,'SPEAKER_00',0,1,$2,0)`,
        [mid, i],
      );
    await ins(0);
    await expect(ins(0)).rejects.toThrow(/duplicate key|unique/i);
  });

  it('rejects invalid job.status via CHECK', async () => {
    await expect(
      db.pool.query(`INSERT INTO job(type, payload, status) VALUES('process_meeting','{}','bogus')`),
    ).rejects.toThrow(/check constraint/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest test/migration.spec.ts`
Expected: FAIL — `runMigrations` not found / module `../src/database/migrate` missing.

- [ ] **Step 3: Implement migration runner, schema, and DatabaseService**

`src/database/migrations/001_init.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE speaker (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  enrollment_status text NOT NULL DEFAULT 'pending'
                      CHECK (enrollment_status IN ('pending','ready','failed')),
  current_job_id    uuid,
  enrollment_error  jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE voiceprint (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  speaker_id         uuid NOT NULL REFERENCES speaker(id) ON DELETE CASCADE,
  embedding          vector(192) NOT NULL,
  model              text NOT NULL,
  dimension          int NOT NULL,
  sample_duration_ms int,
  quality_score      real,
  source             text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voiceprint_model_dim_idx ON voiceprint (model, dimension);
CREATE INDEX voiceprint_embedding_idx ON voiceprint USING hnsw (embedding vector_cosine_ops);

CREATE TABLE meeting (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title              text,
  original_filename  text,
  audio_key          text NOT NULL,
  normalized_key     text,
  recorded_at        timestamptz,
  duration_ms        int,
  status             text NOT NULL DEFAULT 'uploaded'
                       CHECK (status IN ('uploaded','processing','done','failed')),
  current_job_id     uuid,
  processing_version int NOT NULL DEFAULT 0,
  error              jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meeting_cluster (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id          uuid NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  diar_label          text NOT NULL,
  centroid            vector(192),
  resolved_speaker_id uuid REFERENCES speaker(id),
  processing_version  int NOT NULL,
  job_id              uuid,
  UNIQUE (meeting_id, diar_label)
);

CREATE TABLE utterance (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id         uuid NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  speaker_id         uuid REFERENCES speaker(id),
  diar_label         text NOT NULL,
  start_ms           int NOT NULL,
  end_ms             int NOT NULL,
  text               text,
  confidence         real,
  status             text NOT NULL DEFAULT 'ok'
                       CHECK (status IN ('ok','silence','transcribe_failed')),
  transcript_error   jsonb,
  order_index        int NOT NULL,
  processing_version int NOT NULL,
  job_id             uuid,
  UNIQUE (meeting_id, order_index)
);

CREATE TABLE job (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text NOT NULL CHECK (type IN ('process_meeting','enroll_speaker')),
  meeting_id   uuid REFERENCES meeting(id) ON DELETE CASCADE,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','done','failed')),
  stage        text CHECK (stage IN
                 ('vad','diarize','identify','stt','align','persist',
                  'extract_embedding','enroll_persist')),
  progress     smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  locked_by    text,
  locked_at    timestamptz,
  error        jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_status_created_idx ON job (status, created_at);

ALTER TABLE meeting         ADD FOREIGN KEY (current_job_id) REFERENCES job(id) ON DELETE SET NULL;
ALTER TABLE speaker         ADD FOREIGN KEY (current_job_id) REFERENCES job(id) ON DELETE SET NULL;
ALTER TABLE meeting_cluster ADD FOREIGN KEY (job_id)         REFERENCES job(id) ON DELETE SET NULL;
ALTER TABLE utterance       ADD FOREIGN KEY (job_id)         REFERENCES job(id) ON DELETE SET NULL;
```

`src/database/migrate.ts`:
```ts
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { loadEnv } from '../config/env';

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const done = await pool.query('SELECT 1 FROM _migrations WHERE name=$1', [file]);
    if (done.rowCount) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations(name) VALUES($1)', [file]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

if (require.main === module) {
  const pool = new Pool({ connectionString: loadEnv().DATABASE_URL });
  runMigrations(pool)
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
```

> Important: `nest build` (tsc) does not copy `.sql` files to `dist/`. The `build` script in the `package.json` above **already** appends `&& cp -r src/database/migrations dist/database/migrations` — do not omit it. For tests, ts-jest runs from `src` so `__dirname` already resolves to `src/database`.

`src/database/database.service.ts`:
```ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { loadEnv } from '../config/env';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;
  constructor() {
    this.pool = new Pool({ connectionString: loadEnv().DATABASE_URL });
  }
  query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }
  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async onModuleDestroy() { await this.pool.end(); }
}
```

`src/database/database.module.ts` (replaces the stub):
```ts
import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Global()
@Module({ providers: [DatabaseService], exports: [DatabaseService] })
export class DatabaseModule {}
```

- [ ] **Step 4: Run migration + health tests to verify pass**

Run: `npx jest test/migration.spec.ts test/health.e2e-spec.ts`
Expected: PASS (all assertions). pgvector image pulls on first run.

- [ ] **Step 5: Commit**

```bash
git add src/database test/db.ts test/migration.spec.ts test/health.e2e-spec.ts package.json
git commit -m "feat: Postgres schema, migration runner, DatabaseService + Testcontainers harness"
```

---

## Task 3: StorageService (UUID 키 · traversal 가드 · Range)

**Files:**
- Create: `src/storage/storage.service.ts`, `src/storage/storage.module.ts` (replaces stub)
- Test: `test/storage.spec.ts`

**Interfaces:**
- Produces: `StorageService` with:
  - `sanitizeExt(filename: string): string` → `.ext` (alphanumeric only, lowercased; `''` if none)
  - `meetingKey(meetingId: string, filename: string): string` → `meetings/<id>/original<.ext>`
  - `speakerKey(speakerId: string, filename: string): string` → `speakers/<id>/sample<.ext>`
  - `resolve(key: string): string` (absolute path; throws `ForbiddenException` on traversal/absolute)
  - `save(key: string, data: Buffer): Promise<void>`
  - `saveFromTemp(key: string, tempPath: string): Promise<void>` — multer diskStorage 임시 파일을 최종 키로 이동(rename, 크로스 디바이스면 copy+unlink). 메모리에 적재하지 않음.
  - `stat(key: string): Promise<fs.Stats>`
  - `createReadStream(key: string, opts?: { start: number; end: number }): fs.ReadStream`

- [ ] **Step 1: Write the failing test**

`test/storage.spec.ts`:
```ts
import { StorageService } from '../src/storage/storage.service';
import { ForbiddenException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('StorageService', () => {
  let root: string;
  let svc: StorageService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-store-'));
    process.env.STORAGE_ROOT = root;
    svc = new StorageService();
  });

  it('builds UUID-based keys, ignoring untrusted filename', () => {
    expect(svc.meetingKey('11111111-1111-1111-1111-111111111111', '../../evil.MP3'))
      .toBe('meetings/11111111-1111-1111-1111-111111111111/original.mp3');
    expect(svc.speakerKey('22222222-2222-2222-2222-222222222222', 'no-ext'))
      .toBe('speakers/22222222-2222-2222-2222-222222222222/sample');
  });

  it('saves and resolves within root', async () => {
    const key = svc.meetingKey('aaaa', 'a.wav');
    await svc.save(key, Buffer.from('hello'));
    const full = svc.resolve(key);
    expect(full.startsWith(fs.realpathSync(root))).toBe(true);
    expect(fs.readFileSync(full, 'utf8')).toBe('hello');
  });

  it('rejects path traversal and absolute keys', () => {
    expect(() => svc.resolve('../../etc/passwd')).toThrow(ForbiddenException);
    expect(() => svc.resolve('/etc/passwd')).toThrow(ForbiddenException);
    expect(() => svc.resolve('meetings/../../secret')).toThrow(ForbiddenException);
  });

  it('streams a byte range', async () => {
    const key = svc.meetingKey('bbbb', 'a.wav');
    await svc.save(key, Buffer.from('0123456789'));
    const chunks: Buffer[] = [];
    await new Promise<void>((res, rej) => {
      svc.createReadStream(key, { start: 2, end: 5 })
        .on('data', (c) => chunks.push(c as Buffer))
        .on('end', res).on('error', rej);
    });
    expect(Buffer.concat(chunks).toString()).toBe('2345');
  });

  it('saveFromTemp moves a temp file into the keyed location', async () => {
    const tmp = path.join(os.tmpdir(), 'dw-tmp-src');
    fs.writeFileSync(tmp, 'tempdata');
    const key = svc.meetingKey('cccc', 'a.wav');
    await svc.saveFromTemp(key, tmp);
    expect(fs.readFileSync(svc.resolve(key), 'utf8')).toBe('tempdata');
    expect(fs.existsSync(tmp)).toBe(false); // temp consumed
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest test/storage.spec.ts`
Expected: FAIL — module `../src/storage/storage.service` not found.

- [ ] **Step 3: Implement StorageService**

`src/storage/storage.service.ts`:
```ts
import { ForbiddenException, Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { loadEnv } from '../config/env';

@Injectable()
export class StorageService {
  private readonly root: string;
  constructor() {
    this.root = path.resolve(loadEnv().STORAGE_ROOT);
  }

  sanitizeExt(filename: string): string {
    const ext = path.extname(filename).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    return ext ? `.${ext}` : '';
  }
  meetingKey(meetingId: string, filename: string): string {
    return `meetings/${meetingId}/original${this.sanitizeExt(filename)}`;
  }
  speakerKey(speakerId: string, filename: string): string {
    return `speakers/${speakerId}/sample${this.sanitizeExt(filename)}`;
  }

  resolve(key: string): string {
    const full = path.resolve(this.root, key);
    const rel = path.relative(this.root, full);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ForbiddenException('invalid storage key');
    }
    return full;
  }

  async save(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, data);
  }
  async saveFromTemp(key: string, tempPath: string): Promise<void> {
    const full = this.resolve(key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    try {
      await fs.promises.rename(tempPath, full);
    } catch (e: any) {
      if (e?.code === 'EXDEV') {
        // temp dir on a different filesystem (e.g. os.tmpdir() vs STORAGE_ROOT)
        await fs.promises.copyFile(tempPath, full);
        await fs.promises.unlink(tempPath);
      } else {
        throw e;
      }
    }
  }
  stat(key: string): Promise<fs.Stats> {
    return fs.promises.stat(this.resolve(key));
  }
  createReadStream(key: string, opts?: { start: number; end: number }): fs.ReadStream {
    return fs.createReadStream(this.resolve(key), opts);
  }
}
```

`src/storage/storage.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest test/storage.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage test/storage.spec.ts
git commit -m "feat: StorageService with UUID keys, path-traversal guard, range streaming"
```

---

## Task 4: 작업 payload 계약 (zod)

**Files:**
- Create: `src/contracts/job-payload.schema.ts`
- Test: `test/job-payload.spec.ts`

**Interfaces:**
- Produces: `ProcessMeetingPayloadSchema`, `EnrollSpeakerPayloadSchema` (zod), and inferred types `ProcessMeetingPayload`, `EnrollSpeakerPayload`.
- Produces: `buildProcessMeetingPayload(args: { meetingId: string; audioKey: string; processingVersion: number; reprocess: boolean }): ProcessMeetingPayload` — fills `models`/`identify` from `ENV`.
- Produces: `buildEnrollSpeakerPayload(args: { speakerId: string; audioKey: string }): EnrollSpeakerPayload`.

> This schema is the Nest↔Python contract. Plan 2's pydantic models mirror it field-for-field; the same JSON fixtures validate on both sides.

- [ ] **Step 1: Write the failing test**

`test/job-payload.spec.ts`:
```ts
import {
  ProcessMeetingPayloadSchema,
  EnrollSpeakerPayloadSchema,
  buildProcessMeetingPayload,
  buildEnrollSpeakerPayload,
} from '../src/contracts/job-payload.schema';

describe('job payload contract', () => {
  beforeAll(() => {
    process.env.WHISPER_MODEL = 'large-v3-turbo';
    process.env.EMBEDDING_DIM = '192';
    process.env.IDENTIFY_THRESHOLD = '0.7';
  });

  it('builds + validates a process_meeting payload from ENV', () => {
    const p = buildProcessMeetingPayload({
      meetingId: '11111111-1111-1111-1111-111111111111',
      audioKey: 'meetings/x/original.wav',
      processingVersion: 2,
      reprocess: true,
    });
    expect(p.models.whisper_model).toBe('large-v3-turbo');
    expect(p.models.embedding.dimension).toBe(192);
    expect(p.identify.threshold).toBeCloseTo(0.7);
    expect(() => ProcessMeetingPayloadSchema.parse(p)).not.toThrow();
  });

  it('rejects a process_meeting payload missing audio_key', () => {
    expect(() => ProcessMeetingPayloadSchema.parse({ meeting_id: 'x' })).toThrow();
  });

  it('builds + validates an enroll_speaker payload', () => {
    const p = buildEnrollSpeakerPayload({
      speakerId: '22222222-2222-2222-2222-222222222222',
      audioKey: 'speakers/y/sample.wav',
    });
    expect(() => EnrollSpeakerPayloadSchema.parse(p)).not.toThrow();
    expect(p.embedding.dimension).toBe(192);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest test/job-payload.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the contract**

`src/contracts/job-payload.schema.ts`:
```ts
import { z } from 'zod';
import { loadEnv } from '../config/env';

export const ModelsSchema = z.object({
  whisper_model: z.enum(['large-v3-turbo', 'large-v3']),
  device: z.enum(['mps', 'cpu', 'cuda']),
  language: z.string(),
  diarization: z.object({
    model: z.string(),
    min_speakers: z.number().int().nullable(),
    max_speakers: z.number().int().nullable(),
  }),
  embedding: z.object({ model: z.string(), dimension: z.number().int() }),
});

export const ProcessMeetingPayloadSchema = z.object({
  meeting_id: z.string().uuid(),
  audio_key: z.string().min(1),
  processing_version: z.number().int().nonnegative(),
  reprocess: z.boolean(),
  models: ModelsSchema,
  identify: z.object({ threshold: z.number() }),
});

export const EnrollSpeakerPayloadSchema = z.object({
  speaker_id: z.string().uuid(),
  audio_key: z.string().min(1),
  embedding: z.object({ model: z.string(), dimension: z.number().int() }),
});

export type ProcessMeetingPayload = z.infer<typeof ProcessMeetingPayloadSchema>;
export type EnrollSpeakerPayload = z.infer<typeof EnrollSpeakerPayloadSchema>;

export function buildProcessMeetingPayload(args: {
  meetingId: string; audioKey: string; processingVersion: number; reprocess: boolean;
}): ProcessMeetingPayload {
  const env = loadEnv();
  return {
    meeting_id: args.meetingId,
    audio_key: args.audioKey,
    processing_version: args.processingVersion,
    reprocess: args.reprocess,
    models: {
      whisper_model: env.WHISPER_MODEL,
      device: env.WHISPER_DEVICE,
      language: env.STT_LANGUAGE,
      diarization: { model: env.DIARIZATION_MODEL, min_speakers: null, max_speakers: null },
      embedding: { model: env.EMBEDDING_MODEL, dimension: env.EMBEDDING_DIM },
    },
    identify: { threshold: env.IDENTIFY_THRESHOLD },
  };
}

export function buildEnrollSpeakerPayload(args: {
  speakerId: string; audioKey: string;
}): EnrollSpeakerPayload {
  const env = loadEnv();
  return {
    speaker_id: args.speakerId,
    audio_key: args.audioKey,
    embedding: { model: env.EMBEDDING_MODEL, dimension: env.EMBEDDING_DIM },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest test/job-payload.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/contracts test/job-payload.spec.ts
git commit -m "feat: job payload contract (zod) shared with Python worker"
```

---

## Task 5: JobsRepository — enqueue + claim (SKIP LOCKED, attempts++)

**Files:**
- Create: `src/jobs/jobs.types.ts`, `src/jobs/jobs.repository.ts`, `src/jobs/jobs.module.ts` (replaces stub)
- Test: `test/jobs.repository.spec.ts`

**Interfaces:**
- Produces: `Queryable = Pick<Pool, 'query'>` (satisfied by `Pool` and `PoolClient`).
- Produces: `JobRow` (all `job` columns, typed).
- Produces: `JobsRepository` with:
  - `enqueue(exec: Queryable, args: { type: JobType; meetingId: string | null; payload: unknown }): Promise<JobRow>`
  - `claim(exec: Queryable, workerId: string): Promise<JobRow | null>` (SKIP LOCKED, `attempts=attempts+1`, no stage set)
  - `heartbeat(exec: Queryable, jobId: string, workerId: string): Promise<void>`
  - `setStage(exec: Queryable, jobId: string, stage: string, progress: number): Promise<void>`
  - `complete(exec: Queryable, jobId: string): Promise<void>`
  - `fail(exec: Queryable, jobId: string, error: object): Promise<void>`

- [ ] **Step 1: Write the failing test**

`test/jobs.repository.spec.ts`:
```ts
import { startTestDb, StartedTestDb } from './db';
import { JobsRepository } from '../src/jobs/jobs.repository';

describe('JobsRepository', () => {
  let db: StartedTestDb;
  let repo: JobsRepository;
  beforeAll(async () => { db = await startTestDb(); repo = new JobsRepository(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  async function seedMeeting() {
    const r = await db.pool.query(`INSERT INTO meeting(audio_key) VALUES('k') RETURNING id`);
    return r.rows[0].id as string;
  }

  it('enqueues a queued job', async () => {
    const mid = await seedMeeting();
    const job = await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: mid, payload: { a: 1 } });
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(0);
    expect(job.stage).toBeNull();
  });

  it('claim transitions to running and increments attempts', async () => {
    const mid = await seedMeeting();
    await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: mid, payload: {} });
    const claimed = await repo.claim(db.pool, 'worker-1');
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('running');
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.locked_by).toBe('worker-1');
    expect(claimed!.stage).toBeNull(); // claim does not set stage
  });

  it('two concurrent claims never get the same job', async () => {
    const mid = await seedMeeting();
    await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: mid, payload: {} });
    const [a, b] = await Promise.all([
      repo.claim(db.pool, 'w-a'),
      repo.claim(db.pool, 'w-b'),
    ]);
    const claimedIds = [a, b].filter(Boolean).map((j) => j!.id);
    expect(claimedIds.length).toBe(1); // only one wins
  });

  it('claim returns null when queue empty', async () => {
    expect(await repo.claim(db.pool, 'w')).toBeNull();
  });

  it('setStage, complete, fail update fields', async () => {
    const mid = await seedMeeting();
    const job = await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: mid, payload: {} });
    await repo.claim(db.pool, 'w');
    await repo.setStage(db.pool, job.id, 'diarize', 40);
    await repo.fail(db.pool, job.id, { code: 'x', message: 'boom' });
    const { rows } = await db.pool.query('SELECT * FROM job WHERE id=$1', [job.id]);
    expect(rows[0].stage).toBe('diarize');
    expect(rows[0].progress).toBe(40);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toEqual({ code: 'x', message: 'boom' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest test/jobs.repository.spec.ts`
Expected: FAIL — `../src/jobs/jobs.repository` not found.

- [ ] **Step 3: Implement types and repository**

`src/jobs/jobs.types.ts`:
```ts
import { Pool } from 'pg';

export type Queryable = Pick<Pool, 'query'>;
export type JobType = 'process_meeting' | 'enroll_speaker';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface JobRow {
  id: string;
  type: JobType;
  meeting_id: string | null;
  payload: any;
  status: JobStatus;
  stage: string | null;
  progress: number;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: Date | null;
  error: any;
  created_at: Date;
  updated_at: Date;
}
```

`src/jobs/jobs.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { JobRow, JobType, Queryable } from './jobs.types';

@Injectable()
export class JobsRepository {
  async enqueue(
    exec: Queryable,
    args: { type: JobType; meetingId: string | null; payload: unknown },
  ): Promise<JobRow> {
    const { rows } = await exec.query<JobRow>(
      `INSERT INTO job(type, meeting_id, payload)
       VALUES($1, $2, $3::jsonb) RETURNING *`,
      [args.type, args.meetingId, JSON.stringify(args.payload)],
    );
    return rows[0];
  }

  async claim(exec: Queryable, workerId: string): Promise<JobRow | null> {
    const { rows } = await exec.query<JobRow>(
      `UPDATE job SET status='running', locked_by=$1, locked_at=now(),
                      attempts = attempts + 1, updated_at=now()
       WHERE id IN (
         SELECT id FROM job WHERE status='queued'
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
       ) RETURNING *`,
      [workerId],
    );
    return rows[0] ?? null;
  }

  async heartbeat(exec: Queryable, jobId: string, workerId: string): Promise<void> {
    await exec.query(
      `UPDATE job SET locked_at=now(), updated_at=now()
       WHERE id=$1 AND locked_by=$2 AND status='running'`,
      [jobId, workerId],
    );
  }

  async setStage(exec: Queryable, jobId: string, stage: string, progress: number): Promise<void> {
    await exec.query(
      `UPDATE job SET stage=$2, progress=$3, updated_at=now() WHERE id=$1`,
      [jobId, stage, progress],
    );
  }

  async complete(exec: Queryable, jobId: string): Promise<void> {
    await exec.query(
      `UPDATE job SET status='done', progress=100, updated_at=now() WHERE id=$1`,
      [jobId],
    );
  }

  async fail(exec: Queryable, jobId: string, error: object): Promise<void> {
    await exec.query(
      `UPDATE job SET status='failed', error=$2::jsonb, updated_at=now() WHERE id=$1`,
      [jobId, JSON.stringify(error)],
    );
  }
}
```

> Scope note: `complete()`/`fail()` update **`job` only** — intentional. On normal worker completion/failure the linked `meeting.status`/`speaker.enrollment_status` transitions happen in the **worker's** persist/enroll transaction (Plan 2), so they stay consistent with the result write. Plan 1 only propagates status on the **crash path** via the reaper (Task 6).

`src/jobs/jobs.module.ts` (partial — reaper added in Task 6):
```ts
import { Global, Module } from '@nestjs/common';
import { JobsRepository } from './jobs.repository';

@Global()
@Module({ providers: [JobsRepository], exports: [JobsRepository] })
export class JobsModule {}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest test/jobs.repository.spec.ts`
Expected: PASS (5 tests). The concurrency test confirms `SKIP LOCKED` gives the job to exactly one claimer.

- [ ] **Step 5: Commit**

```bash
git add src/jobs test/jobs.repository.spec.ts
git commit -m "feat: JobsRepository with SKIP LOCKED claim (attempts++ at claim)"
```

---

## Task 6: Stale lock reaper

**Files:**
- Modify: `src/jobs/jobs.repository.ts` (add `reapStale`)
- Create: `src/jobs/reaper.service.ts`
- Modify: `src/jobs/jobs.module.ts` (register `ReaperService`)
- Test: `test/reaper.spec.ts`

**Interfaces:**
- Produces: `JobsRepository.reapStale(exec: Queryable, staleMinutes: number): Promise<{ requeued: number; failed: number }>` — requeues stale `running` jobs with `attempts < max_attempts`; fails the rest and propagates failure to the linked `meeting.status='failed'` (process_meeting) / `speaker.enrollment_status='failed'` (enroll_speaker).
- Produces: `ReaperService` with `@Cron` calling `reapStale(db.pool, ENV.REAPER_STALE_MINUTES)`.

- [ ] **Step 1: Write the failing test**

`test/reaper.spec.ts`:
```ts
import { startTestDb, StartedTestDb } from './db';
import { JobsRepository } from '../src/jobs/jobs.repository';

describe('reapStale', () => {
  let db: StartedTestDb;
  let repo: JobsRepository;
  beforeAll(async () => { db = await startTestDb(); repo = new JobsRepository(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  // helper: create a running job whose lock is `minutesAgo` old, with given attempts
  async function runningJob(opts: { minutesAgo: number; attempts: number; maxAttempts: number }) {
    const m = await db.pool.query(`INSERT INTO meeting(audio_key, status) VALUES('k','processing') RETURNING id`);
    const mid = m.rows[0].id;
    const j = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status, locked_by, locked_at, attempts, max_attempts)
       VALUES('process_meeting',$1,'{}','running','w',
              now() - ($2 || ' minutes')::interval, $3, $4) RETURNING id`,
      [mid, String(opts.minutesAgo), opts.attempts, opts.maxAttempts],
    );
    await db.pool.query(`UPDATE meeting SET current_job_id=$1 WHERE id=$2`, [j.rows[0].id, mid]);
    return { jobId: j.rows[0].id as string, meetingId: mid as string };
  }

  it('requeues a stale job that has attempts left', async () => {
    const { jobId } = await runningJob({ minutesAgo: 45, attempts: 1, maxAttempts: 3 });
    const res = await repo.reapStale(db.pool, 30);
    expect(res.requeued).toBe(1);
    const { rows } = await db.pool.query('SELECT status, locked_by FROM job WHERE id=$1', [jobId]);
    expect(rows[0].status).toBe('queued');
    expect(rows[0].locked_by).toBeNull();
  });

  it('fails a stale job out of attempts and marks the meeting failed', async () => {
    const { jobId, meetingId } = await runningJob({ minutesAgo: 45, attempts: 3, maxAttempts: 3 });
    const res = await repo.reapStale(db.pool, 30);
    expect(res.failed).toBe(1);
    const job = await db.pool.query('SELECT status, error FROM job WHERE id=$1', [jobId]);
    expect(job.rows[0].status).toBe('failed');
    expect(job.rows[0].error.code).toBe('stale_worker');
    const mt = await db.pool.query('SELECT status FROM meeting WHERE id=$1', [meetingId]);
    expect(mt.rows[0].status).toBe('failed');
  });

  it('leaves fresh running jobs alone', async () => {
    await runningJob({ minutesAgo: 5, attempts: 1, maxAttempts: 3 });
    const res = await repo.reapStale(db.pool, 30);
    expect(res).toEqual({ requeued: 0, failed: 0 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest test/reaper.spec.ts`
Expected: FAIL — `repo.reapStale is not a function`.

- [ ] **Step 3: Implement reapStale and ReaperService**

Add to `src/jobs/jobs.repository.ts`:
```ts
  async reapStale(
    exec: Queryable,
    staleMinutes: number,
  ): Promise<{ requeued: number; failed: number }> {
    const { rows } = await exec.query<{ requeued: string; failed: string }>(
      `WITH stale AS (
         SELECT id, type, meeting_id, attempts, max_attempts, stage
         FROM job
         WHERE status='running'
           AND locked_at < now() - ($1 || ' minutes')::interval
         FOR UPDATE SKIP LOCKED
       ),
       requeued AS (
         UPDATE job SET status='queued', locked_by=NULL, locked_at=NULL, updated_at=now()
         WHERE id IN (SELECT id FROM stale WHERE attempts < max_attempts)
         RETURNING id
       ),
       failed AS (
         UPDATE job j SET status='failed', updated_at=now(),
           error = jsonb_build_object('code','stale_worker',
                                       'message','worker lock expired',
                                       'stage', j.stage)
         WHERE id IN (SELECT id FROM stale WHERE attempts >= max_attempts)
         RETURNING id, type, meeting_id
       ),
       fail_meetings AS (
         UPDATE meeting m SET status='failed',
           error = jsonb_build_object('code','stale_worker','message','processing worker lost')
         WHERE m.id IN (SELECT meeting_id FROM failed WHERE type='process_meeting')
         RETURNING m.id
       ),
       fail_speakers AS (
         UPDATE speaker s SET enrollment_status='failed',
           enrollment_error = jsonb_build_object('code','stale_worker','message','enroll worker lost')
         WHERE s.current_job_id IN (SELECT id FROM failed WHERE type='enroll_speaker')
         RETURNING s.id
       )
       SELECT (SELECT count(*) FROM requeued) AS requeued,
              (SELECT count(*) FROM failed)   AS failed`,
      [String(staleMinutes)],
    );
    return { requeued: Number(rows[0].requeued), failed: Number(rows[0].failed) };
  }
```

`src/jobs/reaper.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';
import { JobsRepository } from './jobs.repository';
import { loadEnv } from '../config/env';

@Injectable()
export class ReaperService {
  private readonly logger = new Logger(ReaperService.name);
  constructor(private readonly db: DatabaseService, private readonly jobs: JobsRepository) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reap() {
    const res = await this.jobs.reapStale(this.db.pool, loadEnv().REAPER_STALE_MINUTES);
    if (res.requeued || res.failed) {
      this.logger.warn(`reaper: requeued=${res.requeued} failed=${res.failed}`);
    }
  }
}
```

`src/jobs/jobs.module.ts` (final):
```ts
import { Global, Module } from '@nestjs/common';
import { JobsRepository } from './jobs.repository';
import { ReaperService } from './reaper.service';

@Global()
@Module({ providers: [JobsRepository, ReaperService], exports: [JobsRepository] })
export class JobsModule {}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest test/reaper.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/jobs test/reaper.spec.ts
git commit -m "feat: stale-lock reaper (requeue/fail + denormalized status propagation)"
```

---

## Task 7: Meetings — 업로드 · 목록 · 조회 · 상태 · 재처리

**Files:**
- Create: `src/storage/upload-options.ts` (shared multer diskStorage config, reused by speakers in Task 9)
- Create: `src/meetings/meetings.repository.ts`, `src/meetings/meetings.service.ts`, `src/meetings/meetings.controller.ts`, `src/meetings/meetings.module.ts` (replaces stub)
- Test: `test/meetings.e2e-spec.ts`

**Interfaces:**
- Consumes: `JobsRepository.enqueue`, `StorageService.meetingKey/save`, `buildProcessMeetingPayload`, `DatabaseService.withTransaction`.
- Produces: `MeetingsRepository` with `create`, `list`, `findById`, `findUtterances`, `findStatus`, `bumpVersionForReprocess`. `MeetingsService.upload/list/get/getStatus/reprocess`.
- Produces: REST — `POST /meetings`, `GET /meetings`, `GET /meetings/:id`, `GET /meetings/:id/status`, `POST /meetings/:id/reprocess`.

- [ ] **Step 1: Write the failing e2e test**

`test/meetings.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('meetings', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  const srv = () => app.getHttpServer();

  it('POST /meetings stores file, creates meeting + queued job + current_job_id', async () => {
    const res = await request(srv())
      .post('/meetings')
      .field('title', '기획회의')
      .attach('audio', Buffer.from('fake-audio'), { filename: 'rec.m4a', contentType: 'audio/mp4' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('uploaded');
    expect(res.body.title).toBe('기획회의');
    expect(res.body.audio_key).toMatch(/^meetings\/.+\/original\.m4a$/);
    expect(res.body.current_job_id).toBeTruthy();

    const job = await db.pool.query('SELECT * FROM job WHERE id=$1', [res.body.current_job_id]);
    expect(job.rows[0].type).toBe('process_meeting');
    expect(job.rows[0].status).toBe('queued');
    expect(job.rows[0].payload.audio_key).toBe(res.body.audio_key);
    expect(job.rows[0].payload.processing_version).toBe(0);
  });

  it('POST /meetings rejects non-audio mime', async () => {
    const res = await request(srv())
      .post('/meetings')
      .attach('audio', Buffer.from('x'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });

  it('GET /meetings/:id returns meeting with ordered utterances', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,speaker_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES ($1,NULL,'SPEAKER_00',1000,2000,'두번째','ok',1,0),
              ($1,NULL,'SPEAKER_00',0,900,'첫번째','ok',0,0)`,
      [mid],
    );
    const res = await request(srv()).get(`/meetings/${mid}`);
    expect(res.status).toBe(200);
    expect(res.body.utterances.map((u: any) => u.text)).toEqual(['첫번째', '두번째']);
  });

  it('GET /meetings/:id → 404 for unknown id', async () => {
    const res = await request(srv()).get('/meetings/99999999-9999-9999-9999-999999999999');
    expect(res.status).toBe(404);
  });

  it('GET /meetings/:id/status reflects job stage/progress', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    await db.pool.query(
      `UPDATE job SET status='running', stage='stt', progress=60 WHERE id=$1`,
      [created.body.current_job_id],
    );
    const res = await request(srv()).get(`/meetings/${mid}/status`);
    expect(res.body).toMatchObject({ status: 'uploaded', stage: 'stt', progress: 60 });
  });

  it('POST /meetings/:id/reprocess bumps version + enqueues new job (done only)', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    // not allowed while uploaded
    expect((await request(srv()).post(`/meetings/${mid}/reprocess`)).status).toBe(409);
    await db.pool.query(`UPDATE meeting SET status='done' WHERE id=$1`, [mid]);
    const res = await request(srv()).post(`/meetings/${mid}/reprocess`);
    expect(res.status).toBe(202);
    const mt = await db.pool.query('SELECT processing_version, current_job_id, status FROM meeting WHERE id=$1', [mid]);
    expect(mt.rows[0].processing_version).toBe(1);
    expect(mt.rows[0].status).toBe('uploaded');
    const job = await db.pool.query('SELECT payload, status FROM job WHERE id=$1', [mt.rows[0].current_job_id]);
    expect(job.rows[0].payload.processing_version).toBe(1);
    expect(job.rows[0].payload.reprocess).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest test/meetings.e2e-spec.ts`
Expected: FAIL — routes 404 / module not wired.

- [ ] **Step 3: Implement upload options, repository, service, controller, module**

`src/storage/upload-options.ts` (diskStorage → temp file; never buffers the upload in memory; `maxUploadBytes()` is import-safe — see Task 1):
```ts
import { diskStorage } from 'multer';
import * as os from 'os';
import * as crypto from 'crypto';
import { maxUploadBytes } from '../config/env';

export const uploadInterceptorOptions = {
  storage: diskStorage({
    destination: os.tmpdir(),
    filename: (_req: any, _file: any, cb: (err: Error | null, name: string) => void) =>
      cb(null, `dw-upload-${crypto.randomUUID()}`),
  }),
  limits: { fileSize: maxUploadBytes() },
};
```

`src/meetings/meetings.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Queryable } from '../jobs/jobs.types';

export interface MeetingRow {
  id: string; title: string | null; original_filename: string | null;
  audio_key: string; normalized_key: string | null; recorded_at: Date | null;
  duration_ms: number | null; status: string; current_job_id: string | null;
  processing_version: number; error: any; created_at: Date;
}

@Injectable()
export class MeetingsRepository {
  async create(
    exec: Queryable,
    args: { audioKey: string; title: string | null; originalFilename: string | null; recordedAt: string | null },
  ): Promise<MeetingRow> {
    const { rows } = await exec.query<MeetingRow>(
      `INSERT INTO meeting(title, original_filename, audio_key, recorded_at, status)
       VALUES($1,$2,$3,$4,'uploaded') RETURNING *`,
      [args.title, args.originalFilename, args.audioKey, args.recordedAt],
    );
    return rows[0];
  }
  async setCurrentJob(exec: Queryable, meetingId: string, jobId: string): Promise<MeetingRow> {
    const { rows } = await exec.query<MeetingRow>(
      `UPDATE meeting SET current_job_id=$2 WHERE id=$1 RETURNING *`,
      [meetingId, jobId],
    );
    return rows[0];
  }
  async list(exec: Queryable): Promise<MeetingRow[]> {
    const { rows } = await exec.query<MeetingRow>(`SELECT * FROM meeting ORDER BY created_at DESC`);
    return rows;
  }
  async findById(exec: Queryable, id: string): Promise<MeetingRow | null> {
    const { rows } = await exec.query<MeetingRow>(`SELECT * FROM meeting WHERE id=$1`, [id]);
    return rows[0] ?? null;
  }
  async findUtterances(exec: Queryable, meetingId: string) {
    const { rows } = await exec.query(
      `SELECT * FROM utterance WHERE meeting_id=$1 ORDER BY order_index ASC`,
      [meetingId],
    );
    return rows;
  }
  async findStatus(exec: Queryable, id: string) {
    const { rows } = await exec.query(
      `SELECT m.status, j.stage, j.progress, m.error
       FROM meeting m LEFT JOIN job j ON j.id = m.current_job_id
       WHERE m.id=$1`,
      [id],
    );
    return rows[0] ?? null;
  }
  // reprocess: bump version + reset status, return new version (single short tx via caller)
  async bumpVersionForReprocess(exec: Queryable, id: string): Promise<number> {
    const { rows } = await exec.query<{ processing_version: number }>(
      `UPDATE meeting SET processing_version = processing_version + 1, status='uploaded', error=NULL
       WHERE id=$1 RETURNING processing_version`,
      [id],
    );
    return rows[0].processing_version;
  }
}
```

`src/meetings/meetings.service.ts`:
```ts
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { JobsRepository } from '../jobs/jobs.repository';
import { buildProcessMeetingPayload } from '../contracts/job-payload.schema';
import { MeetingsRepository } from './meetings.repository';
import * as crypto from 'crypto';
import * as fs from 'fs';

const AUDIO_MIME = /^audio\//;

async function unlinkQuietly(p?: string) {
  if (!p) return;
  try { await fs.promises.unlink(p); } catch { /* already gone */ }
}

@Injectable()
export class MeetingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly jobs: JobsRepository,
    private readonly meetings: MeetingsRepository,
  ) {}

  // Validation scope (Plan 1): MIME + extension + size only. Deep audio-integrity
  // validation (ffmpeg probe) happens in the Plan 2 worker normalize stage.
  async upload(file: Express.Multer.File | undefined, body: { title?: string; recorded_at?: string }) {
    if (!file) throw new BadRequestException('audio file required');
    if (!AUDIO_MIME.test(file.mimetype)) {
      await unlinkQuietly(file.path); // remove the temp file multer already wrote
      throw new BadRequestException('file must be audio/*');
    }

    const meetingId = crypto.randomUUID();
    const audioKey = this.storage.meetingKey(meetingId, file.originalname);
    await this.storage.saveFromTemp(audioKey, file.path);

    return this.db.withTransaction(async (c) => {
      const meeting = await c.query(
        `INSERT INTO meeting(id, title, original_filename, audio_key, recorded_at, status)
         VALUES($1,$2,$3,$4,$5,'uploaded') RETURNING *`,
        [meetingId, body.title ?? null, file.originalname, audioKey, body.recorded_at ?? null],
      );
      const payload = buildProcessMeetingPayload({
        meetingId, audioKey, processingVersion: 0, reprocess: false,
      });
      const job = await this.jobs.enqueue(c, { type: 'process_meeting', meetingId, payload });
      const updated = await this.meetings.setCurrentJob(c, meetingId, job.id);
      return updated;
    });
  }

  async list() { return this.meetings.list(this.db.pool); }

  async get(id: string) {
    const meeting = await this.meetings.findById(this.db.pool, id);
    if (!meeting) throw new NotFoundException('meeting not found');
    const utterances = await this.meetings.findUtterances(this.db.pool, id);
    return { ...meeting, utterances };
  }

  async getStatus(id: string) {
    const status = await this.meetings.findStatus(this.db.pool, id);
    if (!status) throw new NotFoundException('meeting not found');
    return status;
  }

  async reprocess(id: string) {
    const meeting = await this.meetings.findById(this.db.pool, id);
    if (!meeting) throw new NotFoundException('meeting not found');
    if (meeting.status !== 'done' && meeting.status !== 'failed') {
      throw new ConflictException('reprocess allowed only when status is done or failed');
    }
    return this.db.withTransaction(async (c) => {
      const version = await this.meetings.bumpVersionForReprocess(c, id);
      const payload = buildProcessMeetingPayload({
        meetingId: id, audioKey: meeting.audio_key, processingVersion: version, reprocess: true,
      });
      const job = await this.jobs.enqueue(c, { type: 'process_meeting', meetingId: id, payload });
      await this.meetings.setCurrentJob(c, id, job.id);
      return { meeting_id: id, processing_version: version, job_id: job.id };
    });
  }
}
```

`src/meetings/meetings.controller.ts`:
```ts
import {
  Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MeetingsService } from './meetings.service';
import { uploadInterceptorOptions } from '../storage/upload-options';

@Controller('meetings')
export class MeetingsController {
  constructor(private readonly service: MeetingsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('audio', uploadInterceptorOptions))
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { title?: string; recorded_at?: string },
  ) {
    return this.service.upload(file, body);
  }

  @Get()
  list() { return this.service.list(); }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) { return this.service.get(id); }

  @Get(':id/status')
  status(@Param('id', ParseUUIDPipe) id: string) { return this.service.getStatus(id); }

  @Post(':id/reprocess')
  @HttpCode(202)
  reprocess(@Param('id', ParseUUIDPipe) id: string) { return this.service.reprocess(id); }
}
```

`src/meetings/meetings.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { MeetingsController } from './meetings.controller';
import { MeetingsService } from './meetings.service';
import { MeetingsRepository } from './meetings.repository';

@Module({
  controllers: [MeetingsController],
  providers: [MeetingsService, MeetingsRepository],
  exports: [MeetingsRepository, MeetingsService],
})
export class MeetingsModule {}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest test/meetings.e2e-spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/meetings test/meetings.e2e-spec.ts
git commit -m "feat: meetings upload/list/get/status/reprocess endpoints"
```

---

## Task 8: 오디오 Range 스트리밍

**Files:**
- Modify: `src/meetings/meetings.controller.ts` (add `GET :id/audio`)
- Modify: `src/meetings/meetings.service.ts` (add `getAudioDescriptor`)
- Test: `test/audio.e2e-spec.ts`

**Interfaces:**
- Consumes: `MeetingsRepository.findById`, `StorageService.stat/createReadStream`.
- Produces: `MeetingsService.getAudioDescriptor(id): Promise<{ key: string; size: number }>` (404 if meeting missing). Controller streams with HTTP Range (206) or full body (200).

- [ ] **Step 1: Write the failing test**

`test/audio.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('audio streaming', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  it('serves full body (200) and a byte range (206)', async () => {
    const created = await request(app.getHttpServer())
      .post('/meetings').attach('audio', Buffer.from('0123456789'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;

    const full = await request(app.getHttpServer()).get(`/meetings/${mid}/audio`);
    expect(full.status).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.body.toString()).toBe('0123456789');

    const part = await request(app.getHttpServer())
      .get(`/meetings/${mid}/audio`).set('Range', 'bytes=2-5');
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 2-5/10');
    expect(part.body.toString()).toBe('2345');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest test/audio.e2e-spec.ts`
Expected: FAIL — `GET /meetings/:id/audio` returns 404 (route missing).

- [ ] **Step 3: Implement audio descriptor + streaming controller**

Add to `src/meetings/meetings.service.ts`:
```ts
  async getAudioDescriptor(id: string): Promise<{ key: string; size: number }> {
    const meeting = await this.meetings.findById(this.db.pool, id);
    if (!meeting) throw new NotFoundException('meeting not found');
    const key = meeting.normalized_key ?? meeting.audio_key;
    const stat = await this.storage.stat(key);
    return { key, size: stat.size };
  }

  audioStream(key: string, range?: { start: number; end: number }) {
    return this.storage.createReadStream(key, range);
  }
```

Add to `src/meetings/meetings.controller.ts` (imports: add `Headers, Req, Res`; `import { Request, Response } from 'express'`):
```ts
  @Get(':id/audio')
  async audio(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ) {
    const { key, size } = await this.service.getAudioDescriptor(id);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/octet-stream');

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (start > end || end >= size) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      return this.service.audioStream(key, { start, end }).pipe(res);
    }
    res.status(200);
    res.setHeader('Content-Length', String(size));
    return this.service.audioStream(key).pipe(res);
  }
```

> Place the `@Get(':id/audio')` handler in the controller. `@Res()` opts out of Nest's serializer, which is correct for streaming.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest test/audio.e2e-spec.ts`
Expected: PASS (200 full body + 206 range with correct `Content-Range`).

- [ ] **Step 5: Commit**

```bash
git add src/meetings test/audio.e2e-spec.ts
git commit -m "feat: range-aware audio streaming endpoint"
```

---

## Task 9: Speakers — 등록 · 목록 · 상태

**Files:**
- Create: `src/speakers/speakers.repository.ts`, `src/speakers/speakers.service.ts`, `src/speakers/speakers.controller.ts`, `src/speakers/speakers.module.ts` (replaces stub)
- Test: `test/speakers.e2e-spec.ts`

**Interfaces:**
- Consumes: `JobsRepository.enqueue`, `StorageService.speakerKey/save`, `buildEnrollSpeakerPayload`, `DatabaseService.withTransaction`.
- Produces: `SpeakersRepository` (`create`, `setCurrentJob`, `list`, `findById`). `SpeakersService.enroll/list/get`.
- Produces: REST — `POST /speakers`, `GET /speakers`, `GET /speakers/:id`.

- [ ] **Step 1: Write the failing test**

`test/speakers.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('speakers', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });
  const srv = () => app.getHttpServer();

  it('POST /speakers creates pending speaker + enroll_speaker job', async () => {
    const res = await request(srv())
      .post('/speakers').field('name', '김영재')
      .attach('audio', Buffer.from('sample'), { filename: 'voice.wav', contentType: 'audio/wav' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('김영재');
    expect(res.body.enrollment_status).toBe('pending');
    expect(res.body.current_job_id).toBeTruthy();
    const job = await db.pool.query('SELECT * FROM job WHERE id=$1', [res.body.current_job_id]);
    expect(job.rows[0].type).toBe('enroll_speaker');
    expect(job.rows[0].payload.speaker_id).toBe(res.body.id);
  });

  it('POST /speakers requires name and audio', async () => {
    expect((await request(srv()).post('/speakers').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' })).status).toBe(400);
    expect((await request(srv()).post('/speakers').field('name', 'x')).status).toBe(400);
  });

  it('GET /speakers/:id returns enrollment_status', async () => {
    const created = await request(srv()).post('/speakers').field('name', 'A').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const res = await request(srv()).get(`/speakers/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.enrollment_status).toBe('pending');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest test/speakers.e2e-spec.ts`
Expected: FAIL — routes missing.

- [ ] **Step 3: Implement repository, service, controller, module**

`src/speakers/speakers.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Queryable } from '../jobs/jobs.types';

export interface SpeakerRow {
  id: string; name: string; enrollment_status: string;
  current_job_id: string | null; enrollment_error: any; created_at: Date;
}

@Injectable()
export class SpeakersRepository {
  async create(exec: Queryable, id: string, name: string): Promise<SpeakerRow> {
    const { rows } = await exec.query<SpeakerRow>(
      `INSERT INTO speaker(id, name, enrollment_status) VALUES($1,$2,'pending') RETURNING *`,
      [id, name],
    );
    return rows[0];
  }
  async setCurrentJob(exec: Queryable, id: string, jobId: string): Promise<SpeakerRow> {
    const { rows } = await exec.query<SpeakerRow>(
      `UPDATE speaker SET current_job_id=$2 WHERE id=$1 RETURNING *`, [id, jobId],
    );
    return rows[0];
  }
  async list(exec: Queryable): Promise<SpeakerRow[]> {
    const { rows } = await exec.query<SpeakerRow>(`SELECT * FROM speaker ORDER BY created_at DESC`);
    return rows;
  }
  async findById(exec: Queryable, id: string): Promise<SpeakerRow | null> {
    const { rows } = await exec.query<SpeakerRow>(`SELECT * FROM speaker WHERE id=$1`, [id]);
    return rows[0] ?? null;
  }
}
```

`src/speakers/speakers.service.ts`:
```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { JobsRepository } from '../jobs/jobs.repository';
import { buildEnrollSpeakerPayload } from '../contracts/job-payload.schema';
import { SpeakersRepository } from './speakers.repository';
import * as crypto from 'crypto';
import * as fs from 'fs';

const AUDIO_MIME = /^audio\//;

async function unlinkQuietly(p?: string) {
  if (!p) return;
  try { await fs.promises.unlink(p); } catch { /* already gone */ }
}

@Injectable()
export class SpeakersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly jobs: JobsRepository,
    private readonly speakers: SpeakersRepository,
  ) {}

  // Validation scope (Plan 1): MIME + size only (see MeetingsService).
  async enroll(file: Express.Multer.File | undefined, body: { name?: string }) {
    if (!body?.name) { await unlinkQuietly(file?.path); throw new BadRequestException('name required'); }
    if (!file) throw new BadRequestException('audio file required');
    if (!AUDIO_MIME.test(file.mimetype)) {
      await unlinkQuietly(file.path);
      throw new BadRequestException('file must be audio/*');
    }

    const speakerId = crypto.randomUUID();
    const audioKey = this.storage.speakerKey(speakerId, file.originalname);
    await this.storage.saveFromTemp(audioKey, file.path);

    return this.db.withTransaction(async (c) => {
      await this.speakers.create(c, speakerId, body.name!);
      const payload = buildEnrollSpeakerPayload({ speakerId, audioKey });
      const job = await this.jobs.enqueue(c, { type: 'enroll_speaker', meetingId: null, payload });
      return this.speakers.setCurrentJob(c, speakerId, job.id);
    });
  }

  list() { return this.speakers.list(this.db.pool); }

  async get(id: string) {
    const s = await this.speakers.findById(this.db.pool, id);
    if (!s) throw new NotFoundException('speaker not found');
    return s;
  }
}
```

`src/speakers/speakers.controller.ts`:
```ts
import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SpeakersService } from './speakers.service';
import { uploadInterceptorOptions } from '../storage/upload-options';

@Controller('speakers')
export class SpeakersController {
  constructor(private readonly service: SpeakersService) {}

  @Post()
  @UseInterceptors(FileInterceptor('audio', uploadInterceptorOptions))
  enroll(@UploadedFile() file: Express.Multer.File, @Body() body: { name?: string }) {
    return this.service.enroll(file, body);
  }

  @Get()
  list() { return this.service.list(); }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) { return this.service.get(id); }
}
```

`src/speakers/speakers.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { SpeakersController } from './speakers.controller';
import { SpeakersService } from './speakers.service';
import { SpeakersRepository } from './speakers.repository';

@Module({
  controllers: [SpeakersController],
  providers: [SpeakersService, SpeakersRepository],
  exports: [SpeakersRepository],
})
export class SpeakersModule {}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest test/speakers.e2e-spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/speakers test/speakers.e2e-spec.ts
git commit -m "feat: speaker enrollment endpoints with pending status + enroll job"
```

---

## Task 10: 미식별 클러스터 resolve (clusterId 기반 트랜잭션)

**Files:**
- Create: `src/meetings/clusters.controller.ts`
- Modify: `src/meetings/meetings.service.ts` (add `resolveCluster`)
- Modify: `src/meetings/meetings.repository.ts` (add cluster/utterance/voiceprint helpers)
- Modify: `src/meetings/meetings.module.ts` (register `ClustersController`)
- Test: `test/clusters.e2e-spec.ts`

**Interfaces:**
- Consumes: `DatabaseService.withTransaction`, `loadEnv().EMBEDDING_MODEL/EMBEDDING_DIM`.
- Produces: `MeetingsService.resolveCluster(meetingId, clusterId, body: { speaker_id?: string; new_name?: string }): Promise<{ speaker_id: string; updated_utterances: number }>`.
- Produces: REST — `POST /meetings/:id/clusters/:clusterId/resolve`.
- Behavior (single tx): load cluster by (`clusterId`,`meetingId`) → 404; resolve target speaker (existing `speaker_id` → 404 if missing; or `new_name` → create speaker with `enrollment_status='ready'`); set `meeting_cluster.resolved_speaker_id`; bulk `UPDATE utterance SET speaker_id` for matching `diar_label`; if `centroid` not null, `INSERT INTO voiceprint` from the centroid (`source='cluster_resolve'`).

- [ ] **Step 1: Write the failing test**

`test/clusters.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('cluster resolve', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });
  const srv = () => app.getHttpServer();

  // seed: meeting + one unidentified cluster (with centroid) + two utterances on that label
  async function seed() {
    const m = await db.pool.query(`INSERT INTO meeting(audio_key,status) VALUES('k','done') RETURNING id`);
    const mid = m.rows[0].id;
    const vec = '[' + Array(192).fill(0.2).join(',') + ']';
    const c = await db.pool.query(
      `INSERT INTO meeting_cluster(meeting_id,diar_label,centroid,processing_version)
       VALUES($1,'SPEAKER_00',$2::vector,0) RETURNING id`, [mid, vec]);
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,order_index,processing_version)
       VALUES($1,'SPEAKER_00',0,1,0,0),($1,'SPEAKER_00',2,3,1,0)`, [mid]);
    return { mid, clusterId: c.rows[0].id as string };
  }

  it('resolves to a NEW speaker (ready), bulk-updates utterances, stores a voiceprint', async () => {
    const { mid, clusterId } = await seed();
    const res = await request(srv())
      .post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ new_name: '박지원' });
    expect(res.status).toBe(200);
    expect(res.body.updated_utterances).toBe(2);

    const sp = await db.pool.query('SELECT * FROM speaker WHERE id=$1', [res.body.speaker_id]);
    expect(sp.rows[0].enrollment_status).toBe('ready');
    expect(sp.rows[0].name).toBe('박지원');

    const utt = await db.pool.query('SELECT speaker_id FROM utterance WHERE meeting_id=$1', [mid]);
    expect(utt.rows.every((u) => u.speaker_id === res.body.speaker_id)).toBe(true);

    const vp = await db.pool.query('SELECT source FROM voiceprint WHERE speaker_id=$1', [res.body.speaker_id]);
    expect(vp.rows.length).toBe(1);
    expect(vp.rows[0].source).toBe('cluster_resolve');

    const cl = await db.pool.query('SELECT resolved_speaker_id FROM meeting_cluster WHERE id=$1', [clusterId]);
    expect(cl.rows[0].resolved_speaker_id).toBe(res.body.speaker_id);
  });

  it('resolves to an EXISTING speaker', async () => {
    const { mid, clusterId } = await seed();
    const ex = await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('기존','ready') RETURNING id`);
    const res = await request(srv())
      .post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ speaker_id: ex.rows[0].id });
    expect(res.status).toBe(200);
    expect(res.body.speaker_id).toBe(ex.rows[0].id);
    expect(res.body.updated_utterances).toBe(2);
  });

  it('404 when cluster does not belong to meeting', async () => {
    const { clusterId } = await seed();
    const other = await db.pool.query(`INSERT INTO meeting(audio_key,status) VALUES('k2','done') RETURNING id`);
    const res = await request(srv())
      .post(`/meetings/${other.rows[0].id}/clusters/${clusterId}/resolve`).send({ new_name: 'x' });
    expect(res.status).toBe(404);
  });

  it('400 when neither speaker_id nor new_name provided', async () => {
    const { mid, clusterId } = await seed();
    const res = await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({});
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest test/clusters.e2e-spec.ts`
Expected: FAIL — route missing.

- [ ] **Step 3: Implement repository helpers, service method, controller**

Add to `src/meetings/meetings.repository.ts`:
```ts
  async findClusterInMeeting(exec: Queryable, meetingId: string, clusterId: string) {
    const { rows } = await exec.query(
      `SELECT id, meeting_id, diar_label, (centroid IS NOT NULL) AS has_centroid
       FROM meeting_cluster WHERE id=$1 AND meeting_id=$2`,
      [clusterId, meetingId],
    );
    return rows[0] ?? null;
  }
  async setClusterResolved(exec: Queryable, clusterId: string, speakerId: string) {
    await exec.query(`UPDATE meeting_cluster SET resolved_speaker_id=$2 WHERE id=$1`, [clusterId, speakerId]);
  }
  async bulkAssignSpeaker(exec: Queryable, meetingId: string, diarLabel: string, speakerId: string): Promise<number> {
    const res = await exec.query(
      `UPDATE utterance SET speaker_id=$3 WHERE meeting_id=$1 AND diar_label=$2`,
      [meetingId, diarLabel, speakerId],
    );
    return res.rowCount ?? 0;
  }
  // copy the cluster centroid into a voiceprint (vector stays in SQL, no JS round-trip)
  async voiceprintFromClusterCentroid(
    exec: Queryable, clusterId: string, speakerId: string, model: string, dimension: number,
  ): Promise<void> {
    await exec.query(
      `INSERT INTO voiceprint(speaker_id, embedding, model, dimension, source)
       SELECT $2, centroid, $3, $4, 'cluster_resolve'
       FROM meeting_cluster WHERE id=$1 AND centroid IS NOT NULL`,
      [clusterId, speakerId, model, dimension],
    );
  }
```

Add to `src/meetings/meetings.service.ts` (imports: add `loadEnv` from `../config/env`):
```ts
  async resolveCluster(
    meetingId: string,
    clusterId: string,
    body: { speaker_id?: string; new_name?: string },
  ): Promise<{ speaker_id: string; updated_utterances: number }> {
    if (!body.speaker_id && !body.new_name) {
      throw new BadRequestException('speaker_id or new_name required');
    }
    const env = loadEnv();
    return this.db.withTransaction(async (c) => {
      const cluster = await this.meetings.findClusterInMeeting(c, meetingId, clusterId);
      if (!cluster) throw new NotFoundException('cluster not found in meeting');

      let speakerId: string;
      if (body.speaker_id) {
        const exists = await c.query('SELECT 1 FROM speaker WHERE id=$1', [body.speaker_id]);
        if (!exists.rowCount) throw new NotFoundException('speaker not found');
        speakerId = body.speaker_id;
      } else {
        const created = await c.query(
          `INSERT INTO speaker(name, enrollment_status) VALUES($1,'ready') RETURNING id`,
          [body.new_name],
        );
        speakerId = created.rows[0].id;
      }

      await this.meetings.setClusterResolved(c, clusterId, speakerId);
      const updated = await this.meetings.bulkAssignSpeaker(c, meetingId, cluster.diar_label, speakerId);
      if (cluster.has_centroid) {
        await this.meetings.voiceprintFromClusterCentroid(
          c, clusterId, speakerId, env.EMBEDDING_MODEL, env.EMBEDDING_DIM,
        );
      }
      return { speaker_id: speakerId, updated_utterances: updated };
    });
  }
```

`src/meetings/clusters.controller.ts`:
```ts
import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { MeetingsService } from './meetings.service';

@Controller('meetings/:id/clusters')
export class ClustersController {
  constructor(private readonly service: MeetingsService) {}

  @Post(':clusterId/resolve')
  resolve(
    @Param('id', ParseUUIDPipe) meetingId: string,
    @Param('clusterId', ParseUUIDPipe) clusterId: string,
    @Body() body: { speaker_id?: string; new_name?: string },
  ) {
    return this.service.resolveCluster(meetingId, clusterId, body);
  }
}
```

Modify `src/meetings/meetings.module.ts` to register the controller:
```ts
import { Module } from '@nestjs/common';
import { MeetingsController } from './meetings.controller';
import { ClustersController } from './clusters.controller';
import { MeetingsService } from './meetings.service';
import { MeetingsRepository } from './meetings.repository';

@Module({
  controllers: [MeetingsController, ClustersController],
  providers: [MeetingsService, MeetingsRepository],
  exports: [MeetingsRepository, MeetingsService],
})
export class MeetingsModule {}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest test/clusters.e2e-spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full suite + commit**

Run: `npx jest`
Expected: PASS (all spec files green).

```bash
git add src/meetings test/clusters.e2e-spec.ts
git commit -m "feat: cluster resolve (clusterId-based) with bulk speaker assignment + voiceprint from centroid"
```

---

## Self-Review

**Spec coverage** (spec §→task):
- §3 데이터 모델 / DDL → Task 2 (마이그레이션, 모든 테이블·제약·FK·인덱스).
- §4 jobs 계약(payload/enum) → Task 4 (zod) + Task 2 (enum CHECK).
- §5.1 업로드→처리→조회 흐름 (API 측) → Task 7. (워커 측 파이프라인은 Plan 2.)
- §5.2 화자 등록 + enrollment_status → Task 9.
- §5.3 점진적 식별 resolve (clusterId) → Task 10.
- §6.1 attempts at claim → Task 5. §6.2 reaper → Task 6. §6.3 reprocess 버전 bump/enqueue → Task 7 (워커 persist 가드는 Plan 2). §6.4 denormalized status + current_job_id → Tasks 6,7.
- §7 입력 검증 → Tasks 7,9는 **MIME+크기**만 검증(diskStorage, 메모리 미적재). **ffmpeg probe 실제 오디오 검증은 Plan 2 워커 정규화로 이월**(Global Constraints에 명시; 의도된 약한 계약). 부분 실패 status 컬럼 → Task 2(스키마); 런타임 기록은 Plan 2.
- §6.4 정상 완료/실패 시 `meeting.status`/`speaker.enrollment_status` 전이 → **Plan 2 워커 책임**(persist/enroll TX 내, 거기서 계약 테스트). Plan 1은 크래시 경로(reaper, Task 6)만. (Global Constraints에 명시.)
- §8 파일 경로 안전 → Task 3 + Task 7/9 사용. §9 audio Range → Task 8.
- §10 model/dimension 메타 → Task 2(스키마) + Task 10(voiceprint insert).
- §11 테스트 전략 (claim 동시성/reaper/traversal/reprocess/resolve) → 각 task 테스트에 명시 포함.
- **Plan 2로 이월(명시)**: 워커 파이프라인(VAD~정렬), ffmpeg 정규화/probe, STT/diarization/임베딩, persist 트랜잭션의 stale 가드 *적용*, 부분 실패 런타임 기록. Plan 1은 이들이 쓸 스키마·계약·enqueue·상태 인프라를 모두 갖춘다.

**Placeholder scan:** 모든 코드 스텝에 실제 코드 포함. "TBD/적절히 처리" 없음.

**Type consistency:** `Queryable`은 Task 5에서 정의, 이후 모든 리포지토리가 동일 시그니처 사용. `buildProcessMeetingPayload`/`buildEnrollSpeakerPayload`(Task 4)를 Task 7/9가 동일 시그니처로 호출. `MeetingsRepository.findById`가 Task 7/8/10에서 일관 사용. `JobsRepository.enqueue(exec, {type, meetingId, payload})` 시그니처가 Task 7/9에서 동일.

---

## Execution Handoff (Plan 2 예고)

Plan 1 완료 시 산출물: 업로드/등록 → job enqueue → 상태/오디오/결과 서빙 → resolve 까지 동작하는, SQL 계약 레벨로 완전히 테스트된 NestJS 백엔드. **Plan 2(Python ML 워커)** 가 이 `job` 계약을 소비해 실제 파이프라인을 채우면 end-to-end가 완성된다.
