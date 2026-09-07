# 실시간 녹음(라이브 세션) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 워커 Mac의 마이크로 회의를 녹음하면서 전사·등록 화자 식별을 실시간으로 보여주고, 종료 시 기존 `process_meeting`으로 정본을 만든다.

**Architecture:** `live_session` job을 supervisor 자식이 세션 동안 붙들고 돈다. 마이크 콜백이 프레임을 writer 큐와 preview 큐에 나눠 넣고, 전용 writer 스레드가 스트리밍 헤더 WAV에 쓰며, 메인 루프는 preview 큐만 먹어 VAD → 세그먼트 → whisper → ECAPA 식별 → `live_utterance` INSERT를 돈다. 종료는 `job.stop_requested_at`이고, finalize가 회의를 `uploaded`로 바꾸며 payload에 실린 v5 `process_meeting`을 그대로 큐잉한다. API는 `POST /meetings/live`, `POST /meetings/:id/live/stop`, `GET /meetings/:id/live` 셋, FE는 1초 폴링이다.

**Tech Stack:** NestJS 10 + zod + pg(raw SQL) · Python 3.12 + pydantic v2 + psycopg3 + sounddevice + silero-vad `VADIterator` · React 19 + TanStack Query + Vite · testcontainers(양쪽) + vitest

**Spec:** `docs/superpowers/specs/2026-09-05-live-recording-design.md`

## Global Constraints

- API와 워커는 **Postgres로만** 통신한다. HTTP 경로를 새로 만들지 않는다.
- payload 계약은 **셋을 같이** 바꾼다: `be/src/contracts/job-payload.schema.ts`(zod), `be/worker/damwha_worker/contracts.py`(pydantic), `be/test/fixtures/job-payloads/*.json`(공용 fixture). DB CHECK 목록(`022`)도 같은 값이다.
- claim SQL과 reaper CTE는 TS·Python **두 벌**이다. 둘을 같이 고친다.
- `live_session`은 `max_attempts=1`, 워커 쪽 오류는 전부 PERMANENT, `requeue_for_shutdown`을 타지 않는다.
- 녹음 중 WAV 헤더의 RIFF/data 크기는 `0xFFFFFFFF`, `close()`에서만 실제 값. 주기 갱신 없음.
- 잠금 순서는 **job → meeting**(persist·fail_process_meeting과 동일). stop 엔드포인트도 job 행을 먼저 `FOR UPDATE`.
- 동시 `recording` 회의는 `meeting_single_recording_idx`(status 부분 유일 인덱스)가 막는다. API는 `23505`+그 인덱스 이름을 409로.
- 라이브 식별 결합 기준은 `process.identify.suggest_threshold`. 텍스트가 빈 클립은 행을 쓰지 않는다.
- 워커의 결정적 테스트는 `models` extra 없이 돈다: `numpy`/`soundfile`/`torch`/`sounddevice`를 **모듈 최상위에서 import하지 않는다**. 프레임은 `bytes`(int16 LE, 512샘플 = 1024바이트), 파일 읽기·쓰기는 표준 `wave`/`struct`.
- 상수: 프레임 512샘플@16kHz(32ms), 세그먼트 상한 15000ms, 최소 300ms, pre-roll 200ms, preview 큐 상한 5분, 클립 연속 실패 5회, stop 폴링 1초, 세션 상한 `LIVE_MAX_MINUTES`=240.
- FE 폴링: `recording` 1000ms, `uploaded`/`processing` 3000ms, `failed` 1회, `done` 조회 안 함.
- UI 카피·커밋 메시지·문서는 한국어. FE는 `pnpm format` 뒤 커밋. Python은 `uv run ruff check . && uv run ruff format .`.
- 커밋 메시지 끝에 `Claude-Session: https://claude.ai/code/session_01X1x9qJVRgpKfcnajp5SrbJ`를 붙인다.
- 실행 명령: API `cd be && pnpm exec jest test/<file>`, 워커 `cd be/worker && uv run pytest tests/<file> -q`, FE `cd fe && pnpm vitest run <file>`. 테스트는 Docker가 떠 있어야 한다.

---

## 파일 구조

| 경로 | 책임 |
|---|---|
| `be/src/database/migrations/022_live_session.sql` | 상태·타입·stage CHECK, 부분 유일 인덱스, `stop_requested_at`, `live_utterance` |
| `be/src/contracts/job-payload.schema.ts` | `LiveSessionPayloadSchema`, `buildLiveSessionPayload`, `ProcessMeetingPayloadV5Schema` export |
| `be/src/jobs/jobs.types.ts` | `JobType`에 `live_session`, `JobRow.stop_requested_at` |
| `be/src/jobs/jobs.repository.ts` | `enqueue(maxAttempts)`, claim 우선순위, reaper `live_session` 전파 |
| `be/src/live/live.repository.ts` | recording 회의 INSERT/조회, 세션 job 잠금, stop 플래그, 라이브 발화 조회 |
| `be/src/live/live.service.ts` | start/stop/getLive 오케스트레이션, 409 매핑 |
| `be/src/live/live.controller.ts` | 엔드포인트 셋 |
| `be/src/live/live.module.ts`, `be/src/app.module.ts` | 모듈 등록 |
| `be/test/fixtures/job-payloads/live_session.valid.json` | 공용 fixture |
| `be/worker/damwha_worker/contracts.py` | `LiveSessionPayload`(+wire), `SUPPORTED_SCHEMA_VERSIONS` |
| `be/worker/damwha_worker/errors.py` | `AUDIO_DEVICE_FAILED`, `LIVE_STT_FAILED` |
| `be/worker/damwha_worker/config.py` | `live_max_minutes` |
| `be/worker/damwha_worker/db.py` | claim 우선순위, reaper, 라이브 5함수, persist의 live 행 삭제 |
| `be/worker/damwha_worker/audio/__init__.py` | 패키지 |
| `be/worker/damwha_worker/audio/wav_writer.py` | `WavWriter`, `repair_streaming_header`, `run_writer_thread` |
| `be/worker/damwha_worker/audio/source.py` | `AudioSource` 프로토콜, `FileSource`, `MicSource` |
| `be/worker/damwha_worker/models/base.py` | `StreamingVAD` 프로토콜 |
| `be/worker/damwha_worker/models/silero_vad.py` | `StreamingSileroVAD` |
| `be/worker/damwha_worker/models/registry.py` | `build_live_models` |
| `be/worker/damwha_worker/pipeline/live_segmenter.py` | `LiveSegmenter`, `Segment` |
| `be/worker/damwha_worker/pipeline/live_session.py` | `LiveModels`, `run_live_session`, 캡처/finalize |
| `be/worker/damwha_worker/pipeline/identify.py` | `identify_embedding` |
| `be/worker/damwha_worker/pipeline/ffmpeg.py` | normalize 전 `repair_streaming_header` |
| `be/worker/damwha_worker/__main__.py` | `live_session` 분기, 빌더 주입, 실패 경로 |
| `be/worker/scripts/smoke_live_session.py` | 실모델 smoke |
| `fe/src/features/meeting/api/types.ts`, `model/types.ts` | `recording` 상태, 라이브 타입 |
| `fe/src/features/meeting/api/live.ts` | `useStartLive`, `useStopLive`, `useLiveUtterances` |
| `fe/src/features/meeting/ui/live-start-dialog.tsx` | 시작 다이얼로그 |
| `fe/src/features/meeting/ui/live-banner.tsx` | 녹음 중 배너 |
| `fe/src/features/meeting/ui/live-transcript.tsx` | 라이브 전사 목록 |
| `fe/src/features/meeting/ui/left-nav.tsx` | 녹음 버튼, 뱃지 |
| `fe/src/features/meeting/ui/transcript-pane.tsx` | `livePreview` prop, 재처리 버튼 숨김 |
| `fe/src/pages/meeting.tsx` | recording 분기, 미리보기 배선 |

---

### Task 1: 마이그레이션 `022_live_session.sql`

**Files:**
- Create: `be/src/database/migrations/022_live_session.sql`
- Test: `be/test/migration.spec.ts`

**Interfaces:**
- Produces: `meeting.status` 값 `recording`; `job.type` 값 `live_session`; `job.stage` 값 `capture`, `finalize`; `job.stop_requested_at timestamptz NULL`; 테이블 `live_utterance`; 인덱스 `meeting_single_recording_idx`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/test/migration.spec.ts`의 `describe('migration', …)` 안, 마지막 `it` 뒤에 추가:

```ts
  it('allows exactly one recording meeting at a time', async () => {
    await db.pool.query(`INSERT INTO meeting(audio_key, status) VALUES('a','recording')`);
    await expect(
      db.pool.query(`INSERT INTO meeting(audio_key, status) VALUES('b','recording')`),
    ).rejects.toThrow(/meeting_single_recording_idx/);
    // 다른 상태는 여럿이어도 된다
    await db.pool.query(`INSERT INTO meeting(audio_key, status) VALUES('c','done'),('d','done')`);
    await db.pool.query(`DELETE FROM meeting WHERE audio_key IN ('a','c','d')`);
  });

  it('live_utterance keeps one row per (meeting, seq), non-empty text and ordered bounds', async () => {
    const m = await db.pool.query(`INSERT INTO meeting(audio_key) VALUES('lu') RETURNING id`);
    const mid = m.rows[0].id;
    const ins = (seq: number, text: string, start = 0, end = 1000) =>
      db.pool.query(
        `INSERT INTO live_utterance(meeting_id, job_id, seq, start_ms, end_ms, text)
         VALUES($1,'job_1',$2,$3,$4,$5) RETURNING id`,
        [mid, seq, start, end, text],
      );
    const first = await ins(0, '안녕');
    expect(first.rows[0].id).toMatch(/^lut_[1-9][0-9]*$/);
    await expect(ins(0, '중복')).rejects.toThrow(/duplicate key|unique/i);
    await expect(ins(1, '')).rejects.toThrow(/check/i);
    await expect(ins(2, '역순', 1000, 1000)).rejects.toThrow(/check/i);
    await db.pool.query(`DELETE FROM meeting WHERE id=$1`, [mid]);
  });

  it('job.stop_requested_at exists and defaults to null', async () => {
    const { rows } = await db.pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='job' AND column_name='stop_requested_at'`,
    );
    expect(rows).toHaveLength(1);
    const j = await db.pool.query(
      `INSERT INTO job(type, payload) VALUES('live_session','{}') RETURNING stop_requested_at, stage`,
    );
    expect(j.rows[0].stop_requested_at).toBeNull();
    await db.pool.query(`UPDATE job SET stage='capture' WHERE type='live_session'`);
    await db.pool.query(`DELETE FROM job WHERE type='live_session'`);
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd be && pnpm exec jest test/migration.spec.ts -t "recording|live_utterance|stop_requested_at"`
Expected: FAIL — `invalid input value for enum`/`violates check constraint "meeting_status_check"`, `relation "live_utterance" does not exist`, `column "stop_requested_at"` 0행.

- [ ] **Step 3: 마이그레이션을 쓴다**

`be/src/database/migrations/022_live_session.sql`:

```sql
-- 라이브 세션(실시간 녹음). 설계: docs/superpowers/specs/2026-09-05-live-recording-design.md §3.1
--
-- 새 상태는 recording 하나뿐이다. 종료 시 워커가 uploaded로 바꾸면 그 뒤는 기존 흐름이다.
ALTER TABLE meeting DROP CONSTRAINT meeting_status_check;
ALTER TABLE meeting ADD CONSTRAINT meeting_status_check
  CHECK (status IN ('recording','uploaded','processing','done','failed'));

ALTER TABLE job DROP CONSTRAINT job_type_check;
ALTER TABLE job ADD CONSTRAINT job_type_check
  CHECK (type IN ('process_meeting','enroll_speaker','index_meeting',
                  'extract_lenses','summarize_meeting','live_session'));

ALTER TABLE job DROP CONSTRAINT job_stage_check;
ALTER TABLE job ADD CONSTRAINT job_stage_check
  CHECK (stage IN ('vad','diarize','identify','stt','align','persist',
                   'extract_embedding','enroll_persist','embed',
                   'extract_lenses','persist_lenses',
                   'summarize_meeting','persist_summary',
                   'capture','finalize'));

-- 동시에 recording인 회의는 하나뿐이다. status 컬럼의 부분 유일 인덱스라 그 값의 행이
-- 둘이 될 수 없다. 동시 시작 요청은 둘 다 "recording 없음"을 읽어도 INSERT에서 하나만 산다.
CREATE UNIQUE INDEX meeting_single_recording_idx ON meeting (status) WHERE status = 'recording';

-- API → 워커 종료 신호. cancel(job을 failed로)과 달리 파일을 살려 최종 패스로 넘긴다.
ALTER TABLE job ADD COLUMN stop_requested_at timestamptz;

-- 라이브 미리보기 발화. utterance에 버전 0으로 섞지 않는다 — 모든 리더가 처리 버전으로
-- 거르고 렌즈 근거·저장 발화가 FK로 물고 있어 임시 행이 새어 나갈 길을 막는다.
-- 최종 패스의 persist가 같은 트랜잭션에서 지운다.
CREATE SEQUENCE lut_id_seq;
CREATE TABLE live_utterance (
  id          text PRIMARY KEY DEFAULT 'lut_' || nextval('lut_id_seq')
                CHECK (id ~ '^lut_[1-9][0-9]*$'),
  meeting_id  text NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  job_id      text NOT NULL,
  seq         int  NOT NULL,
  start_ms    int  NOT NULL,
  end_ms      int  NOT NULL CHECK (end_ms > start_ms),
  text        text NOT NULL CHECK (char_length(text) > 0),
  speaker_id  text REFERENCES speaker(id) ON DELETE SET NULL,
  similarity  real,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, seq)
);
ALTER SEQUENCE lut_id_seq OWNED BY live_utterance.id;
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd be && pnpm exec jest test/migration.spec.ts`
Expected: PASS (기존 케이스 포함)

- [ ] **Step 5: 워커 테스트 컨테이너도 같은 마이그레이션을 읽는다 — 회귀 확인**

Run: `cd be/worker && uv run pytest tests/test_db_lifecycle.py -q`
Expected: PASS (`conftest._run_migrations`가 `022`를 자동으로 적용한다)

- [ ] **Step 6: 커밋**

```bash
cd /Users/jason/projects/Damwha2
git add be/src/database/migrations/022_live_session.sql be/test/migration.spec.ts
git commit -m "feat(be): 라이브 세션 마이그레이션을 더한다 — recording 상태, live_session job, live_utterance

Claude-Session: https://claude.ai/code/session_01X1x9qJVRgpKfcnajp5SrbJ"
```

---

### Task 2: TS 계약 — `LiveSessionPayloadSchema`와 공용 fixture

**Files:**
- Modify: `be/src/contracts/job-payload.schema.ts`
- Modify: `be/src/jobs/jobs.types.ts`
- Create: `be/test/fixtures/job-payloads/live_session.valid.json`
- Test: `be/test/job-payload.spec.ts`, `be/test/contract-fixtures.spec.ts`

**Interfaces:**
- Produces: `LiveSessionPayloadSchema`, `type LiveSessionPayload = { schema_version: 1; meeting_id; audio_key; source: 'mic'; process: ProcessMeetingPayloadV5 }`, `buildLiveSessionPayload(args: { meetingId: string; audioKey: string; processing: ProcessingConfig; followups: Followups; speakers?: { min?: number; max?: number } }): LiveSessionPayload`, `export const ProcessMeetingPayloadV5Schema`. `JobType`에 `'live_session'`, `JobRow.stop_requested_at: Date | null`.
- Task 3의 pydantic 쪽과 Task 12의 API가 이 fixture·빌더를 쓴다.

- [ ] **Step 1: fixture를 만든다**

`be/test/fixtures/job-payloads/live_session.valid.json`:

```json
{
  "schema_version": 1,
  "meeting_id": "mtg_1",
  "audio_key": "meetings/mtg_1/original.wav",
  "source": "mic",
  "process": {
    "schema_version": 5,
    "meeting_id": "mtg_1",
    "audio_key": "meetings/mtg_1/original.wav",
    "processing_version": 0,
    "reprocess": false,
    "models": {
      "whisper_model": "large-v3-turbo",
      "language": "ko",
      "devices": { "diarization": "gpu", "stt": "gpu" },
      "preset": "standard",
      "preset_revision": "2026-08-12.3",
      "summary_model": "mlx-community/Qwen3.5-9B-8bit",
      "diarization": { "model": "pyannote/speaker-diarization-community-1", "min_speakers": null, "max_speakers": null },
      "embedding": { "model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192 }
    },
    "identify": { "threshold": 0.8, "suggest_threshold": 0.6 },
    "followups": { "lens": true, "summary": true }
  }
}
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`be/test/contract-fixtures.spec.ts` import에 `LiveSessionPayloadSchema`를 더하고 `describe` 끝에:

```ts
  it('validates live_session.valid.json and its embedded v5 process payload', () => {
    const p = LiveSessionPayloadSchema.parse(read('live_session.valid.json'));
    expect(p.source).toBe('mic');
    expect(p.process.schema_version).toBe(5);
    expect(p.process.audio_key).toBe(p.audio_key);
  });
  it('rejects live_session whose process block is not v5', () => {
    const bad = read('live_session.valid.json');
    bad.process = { ...bad.process, schema_version: 4 };
    delete bad.process.followups;
    expect(() => LiveSessionPayloadSchema.parse(bad)).toThrow();
  });
  it('rejects live_session with an unknown source', () => {
    const bad = read('live_session.valid.json');
    bad.source = 'system';
    expect(() => LiveSessionPayloadSchema.parse(bad)).toThrow();
  });
```

`be/test/job-payload.spec.ts` import에 `buildLiveSessionPayload, LiveSessionPayloadSchema`를 더하고 `describe` 끝에:

```ts
  it('builds a live_session payload whose process block is the v5 process_meeting payload', () => {
    const p = buildLiveSessionPayload({
      meetingId: 'mtg_7', audioKey: 'meetings/mtg_7/original.wav',
      processing: resolvePreset('standard', 'ko'),
      followups: { lens: false, summary: true },
      speakers: { min: 2 },
    });
    expect(p).toMatchObject({
      schema_version: 1, meeting_id: 'mtg_7', audio_key: 'meetings/mtg_7/original.wav', source: 'mic',
    });
    expect(p.process).toMatchObject({
      schema_version: 5, meeting_id: 'mtg_7', audio_key: 'meetings/mtg_7/original.wav',
      processing_version: 0, reprocess: false, followups: { lens: false, summary: true },
    });
    expect(p.process.models.diarization.min_speakers).toBe(2);
    expect(() => LiveSessionPayloadSchema.parse(p)).not.toThrow();
  });
```

- [ ] **Step 3: 실패를 확인한다**

Run: `cd be && pnpm exec jest test/contract-fixtures.spec.ts test/job-payload.spec.ts`
Expected: FAIL — `LiveSessionPayloadSchema`/`buildLiveSessionPayload` export 없음(TS 컴파일 에러).

- [ ] **Step 4: 스키마와 빌더를 쓴다**

`be/src/contracts/job-payload.schema.ts`:

1. `const ProcessMeetingPayloadV5Schema = z.object({` → `export const ProcessMeetingPayloadV5Schema = z.object({`
2. `SummarizeMeetingPayloadSchema` 정의 바로 뒤에 추가:

```ts
// 라이브 세션(실시간 녹음). process는 API가 시작 시점에 완전히 해석한 v5
// process_meeting payload 그대로다 — 워커는 여기서 whisper/ECAPA/임계값을 읽고,
// 종료 시 이 블록을 그대로 최종 job의 payload로 넣는다. 설정을 두 번 풀지 않고
// 라이브 패스와 최종 패스가 같은 모델로 돈다는 것이 구조로 보장된다.
// source는 나중에 시스템 오디오를 붙일 자리 (설계 §2.1).
export const LiveSessionPayloadSchema = z.object({
  schema_version: z.literal(1),
  meeting_id: z.string().regex(/^mtg_[1-9][0-9]*$/),
  audio_key: z.string().min(1),
  source: z.literal('mic'),
  process: ProcessMeetingPayloadV5Schema,
}).strict();
```

3. 타입 export 블록에 `export type LiveSessionPayload = z.infer<typeof LiveSessionPayloadSchema>;`
4. `buildSummarizeMeetingPayload` 뒤에:

```ts
export function buildLiveSessionPayload(args: {
  meetingId: string; audioKey: string;
  processing: ProcessingConfig; followups: Followups;
  speakers?: { min?: number; max?: number };
}): LiveSessionPayload {
  return {
    schema_version: 1,
    meeting_id: args.meetingId,
    audio_key: args.audioKey,
    source: 'mic',
    process: buildProcessMeetingPayload({
      meetingId: args.meetingId, audioKey: args.audioKey,
      processingVersion: 0, reprocess: false,
      processing: args.processing, followups: args.followups, speakers: args.speakers,
    }),
  };
}
```

`be/src/jobs/jobs.types.ts`: `JobType` 유니온에 `| 'live_session'`, `JobRow`에 `stop_requested_at: Date | null;` (`next_attempt_at` 아래).

- [ ] **Step 5: 통과를 확인한다**

Run: `cd be && pnpm exec jest test/contract-fixtures.spec.ts test/job-payload.spec.ts && pnpm exec tsc --noEmit -p tsconfig.build.json`
Expected: PASS, 타입 에러 없음

- [ ] **Step 6: 커밋**

```bash
git add be/src/contracts/job-payload.schema.ts be/src/jobs/jobs.types.ts be/test/fixtures/job-payloads/live_session.valid.json be/test/contract-fixtures.spec.ts be/test/job-payload.spec.ts
git commit -m "feat(be): live_session payload 계약과 공용 fixture를 더한다

Claude-Session: https://claude.ai/code/session_01X1x9qJVRgpKfcnajp5SrbJ"
```

---

### Task 3: Python 계약 — `LiveSessionPayload`

**Files:**
- Modify: `be/worker/damwha_worker/contracts.py`
- Test: `be/worker/tests/test_contracts_live.py`

**Interfaces:**
- Produces: `LiveSessionPayload(meeting_id, audio_key, source: Literal["mic"], process: ProcessMeetingPayload, process_wire: dict)`; `parse_payload("live_session", data)`가 이것을 돌려준다. `process_wire`는 종료 시 그대로 큐잉할 원본 v5 dict.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_contracts_live.py`:

```python
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from damwha_worker.contracts import (
    LiveSessionPayload,
    ProcessMeetingPayload,
    UnsupportedPayloadVersion,
    parse_payload,
)

FIX = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "job-payloads"


def load(name):
    return json.loads((FIX / name).read_text())


def test_parses_live_session_fixture_and_normalizes_process():
    p = parse_payload("live_session", load("live_session.valid.json"))
    assert isinstance(p, LiveSessionPayload)
    assert p.source == "mic"
    assert isinstance(p.process, ProcessMeetingPayload)
    assert p.process.schema_version == 5
    assert p.process.models.whisper_model == "large-v3-turbo"
    assert p.process.identify.suggest_threshold == 0.6
    assert p.process.followups.lens is True


def test_keeps_the_wire_process_block_verbatim_for_requeue():
    data = load("live_session.valid.json")
    p = parse_payload("live_session", data)
    assert p.process_wire == data["process"]


def test_rejects_process_that_is_not_v5():
    data = load("live_session.valid.json")
    data["process"]["schema_version"] = 4
    del data["process"]["followups"]
    with pytest.raises(ValidationError):
        parse_payload("live_session", data)


def test_rejects_mismatched_meeting_id_or_audio_key():
    data = load("live_session.valid.json")
    data["process"]["meeting_id"] = "mtg_2"
    with pytest.raises(ValidationError):
        parse_payload("live_session", data)
    data = load("live_session.valid.json")
    data["process"]["audio_key"] = "meetings/mtg_1/other.wav"
    with pytest.raises(ValidationError):
        parse_payload("live_session", data)


def test_rejects_unknown_source_and_future_version():
    data = load("live_session.valid.json")
    data["source"] = "system"
    with pytest.raises(ValidationError):
        parse_payload("live_session", data)
    data = load("live_session.valid.json") | {"schema_version": 2}
    with pytest.raises(UnsupportedPayloadVersion):
        parse_payload("live_session", data)
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd be/worker && uv run pytest tests/test_contracts_live.py -q`
Expected: FAIL — `ImportError: cannot import name 'LiveSessionPayload'`

- [ ] **Step 3: 계약을 쓴다**

`be/worker/damwha_worker/contracts.py`:

1. `SUPPORTED_SCHEMA_VERSIONS`에 `"live_session": frozenset({1}),`
2. `SummaryResponse` 클래스 뒤에 추가:

```python
class LiveSessionPayloadWire(BaseModel):
    """wire v1. process는 API가 완전히 해석한 v5 process_meeting payload 그대로다."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    meeting_id: MeetingId
    audio_key: str
    source: Literal["mic"]
    process: dict

    @model_validator(mode="after")
    def _process_matches(self):
        if self.process.get("schema_version") != 5:
            raise ValueError("live_session.process must be a wire v5 process_meeting payload")
        if self.process.get("meeting_id") != self.meeting_id:
            raise ValueError("live_session.process.meeting_id must equal meeting_id")
        if self.process.get("audio_key") != self.audio_key:
            raise ValueError("live_session.process.audio_key must equal audio_key")
        return self


class LiveSessionPayload(BaseModel):
    """내부 표현. process는 정규화된 ProcessMeetingPayload(워커가 모델·임계값을 읽는 곳),
    process_wire는 종료 시 그대로 최종 job에 넣을 원본 dict."""

    schema_version: int = 1
    meeting_id: MeetingId
    audio_key: str
    source: Literal["mic"]
    process: ProcessMeetingPayload
    process_wire: dict


def _parse_live_session(data: dict) -> LiveSessionPayload:
    wire = LiveSessionPayloadWire.model_validate(data)
    return LiveSessionPayload(
        meeting_id=wire.meeting_id,
        audio_key=wire.audio_key,
        source=wire.source,
        process=_parse_process_meeting(wire.process),
        process_wire=wire.process,
    )
```

3. `parse_payload` 안, `if job_type == "summarize_meeting":` 앞에:

```python
    if job_type == "live_session":
        return _parse_live_session(data)
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd be/worker && uv run pytest tests/test_contracts_live.py tests/test_contracts.py -q && uv run ruff check . && uv run ruff format --check .`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add be/worker/damwha_worker/contracts.py be/worker/tests/test_contracts_live.py
git commit -m "feat(worker): live_session payload 계약을 더한다

Claude-Session: https://claude.ai/code/session_01X1x9qJVRgpKfcnajp5SrbJ"
```

---

### Task 4: 큐 (TS) — `max_attempts`, claim 우선순위, reaper 전파

**Files:**
- Modify: `be/src/jobs/jobs.repository.ts`
- Test: `be/test/jobs.repository.spec.ts`, `be/test/reaper.spec.ts`

**Interfaces:**
- Produces: `JobsRepository.enqueue(exec, { type, meetingId, payload, maxAttempts? })`; claim이 `live_session`을 먼저 집는다; `reapStale`이 stale `live_session`의 회의를 `failed`로 닫는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/test/jobs.repository.spec.ts` `describe` 끝에:

```ts
  it('enqueue honors maxAttempts and leaves the column default otherwise', async () => {
    const mid = await seedMeeting();
    const one = await repo.enqueue(db.pool, { type: 'live_session', meetingId: mid, payload: {}, maxAttempts: 1 });
    const def = await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: mid, payload: {} });
    expect(one.max_attempts).toBe(1);
    expect(def.max_attempts).toBe(3);
    expect(one.stop_requested_at).toBeNull();
  });

  it('claims a queued live_session ahead of an older queued process_meeting', async () => {
    const mid = await seedMeeting();
    await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: mid, payload: {} });
    await repo.enqueue(db.pool, { type: 'index_meeting', meetingId: mid, payload: {} });
    const live = await repo.enqueue(db.pool, { type: 'live_session', meetingId: mid, payload: {}, maxAttempts: 1 });
    const claimed = await repo.claim(db.pool, 'w');
    expect(claimed!.id).toBe(live.id);
  });
```

`be/test/reaper.spec.ts` `describe` 끝에:

```ts
  it('fails a stale live_session outright and marks its meeting failed (max_attempts=1)', async () => {
    const m = await db.pool.query(`INSERT INTO meeting(audio_key, status) VALUES('k','recording') RETURNING id`);
    const mid = m.rows[0].id;
    const j = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status, locked_by, locked_at, attempts, max_attempts, stage)
       VALUES('live_session',$1,'{}','running','w', now() - interval '45 minutes', 1, 1, 'capture') RETURNING id`,
      [mid],
    );
    await db.pool.query(`UPDATE meeting SET current_job_id=$1 WHERE id=$2`, [j.rows[0].id, mid]);

    const res = await repo.reapStale(db.pool, 30);
    expect(res).toEqual({ requeued: 0, failed: 1 });
    const job = await db.pool.query('SELECT status, error FROM job WHERE id=$1', [j.rows[0].id]);
    expect(job.rows[0].status).toBe('failed');
    expect(job.rows[0].error.code).toBe('stale_worker');
    const meeting = await db.pool.query('SELECT status, error FROM meeting WHERE id=$1', [mid]);
    expect(meeting.rows[0].status).toBe('failed');
    expect(meeting.rows[0].error.code).toBe('stale_worker');
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd be && pnpm exec jest test/jobs.repository.spec.ts test/reaper.spec.ts`
Expected: FAIL — `max_attempts` 3, claim이 `process_meeting`을 집음, 회의가 `recording` 그대로.

- [ ] **Step 3: 구현한다**

`be/src/jobs/jobs.repository.ts`:

`enqueue`를 교체:

```ts
  async enqueue(
    exec: Queryable,
    args: { type: JobType; meetingId: string | null; payload: unknown; maxAttempts?: number },
  ): Promise<JobRow> {
    // maxAttempts를 안 주면 컬럼 DEFAULT(3)를 그대로 쓴다 — 상수를 여기 복제하지 않는다.
    const { rows } = args.maxAttempts === undefined
      ? await exec.query<JobRow>(
          `INSERT INTO job(type, meeting_id, payload)
           VALUES($1, $2, $3::jsonb) RETURNING *`,
          [args.type, args.meetingId, JSON.stringify(args.payload)],
        )
      : await exec.query<JobRow>(
          `INSERT INTO job(type, meeting_id, payload, max_attempts)
           VALUES($1, $2, $3::jsonb, $4) RETURNING *`,
          [args.type, args.meetingId, JSON.stringify(args.payload), args.maxAttempts],
        );
    this.logger.log(`enqueued job ${rows[0].id} type=${args.type} meeting=${args.meetingId ?? '-'}`);
    return rows[0];
  }
```

`claim`의 `ORDER BY` 줄을 교체 (워커 `db.claim`과 같은 식이어야 한다):

```ts
         ORDER BY (type = 'live_session') DESC, next_attempt_at NULLS FIRST, created_at
```

그 위 주석으로 한 줄: `// 라이브 세션은 사람이 회의 중이다 — 밀린 색인·요약보다 먼저 집는다 (설계 §3.3).`

`reapStale`의 `fail_meetings` CTE에서

```ts
         WHERE m.id IN (SELECT meeting_id FROM failed WHERE type='process_meeting')
```
를
```ts
         WHERE m.id IN (SELECT meeting_id FROM failed WHERE type IN ('process_meeting','live_session'))
```
로 바꾼다.

- [ ] **Step 4: 통과를 확인한다**

Run: `cd be && pnpm exec jest test/jobs.repository.spec.ts test/reaper.spec.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add be/src/jobs/jobs.repository.ts be/test/jobs.repository.spec.ts be/test/reaper.spec.ts
git commit -m "feat(be): live_session을 먼저 claim하고 reaper가 그 회의를 닫는다

Claude-Session: https://claude.ai/code/session_01X1x9qJVRgpKfcnajp5SrbJ"
```

---

### Task 5: 큐 (Python) — claim 우선순위, reaper 전파

**Files:**
- Modify: `be/worker/damwha_worker/db.py:28-44` (claim), `:104-160` (reap_stale)
- Test: `be/worker/tests/test_db_lifecycle.py`

**Interfaces:**
- Produces: `db.claim`이 `live_session`을 먼저 집는다; `db.reap_stale`이 stale `live_session`의 회의를 `failed`로.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_db_lifecycle.py` 끝에:

```python
def test_claim_prefers_live_session_over_older_jobs(conn):
    mid = seed_meeting(conn)
    seed_job(conn, type="process_meeting", meeting_id=mid)
    seed_job(conn, type="index_meeting", meeting_id=mid)
    live = seed_job(conn, type="live_session", meeting_id=mid, max_attempts=1)

    assert db.claim(conn, "w1")["id"] == live


def test_reap_stale_fails_live_session_and_its_meeting(conn):
    mid = seed_meeting(conn, status="recording")
    jid = seed_job(
        conn,
        type="live_session",
        meeting_id=mid,
        status="running",
        locked_by="w1",
        attempts=1,
        max_attempts=1,
        locked_minutes_ago=45,
    )
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))

    assert db.reap_stale(conn, 30) == (0, 1)
    job = conn.execute("SELECT status, error FROM job WHERE id=%s", (jid,)).fetchone()
    assert job["status"] == "failed" and job["error"]["code"] == "stale_worker"
    meeting = conn.execute("SELECT status, error FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert meeting["status"] == "failed" and meeting["error"]["code"] == "stale_worker"
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd be/worker && uv run pytest tests/test_db_lifecycle.py -q -k "live_session"`
Expected: FAIL (claim이 process_meeting을 집음, 회의가 recording 그대로)

- [ ] **Step 3: 구현한다**

`be/worker/damwha_worker/db.py` `claim`의 `ORDER BY next_attempt_at NULLS FIRST, created_at`을

```sql
          ORDER BY (type = 'live_session') DESC, next_attempt_at NULLS FIRST, created_at
```

로 바꾸고 함수 docstring을 추가한다: `"""queued job 하나를 잠근다. live_session은 사람이 회의 중이라 밀린 job보다 먼저 집는다 (API의 JobsRepository.claim과 같은 정렬)."""`

`reap_stale`의 `fail_meetings`:

```sql
          WHERE m.id IN (SELECT meeting_id FROM failed WHERE type IN ('process_meeting','live_session'))
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd be/worker && uv run pytest tests/test_db_lifecycle.py -q && uv run ruff check . && uv run ruff format --check .`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add be/worker/damwha_worker/db.py be/worker/tests/test_db_lifecycle.py
git commit -m "feat(worker): live_session을 먼저 claim하고 reaper가 그 회의를 닫는다

Claude-Session: https://claude.ai/code/session_01X1x9qJVRgpKfcnajp5SrbJ"
```

---

### Task 6: `WavWriter` — 스트리밍 헤더, 복구, normalize 훅

**Files:**
- Create: `be/worker/damwha_worker/audio/__init__.py` (빈 파일)
- Create: `be/worker/damwha_worker/audio/wav_writer.py`
- Modify: `be/worker/damwha_worker/pipeline/ffmpeg.py`
- Test: `be/worker/tests/test_wav_writer.py`, `be/worker/tests/test_ffmpeg.py`

**Interfaces:**
- Produces: `WavWriter(path, sample_rate=16000)` — `.append(pcm: bytes)`, `.flush()`, `.close()`, `.frames_written: int`, `.duration_ms: int`; `repair_streaming_header(path) -> bool`; `run_writer_thread(writer, frames: queue.Queue) -> threading.Thread` (큐에서 `None`을 받으면 끝난다, 파일은 닫지 않는다).
- `ffmpeg.normalize`가 ffmpeg 실행 전에 `repair_streaming_header(src_path)`를 부른다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_wav_writer.py`:

```python
import hashlib
import queue
import struct
import wave

from damwha_worker.audio.wav_writer import (
    HEADER_LEN,
    STREAMING_SIZE,
    WavWriter,
    repair_streaming_header,
    run_writer_thread,
)

FRAME = bytes(range(256)) * 4  # 1024바이트 = int16 512샘플


def _sizes(path):
    with open(path, "rb") as f:
        head = f.read(HEADER_LEN)
    return struct.unpack("<I", head[4:8])[0], struct.unpack("<I", head[40:44])[0]


def test_open_writes_streaming_header_and_close_writes_real_sizes(tmp_path):
    path = str(tmp_path / "a.wav")
    w = WavWriter(path)
    w.flush()
    assert _sizes(path) == (STREAMING_SIZE, STREAMING_SIZE)
    for _ in range(10):
        w.append(FRAME)
    w.close()
    assert _sizes(path) == (36 + 10 * 1024, 10 * 1024)
    assert w.frames_written == 5120 and w.duration_ms == 320
    with wave.open(path, "rb") as r:
        assert (r.getnchannels(), r.getsampwidth(), r.getframerate(), r.getnframes()) == (1, 2, 16000, 5120)


def test_file_cut_without_close_is_recovered_by_repair(tmp_path):
    path = str(tmp_path / "cut.wav")
    w = WavWriter(path)
    for _ in range(7):
        w.append(FRAME)
    w.flush()  # close 없이 끊긴 파일 — 헤더는 스트리밍 값 그대로
    assert _sizes(path) == (STREAMING_SIZE, STREAMING_SIZE)
    assert repair_streaming_header(path) is True
    assert _sizes(path) == (36 + 7 * 1024, 7 * 1024)
    with wave.open(path, "rb") as r:
        assert r.getnframes() == 7 * 512


def test_repair_truncates_a_half_sample_tail(tmp_path):
    path = str(tmp_path / "odd.wav")
    w = WavWriter(path)
    w.append(FRAME)
    w.append(b"\x01")  # 샘플 경계가 아닌 1바이트
    w.flush()
    assert repair_streaming_header(path) is True
    assert _sizes(path) == (36 + 1024, 1024)
    with wave.open(path, "rb") as r:
        assert r.getnframes() == 512


def test_repair_leaves_a_normal_wav_untouched(tmp_path):
    path = str(tmp_path / "ok.wav")
    w = WavWriter(path)
    w.append(FRAME)
    w.close()
    before = hashlib.sha256(open(path, "rb").read()).hexdigest()
    assert repair_streaming_header(path) is False
    assert hashlib.sha256(open(path, "rb").read()).hexdigest() == before


def test_repair_ignores_missing_or_foreign_files(tmp_path):
    assert repair_streaming_header(str(tmp_path / "missing.wav")) is False
    other = tmp_path / "x.m4a"
    other.write_bytes(b"not a wav at all, definitely more than forty-four bytes long..")
    assert repair_streaming_header(str(other)) is False


def test_writer_thread_drains_queue_until_sentinel(tmp_path):
    path = str(tmp_path / "t.wav")
    w = WavWriter(path)
    q: queue.Queue = queue.Queue()
    t = run_writer_thread(w, q)
    for _ in range(3):
        q.put(FRAME)
    q.put(None)
    t.join(timeout=5)
    assert not t.is_alive()
    w.close()
    with wave.open(path, "rb") as r:
        assert r.getnframes() == 3 * 512
```

`be/worker/tests/test_ffmpeg.py` 끝에:

```python
def test_normalize_repairs_a_streaming_wav_header_before_ffmpeg(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(
        ffmpeg, "repair_streaming_header", lambda path: calls.append(("repair", path)) or True
    )
    monkeypatch.setattr(ffmpeg, "probe", lambda path: ffmpeg.ProbeResult(1))
    ffmpeg.normalize(
        "/in/live.wav", str(tmp_path / "n.flac"),
        runner=lambda cmd: calls.append(("ffmpeg", cmd)) or ok_proc(),
    )
    assert calls[0] == ("repair", "/in/live.wav")
    assert calls[1][0] == "ffmpeg"
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd be/worker && uv run pytest tests/test_wav_writer.py tests/test_ffmpeg.py -q`
Expected: FAIL — `ModuleNotFoundError: damwha_worker.audio`, `ffmpeg has no attribute repair_streaming_header`

- [ ] **Step 3: writer를 쓴다**

`be/worker/damwha_worker/audio/__init__.py`: 빈 파일.

`be/worker/damwha_worker/audio/wav_writer.py`:

```python
"""스트리밍 헤더 WAV writer — 녹음 중에는 길이 미정, 닫을 때만 실제 크기.

표준 wave 모듈은 close()에서만 헤더를 쓴다. 자식이 죽으면 길이 0짜리 헤더가 남고,
ffmpeg는 data 크기가 실제보다 작은 헤더를 만나면 그 길이로 잘라 읽는다(실측: PCM 7초·
헤더 5초 → 5초). 반대로 0xFFFFFFFF(ffmpeg가 seek 불가 출력에 쓰는 관례)면 EOF까지
읽는다. 그래서 열 때 두 크기 필드를 0xFFFFFFFF로 두고 close()에서만 고친다 — 어느
순간 죽어도 디스크에 닿은 프레임까지 살아 있다. 주기 갱신은 마지막 갱신 이후를 잃으므로
하지 않는다. 설계: docs/superpowers/specs/2026-09-05-live-recording-design.md §2.9.

numpy/soundfile을 쓰지 않는다 — 결정적 테스트는 models extra 없이 돈다.
"""

import os
import queue
import struct
import threading

SR = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2  # int16
HEADER_LEN = 44
STREAMING_SIZE = 0xFFFFFFFF


def _header(data_size: int, riff_size: int, sample_rate: int = SR) -> bytes:
    byte_rate = sample_rate * CHANNELS * SAMPLE_WIDTH
    block_align = CHANNELS * SAMPLE_WIDTH
    return (
        b"RIFF"
        + struct.pack("<I", riff_size)
        + b"WAVE"
        + b"fmt "
        + struct.pack("<IHHIIHH", 16, 1, CHANNELS, sample_rate, byte_rate, block_align, 16)
        + b"data"
        + struct.pack("<I", data_size)
    )


class WavWriter:
    def __init__(self, path: str, sample_rate: int = SR) -> None:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self._sample_rate = sample_rate
        self._f = open(path, "wb")  # noqa: SIM115 — 수명이 close()까지다
        self._f.write(_header(STREAMING_SIZE, STREAMING_SIZE, sample_rate))
        self._bytes = 0
        self._closed = False

    @property
    def frames_written(self) -> int:
        return self._bytes // (CHANNELS * SAMPLE_WIDTH)

    @property
    def duration_ms(self) -> int:
        return int(self.frames_written * 1000 / self._sample_rate)

    def append(self, pcm: bytes) -> None:
        if self._closed:
            raise ValueError("WavWriter is closed")
        self._f.write(pcm)
        self._bytes += len(pcm)

    def flush(self) -> None:
        self._f.flush()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._f.flush()
        self._f.seek(0)
        self._f.write(_header(self._bytes, 36 + self._bytes, self._sample_rate))
        self._f.close()


def repair_streaming_header(path: str) -> bool:
    """스트리밍 헤더(또는 파일보다 큰 data 크기)를 실제 파일 크기로 고친다.

    우리 writer가 만든 44바이트 헤더(fmt가 12, data가 36 오프셋)만 다룬다. 다른 배치의
    WAV나 WAV가 아닌 파일, 없는 파일은 건드리지 않고 False. 반쪽 샘플로 끝나면 샘플 경계로
    내림해 잘라낸다. 크래시 후 재처리가 부르는 곳: pipeline.ffmpeg.normalize.
    """
    try:
        size = os.path.getsize(path)
    except OSError:
        return False
    if size < HEADER_LEN:
        return False
    with open(path, "r+b") as f:
        head = f.read(HEADER_LEN)
        if head[:4] != b"RIFF" or head[8:12] != b"WAVE" or head[36:40] != b"data":
            return False
        declared = struct.unpack("<I", head[40:44])[0]
        actual = size - HEADER_LEN
        if declared != STREAMING_SIZE and declared <= actual:
            return False
        block = CHANNELS * SAMPLE_WIDTH
        aligned = actual - (actual % block)
        f.seek(4)
        f.write(struct.pack("<I", 36 + aligned))
        f.seek(40)
        f.write(struct.pack("<I", aligned))
        if aligned != actual:
            f.truncate(HEADER_LEN + aligned)
    return True


def run_writer_thread(writer: WavWriter, frames: "queue.Queue[bytes | None]") -> threading.Thread:
    """큐의 프레임을 디스크로 옮기는 전용 스레드. None을 받으면 끝난다(파일은 안 닫는다).

    미리보기 파이프라인(whisper·DB)과 다른 스레드에 두는 이유: 추론이 멈춰도 파일 쓰기는
    디스크 속도로만 진행돼야 "녹음은 잃지 않는다"가 성립한다 (설계 §2.9).
    """

    def _loop() -> None:
        while True:
            pcm = frames.get()
            if pcm is None:
                return
            writer.append(pcm)

    t = threading.Thread(target=_loop, name="wav-writer", daemon=True)
    t.start()
    return t
```

`be/worker/damwha_worker/pipeline/ffmpeg.py`: import에 `from ..audio.wav_writer import repair_streaming_header`를 더하고, `normalize`의 `fd, temp_path = tempfile.mkstemp(` 바로 앞에:

```python
    # 라이브 녹음이 크래시로 남긴 스트리밍 헤더(0xFFFFFFFF)를 실제 길이로 고친다.
    # ffmpeg는 그 값도 EOF까지 읽지만, 원본을 그대로 재생하는 API와 다른 리더까지 정확한
    # 헤더를 보게 한다. 다른 파일에는 no-op.
    repair_streaming_header(src_path)
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd be/worker && uv run pytest tests/test_wav_writer.py tests/test_ffmpeg.py -q && uv run ruff check . && uv run ruff format --check .`
Expected: PASS

- [ ] **Step 5: 실제 ffmpeg로 한 번 확인한다 (로컬, 선택)**

Run:
```bash
cd be/worker && uv run python - <<'PY'
import subprocess, tempfile, os
from damwha_worker.audio.wav_writer import WavWriter
d = tempfile.mkdtemp(); p = os.path.join(d, "cut.wav")
w = WavWriter(p)
for _ in range(16000 * 7 // 512): w.append(b"\x01\x00" * 512)
w.flush()  # close 없음 = 크래시
print(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",p],capture_output=True,text=True).stdout)
PY
```
Expected: `6.9…` 초 (헤더 없이 EOF까지 읽힘)

- [ ] **Step 6: 커밋**

```bash
git add be/worker/damwha_worker/audio be/worker/damwha_worker/pipeline/ffmpeg.py be/worker/tests/test_wav_writer.py be/worker/tests/test_ffmpeg.py
git commit -m "feat(worker): 스트리밍 헤더 WAV writer와 normalize 전 헤더 복구를 더한다

Claude-Session: https://claude.ai/code/session_01X1x9qJVRgpKfcnajp5SrbJ"
```

---

### Task 7: `AudioSource` — `FileSource`, `MicSource`, 오류 코드, 의존성

**Files:**
- Create: `be/worker/damwha_worker/audio/source.py`
- Create: `be/worker/tests/audio_fixtures.py`
- Modify: `be/worker/damwha_worker/errors.py`
- Modify: `be/worker/pyproject.toml`
- Test: `be/worker/tests/test_audio_source.py`

**Interfaces:**
- Produces: 상수 `SR=16000`, `FRAME_SAMPLES=512`, `FRAME_BYTES=1024`, `FRAME_MS=32`. `AudioSource` 프로토콜: `frames() -> Iterator[bytes]`, `stop() -> None`. `FileSource(path, *, realtime=False, sleep=time.sleep)`, `MicSource(device=None, *, sounddevice_module=None)`. `errors.AUDIO_DEVICE_FAILED = "audio_device_failed"`, `errors.LIVE_STT_FAILED = "live_stt_failed"`. 테스트 헬퍼 `tests/audio_fixtures.py: make_wav(path, frames: int, *, sample_rate=16000) -> str` (int16 모노, `frames`개 프레임 = frames×512 샘플, 값은 프레임 번호로 채운다).

- [ ] **Step 1: 테스트 헬퍼와 실패하는 테스트를 쓴다**

`be/worker/tests/audio_fixtures.py`:

```python
"""테스트용 16 kHz 모노 int16 WAV 생성기 — 표준 wave만 쓴다(models extra 불필요)."""

import struct
import wave

FRAME_SAMPLES = 512


def frame_bytes(value: int) -> bytes:
    """샘플값이 전부 value인 프레임 1개(1024바이트)."""
    return struct.pack("<h", value) * FRAME_SAMPLES


def make_wav(path: str, frames: int, *, sample_rate: int = 16000, tail_samples: int = 0) -> str:
    """frames개 프레임(프레임 i의 샘플값은 i)을 담은 WAV. tail_samples는 프레임 경계
    밖에 남는 자투리 샘플 수 — FileSource가 버려야 한다."""
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        for i in range(frames):
            w.writeframes(frame_bytes(i))
        if tail_samples:
            w.writeframes(struct.pack("<h", 0) * tail_samples)
    return path
```

`be/worker/tests/test_audio_source.py`:

```python
import threading
import time

import pytest

from damwha_worker.audio.source import FRAME_BYTES, FRAME_MS, FileSource, MicSource
from damwha_worker.errors import AUDIO_DEVICE_FAILED, ErrorKind, WorkerError
from tests.audio_fixtures import frame_bytes, make_wav


def test_file_source_yields_whole_frames_and_drops_the_tail(tmp_path):
    path = make_wav(str(tmp_path / "a.wav"), 5, tail_samples=100)
    frames = list(FileSource(path).frames())
    assert len(frames) == 5
    assert all(len(f) == FRAME_BYTES for f in frames)
    assert frames[3] == frame_bytes(3)


def test_file_source_rejects_non_16k_mono(tmp_path):
    path = make_wav(str(tmp_path / "44k.wav"), 2, sample_rate=44100)
    with pytest.raises(ValueError):
        list(FileSource(path).frames())


def test_file_source_stop_ends_iteration_early(tmp_path):
    path = make_wav(str(tmp_path / "a.wav"), 50)
    src = FileSource(path)
    out = []
    for f in src.frames():
        out.append(f)
        if len(out) == 3:
            src.stop()
    assert len(out) == 3


def test_file_source_realtime_sleeps_one_frame_per_frame(tmp_path):
    path = make_wav(str(tmp_path / "a.wav"), 4)
    slept = []
    list(FileSource(path, realtime=True, sleep=slept.append).frames())
    assert slept == [FRAME_MS / 1000] * 4


class _FakeStream:
    """sounddevice.InputStream 흉내 — start()에서 콜백을 스레드로 돌린다."""

    def __init__(self, *, samplerate, channels, dtype, blocksize, device, callback):
        assert (samplerate, channels, dtype, blocksize) == (16000, 1, "int16", 512)
        self._cb = callback
        self._stop = threading.Event()
        self.closed = False

    def start(self):
        def _pump():
            i = 0
            while not self._stop.is_set():
                self._cb(bytearray(frame_bytes(i)), 512, None, None)
                i += 1
                time.sleep(0.001)

        threading.Thread(target=_pump, daemon=True).start()

    def stop(self):
        self._stop.set()

    def close(self):
        self.closed = True


class _FakeSounddevice:
    def __init__(self, stream_cls=_FakeStream):
        self.InputStream = stream_cls


def test_mic_source_streams_callback_frames_until_stop():
    sd = _FakeSounddevice()
    src = MicSource(sounddevice_module=sd)
    got = []
    for f in src.frames():
        got.append(f)
        if len(got) == 5:
            src.stop()
    assert len(got) >= 5
    assert got[0] == frame_bytes(0) and len(got[4]) == FRAME_BYTES


def test_mic_source_maps_open_failure_to_permanent_audio_device_failed():
    class _Broken(_FakeStream):
        def start(self):
            raise RuntimeError("Error opening InputStream: no default input device")

    src = MicSource(sounddevice_module=_FakeSounddevice(_Broken))
    with pytest.raises(WorkerError) as ei:
        list(src.frames())
    assert ei.value.code == AUDIO_DEVICE_FAILED
    assert ei.value.kind is ErrorKind.PERMANENT


def test_mic_source_without_sounddevice_installed_is_permanent(monkeypatch):
    import builtins

    real_import = builtins.__import__

    def _no_sd(name, *a, **k):
        if name == "sounddevice":
            raise ImportError("No module named 'sounddevice'")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", _no_sd)
    with pytest.raises(WorkerError) as ei:
        list(MicSource().frames())
    assert ei.value.code == AUDIO_DEVICE_FAILED
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd be/worker && uv run pytest tests/test_audio_source.py -q`
Expected: FAIL — `ModuleNotFoundError: damwha_worker.audio.source`

- [ ] **Step 3: 오류 코드·의존성·소스를 쓴다**

`be/worker/damwha_worker/errors.py`의 `GPU_UNAVAILABLE = "gpu_unavailable"` 아래에:

```python
# 라이브 세션 (설계 §8). 둘 다 PERMANENT — 끊긴 녹음은 이어 붙일 수 없다.
AUDIO_DEVICE_FAILED = "audio_device_failed"  # 마이크를 못 열었다 (권한·장치 없음·미설치)
LIVE_STT_FAILED = "live_stt_failed"  # 클립 연속 실패 상한 초과
```

`be/worker/pyproject.toml` `models` extra의 `"uvicorn==0.49.0",` 뒤에 `"sounddevice==0.5.2",` (PortAudio 바인딩; macOS wheel에 라이브러리 동봉). 이어서 `uv lock`을 돌린다. 그 버전이 인덱스에 없으면 `uv lock` 오류 메시지가 알려주는 최신 0.5.x로 고정한다.

`be/worker/damwha_worker/audio/source.py`:

```python
"""오디오 프레임 소스 — 마이크(sounddevice)와 파일(테스트·smoke).

프레임은 16 kHz 모노 int16 LE 512샘플(32 ms) = 1024바이트의 `bytes`다. numpy를 쓰지
않는 이유는 결정적 테스트가 models extra 없이 돌아야 하기 때문이고, 512샘플인 이유는
silero VADIterator가 16 kHz에서 그 크기만 받기 때문이다. `AudioSource`는 시스템 오디오
구현체를 나중에 붙일 자리다 (설계 §2.1).
"""

import logging
import queue
import threading
import time
import wave
from collections.abc import Iterator
from typing import Protocol

from ..errors import AUDIO_DEVICE_FAILED, ErrorKind, WorkerError

log = logging.getLogger("damwha_worker")

SR = 16000
FRAME_SAMPLES = 512
FRAME_BYTES = FRAME_SAMPLES * 2
FRAME_MS = FRAME_SAMPLES * 1000 // SR  # 32


class AudioSource(Protocol):
    def frames(self) -> Iterator[bytes]:
        """프레임을 순서대로 낸다. stop() 뒤(또는 EOF) 반복이 끝난다."""
        ...

    def stop(self) -> None: ...


class FileSource:
    """WAV 파일을 프레임으로 흘린다. realtime=True면 프레임당 32 ms 대기(smoke용)."""

    def __init__(self, path: str, *, realtime: bool = False, sleep=time.sleep) -> None:
        self._path = path
        self._realtime = realtime
        self._sleep = sleep
        self._stopped = threading.Event()

    def frames(self) -> Iterator[bytes]:
        with wave.open(self._path, "rb") as w:
            if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (SR, 1, 2):
                raise ValueError(
                    f"FileSource needs {SR} Hz mono int16, got "
                    f"{w.getframerate()} Hz / {w.getnchannels()} ch / {w.getsampwidth() * 8} bit"
                )
            while not self._stopped.is_set():
                pcm = w.readframes(FRAME_SAMPLES)
                if len(pcm) < FRAME_BYTES:
                    return  # 마지막 자투리는 버린다
                if self._realtime:
                    self._sleep(FRAME_MS / 1000)
                yield pcm

    def stop(self) -> None:
        self._stopped.set()


def _import_sounddevice():
    try:
        import sounddevice
    except ImportError as exc:
        raise WorkerError(
            AUDIO_DEVICE_FAILED,
            "sounddevice is not installed — run `uv sync --extra models`",
            ErrorKind.PERMANENT,
            stage="capture",
        ) from exc
    return sounddevice


class MicSource:
    """기본 입력 장치를 연다. 콜백은 큐에 넣기만 하고, frames()가 그 큐를 비운다.

    첫 실행에 macOS 마이크 권한 프롬프트가 터미널 앱 앞으로 뜬다. 거부·장치 없음·미설치는
    전부 PERMANENT audio_device_failed — 재시도로 달라질 게 없다.
    """

    def __init__(self, device: int | str | None = None, *, sounddevice_module=None) -> None:
        self._device = device
        self._sd = sounddevice_module
        self._q: queue.Queue[bytes | None] | None = None

    def frames(self) -> Iterator[bytes]:
        sd = self._sd or _import_sounddevice()
        q: queue.Queue[bytes | None] = queue.Queue()
        self._q = q

        def _callback(indata, frames, time_info, status) -> None:
            if status:
                log.warning("mic stream status: %s", status)
            # indata는 PortAudio가 재사용하는 버퍼다 — bytes()가 복사한다.
            q.put(bytes(indata))

        try:
            stream = sd.InputStream(
                samplerate=SR,
                channels=1,
                dtype="int16",
                blocksize=FRAME_SAMPLES,
                device=self._device,
                callback=_callback,
            )
            stream.start()
        except Exception as exc:  # noqa: BLE001 — PortAudioError 등 장치 계층 예외 전부
            raise WorkerError(
                AUDIO_DEVICE_FAILED,
                f"could not open microphone: {exc}",
                ErrorKind.PERMANENT,
                stage="capture",
            ) from exc
        try:
            while True:
                pcm = q.get()
                if pcm is None:
                    return
                yield pcm
        finally:
            stream.stop()
            stream.close()

    def stop(self) -> None:
        if self._q is not None:
            self._q.put(None)
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd be/worker && uv run pytest tests/test_audio_source.py -q && uv run ruff check . && uv run ruff format --check .`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add be/worker/damwha_worker/audio/source.py be/worker/damwha_worker/errors.py be/worker/pyproject.toml be/worker/uv.lock be/worker/tests/audio_fixtures.py be/worker/tests/test_audio_source.py
git commit -m "feat(worker): 마이크·파일 오디오 소스와 라이브 오류 코드를 더한다

Claude-Session: https://claude.ai/code/session_01X1x9qJVRgpKfcnajp5SrbJ"
```

---

### Task 8: 세그먼터와 스트리밍 VAD

**Files:**
- Modify: `be/worker/damwha_worker/models/base.py`
- Modify: `be/worker/damwha_worker/models/silero_vad.py`
- Create: `be/worker/damwha_worker/pipeline/live_segmenter.py`
- Modify: `be/worker/tests/fakes.py`
- Test: `be/worker/tests/test_live_segmenter.py`

**Interfaces:**
- Produces: `StreamingVAD` 프로토콜 — `process(pcm: bytes) -> list[tuple[str, int]]`(`("start", ms)` / `("end", ms)`, ms는 스트림 시작 기준), `reset() -> None`. `Segment(start_ms: int, end_ms: int, pcm: bytes)`. `LiveSegmenter(vad, *, max_segment_ms=15000, min_segment_ms=300, pre_roll_ms=200)` — `push(pcm) -> list[Segment]`, `flush() -> Segment | None`. `StreamingSileroVAD(threshold=0.5, min_silence_duration_ms=200)`. `tests.fakes.FakeStreamingVAD(events: dict[int, list[tuple[str, int]]])` — 프레임 인덱스별 이벤트.

- [ ] **Step 1: fake와 실패하는 테스트를 쓴다**

`be/worker/tests/fakes.py` 끝에:

```python
class FakeStreamingVAD:
    """프레임 인덱스 → 이벤트 목록. 시각(ms)은 세그먼터가 무시하므로 0으로 둔다."""

    def __init__(self, events: dict[int, list[tuple[str, int]]] | None = None) -> None:
        self._events = events or {}
        self.frames_seen = 0

    def process(self, pcm: bytes) -> list[tuple[str, int]]:
        i = self.frames_seen
        self.frames_seen += 1
        return list(self._events.get(i, []))

    def reset(self) -> None:
        self.frames_seen = 0
```

`be/worker/tests/test_live_segmenter.py`:

```python
from damwha_worker.pipeline.live_segmenter import LiveSegmenter, Segment
from tests.audio_fixtures import frame_bytes
from tests.fakes import FakeStreamingVAD

FRAME_MS = 32


def _run(seg: LiveSegmenter, n: int) -> list[Segment]:
    out = []
    for i in range(n):
        out.extend(seg.push(frame_bytes(i)))
    return out


def test_emits_segment_from_pre_roll_to_end_event():
    seg = LiveSegmenter(FakeStreamingVAD({10: [("start", 0)], 40: [("end", 0)]}))
    out = _run(seg, 50)
    assert len(out) == 1
    s = out[0]
    # pre-roll 200ms = 7프레임(현재 프레임 포함): 4..10 → 시작 4*32
    assert s.start_ms == 4 * FRAME_MS
    assert s.end_ms == 41 * FRAME_MS
    assert len(s.pcm) == 37 * 1024
    assert s.pcm[:1024] == frame_bytes(4) and s.pcm[-1024:] == frame_bytes(40)


def test_drops_segments_shorter_than_min():
    seg = LiveSegmenter(FakeStreamingVAD({10: [("start", 0)], 11: [("end", 0)]}))
    assert _run(seg, 20) == []  # 8프레임 = 256ms < 300ms


def test_force_cuts_at_max_and_continues_without_gap():
    seg = LiveSegmenter(FakeStreamingVAD({0: [("start", 0)]}), max_segment_ms=15000)
    out = _run(seg, 1000)
    assert len(out) == 2
    first, second = out
    assert first.start_ms == 0
    assert first.end_ms - first.start_ms >= 15000
    assert second.start_ms == first.end_ms
    assert second.end_ms - second.start_ms >= 15000


def test_flush_closes_the_open_segment_once():
    seg = LiveSegmenter(FakeStreamingVAD({10: [("start", 0)]}))
    assert _run(seg, 30) == []
    s = seg.flush()
    assert s is not None and s.start_ms == 4 * FRAME_MS and s.end_ms == 30 * FRAME_MS
    assert seg.flush() is None


def test_ignores_end_without_start_and_start_while_open():
    seg = LiveSegmenter(FakeStreamingVAD({3: [("end", 0)], 10: [("start", 0)], 12: [("start", 0)], 20: [("end", 0)]}))
    out = _run(seg, 25)
    assert len(out) == 1 and out[0].start_ms == 4 * FRAME_MS
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd be/worker && uv run pytest tests/test_live_segmenter.py -q`
Expected: FAIL — `ModuleNotFoundError: damwha_worker.pipeline.live_segmenter`

- [ ] **Step 3: 프로토콜·세그먼터·silero 어댑터를 쓴다**

`be/worker/damwha_worker/models/base.py` 끝에:

```python
class StreamingVAD(Protocol):
    """프레임 단위 VAD. 이벤트는 ("start", ms) 또는 ("end", ms), ms는 스트림 시작 기준.
    세그먼터는 자체 프레임 계수로 경계를 잡으므로 ms는 로그용이다."""

    def process(self, pcm: bytes) -> list[tuple[str, int]]: ...

    def reset(self) -> None: ...
```

`be/worker/damwha_worker/pipeline/live_segmenter.py`:

```python
"""프레임 스트림 → 발화 세그먼트 (pure).

VAD start에서 pre-roll(직전 200 ms)을 붙여 열고, end에서 닫는다. 끝이 안 와도 상한
(15 s)에서 강제로 자르고 다음 세그먼트를 빈틈 없이 이어 연다. 최종 패스의
prepare_stt_spans와 같은 취지의 앞 패딩·최소 길이 규칙이다. 뒤 패딩은 silero의
min_silence_duration_ms(끝 이벤트가 그만큼 늦게 온다)가 담당한다.
"""

from collections import deque
from dataclasses import dataclass

from ..audio.source import FRAME_MS
from ..models.base import StreamingVAD

MAX_SEGMENT_MS = 15000
MIN_SEGMENT_MS = 300
PRE_ROLL_MS = 200


@dataclass
class Segment:
    start_ms: int
    end_ms: int
    pcm: bytes


class LiveSegmenter:
    def __init__(
        self,
        vad: StreamingVAD,
        *,
        max_segment_ms: int = MAX_SEGMENT_MS,
        min_segment_ms: int = MIN_SEGMENT_MS,
        pre_roll_ms: int = PRE_ROLL_MS,
    ) -> None:
        self._vad = vad
        self._max = max_segment_ms
        self._min = min_segment_ms
        self._pre_roll: deque[bytes] = deque(maxlen=-(-pre_roll_ms // FRAME_MS))  # ceil
        self._pos_ms = 0  # 지금까지 push된 프레임의 끝 시각
        self._cur: list[bytes] | None = None
        self._cur_start_ms = 0

    def push(self, pcm: bytes) -> list[Segment]:
        events = self._vad.process(pcm)
        self._pos_ms += FRAME_MS
        if self._cur is None:
            self._pre_roll.append(pcm)
        else:
            self._cur.append(pcm)
        out: list[Segment] = []
        for kind, _ in events:
            if kind == "start" and self._cur is None:
                # pre-roll에는 방금 append한 현재 프레임이 들어 있다
                self._cur = list(self._pre_roll)
                self._cur_start_ms = self._pos_ms - len(self._cur) * FRAME_MS
                self._pre_roll.clear()
            elif kind == "end" and self._cur is not None:
                seg = self._emit(keep_open=False)
                if seg is not None:
                    out.append(seg)
        if self._cur is not None and self._pos_ms - self._cur_start_ms >= self._max:
            seg = self._emit(keep_open=True)
            if seg is not None:
                out.append(seg)
        return out

    def flush(self) -> Segment | None:
        """종료 시 진행 중이던 발화를 닫는다."""
        if self._cur is None:
            return None
        return self._emit(keep_open=False)

    def _emit(self, *, keep_open: bool) -> Segment | None:
        assert self._cur is not None
        frames = self._cur
        start = self._cur_start_ms
        end = start + len(frames) * FRAME_MS
        if keep_open:
            self._cur = []
            self._cur_start_ms = end
        else:
            self._cur = None
        if end - start < self._min or not frames:
            return None
        return Segment(start_ms=start, end_ms=end, pcm=b"".join(frames))
```

`be/worker/damwha_worker/models/silero_vad.py` 끝에:

```python
class StreamingSileroVAD:
    """silero VADIterator 래핑 — 512샘플 int16 프레임을 받아 start/end 이벤트를 낸다.

    speech_pad_ms=0: 앞 패딩은 세그먼터의 pre-roll이, 뒤 패딩은 min_silence_duration_ms가
    담당한다(끝 이벤트가 그만큼 뒤에 온다). 무거운 import는 __init__ 안.
    """

    def __init__(self, *, threshold: float = 0.5, min_silence_duration_ms: int = 200) -> None:
        from silero_vad import VADIterator, load_silero_vad

        self._it = VADIterator(
            load_silero_vad(),
            threshold=threshold,
            sampling_rate=_SR,
            min_silence_duration_ms=min_silence_duration_ms,
            speech_pad_ms=0,
        )

    def process(self, pcm: bytes) -> list[tuple[str, int]]:
        import torch

        x = torch.frombuffer(bytearray(pcm), dtype=torch.int16).float() / 32768.0
        event = self._it(x, return_seconds=False)
        if not event:
            return []
        if "start" in event:
            return [("start", int(event["start"] * 1000 / _SR))]
        return [("end", int(event["end"] * 1000 / _SR))]

    def reset(self) -> None:
        self._it.reset_states()
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd be/worker && uv run pytest tests/test_live_segmenter.py -q && uv run ruff check . && uv run ruff format --check .`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add be/worker/damwha_worker/models/base.py be/worker/damwha_worker/models/silero_vad.py be/worker/damwha_worker/pipeline/live_segmenter.py be/worker/tests/fakes.py be/worker/tests/test_live_segmenter.py
git commit -m "feat(worker): 라이브 세그먼터와 스트리밍 silero VAD를 더한다

Claude-Session: https://claude.ai/code/session_01X1x9qJVRgpKfcnajp5SrbJ"
```

---

### Task 9: `db.py` 라이브 함수, `identify_embedding`, persist의 live 행 삭제

**Files:**
- Modify: `be/worker/damwha_worker/db.py`
- Modify: `be/worker/damwha_worker/pipeline/identify.py`
- Test: `be/worker/tests/test_db_live.py`, `be/worker/tests/test_identify.py`, `be/worker/tests/test_db_persist.py`

**Interfaces:**
- Produces (db): `set_recording_started(conn, meeting_id, job_id) -> int`(rowcount), `get_stop_requested(conn, job_id, worker_id) -> str | None`(`"stop"` | `"lost"` | `None`), `insert_live_utterance(conn, *, meeting_id, job_id, seq, start_ms, end_ms, text, speaker_id, similarity) -> str`, `finalize_live_session(conn, *, job_id, worker_id, meeting_id, duration_ms, process_payload: dict) -> str`(`"committed"` | `"discarded"` | `"lost"`), `delete_live_utterances(conn, meeting_id) -> int`.
- Produces (identify): `identify_embedding(conn, embedding, model, dimension, threshold) -> tuple[str, float] | None`.
- `persist_process_meeting`이 같은 트랜잭션에서 그 회의의 `live_utterance`를 지운다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_db_live.py`:

```python
import pytest

from damwha_worker import db
from tests.conftest import seed_job, seed_meeting

PROCESS = {"schema_version": 5, "meeting_id": "mtg_1", "audio_key": "k", "marker": "verbatim"}


def _claimed_live(conn, *, status="recording"):
    mid = seed_meeting(conn, status=status)
    jid = seed_job(conn, type="live_session", meeting_id=mid, max_attempts=1)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    return mid, jid


def test_set_recording_started_is_guarded_by_current_job_and_status(conn):
    mid, jid = _claimed_live(conn)
    before = conn.execute("SELECT recorded_at FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert db.set_recording_started(conn, mid, jid) == 1
    after = conn.execute("SELECT recorded_at FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert after["recorded_at"] >= before["recorded_at"]
    assert db.set_recording_started(conn, mid, "job_999") == 0
    conn.execute("UPDATE meeting SET status='failed' WHERE id=%s", (mid,))
    assert db.set_recording_started(conn, mid, jid) == 0


def test_get_stop_requested_reports_none_stop_or_lost(conn):
    mid, jid = _claimed_live(conn)
    assert db.get_stop_requested(conn, jid, "w1") is None
    conn.execute("UPDATE job SET stop_requested_at=now() WHERE id=%s", (jid,))
    assert db.get_stop_requested(conn, jid, "w1") == "stop"
    assert db.get_stop_requested(conn, jid, "someone-else") == "lost"
    conn.execute("UPDATE job SET status='failed' WHERE id=%s", (jid,))
    assert db.get_stop_requested(conn, jid, "w1") == "lost"
    assert db.get_stop_requested(conn, "job_999", "w1") == "lost"


def test_insert_live_utterance_returns_id_and_enforces_seq(conn):
    mid, jid = _claimed_live(conn)
    lid = db.insert_live_utterance(
        conn, meeting_id=mid, job_id=jid, seq=0, start_ms=0, end_ms=800,
        text="안녕하세요", speaker_id=None, similarity=None,
    )
    assert lid.startswith("lut_")
    with pytest.raises(Exception, match="live_utterance_meeting_id_seq_key"):
        db.insert_live_utterance(
            conn, meeting_id=mid, job_id=jid, seq=0, start_ms=800, end_ms=1600,
            text="또", speaker_id=None, similarity=None,
        )


def test_delete_live_utterances_only_touches_that_meeting(conn):
    mid, jid = _claimed_live(conn)
    other = seed_meeting(conn)
    for m in (mid, other):
        db.insert_live_utterance(
            conn, meeting_id=m, job_id=jid, seq=0, start_ms=0, end_ms=500,
            text="x", speaker_id=None, similarity=None,
        )
    assert db.delete_live_utterances(conn, mid) == 1
    assert (
        conn.execute("SELECT count(*) c FROM live_utterance WHERE meeting_id=%s", (other,)).fetchone()["c"]
        == 1
    )


def test_finalize_commits_and_enqueues_the_wire_process_payload(conn):
    mid, jid = _claimed_live(conn)
    db.insert_live_utterance(
        conn, meeting_id=mid, job_id=jid, seq=0, start_ms=0, end_ms=500,
        text="살아남는다", speaker_id=None, similarity=None,
    )
    out = db.finalize_live_session(
        conn, job_id=jid, worker_id="w1", meeting_id=mid, duration_ms=2048, process_payload=PROCESS
    )
    assert out == "committed"
    m = conn.execute("SELECT status, duration_ms, current_job_id FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert m["status"] == "uploaded" and m["duration_ms"] == 2048
    new = conn.execute("SELECT * FROM job WHERE id=%s", (m["current_job_id"],)).fetchone()
    assert new["type"] == "process_meeting" and new["status"] == "queued"
    assert new["payload"] == PROCESS
    assert new["meeting_id"] == mid
    live = conn.execute("SELECT status, progress FROM job WHERE id=%s", (jid,)).fetchone()
    assert live["status"] == "done" and live["progress"] == 100
    # 라이브 행은 최종 패스의 persist가 지운다 — finalize는 남긴다
    assert conn.execute("SELECT count(*) c FROM live_utterance WHERE meeting_id=%s", (mid,)).fetchone()["c"] == 1


def test_finalize_discards_when_meeting_was_cancelled(conn):
    mid, jid = _claimed_live(conn)
    conn.execute("UPDATE meeting SET status='failed' WHERE id=%s", (mid,))
    out = db.finalize_live_session(
        conn, job_id=jid, worker_id="w1", meeting_id=mid, duration_ms=10, process_payload=PROCESS
    )
    assert out == "discarded"
    job = conn.execute("SELECT status, error FROM job WHERE id=%s", (jid,)).fetchone()
    assert job["status"] == "done" and job["error"]["code"] == "discarded_by_stale_guard"
    assert conn.execute("SELECT count(*) c FROM job WHERE type='process_meeting'").fetchone()["c"] == 0


def test_finalize_returns_lost_without_job_ownership(conn):
    mid, jid = _claimed_live(conn)
    out = db.finalize_live_session(
        conn, job_id=jid, worker_id="w2", meeting_id=mid, duration_ms=10, process_payload=PROCESS
    )
    assert out == "lost"
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == "recording"
```

`be/worker/tests/test_identify.py` 끝에:

```python
def test_identify_embedding_binds_at_threshold_and_returns_similarity(conn):
    from damwha_worker.pipeline.identify import identify_embedding

    sid = seed_speaker(conn, enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0] + [0.0] * 191)
    hit = identify_embedding(conn, [1.0] + [0.0] * 191, "speechbrain/spkrec-ecapa-voxceleb", 192, 0.6)
    assert hit is not None
    assert hit[0] == sid and hit[1] == pytest.approx(1.0, abs=1e-6)


def test_identify_embedding_returns_none_below_threshold_or_without_candidates(conn):
    from damwha_worker.pipeline.identify import identify_embedding

    assert identify_embedding(conn, [1.0] + [0.0] * 191, "m", 192, 0.6) is None
    sid = seed_speaker(conn, enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0] + [0.0] * 191)
    far = [0.0, 1.0] + [0.0] * 190  # cosine 0
    assert identify_embedding(conn, far, "speechbrain/spkrec-ecapa-voxceleb", 192, 0.6) is None
    # 모델이 다르면 후보가 아니다
    assert identify_embedding(conn, [1.0] + [0.0] * 191, "other-model", 192, 0.6) is None
```

`be/worker/tests/test_db_persist.py` 끝에:

```python
def test_persist_deletes_the_meetings_live_utterances(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    other = seed_meeting(conn)
    for m in (mid, other):
        db.insert_live_utterance(
            conn, meeting_id=m, job_id=jid, seq=0, start_ms=0, end_ms=500,
            text="미리보기", speaker_id=None, similarity=None,
        )
    out = db.persist_process_meeting(
        conn, job_id=jid, worker_id="w1", meeting_id=mid, processing_version=0,
        normalized_key="meetings/x/normalized.flac", duration_ms=500, utterances=[], clusters=[],
        embedding_model="speechbrain/spkrec-ecapa-voxceleb", embedding_dim=192,
    )
    assert out == "committed"
    count = lambda m: conn.execute(  # noqa: E731
        "SELECT count(*) c FROM live_utterance WHERE meeting_id=%s", (m,)
    ).fetchone()["c"]
    assert count(mid) == 0 and count(other) == 1
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd be/worker && uv run pytest tests/test_db_live.py tests/test_identify.py tests/test_db_persist.py -q`
Expected: FAIL — `AttributeError: module 'damwha_worker.db' has no attribute 'set_recording_started'`, `ImportError: identify_embedding`

- [ ] **Step 3: db 함수를 쓴다**

`be/worker/damwha_worker/db.py`, `peek_queued` 바로 앞에 추가:

```python
# ── 라이브 세션 (설계 §4·§5) ─────────────────────────────────────────────


def set_recording_started(conn, meeting_id: str, job_id: str) -> int:
    """캡처가 실제로 시작된 시각을 recorded_at에 찍는다. API 호출 시각이 아니라 첫 샘플
    시각이어야 경과 시간이 맞는다. 회의 가드(current_job_id·status)에 막히면 0."""
    cur = conn.execute(
        """
        UPDATE meeting SET recorded_at=now()
        WHERE id=%s AND current_job_id=%s AND status='recording'
        """,
        (meeting_id, job_id),
    )
    return cur.rowcount


def get_stop_requested(conn, job_id: str, worker_id: str) -> str | None:
    """루프가 1초마다 읽는 종료 신호. 'stop'=API가 종료 요청, 'lost'=소유권 상실
    (cancel·reaper), None=계속."""
    row = conn.execute(
        "SELECT status, locked_by, stop_requested_at FROM job WHERE id=%s", (job_id,)
    ).fetchone()
    if row is None or row["locked_by"] != worker_id or row["status"] != "running":
        return "lost"
    if row["stop_requested_at"] is not None:
        return "stop"
    return None


def insert_live_utterance(
    conn,
    *,
    meeting_id: str,
    job_id: str,
    seq: int,
    start_ms: int,
    end_ms: int,
    text: str,
    speaker_id: str | None,
    similarity: float | None,
) -> str:
    return conn.execute(
        """
        INSERT INTO live_utterance(meeting_id, job_id, seq, start_ms, end_ms, text,
                                   speaker_id, similarity)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id
        """,
        (meeting_id, job_id, seq, start_ms, end_ms, text, speaker_id, similarity),
    ).fetchone()["id"]


def delete_live_utterances(conn, meeting_id: str) -> int:
    return conn.execute("DELETE FROM live_utterance WHERE meeting_id=%s", (meeting_id,)).rowcount


def finalize_live_session(
    conn,
    *,
    job_id: str,
    worker_id: str,
    meeting_id: str,
    duration_ms: int,
    process_payload: dict,
) -> str:
    """녹음 종료: 회의를 uploaded로 바꾸고 payload의 v5 process_meeting을 그대로 큐잉한다.

    잠금 순서는 persist와 같은 job → meeting. API의 stop도 같은 순서라 교차하지 않는다.
    라이브 발화는 여기서 지우지 않는다 — 최종 패스가 도는 1~2분 동안 미리보기로 남아야 한다.
    """
    try:
        with conn.transaction():
            owned = conn.execute(
                "SELECT 1 FROM job WHERE id=%s AND locked_by=%s AND status='running' FOR UPDATE",
                (job_id, worker_id),
            ).fetchone()
            if owned is None:
                raise _Abort
            cur = conn.execute(
                """
                UPDATE meeting SET status='uploaded', duration_ms=%s, error=NULL
                WHERE id=%s AND status='recording' AND current_job_id=%s
                """,
                (duration_ms, meeting_id, job_id),
            )
            if cur.rowcount == 0:
                conn.execute(
                    "UPDATE job SET status='done', error=%s, updated_at=now() WHERE id=%s",
                    (
                        Jsonb(
                            {
                                "code": "discarded_by_stale_guard",
                                "message": "meeting is no longer recording under this job",
                                "stage": "finalize",
                            }
                        ),
                        job_id,
                    ),
                )
                return "discarded"
            new_job_id = conn.execute(
                "INSERT INTO job(type, meeting_id, payload) VALUES('process_meeting', %s, %s) "
                "RETURNING id",
                (meeting_id, Jsonb(process_payload)),
            ).fetchone()["id"]
            conn.execute(
                "UPDATE meeting SET current_job_id=%s WHERE id=%s", (new_job_id, meeting_id)
            )
            conn.execute(
                "UPDATE job SET status='done', progress=100, updated_at=now() WHERE id=%s",
                (job_id,),
            )
            return "committed"
    except _Abort:
        return "lost"
```

`persist_process_meeting` 안, 임시 화자 GC `DELETE FROM speaker s …` 문장 바로 뒤에:

```python
            # 라이브 미리보기 행은 정본이 들어오는 이 순간 역할이 끝난다 (설계 §2.4).
            conn.execute("DELETE FROM live_utterance WHERE meeting_id=%s", (meeting_id,))
```

- [ ] **Step 4: identify를 쓴다**

`be/worker/damwha_worker/pipeline/identify.py`: `identify_clusters`의 SQL 조회를 헬퍼로 뽑고, 라이브용 함수를 더한다.

`_vec` 정의 뒤에:

```python
def _nearest_voiceprint(conn, vector, model, dimension) -> tuple[str, float] | None:
    """matchable 화자의 성문 중 코사인 최근접 (speaker_id, similarity)."""
    row = conn.execute(
        """
        SELECT v.speaker_id, 1 - (v.embedding <=> %s::vector) AS similarity
        FROM voiceprint v
        JOIN speaker s ON s.id = v.speaker_id
        WHERE v.model = %s AND v.dimension = %s
          AND s.enrollment_status = ANY(%s)
        ORDER BY v.embedding <=> %s::vector ASC
        LIMIT 1
        """,
        (_vec(vector), model, dimension, list(MATCHABLE_STATUSES), _vec(vector)),
    ).fetchone()
    if row is None:
        return None
    return row["speaker_id"], float(row["similarity"])


def identify_embedding(conn, embedding, model, dimension, threshold) -> tuple[str, float] | None:
    """라이브 클립 하나의 임베딩을 결합한다. 최종 패스와 같은 후보 집합·같은 SQL이고,
    기준만 호출자가 정한다(라이브는 suggest_threshold — 설계 §2.8)."""
    hit = _nearest_voiceprint(conn, embedding, model, dimension)
    if hit is None or hit[1] < threshold:
        return None
    return hit
```

`identify_clusters`의 본문에서 `row = conn.execute(...)…fetchone()` ~ `sim = float(row["similarity"])`까지를 다음으로 교체:

```python
        hit = _nearest_voiceprint(conn, centroid, model, dimension)
        if hit is None:
            out[label] = ClusterMatch()
            continue
        speaker_id, sim = hit
```

그리고 아래 두 `ClusterMatch(...=row["speaker_id"], …)`의 `row["speaker_id"]`를 `speaker_id`로 바꾼다.

- [ ] **Step 5: 통과를 확인한다**

Run: `cd be/worker && uv run pytest tests/test_db_live.py tests/test_identify.py tests/test_db_persist.py tests/test_process_meeting.py -q && uv run ruff check . && uv run ruff format --check .`
Expected: PASS (process_meeting 회귀 포함)

- [ ] **Step 6: 커밋**

```bash
git add be/worker/damwha_worker/db.py be/worker/damwha_worker/pipeline/identify.py be/worker/tests/test_db_live.py be/worker/tests/test_identify.py be/worker/tests/test_db_persist.py
git commit -m "feat(worker): 라이브 세션 DB 함수와 단일 임베딩 식별을 더한다

Claude-Session: https://claude.ai/code/session_01X1x9qJVRgpKfcnajp5SrbJ"
```

---

### Task 10: `run_live_session` — 캡처·미리보기·finalize 루프

**Files:**
- Create: `be/worker/damwha_worker/pipeline/live_session.py`
- Modify: `be/worker/tests/fakes.py`
- Test: `be/worker/tests/test_live_session.py`

**Interfaces:**
- Consumes: Task 6~9의 `WavWriter`, `run_writer_thread`, `AudioSource`, `LiveSegmenter`, `StreamingVAD`, `db.*`, `identify_embedding`, `LiveSessionPayload`.
- Produces: `LiveModels(transcriber: Transcriber, embedder: Embedder, vad: StreamingVAD)`, `run_live_session(conn, job, payload, models, storage, source, *, worker_id, shutdown_event=None, max_minutes=240.0, clip_failure_limit=5, preview_max_frames=9375, stop_poll_seconds=1.0, clock=time.monotonic) -> str`(`"committed"` | `"discarded"` | `"lost"`), 실패는 `WorkerError`(항상 PERMANENT)로 올라간다. 내부 `Capture` 클래스(테스트 대상).
- `tests.fakes.SilenceSource(frame_bytes)` — stop()까지 무음 프레임을 5 ms 간격으로 낸다.

- [ ] **Step 1: fake와 실패하는 테스트를 쓴다**

`be/worker/tests/fakes.py` 끝에:

```python
class SilenceSource:
    """stop()이 올 때까지 무음 프레임을 낸다 — stop 플래그·상한 시간 테스트용."""

    def __init__(self, interval_seconds: float = 0.005) -> None:
        import threading

        self._stop = threading.Event()
        self._interval = interval_seconds
        self.emitted = 0

    def frames(self):
        import time

        while not self._stop.is_set():
            self.emitted += 1
            yield b"\x00" * 1024
            time.sleep(self._interval)

    def stop(self) -> None:
        self._stop.set()


class RaisingSource:
    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    def frames(self):
        raise self._exc
        yield  # noqa: RET503 — 제너레이터로 만들기 위한 도달 불가 yield

    def stop(self) -> None:
        pass
```

`be/worker/tests/test_live_session.py`:

```python
import queue
import threading
import time
import wave

import pytest

from damwha_worker import db
from damwha_worker.audio.source import FileSource
from damwha_worker.contracts import parse_payload
from damwha_worker.errors import AUDIO_DEVICE_FAILED, LIVE_STT_FAILED, ErrorKind, WorkerError
from damwha_worker.models.base import Word
from damwha_worker.pipeline.live_session import Capture, LiveModels, run_live_session
from damwha_worker.storage import Storage
from tests.audio_fixtures import make_wav
from tests.conftest import seed_job, seed_meeting, seed_speaker, seed_voiceprint
from tests.fakes import FakeEmbedder, FakeStreamingVAD, FakeTranscriber, RaisingSource, SilenceSource

EMB = "speechbrain/spkrec-ecapa-voxceleb"


def _payload(mid):
    process = {
        "schema_version": 5,
        "meeting_id": str(mid),
        "audio_key": f"meetings/{mid}/original.wav",
        "processing_version": 0,
        "reprocess": False,
        "models": {
            "whisper_model": "large-v3-turbo",
            "language": "ko",
            "devices": {"diarization": "cpu", "stt": "cpu"},
            "preset": "standard",
            "preset_revision": "2026-08-12.3",
            "summary_model": "mlx-community/Qwen3.5-4B-8bit",
            "diarization": {"model": "d", "min_speakers": None, "max_speakers": None},
            "embedding": {"model": EMB, "dimension": 192},
        },
        "identify": {"threshold": 0.8, "suggest_threshold": 0.6},
        "followups": {"lens": True, "summary": True},
    }
    return parse_payload(
        "live_session",
        {
            "schema_version": 1,
            "meeting_id": str(mid),
            "audio_key": f"meetings/{mid}/original.wav",
            "source": "mic",
            "process": process,
        },
    )


def _claimed(conn):
    mid = seed_meeting(conn, status="recording")
    jid = seed_job(conn, type="live_session", meeting_id=mid, max_attempts=1)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    return mid, conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone()


def _models(*, transcriber=None, embedder=None, vad=None):
    return LiveModels(
        transcriber=transcriber or FakeTranscriber([Word("안녕", 0, 400, 0.9), Word("하세요", 400, 800, 0.9)]),
        embedder=embedder or FakeEmbedder([[1.0] + [0.0] * 191]),
        vad=vad or FakeStreamingVAD({5: [("start", 0)], 40: [("end", 0)]}),
    )


def _run(conn, tmp_path, job, payload, models, source, **kw):
    return run_live_session(
        conn, job, payload, models, Storage(str(tmp_path)), source,
        worker_id="w1", stop_poll_seconds=kw.pop("stop_poll_seconds", 0.02), **kw,
    )


def test_session_writes_preview_rows_and_finalizes_into_process_meeting(conn, tmp_path):
    sid = seed_speaker(conn, name="영재", enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0] + [0.0] * 191)
    mid, job = _claimed(conn)
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 64))  # 64프레임 = 2048ms

    out = _run(conn, tmp_path, job, _payload(mid), _models(), src)

    assert out == "committed"
    rows = conn.execute(
        "SELECT seq, start_ms, end_ms, text, speaker_id, similarity FROM live_utterance "
        "WHERE meeting_id=%s ORDER BY seq", (mid,)
    ).fetchall()
    assert len(rows) == 1
    assert rows[0]["text"] == "안녕 하세요"
    assert rows[0]["start_ms"] == 0 and rows[0]["end_ms"] == 41 * 32  # pre-roll 5-6 프레임
    assert rows[0]["speaker_id"] == sid and rows[0]["similarity"] == pytest.approx(1.0, abs=1e-6)
    m = conn.execute("SELECT status, duration_ms, recorded_at, current_job_id FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert m["status"] == "uploaded" and m["duration_ms"] == 2048
    new = conn.execute("SELECT type, payload FROM job WHERE id=%s", (m["current_job_id"],)).fetchone()
    assert new["type"] == "process_meeting" and new["payload"] == _payload(mid).process_wire
    with wave.open(str(tmp_path / "meetings" / str(mid) / "original.wav"), "rb") as r:
        assert r.getnframes() == 64 * 512  # 헤더가 확정된 완전한 파일


def test_session_skips_rows_for_empty_transcripts_and_unknown_speakers(conn, tmp_path):
    mid, job = _claimed(conn)
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 64))
    models = _models(
        transcriber=FakeTranscriber([Word("모르는", 0, 300, 0.5)]),
        embedder=FakeEmbedder([[0.0, 1.0] + [0.0] * 190]),  # 등록 성문 없음 → 화자 ?
    )
    assert _run(conn, tmp_path, job, _payload(mid), models, src) == "committed"
    rows = conn.execute("SELECT speaker_id, similarity FROM live_utterance WHERE meeting_id=%s", (mid,)).fetchall()
    assert rows == [{"speaker_id": None, "similarity": None}]


def test_session_writes_nothing_when_transcript_is_empty(conn, tmp_path):
    mid, job = _claimed(conn)
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 64))
    assert _run(conn, tmp_path, job, _payload(mid), _models(transcriber=FakeTranscriber([])), src) == "committed"
    assert conn.execute("SELECT count(*) c FROM live_utterance WHERE meeting_id=%s", (mid,)).fetchone()["c"] == 0


def test_stop_flag_ends_capture_and_finalizes(conn, pg_url, tmp_path):
    mid, job = _claimed(conn)
    src = SilenceSource()
    result = {}
    # psycopg 커넥션은 스레드 간 공유가 안 된다 — 세션 스레드는 자기 커넥션을 쓴다
    t = threading.Thread(
        target=lambda: result.setdefault(
            "out", _run(db.connect(pg_url), tmp_path, job, _payload(mid), _models(vad=FakeStreamingVAD()), src)
        ),
    )
    t.start()
    time.sleep(0.2)
    conn.execute("UPDATE job SET stop_requested_at=now() WHERE id=%s", (job["id"],))
    t.join(timeout=10)
    assert result["out"] == "committed"
    assert src.emitted > 0
    with wave.open(str(tmp_path / "meetings" / str(mid) / "original.wav"), "rb") as r:
        assert r.getnframes() == src.emitted * 512 or r.getnframes() == (src.emitted - 1) * 512


def test_lost_ownership_returns_lost_and_keeps_the_file(conn, pg_url, tmp_path):
    mid, job = _claimed(conn)
    src = SilenceSource()
    result = {}
    t = threading.Thread(
        target=lambda: result.setdefault(
            "out", _run(db.connect(pg_url), tmp_path, job, _payload(mid), _models(vad=FakeStreamingVAD()), src)
        ),
    )
    t.start()
    time.sleep(0.2)
    conn.execute("UPDATE job SET status='failed' WHERE id=%s", (job["id"],))  # API cancel
    t.join(timeout=10)
    assert result["out"] == "lost"
    assert (tmp_path / "meetings" / str(mid) / "original.wav").exists()
    assert conn.execute("SELECT count(*) c FROM job WHERE type='process_meeting'").fetchone()["c"] == 0


def test_shutdown_event_finalizes_instead_of_requeue(conn, tmp_path):
    mid, job = _claimed(conn)
    ev = threading.Event()
    src = SilenceSource()
    threading.Timer(0.2, ev.set).start()
    out = _run(conn, tmp_path, job, _payload(mid), _models(vad=FakeStreamingVAD()), src, shutdown_event=ev)
    assert out == "committed"
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == "uploaded"


def test_max_duration_stops_the_session(conn, tmp_path):
    mid, job = _claimed(conn)
    src = SilenceSource()
    ticks = iter([0.0, 0.0, 0.0, 10_000.0, 10_000.0, 10_000.0, 10_000.0, 10_000.0])
    out = _run(conn, tmp_path, job, _payload(mid), _models(vad=FakeStreamingVAD()), src, max_minutes=1.0, clock=lambda: next(ticks, 10_000.0))
    assert out == "committed"


def test_consecutive_clip_failures_raise_live_stt_failed(conn, tmp_path):
    class Boom:
        def transcribe(self, *a, **k):
            raise RuntimeError("model exploded")

    mid, job = _claimed(conn)
    events = {i * 20: [("start", 0)] for i in range(6)} | {i * 20 + 15: [("end", 0)] for i in range(6)}
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 130))
    with pytest.raises(WorkerError) as ei:
        _run(conn, tmp_path, job, _payload(mid), _models(transcriber=Boom(), vad=FakeStreamingVAD(events)), src, clip_failure_limit=5)
    assert ei.value.code == LIVE_STT_FAILED and ei.value.kind is ErrorKind.PERMANENT
    # 파일은 닫혀 있고 완전하다
    with wave.open(str(tmp_path / "meetings" / str(mid) / "original.wav"), "rb") as r:
        assert r.getnframes() == 130 * 512


def test_one_clip_failure_is_tolerated_and_counter_resets(conn, tmp_path):
    class Flaky:
        def __init__(self):
            self.calls = 0

        def transcribe(self, *a, **k):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("once")
            return [Word("됐다", 0, 300, 0.9)]

    mid, job = _claimed(conn)
    events = {0: [("start", 0)], 15: [("end", 0)], 20: [("start", 0)], 35: [("end", 0)]}
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 64))
    out = _run(conn, tmp_path, job, _payload(mid), _models(transcriber=Flaky(), vad=FakeStreamingVAD(events)), src)
    assert out == "committed"
    assert conn.execute("SELECT count(*) c FROM live_utterance WHERE meeting_id=%s", (mid,)).fetchone()["c"] == 1


def test_source_failure_propagates_as_worker_error(conn, tmp_path):
    mid, job = _claimed(conn)
    src = RaisingSource(WorkerError(AUDIO_DEVICE_FAILED, "no mic", ErrorKind.PERMANENT))
    with pytest.raises(WorkerError) as ei:
        _run(conn, tmp_path, job, _payload(mid), _models(), src)
    assert ei.value.code == AUDIO_DEVICE_FAILED
    assert not (tmp_path / "meetings" / str(mid) / "original.wav").exists()  # 프레임 0 → 파일 없음


def test_file_is_complete_even_when_transcription_is_slow(conn, tmp_path):
    class Slow:
        def transcribe(self, *a, **k):
            time.sleep(0.3)
            return [Word("느림", 0, 300, 0.9)]

    mid, job = _claimed(conn)
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 200))
    events = {0: [("start", 0)], 10: [("end", 0)], 20: [("start", 0)], 30: [("end", 0)]}
    assert _run(conn, tmp_path, job, _payload(mid), _models(transcriber=Slow(), vad=FakeStreamingVAD(events)), src) == "committed"
    with wave.open(str(tmp_path / "meetings" / str(mid) / "original.wav"), "rb") as r:
        assert r.getnframes() == 200 * 512


def test_capture_bounds_the_preview_queue_but_never_the_writer_queue(tmp_path):
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 100))
    writer_q, preview_q = queue.Queue(), queue.Queue()
    cap = Capture(src, writer_q, preview_q, preview_max_frames=10)
    cap.start()
    cap.join(timeout=5)
    assert cap.error is None
    assert writer_q.qsize() == 101  # 100 프레임 + None
    assert preview_q.qsize() == 11  # 10 프레임 + None
    assert cap.dropped == 90
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd be/worker && uv run pytest tests/test_live_session.py -q`
Expected: FAIL — `ModuleNotFoundError: damwha_worker.pipeline.live_session`

- [ ] **Step 3: 루프를 쓴다**

`be/worker/damwha_worker/pipeline/live_session.py`:

```python
"""라이브 세션 — 마이크 프레임을 파일과 미리보기 파이프라인으로 나눠 흘린다.

[capture thread]  source.frames() ──▶ writer 큐 ──▶ [writer thread] WavWriter.append
                                  └─▶ preview 큐 (상한 5분, 넘치면 오래된 것부터 버림)
[main loop]       preview 큐 ──▶ LiveSegmenter ──segment──▶ temp wav
                              ──▶ transcribe ──▶ text (비면 건너뜀)
                              ──▶ embed ──▶ identify_embedding(suggest_threshold)
                              ──▶ insert_live_utterance(seq++)
                  매 1초: get_stop_requested, shutdown_event, 상한 시간

파일 쓰기와 미리보기는 서로 다른 큐·스레드다. 추론이 멈춰도 파일은 디스크 속도로 쓰인다
(설계 §2.9). 오류는 전부 PERMANENT — 끊긴 녹음은 이어 붙일 수 없다 (§2.6). DB 오류는
클립 실패로 세고 stop 폴링에서는 건너뛴다. 자식은 재접속하지 않는다는 워커 원칙 그대로다.
"""

import logging
import os
import queue
import tempfile
import threading
import time
import wave
from dataclasses import dataclass

from .. import db
from ..audio.source import FRAME_MS, SR, AudioSource
from ..audio.wav_writer import WavWriter, run_writer_thread
from ..contracts import LiveSessionPayload
from ..errors import LIVE_STT_FAILED, ErrorKind, WorkerError
from ..models.base import DiarSegment, Embedder, StreamingVAD, Transcriber
from ..storage import Storage
from .identify import identify_embedding
from .live_segmenter import LiveSegmenter, Segment
from .stage import enter_stage

log = logging.getLogger("damwha_worker")

PREVIEW_QUEUE_MAX_FRAMES = 5 * 60 * 1000 // FRAME_MS  # 5분
CLIP_FAILURE_LIMIT = 5
STOP_POLL_SECONDS = 1.0


@dataclass
class LiveModels:
    transcriber: Transcriber
    embedder: Embedder
    vad: StreamingVAD


class Capture:
    """capture thread: 소스의 프레임을 writer 큐와 preview 큐에 나눠 넣는다.

    writer 큐는 무제한이다 — 녹음은 한 프레임도 버리지 않는다. preview 큐만 상한을 두고
    넘치면 오래된 프레임부터 버린다(미리보기가 늦어질 뿐 파일은 온전하다). 소스가 끝나거나
    죽으면 두 큐에 None을 넣어 소비자를 깨운다.
    """

    def __init__(
        self,
        source: AudioSource,
        writer_q: "queue.Queue[bytes | None]",
        preview_q: "queue.Queue[bytes | None]",
        *,
        preview_max_frames: int,
    ) -> None:
        self._source = source
        self._writer_q = writer_q
        self._preview_q = preview_q
        self._max = preview_max_frames
        self.dropped = 0
        self.error: BaseException | None = None
        self._thread = threading.Thread(target=self._run, name="live-capture", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def join(self, timeout: float | None = None) -> None:
        self._thread.join(timeout)

    def _run(self) -> None:
        try:
            for pcm in self._source.frames():
                self._writer_q.put(pcm)
                if self._preview_q.qsize() >= self._max:
                    try:
                        self._preview_q.get_nowait()
                        self.dropped += 1
                        if self.dropped in (1, 100, 1000) or self.dropped % 10000 == 0:
                            log.warning("live preview queue full — dropped %d frames", self.dropped)
                    except queue.Empty:
                        pass
                self._preview_q.put(pcm)
        except BaseException as exc:  # noqa: BLE001 — 메인 루프가 다시 던진다
            self.error = exc
        finally:
            self._writer_q.put(None)
            self._preview_q.put(None)


def _write_clip(path: str, pcm: bytes) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)


_NO_FRAME = object()


def run_live_session(
    conn,
    job: dict,
    payload: LiveSessionPayload,
    models: LiveModels,
    storage: Storage,
    source: AudioSource,
    *,
    worker_id: str,
    shutdown_event: threading.Event | None = None,
    max_minutes: float = 240.0,
    clip_failure_limit: int = CLIP_FAILURE_LIMIT,
    preview_max_frames: int = PREVIEW_QUEUE_MAX_FRAMES,
    stop_poll_seconds: float = STOP_POLL_SECONDS,
    clock=time.monotonic,
) -> str:
    job_id = job["id"]
    meeting_id = payload.meeting_id
    ctx = f"job={job_id} meeting={meeting_id}"
    enter_stage(conn, job_id, worker_id, "capture", 0, shutdown_event)
    if db.set_recording_started(conn, meeting_id, job_id) == 0:
        log.info("%s live_session lost ownership before capture", ctx)
        return "lost"

    writer = WavWriter(storage.resolve(payload.audio_key))
    writer_q: queue.Queue[bytes | None] = queue.Queue()
    preview_q: queue.Queue[bytes | None] = queue.Queue()
    writer_thread = run_writer_thread(writer, writer_q)
    capture = Capture(source, writer_q, preview_q, preview_max_frames=preview_max_frames)
    segmenter = LiveSegmenter(models.vad)
    tmpdir = tempfile.TemporaryDirectory(prefix="damwha-live-")
    state = {"seq": 0, "failures": 0}
    started = clock()
    last_poll = started
    stop_reason: str | None = None
    log.info("%s live_session capture start", ctx)

    def handle(seg: Segment) -> None:
        clip = os.path.join(tmpdir.name, f"seg_{state['seq']}.wav")
        try:
            _write_clip(clip, seg.pcm)
            words = models.transcriber.transcribe(clip, payload.process.models.language)
            text = " ".join(w.text for w in words).strip()
            if not text:
                state["failures"] = 0
                return
            speaker_id = None
            similarity = None
            emb = models.embedder.embed(clip, [DiarSegment("LIVE", 0, seg.end_ms - seg.start_ms)])[0]
            if emb is not None:
                identify = payload.process.identify
                hit = identify_embedding(
                    conn,
                    emb,
                    payload.process.models.embedding.model,
                    payload.process.models.embedding.dimension,
                    # 라이브는 suggest 기준 (설계 §2.8). v5는 항상 값이 있지만 타입상 None을 막는다.
                    identify.suggest_threshold if identify.suggest_threshold is not None else identify.threshold,
                )
                if hit is not None:
                    speaker_id, similarity = hit
            db.insert_live_utterance(
                conn,
                meeting_id=meeting_id,
                job_id=job_id,
                seq=state["seq"],
                start_ms=seg.start_ms,
                end_ms=seg.end_ms,
                text=text,
                speaker_id=speaker_id,
                similarity=similarity,
            )
            state["seq"] += 1
            state["failures"] = 0
        except Exception as exc:  # noqa: BLE001 — 클립 하나는 세션을 죽이지 않는다
            state["failures"] += 1
            log.warning("%s live clip failed (%d/%d): %r", ctx, state["failures"], clip_failure_limit, exc)
            if state["failures"] >= clip_failure_limit:
                raise WorkerError(
                    LIVE_STT_FAILED,
                    f"{state['failures']} consecutive clip failures: {exc}",
                    ErrorKind.PERMANENT,
                    stage="capture",
                ) from exc
        finally:
            try:
                os.unlink(clip)
            except FileNotFoundError:
                pass

    try:
        capture.start()
        while True:
            try:
                pcm = preview_q.get(timeout=stop_poll_seconds)
            except queue.Empty:
                pcm = _NO_FRAME
            if pcm is None:
                stop_reason = "source_ended"
                break
            if pcm is not _NO_FRAME:
                for seg in segmenter.push(pcm):
                    handle(seg)
            now = clock()
            if now - last_poll >= stop_poll_seconds:
                last_poll = now
                try:
                    signal = db.get_stop_requested(conn, job_id, worker_id)
                except Exception:  # noqa: BLE001 — DB가 잠깐 죽어도 녹음은 계속
                    log.warning("%s stop poll failed — continuing", ctx, exc_info=True)
                    signal = None
                if signal == "lost":
                    stop_reason = "lost"
                    break
                if signal == "stop":
                    stop_reason = "stop"
                    break
                if shutdown_event is not None and shutdown_event.is_set():
                    stop_reason = "shutdown"
                    break
                if now - started >= max_minutes * 60:
                    stop_reason = "max_duration"
                    break
        # 정상 종료 순서 (설계 §4): 캡처 닫기 → writer 비우고 파일 닫기 → 마지막 발화 → finalize
        source.stop()
        capture.join(timeout=10)
        writer_thread.join(timeout=60)
        writer.close()
        if capture.error is not None:
            raise capture.error
        log.info(
            "%s live_session capture end reason=%s duration_ms=%d rows=%d dropped=%d",
            ctx, stop_reason, writer.duration_ms, state["seq"], capture.dropped,
        )
        if stop_reason == "lost":
            return "lost"
        last = segmenter.flush()
        if last is not None:
            handle(last)
        if db.set_stage(conn, job_id, worker_id, "finalize", 100) == 0:
            return "lost"
        return db.finalize_live_session(
            conn,
            job_id=job_id,
            worker_id=worker_id,
            meeting_id=meeting_id,
            duration_ms=writer.duration_ms,
            process_payload=payload.process_wire,
        )
    finally:
        # 예외 경로에서도 파일은 닫는다(헤더 확정). 소스는 두 번 stop해도 안전하다.
        source.stop()
        writer_q.put(None)
        writer_thread.join(timeout=60)
        writer.close()
        if writer.frames_written == 0:
            # 마이크를 못 열었거나 프레임이 하나도 없었다 — 헤더만 남은 파일은 "파일 없음"이 맞다 (§8).
            try:
                os.unlink(storage.resolve(payload.audio_key))
            except FileNotFoundError:
                pass
        tmpdir.cleanup()
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd be/worker && uv run pytest tests/test_live_session.py -q && uv run ruff check . && uv run ruff format --check .`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add be/worker/damwha_worker/pipeline/live_session.py be/worker/tests/fakes.py be/worker/tests/test_live_session.py
git commit -m "feat(worker): 라이브 세션 루프를 더한다 — 캡처·미리보기 분리, finalize

Claude-Session: https://claude.ai/code/session_01X1x9qJVRgpKfcnajp5SrbJ"
```

---

### Task 11: 디스패치·registry·설정 — `live_session`을 워커에 연결

**Files:**
- Modify: `be/worker/damwha_worker/__main__.py`
- Modify: `be/worker/damwha_worker/models/registry.py`
- Modify: `be/worker/damwha_worker/config.py`
- Test: `be/worker/tests/test_dispatch_live.py`, `be/worker/tests/test_config.py`

**Interfaces:**
- Consumes: `run_live_session`, `LiveModels`, `MicSource`, `StreamingSileroVAD`.
- Produces: `handle_job(..., build_live_models=None, build_live_source=None, live_max_minutes=240.0)`; `dispatch_claimed_job(..., build_live_models_fn=None, build_live_source_fn=None)`; `run_single_job(..., build_live_models_fn=None, build_live_source_fn=None)`; `registry.build_live_models(payload: dict, settings) -> LiveModels`; `Settings.live_max_minutes: float = 240.0`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_dispatch_live.py`:

```python
from damwha_worker import db
from damwha_worker.__main__ import handle_job
from damwha_worker.audio.source import FileSource
from damwha_worker.errors import AUDIO_DEVICE_FAILED, ErrorKind, WorkerError
from damwha_worker.models.base import Word
from damwha_worker.pipeline.live_session import LiveModels
from damwha_worker.storage import Storage
from tests.audio_fixtures import make_wav
from tests.conftest import seed_job, seed_meeting
from tests.fakes import FakeEmbedder, FakeStreamingVAD, FakeTranscriber, RaisingSource


def _live_payload(mid):
    return {
        "schema_version": 1,
        "meeting_id": str(mid),
        "audio_key": f"meetings/{mid}/original.wav",
        "source": "mic",
        "process": {
            "schema_version": 5,
            "meeting_id": str(mid),
            "audio_key": f"meetings/{mid}/original.wav",
            "processing_version": 0,
            "reprocess": False,
            "models": {
                "whisper_model": "large-v3-turbo",
                "language": "ko",
                "devices": {"diarization": "cpu", "stt": "cpu"},
                "preset": "standard",
                "preset_revision": None,
                "summary_model": "mlx-community/Qwen3.5-4B-8bit",
                "diarization": {"model": "d", "min_speakers": None, "max_speakers": None},
                "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
            },
            "identify": {"threshold": 0.8, "suggest_threshold": 0.6},
            "followups": {"lens": True, "summary": True},
        },
    }


def _claimed(conn, mid):
    jid = seed_job(conn, type="live_session", meeting_id=mid, payload=_live_payload(mid), max_attempts=1)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    return conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone()


def _models():
    return LiveModels(
        transcriber=FakeTranscriber([Word("안녕", 0, 300, 0.9)]),
        embedder=FakeEmbedder([None]),
        vad=FakeStreamingVAD({2: [("start", 0)], 30: [("end", 0)]}),
    )


def test_dispatches_live_session_and_queues_the_final_pass(conn, tmp_path):
    mid = seed_meeting(conn, status="recording")
    job = _claimed(conn, mid)
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 64))
    out = handle_job(
        conn, job, Storage(str(tmp_path)), "w1",
        build_live_models=_models, build_live_source=lambda: src,
    )
    assert out == "committed"
    m = conn.execute("SELECT status, current_job_id FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert m["status"] == "uploaded"
    assert conn.execute("SELECT type FROM job WHERE id=%s", (m["current_job_id"],)).fetchone()["type"] == "process_meeting"


def test_live_failure_never_requeues_even_when_transient(conn, tmp_path):
    mid = seed_meeting(conn, status="recording")
    job = _claimed(conn, mid)
    src = RaisingSource(WorkerError(AUDIO_DEVICE_FAILED, "no mic", ErrorKind.TRANSIENT))
    out = handle_job(
        conn, job, Storage(str(tmp_path)), "w1",
        build_live_models=_models, build_live_source=lambda: src,
    )
    assert out == "failed"
    j = conn.execute("SELECT status, error FROM job WHERE id=%s", (job["id"],)).fetchone()
    assert j["status"] == "failed" and j["error"]["code"] == AUDIO_DEVICE_FAILED
    m = conn.execute("SELECT status, error FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert m["status"] == "failed" and m["error"]["code"] == AUDIO_DEVICE_FAILED
```

`be/worker/tests/test_config.py` 끝에 (기존 테스트가 `Settings`를 어떻게 만드는지 그대로 따라 — 파일 상단의 헬퍼를 쓴다):

```python
def test_live_max_minutes_defaults_to_four_hours(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x")
    monkeypatch.setenv("LENS_LLM_BASE_URL", "http://127.0.0.1:8000/v1")
    from damwha_worker.config import Settings

    assert Settings(_env_file=None).live_max_minutes == 240.0
    monkeypatch.setenv("LIVE_MAX_MINUTES", "30")
    assert Settings(_env_file=None).live_max_minutes == 30.0
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd be/worker && uv run pytest tests/test_dispatch_live.py tests/test_config.py -q`
Expected: FAIL — `handle_job() got an unexpected keyword argument 'build_live_models'`, `live_max_minutes` 속성 없음

- [ ] **Step 3: 설정·registry·디스패치를 쓴다**

`be/worker/damwha_worker/config.py`: `stt_chunk_minutes: float = 25.0` 아래에

```python
    # 라이브 세션 상한. 넘으면 stop이 온 것과 똑같이 finalize한다 (설계 §4).
    live_max_minutes: float = 240.0
```

`be/worker/damwha_worker/models/registry.py` 끝에:

```python
def build_live_models(payload: dict, settings: Settings):
    """live_session payload → 세션 자식이 상주시킬 세 모델. pyannote는 안 뜬다 (설계 §5.1)."""
    from ..pipeline.live_session import LiveModels
    from .silero_vad import StreamingSileroVAD

    m = parse_models(payload["process"])
    if m.devices.stt == "gpu":
        from .whisper_mlx import MlxWhisper

        transcriber = MlxWhisper(m.whisper_model)
    else:
        from .whisper_faster import FasterWhisper

        transcriber = FasterWhisper(m.whisper_model, device="cpu")
    return LiveModels(
        transcriber=transcriber,
        embedder=EcapaEmbedder(m.embedding.model, "cpu"),
        vad=StreamingSileroVAD(),
    )
```

`be/worker/damwha_worker/__main__.py`:

1. import에 `from .pipeline.live_session import run_live_session` 추가.
2. `handle_job` 시그니처의 `register_abort=None,` 뒤에:

```python
    build_live_models=None,
    build_live_source=None,
    live_max_minutes=240.0,
```

3. `handle_job` 안 `if job["type"] == "summarize_meeting":` 블록 뒤, `raise ValueError(f"unknown job type …")` 앞에:

```python
        if job["type"] == "live_session":
            # 소유권 상실은 루프가 1초마다 직접 읽는다(get_stop_requested → 'lost') —
            # process_meeting의 shutdown 훅은 걸지 않는다. shutdown_event는 루프가 stop으로 다룬다.
            live_models = build_live_models()
            source = build_live_source()
            return run_live_session(
                conn,
                job,
                payload,
                live_models,
                storage,
                source,
                worker_id=worker_id,
                shutdown_event=shutdown_event,
                max_minutes=live_max_minutes,
            )
```

4. `except Exception as exc:` 분기 안, `transient_retry = …` 줄 바로 뒤에:

```python
        if job["type"] == "live_session":
            # 재시도는 없다 (설계 §2.6). 끊긴 녹음은 이어 붙일 수 없고, 파일은 디스크에 남는다.
            ok = db.fail_process_meeting(conn, job["id"], worker_id, job["meeting_id"], error_json)
            return "failed" if ok else "lost"
```

5. `dispatch_claimed_job` 시그니처에 `build_live_models_fn=None, build_live_source_fn=None,` 추가, `handle_job(...)` 호출에

```python
            build_live_models=(
                (lambda: build_live_models_fn(job["payload"], settings)) if build_live_models_fn else None
            ),
            build_live_source=build_live_source_fn,
            live_max_minutes=settings.live_max_minutes,
```

6. `run_single_job` 시그니처에 `build_live_models_fn=None, build_live_source_fn=None,` 추가하고 `dispatch_claimed_job(...)` 호출에 `build_live_models_fn=build_live_models_fn, build_live_source_fn=build_live_source_fn,` 전달.

7. `run_child`에 두 빌더를 더하고 `run_single_job` 호출에 넘긴다:

```python
    def _build_live_models(payload, worker_settings):
        from .models.registry import build_live_models

        return build_live_models(payload, worker_settings)

    def _build_live_source():
        from .audio.source import MicSource

        return MicSource()
```

`run_single_job(...)` 호출 인자에 `build_live_models_fn=_build_live_models, build_live_source_fn=_build_live_source,`.

- [ ] **Step 4: 통과를 확인한다**

Run: `cd be/worker && uv run pytest -q && uv run ruff check . && uv run ruff format --check .`
Expected: 전체 PASS

- [ ] **Step 5: 커밋**

```bash
git add be/worker/damwha_worker/__main__.py be/worker/damwha_worker/models/registry.py be/worker/damwha_worker/config.py be/worker/tests/test_dispatch_live.py be/worker/tests/test_config.py
git commit -m "feat(worker): live_session job을 디스패치한다 — 실패는 재시도 없이 회의를 닫는다

Claude-Session: https://claude.ai/code/session_01X1x9qJVRgpKfcnajp5SrbJ"
```

---

### Task 12: API — `src/live/` 모듈과 엔드포인트 셋

**Files:**
- Create: `be/src/live/live.repository.ts`, `be/src/live/live.service.ts`, `be/src/live/live.controller.ts`, `be/src/live/live.module.ts`
- Modify: `be/src/app.module.ts`
- Test: `be/test/live.e2e-spec.ts`, `be/test/demo-read-only.e2e-spec.ts`

**Interfaces:**
- Consumes: `buildLiveSessionPayload`, `JobsRepository.enqueue({maxAttempts})`, `MeetingsRepository.lockById/setCurrentJob/deleteById`, `SettingsService.getProcessingConfig`, `CapabilitiesService.get`, `resolveProcessingConfig`, `ProcessingOverrideSchema`, `SpeakerBoundsSchema`, `StorageService.meetingKey/meetingDir/deleteDir`, `nextId`.
- Produces: `POST /meetings/live` → 201 `MeetingRow`; `POST /meetings/:id/live/stop` → 200 `{ meeting_id, job_id, outcome: 'stopping' | 'discarded' }`; `GET /meetings/:id/live?after=<seq>` → 200 `{ status, stage, heartbeat_at, items: [{ id, seq, start_ms, end_ms, text, speaker_id, speaker_name, similarity }] }`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/test/live.e2e-spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { JobsRepository } from '../src/jobs/jobs.repository';
import { LiveSessionPayloadSchema } from '../src/contracts/job-payload.schema';

describe('live session api', () => {
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
  const start = (body: object = {}) => request(srv()).post('/meetings/live').send(body);

  /** 워커의 claim을 SQL로 흉내 낸다. */
  const claim = (jobId: string) =>
    db.pool.query(
      `UPDATE job SET status='running', locked_by='w1', locked_at=now(), attempts=1, stage='capture' WHERE id=$1`,
      [jobId],
    );

  it('POST /meetings/live creates a recording meeting and a live_session job with max_attempts=1', async () => {
    const res = await start({ title: '오늘 회의', defer_summary: true, speakers: { min: 2 } });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('recording');
    expect(res.body.title).toBe('오늘 회의');
    expect(res.body.audio_key).toMatch(/^meetings\/mtg_[1-9][0-9]*\/original\.wav$/);
    const job = (await db.pool.query('SELECT * FROM job WHERE id=$1', [res.body.current_job_id])).rows[0];
    expect(job.type).toBe('live_session');
    expect(job.max_attempts).toBe(1);
    expect(job.stop_requested_at).toBeNull();
    const payload = LiveSessionPayloadSchema.parse(job.payload);
    expect(payload.audio_key).toBe(res.body.audio_key);
    expect(payload.process.followups).toEqual({ lens: true, summary: false });
    expect(payload.process.models.diarization.min_speakers).toBe(2);
    expect(payload.process.processing_version).toBe(0);
  });

  it('POST /meetings/live → 409 while another recording exists', async () => {
    await start().expect(201);
    const res = await start();
    expect(res.status).toBe(409);
  });

  it('two simultaneous starts yield exactly one 201 and one 409 (unique index)', async () => {
    const [a, b] = await Promise.all([start(), start()]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM meeting WHERE status='recording'`);
    expect(rows[0].n).toBe(1);
  });

  it('POST /meetings/live → 400 for a bad override or flag, and creates nothing', async () => {
    expect((await start({ processing: { preset: 'huge' } })).status).toBe(400);
    expect((await start({ defer_lens: 'maybe' })).status).toBe(400);
    expect((await start({ title: 42 })).status).toBe(400);
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM meeting');
    expect(rows[0].n).toBe(0);
  });

  it('stop on a queued session discards the meeting and job', async () => {
    const created = await start().expect(201);
    const res = await request(srv()).post(`/meetings/${created.body.id}/live/stop`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ meeting_id: created.body.id, job_id: created.body.current_job_id, outcome: 'discarded' });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM meeting')).rows[0].n).toBe(0);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM job')).rows[0].n).toBe(0);
  });

  it('stop on a running session sets stop_requested_at once and is idempotent', async () => {
    const created = await start().expect(201);
    await claim(created.body.current_job_id);
    const first = await request(srv()).post(`/meetings/${created.body.id}/live/stop`).expect(200);
    expect(first.body.outcome).toBe('stopping');
    const at1 = (await db.pool.query('SELECT stop_requested_at FROM job WHERE id=$1', [created.body.current_job_id])).rows[0].stop_requested_at;
    expect(at1).not.toBeNull();
    const second = await request(srv()).post(`/meetings/${created.body.id}/live/stop`).expect(200);
    expect(second.body.outcome).toBe('stopping');
    const at2 = (await db.pool.query('SELECT stop_requested_at FROM job WHERE id=$1', [created.body.current_job_id])).rows[0].stop_requested_at;
    expect(new Date(at2).getTime()).toBe(new Date(at1).getTime());
  });

  it('stop → 409 when the meeting is not recording, 404 when missing', async () => {
    const done = await db.pool.query(`INSERT INTO meeting(audio_key,status) VALUES('k','done') RETURNING id`);
    expect((await request(srv()).post(`/meetings/${done.rows[0].id}/live/stop`)).status).toBe(409);
    expect((await request(srv()).post(`/meetings/mtg_999/live/stop`)).status).toBe(404);
  });

  it('a claim skips the session job while stop holds its row lock', async () => {
    const created = await start().expect(201);
    const jobId = created.body.current_job_id;
    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT * FROM job WHERE id=$1 FOR UPDATE', [jobId]);
      const repo = new JobsRepository();
      expect(await repo.claim(db.pool, 'w1')).toBeNull(); // SKIP LOCKED
      await holder.query('ROLLBACK');
      const claimed = await repo.claim(db.pool, 'w1');
      expect(claimed!.id).toBe(jobId);
    } finally {
      holder.release();
    }
    const res = await request(srv()).post(`/meetings/${created.body.id}/live/stop`).expect(200);
    expect(res.body.outcome).toBe('stopping');
  });

  it('GET /meetings/:id/live returns rows after the cursor with speaker names, stage and heartbeat', async () => {
    const created = await start().expect(201);
    const mid = created.body.id;
    await claim(created.body.current_job_id);
    const sp = await db.pool.query(`INSERT INTO speaker(name, enrollment_status) VALUES('영재','ready') RETURNING id`);
    const ins = (seq: number, text: string, speaker: string | null) =>
      db.pool.query(
        `INSERT INTO live_utterance(meeting_id, job_id, seq, start_ms, end_ms, text, speaker_id, similarity)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [mid, created.body.current_job_id, seq, seq * 1000, seq * 1000 + 800, text, speaker, speaker ? 0.82 : null],
      );
    await ins(0, '첫 줄', sp.rows[0].id);
    await ins(1, '둘째 줄', null);
    await ins(2, '셋째 줄', null);

    const all = await request(srv()).get(`/meetings/${mid}/live`).expect(200);
    expect(all.body.status).toBe('recording');
    expect(all.body.stage).toBe('capture');
    expect(all.body.heartbeat_at).not.toBeNull();
    expect(all.body.items.map((i: { seq: number }) => i.seq)).toEqual([0, 1, 2]);
    expect(all.body.items[0]).toMatchObject({ text: '첫 줄', speaker_name: '영재', similarity: 0.82 });
    expect(all.body.items[1]).toMatchObject({ speaker_id: null, speaker_name: null, similarity: null });

    const after = await request(srv()).get(`/meetings/${mid}/live?after=1`).expect(200);
    expect(after.body.items.map((i: { seq: number }) => i.seq)).toEqual([2]);

    expect((await request(srv()).get(`/meetings/${mid}/live?after=x`)).status).toBe(400);
    expect((await request(srv()).get(`/meetings/mtg_999/live`)).status).toBe(404);
  });

  it('GET /meetings/:id/live still serves rows for a failed meeting', async () => {
    const created = await start().expect(201);
    const mid = created.body.id;
    await db.pool.query(
      `INSERT INTO live_utterance(meeting_id, job_id, seq, start_ms, end_ms, text) VALUES($1,$2,0,0,500,'남는다')`,
      [mid, created.body.current_job_id],
    );
    await db.pool.query(`UPDATE meeting SET status='failed' WHERE id=$1`, [mid]);
    const res = await request(srv()).get(`/meetings/${mid}/live`).expect(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.items).toHaveLength(1);
  });
});
```

`be/test/demo-read-only.e2e-spec.ts` `describe` 끝에:

```ts
  it('live start/stop are closed in demo mode', async () => {
    expect((await request(srv()).post('/meetings/live').send({})).status).toBe(403);
    expect((await request(srv()).post('/meetings/mtg_1/live/stop')).status).toBe(403);
    expect((await request(srv()).get('/meetings/mtg_1/live')).status).not.toBe(403);
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd be && pnpm exec jest test/live.e2e-spec.ts`
Expected: FAIL — `POST /meetings/live` 404

- [ ] **Step 3: repository를 쓴다**

`be/src/live/live.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { JobRow, Queryable } from '../jobs/jobs.types';
import { MeetingRow } from '../meetings/meetings.repository';

export interface LiveUtteranceRow {
  id: string; seq: number; start_ms: number; end_ms: number; text: string;
  speaker_id: string | null; speaker_name: string | null; similarity: number | null;
}
export interface LiveHeadRow { status: string; stage: string | null; heartbeat_at: Date | null }

@Injectable()
export class LiveRepository {
  async findRecording(exec: Queryable): Promise<MeetingRow | null> {
    const { rows } = await exec.query<MeetingRow>(`SELECT * FROM meeting WHERE status='recording' LIMIT 1`);
    return rows[0] ?? null;
  }

  async createRecording(
    exec: Queryable, args: { id: string; audioKey: string; title: string | null },
  ): Promise<MeetingRow> {
    const { rows } = await exec.query<MeetingRow>(
      `INSERT INTO meeting(id, title, audio_key, status) VALUES($1,$2,$3,'recording') RETURNING *`,
      [args.id, args.title, args.audioKey],
    );
    return rows[0];
  }

  /**
   * 세션 job 행을 먼저 잠근다 (job → meeting 순서, 워커 persist와 동일). 회의만 잠그면
   * 그 사이 claim(`FOR UPDATE SKIP LOCKED`, job 행만)이 끼어들어 이미 시작된 세션을
   * 지울 수 있다 — 설계 §4.
   */
  async lockSessionJob(exec: Queryable, meetingId: string): Promise<JobRow | null> {
    const { rows } = await exec.query<JobRow>(
      `SELECT j.* FROM job j JOIN meeting m ON m.current_job_id = j.id
       WHERE m.id=$1 AND j.type='live_session' FOR UPDATE OF j`,
      [meetingId],
    );
    return rows[0] ?? null;
  }

  async requestStop(exec: Queryable, jobId: string): Promise<JobRow> {
    const { rows } = await exec.query<JobRow>(
      `UPDATE job SET stop_requested_at = COALESCE(stop_requested_at, now()), updated_at=now()
       WHERE id=$1 RETURNING *`,
      [jobId],
    );
    return rows[0];
  }

  async findHead(exec: Queryable, meetingId: string): Promise<LiveHeadRow | null> {
    const { rows } = await exec.query<LiveHeadRow>(
      `SELECT m.status, j.stage, j.locked_at AS heartbeat_at
       FROM meeting m LEFT JOIN job j ON j.id = m.current_job_id
       WHERE m.id=$1`,
      [meetingId],
    );
    return rows[0] ?? null;
  }

  async findUtterances(exec: Queryable, meetingId: string, afterSeq: number): Promise<LiveUtteranceRow[]> {
    const { rows } = await exec.query<LiveUtteranceRow>(
      `SELECT lu.id, lu.seq, lu.start_ms, lu.end_ms, lu.text, lu.speaker_id,
              s.name AS speaker_name, lu.similarity
       FROM live_utterance lu LEFT JOIN speaker s ON s.id = lu.speaker_id
       WHERE lu.meeting_id=$1 AND lu.seq > $2
       ORDER BY lu.seq ASC`,
      [meetingId, afterSeq],
    );
    return rows;
  }
}
```

- [ ] **Step 4: service를 쓴다**

`be/src/live/live.service.ts`:

```ts
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { JobsRepository } from '../jobs/jobs.repository';
import { MeetingsRepository } from '../meetings/meetings.repository';
import { SettingsService } from '../settings/settings.service';
import { CapabilitiesService } from '../system/capabilities.service';
import { ProcessingOverride, ProcessingOverrideSchema, resolveProcessingConfig } from '../settings/resolve-processing';
import { SpeakerBounds, SpeakerBoundsSchema } from '../meetings/speaker-bounds';
import { buildLiveSessionPayload } from '../contracts/job-payload.schema';
import { nextId } from '../common/id';
import { LiveRepository } from './live.repository';

const RECORDING_INDEX = 'meeting_single_recording_idx';

function isSingleRecordingViolation(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string } | null;
  return err?.code === '23505' && err?.constraint === RECORDING_INDEX;
}

@Injectable()
export class LiveService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly jobs: JobsRepository,
    private readonly meetings: MeetingsRepository,
    private readonly live: LiveRepository,
    private readonly settings: SettingsService,
    private readonly caps: CapabilitiesService,
  ) {}

  // JSON body라 multipart 문자열 파싱은 없다. 불리언은 불리언으로 받되, 업로드와의 대칭을
  // 위해 "true"/"false" 문자열도 받는다. 그 외는 400.
  private parseFlag(v: unknown, field: string): boolean {
    if (v === undefined || v === null || v === '' || v === false || v === 'false') return false;
    if (v === true || v === 'true') return true;
    throw new BadRequestException(`${field} must be a boolean`);
  }

  private parseTitle(v: unknown): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new BadRequestException('title must be a string');
    const t = v.trim();
    return t === '' ? null : t;
  }

  private parseOverride(v: unknown): ProcessingOverride | undefined {
    if (v === undefined) return undefined;
    const r = ProcessingOverrideSchema.safeParse(v);
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join('; '));
    return r.data;
  }

  private parseSpeakers(v: unknown): SpeakerBounds | undefined {
    if (v === undefined) return undefined;
    const r = SpeakerBoundsSchema.safeParse(v);
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join('; '));
    return r.data;
  }

  async start(body: {
    title?: unknown; processing?: unknown; speakers?: unknown; defer_lens?: unknown; defer_summary?: unknown;
  }) {
    const title = this.parseTitle(body.title);
    const override = this.parseOverride(body.processing);
    const speakers = this.parseSpeakers(body.speakers);
    const followups = {
      lens: !this.parseFlag(body.defer_lens, 'defer_lens'),
      summary: !this.parseFlag(body.defer_summary, 'defer_summary'),
    };
    const global_ = await this.settings.getProcessingConfig();
    const processing = resolveProcessingConfig(global_, override, (await this.caps.get()).gpu_eligible);

    // 친절한 메시지를 위한 사전 조회. 보장은 아래 INSERT의 부분 유일 인덱스가 한다 (설계 §4).
    if (await this.live.findRecording(this.db.pool)) {
      throw new ConflictException('a recording is already in progress');
    }
    const meetingId = await nextId(this.db.pool, 'meeting');
    const audioKey = this.storage.meetingKey(meetingId, 'live.wav');
    try {
      return await this.db.withTransaction(async (c) => {
        await this.live.createRecording(c, { id: meetingId, audioKey, title });
        const payload = buildLiveSessionPayload({ meetingId, audioKey, processing, followups, speakers });
        // 재시도 없음 — 끊긴 녹음은 이어 붙일 수 없다 (설계 §2.6).
        const job = await this.jobs.enqueue(c, { type: 'live_session', meetingId, payload, maxAttempts: 1 });
        return this.meetings.setCurrentJob(c, meetingId, job.id);
      });
    } catch (e) {
      if (isSingleRecordingViolation(e)) throw new ConflictException('a recording is already in progress');
      throw e;
    }
  }

  async stop(id: string): Promise<{ meeting_id: string; job_id: string; outcome: 'stopping' | 'discarded' }> {
    const result = await this.db.withTransaction(async (c) => {
      const job = await this.live.lockSessionJob(c, id); // job 먼저 (설계 §4 잠금 순서)
      const meeting = await this.meetings.lockById(c, id);
      if (!meeting) throw new NotFoundException('meeting not found');
      if (meeting.status !== 'recording' || !job) throw new ConflictException('meeting is not recording');
      if (job.status === 'running') {
        await this.live.requestStop(c, job.id);
        return { meeting_id: id, job_id: job.id, outcome: 'stopping' as const };
      }
      if (job.status === 'queued') {
        // 워커가 아직 마이크를 열지 않았다 — 녹음된 게 없으니 회의째 지운다 (job은 cascade).
        await this.meetings.deleteById(c, id);
        return { meeting_id: id, job_id: job.id, outcome: 'discarded' as const };
      }
      throw new ConflictException(`live session job is ${job.status}`);
    });
    if (result.outcome === 'discarded') await this.storage.deleteDir(this.storage.meetingDir(id));
    return result;
  }

  async getLive(id: string, after: string | undefined) {
    let afterSeq = -1;
    if (after !== undefined) {
      if (!/^-?\d+$/.test(after)) throw new BadRequestException('after must be an integer seq');
      afterSeq = Number(after);
    }
    const head = await this.live.findHead(this.db.pool, id);
    if (!head) throw new NotFoundException('meeting not found');
    const items = await this.live.findUtterances(this.db.pool, id, afterSeq);
    return { status: head.status, stage: head.stage, heartbeat_at: head.heartbeat_at, items };
  }
}
```

- [ ] **Step 5: controller·module을 쓰고 등록한다**

`be/src/live/live.controller.ts`:

```ts
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { LiveService } from './live.service';

@ApiTags('live')
@Controller('meetings')
export class LiveController {
  constructor(private readonly service: LiveService) {}

  @Post('live')
  @ApiOperation({
    summary: '실시간 녹음 시작',
    description:
      '워커 Mac의 마이크로 녹음을 시작한다. recording 회의와 live_session job을 만들고 회의 행을 돌려준다. ' +
      '이미 녹음 중인 회의가 있으면 409. body는 업로드와 같은 필드(JSON): title, processing, speakers, defer_lens, defer_summary.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        processing: { type: 'object', description: '처리 설정 오버라이드 — 업로드와 동일' },
        speakers: { type: 'object', description: '{"min":2,"max":5}' },
        defer_lens: { type: 'boolean' },
        defer_summary: { type: 'boolean' },
      },
    },
  })
  @HttpCode(201)
  start(@Body() body: {
    title?: unknown; processing?: unknown; speakers?: unknown; defer_lens?: unknown; defer_summary?: unknown;
  }) {
    return this.service.start(body ?? {});
  }

  @Post(':id/live/stop')
  @ApiOperation({
    summary: '실시간 녹음 종료',
    description:
      '워커가 마이크를 연 뒤면 stop_requested_at을 찍고 stopping. 아직 queued면 녹음된 게 없으니 ' +
      '회의를 지우고 discarded. recording이 아니면 409.',
  })
  @HttpCode(200)
  stop(@Param('id') id: string) { return this.service.stop(id); }

  @Get(':id/live')
  @ApiOperation({ summary: '라이브 발화 조회 (seq 커서)' })
  @ApiQuery({ name: 'after', required: false, description: '이 seq 이후 행만' })
  get(@Param('id') id: string, @Query('after') after?: string) {
    return this.service.getLive(id, after);
  }
}
```

`be/src/live/live.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { LiveController } from './live.controller';
import { LiveRepository } from './live.repository';
import { LiveService } from './live.service';
import { MeetingsModule } from '../meetings/meetings.module';
import { SettingsModule } from '../settings/settings.module';
import { SystemModule } from '../system/system.module';

@Module({
  imports: [MeetingsModule, SettingsModule, SystemModule],
  controllers: [LiveController],
  providers: [LiveRepository, LiveService],
})
export class LiveModule {}
```

`be/src/app.module.ts`: `import { LiveModule } from './live/live.module';` 추가, `imports` 배열의 `NotesModule,` 뒤에 `LiveModule,`.

- [ ] **Step 6: 통과를 확인한다**

Run: `cd be && pnpm exec jest test/live.e2e-spec.ts test/demo-read-only.e2e-spec.ts test/meetings.e2e-spec.ts && pnpm exec tsc --noEmit -p tsconfig.build.json`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add be/src/live be/src/app.module.ts be/test/live.e2e-spec.ts be/test/demo-read-only.e2e-spec.ts
git commit -m "feat(be): 실시간 녹음 시작·종료·조회 엔드포인트를 더한다

Claude-Session: https://claude.ai/code/session_01X1x9qJVRgpKfcnajp5SrbJ"
```

---

### Task 13: FE 타입과 데이터 레이어 — `api/live.ts`

**Files:**
- Modify: `fe/src/features/meeting/api/types.ts`, `fe/src/features/meeting/model/types.ts`, `fe/src/features/meeting/api/mappers.ts`, `fe/src/features/meeting/api/meetings.ts`
- Create: `fe/src/features/meeting/api/live.ts`
- Test: `fe/src/features/meeting/api/live.test.tsx`

**Interfaces:**
- Produces: `MeetingStatus`에 `"recording"`(양쪽 타입 파일); `Meeting.recordedAtIso: string`; wire `WireLiveUtterance`, `WireLiveResponse`, `LiveStartRequest`, `LiveStopResponse`; 도메인 `LiveUtterance = { id; seq; t; startMs; text; speakerName: string | null; similarity: number | null }`; `liveQueryKey(id)`; `useStartLive()`(mutate `LiveStartRequest` → `MeetingSummary`), `useStopLive()`(mutate `id` → `LiveStopResponse`), `useLiveUtterances(id, status)` → `{ status, stage, heartbeatAt, items }` (커서 append, 상태별 폴링). `useMeetings`가 `recording`도 활성으로 본다. `useDeleteMeeting`이 라이브 캐시를 제거한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`fe/src/features/meeting/api/live.test.tsx`:

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import type { WireLiveResponse } from "./types";
import { liveQueryKey, useLiveUtterances, useStartLive, useStopLive } from "./live";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

const page = (items: WireLiveResponse["items"]): WireLiveResponse => ({
  status: "recording",
  stage: "capture",
  heartbeat_at: "2026-09-05T10:00:00.000Z",
  items,
});

const row = (seq: number, text: string) => ({
  id: `lut_${seq}`,
  seq,
  start_ms: seq * 1000,
  end_ms: seq * 1000 + 800,
  text,
  speaker_id: null,
  speaker_name: null,
  similarity: null,
});

test("첫 조회는 커서 없이, 다음 조회는 마지막 seq를 after로 보내고 append한다", async () => {
  const get = vi
    .spyOn(apiClient, "get")
    .mockResolvedValueOnce({ data: page([row(0, "첫"), row(1, "둘")]) } as never)
    .mockResolvedValueOnce({ data: page([row(2, "셋")]) } as never);
  const { wrapper } = setup();
  const { result } = renderHook(() => useLiveUtterances("m1", "recording"), {
    wrapper,
  });
  await waitFor(() => expect(result.current.data?.items).toHaveLength(2));
  expect(get).toHaveBeenLastCalledWith("/meetings/m1/live", { params: undefined });

  await act(async () => {
    await result.current.refetch();
  });
  await waitFor(() => expect(result.current.data?.items).toHaveLength(3));
  expect(get).toHaveBeenLastCalledWith("/meetings/m1/live", {
    params: { after: 1 },
  });
  expect(result.current.data?.items.map((i) => i.text)).toEqual(["첫", "둘", "셋"]);
  expect(result.current.data?.items[2].t).toBe("00:02");
});

test("done 회의는 조회하지 않는다", async () => {
  const get = vi.spyOn(apiClient, "get");
  const { wrapper } = setup();
  renderHook(() => useLiveUtterances("m1", "done"), { wrapper });
  await new Promise((r) => setTimeout(r, 20));
  expect(get).not.toHaveBeenCalled();
});

test("녹음 시작은 JSON body를 보내고 목록을 무효화한다", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({
    data: {
      id: "m7", title: "녹음", original_filename: null, audio_key: "meetings/m7/original.wav",
      normalized_key: null, recorded_at: "2026-09-05T10:00:00.000Z", duration_ms: null,
      status: "recording", is_favorite: false, current_job_id: "job_1", processing_version: 0,
      error: null, created_at: "2026-09-05T10:00:00.000Z",
    },
  } as never);
  const { qc, wrapper } = setup();
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const { result } = renderHook(() => useStartLive(), { wrapper });
  act(() => {
    result.current.mutate({ title: "녹음", defer_summary: true, speakers: { min: 2 } });
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(post).toHaveBeenCalledWith("/meetings/live", {
    title: "녹음", defer_summary: true, speakers: { min: 2 },
  });
  expect(result.current.data?.id).toBe("m7");
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["meetings"] });
});

test("종료가 discarded면 그 회의의 캐시를 지운다", async () => {
  vi.spyOn(apiClient, "post").mockResolvedValue({
    data: { meeting_id: "m7", job_id: "job_1", outcome: "discarded" },
  } as never);
  const { qc, wrapper } = setup();
  const remove = vi.spyOn(qc, "removeQueries");
  const { result } = renderHook(() => useStopLive(), { wrapper });
  act(() => {
    result.current.mutate("m7");
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(remove).toHaveBeenCalledWith({ queryKey: ["meeting", "m7"] });
  expect(remove).toHaveBeenCalledWith({ queryKey: liveQueryKey("m7") });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd fe && pnpm vitest run src/features/meeting/api/live.test.tsx`
Expected: FAIL — `Cannot find module './live'`

- [ ] **Step 3: 타입을 넓힌다**

`fe/src/features/meeting/api/types.ts`:
- `export type MeetingStatus = "recording" | "uploaded" | "processing" | "done" | "failed";`
- 파일 끝에:

```ts
/** GET /meetings/:id/live 의 라이브 발화 1행. 화자는 전부 추정이다(설계 §2.8). */
export type WireLiveUtterance = {
  id: string;
  seq: number;
  start_ms: number;
  end_ms: number;
  text: string;
  speaker_id: string | null;
  speaker_name: string | null;
  similarity: number | null;
};

/** GET /meetings/:id/live 응답. heartbeat_at은 세션 job의 locked_at. */
export type WireLiveResponse = {
  status: MeetingStatus;
  stage: string | null;
  heartbeat_at: string | null;
  items: WireLiveUtterance[];
};

/** POST /meetings/live 요청 — 업로드와 같은 필드, JSON. */
export type LiveStartRequest = {
  title?: string;
  processing?: import("@/features/settings/api/types").ProcessingOverride;
  speakers?: SpeakerBounds;
  defer_lens?: boolean;
  defer_summary?: boolean;
};

/** POST /meetings/:id/live/stop 응답. */
export type LiveStopResponse = {
  meeting_id: string;
  job_id: string;
  outcome: "stopping" | "discarded";
};
```

`fe/src/features/meeting/model/types.ts`:
- `export type MeetingStatus = "recording" | "uploaded" | "processing" | "done" | "failed";`
- `Meeting` 타입의 `status: MeetingStatus;` 아래에 `/** 녹음 시작 시각(ISO). 라이브 배너의 경과 시간 기준. */ recordedAtIso: string;`
- 파일 끝에:

```ts
/** 라이브 미리보기 발화 — 화자는 추정이라 이름과 유사도만 있다. */
export type LiveUtterance = {
  id: string;
  seq: number;
  t: string;
  startMs: number;
  text: string;
  speakerName: string | null;
  similarity: number | null;
};
```

`fe/src/features/meeting/api/mappers.ts`의 `toMeetingDetail` 반환 객체에 `status: wire.status,` 근처에 `recordedAtIso: wire.recorded_at ?? wire.created_at,`를 추가한다 (반환 객체 안 필드 순서는 무관).

- [ ] **Step 4: `live.ts`를 쓰고 `meetings.ts`를 손본다**

`fe/src/features/meeting/api/live.ts`:

```ts
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";

import type { LiveUtterance, MeetingStatus, MeetingSummary } from "../model/types";
import { formatClock, toMeetingSummary } from "./mappers";
import type {
  LiveStartRequest,
  LiveStopResponse,
  WireLiveResponse,
  WireLiveUtterance,
  WireMeeting,
} from "./types";

/**
 * 라이브 세션 데이터 레이어 (설계 §7.1). 상세 캐시(["meeting", id])와 분리한 이유는
 * 메모와 같다 — 1초마다 상세를 갈아 끼우면 그 캐시를 구독하는 화면 전체가 리렌더된다.
 */

export const liveQueryKey = (id: string) => ["live-utterances", id] as const;

export type LiveState = {
  status: MeetingStatus;
  stage: string | null;
  heartbeatAt: string | null;
  items: LiveUtterance[];
};

function toLiveUtterance(w: WireLiveUtterance): LiveUtterance {
  return {
    id: w.id,
    seq: w.seq,
    t: formatClock(w.start_ms),
    startMs: w.start_ms,
    text: w.text,
    speakerName: w.speaker_name,
    similarity: w.similarity,
  };
}

/** 상태별 폴링 간격. failed는 한 번만(보존된 미리보기), done은 조회 자체를 안 한다. */
function intervalFor(status: MeetingStatus | undefined): number | false {
  if (status === "recording") return 1000;
  if (status === "uploaded" || status === "processing") return 3000;
  return false;
}

/**
 * 라이브 발화. 마지막 seq를 `after`로 넘겨 새 행만 받아 append한다 — 응답은 늘
 * 새 행 몇 개뿐이다. 탭이 뒤로 가면 TanStack Query 기본대로 멈췄다가 복귀 시 커서로
 * 따라잡는다.
 */
export function useLiveUtterances(
  id: string | undefined,
  status: MeetingStatus | undefined,
): UseQueryResult<LiveState> {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: liveQueryKey(id ?? ""),
    enabled: !!id && status !== undefined && status !== "done",
    queryFn: async () => {
      const prev = queryClient.getQueryData<LiveState>(liveQueryKey(id ?? ""));
      const last = prev?.items.length
        ? prev.items[prev.items.length - 1].seq
        : undefined;
      const { data } = await apiClient.get<WireLiveResponse>(
        `/meetings/${id}/live`,
        { params: last === undefined ? undefined : { after: last } },
      );
      const fresh = data.items.map(toLiveUtterance);
      return {
        status: data.status,
        stage: data.stage,
        heartbeatAt: data.heartbeat_at,
        items: last === undefined ? fresh : [...(prev?.items ?? []), ...fresh],
      };
    },
    refetchInterval: () => intervalFor(status),
  });
}

/** 녹음 시작 (POST /meetings/live). 성공하면 목록을 무효화한다. */
export function useStartLive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: LiveStartRequest): Promise<MeetingSummary> => {
      const { data } = await apiClient.post<WireMeeting>("/meetings/live", vars);
      return toMeetingSummary(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
}

/** 녹음 종료 (POST /meetings/:id/live/stop). discarded면 회의가 사라졌으니 캐시를 지운다. */
export function useStopLive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await apiClient.post<LiveStopResponse>(
        `/meetings/${id}/live/stop`,
      );
      return data;
    },
    onSuccess: (data, id) => {
      if (data.outcome === "discarded") {
        queryClient.removeQueries({ queryKey: ["meeting", id] });
        queryClient.removeQueries({ queryKey: ["meeting-status", id] });
        queryClient.removeQueries({ queryKey: liveQueryKey(id) });
      } else {
        queryClient.invalidateQueries({ queryKey: ["meeting", id] });
        queryClient.invalidateQueries({ queryKey: ["meeting-status", id] });
      }
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
}
```

`fe/src/features/meeting/api/meetings.ts`:
- `const isActive = (status: MeetingStatus) => status === "recording" || status === "uploaded" || status === "processing";`
- `useDeleteMeeting`의 `onSuccess` 안 `queryClient.removeQueries({ queryKey: noteQueryKey(vars.id) });` 뒤에 `queryClient.removeQueries({ queryKey: liveQueryKey(vars.id) });` — 파일 상단에 `import { liveQueryKey } from "./live";`.

- [ ] **Step 5: 통과와 타입을 확인한다**

Run: `cd fe && pnpm vitest run src/features/meeting/api && pnpm exec tsc -b`
Expected: PASS. `tsc -b`가 `MeetingStatus`의 `recording`을 다루지 않는 switch/조건이 있으면 알려준다 — `statusBadge`(left-nav)는 `return null` 기본이 있어 그대로 통과한다.

- [ ] **Step 6: 포맷·커밋**

```bash
cd fe && pnpm format && cd ..
git add fe/src/features/meeting/api fe/src/features/meeting/model/types.ts
git commit -m "feat(fe): 라이브 세션 데이터 레이어를 더한다 — recording 상태, 커서 폴링

Claude-Session: https://claude.ai/code/session_01X1x9qJVRgpKfcnajp5SrbJ"
```

---

### Task 14: FE 시작 다이얼로그와 좌측 목록

**Files:**
- Create: `fe/src/features/meeting/ui/live-start-dialog.tsx`
- Modify: `fe/src/features/meeting/ui/left-nav.tsx`
- Test: `fe/src/features/meeting/ui/live-start-dialog.test.tsx`, `fe/src/features/meeting/ui/left-nav.test.tsx`

**Interfaces:**
- Consumes: `useStartLive`, `OverrideSection`, `SpeakerCountField`, `SegmentedControl`, `Dialog*`, `Input`, `Button`, `toast`, `isDemoBlocked`, `isApiError`, `isSpeakerBoundsValid`.
- Produces: `LiveStartDialog({ open, onOpenChange, onStarted(id) })`, `defaultLiveTitle(now?: Date): string` (`녹음 YYYY-MM-DD HH:mm`). 좌측 목록에 "녹음 시작" 버튼(데모에서는 숨김)과 "녹음 중" 뱃지.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`fe/src/features/meeting/ui/live-start-dialog.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";

import { ApiError, apiClient } from "@/shared/api/client";
import { LiveStartDialog, defaultLiveTitle } from "./live-start-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WIRE = {
  id: "m7", title: "녹음", original_filename: null, audio_key: "meetings/m7/original.wav",
  normalized_key: null, recorded_at: "2026-09-05T10:00:00.000Z", duration_ms: null,
  status: "recording", is_favorite: false, current_job_id: "job_1", processing_version: 0,
  error: null, created_at: "2026-09-05T10:00:00.000Z",
};

function renderDialog(onStarted = vi.fn()) {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      preset: "standard", preset_revision: null, language: "ko",
      whisper_model: "large-v3-turbo", devices: { diarization: "gpu", stt: "gpu" },
    },
  } as never);
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: WIRE } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LiveStartDialog open onOpenChange={() => {}} onStarted={onStarted} />
    </QueryClientProvider>,
  );
  return { post, onStarted };
}

test("기본 제목은 '녹음 YYYY-MM-DD HH:mm'이다", () => {
  expect(defaultLiveTitle(new Date(2026, 8, 5, 14, 7))).toBe("녹음 2026-09-05 14:07");
});

test("제목·미루기 선택이 JSON body로 실리고 성공하면 onStarted를 부른다", async () => {
  const { post, onStarted } = renderDialog();
  const title = screen.getByLabelText("제목 (선택)") as HTMLInputElement;
  expect(title.value).toMatch(/^녹음 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  fireEvent.change(title, { target: { value: "주간 회의" } });
  fireEvent.click(screen.getByRole("radio", { name: "요약 나중에 실행" }));
  fireEvent.click(screen.getByRole("button", { name: "녹음 시작" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith("m7"));
  expect(post).toHaveBeenCalledWith("/meetings/live", {
    title: "주간 회의", defer_summary: true,
  });
});

test("409면 이미 녹음 중이라는 토스트를 띄우고 닫지 않는다", async () => {
  const { onStarted } = renderDialog();
  vi.spyOn(apiClient, "post").mockRejectedValue(
    new ApiError(409, "a recording is already in progress"),
  );
  fireEvent.click(screen.getByRole("button", { name: "녹음 시작" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "녹음 시작" })).not.toBeDisabled());
  expect(onStarted).not.toHaveBeenCalled();
});
```

`fe/src/features/meeting/ui/left-nav.test.tsx`의 `vi.mock("@/features/meeting/ui/upload-dialog", …)` 아래에 라이브 다이얼로그 목을 더하고, 파일 끝에 두 테스트:

```tsx
vi.mock("@/features/meeting/ui/live-start-dialog", () => ({
  LiveStartDialog: ({ open, onStarted }: { open: boolean; onStarted: (id: string) => void }) =>
    open ? (
      <button type="button" onClick={() => onStarted("m8")}>
        녹음 시작 흉내
      </button>
    ) : null,
}));
```

```tsx
test("녹음 시작 버튼이 다이얼로그를 열고, 시작되면 새 회의 경로로 이동한다", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Probe />
        <Routes>
          <Route path="*" element={<LeftNav filter="all" onFilter={() => {}} onOpenSearch={() => {}} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "녹음 시작" }));
  fireEvent.click(await screen.findByRole("button", { name: "녹음 시작 흉내" }));
  expect(await screen.findByText("경로: /meetings/m8")).toBeInTheDocument();
});

test("녹음 중인 회의에는 '녹음 중' 뱃지가 붙는다", async () => {
  const { apiClient } = await import("@/shared/api/client");
  (apiClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    data: [{
      id: "m1", title: "지금 회의", original_filename: null, audio_key: "k", normalized_key: null,
      recorded_at: "2026-09-05T10:00:00.000Z", duration_ms: null, status: "recording",
      is_favorite: false, current_job_id: "job_1", processing_version: 0, error: null,
      created_at: "2026-09-05T10:00:00.000Z",
    }],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="*" element={<LeftNav filter="all" onFilter={() => {}} onOpenSearch={() => {}} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("녹음 중")).toBeInTheDocument();
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd fe && pnpm vitest run src/features/meeting/ui/live-start-dialog.test.tsx src/features/meeting/ui/left-nav.test.tsx`
Expected: FAIL — 모듈 없음 / 버튼 없음

- [ ] **Step 3: 다이얼로그를 쓴다**

`fe/src/features/meeting/ui/live-start-dialog.tsx`:

```tsx
import * as React from "react";

import { isDemoBlocked } from "@/shared/api/demo-read-only";
import { isApiError } from "@/shared/api/client";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { SegmentedControl } from "@/shared/ui/segmented-control";
import { toast } from "@/shared/ui/use-toast";
import type { ProcessingOverride } from "@/features/settings/api/types";
import { OverrideSection } from "@/features/settings/ui/override-section";

import { useStartLive } from "../api/live";
import type { SpeakerBounds } from "../api/types";
import { isSpeakerBoundsValid } from "../lib/speaker-bounds";
import { Icon } from "./icons";
import { SpeakerCountField } from "./speaker-count-field";

/**
 * LiveStartDialog — 워커 Mac의 마이크로 녹음을 시작한다. 업로드 모달에서 파일·녹음
 * 일시 필드를 뺀 것이다(녹음 일시는 워커가 첫 샘플 시각으로 찍는다). 제목은 브라우저
 * 시각으로 미리 채운다 — 컨테이너 API는 회의 시간대를 모른다 (설계 §4).
 */

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "녹음 YYYY-MM-DD HH:mm" — 로컬 시각. */
export function defaultLiveTitle(now: Date = new Date()): string {
  return `녹음 ${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

type FollowupTiming = "auto" | "later";

function timingOptions(task: string) {
  return [
    { value: "auto" as const, label: "자동 실행", ariaLabel: `${task} 자동 실행` },
    { value: "later" as const, label: "나중에 실행", ariaLabel: `${task} 나중에 실행` },
  ];
}

function FollowupRow({
  task,
  description,
  deferred,
  onDeferredChange,
}: {
  task: string;
  description: string;
  deferred: boolean;
  onDeferredChange: (deferred: boolean) => void;
}) {
  const taskLabelId = React.useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <span id={taskLabelId} className="text-sm font-medium text-foreground">
          {task}
        </span>
        <span className="truncate text-xs text-[color:var(--text-muted)]">
          {description}
        </span>
      </div>
      <SegmentedControl<FollowupTiming>
        className="shrink-0"
        aria-labelledby={taskLabelId}
        options={timingOptions(task)}
        value={deferred ? "later" : "auto"}
        onChange={(timing) => onDeferredChange(timing === "later")}
      />
    </div>
  );
}

type LiveStartDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 세션이 만들어졌을 때 새 회의 id — 셸이 그 회의로 이동한다. */
  onStarted: (id: string) => void;
};

export function LiveStartDialog({ open, onOpenChange, onStarted }: LiveStartDialogProps) {
  const followupsLabelId = React.useId();
  const [title, setTitle] = React.useState(() => defaultLiveTitle());
  const [processing, setProcessing] = React.useState<ProcessingOverride | undefined>(undefined);
  const [speakers, setSpeakers] = React.useState<SpeakerBounds | undefined>(undefined);
  const [deferLens, setDeferLens] = React.useState(false);
  const [deferSummary, setDeferSummary] = React.useState(false);
  const start = useStartLive();

  const resetForm = () => {
    setTitle(defaultLiveTitle());
    setProcessing(undefined);
    setSpeakers(undefined);
    setDeferLens(false);
    setDeferSummary(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && start.isPending) return;
    if (!next) resetForm();
    onOpenChange(next);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (start.isPending || !isSpeakerBoundsValid(speakers)) return;
    start.mutate(
      {
        title: title.trim() || undefined,
        processing,
        speakers,
        defer_lens: deferLens || undefined,
        defer_summary: deferSummary || undefined,
      },
      {
        onSuccess: (summary) => {
          toast({ variant: "success", title: "녹음 시작", description: "워커가 마이크를 열면 발화가 흘러와요." });
          resetForm();
          onOpenChange(false);
          onStarted(summary.id);
        },
        onError: (error) => {
          if (isDemoBlocked(error)) return;
          const conflict = isApiError(error) && error.statusCode === 409;
          toast({
            variant: "error",
            title: conflict ? "이미 녹음 중이에요" : "녹음을 시작하지 못했어요",
            description: conflict
              ? "진행 중인 녹음을 먼저 종료해 주세요."
              : isApiError(error)
                ? error.message
                : "잠시 후 다시 시도해 주세요.",
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>실시간 녹음</DialogTitle>
          <DialogDescription>
            워커가 도는 Mac의 마이크로 녹음해요. 발화가 실시간으로 표시되고, 종료하면 정식
            처리가 이어져요.
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <Input
            label="제목 (선택)"
            placeholder="회의 제목"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />

          <SpeakerCountField value={speakers} onChange={setSpeakers} />

          <div className="flex flex-col gap-1.5">
            <span id={followupsLabelId} className="text-sm font-medium text-[color:var(--text-secondary)]">
              후속 처리
            </span>
            <p className="text-sm text-[color:var(--text-muted)]">
              녹음을 종료하고 전사가 끝난 뒤 실행할 추가 작업이에요.
            </p>
            <div role="group" aria-labelledby={followupsLabelId} className="mt-0.5 flex flex-col gap-3">
              <FollowupRow task="렌즈 추출" description="할 일·결정·약속을 뽑아내요." deferred={deferLens} onDeferredChange={setDeferLens} />
              <FollowupRow task="요약" description="주요 주제와 단락별 요약을 만들어요." deferred={deferSummary} onDeferredChange={setDeferSummary} />
            </div>
          </div>

          <OverrideSection value={processing} onChange={setProcessing} />

          <DialogFooter className="mt-1">
            <DialogClose asChild>
              <Button type="button" variant="secondary" disabled={start.isPending}>
                취소
              </Button>
            </DialogClose>
            <Button
              type="submit"
              iconLeft={<Icon name="mic" size={15} />}
              loading={start.isPending}
              disabled={start.isPending || !isSpeakerBoundsValid(speakers)}
            >
              녹음 시작
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: 좌측 목록을 손본다**

`fe/src/features/meeting/ui/left-nav.tsx`:

1. import에 `import { LiveStartDialog } from "./live-start-dialog";`
2. `NewMeetingItem` 아래에:

```tsx
function RecordItem({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-1.5 flex w-full cursor-pointer items-center gap-[9px] rounded-sm border border-border bg-card px-2.5 py-2 text-left text-sm font-medium text-foreground outline-none transition-colors duration-[80ms] hover:bg-[var(--gray-2)] focus-visible:[box-shadow:var(--focus-ring)]"
    >
      <Icon name="mic" size={16} />
      <span className="flex-1">녹음 시작</span>
    </button>
  );
}
```

3. `statusBadge`의 첫 분기 앞에:

```tsx
  if (status === "recording")
    return (
      <Badge variant="accent" dot>
        녹음 중
      </Badge>
    );
```

4. `LeftNav` 안 `const [uploadOpen, setUploadOpen] = React.useState(false);` 아래 `const [liveOpen, setLiveOpen] = React.useState(false);`
5. `<NewMeetingItem onClick={() => setUploadOpen(true)} />` 아래에 `{env.demoMode ? null : <RecordItem onClick={() => setLiveOpen(true)} />}` — 데모 빌드는 늘 403이라 버튼을 숨긴다.
6. `<UploadDialog … />` 아래에:

```tsx
      <LiveStartDialog
        open={liveOpen}
        onOpenChange={setLiveOpen}
        onStarted={(id) => navigate(`/meetings/${id}`)}
      />
```

- [ ] **Step 5: 통과를 확인한다**

Run: `cd fe && pnpm vitest run src/features/meeting/ui/live-start-dialog.test.tsx src/features/meeting/ui/left-nav.test.tsx && pnpm exec tsc -b && pnpm lint`
Expected: PASS

- [ ] **Step 6: 포맷·커밋**

```bash
cd fe && pnpm format && cd ..
git add fe/src/features/meeting/ui/live-start-dialog.tsx fe/src/features/meeting/ui/live-start-dialog.test.tsx fe/src/features/meeting/ui/left-nav.tsx fe/src/features/meeting/ui/left-nav.test.tsx
git commit -m "feat(fe): 녹음 시작 다이얼로그와 목록의 녹음 중 뱃지를 더한다

Claude-Session: https://claude.ai/code/session_01X1x9qJVRgpKfcnajp5SrbJ"
```

---

### Task 15: FE 배너·라이브 전사·회의 페이지 배선

**Files:**
- Create: `fe/src/features/meeting/ui/live-banner.tsx`, `fe/src/features/meeting/ui/live-transcript.tsx`
- Modify: `fe/src/pages/meeting.tsx`, `fe/src/features/meeting/ui/transcript-pane.tsx`
- Test: `fe/src/features/meeting/ui/live-banner.test.tsx`, `fe/src/features/meeting/ui/live-transcript.test.tsx`, `fe/src/pages/meeting-live.test.tsx`

**Interfaces:**
- Consumes: `useLiveUtterances`, `useStopLive`, `LiveUtterance`, `Meeting.recordedAtIso`, `Button`, `Icon`, `CenterState`.
- Produces: `LiveBanner({ recordedAtIso, stage, heartbeatAt, onStop, stopping, now? })`, `LiveTranscript({ items, readOnly?, className? })`, `isHeartbeatStale(heartbeatAt, nowMs, thresholdMs = 30_000)`, `TranscriptPane`의 선택 prop `livePreview?: LiveUtterance[]`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`fe/src/features/meeting/ui/live-banner.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { LiveBanner, isHeartbeatStale } from "./live-banner";

afterEach(cleanup);

const T0 = new Date("2026-09-05T10:00:00.000Z").getTime();

test("경과 시간은 recorded_at 기준이다", () => {
  render(
    <LiveBanner
      recordedAtIso="2026-09-05T10:00:00.000Z"
      stage="capture"
      heartbeatAt="2026-09-05T10:12:20.000Z"
      onStop={() => {}}
      stopping={false}
      now={() => T0 + 12 * 60_000 + 34_000}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("녹음 중");
  expect(screen.getByRole("status")).toHaveTextContent("12:34");
});

test("job이 아직 queued면 워커를 기다린다고 알리고 버튼은 취소가 된다", () => {
  const onStop = vi.fn();
  render(
    <LiveBanner recordedAtIso="2026-09-05T10:00:00.000Z" stage={null} heartbeatAt={null} onStop={onStop} stopping={false} now={() => T0} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("워커를 기다리는 중");
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(onStop).toHaveBeenCalled();
});

test("heartbeat가 30초 넘게 멈추면 신호 끊김으로 바뀐다", () => {
  expect(isHeartbeatStale("2026-09-05T10:00:00.000Z", T0 + 31_000)).toBe(true);
  expect(isHeartbeatStale("2026-09-05T10:00:00.000Z", T0 + 29_000)).toBe(false);
  expect(isHeartbeatStale(null, T0)).toBe(false);
  render(
    <LiveBanner recordedAtIso="2026-09-05T10:00:00.000Z" stage="capture" heartbeatAt="2026-09-05T10:00:00.000Z" onStop={() => {}} stopping={false} now={() => T0 + 60_000} />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("워커 신호가 끊겼어요");
});

test("종료 중에는 버튼이 잠긴다", () => {
  render(
    <LiveBanner recordedAtIso="2026-09-05T10:00:00.000Z" stage="capture" heartbeatAt="2026-09-05T10:00:00.000Z" onStop={() => {}} stopping now={() => T0} />,
  );
  expect(screen.getByRole("button", { name: /종료/ })).toBeDisabled();
});
```

`fe/src/features/meeting/ui/live-transcript.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import type { LiveUtterance } from "../model/types";
import { LiveTranscript } from "./live-transcript";

afterEach(cleanup);

const item = (seq: number, o: Partial<LiveUtterance> = {}): LiveUtterance => ({
  id: `lut_${seq}`, seq, t: `00:0${seq}`, startMs: seq * 1000, text: `발화 ${seq}`,
  speakerName: null, similarity: null, ...o,
});

test("추정 화자는 이름과 유사도로, 미식별은 '화자 ?'로 그린다", () => {
  render(
    <LiveTranscript items={[item(0, { speakerName: "영재", similarity: 0.82 }), item(1)]} />,
  );
  expect(screen.getByText("영재")).toBeInTheDocument();
  expect(screen.getByText("추정 82%")).toBeInTheDocument();
  expect(screen.getByText("화자 ?")).toBeInTheDocument();
  expect(screen.getByRole("log")).toHaveTextContent("발화 0");
});

test("위로 스크롤하면 따라가기가 꺼지고 버튼으로 복귀한다", () => {
  const { rerender } = render(<LiveTranscript items={[item(0)]} />);
  const log = screen.getByRole("log");
  Object.defineProperty(log, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(log, "clientHeight", { value: 200, configurable: true });
  log.scrollTop = 0;
  fireEvent.scroll(log);
  expect(screen.getByRole("button", { name: "자동 따라가기" })).toBeInTheDocument();
  rerender(<LiveTranscript items={[item(0), item(1)]} />);
  fireEvent.click(screen.getByRole("button", { name: "자동 따라가기" }));
  expect(screen.queryByRole("button", { name: "자동 따라가기" })).toBeNull();
});

test("비어 있으면 안내 문구를 그린다", () => {
  render(<LiveTranscript items={[]} />);
  expect(screen.getByText("첫 발화를 기다리고 있어요")).toBeInTheDocument();
});
```

`fe/src/pages/meeting-live.test.tsx` — 회의 페이지 통합. 기존 `meeting.test.tsx`의 큰 픽스처를 건드리지 않고 이 파일만의 작은 목 라우터를 쓴다:

```tsx
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { routes } from "@/app/router";
import { apiClient } from "@/shared/api/client";
import type { WireLiveResponse, WireMeeting, WireMeetingDetail } from "@/features/meeting/api/types";

const meeting = (o: Partial<WireMeeting>): WireMeeting => ({
  id: "m1", title: "지금 회의", original_filename: null, audio_key: "meetings/m1/original.wav",
  normalized_key: null, recorded_at: "2026-09-05T10:00:00.000Z", duration_ms: null,
  status: "recording", is_favorite: false, current_job_id: "job_1", processing_version: 0,
  error: null, created_at: "2026-09-05T10:00:00.000Z", ...o,
});

let current: WireMeeting = meeting({});
let live: WireLiveResponse = { status: "recording", stage: "capture", heartbeat_at: new Date().toISOString(), items: [] };

function getResponse(url: string) {
  if (url === "/meetings") return Promise.resolve({ data: [current] });
  if (url === "/settings/processing")
    return Promise.resolve({ data: { preset: "standard", preset_revision: "2026-08-12.3", language: "ko", whisper_model: "large-v3-turbo", devices: { diarization: "gpu", stt: "gpu" }, summary_model: "mlx-community/Qwen3.5-9B-8bit" } });
  if (url === "/lenses/extraction-status") return Promise.resolve({ data: { running: 0, failed: [] } });
  if (url === "/meetings/m1/lenses") return Promise.resolve({ data: { items: [], extraction_status: null } });
  if (url === "/meetings/m1/note") return Promise.resolve({ data: { note: null } });
  if (url === "/meetings/m1/status")
    return Promise.resolve({ data: { status: current.status, stage: live.stage, progress: 0, error: current.error, summary: null, search_index: null } });
  if (url === "/meetings/m1/live") return Promise.resolve({ data: live });
  if (url === "/meetings/m1") {
    const detail: WireMeetingDetail = { ...current, utterances: [], clusters: [], summary: null };
    return Promise.resolve({ data: detail });
  }
  return Promise.reject(new Error(`unhandled GET ${url}`));
}

beforeEach(() => {
  current = meeting({});
  live = { status: "recording", stage: "capture", heartbeat_at: new Date().toISOString(), items: [] };
  vi.spyOn(apiClient, "get").mockImplementation((url: string) => getResponse(url) as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("녹음 중인 회의는 라이브 배너와 라이브 전사를 그리고 플레이바는 없다", async () => {
  live.items = [{ id: "lut_1", seq: 0, start_ms: 0, end_ms: 800, text: "첫 발화예요", speaker_id: "sp_1", speaker_name: "영재", similarity: 0.82 }];
  renderAt("/meetings/m1");
  expect(await screen.findByText("첫 발화예요")).toBeInTheDocument();
  expect(screen.getByRole("status", { name: /녹음/ })).toHaveTextContent("녹음 중");
  expect(screen.getByRole("button", { name: "종료" })).toBeInTheDocument();
  expect(screen.queryByRole("slider")).toBeNull();
  expect(screen.getByText("녹음이 끝나면 요약과 렌즈가 만들어져요")).toBeInTheDocument();
});

test("종료를 누르면 stop을 호출하고 버튼이 잠긴다", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: { meeting_id: "m1", job_id: "job_1", outcome: "stopping" } } as never);
  renderAt("/meetings/m1");
  const btn = await screen.findByRole("button", { name: "종료" });
  btn.click();
  await waitFor(() => expect(post).toHaveBeenCalledWith("/meetings/m1/live/stop"));
});

test("실패한 회의에 라이브 행이 남아 있으면 읽기 전용 미리보기를 그린다", async () => {
  current = meeting({ status: "failed", error: { code: "stale_worker", message: "worker lost" } });
  live = { status: "failed", stage: "capture", heartbeat_at: null, items: [{ id: "lut_1", seq: 0, start_ms: 0, end_ms: 800, text: "남은 발화", speaker_id: null, speaker_name: null, similarity: null }] };
  renderAt("/meetings/m1");
  expect(await screen.findByText("남은 발화")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("처리에 실패했어요");
  expect(screen.getByRole("button", { name: "회의 재처리" })).toBeInTheDocument();
});

test("마이크를 못 연 실패는 권한 안내를 보여주고 재처리 버튼을 숨긴다", async () => {
  current = meeting({ status: "failed", error: { code: "audio_device_failed", message: "no mic" } });
  live = { status: "failed", stage: null, heartbeat_at: null, items: [] };
  renderAt("/meetings/m1");
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("마이크를 열지 못했어요")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "회의 재처리" })).toBeNull();
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd fe && pnpm vitest run src/features/meeting/ui/live-banner.test.tsx src/features/meeting/ui/live-transcript.test.tsx src/pages/meeting-live.test.tsx`
Expected: FAIL — 모듈 없음 / 요소 없음

- [ ] **Step 3: 배너를 쓴다**

`fe/src/features/meeting/ui/live-banner.tsx`:

```tsx
import * as React from "react";

import { Button } from "@/shared/ui/button";

import { formatClock } from "../api/mappers";
import { Icon } from "./icons";

/**
 * LiveBanner — 녹음 중인 회의의 상단 배너. ProcessingBanner 자리에 선다.
 * 경과 시간은 워커가 첫 샘플 시각으로 찍은 recorded_at 기준이고, heartbeat(세션 job의
 * locked_at)가 30초 넘게 멈추면 "신호 끊김"으로 바뀐다 — reaper의 stale 창(30분)이
 * 닫히기 전까지 거짓 "녹음 중"을 보여주지 않기 위한 최소 장치다 (설계 §8).
 */

const STALE_MS = 30_000;

export function isHeartbeatStale(
  heartbeatAt: string | null,
  nowMs: number,
  thresholdMs: number = STALE_MS,
): boolean {
  if (!heartbeatAt) return false;
  const t = new Date(heartbeatAt).getTime();
  if (Number.isNaN(t)) return false;
  return nowMs - t > thresholdMs;
}

function useTick(now: () => number, active: boolean): number {
  const [tick, setTick] = React.useState(() => now());
  React.useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick(now()), 1000);
    return () => window.clearInterval(id);
  }, [active, now]);
  return tick;
}

type LiveBannerProps = {
  recordedAtIso: string;
  /** 세션 job의 stage. null이면 워커가 아직 claim하지 않았다. */
  stage: string | null;
  heartbeatAt: string | null;
  onStop: () => void;
  stopping: boolean;
  /** 테스트용 시계. */
  now?: () => number;
};

export function LiveBanner({
  recordedAtIso,
  stage,
  heartbeatAt,
  onStop,
  stopping,
  now = Date.now,
}: LiveBannerProps) {
  const queued = stage === null;
  const nowMs = useTick(now, !queued);
  const stale = !queued && isHeartbeatStale(heartbeatAt, nowMs);
  const started = new Date(recordedAtIso).getTime();
  const elapsed = Number.isNaN(started) ? 0 : Math.max(0, nowMs - started);

  if (stale) {
    return (
      <div
        role="alert"
        className="flex items-center gap-2.5 border-b border-[color:var(--red-9)] bg-[var(--red-bg)] px-7 py-2.5 text-sm"
      >
        <Icon name="mic" size={15} className="shrink-0 text-[color:var(--red-text)]" />
        <span className="font-semibold text-[color:var(--red-text)]">워커 신호가 끊겼어요</span>
        <span className="text-[color:var(--text-secondary)]">
          녹음은 디스크에 남아 있어요. 워커가 돌아오지 않으면 잠시 뒤 실패로 정리되고, 재처리로 그
          파일을 처리할 수 있어요.
        </span>
        <Button variant="secondary" size="sm" className="ml-auto shrink-0" disabled={stopping} onClick={onStop}>
          종료
        </Button>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-label="녹음 상태"
      aria-busy="true"
      className="flex items-center gap-2.5 border-b border-[color:var(--accent-6)] bg-[var(--accent-1)] px-7 py-2.5 text-sm"
    >
      <span
        aria-hidden="true"
        className={
          queued
            ? "size-2.5 shrink-0 rounded-full bg-[var(--text-faint)]"
            : "size-2.5 shrink-0 animate-pulse rounded-full bg-[var(--red-9)]"
        }
      />
      <span className="font-semibold text-[color:var(--accent-text)]">
        {queued ? "워커를 기다리는 중" : "녹음 중"}
      </span>
      <span className="text-[color:var(--text-secondary)]">
        {queued ? "워커가 마이크를 열면 녹음이 시작돼요." : formatClock(elapsed)}
      </span>
      <Button
        variant="secondary"
        size="sm"
        className="ml-auto shrink-0"
        loading={stopping}
        disabled={stopping}
        onClick={onStop}
      >
        {stopping ? "종료 중…" : queued ? "취소" : "종료"}
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: 라이브 전사를 쓴다**

`fe/src/features/meeting/ui/live-transcript.tsx`:

```tsx
import * as React from "react";

import { cn } from "@/shared/lib/utils";

import type { LiveUtterance } from "../model/types";
import { Icon } from "./icons";

/**
 * LiveTranscript — 라이브 발화 목록. 새 행이 오면 바닥으로 따라가되, 사용자가 위로
 * 스크롤하면 멈추고 "자동 따라가기" 버튼으로 복귀한다. 화자는 전부 추정이라 흐린 톤으로
 * 그리고 유사도를 옆에 붙인다. readOnly는 실패한 회의의 보존된 미리보기(설계 §7.2).
 */

const FOLLOW_SLACK_PX = 40;

type LiveTranscriptProps = {
  items: LiveUtterance[];
  readOnly?: boolean;
  className?: string;
};

export function LiveTranscript({ items, readOnly = false, className }: LiveTranscriptProps) {
  const logRef = React.useRef<HTMLDivElement>(null);
  const [follow, setFollow] = React.useState(true);

  const scrollToBottom = React.useCallback(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  React.useEffect(() => {
    if (follow) scrollToBottom();
  }, [items.length, follow, scrollToBottom]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
    setFollow(atBottom);
  };

  return (
    <div className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--surface-card)]", className)}>
      <div
        ref={logRef}
        role="log"
        aria-label={readOnly ? "녹음 미리보기" : "실시간 전사"}
        aria-live="off"
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-7 pt-4 pb-6"
      >
        {items.length === 0 ? (
          <p className="pt-10 text-center text-sm text-[color:var(--text-muted)]">
            {readOnly ? "남아 있는 발화가 없어요" : "첫 발화를 기다리고 있어요"}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((u) => (
              <li key={u.id} className="flex gap-3 text-base leading-relaxed">
                <span className="w-12 shrink-0 pt-px font-mono text-xs text-[color:var(--text-faint)]">
                  {u.t}
                </span>
                <span className="w-32 shrink-0 truncate text-sm text-[color:var(--text-muted)]">
                  {u.speakerName ?? "화자 ?"}
                  {u.similarity != null ? (
                    <span className="ml-1 text-xs text-[color:var(--text-faint)]">
                      추정 {Math.round(u.similarity * 100)}%
                    </span>
                  ) : null}
                </span>
                <span className="min-w-0 flex-1 text-foreground">{u.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {!follow && !readOnly ? (
        <button
          type="button"
          aria-label="자동 따라가기"
          onClick={() => {
            setFollow(true);
            scrollToBottom();
          }}
          className="absolute bottom-4 left-1/2 inline-flex -translate-x-1/2 cursor-pointer items-center gap-1 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-foreground shadow-none outline-none hover:bg-[var(--gray-2)] focus-visible:[box-shadow:var(--focus-ring)]"
        >
          <Icon name="chevDown" size={13} /> 자동 따라가기
        </button>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: 회의 페이지와 전사 패널을 배선한다**

`fe/src/features/meeting/ui/transcript-pane.tsx`:

1. `import type { LiveUtterance } from "../model/types";`와 `import { LiveTranscript } from "./live-transcript";`를 더한다 (기존 `Meeting` import 옆).
2. `TranscriptPaneProps`에 `/** 실패한 회의에 남은 라이브 미리보기 — 전사가 없을 때만 그린다 (설계 §7.2). */ livePreview?: LiveUtterance[];`를 더하고 `TranscriptPane`의 구조분해에 `livePreview`를 넣는다.
3. 재처리 버튼 조건을 바꾼다. `(meeting.status === "done" || meeting.status === "failed") && (` → `(meeting.status === "done" || (meeting.status === "failed" && meeting.error?.code !== "audio_device_failed")) && (`. 그 위 주석 한 줄: `{/* 마이크를 못 연 실패는 파일이 없다 — 재처리할 게 없으니 숨긴다 */}`.
4. `<div className="flex flex-col gap-px" role="log" aria-label="회의 전사" aria-live="off">` 바로 앞에:

```tsx
        {meeting.utterances.length === 0 && livePreview && livePreview.length > 0 ? (
          <LiveTranscript items={livePreview} readOnly className="min-h-[240px]" />
        ) : null}
```

`fe/src/pages/meeting.tsx`:

1. import 추가: `import { useLiveUtterances, useStopLive } from "@/features/meeting/api/live";`, `import { LiveBanner } from "@/features/meeting/ui/live-banner";`, `import { LiveTranscript } from "@/features/meeting/ui/live-transcript";`.
2. `ProcessingBanner`의 failed 분기에서 문구를 코드로 가른다. `const cancelled = meeting.error?.code === "cancelled";` 아래에 `const noMic = meeting.error?.code === "audio_device_failed";`를 두고, 두 `<span>`을:

```tsx
        <span className="font-semibold text-[color:var(--red-text)]">
          {cancelled ? "처리를 취소했어요" : noMic ? "마이크를 열지 못했어요" : "처리에 실패했어요"}
        </span>
        <span className="text-[color:var(--text-secondary)]">
          {cancelled
            ? "재처리로 다시 시작할 수 있어요."
            : noMic
              ? "워커가 도는 Mac의 시스템 설정 › 개인정보 보호 및 보안 › 마이크에서 터미널 앱을 허용한 뒤 다시 녹음해 주세요."
              : "다시 업로드하거나 잠시 후 시도해 주세요."}
        </span>
```

3. `MeetingView` 안, `const { data: procStatus } = useMeetingStatus(meetingId, statusEnabled);` 아래에:

```tsx
  // 라이브 미리보기 — recording에서는 1초, 처리 중엔 3초, failed는 한 번, done은 안 본다.
  const { data: liveState } = useLiveUtterances(meetingId, meeting?.status);
  const stopLive = useStopLive();
  const liveItems = liveState?.items ?? [];
```

4. `renderCenter`의 `return (<> <TranscriptPane …` 앞에 recording 분기:

```tsx
    if (meeting.status === "recording") {
      return (
        <>
          <LiveTranscript items={liveItems} />
          <aside
            aria-label="인사이트"
            className="flex w-[var(--rail-insight)] shrink-0 flex-col items-center justify-center border-l border-border bg-[var(--surface-panel)] px-6 text-center"
          >
            <Icon name="sparkles" size={20} className="text-[color:var(--text-faint)]" />
            <p className="mt-2 text-sm text-[color:var(--text-muted)]">
              녹음이 끝나면 요약과 렌즈가 만들어져요
            </p>
          </aside>
        </>
      );
    }
```

5. `<TranscriptPane` 호출에 `livePreview={meeting.status === "failed" ? liveItems : undefined}` prop을 더한다.
6. 상단 배너 JSX를 교체:

```tsx
        {meeting && meeting.status === "recording" ? (
          <LiveBanner
            recordedAtIso={meeting.recordedAtIso}
            stage={liveState?.stage ?? null}
            heartbeatAt={liveState?.heartbeatAt ?? null}
            onStop={() => stopLive.mutate(meeting.id, {
              onSuccess: (r) => { if (r.outcome === "discarded") navigate("/", { replace: true }); },
            })}
            stopping={stopLive.isPending}
          />
        ) : meeting && meeting.status !== "done" ? (
          <ProcessingBanner meeting={meeting} status={procStatus} />
        ) : null}
```

플레이바는 `meeting.tracks.length > 0` 조건으로 이미 숨는다(recording은 발화가 없다). `<audio key={meeting.status} …>`도 그대로 둔다 — recording에서는 파일이 아직 자라는 중이라 재생할 수 없지만 `preload="metadata"`가 실패해도 화면에는 영향이 없다.

- [ ] **Step 6: 통과·타입·린트를 확인한다**

Run: `cd fe && pnpm vitest run src/features/meeting src/pages && pnpm exec tsc -b && pnpm lint`
Expected: PASS (기존 `meeting.test.tsx` 포함). `meeting.test.tsx`의 `getResponse`가 `/meetings/:id/live`를 모른다며 `unhandled GET` reject를 내면 그 라우터에 `if (url.match(/^\/meetings\/[^/]+\/live$/)) return Promise.resolve({ data: { status: "done", stage: null, heartbeat_at: null, items: [] } });` 한 줄을 더한다 — done 회의는 조회하지 않으므로 보통 필요 없다.

- [ ] **Step 7: 포맷·커밋**

```bash
cd fe && pnpm format && cd ..
git add fe/src/features/meeting/ui/live-banner.tsx fe/src/features/meeting/ui/live-banner.test.tsx fe/src/features/meeting/ui/live-transcript.tsx fe/src/features/meeting/ui/live-transcript.test.tsx fe/src/features/meeting/ui/transcript-pane.tsx fe/src/pages/meeting.tsx fe/src/pages/meeting-live.test.tsx
git commit -m "feat(fe): 녹음 중 배너와 실시간 전사를 회의 화면에 그린다

Claude-Session: https://claude.ai/code/session_01X1x9qJVRgpKfcnajp5SrbJ"
```

---

### Task 16: smoke 스크립트와 살아있는 문서

**Files:**
- Create: `be/worker/scripts/smoke_live_session.py`
- Modify: `be/worker/SMOKE.md`, `deploy/README.md`, `be/CLAUDE.md`, `fe/CLAUDE.md`, `be/docs/worker-architecture.md`, `fe/docs/product-concept.md`

**Interfaces:**
- Consumes: `run_live_session`, `build_live_models`, `MicSource`, `FileSource`, `db.*`.
- Produces: 실모델로 세션 한 번을 돌리고 세그먼트 끝→INSERT 지연을 로그로 남기는 스크립트. 문서 델타.

- [ ] **Step 1: smoke 스크립트를 쓴다**

`be/worker/scripts/smoke_live_session.py`:

```python
"""라이브 세션 로컬 smoke — 실모델(whisper·ECAPA·silero)로 세션 한 번.

    uv run python scripts/smoke_live_session.py --mic --seconds 60
    uv run python scripts/smoke_live_session.py --file /path/16k-mono.wav

testcontainers Postgres를 띄우고 마이그레이션·recording 회의·live_session job을 심은 뒤
run_live_session을 돌린다. --mic는 지정한 초 뒤에 stop 플래그를 스스로 찍는다. --file은
실시간 속도로 흘리고 EOF에서 끝난다. 세그먼트 끝 → live_utterance INSERT 지연(ms)을
"latency_ms=" 로그로 남긴다 — 설계 §9 "1~2초"의 실측이다. CI 테스트가 아니다.
"""

import argparse
import logging
import sys
import tempfile
import threading
import time
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from testcontainers.postgres import PostgresContainer

from damwha_worker import db
from damwha_worker.audio.source import FileSource, MicSource
from damwha_worker.config import load_settings
from damwha_worker.contracts import parse_payload
from damwha_worker.models.registry import build_live_models
from damwha_worker.pipeline import live_session
from damwha_worker.storage import Storage

MIGRATIONS = Path(__file__).resolve().parents[2] / "src" / "database" / "migrations"


def _payload(meeting_id: str, audio_key: str, device: str) -> dict:
    return {
        "schema_version": 1,
        "meeting_id": meeting_id,
        "audio_key": audio_key,
        "source": "mic",
        "process": {
            "schema_version": 5,
            "meeting_id": meeting_id,
            "audio_key": audio_key,
            "processing_version": 0,
            "reprocess": False,
            "models": {
                "whisper_model": "large-v3-turbo",
                "language": "ko",
                "devices": {"diarization": device, "stt": device},
                "preset": "standard",
                "preset_revision": None,
                "summary_model": "mlx-community/Qwen3.5-4B-8bit",
                "diarization": {
                    "model": "pyannote/speaker-diarization-community-1",
                    "min_speakers": None,
                    "max_speakers": None,
                },
                "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
            },
            "identify": {"threshold": 0.8, "suggest_threshold": 0.6},
            "followups": {"lens": True, "summary": True},
        },
    }


class _LatencyLog(logging.Filter):
    """insert 직후 로그에 세그먼트 끝→INSERT 지연을 붙인다."""

    def filter(self, record: logging.LogRecord) -> bool:
        return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mic", action="store_true")
    ap.add_argument("--file")
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--device", choices=["gpu", "cpu"], default="gpu")
    args = ap.parse_args()
    if not args.mic and not args.file:
        ap.error("--mic 또는 --file 중 하나")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    settings = load_settings()

    with PostgresContainer("damwha/postgres-bigm:pg16") as pg:
        url = pg.get_connection_url().replace("postgresql+psycopg2", "postgresql")
        with psycopg.connect(url, autocommit=True) as c:
            for f in sorted(MIGRATIONS.glob("*.sql")):
                c.execute(f.read_text())
        conn = psycopg.connect(url, row_factory=dict_row, autocommit=True)
        storage_root = tempfile.mkdtemp(prefix="damwha-live-smoke-")
        storage = Storage(storage_root)

        mid = conn.execute(
            "INSERT INTO meeting(audio_key, status) VALUES ('pending','recording') RETURNING id"
        ).fetchone()["id"]
        audio_key = f"meetings/{mid}/original.wav"
        conn.execute("UPDATE meeting SET audio_key=%s WHERE id=%s", (audio_key, mid))
        payload_dict = _payload(mid, audio_key, args.device)
        jid = conn.execute(
            "INSERT INTO job(type, meeting_id, payload, max_attempts) "
            "VALUES ('live_session', %s, %s, 1) RETURNING id",
            (mid, Jsonb(payload_dict)),
        ).fetchone()["id"]
        conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
        job = db.claim(conn, settings.worker_id)
        assert job is not None and job["id"] == jid

        models = build_live_models(payload_dict, settings)
        source = MicSource() if args.mic else FileSource(args.file, realtime=True)
        if args.mic:
            def _stop_later() -> None:
                time.sleep(args.seconds)
                with psycopg.connect(url, autocommit=True) as c2:
                    c2.execute("UPDATE job SET stop_requested_at=now() WHERE id=%s", (jid,))
                logging.info("stop requested after %ss", args.seconds)

            threading.Thread(target=_stop_later, daemon=True).start()

        # 지연 측정: insert_live_utterance를 감싸 세그먼트 end_ms 대비 벽시계 지연을 찍는다.
        real_insert = db.insert_live_utterance
        t0 = time.monotonic()

        def _timed_insert(conn_, **kw):
            wall_ms = int((time.monotonic() - t0) * 1000)
            logging.info(
                "seg %d [%d-%d ms] latency_ms=%d text=%r",
                kw["seq"], kw["start_ms"], kw["end_ms"], wall_ms - kw["end_ms"], kw["text"][:40],
            )
            return real_insert(conn_, **kw)

        db.insert_live_utterance = _timed_insert  # type: ignore[assignment]

        outcome = live_session.run_live_session(
            conn, job, parse_payload("live_session", payload_dict), models, storage, source,
            worker_id=settings.worker_id, max_minutes=settings.live_max_minutes,
        )
        rows = conn.execute(
            "SELECT seq, start_ms, end_ms, speaker_id, similarity, text FROM live_utterance "
            "WHERE meeting_id=%s ORDER BY seq",
            (mid,),
        ).fetchall()
        m = conn.execute("SELECT status, duration_ms FROM meeting WHERE id=%s", (mid,)).fetchone()
        print(f"\noutcome={outcome} meeting={m} rows={len(rows)} wav={storage.resolve(audio_key)}")
        for r in rows:
            print(f"  {r['seq']:3d} {r['start_ms']:7d}-{r['end_ms']:7d} {r['speaker_id'] or '?':10s} {r['text']}")
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: 로컬에서 한 번 돌린다 (실모델, Docker, 마이크)**

Run: `cd be/worker && uv sync --extra models && uv run python scripts/smoke_live_session.py --mic --seconds 30`
Expected: 첫 실행에 macOS 마이크 권한 프롬프트. 말하면 `latency_ms=` 로그가 찍히고 `outcome=committed`, `meeting={'status': 'uploaded', …}`. 지연 수치를 SMOKE.md에 적는다.

- [ ] **Step 3: SMOKE.md와 deploy README를 갱신한다**

`be/worker/SMOKE.md` 끝에 섹션 추가:

````markdown
## 라이브 세션 (`live_session`, 설계 2026-09-05)

```bash
uv sync --extra models          # sounddevice 포함
uv run python scripts/smoke_live_session.py --mic --seconds 60      # 마이크 60초 뒤 자동 stop
uv run python scripts/smoke_live_session.py --file ~/x/16k-mono.wav  # 파일을 실시간 속도로
```

- 첫 실행에 macOS가 **터미널 앱**에 마이크 권한을 묻는다. 거부하면 job이 `audio_device_failed`로
  즉시 실패한다. 시스템 설정 › 개인정보 보호 및 보안 › 마이크에서 다시 허용.
- 로그의 `latency_ms=`가 세그먼트 끝 → `live_utterance` INSERT 지연이다. 실측(날짜, 머신, 값)을 아래에 적는다.
- 식별 결합 기준은 `suggest_threshold`(0.6)다. bind(0.8)와의 적중률 비교는 `eval_speaker_id.py`
  방식으로 같은 클립을 두 기준에 돌려 여기 기록한다 — 설계 §2.8을 되돌릴 근거가 된다.

### 실측

| 날짜 | 머신 | STT | latency_ms (중앙값/최대) | 비고 |
|---|---|---|---|---|
| (채운다) | | | | |
````

`deploy/README.md` "3. 써보기" 섹션 끝에:

```markdown
- **실시간 녹음**: 좌측 "녹음 시작"으로 이 Mac의 마이크를 바로 녹음한다. 첫 실행에 macOS가
  `damwha-worker`를 띄운 터미널 앱에 마이크 권한을 묻는다. 녹음하는 동안은 다른 처리(요약·색인 등)가
  대기하고, 종료하면 정식 처리가 이어진다. 데모 사이트에서는 꺼져 있다.
```

그리고 "문제 생기면" 표에 한 행: `| 녹음이 \`audio_device_failed\`로 실패 | 마이크 권한 거부 또는 입력 장치 없음 — 시스템 설정 › 개인정보 보호 및 보안 › 마이크에서 터미널 앱 허용 |`

- [ ] **Step 4: CLAUDE.md 둘과 아키텍처·개념 문서를 갱신한다**

`be/CLAUDE.md` 워커 섹션(`- **Search indexing.**` 항목 앞)에 항목 추가:

```markdown
- **Live session is a fifth job type.** `live_session` (`pipeline/live_session.py`, spec
  `docs/superpowers/specs/2026-09-05-live-recording-design.md`) records the worker Mac's
  microphone and streams a preview (`live_utterance`) while the meeting is `recording`; on
  stop it flips the meeting to `uploaded` and enqueues the payload's embedded **v5
  `process_meeting`** verbatim — the batch pass is the record, the live pass is a preview.
  Non-obvious rules: the mic callback tees frames into a **writer queue** (dedicated thread,
  streaming WAV header `0xFFFFFFFF` until `close()`) and a bounded **preview queue**, so
  inference stalls never lose audio; `ffmpeg.normalize` repairs a streaming header left by a
  crash; the stop signal is `job.stop_requested_at` (cancel stays the discard path);
  `max_attempts=1` and every live error is PERMANENT, and the first SIGTERM finalizes instead
  of `requeue_for_shutdown`; claim orders `live_session` first (both claim SQLs); one
  `recording` meeting at a time is enforced by `meeting_single_recording_idx`; live
  identification binds at `suggest_threshold`; `persist_process_meeting` deletes the
  meeting's `live_utterance` rows. Stop must lock the **job row first** (`FOR UPDATE OF j`)
  — locking only the meeting lets `claim` (job row, `SKIP LOCKED`) slip in.
```

`fe/CLAUDE.md`의 `src/features/meeting/` 문단 뒤에:

```markdown
- **실시간 녹음(`recording` 상태).** `api/live.ts`의 `useStartLive`/`useStopLive`/`useLiveUtterances`가
  `POST /meetings/live`, `POST /meetings/:id/live/stop`, `GET /meetings/:id/live?after=<seq>`를 쓴다.
  라이브 발화는 상세 캐시와 분리된 `["live-utterances", id]` 키에 **커서 append**로 쌓고, 폴링은
  `recording` 1초 / `uploaded`·`processing` 3초 / `failed` 1회 / `done` 없음. 화면은 `ui/live-banner.tsx`
  (경과 시간, heartbeat 30초 초과 시 "신호 끊김"), `ui/live-transcript.tsx`(자동 따라가기), 시작은
  `ui/live-start-dialog.tsx`(업로드 모달에서 파일·일시를 뺀 것, 기본 제목은 브라우저 시각). 실패한
  회의에 라이브 행이 남아 있으면 `TranscriptPane`의 `livePreview`로 읽기 전용 미리보기를 그리고,
  `audio_device_failed`는 재처리 버튼을 숨긴다(파일이 없다). 데모 빌드는 녹음 버튼을 숨긴다.
```

`be/docs/worker-architecture.md` §1 "제공 기능" 표에 행 추가: `| 실시간 녹음 | \`live_session\` | 마이크 캡처 WAV, 미리보기 \`live_utterance\`, 종료 시 \`process_meeting\` 자동 큐잉 |`. §4 뒤에 짧은 절:

```markdown
### 라이브 세션 자식

`live_session`을 claim한 자식은 종료 신호까지 산다. 마이크 콜백 → writer 큐(전용 스레드, 스트리밍
헤더 WAV) + preview 큐(상한 5분) → 메인 루프(VAD → 세그먼트 → whisper → ECAPA 식별 → `live_utterance`).
1초마다 `job.stop_requested_at`·소유권·shutdown·상한 시간을 본다. 종료 순서: 캡처 닫기 → writer 비우고
파일 닫기 → 마지막 발화 → finalize(회의 `uploaded`, payload의 v5 `process_meeting` 큐잉). 재시도 없음,
1차 SIGTERM은 finalize. 상세: `docs/superpowers/specs/2026-09-05-live-recording-design.md`.
```

`fe/docs/product-concept.md` 7장 파이프라인 목록 앞에 한 줄: `0. **앱 안 녹음 (선택)** — 워커 Mac의 마이크로 녹음하면서 전사·등록 화자 식별을 실시간 미리보기로 보여주고, 종료하면 아래 배치 파이프라인이 정본을 만든다.`

- [ ] **Step 5: 그래프를 갱신하고 커밋한다**

Run: `cd /Users/jason/projects/Damwha2 && graphify update .` (graphify-out이 없으면 건너뛴다)

```bash
git add be/worker/scripts/smoke_live_session.py be/worker/SMOKE.md deploy/README.md be/CLAUDE.md fe/CLAUDE.md be/docs/worker-architecture.md fe/docs/product-concept.md
git commit -m "docs: 라이브 세션 smoke와 살아있는 문서를 갱신한다

Claude-Session: https://claude.ai/code/session_01X1x9qJVRgpKfcnajp5SrbJ"
```

---

## 전체 확인

- [ ] `cd be && pnpm test` — 전체 통과 (Docker 필요)
- [ ] `cd be/worker && uv run pytest -q && uv run ruff check . && uv run ruff format --check .`
- [ ] `cd fe && pnpm test && pnpm lint && pnpm build`
- [ ] `pnpm dev`로 띄우고 실제로: 녹음 시작 → 발화가 화면에 뜨는지 → 종료 → `processing` → `done`에서 라이브 행이 실제 전사로 교체되는지 → 워커를 `Ctrl+C` 한 번으로 끊었을 때 회의가 `uploaded`로 넘어가는지.
