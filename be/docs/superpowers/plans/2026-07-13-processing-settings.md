# 처리 설정(모델/디바이스 선택) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ARM Mac 사용자가 스펙에 맞춰 Whisper 모델 + 단계별(diarization/STT) CPU/GPU를 전역 설정 + job별 오버라이드로 선택할 수 있게 한다.

**Architecture:** 설정은 유저 의도(`app_setting` 단일 행 — 이름 프리셋은 이름만, custom은 개별 값), payload는 실행 계약(enqueue 시 완전 해석된 v2 payload, 불변). 프리셋 정의는 API 코드 상수 한 곳. 워커는 프리셋 개념 없이 payload의 구체 값만 실행하며, v1 payload는 파싱 즉시 내부 v2 표현으로 변환한다. GPU 미가용 시 조용한 폴백 금지 — API는 400, 워커는 PERMANENT fail.

**Tech Stack:** NestJS + zod + raw SQL(pg), Python 3.12 + pydantic v2 + psycopg3, mlx-whisper / faster-whisper / pyannote 4.x.

**Spec:** `docs/superpowers/specs/2026-07-13-processing-settings-design.md` (모든 태스크는 이 스펙을 따른다. FE는 별도 계획.)

## Global Constraints

- Node 22 (`nvm use`), 워커는 Python 3.12 + uv. TS 테스트는 Docker(Testcontainers) 필요, `npm test`는 serial.
- 마이그레이션은 새 번호 파일만 추가 (`src/database/migrations/007_app_setting.sql`), 적용된 파일 수정 금지.
- payload 계약 변경은 **양쪽 동시**: `src/contracts/job-payload.schema.ts` + `worker/damwha_worker/contracts.py` + `test/fixtures/job-payloads/` 공유 fixture.
- whisper 모델 enum: `tiny | base | small | medium | large-v3 | large-v3-turbo`. 디바이스 enum: `cpu | gpu` (gpu = Apple Metal/MPS). cuda는 non-goal.
- 프리셋: `light`(small, diar gpu, stt cpu) / `standard`(large-v3-turbo, diar gpu, stt gpu) / `quality`(large-v3, diar gpu, stt gpu). `PRESET_REVISION = "2026-07-13.1"`.
- VAD/ECAPA는 CPU 고정(스키마 미노출). 임베딩 모델 교체 없음.
- loadEnv()는 decorator/module metadata에서 호출 금지 (기존 불변식).
- 커밋은 태스크당 1회 이상, conventional commit 형식.

---

### Task 1: TS 계약 v2 — discriminated union + fixtures

**Files:**
- Modify: `src/contracts/job-payload.schema.ts`
- Create: `test/fixtures/job-payloads/process_meeting.v2.valid.json`
- Modify: `test/contract-fixtures.spec.ts`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces:
  - `WHISPER_MODELS: readonly ['tiny','base','small','medium','large-v3','large-v3-turbo']`
  - `DeviceSchema = z.enum(['cpu','gpu'])`, `type Device = 'cpu'|'gpu'`
  - `ModelsSchemaV2`, `ProcessMeetingPayloadSchema` (preprocess + v1/v2 union)
  - `type ProcessMeetingPayloadV2` — Task 6의 builder 반환 타입
  - `buildProcessMeetingPayload`는 이 태스크에서 **일단 v2를 env로 채워 반환하도록 수정** (Task 6에서 설정 주입으로 재작성). 시그니처 유지.

- [ ] **Step 1: v2 fixture 작성**

`test/fixtures/job-payloads/process_meeting.v2.valid.json`:

```json
{
  "schema_version": 2,
  "meeting_id": "mtg_1",
  "audio_key": "meetings/mtg_1/original.m4a",
  "processing_version": 2,
  "reprocess": true,
  "models": {
    "whisper_model": "small",
    "language": "ko",
    "devices": { "diarization": "gpu", "stt": "cpu" },
    "preset": "light",
    "preset_revision": "2026-07-13.1",
    "diarization": { "model": "pyannote/speaker-diarization-3.1", "min_speakers": null, "max_speakers": null },
    "embedding": { "model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192 }
  },
  "identify": { "threshold": 0.7 }
}
```

- [ ] **Step 2: 실패 테스트 추가** — `test/contract-fixtures.spec.ts`에:

```ts
  it('validates process_meeting.v2.valid.json', () => {
    const p = ProcessMeetingPayloadSchema.parse(read('process_meeting.v2.valid.json'));
    expect(p.schema_version).toBe(2);
    if (p.schema_version === 2) {
      expect(p.models.devices).toEqual({ diarization: 'gpu', stt: 'cpu' });
      expect(p.models.preset).toBe('light');
    }
  });
  it('still accepts v1 fixture and missing-version fixture as v1', () => {
    expect(ProcessMeetingPayloadSchema.parse(read('process_meeting.valid.json')).schema_version).toBe(1);
    expect(ProcessMeetingPayloadSchema.parse(read('process_meeting.no_version.json')).schema_version).toBe(1);
  });
  it('rejects v2 payload with legacy device field', () => {
    const v2 = read('process_meeting.v2.valid.json');
    v2.models.device = 'mps';
    expect(() => ProcessMeetingPayloadSchema.parse(v2)).toThrow();
  });
```

- [ ] **Step 3: 실패 확인**

Run: `npx jest test/contract-fixtures.spec.ts`
Expected: FAIL (v2 fixture가 기존 단일 v1 스키마에 안 맞음)

- [ ] **Step 4: 스키마 구현** — `src/contracts/job-payload.schema.ts`:

```ts
export const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'] as const;
export const DeviceSchema = z.enum(['cpu', 'gpu']);
export type Device = z.infer<typeof DeviceSchema>;

const DiarizationSchema = z.object({
  model: z.string(),
  min_speakers: z.number().int().nullable(),
  max_speakers: z.number().int().nullable(),
});
const EmbeddingSchema = z.object({ model: z.string(), dimension: z.number().int() });

// v1 — 큐 잔존 job / 기존 fixture 호환용. 신규 enqueue는 v2만.
export const ModelsSchemaV1 = z.object({
  whisper_model: z.enum(['large-v3-turbo', 'large-v3']),
  device: z.enum(['mps', 'cpu', 'cuda']),
  language: z.string(),
  diarization: DiarizationSchema,
  embedding: EmbeddingSchema,
});

export const ModelsSchemaV2 = z
  .object({
    whisper_model: z.enum(WHISPER_MODELS),
    language: z.string(),
    devices: z.object({ diarization: DeviceSchema, stt: DeviceSchema }),
    preset: z.enum(['light', 'standard', 'quality', 'custom']),
    preset_revision: z.string().nullable(),
    diarization: DiarizationSchema,
    embedding: EmbeddingSchema,
  })
  .strict(); // legacy `device` 혼입 차단

const processMeetingCommon = {
  meeting_id: z.string().regex(/^mtg_[1-9][0-9]*$/),
  audio_key: z.string().min(1),
  processing_version: z.number().int().nonnegative(),
  reprocess: z.boolean(),
  identify: z.object({ threshold: z.number() }),
};
const ProcessMeetingPayloadV1Schema = z.object({
  schema_version: z.literal(1), ...processMeetingCommon, models: ModelsSchemaV1,
});
const ProcessMeetingPayloadV2Schema = z.object({
  schema_version: z.literal(2), ...processMeetingCommon, models: ModelsSchemaV2,
});

// zod discriminatedUnion은 child의 .default()를 discriminator 선택 전에 적용하지
// 않으므로, version 누락 payload는 preprocess로 v1에 귀속시킨다 (spec §4).
export const ProcessMeetingPayloadSchema = z.preprocess(
  (v) =>
    v !== null && typeof v === 'object' && (v as Record<string, unknown>).schema_version === undefined
      ? { ...(v as object), schema_version: 1 }
      : v,
  z.discriminatedUnion('schema_version', [ProcessMeetingPayloadV1Schema, ProcessMeetingPayloadV2Schema]),
);

export type ProcessMeetingPayloadV2 = z.infer<typeof ProcessMeetingPayloadV2Schema>;
export type ProcessMeetingPayload = z.infer<typeof ProcessMeetingPayloadSchema>;
```

`buildProcessMeetingPayload`는 이 태스크에서는 **기존 env 값으로 v2 payload를 만들도록만** 수정 (시그니처 불변, Task 6에서 설정 주입으로 재작성):

```ts
export function buildProcessMeetingPayload(args: {
  meetingId: string; audioKey: string; processingVersion: number; reprocess: boolean;
}): ProcessMeetingPayloadV2 {
  const env = loadEnv();
  const dev: Device = env.WHISPER_DEVICE === 'mps' ? 'gpu' : 'cpu'; // cuda→cpu (spec §1)
  return {
    schema_version: 2,
    meeting_id: args.meetingId,
    audio_key: args.audioKey,
    processing_version: args.processingVersion,
    reprocess: args.reprocess,
    models: {
      whisper_model: env.WHISPER_MODEL,
      language: env.STT_LANGUAGE,
      devices: { diarization: dev, stt: dev },
      preset: 'custom',
      preset_revision: null,
      diarization: { model: env.DIARIZATION_MODEL, min_speakers: null, max_speakers: null },
      embedding: { model: env.EMBEDDING_MODEL, dimension: env.EMBEDDING_DIM },
    },
    identify: { threshold: env.IDENTIFY_THRESHOLD },
  };
}
```

`EnrollSpeakerPayloadSchema`/`IndexMeetingPayloadSchema`/그 builder는 불변.

- [ ] **Step 5: 통과 확인 + 파급 확인**

Run: `npx jest test/contract-fixtures.spec.ts && npx tsc --noEmit -p tsconfig.build.json`
Expected: fixture 스위트 PASS. 타입 에러가 나면 `ProcessMeetingPayload`를 union으로 소비하는 곳(jobs enqueue 등)을 확인 — enqueue는 payload를 jsonb로 저장할 뿐이므로 타입 주석만 조정.

Run: `npm test`
Expected: 전체 PASS — 워커가 아직 v2를 모르지만 TS 테스트는 통과해야 함. **주의: 이 시점부터 Task 2 완료 전까지 실제 워커를 돌리지 말 것** (신규 enqueue가 v2인데 워커는 v1만 파싱). 커밋은 하되 순서대로 Task 2를 바로 진행.

- [ ] **Step 6: Commit**

```bash
git add src/contracts/job-payload.schema.ts test/fixtures/job-payloads/process_meeting.v2.valid.json test/contract-fixtures.spec.ts
git commit -m "feat(contracts): process_meeting payload v2 — per-stage devices, whisper enum 확장, v1/v2 union"
```

---

### Task 2: Python 계약 v2 — v1 즉시 변환 + registry 정규화 진입점

**Files:**
- Modify: `worker/damwha_worker/contracts.py`
- Modify: `worker/tests/test_contracts.py`

**Interfaces:**
- Consumes: Task 1의 v2 fixture.
- Produces:
  - `ModelsV2` (fields: `whisper_model`, `language`, `devices: Devices(diarization, stt)`, `preset: str | None`, `preset_revision: str | None`, `diarization`, `embedding`)
  - `parse_models(payload: dict) -> ModelsV2` — Task 7의 registry가 사용
  - `parse_payload("process_meeting", data)` → 항상 내부 v2 표현(`ProcessMeetingPayload`, `models: ModelsV2`) 반환. 파이프라인이 쓰는 경로(`payload.models.embedding.model`, `payload.models.language`)는 이름 불변.

- [ ] **Step 1: 실패 테스트 추가** — `worker/tests/test_contracts.py`에:

```python
def test_parses_v2_fixture():
    p = parse_payload("process_meeting", load("process_meeting.v2.valid.json"))
    assert p.models.devices.diarization == "gpu"
    assert p.models.devices.stt == "cpu"
    assert p.models.whisper_model == "small"
    assert p.models.preset == "light"
    assert p.models.preset_revision == "2026-07-13.1"


@pytest.mark.parametrize(
    ("v1_device", "expected"),
    [("mps", "gpu"), ("cpu", "cpu"), ("cuda", "cpu")],  # cuda→cpu (spec §4)
)
def test_v1_converts_to_internal_v2(v1_device, expected):
    data = load("process_meeting.valid.json")
    data["models"]["device"] = v1_device
    p = parse_payload("process_meeting", data)
    assert p.models.devices.diarization == expected
    assert p.models.devices.stt == expected
    assert p.models.preset is None
    assert p.models.preset_revision is None


def test_v1_missing_version_converts():
    p = parse_payload("process_meeting", load("process_meeting.no_version.json"))
    assert p.schema_version == 1
    assert p.models.devices.stt in ("cpu", "gpu")


def test_parse_models_from_raw_dict():
    from damwha_worker.contracts import parse_models

    m = parse_models(load("process_meeting.v2.valid.json"))
    assert m.whisper_model == "small"
    m1 = parse_models(load("process_meeting.valid.json"))
    assert m1.devices.stt == "gpu"  # v1 mps
```

기존 `test_rejects_future_schema_version`은 **v2 수용으로 의미가 바뀜** — `{"schema_version": 3}`으로 수정.

- [ ] **Step 2: 실패 확인**

Run: `cd worker && uv run pytest tests/test_contracts.py -q`
Expected: FAIL (`devices` 속성 없음 / version 2 거부)

- [ ] **Step 3: 구현** — `worker/damwha_worker/contracts.py`:

```python
import logging

log = logging.getLogger("damwha_worker")

SUPPORTED_SCHEMA_VERSIONS = frozenset({1, 2})

WhisperModel = Literal["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"]
Device = Literal["cpu", "gpu"]


class Devices(BaseModel):
    diarization: Device
    stt: Device


class ModelsV1(BaseModel):  # 기존 Models 이름 변경
    whisper_model: Literal["large-v3-turbo", "large-v3"]
    device: Literal["mps", "cpu", "cuda"]
    language: str
    diarization: Diarization
    embedding: Embedding


class ModelsV2(BaseModel):
    whisper_model: WhisperModel
    language: str
    devices: Devices
    # v1 변환·env 폴백 유래 payload는 null (spec §4)
    preset: str | None = None
    preset_revision: str | None = None
    diarization: Diarization
    embedding: Embedding


def _v1_models_to_v2(m: ModelsV1) -> ModelsV2:
    if m.device == "cuda":
        # cuda→gpu는 Metal 의미와 다른 오변환 — cpu로 내리고 경고 (spec §4)
        log.warning("v1 payload device=cuda — converting to cpu (cuda is a non-goal)")
    dev: Device = "gpu" if m.device == "mps" else "cpu"
    return ModelsV2(
        whisper_model=m.whisper_model,
        language=m.language,
        devices=Devices(diarization=dev, stt=dev),
        preset=None,
        preset_revision=None,
        diarization=m.diarization,
        embedding=m.embedding,
    )


class ProcessMeetingPayloadV1(BaseModel):
    schema_version: int = 1
    meeting_id: MeetingId
    audio_key: str
    processing_version: int
    reprocess: bool
    models: ModelsV1
    identify: Identify


class ProcessMeetingPayload(BaseModel):
    """내부 표현 — 항상 v2 models. v1은 parse에서 즉시 변환된다."""

    schema_version: int = 2
    meeting_id: MeetingId
    audio_key: str
    processing_version: int
    reprocess: bool
    models: ModelsV2
    identify: Identify


def _parse_process_meeting(data: dict) -> ProcessMeetingPayload:
    if data.get("schema_version", 1) == 1:
        v1 = ProcessMeetingPayloadV1.model_validate(data)
        return ProcessMeetingPayload(
            schema_version=1,
            meeting_id=v1.meeting_id,
            audio_key=v1.audio_key,
            processing_version=v1.processing_version,
            reprocess=v1.reprocess,
            models=_v1_models_to_v2(v1.models),
            identify=v1.identify,
        )
    return ProcessMeetingPayload.model_validate(data)


def parse_models(payload: dict) -> ModelsV2:
    """registry용: process_meeting payload dict → 정규화된 ModelsV2."""
    return _parse_process_meeting(payload).models
```

`parse_payload`의 `process_meeting` 분기를 `_parse_process_meeting(data)` 호출로 교체. enroll/index 분기는 불변 (`SUPPORTED_SCHEMA_VERSIONS` 검사에서 enroll/index payload는 여전히 version 1만 오지만, 집합 검사만 하므로 그대로 동작).

- [ ] **Step 4: 통과 확인**

Run: `cd worker && uv run pytest -q && uv run ruff check .`
Expected: 전체 PASS. `test_process_meeting.py` 등이 `Models`를 직접 import했다면 이름 변경 파급 — `grep -rn "from damwha_worker.contracts import" worker/tests worker/damwha_worker`로 확인해 `ModelsV1`/`ModelsV2`로 정리.

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/contracts.py worker/tests/test_contracts.py
git commit -m "feat(worker): payload v2 계약 — v1 파싱 즉시 내부 v2 변환, cuda→cpu 경고"
```

---

### Task 3: 설정 저장 — 마이그레이션 + 프리셋 상수 + ProcessingConfig 로더

**Files:**
- Create: `src/database/migrations/007_app_setting.sql`
- Create: `src/settings/presets.ts`
- Create: `src/settings/processing-config.ts`
- Create: `src/settings/settings.repository.ts`
- Create: `src/settings/settings.service.ts`
- Create: `src/settings/settings.module.ts`
- Test: `test/settings.service.spec.ts`

**Interfaces:**
- Consumes: Task 1의 `WHISPER_MODELS`, `DeviceSchema`, `Device`.
- Produces:
  - `interface ProcessingConfig { preset: 'light'|'standard'|'quality'|'custom'; preset_revision: string | null; language: string; whisper_model: (typeof WHISPER_MODELS)[number]; devices: { diarization: Device; stt: Device } }`
  - `PRESET_REVISION = '2026-07-13.1'`, `resolvePreset(name, language): ProcessingConfig`
  - `envFallbackProcessingConfig(): ProcessingConfig`
  - `SettingsService.getProcessingConfig(): Promise<ProcessingConfig>` — Task 5/6이 사용
  - `SettingsService.putProcessing(value: StoredProcessingValue): Promise<ProcessingConfig>`
  - `StoredProcessingValueSchema` (named: `{preset, language}` strict / custom: 전 필드 strict)

- [ ] **Step 1: 마이그레이션**

`src/database/migrations/007_app_setting.sql`:

```sql
CREATE TABLE app_setting (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: 실패 테스트** — `test/settings.service.spec.ts` (testcontainers 패턴은 `test/meetings.e2e-spec.ts` 참조: `startTestDb` + `Test.createTestingModule({ imports: [AppModule] })`):

```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { SettingsService } from '../src/settings/settings.service';
import { PRESET_REVISION } from '../src/settings/presets';

describe('SettingsService.getProcessingConfig', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  let service: SettingsService;
  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    service = app.get(SettingsService);
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  it('행 없음 → env 폴백 (WHISPER_DEVICE=mps → 전 단계 gpu, preset custom, revision null)', async () => {
    const cfg = await service.getProcessingConfig();
    expect(cfg.preset).toBe('custom');
    expect(cfg.preset_revision).toBeNull();
    expect(cfg.devices).toEqual({ diarization: 'gpu', stt: 'gpu' });
    expect(cfg.whisper_model).toBe('large-v3-turbo');
  });

  it('이름 프리셋 저장 → 항상 상수에서 resolve', async () => {
    await service.putProcessing({ preset: 'light', language: 'ko' });
    const cfg = await service.getProcessingConfig();
    expect(cfg).toEqual({
      preset: 'light', preset_revision: PRESET_REVISION, language: 'ko',
      whisper_model: 'small', devices: { diarization: 'gpu', stt: 'cpu' },
    });
    const row = await db.pool.query(`SELECT value FROM app_setting WHERE key='processing_defaults'`);
    expect(row.rows[0].value).toEqual({ preset: 'light', language: 'ko' }); // 이름만 저장 — 개별 값 스냅샷 없음
  });

  it('custom 저장 → 개별 값이 진실', async () => {
    await service.putProcessing({
      preset: 'custom', language: 'ko', whisper_model: 'medium',
      devices: { diarization: 'gpu', stt: 'cpu' },
    });
    const cfg = await service.getProcessingConfig();
    expect(cfg.preset).toBe('custom');
    expect(cfg.preset_revision).toBeNull();
    expect(cfg.whisper_model).toBe('medium');
  });

  it('손상 jsonb → env 폴백 + 예외 없음', async () => {
    await db.pool.query(
      `INSERT INTO app_setting(key, value) VALUES('processing_defaults', '{"preset":"nope"}')`,
    );
    const cfg = await service.getProcessingConfig();
    expect(cfg.preset).toBe('custom'); // env 폴백
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx jest test/settings.service.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 4: 구현**

`src/settings/presets.ts`:

```ts
import { Device, WHISPER_MODELS } from '../contracts/job-payload.schema';

export const PRESET_REVISION = '2026-07-13.1'; // 프리셋 정의 변경 시 갱신 (spec §2)
export type PresetName = 'light' | 'standard' | 'quality';
export type WhisperModel = (typeof WHISPER_MODELS)[number];

export interface ProcessingConfig {
  preset: PresetName | 'custom';
  preset_revision: string | null;
  language: string;
  whisper_model: WhisperModel;
  devices: { diarization: Device; stt: Device };
}

const PRESETS: Record<PresetName, Pick<ProcessingConfig, 'whisper_model' | 'devices'>> = {
  light: { whisper_model: 'small', devices: { diarization: 'gpu', stt: 'cpu' } },
  standard: { whisper_model: 'large-v3-turbo', devices: { diarization: 'gpu', stt: 'gpu' } },
  quality: { whisper_model: 'large-v3', devices: { diarization: 'gpu', stt: 'gpu' } },
};

export function resolvePreset(name: PresetName, language: string): ProcessingConfig {
  return { preset: name, preset_revision: PRESET_REVISION, language, ...PRESETS[name] };
}
```

`src/settings/processing-config.ts`:

```ts
import { z } from 'zod';
import { DeviceSchema, WHISPER_MODELS } from '../contracts/job-payload.schema';
import { loadEnv } from '../config/env';
import { ProcessingConfig, resolvePreset } from './presets';
import { Logger } from '@nestjs/common';

const log = new Logger('ProcessingConfig');
const languageSchema = z.string().trim().min(1);

// PUT/저장 값 — 이름 프리셋은 이름+언어만(strict: 개별 노브 혼입 400), custom은 전 필드
export const StoredProcessingValueSchema = z.union([
  z.object({
    preset: z.literal('custom'),
    language: languageSchema,
    whisper_model: z.enum(WHISPER_MODELS),
    devices: z.object({ diarization: DeviceSchema, stt: DeviceSchema }).strict(),
  }).strict(),
  z.object({
    preset: z.enum(['light', 'standard', 'quality']),
    language: languageSchema,
  }).strict(),
]);
export type StoredProcessingValue = z.infer<typeof StoredProcessingValueSchema>;

// env는 v1 형태(WHISPER_DEVICE 단일 값) — v1과 동일 매핑으로 v2 config 변환 (spec §1)
export function envFallbackProcessingConfig(): ProcessingConfig {
  const env = loadEnv();
  if (env.WHISPER_DEVICE === 'cuda') log.warn('WHISPER_DEVICE=cuda — treating as cpu (cuda is a non-goal)');
  const dev = env.WHISPER_DEVICE === 'mps' ? ('gpu' as const) : ('cpu' as const);
  return {
    preset: 'custom', preset_revision: null, language: env.STT_LANGUAGE,
    whisper_model: env.WHISPER_MODEL, devices: { diarization: dev, stt: dev },
  };
}

export function resolveStoredValue(value: StoredProcessingValue): ProcessingConfig {
  if (value.preset === 'custom') {
    return { preset: 'custom', preset_revision: null, language: value.language,
             whisper_model: value.whisper_model, devices: value.devices };
  }
  return resolvePreset(value.preset, value.language);
}
```

`src/settings/settings.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';

export const PROCESSING_KEY = 'processing_defaults';

@Injectable()
export class SettingsRepository {
  async getValue(pool: Pool, key: string): Promise<unknown | null> {
    const r = await pool.query('SELECT value FROM app_setting WHERE key=$1', [key]);
    return r.rows[0]?.value ?? null;
  }
  async putValue(pool: Pool, key: string, value: unknown): Promise<void> {
    await pool.query(
      `INSERT INTO app_setting(key, value) VALUES($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }
}
```

`src/settings/settings.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SettingsRepository, PROCESSING_KEY } from './settings.repository';
import { ProcessingConfig } from './presets';
import {
  StoredProcessingValue, StoredProcessingValueSchema,
  envFallbackProcessingConfig, resolveStoredValue,
} from './processing-config';

@Injectable()
export class SettingsService {
  private readonly log = new Logger(SettingsService.name);
  constructor(private readonly db: DatabaseService, private readonly repo: SettingsRepository) {}

  // GET과 enqueue가 공유하는 단일 로더 — 폴백 정책 동일 (spec §1)
  async getProcessingConfig(): Promise<ProcessingConfig> {
    const raw = await this.repo.getValue(this.db.pool, PROCESSING_KEY);
    if (raw === null) return envFallbackProcessingConfig();
    const parsed = StoredProcessingValueSchema.safeParse(raw);
    if (!parsed.success) {
      this.log.warn(`corrupt processing_defaults value — falling back to env: ${parsed.error.message}`);
      return envFallbackProcessingConfig();
    }
    return resolveStoredValue(parsed.data);
  }

  async putProcessing(value: StoredProcessingValue): Promise<ProcessingConfig> {
    await this.repo.putValue(this.db.pool, PROCESSING_KEY, value);
    return resolveStoredValue(value);
  }
}
```

`src/settings/settings.module.ts` — `SettingsRepository`/`SettingsService` providers + exports, `DatabaseModule` import. `src/app.module.ts` imports에 `SettingsModule` 추가.

- [ ] **Step 5: 통과 확인**

Run: `npm run migrate && npx jest test/settings.service.spec.ts && npx tsc --noEmit -p tsconfig.build.json`
Expected: PASS (테스트 DB는 testcontainers가 마이그레이션 적용 — `test/db.ts` 확인, 안 되면 스위트 setup에 007 반영 방법 확인)

- [ ] **Step 6: Commit**

```bash
git add src/database/migrations/007_app_setting.sql src/settings/ src/app.module.ts test/settings.service.spec.ts
git commit -m "feat(settings): app_setting 테이블 + 프리셋 상수 + ProcessingConfig 로더 (이름 프리셋은 이름만 저장)"
```

---

### Task 4: `GET /system/capabilities` — 스펙 감지 + 추천

**Files:**
- Create: `src/system/capabilities.ts`
- Create: `src/system/system.controller.ts`
- Create: `src/system/system.module.ts`
- Test: `test/system.e2e-spec.ts` + `src/system/capabilities.spec.ts`(unit은 `test/`에 두는 기존 관례 확인 — jest testMatch가 `test/`만이면 `test/capabilities.spec.ts`)

**Interfaces:**
- Consumes: 없음.
- Produces:
  - `interface Capabilities { platform: string; arch: string; chip: string | null; memory_gb: number; gpu_eligible: boolean; recommended_preset: 'light'|'standard'|'quality'|null }`
  - `buildCapabilities(input: { platform: string; arch: string; totalmemBytes: number; chip: string | null }): Capabilities` — 순수 함수 (unit 테스트 대상)
  - `detectCapabilities(): Promise<Capabilities>` — 감지 + 1회 캐시. Task 5/6이 gpu_eligible 검증에 사용.

- [ ] **Step 1: 실패 unit 테스트** — `test/capabilities.spec.ts`:

```ts
import { buildCapabilities } from '../src/system/capabilities';

const GB = 1024 ** 3;
describe('buildCapabilities', () => {
  it('arm64 darwin 32GB → standard', () => {
    const c = buildCapabilities({ platform: 'darwin', arch: 'arm64', totalmemBytes: 32 * GB, chip: 'Apple M2 Pro' });
    expect(c).toEqual({
      platform: 'darwin', arch: 'arm64', chip: 'Apple M2 Pro', memory_gb: 32,
      gpu_eligible: true, recommended_preset: 'standard',
    });
  });
  it('RAM 경계: 8GB → light, 16GB → standard, 48GB → quality, 64GB → quality', () => {
    const at = (gb: number) =>
      buildCapabilities({ platform: 'darwin', arch: 'arm64', totalmemBytes: gb * GB, chip: null }).recommended_preset;
    expect(at(8)).toBe('light');
    expect(at(16)).toBe('standard');
    expect(at(48)).toBe('quality');
    expect(at(64)).toBe('quality');
  });
  it('비 ARM Mac → gpu_eligible false + recommended null (spec §3: 미지원 환경)', () => {
    const c = buildCapabilities({ platform: 'linux', arch: 'x64', totalmemBytes: 64 * GB, chip: null });
    expect(c.gpu_eligible).toBe(false);
    expect(c.recommended_preset).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest test/capabilities.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — `src/system/capabilities.ts`:

```ts
import { execFile } from 'child_process';
import * as os from 'os';

export interface Capabilities {
  platform: string;
  arch: string;
  chip: string | null;
  memory_gb: number;
  gpu_eligible: boolean;
  recommended_preset: 'light' | 'standard' | 'quality' | null;
}

export function buildCapabilities(input: {
  platform: string; arch: string; totalmemBytes: number; chip: string | null;
}): Capabilities {
  const gpuEligible = input.platform === 'darwin' && input.arch === 'arm64';
  const memoryGb = Math.round(input.totalmemBytes / 1024 ** 3);
  // 모든 프리셋이 diarization gpu를 포함 — 비적격 환경엔 추천 불가 (spec §3)
  const recommended = !gpuEligible
    ? null
    : memoryGb < 16 ? ('light' as const) : memoryGb < 48 ? ('standard' as const) : ('quality' as const);
  return {
    platform: input.platform, arch: input.arch, chip: input.chip, memory_gb: memoryGb,
    gpu_eligible: gpuEligible, recommended_preset: recommended,
  };
}

function sysctlChip(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('sysctl', ['-n', 'machdep.cpu.brand_string'], { timeout: 1000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

let cached: Capabilities | null = null;
export async function detectCapabilities(): Promise<Capabilities> {
  if (cached) return cached;
  const chip = process.platform === 'darwin' ? await sysctlChip() : null;
  cached = buildCapabilities({
    platform: process.platform, arch: process.arch, totalmemBytes: os.totalmem(), chip,
  });
  return cached;
}
```

`src/system/system.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { detectCapabilities } from './capabilities';

@ApiTags('system')
@Controller('system')
export class SystemController {
  @Get('capabilities')
  @ApiOperation({ summary: '머신 스펙 감지 + 추천 프리셋 (gpu_eligible = 하드웨어 적합성만)' })
  capabilities() {
    return detectCapabilities();
  }
}
```

`src/system/system.module.ts` + `app.module.ts` 등록. e2e 한 줄 (`test/system.e2e-spec.ts`): `GET /system/capabilities` 200 + `gpu_eligible` boolean + `memory_gb` number 확인 (CI 머신 스펙에 의존하는 값 단언 금지).

- [ ] **Step 4: 통과 확인**

Run: `npx jest test/capabilities.spec.ts test/system.e2e-spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/system/ src/app.module.ts test/capabilities.spec.ts test/system.e2e-spec.ts
git commit -m "feat(system): GET /system/capabilities — 스펙 감지 + RAM 기반 프리셋 추천"
```

---

### Task 5: 설정 API — `GET/PUT /settings/processing`

**Files:**
- Create: `src/settings/settings.controller.ts`
- Modify: `src/settings/settings.module.ts` (controller 등록)
- Test: `test/settings.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 3 `SettingsService`, `StoredProcessingValueSchema`; Task 4 `detectCapabilities`.
- Produces: HTTP API — GET/PUT 응답 형태 `{ preset, preset_revision, language, whisper_model, devices }` (resolved 뷰).

- [ ] **Step 1: 실패 e2e** — `test/settings.e2e-spec.ts` (harness는 Task 3 테스트와 동일 패턴):

```ts
  it('GET → 행 없음이면 env 폴백 resolved 뷰', async () => {
    const res = await request(srv()).get('/settings/processing');
    expect(res.status).toBe(200);
    expect(res.body.preset).toBe('custom');
    expect(res.body.whisper_model).toBe('large-v3-turbo');
  });

  it('PUT 이름 프리셋 → resolved 반환, DB엔 이름만', async () => {
    const res = await request(srv()).put('/settings/processing').send({ preset: 'light', language: 'ko' });
    expect(res.status).toBe(200);
    expect(res.body.whisper_model).toBe('small');
    expect(res.body.preset_revision).toBe(PRESET_REVISION);
  });

  it('PUT 이름 프리셋 + 개별 노브 혼합 → 400 (spec §3)', async () => {
    const res = await request(srv()).put('/settings/processing')
      .send({ preset: 'light', language: 'ko', whisper_model: 'medium' });
    expect(res.status).toBe(400);
  });

  it('PUT custom 필드 누락 → 400', async () => {
    const res = await request(srv()).put('/settings/processing').send({ preset: 'custom', language: 'ko' });
    expect(res.status).toBe(400);
  });

  it('PUT 빈 language → 400', async () => {
    const res = await request(srv()).put('/settings/processing').send({ preset: 'light', language: '  ' });
    expect(res.status).toBe(400);
  });
```

**gpu 400 케이스는 환경 의존** (CI가 ARM Mac이 아니면 gpu_eligible=false): controller가 `detectCapabilities`를 DI 가능한 형태로 받아야 테스트 가능. 아래 구현처럼 `SystemModule`이 `CAPABILITIES` provider(`useFactory: detectCapabilities`)를 export하고, 테스트에서 `overrideProvider(CAPABILITIES).useValue({ ...caps, gpu_eligible: false })`로 고정:

```ts
  it('gpu_eligible=false면 gpu 포함 custom PUT → 400', async () => {
    // 별도 describe: TestingModule에서 CAPABILITIES override 후 앱 재생성
    const res = await request(srvNoGpu()).put('/settings/processing').send({
      preset: 'custom', language: 'ko', whisper_model: 'small',
      devices: { diarization: 'gpu', stt: 'cpu' },
    });
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest test/settings.e2e-spec.ts`
Expected: FAIL (라우트 없음 404)

- [ ] **Step 3: 구현**

`src/system/system.module.ts`에 provider 추가 (Task 4 산출물 수정):

```ts
export const CAPABILITIES = 'CAPABILITIES';
// providers: [{ provide: CAPABILITIES, useFactory: detectCapabilities }], exports: [CAPABILITIES]
```

`src/settings/settings.controller.ts`:

```ts
import { BadRequestException, Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import { StoredProcessingValueSchema } from './processing-config';
import { Capabilities } from '../system/capabilities';
import { CAPABILITIES } from '../system/system.module';

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly service: SettingsService,
    @Inject(CAPABILITIES) private readonly caps: Capabilities,
  ) {}

  @Get('processing')
  @ApiOperation({ summary: '처리 기본 설정 (resolved 뷰)' })
  get() { return this.service.getProcessingConfig(); }

  @Put('processing')
  @ApiOperation({ summary: '처리 기본 설정 변경 — 이름 프리셋은 이름만, custom은 전 필드' })
  async put(@Body() body: unknown) {
    const parsed = StoredProcessingValueSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    const v = parsed.data;
    if (v.preset === 'custom' && !this.caps.gpu_eligible &&
        (v.devices.diarization === 'gpu' || v.devices.stt === 'gpu')) {
      throw new BadRequestException('gpu is not available on this machine (gpu_eligible=false)');
    }
    return this.service.putProcessing(v);
  }
}
```

`settings.module.ts`: `imports: [DatabaseModule, SystemModule]`, `controllers: [SettingsController]`.

- [ ] **Step 4: 통과 확인**

Run: `npx jest test/settings.e2e-spec.ts && npx tsc --noEmit -p tsconfig.build.json`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/settings/ src/system/system.module.ts test/settings.e2e-spec.ts
git commit -m "feat(settings): GET/PUT /settings/processing — 혼합 400, gpu 비적격 400"
```

---

### Task 6: enqueue — 병합 함수 + builder 순수화 + upload/reprocess 오버라이드

**Files:**
- Modify: `src/contracts/job-payload.schema.ts` (builder 시그니처)
- Create: `src/settings/resolve-processing.ts`
- Modify: `src/meetings/meetings.service.ts` / `src/meetings/meetings.controller.ts` / `src/meetings/meetings.module.ts`
- Test: `test/resolve-processing.spec.ts`, `test/meetings.e2e-spec.ts` (추가 케이스)

**Interfaces:**
- Consumes: Task 1 `ProcessMeetingPayloadV2`, Task 3 `ProcessingConfig`/`SettingsService`, Task 4 `CAPABILITIES`.
- Produces:
  - `ProcessingOverrideSchema` — `{ preset?, whisper_model?, devices?: {diarization?, stt?}, language? }` 전 필드 optional, `.strict()`. **PUT 스키마와 별개 — 혼합 허용이 의도된 비대칭 (spec §5)**
  - `resolveProcessingConfig(global: ProcessingConfig, override: ProcessingOverride | undefined, gpuEligible: boolean): ProcessingConfig` — gpu 비적격이면 `BadRequestException`
  - `buildProcessMeetingPayload(args: { meetingId; audioKey; processingVersion; reprocess; processing: ProcessingConfig }): ProcessMeetingPayloadV2`

- [ ] **Step 1: 실패 unit 테스트** — `test/resolve-processing.spec.ts`:

```ts
import { resolveProcessingConfig, ProcessingOverrideSchema } from '../src/settings/resolve-processing';
import { resolvePreset } from '../src/settings/presets';

const global_ = resolvePreset('standard', 'ko');

describe('resolveProcessingConfig', () => {
  it('override 없음 → 전역 그대로', () => {
    expect(resolveProcessingConfig(global_, undefined, true)).toEqual(global_);
  });
  it('preset override → 통째 대체 (이름 유지)', () => {
    const r = resolveProcessingConfig(global_, { preset: 'quality' }, true);
    expect(r.preset).toBe('quality');
    expect(r.whisper_model).toBe('large-v3');
  });
  it('개별 필드 override → 얕은 병합 + preset custom + revision null (spec §5)', () => {
    const r = resolveProcessingConfig(global_, { devices: { stt: 'cpu' } }, true);
    expect(r.devices).toEqual({ diarization: 'gpu', stt: 'cpu' });
    expect(r.whisper_model).toBe('large-v3-turbo'); // 전역 유지
    expect(r.preset).toBe('custom');
    expect(r.preset_revision).toBeNull();
  });
  it('preset + 개별 필드 혼합 → preset resolve 후 병합, 결과는 custom', () => {
    const r = resolveProcessingConfig(global_, { preset: 'light', whisper_model: 'medium' }, true);
    expect(r.whisper_model).toBe('medium');
    expect(r.devices.stt).toBe('cpu'); // light 유래
    expect(r.preset).toBe('custom');
  });
  it('gpu 비적격 + 결과에 gpu → BadRequestException', () => {
    expect(() => resolveProcessingConfig(global_, undefined, false)).toThrow(/gpu/);
  });
  it('스키마: 알 수 없는 필드 거부', () => {
    expect(ProcessingOverrideSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest test/resolve-processing.spec.ts`
Expected: FAIL

- [ ] **Step 3: 구현** — `src/settings/resolve-processing.ts`:

```ts
import { z } from 'zod';
import { BadRequestException } from '@nestjs/common';
import { DeviceSchema, WHISPER_MODELS } from '../contracts/job-payload.schema';
import { ProcessingConfig, resolvePreset } from './presets';

// job 오버라이드 — PUT 스키마와 별개(혼합 허용, 의도된 비대칭; spec §5)
export const ProcessingOverrideSchema = z.object({
  preset: z.enum(['light', 'standard', 'quality']).optional(),
  whisper_model: z.enum(WHISPER_MODELS).optional(),
  devices: z.object({ diarization: DeviceSchema.optional(), stt: DeviceSchema.optional() }).strict().optional(),
  language: z.string().trim().min(1).optional(),
}).strict();
export type ProcessingOverride = z.infer<typeof ProcessingOverrideSchema>;

export function resolveProcessingConfig(
  global: ProcessingConfig, override: ProcessingOverride | undefined, gpuEligible: boolean,
): ProcessingConfig {
  let cfg = global;
  if (override?.preset) cfg = resolvePreset(override.preset, override.language ?? global.language);
  const individual = override && (override.whisper_model !== undefined ||
    override.devices !== undefined || override.language !== undefined);
  if (override && individual) {
    cfg = {
      preset: 'custom',
      preset_revision: null,
      language: override.language ?? cfg.language,
      whisper_model: override.whisper_model ?? cfg.whisper_model,
      devices: {
        diarization: override.devices?.diarization ?? cfg.devices.diarization,
        stt: override.devices?.stt ?? cfg.devices.stt,
      },
    };
  }
  if (!gpuEligible && (cfg.devices.diarization === 'gpu' || cfg.devices.stt === 'gpu')) {
    throw new BadRequestException('gpu is not available on this machine (gpu_eligible=false)');
  }
  return cfg;
}
```

주의: `preset + language`만 있는 override는 `individual`에 걸려 custom이 된다 — spec §5 "개별 필드(whisper_model, devices.*, language)" 그대로. preset만 단독이면 이름 유지.

`buildProcessMeetingPayload` 재작성 (`job-payload.schema.ts`) — 선택 노브는 인자, 비선택 인프라(diarization 모델, embedding, identify threshold)만 env:

```ts
export function buildProcessMeetingPayload(args: {
  meetingId: string; audioKey: string; processingVersion: number; reprocess: boolean;
  processing: ProcessingConfig;
}): ProcessMeetingPayloadV2 {
  const env = loadEnv();
  const p = args.processing;
  return {
    schema_version: 2,
    meeting_id: args.meetingId,
    audio_key: args.audioKey,
    processing_version: args.processingVersion,
    reprocess: args.reprocess,
    models: {
      whisper_model: p.whisper_model,
      language: p.language,
      devices: p.devices,
      preset: p.preset,
      preset_revision: p.preset_revision,
      diarization: { model: env.DIARIZATION_MODEL, min_speakers: null, max_speakers: null },
      embedding: { model: env.EMBEDDING_MODEL, dimension: env.EMBEDDING_DIM },
    },
    identify: { threshold: env.IDENTIFY_THRESHOLD },
  };
}
```

(`ProcessingConfig` import는 `../settings/presets` — contracts→settings 방향 의존이 싫으면 `ProcessingConfig` 타입을 contracts로 옮기고 settings가 re-export. 구현 시 순환 import가 생기는 쪽을 피해서 배치.)

`meetings.service.ts` — upload는 **`saveFromTemp` 전에** parse/검증/resolve (spec §5 순서), 실패 시 temp unlink:

```ts
  async upload(file: Express.Multer.File | undefined,
               body: { title?: string; recorded_at?: string; processing?: string }) {
    if (!file) throw new BadRequestException('audio file required');
    if (!AUDIO_MIME.test(file.mimetype)) {
      await unlinkQuietly(file.path);
      throw new BadRequestException('file must be audio/*');
    }
    let processing: ProcessingConfig;
    try {
      const override = this.parseOverrideString(body.processing); // JSON.parse + zod, 오류는 BadRequest
      const global_ = await this.settings.getProcessingConfig();
      processing = resolveProcessingConfig(global_, override, this.caps.gpu_eligible);
    } catch (e) {
      await unlinkQuietly(file.path); // 검증 실패 → 고아 파일 금지 (spec §5)
      throw e;
    }

    const meetingId = await nextId(this.db.pool, 'meeting');
    const originalName = decodeOriginalName(file.originalname);
    const audioKey = this.storage.meetingKey(meetingId, originalName);
    await this.storage.saveFromTemp(audioKey, file.path);

    return this.db.withTransaction(async (c) => {
      // (기존 INSERT 동일)
      const payload = buildProcessMeetingPayload({
        meetingId, audioKey, processingVersion: 0, reprocess: false, processing,
      });
      // (기존 enqueue/setCurrentJob 동일)
    });
  }

  private parseOverrideString(s: string | undefined): ProcessingOverride | undefined {
    if (s === undefined) return undefined;
    let raw: unknown;
    try { raw = JSON.parse(s); } catch { throw new BadRequestException('processing must be a valid JSON string'); }
    const r = ProcessingOverrideSchema.safeParse(raw);
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join('; '));
    return r.data;
  }
```

`reprocess(id, body?: { processing?: unknown })` — JSON body라 객체 그대로 `ProcessingOverrideSchema.safeParse`; 설정 로드/resolve는 `withTransaction` 진입 **전에**. constructor에 `SettingsService`, `@Inject(CAPABILITIES) caps` 추가, `meetings.module.ts`에 `SettingsModule`/`SystemModule` import. controller: upload `@Body()`에 `processing?: string` 추가 + `@ApiBody` properties에 `processing: { type: 'string', description: '이번 작업 한정 처리 설정 오버라이드 (JSON 문자열)' }`; reprocess에 `@Body() body: { processing?: unknown }` + `@ApiBody` 추가.

- [ ] **Step 4: e2e 추가** — `test/meetings.e2e-spec.ts`:

```ts
  it('POST /meetings — payload가 v2이고 전역 설정(프리셋)을 따른다', async () => {
    await request(srv()).put('/settings/processing').send({ preset: 'light', language: 'ko' });
    const res = await request(srv()).post('/meetings')
      .attach('audio', Buffer.from('a'), { filename: 'a.m4a', contentType: 'audio/mp4' });
    const job = await db.pool.query('SELECT payload FROM job WHERE id=$1', [res.body.current_job_id]);
    expect(job.rows[0].payload.schema_version).toBe(2);
    expect(job.rows[0].payload.models.whisper_model).toBe('small');
    expect(job.rows[0].payload.models.preset).toBe('light');
  });

  it('POST /meetings — processing 오버라이드(JSON 문자열)가 payload에 반영 + custom 전환', async () => {
    const res = await request(srv()).post('/meetings')
      .field('processing', JSON.stringify({ devices: { stt: 'cpu' } }))
      .attach('audio', Buffer.from('a'), { filename: 'a.m4a', contentType: 'audio/mp4' });
    expect(res.status).toBe(201);
    const job = await db.pool.query('SELECT payload FROM job WHERE id=$1', [res.body.current_job_id]);
    expect(job.rows[0].payload.models.devices.stt).toBe('cpu');
    expect(job.rows[0].payload.models.preset).toBe('custom');
  });

  it('POST /meetings — 잘못된 processing → 400 + storage에 파일 미저장 (spec §5)', async () => {
    const res = await request(srv()).post('/meetings')
      .field('processing', '{"nope":1}')
      .attach('audio', Buffer.from('a'), { filename: 'a.m4a', contentType: 'audio/mp4' });
    expect(res.status).toBe(400);
    const meetings = await db.pool.query('SELECT count(*)::int AS n FROM meeting');
    expect(meetings.rows[0].n).toBe(0);
    // storage 루트에 meetings/ 디렉토리가 비어 있는지 확인 (STORAGE_ROOT는 test 환경 값 사용)
  });

  it('POST /meetings/:id/reprocess — body.processing 반영', async () => {
    // 기존 reprocess 테스트 패턴으로 meeting을 done 상태로 만든 뒤:
    const res = await request(srv()).post(`/meetings/${mid}/reprocess`)
      .send({ processing: { preset: 'quality' } });
    expect(res.status).toBe(202);
    const job = await db.pool.query('SELECT payload FROM job WHERE id=$1', [res.body.job_id]);
    expect(job.rows[0].payload.models.whisper_model).toBe('large-v3');
    expect(job.rows[0].payload.models.preset).toBe('quality');
  });
```

기존 `POST /meetings` 단언 중 `payload.processing_version` 등은 유지되는지 확인 — v2로 바뀌어도 최상위 필드는 동일.

- [ ] **Step 5: 통과 확인**

Run: `npx jest test/resolve-processing.spec.ts test/meetings.e2e-spec.ts && npm test`
Expected: 전체 PASS

- [ ] **Step 6: Commit**

```bash
git add src/settings/resolve-processing.ts src/contracts/job-payload.schema.ts src/meetings/ test/
git commit -m "feat(meetings): enqueue가 전역 설정+job 오버라이드를 v2 payload로 고정 — 검증은 파일 저장 전"
```

---

### Task 7: 워커 — device 번역 + registry + adapters + 의존성

**Files:**
- Create: `worker/damwha_worker/models/device.py`
- Modify: `worker/damwha_worker/errors.py` (GPU_UNAVAILABLE 코드)
- Modify: `worker/damwha_worker/models/registry.py`
- Modify: `worker/damwha_worker/models/pyannote_diar.py` (_torch_device 조용한 폴백 제거)
- Modify: `worker/damwha_worker/models/whisper_mlx.py` (_REPO 확장)
- Modify: `worker/damwha_worker/config.py` (whisper_backend/device 제거)
- Modify: `worker/pyproject.toml` (faster-whisper marker 제거)
- Test: `worker/tests/test_device.py`, `worker/tests/test_config.py` 수정

**Interfaces:**
- Consumes: Task 2 `parse_models`, `ModelsV2`.
- Produces:
  - `device.torch_device(device: str) -> str` — `"cpu"→"cpu"`, `"gpu"→"mps"`; MPS 미가용이면 `WorkerError(GPU_UNAVAILABLE, PERMANENT)` (spec §6 폴백 금지)
  - `registry.build_models(payload, settings)` — 시그니처 불변, 내부가 v2 기반
  - `errors.GPU_UNAVAILABLE = "gpu_unavailable"`

- [ ] **Step 1: 실패 테스트** — `worker/tests/test_device.py`:

```python
import pytest

from damwha_worker.errors import ErrorKind, WorkerError
from damwha_worker.models.device import torch_device


def test_cpu_passthrough():
    assert torch_device("cpu") == "cpu"


def test_gpu_maps_to_mps_when_available(monkeypatch):
    import sys, types

    torch = types.SimpleNamespace(
        backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: True))
    )
    monkeypatch.setitem(sys.modules, "torch", torch)
    assert torch_device("gpu") == "mps"


def test_gpu_unavailable_is_permanent(monkeypatch):
    import sys, types

    torch = types.SimpleNamespace(
        backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False))
    )
    monkeypatch.setitem(sys.modules, "torch", torch)
    with pytest.raises(WorkerError) as e:
        torch_device("gpu")
    assert e.value.kind is ErrorKind.PERMANENT
    assert e.value.code == "gpu_unavailable"
```

- [ ] **Step 2: 실패 확인**

Run: `cd worker && uv run pytest tests/test_device.py -q`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`errors.py` PERMANENT 코드 블록에 추가:

```python
GPU_UNAVAILABLE = "gpu_unavailable"
```

`worker/damwha_worker/models/device.py`:

```python
"""payload device('cpu'|'gpu') → 실행 디바이스 번역 (한 곳; spec §6).

gpu인데 MPS 미가용이면 PERMANENT — CPU 폴백은 payload 재현성을 깨므로 금지.
lazy HF 다운로드의 네트워크 실패는 여기 소관이 아니다(미분류 → TRANSIENT 유지).
"""

from ..errors import ErrorKind, WorkerError, GPU_UNAVAILABLE


def torch_device(device: str) -> str:
    if device == "cpu":
        return "cpu"
    import torch

    if not torch.backends.mps.is_available():
        raise WorkerError(
            GPU_UNAVAILABLE,
            "payload requests gpu but MPS is unavailable on this machine",
            ErrorKind.PERMANENT,
        )
    return "mps"
```

`registry.py` — payload 정규화는 `parse_models`, STT 백엔드는 payload 파생:

```python
from ..config import Settings
from ..contracts import parse_models
from ..pipeline.process_meeting import Models
from .device import torch_device
from .ecapa_embed import EcapaEmbedder
from .pyannote_diar import PyannoteDiarizer
from .silero_vad import SileroVAD


def build_models(payload: dict, settings: Settings) -> Models:
    m = parse_models(payload)  # v1/v2 정규화 (contracts)

    if m.devices.stt == "gpu":
        from .whisper_mlx import MlxWhisper  # ImportError → classify가 PERMANENT

        transcriber = MlxWhisper(m.whisper_model)
    else:
        from .whisper_faster import FasterWhisper

        transcriber = FasterWhisper(m.whisper_model, device="cpu")

    diar_device = torch_device(m.devices.diarization)
    return Models(
        vad=SileroVAD(),
        diarizer=PyannoteDiarizer(m.diarization.model, settings.hf_token, diar_device),
        embedder=EcapaEmbedder(m.embedding.model, "cpu"),  # ECAPA는 CPU 고정 (기존 사유 유지)
        transcriber=transcriber,
    )


def build_embedder(payload: dict, settings: Settings) -> EcapaEmbedder:
    # enroll payload엔 models 블록 없음; ECAPA는 CPU 고정
    return EcapaEmbedder(payload["embedding"]["model"], "cpu")
```

`pyannote_diar.py` — `_torch_device`의 조용한 CPU 폴백 제거 (registry가 이미 번역·검증된 `"mps"|"cpu"`를 넘김):

```python
class PyannoteDiarizer:
    def __init__(self, model: str, hf_token: str | None, device: str) -> None:
        import torch
        from pyannote.audio import Pipeline

        pipeline = Pipeline.from_pretrained(model, token=hf_token)
        if pipeline is None:
            raise RuntimeError(
                f"failed to load gated diarization model {model!r} — "
                "check HF_TOKEN and that the model license is accepted on HuggingFace"
            )
        # device는 registry의 torch_device()가 이미 검증한 'mps'|'cpu' — 폴백 없음 (spec §6)
        self._pipeline = pipeline.to(torch.device(device))
```

(`_torch_device` 함수 삭제. `mx MlxWhisper`는 변경 없음 — mlx는 torch와 무관.)

`whisper_mlx.py` `_REPO` 확장 (repo 이름은 Task 8 스모크에서 실검증 — 다운로드 실패 시 그 시점에 수정):

```python
_REPO = {
    "tiny": "mlx-community/whisper-tiny",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
}
```

`whisper_faster.py` `_MODEL`에 명시 추가 (`get` 폴백이 있지만 명시가 문서 역할):

```python
_MODEL = {
    "tiny": "tiny",
    "base": "base",
    "small": "small",
    "medium": "medium",
    "large-v3-turbo": "large-v3-turbo",
    "large-v3": "large-v3",
}
```

`config.py`: `whisper_backend: str = "mlx"`, `device: str = "mps"` 두 필드 삭제. `grep -rn "whisper_backend\|settings.device" worker/`로 잔존 참조 정리 (`tests/test_config.py` 포함). docstring의 모듈 주석도 갱신.

`pyproject.toml`:

```toml
    "faster-whisper>=1.0",
```

(marker 제거 — ARM Mac에서 mlx-whisper와 공존해야 light 프리셋의 STT cpu가 실행 가능; spec §6)

- [ ] **Step 4: 통과 확인**

Run: `cd worker && uv run pytest -q && uv run ruff check . && uv run ruff format --check .`
Expected: 전체 PASS. registry는 heavy import를 함수 내부로 유지했는지 확인 (테스트 스위트가 registry를 import하지 않는 기존 원칙 — `parse_models`/`torch_device`는 경량이라 무관).

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/ worker/tests/ worker/pyproject.toml worker/uv.lock
git commit -m "feat(worker): 단계별 디바이스 실행 — gpu 미가용 PERMANENT, faster-whisper 전 플랫폼 설치"
```

(`uv.lock`은 `uv sync --extra models` 후 갱신분 포함. CI/로컬에서 `uv lock` 실행.)

---

### Task 8: 문서 + 스모크 + 다운로드 스크립트

**Files:**
- Modify: `worker/scripts/download_models.py`
- Modify: `worker/SMOKE.md`
- Modify: `CLAUDE.md` (구현 델타 기록 — 살아있는 문서 정책)

**Interfaces:**
- Consumes: Task 7의 `_REPO` 맵.
- Produces: 실행 가능한 스모크 절차 (실모델 검증은 로컬 전용, CI 밖).

- [ ] **Step 1: download_models.py** — whisper repo를 env 하나가 아니라 설치할 모델 목록으로:

```python
WHISPER_REPOS = os.environ.get(
    "WHISPER_MLX_REPOS",
    "mlx-community/whisper-large-v3-turbo",  # 기본은 standard 프리셋 모델만
).split(",")
```

`[3/4]` 단계를 `for repo in WHISPER_REPOS: snapshot_download(repo)` 루프로. 사용 예를 docstring에: `WHISPER_MLX_REPOS=mlx-community/whisper-small-mlx,mlx-community/whisper-large-v3-turbo uv run python scripts/download_models.py`

- [ ] **Step 2: SMOKE.md에 프리셋 시나리오 추가**

기존 스모크 절차 뒤에 섹션 추가 — 각 프리셋으로 `scripts/smoke_process_meeting.py` 1회씩:

```markdown
## 프리셋별 스모크 (spec 2026-07-13 processing-settings)

각 프리셋에 대해: `PUT /settings/processing`로 프리셋 설정 → 짧은 오디오 업로드 → job 완료 확인.
- light: whisper small + STT cpu(faster-whisper) — **ARM Mac에서 faster-whisper CPU 경로가 실제로 도는지 확인** (이전엔 설치 자체가 안 됐음)
- standard: large-v3-turbo + STT gpu(mlx)
- quality: large-v3 + STT gpu(mlx)
- v2 payload의 `models.devices`/`preset`이 job 행에 그대로 박혔는지 psql로 확인
- (선택) `devices.diarization: cpu` custom으로 pyannote CPU 경로 1회
- mlx repo 이름 실검증: tiny/base/small/medium 신규 맵 항목은 여기서 처음 다운로드된다 —
  404가 나면 `whisper_mlx.py의 _REPO`를 실제 mlx-community repo 이름으로 수정
```

- [ ] **Step 3: CLAUDE.md 델타 기록**

"Python worker" 섹션의 관련 문장 갱신:
- `whisper_backend` settings 제거 — STT 백엔드는 payload `devices.stt`에서 파생 (gpu→mlx, cpu→faster-whisper int8)
- faster-whisper는 이제 전 플랫폼 설치 (models extra)
- payload v2: 단계별 devices, v1은 파싱 즉시 내부 v2 변환
- 새 도메인: `src/settings/`(app_setting + 프리셋), `src/system/`(capabilities)
- GPU 미가용 시 PERMANENT (`gpu_unavailable`) — 폴백 금지

- [ ] **Step 4: 최종 전체 확인**

Run: `npm test && npx tsc --noEmit -p tsconfig.build.json && cd worker && uv run pytest -q && uv run ruff check .`
Expected: 전체 PASS

- [ ] **Step 5: Commit**

```bash
git add worker/scripts/download_models.py worker/SMOKE.md CLAUDE.md
git commit -m "docs: 처리 설정 구현 델타 — 프리셋 스모크 절차, 모델 다운로드 목록화"
```

---

## Self-Review 체크 결과 (계획 작성 시 수행)

- **Spec coverage:** §1→Task 3, §2→Task 3, §3→Task 4·5, §4→Task 1·2, §5→Task 6, §6→Task 7, §8·§9→각 태스크 테스트 + Task 8. FE(§7)는 별도 계획(사용자 결정).
- **v1/v2 공존 창:** Task 1 완료~Task 2 완료 사이에 실워커 실행 금지 명시(Task 1 Step 5). Task 1·2는 연속 실행.
- **타입 일관성:** `ProcessingConfig`(snake_case 필드), `resolveProcessingConfig(global, override, gpuEligible)`, `parse_models(payload) -> ModelsV2`, `torch_device(device) -> str` — 태스크 간 시그니처 일치 확인함.
- **환경 의존 테스트:** capabilities/gpu 400은 순수 함수 분리 + `CAPABILITIES` provider override로 CI 머신 스펙 비의존.
