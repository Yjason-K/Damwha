# 프리셋별 요약 모델 선택 — 백엔드 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 처리 설정 프리셋(light/standard/quality)이 요약 LLM 모델까지 정의하고, 그 선택이 job payload v3로 워커까지 흘러가며, 요약 재생성 시 요청 단위로 모델을 덮어쓸 수 있게 한다.

**Architecture:** 모델 목록은 의존 없는 잎 모듈(`src/contracts/model-catalog.ts`)의 상수 enum. API가 전역 설정 + job 오버라이드를 완전 해석해 `process_meeting` payload v3의 `models.summary_model`에 고정하고, 워커는 persist 트랜잭션에서 요약 job을 큐잉할 때 그 값을 쓴다. v1/v2 잔존 payload는 값이 없으므로 워커 env로 폴백한다. 요약 재생성 API는 전역 설정값을 기본으로 쓰되 body 오버라이드를 허용하고, 진행 중인 요약과 모델이 다르면 409로 거절한다.

**Tech Stack:** NestJS + zod (TS, `src/`), pydantic v2 + psycopg3 (Python, `worker/`), Jest + Testcontainers, pytest.

## Global Constraints

- 설계 문서: `docs/superpowers/specs/2026-08-12-summary-model-per-preset-design.md`. 충돌 시 스펙이 우선.
- 모델 목록은 정확히 `['qwen3.5:4b-mlx', 'qwen3.5:8b-mlx', 'qwen3.5:14b-mlx']`.
- 프리셋 매핑: `light` → `qwen3.5:4b-mlx`, `standard` → `qwen3.5:8b-mlx`, `quality` → `qwen3.5:14b-mlx`.
- `PRESET_REVISION`은 `'2026-08-12.1'`로 갱신.
- **마이그레이션 파일을 만들지 않는다.** 레거시 custom 행은 읽기 시점 env 기본값으로 처리한다.
- Node 22 (`nvm use`). 테스트는 Docker 필요(Testcontainers). 워커는 `cd worker && uv run pytest`.
- 조용한 폴백 금지 — 값이 없거나 어긋나면 명시적 400/409/ValidationError.
- TS 파일 수정 시 `npx tsc --noEmit -p tsconfig.build.json`이 통과해야 한다.
- 커밋 메시지는 기존 관례(`feat:` / `fix:` / `docs:` / `test:`)를 따른다.

---

### Task 1: 모델 카탈로그 + 프리셋 정의 + 저장 값 스키마

> **왜 한 태스크인가:** `ProcessingConfig`에 필수 필드를 추가하는 순간 그 타입을
> 만들어내는 세 곳(`envFallbackProcessingConfig`, `resolveStoredValue`,
> `resolveProcessingConfig`의 병합 리터럴)이 전부 컴파일 실패한다. 타입 추가와
> 생산자 갱신을 쪼개면 중간 상태가 빌드되지 않으므로 한 단위로 묶는다.
> `resolve-processing.ts`는 컴파일을 살리는 한 줄만 넣고, 오버라이드 노브는
> Task 2가 얹는다.

**Files:**
- Create: `src/contracts/model-catalog.ts`
- Modify: `src/settings/presets.ts`
- Modify: `src/config/env.ts:30`
- Modify: `src/settings/processing-config.ts`
- Modify: `src/settings/settings.controller.ts:4,24`
- Modify: `src/settings/resolve-processing.ts` (병합 리터럴 한 줄만)
- Test: `test/presets.spec.ts` (신규), `test/settings.service.spec.ts`, `test/settings.e2e-spec.ts`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces:
  - `SUMMARY_MODELS: readonly ['qwen3.5:4b-mlx', 'qwen3.5:8b-mlx', 'qwen3.5:14b-mlx']`
  - `type SummaryModel = 'qwen3.5:4b-mlx' | 'qwen3.5:8b-mlx' | 'qwen3.5:14b-mlx'`
  - `interface ProcessingConfig`에 `summary_model: SummaryModel` 필드 추가
  - `resolvePreset(name: PresetName, language: string): ProcessingConfig` — 반환값에 `summary_model` 포함
  - `PRESET_REVISION = '2026-08-12.1'`
  - `StoredProcessingValueSchema` — 읽기용. custom 브랜치의 `summary_model`은 **optional**
  - `PutProcessingValueSchema` — 쓰기용. custom 브랜치의 `summary_model`은 **필수**
  - `type StoredProcessingValue`, `type PutProcessingValue`
  - `resolveStoredValue(value: StoredProcessingValue): ProcessingConfig` — 시그니처 불변
  - `envFallbackProcessingConfig(): ProcessingConfig` — 시그니처 불변

- [ ] **Step 1: 실패하는 테스트 작성**

`test/presets.spec.ts` 신규 생성:

```ts
import { PRESET_REVISION, resolvePreset } from '../src/settings/presets';
import { SUMMARY_MODELS } from '../src/contracts/model-catalog';

describe('resolvePreset — 요약 모델', () => {
  it('프리셋별 요약 모델 매핑', () => {
    expect(resolvePreset('light', 'ko').summary_model).toBe('qwen3.5:4b-mlx');
    expect(resolvePreset('standard', 'ko').summary_model).toBe('qwen3.5:8b-mlx');
    expect(resolvePreset('quality', 'ko').summary_model).toBe('qwen3.5:14b-mlx');
  });

  it('모든 프리셋의 요약 모델은 카탈로그 안에 있다', () => {
    for (const name of ['light', 'standard', 'quality'] as const) {
      expect(SUMMARY_MODELS).toContain(resolvePreset(name, 'ko').summary_model);
    }
  });

  it('프리셋 정의가 바뀌었으므로 revision을 올린다', () => {
    expect(PRESET_REVISION).toBe('2026-08-12.1');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

실행: `npx jest test/presets.spec.ts`
기대: FAIL — `Cannot find module '../src/contracts/model-catalog'`

- [ ] **Step 3: 카탈로그 잎 모듈 생성**

`src/contracts/model-catalog.ts` 신규:

```ts
/**
 * 요약 LLM 모델 카탈로그 — import가 없는 잎 모듈.
 *
 * env.ts / job-payload.schema.ts / settings/* 세 곳이 이 목록을 쓴다.
 * job-payload.schema.ts는 env.ts의 loadEnv를 import하므로, 목록을 그쪽에 두면
 * env.ts → job-payload.schema.ts → env.ts 순환이 생긴다. 그래서 별도 파일이다.
 * (env.ts:9의 WHISPER_MODEL enum 중복도 같은 제약의 흔적 — 그쪽은 건드리지 않는다.)
 */
export const SUMMARY_MODELS = ['qwen3.5:4b-mlx', 'qwen3.5:8b-mlx', 'qwen3.5:14b-mlx'] as const;
export type SummaryModel = (typeof SUMMARY_MODELS)[number];
```

- [ ] **Step 4: presets.ts 확장**

`src/settings/presets.ts`를 아래로 교체:

```ts
import { Device, WHISPER_MODELS } from '../contracts/job-payload.schema';
import { SummaryModel } from '../contracts/model-catalog';

export const PRESET_REVISION = '2026-08-12.1'; // 프리셋 정의 변경 시 갱신 (spec §2)
export type PresetName = 'light' | 'standard' | 'quality';
export type WhisperModel = (typeof WHISPER_MODELS)[number];

export interface ProcessingConfig {
  preset: PresetName | 'custom';
  preset_revision: string | null;
  language: string;
  whisper_model: WhisperModel;
  devices: { diarization: Device; stt: Device };
  summary_model: SummaryModel;
}

const PRESETS: Record<
  PresetName,
  Pick<ProcessingConfig, 'whisper_model' | 'devices' | 'summary_model'>
> = {
  light: {
    whisper_model: 'small',
    devices: { diarization: 'gpu', stt: 'cpu' },
    summary_model: 'qwen3.5:4b-mlx',
  },
  standard: {
    whisper_model: 'large-v3-turbo',
    devices: { diarization: 'gpu', stt: 'gpu' },
    summary_model: 'qwen3.5:8b-mlx',
  },
  quality: {
    whisper_model: 'large-v3',
    devices: { diarization: 'gpu', stt: 'gpu' },
    summary_model: 'qwen3.5:14b-mlx',
  },
};

export function resolvePreset(name: PresetName, language: string): ProcessingConfig {
  return {
    preset: name,
    preset_revision: PRESET_REVISION,
    language,
    whisper_model: PRESETS[name].whisper_model,
    devices: { ...PRESETS[name].devices },
    summary_model: PRESETS[name].summary_model,
  };
}
```

- [ ] **Step 5: 테스트 통과 확인**

실행: `npx jest test/presets.spec.ts`
기대: PASS (3건)

- [ ] **Step 6: 깨진 생산자 확인**

실행: `npx tsc --noEmit -p tsconfig.build.json`
기대: `ProcessingConfig` 리터럴을 만드는 세 곳에서 `summary_model` 누락 에러 — `src/settings/processing-config.ts`의 `envFallbackProcessingConfig`/`resolveStoredValue`, `src/settings/resolve-processing.ts`의 병합 리터럴. 이 태스크의 Step 10·12가 전부 고친다.

- [ ] **Step 7: 실패하는 테스트 작성 (레거시 행 + PUT 필수)**

`test/settings.service.spec.ts`의 `describe` 안에 아래 3건 추가:

```ts
  it('레거시 custom 행(summary_model 없음) → env 값으로 읽히고 나머지 값은 보존된다', async () => {
    await db.pool.query(
      `INSERT INTO app_setting(key, value) VALUES('processing_defaults', $1::jsonb)`,
      [JSON.stringify({
        preset: 'custom', language: 'ko', whisper_model: 'medium',
        devices: { diarization: 'gpu', stt: 'cpu' },
      })],
    );
    const cfg = await service.getProcessingConfig();
    expect(cfg.whisper_model).toBe('medium');            // env 폴백으로 날아가지 않는다
    expect(cfg.devices).toEqual({ diarization: 'gpu', stt: 'cpu' });
    expect(cfg.summary_model).toBe('qwen3.5:4b-mlx');    // env 기본값
  });

  it('레거시 행에 PUT하면 summary_model이 명시 값으로 저장된다', async () => {
    await db.pool.query(
      `INSERT INTO app_setting(key, value) VALUES('processing_defaults', $1::jsonb)`,
      [JSON.stringify({
        preset: 'custom', language: 'ko', whisper_model: 'medium',
        devices: { diarization: 'gpu', stt: 'cpu' },
      })],
    );
    await service.putProcessing({
      preset: 'custom', language: 'ko', whisper_model: 'medium',
      devices: { diarization: 'gpu', stt: 'cpu' }, summary_model: 'qwen3.5:14b-mlx',
    });
    const row = await db.pool.query(`SELECT value FROM app_setting WHERE key='processing_defaults'`);
    expect(row.rows[0].value.summary_model).toBe('qwen3.5:14b-mlx');
  });

  it('custom 저장값의 summary_model이 진실이다', async () => {
    await service.putProcessing({
      preset: 'custom', language: 'ko', whisper_model: 'small',
      devices: { diarization: 'gpu', stt: 'cpu' }, summary_model: 'qwen3.5:8b-mlx',
    });
    const cfg = await service.getProcessingConfig();
    expect(cfg.summary_model).toBe('qwen3.5:8b-mlx');
  });
```

`test/settings.e2e-spec.ts`에 아래 2건 추가:

```ts
  it('PUT custom에 summary_model 누락 → 400', async () => {
    const res = await request(srv()).put('/settings/processing').send({
      preset: 'custom', language: 'ko', whisper_model: 'small',
      devices: { diarization: 'gpu', stt: 'cpu' },
    });
    expect(res.status).toBe(400);
  });

  it('PUT 이름 프리셋에 summary_model 혼입 → 400', async () => {
    const res = await request(srv()).put('/settings/processing').send({
      preset: 'light', language: 'ko', summary_model: 'qwen3.5:4b-mlx',
    });
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 8: 테스트 실패 확인**

실행: `npx jest test/settings.service.spec.ts test/settings.e2e-spec.ts`
기대: FAIL — 타입/컴파일 에러(`summary_model`이 `StoredProcessingValue`에 없음) 및 신규 기대 불일치

- [ ] **Step 9: env 스키마 좁히기**

`src/config/env.ts` 1행 아래에 import 추가하고 30행을 교체:

```ts
import { SUMMARY_MODELS } from '../contracts/model-catalog';
```

```ts
  // 목록 밖 값이면 API가 시작에 실패한다 — 의도된 breaking change (spec §2).
  // 조용히 목록 안 값으로 강등하면 "고른 적 없는 모델로 요약"이 된다.
  SUMMARY_LLM_MODEL: z.enum(SUMMARY_MODELS).default('qwen3.5:4b-mlx'),
```

`LENS_LLM_MODEL`(29행)은 건드리지 않는다 — 이번 범위 밖.

- [ ] **Step 10: processing-config.ts 교체**

`src/settings/processing-config.ts` 전체를 아래로 교체:

```ts
import { z } from 'zod';
import { DeviceSchema, WHISPER_MODELS } from '../contracts/job-payload.schema';
import { SUMMARY_MODELS } from '../contracts/model-catalog';
import { loadEnv } from '../config/env';
import { ProcessingConfig, resolvePreset } from './presets';
import { Logger } from '@nestjs/common';

const log = new Logger('ProcessingConfig');
const languageSchema = z.string().trim().min(1);
const devicesSchema = z.object({ diarization: DeviceSchema, stt: DeviceSchema }).strict();
const namedPresetSchema = z.object({
  preset: z.enum(['light', 'standard', 'quality']),
  language: languageSchema,
}).strict();

// 읽기(저장값 파싱) — summary_model은 optional. 이 필드가 없던 시절에 저장된
// custom 행이 있고, 그 행들의 실제 이전 동작은 env 값이었다 (spec §2).
export const StoredProcessingValueSchema = z.union([
  z.object({
    preset: z.literal('custom'),
    language: languageSchema,
    whisper_model: z.enum(WHISPER_MODELS),
    devices: devicesSchema,
    summary_model: z.enum(SUMMARY_MODELS).optional(),
  }).strict(),
  namedPresetSchema,
]);
export type StoredProcessingValue = z.infer<typeof StoredProcessingValueSchema>;

// 쓰기(PUT body) — custom은 전 필드 필수. 이름 프리셋은 이름+언어만(개별 노브 혼입 400).
export const PutProcessingValueSchema = z.union([
  z.object({
    preset: z.literal('custom'),
    language: languageSchema,
    whisper_model: z.enum(WHISPER_MODELS),
    devices: devicesSchema,
    summary_model: z.enum(SUMMARY_MODELS),
  }).strict(),
  namedPresetSchema,
]);
export type PutProcessingValue = z.infer<typeof PutProcessingValueSchema>;

// env는 v1 형태(WHISPER_DEVICE 단일 값) — v1과 동일 매핑으로 v2 config 변환 (spec §1)
export function envFallbackProcessingConfig(): ProcessingConfig {
  const env = loadEnv();
  if (env.WHISPER_DEVICE === 'cuda') log.warn('WHISPER_DEVICE=cuda — treating as cpu (cuda is a non-goal)');
  const dev = env.WHISPER_DEVICE === 'mps' ? ('gpu' as const) : ('cpu' as const);
  return {
    preset: 'custom', preset_revision: null, language: env.STT_LANGUAGE,
    whisper_model: env.WHISPER_MODEL, devices: { diarization: dev, stt: dev },
    summary_model: env.SUMMARY_LLM_MODEL,
  };
}

export function resolveStoredValue(value: StoredProcessingValue): ProcessingConfig {
  if (value.preset === 'custom') {
    return {
      preset: 'custom', preset_revision: null, language: value.language,
      whisper_model: value.whisper_model, devices: value.devices,
      // 필드 부재는 "이 행이 쓰일 당시엔 env가 진실이었다"는 뜻 (spec §2).
      // 저장된 값이 있으면 언제나 그 값이 진실이다.
      summary_model: value.summary_model ?? loadEnv().SUMMARY_LLM_MODEL,
    };
  }
  return resolvePreset(value.preset, value.language);
}
```

- [ ] **Step 11: 컨트롤러가 쓰기 스키마를 쓰도록 변경**

`src/settings/settings.controller.ts`의 import(4행)와 `put` 안의 파싱(24행)을 교체:

```ts
import { PutProcessingValueSchema, resolveStoredValue } from './processing-config';
```

```ts
    const parsed = PutProcessingValueSchema.safeParse(body);
```

나머지(gpu 적격성 검사, `service.putProcessing(v)`)는 그대로. `PutProcessingValue`는 `StoredProcessingValue`의 부분집합이라 `putProcessing`의 시그니처는 바뀌지 않는다.

- [ ] **Step 12: resolve-processing.ts 컴파일 복구 (한 줄)**

`src/settings/resolve-processing.ts`의 병합 리터럴에 `devices` 블록 아래 한 줄만 추가한다. 오버라이드 노브는 Task 2가 얹는다 — 여기서는 전역 값을 그대로 옮겨 동작을 바꾸지 않는다:

```ts
      summary_model: cfg.summary_model,
```

- [ ] **Step 13: 기존 서비스 테스트의 기대값 갱신**

`test/settings.service.spec.ts`에서 이름 프리셋 resolve 결과를 통째로 비교하는 블록(30–39행 부근)을 아래로 수정:

```ts
  it('이름 프리셋 저장 → 항상 상수에서 resolve', async () => {
    await service.putProcessing({ preset: 'light', language: 'ko' });
    const cfg = await service.getProcessingConfig();
    expect(cfg).toEqual({
      preset: 'light', preset_revision: PRESET_REVISION, language: 'ko',
      whisper_model: 'small', devices: { diarization: 'gpu', stt: 'cpu' },
      summary_model: 'qwen3.5:4b-mlx',
    });
    const row = await db.pool.query(`SELECT value FROM app_setting WHERE key='processing_defaults'`);
    expect(row.rows[0].value).toEqual({ preset: 'light', language: 'ko' }); // 이름만 저장 — 개별 값 스냅샷 없음
  });
```

- [ ] **Step 14: 테스트 + 타입 체크 통과 확인**

실행: `npx jest test/presets.spec.ts test/settings.service.spec.ts test/settings.e2e-spec.ts test/resolve-processing.spec.ts && npx tsc --noEmit -p tsconfig.build.json`
기대: PASS + 타입 에러 없음

- [ ] **Step 15: 커밋**

```bash
git add src/contracts/model-catalog.ts src/settings/presets.ts src/config/env.ts src/settings/processing-config.ts src/settings/settings.controller.ts src/settings/resolve-processing.ts test/presets.spec.ts test/settings.service.spec.ts test/settings.e2e-spec.ts
git commit -m "feat: 프리셋에 summary_model 추가 + 저장값 스키마 읽기/쓰기 분리"
```

---

### Task 2: job 오버라이드 병합

**Files:**
- Modify: `src/settings/resolve-processing.ts`
- Test: `test/resolve-processing.spec.ts`

**Interfaces:**
- Consumes: `ProcessingConfig.summary_model` (Task 1), `SUMMARY_MODELS` (Task 1)
- Produces: `ProcessingOverrideSchema`에 `summary_model?: SummaryModel` 추가. `resolveProcessingConfig(global, override, gpuEligible)` 시그니처는 불변.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/resolve-processing.spec.ts`의 `describe` 안에 추가:

```ts
  it('summary_model만 override → 병합 + preset custom (spec §5)', () => {
    const r = resolveProcessingConfig(global_, { summary_model: 'qwen3.5:14b-mlx' }, true);
    expect(r.summary_model).toBe('qwen3.5:14b-mlx');
    expect(r.whisper_model).toBe('large-v3-turbo'); // 전역 유지
    expect(r.preset).toBe('custom');
    expect(r.preset_revision).toBeNull();
  });

  it('preset override는 그 프리셋의 요약 모델을 통째로 가져온다', () => {
    const r = resolveProcessingConfig(global_, { preset: 'quality' }, true);
    expect(r.summary_model).toBe('qwen3.5:14b-mlx');
    expect(r.preset).toBe('quality');
  });

  it('preset + summary_model 혼합 → 프리셋 resolve 후 요약 모델만 덮어씀, 결과 custom', () => {
    const r = resolveProcessingConfig(global_, { preset: 'light', summary_model: 'qwen3.5:14b-mlx' }, true);
    expect(r.whisper_model).toBe('small');              // light 유래
    expect(r.summary_model).toBe('qwen3.5:14b-mlx');    // 개별 override
    expect(r.preset).toBe('custom');
  });

  it('스키마: 목록 밖 summary_model 거부', () => {
    expect(ProcessingOverrideSchema.safeParse({ summary_model: 'gpt-9' }).success).toBe(false);
  });
```

- [ ] **Step 2: 테스트 실패 확인**

실행: `npx jest test/resolve-processing.spec.ts`
기대: FAIL — `summary_model`이 `ProcessingOverride` 타입에 없음

- [ ] **Step 3: 스키마와 병합 로직 수정**

`src/settings/resolve-processing.ts`에서 import 한 줄을 추가하고, 스키마·병합을 수정:

```ts
import { SUMMARY_MODELS } from '../contracts/model-catalog';
```

`ProcessingOverrideSchema`의 `language` 아래에 필드 추가:

```ts
  summary_model: z.enum(SUMMARY_MODELS).optional(),
```

`individual` 판정과 병합 리터럴을 교체:

```ts
  const individual = override && (override.whisper_model !== undefined ||
    override.devices !== undefined || override.language !== undefined ||
    override.summary_model !== undefined);
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
      summary_model: override.summary_model ?? cfg.summary_model,
    };
  }
```

- [ ] **Step 4: 테스트 통과 확인**

실행: `npx jest test/resolve-processing.spec.ts`
기대: PASS (기존 7건 + 신규 4건)

- [ ] **Step 5: 커밋**

```bash
git add src/settings/resolve-processing.ts test/resolve-processing.spec.ts
git commit -m "feat: job 오버라이드에 summary_model 추가"
```

---

### Task 3: payload v3 (TypeScript) + fixture

**Files:**
- Modify: `src/contracts/job-payload.schema.ts`
- Create: `test/fixtures/job-payloads/process_meeting.v3.valid.json`
- Create: `test/fixtures/job-payloads/process_meeting.v3.missing_summary_model.json`
- Modify: `test/contract-fixtures.spec.ts`
- Modify: `test/meetings.e2e-spec.ts:137,170` (schema_version 기대값)
- Test: `test/contract-fixtures.spec.ts`, `test/job-payload.spec.ts`

**Interfaces:**
- Consumes: `SUMMARY_MODELS` (Task 1), `ProcessingConfig.summary_model` (Task 1)
- Produces:
  - `ModelsSchemaV3` — `ModelsSchemaV2` 필드 전부 + `summary_model: z.enum(SUMMARY_MODELS)`, `.strict()`
  - `type ProcessMeetingPayloadV3`
  - `buildProcessMeetingPayload(args): ProcessMeetingPayloadV3` — `schema_version: 3`
  - `ProcessMeetingPayloadSchema`가 v1/v2/v3 discriminated union

- [ ] **Step 1: fixture 2개 생성**

`test/fixtures/job-payloads/process_meeting.v3.valid.json`:

```json
{
  "schema_version": 3,
  "meeting_id": "mtg_1",
  "audio_key": "meetings/mtg_1/original.m4a",
  "processing_version": 2,
  "reprocess": true,
  "models": {
    "whisper_model": "small",
    "language": "ko",
    "devices": { "diarization": "gpu", "stt": "cpu" },
    "preset": "light",
    "preset_revision": "2026-08-12.1",
    "summary_model": "qwen3.5:4b-mlx",
    "diarization": { "model": "pyannote/speaker-diarization-3.1", "min_speakers": null, "max_speakers": null },
    "embedding": { "model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192 }
  },
  "identify": { "threshold": 0.7 }
}
```

`test/fixtures/job-payloads/process_meeting.v3.missing_summary_model.json` — 위와 동일하되 `"summary_model"` 줄만 제거:

```json
{
  "schema_version": 3,
  "meeting_id": "mtg_1",
  "audio_key": "meetings/mtg_1/original.m4a",
  "processing_version": 2,
  "reprocess": true,
  "models": {
    "whisper_model": "small",
    "language": "ko",
    "devices": { "diarization": "gpu", "stt": "cpu" },
    "preset": "light",
    "preset_revision": "2026-08-12.1",
    "diarization": { "model": "pyannote/speaker-diarization-3.1", "min_speakers": null, "max_speakers": null },
    "embedding": { "model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192 }
  },
  "identify": { "threshold": 0.7 }
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`test/contract-fixtures.spec.ts`의 `describe` 안에 추가:

```ts
  it('validates process_meeting.v3.valid.json', () => {
    const p = ProcessMeetingPayloadSchema.parse(read('process_meeting.v3.valid.json'));
    expect(p.schema_version).toBe(3);
    if (p.schema_version === 3) {
      expect(p.models.summary_model).toBe('qwen3.5:4b-mlx');
      expect(p.models.preset).toBe('light');
    }
  });
  it('rejects v3 payload missing summary_model (env 폴백 금지)', () => {
    expect(() => ProcessMeetingPayloadSchema.parse(read('process_meeting.v3.missing_summary_model.json'))).toThrow();
  });
  it('rejects v2 payload carrying summary_model (v2는 그 필드를 모른다)', () => {
    const v2 = read('process_meeting.v2.valid.json');
    v2.models.summary_model = 'qwen3.5:4b-mlx';
    expect(() => ProcessMeetingPayloadSchema.parse(v2)).toThrow();
  });
```

- [ ] **Step 3: 테스트 실패 확인**

실행: `npx jest test/contract-fixtures.spec.ts`
기대: FAIL — v3 fixture가 discriminated union에 매칭되지 않음

- [ ] **Step 4: 스키마에 v3 추가**

`src/contracts/job-payload.schema.ts`에 import를 추가하고:

```ts
import { SUMMARY_MODELS } from './model-catalog';
```

`ModelsSchemaV2` 정의 아래에 추가:

```ts
export const ModelsSchemaV3 = z
  .object({
    whisper_model: z.enum(WHISPER_MODELS),
    language: z.string(),
    devices: z.object({ diarization: DeviceSchema, stt: DeviceSchema }),
    preset: z.enum(['light', 'standard', 'quality', 'custom']),
    preset_revision: z.string().nullable(),
    summary_model: z.enum(SUMMARY_MODELS),
    diarization: DiarizationSchema,
    embedding: EmbeddingSchema,
  })
  .strict();
```

`ProcessMeetingPayloadV2Schema` 아래에 추가하고 union을 확장:

```ts
const ProcessMeetingPayloadV3Schema = z.object({
  schema_version: z.literal(3), ...processMeetingCommon, models: ModelsSchemaV3,
});
```

```ts
  z.discriminatedUnion('schema_version', [
    ProcessMeetingPayloadV1Schema,
    ProcessMeetingPayloadV2Schema,
    ProcessMeetingPayloadV3Schema,
  ]),
```

타입 export 추가:

```ts
export type ProcessMeetingPayloadV3 = z.infer<typeof ProcessMeetingPayloadV3Schema>;
```

- [ ] **Step 5: builder를 v3로 전환**

`buildProcessMeetingPayload`를 교체:

```ts
export function buildProcessMeetingPayload(args: {
  meetingId: string; audioKey: string; processingVersion: number; reprocess: boolean;
  processing: ProcessingConfig;
}): ProcessMeetingPayloadV3 {
  const env = loadEnv();
  const p = args.processing;
  return {
    schema_version: 3,
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
      summary_model: p.summary_model,
      diarization: { model: env.DIARIZATION_MODEL, min_speakers: null, max_speakers: null },
      embedding: { model: env.EMBEDDING_MODEL, dimension: env.EMBEDDING_DIM },
    },
    identify: { threshold: env.IDENTIFY_THRESHOLD },
  };
}
```

- [ ] **Step 6: 기존 e2e 기대값 갱신**

`test/meetings.e2e-spec.ts` 137행의 `expect(job.rows[0].payload.schema_version).toBe(2)`를 `toBe(3)`으로 바꾼다. 같은 파일에서 `payload.models.*`를 검사하는 나머지 단언(138–171행)은 필드 이름이 그대로라 수정 불필요.

- [ ] **Step 7: 테스트 통과 확인**

실행: `npx jest test/contract-fixtures.spec.ts test/job-payload.spec.ts test/meetings.e2e-spec.ts`
기대: PASS. 실패가 남으면 v2를 하드코딩한 다른 단언이 있는지 확인:
`grep -rn "schema_version" test/ | grep -v fixtures`

- [ ] **Step 8: 커밋**

```bash
git add src/contracts/job-payload.schema.ts test/fixtures/job-payloads/process_meeting.v3.valid.json test/fixtures/job-payloads/process_meeting.v3.missing_summary_model.json test/contract-fixtures.spec.ts test/meetings.e2e-spec.ts
git commit -m "feat: process_meeting payload v3 (models.summary_model)"
```

---

### Task 4: payload v3 (Python) — wire/내부 모델 분리

**Files:**
- Modify: `worker/damwha_worker/contracts.py`
- Modify: `worker/tests/test_contracts.py:36-39` (`test_rejects_future_schema_version`)
- Test: `worker/tests/test_contracts.py`

**Interfaces:**
- Consumes: Task 3이 만든 fixture `process_meeting.v3.valid.json`, `process_meeting.v3.missing_summary_model.json`
- Produces:
  - `ModelsWireV3` — `summary_model: str` 필수, `extra="forbid"`
  - `ModelsConfig` — 내부 정규 표현. `summary_model: str | None = None`. **`Models`라는 이름은 쓸 수 없다** — `pipeline/process_meeting.py:24`의 로드된 ML 어댑터 dataclass가 이미 그 이름이고 `models/registry.py:14`가 import한다.
  - `ProcessMeetingPayload.models: ModelsConfig`
  - `parse_models(payload: dict) -> ModelsConfig`
  - `SUPPORTED_SCHEMA_VERSIONS['process_meeting'] == frozenset({1, 2, 3})`

- [ ] **Step 1: 실패하는 테스트 작성**

`worker/tests/test_contracts.py`에 추가:

```python
def test_parses_v3_fixture():
    p = parse_payload("process_meeting", load("process_meeting.v3.valid.json"))
    assert p.schema_version == 3
    assert p.models.summary_model == "qwen3.5:4b-mlx"
    assert p.models.preset == "light"
    assert p.models.devices.stt == "cpu"


def test_v3_requires_summary_model():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        parse_payload("process_meeting", load("process_meeting.v3.missing_summary_model.json"))


def test_v2_rejects_summary_model_extra_field():
    from pydantic import ValidationError

    data = load("process_meeting.v2.valid.json")
    data["models"]["summary_model"] = "qwen3.5:4b-mlx"
    with pytest.raises(ValidationError):
        parse_payload("process_meeting", data)


@pytest.mark.parametrize("fixture", ["process_meeting.valid.json", "process_meeting.v2.valid.json"])
def test_v1_v2_have_no_summary_model(fixture):
    p = parse_payload("process_meeting", load(fixture))
    assert p.models.summary_model is None
```

같은 파일의 `test_rejects_future_schema_version`을 수정 — 3은 이제 지원 버전이다:

```python
def test_rejects_future_schema_version():
    data = load("process_meeting.valid.json") | {"schema_version": 4}
    with pytest.raises(UnsupportedPayloadVersion):
        parse_payload("process_meeting", data)
```

- [ ] **Step 2: 테스트 실패 확인**

실행: `cd worker && uv run pytest tests/test_contracts.py -q`
기대: FAIL — `UnsupportedPayloadVersion: process_meeting: schema_version 3 not in [1, 2]`

- [ ] **Step 3: contracts.py 모델 재구성**

`worker/damwha_worker/contracts.py`에서 `ModelsV2` 정의부터 `_v1_models_to_v2`까지를 아래로 교체:

```python
class ModelsV2(BaseModel):
    """wire v2 전용. TS ModelsSchemaV2가 .strict()이므로 여기도 extra를 막는다."""

    model_config = ConfigDict(extra="forbid")

    whisper_model: WhisperModel
    language: str
    devices: Devices
    preset: str | None = None
    preset_revision: str | None = None
    diarization: Diarization
    embedding: Embedding


class ModelsWireV3(BaseModel):
    """wire v3. summary_model은 필수 — v3는 완전 해석된 계약이라 워커가 env로
    폴백할 여지를 남기지 않는다 (spec §3)."""

    model_config = ConfigDict(extra="forbid")

    whisper_model: WhisperModel
    language: str
    devices: Devices
    preset: str | None = None
    preset_revision: str | None = None
    summary_model: NonEmptyString
    diarization: Diarization
    embedding: Embedding


class ModelsConfig(BaseModel):
    """내부 정규 표현 — 파이프라인/registry는 이 모양만 다룬다.

    이름이 Models가 아닌 이유: pipeline/process_meeting.py의 Models는 로드된 ML
    어댑터(VAD/Diarizer/Embedder/Transcriber) 묶음이고 registry.py가 그걸 import한다.

    summary_model이 nullable인 이유는 preset/preset_revision과 같다: v1/v2에서
    변환된 payload에는 값이 없다. v3 유래는 항상 채워진다. Literal이 아니라 str인
    이유는 워커가 API의 큐레이션 목록을 알 필요가 없기 때문 — 목록 검증은 API 경계
    (그리고 워커 env 폴백 값은 목록 밖일 수 있다)."""

    whisper_model: WhisperModel
    language: str
    devices: Devices
    preset: str | None = None
    preset_revision: str | None = None
    summary_model: str | None = None
    diarization: Diarization
    embedding: Embedding


def _v1_models_to_internal(m: ModelsV1) -> ModelsConfig:
    if m.device == "cuda":
        # cuda→gpu는 Metal 의미와 다른 오변환 — cpu로 내리고 경고 (spec §4)
        log.warning("v1 payload device=cuda — converting to cpu (cuda is a non-goal)")
    dev: Device = "gpu" if m.device == "mps" else "cpu"
    return ModelsConfig(
        whisper_model=m.whisper_model,
        language=m.language,
        devices=Devices(diarization=dev, stt=dev),
        preset=None,
        preset_revision=None,
        summary_model=None,
        diarization=m.diarization,
        embedding=m.embedding,
    )


def _v2_models_to_internal(m: ModelsV2) -> ModelsConfig:
    return ModelsConfig(**m.model_dump(), summary_model=None)


def _v3_models_to_internal(m: ModelsWireV3) -> ModelsConfig:
    return ModelsConfig(**m.model_dump())
```

`ModelsV1`에는 `extra="forbid"`를 넣지 않는다 — TS `ModelsSchemaV1`도 `.strict()`가 아니다(`src/contracts/job-payload.schema.ts:19`). 두 스키마의 엄격도를 짝지어 둔다.

- [ ] **Step 4: payload 클래스와 parser 수정**

같은 파일에서 `ProcessMeetingPayload`의 `models` 타입과 v3 wire 클래스, parser를 수정.

`ProcessMeetingPayloadV1` 아래에 추가:

```python
class ProcessMeetingPayloadWireV2(BaseModel):
    schema_version: Literal[2]
    meeting_id: MeetingId
    audio_key: str
    processing_version: int
    reprocess: bool
    models: ModelsV2
    identify: Identify


class ProcessMeetingPayloadWireV3(BaseModel):
    schema_version: Literal[3]
    meeting_id: MeetingId
    audio_key: str
    processing_version: int
    reprocess: bool
    models: ModelsWireV3
    identify: Identify
```

`ProcessMeetingPayload`의 필드 타입 교체:

```python
    models: ModelsConfig
```

`_parse_process_meeting`를 교체:

```python
def _parse_process_meeting(data: dict) -> ProcessMeetingPayload:
    version = data.get("schema_version", 1)
    if version == 1:
        v1 = ProcessMeetingPayloadV1.model_validate(data)
        return ProcessMeetingPayload(
            schema_version=1,
            meeting_id=v1.meeting_id,
            audio_key=v1.audio_key,
            processing_version=v1.processing_version,
            reprocess=v1.reprocess,
            models=_v1_models_to_internal(v1.models),
            identify=v1.identify,
        )
    if version == 2:
        v2 = ProcessMeetingPayloadWireV2.model_validate(data)
        return ProcessMeetingPayload(
            schema_version=2,
            meeting_id=v2.meeting_id,
            audio_key=v2.audio_key,
            processing_version=v2.processing_version,
            reprocess=v2.reprocess,
            models=_v2_models_to_internal(v2.models),
            identify=v2.identify,
        )
    v3 = ProcessMeetingPayloadWireV3.model_validate(data)
    return ProcessMeetingPayload(
        schema_version=3,
        meeting_id=v3.meeting_id,
        audio_key=v3.audio_key,
        processing_version=v3.processing_version,
        reprocess=v3.reprocess,
        models=_v3_models_to_internal(v3.models),
        identify=v3.identify,
    )
```

`parse_models`의 반환 타입과 주석을 바꾼다:

```python
def parse_models(payload: dict) -> ModelsConfig:
    """registry용: process_meeting payload dict → 정규화된 내부 ModelsConfig."""
    return _parse_process_meeting(payload).models
```

지원 버전 확장 (10–16행 dict):

```python
    "process_meeting": frozenset({1, 2, 3}),
```

- [ ] **Step 5: 남은 `ModelsV2` 참조 정리**

실행: `cd worker && grep -rn "ModelsV2\b" damwha_worker tests`
기대: `contracts.py`의 wire 클래스 정의/사용만 남는다. 내부 표현 타입으로 `ModelsV2`를 import하던 곳이 있으면 `ModelsConfig`로 교체한다.

`pipeline/process_meeting.py`와 `models/registry.py`의 `Models`(로드된 ML 어댑터 dataclass)는 **건드리지 않는다** — 이름만 비슷할 뿐 다른 개념이다. 확인:
`cd worker && grep -rn "from ..pipeline.process_meeting import Models\|class Models" damwha_worker`
기대: `registry.py:14`와 `pipeline/process_meeting.py:24` 두 줄이 그대로 남아 있다.

- [ ] **Step 6: 테스트 통과 확인**

실행: `cd worker && uv run pytest tests/test_contracts.py -q && uv run ruff check .`
기대: PASS + lint 통과

- [ ] **Step 7: 워커 전체 스위트 확인**

실행: `cd worker && uv run pytest -q`
기대: PASS (Docker 필요)

- [ ] **Step 8: 커밋**

```bash
git add worker/damwha_worker/contracts.py worker/tests/test_contracts.py
git commit -m "feat: 워커 payload v3 파서 + wire/내부 모델 분리"
```

---

### Task 5: 워커 요약 모델 해석

**Files:**
- Modify: `worker/damwha_worker/pipeline/process_meeting.py:44-45,177-178`
- Test: `worker/tests/test_process_meeting.py`

**Interfaces:**
- Consumes: `ProcessMeetingPayload.models.summary_model: str | None` (Task 5)
- Produces: `run_process_meeting(...)` 시그니처 불변. 내부에서 `payload.models.summary_model or summary_llm_model`을 `db.persist_process_meeting`의 `summary_llm_model` 인자로 넘긴다.

- [ ] **Step 1: 실패하는 테스트 작성**

`worker/tests/test_process_meeting.py`의 `_models()` 정의 아래에 v3 payload 헬퍼를 추가한다 (기존 `_payload`는 v1이라 그대로 둔다):

```python
def _payload_v3(meeting_id, audio_key, summary_model, pv=0, threshold=0.7):
    return parse_payload(
        "process_meeting",
        {
            "schema_version": 3,
            "meeting_id": str(meeting_id),
            "audio_key": audio_key,
            "processing_version": pv,
            "reprocess": pv > 0,
            "models": {
                "whisper_model": "large-v3-turbo",
                "language": "ko",
                "devices": {"diarization": "cpu", "stt": "cpu"},
                "preset": "standard",
                "preset_revision": "2026-08-12.1",
                "summary_model": summary_model,
                "diarization": {"model": "d", "min_speakers": None, "max_speakers": None},
                "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
            },
            "identify": {"threshold": threshold},
        },
    )
```

같은 파일 끝에 두 테스트를 추가한다:

```python
def test_v3_payload_summary_model_wins_over_worker_env(conn, tmp_path):
    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")

    out = run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload_v3(mid, "meetings/m/original.m4a", "qwen3.5:14b-mlx"),
        _models(),
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(2000),
        summary_llm_model="worker-env-model",
    )
    assert out == "committed"
    row = conn.execute(
        "SELECT model FROM meeting_summary WHERE meeting_id=%s", (mid,)
    ).fetchone()
    assert row["model"] == "qwen3.5:14b-mlx"


def test_v1_payload_falls_back_to_worker_env_summary_model(conn, tmp_path):
    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")

    out = run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(mid, "meetings/m/original.m4a"),  # v1 — summary_model 없음
        _models(),
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(2000),
        summary_llm_model="worker-env-model",
    )
    assert out == "committed"
    row = conn.execute(
        "SELECT model FROM meeting_summary WHERE meeting_id=%s", (mid,)
    ).fetchone()
    assert row["model"] == "worker-env-model"
```

- [ ] **Step 2: 테스트 실패 확인**

실행: `cd worker && uv run pytest tests/test_process_meeting.py -k summary_model -q`
기대: FAIL — 첫 테스트에서 `model == "env-model"` (payload 값이 무시됨)

- [ ] **Step 3: 해석 로직 추가**

`worker/damwha_worker/pipeline/process_meeting.py`의 `db.persist_process_meeting(...)` 호출 직전(현재 177–178행이 있는 블록의 위)에 한 줄을 넣고, 인자를 바꾼다:

```python
        # v3 payload는 API가 해석한 값을 싣고 온다. v1/v2 유래는 None이라 워커
        # env로 폴백한다 (spec §4).
        summary_model = payload.models.summary_model or summary_llm_model
```

```python
            lens_llm_model=lens_llm_model,
            summary_llm_model=summary_model,
```

- [ ] **Step 4: 테스트 통과 확인**

실행: `cd worker && uv run pytest tests/test_process_meeting.py -q && uv run ruff check .`
기대: PASS

- [ ] **Step 5: 커밋**

```bash
git add worker/damwha_worker/pipeline/process_meeting.py worker/tests/test_process_meeting.py
git commit -m "feat: 워커가 payload의 summary_model로 요약 job을 큐잉"
```

---

### Task 6: 요약 재생성 API — 모듈 배선 + 오버라이드 + 409

**Files:**
- Modify: `src/summary/summary.module.ts`
- Modify: `src/summary/summary.repository.ts:31-39`
- Modify: `src/summary/summary.service.ts`
- Modify: `src/meetings/meetings.controller.ts:65-68`
- Test: `test/summary.e2e-spec.ts`

**Interfaces:**
- Consumes: `SettingsService.getProcessingConfig(): Promise<ProcessingConfig>` (기존), `SUMMARY_MODELS` (Task 1)
- Produces:
  - `SummaryGenerateBodySchema` — `{ summary_model?: SummaryModel }`, `.strict()`
  - `SummaryRepository.findActive(...)` 반환값에 `model: string` 추가
  - `SummaryService.request(meetingId: string, body?: unknown): Promise<SummaryRequestResult>`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/summary.e2e-spec.ts`의 `describe` 안에 추가. `seedSummary` 헬퍼는 모델을 `'test-model'`로 고정하므로, 모델을 지정할 수 있는 헬퍼를 하나 더 둔다:

```ts
  const seedSummaryWithModel = async (
    meetingId: string,
    opts: { processingVersion: number; status: SummaryStatus; model: string },
  ) =>
    db.pool.query(
      `INSERT INTO meeting_summary(meeting_id, processing_version, model, status, topics, segments)
       VALUES($1, $2, $3, $4, '[]'::jsonb, '[]'::jsonb)`,
      [meetingId, opts.processingVersion, opts.model, opts.status],
    );

  it('body 없음 → 전역 설정의 summary_model로 큐잉된다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await request(app.getHttpServer())
      .put('/settings/processing').send({ preset: 'quality', language: 'ko' }).expect(200);

    await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/summary/generate`).expect(202);

    const row = await db.pool.query(
      `SELECT model FROM meeting_summary WHERE meeting_id=$1`, [meetingId],
    );
    expect(row.rows[0].model).toBe('qwen3.5:14b-mlx');
    const job = await db.pool.query(
      `SELECT payload FROM job WHERE meeting_id=$1 AND type='summarize_meeting'`, [meetingId],
    );
    expect(job.rows[0].payload.model).toBe('qwen3.5:14b-mlx');
  });

  it('body override → 그 모델로 큐잉되고 전역 설정은 바뀌지 않는다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await request(app.getHttpServer())
      .put('/settings/processing').send({ preset: 'light', language: 'ko' }).expect(200);

    await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/summary/generate`)
      .send({ summary_model: 'qwen3.5:14b-mlx' })
      .expect(202);

    const row = await db.pool.query(
      `SELECT model FROM meeting_summary WHERE meeting_id=$1`, [meetingId],
    );
    expect(row.rows[0].model).toBe('qwen3.5:14b-mlx');
    const settings = await request(app.getHttpServer()).get('/settings/processing').expect(200);
    expect(settings.body.summary_model).toBe('qwen3.5:4b-mlx'); // 저장되지 않는다
  });

  it('목록 밖 모델 → 400', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/summary/generate`)
      .send({ summary_model: 'gpt-9' })
      .expect(400);
  });

  it('진행 중 요약과 다른 모델로 재요청 → 409', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await seedSummaryWithModel(meetingId, {
      processingVersion: 0, status: 'running', model: 'qwen3.5:4b-mlx',
    });
    const res = await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/summary/generate`)
      .send({ summary_model: 'qwen3.5:14b-mlx' });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('qwen3.5:4b-mlx');
  });

  it('진행 중 요약과 같은 모델로 재요청 → 기존 상태 반환 (멱등)', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await seedSummaryWithModel(meetingId, {
      processingVersion: 0, status: 'running', model: 'qwen3.5:14b-mlx',
    });
    const res = await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/summary/generate`)
      .send({ summary_model: 'qwen3.5:14b-mlx' })
      .expect(202);
    expect(res.body.status).toBe('running');
    const jobs = await db.pool.query(
      `SELECT count(*)::int AS n FROM job WHERE meeting_id=$1 AND type='summarize_meeting'`,
      [meetingId],
    );
    expect(jobs.rows[0].n).toBe(0); // 재큐잉 없음
  });
```

- [ ] **Step 2: 테스트 실패 확인**

실행: `npx jest test/summary.e2e-spec.ts`
기대: FAIL — 첫 테스트에서 `model`이 env 기본값(`qwen3.5:4b-mlx`)으로 기록됨

- [ ] **Step 3: 모듈 배선**

`src/summary/summary.module.ts`를 교체:

```ts
import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { SummaryRepository } from './summary.repository';
import { SummaryService } from './summary.service';

@Module({
  // DatabaseModule/JobsModule은 @Global()이지만 SettingsModule은 아니다 — 명시 import 필요.
  imports: [SettingsModule],
  providers: [SummaryRepository, SummaryService],
  exports: [SummaryService],
})
export class SummaryModule {}
```

- [ ] **Step 4: findActive가 model을 조회하도록 수정**

`src/summary/summary.repository.ts`의 `findActive`를 교체:

```ts
  async findActive(exec: Queryable, meetingId: string, processingVersion: number) {
    const { rows } = await exec.query<{ status: string; job_id: string | null; model: string }>(
      `SELECT status, job_id, model FROM meeting_summary
        WHERE meeting_id = $1 AND processing_version = $2
          AND status IN ('queued','running')`,
      [meetingId, processingVersion],
    );
    return rows[0] ?? null;
  }
```

- [ ] **Step 5: 서비스 로직 교체**

`src/summary/summary.service.ts` 전체를 교체:

```ts
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { buildSummarizeMeetingPayload } from '../contracts/job-payload.schema';
import { SUMMARY_MODELS } from '../contracts/model-catalog';
import { DatabaseService } from '../database/database.service';
import { JobsRepository } from '../jobs/jobs.repository';
import { SettingsService } from '../settings/settings.service';
import { SummaryRepository } from './summary.repository';
import { SummaryRow } from './summary.types';

export interface SummaryRequestResult {
  status: string;
  job_id: string | null;
  processing_version: number;
}

// 요약 재생성 한정 오버라이드 — 저장하지 않는다 (spec §6).
export const SummaryGenerateBodySchema = z.object({
  summary_model: z.enum(SUMMARY_MODELS).optional(),
}).strict();

@Injectable()
export class SummaryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: JobsRepository,
    private readonly summaries: SummaryRepository,
    private readonly settings: SettingsService,
  ) {}

  get(meetingId: string): Promise<SummaryRow | null> {
    return this.summaries.findCurrent(meetingId);
  }

  async request(meetingId: string, body?: unknown): Promise<SummaryRequestResult> {
    const parsed = SummaryGenerateBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    // 설정 로드(DB)는 트랜잭션 진입 전에 — spec §5의 순서 원칙.
    const model =
      parsed.data.summary_model ?? (await this.settings.getProcessingConfig()).summary_model;

    return this.db.withTransaction(async (exec) => {
      const meeting = await this.summaries.lockMeeting(exec, meetingId);
      if (!meeting) throw new NotFoundException('meeting not found');
      if (meeting.status !== 'done') {
        throw new ConflictException('summary generation allowed only when status is done');
      }

      const active = await this.summaries.findActive(exec, meeting.id, meeting.processing_version);
      if (active) {
        if (active.model !== model) {
          // 큐에 든 job의 payload는 불변이라 모델을 갈아끼울 수 없다. 조용히
          // 무시하면 "고른 적 없는 모델의 결과"가 나온다 (spec §6).
          throw new ConflictException(
            `summary already in progress with model ${active.model}; ` +
            `wait for it to finish before requesting ${model}`,
          );
        }
        return {
          status: active.status,
          job_id: active.job_id,
          processing_version: meeting.processing_version,
        };
      }

      const payload = buildSummarizeMeetingPayload({
        meetingId: meeting.id,
        processingVersion: meeting.processing_version,
        model,
      });
      const job = await this.jobs.enqueue(exec, {
        type: 'summarize_meeting', meetingId: meeting.id, payload,
      });
      await this.summaries.upsertQueued(exec, {
        meetingId: meeting.id,
        processingVersion: meeting.processing_version,
        jobId: job.id,
        model,
      });
      return { status: 'queued', job_id: job.id, processing_version: meeting.processing_version };
    });
  }
}
```

`loadEnv` import가 사라진 것을 확인한다 — 이제 env를 직접 읽지 않는다.

- [ ] **Step 6: 컨트롤러가 body를 넘기도록 수정**

`src/meetings/meetings.controller.ts`의 요약 생성 엔드포인트(65–68행)를 교체:

```ts
  @Post(':id/summary/generate')
  @ApiOperation({ summary: '대화 요약 생성/재생성' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        summary_model: {
          type: 'string',
          description:
            '이번 요약 한정 모델 오버라이드. 생략하면 전역 처리 설정의 summary_model을 쓴다. ' +
            '저장되지 않으며, 진행 중인 요약과 모델이 다르면 409.',
        },
      },
    },
  })
  @HttpCode(202)
  generateSummary(@Param('id') id: string, @Body() body: { summary_model?: unknown }) {
    return this.summary.request(id, body);
  }
```

`@ApiBody`가 이미 import되어 있는지 확인하고(재처리 엔드포인트가 쓰고 있음), `@HttpCode(202)`는 기존 값을 그대로 유지한다 — 기존 코드에 있던 데코레이터를 지우지 말 것.

- [ ] **Step 7: 테스트 통과 확인**

실행: `npx jest test/summary.e2e-spec.ts`
기대: PASS (기존 + 신규 5건)

- [ ] **Step 8: 전체 스위트 확인**

실행: `npm test`
기대: PASS. 실패 시 `SummaryModule`을 import하는 다른 모듈에서 DI 에러가 났는지 먼저 확인한다.

- [ ] **Step 9: 커밋**

```bash
git add src/summary/ src/meetings/meetings.controller.ts test/summary.e2e-spec.ts
git commit -m "feat: 요약 재생성에 모델 오버라이드 + 진행 중 모델 불일치 409"
```

---

### Task 7: 문서 갱신

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/worker-architecture.md`
- Modify: `.env.example`
- Modify: `worker/SMOKE.md`

**Interfaces:**
- Consumes: Task 1–6의 최종 동작
- Produces: 없음 (문서)

- [ ] **Step 1: CLAUDE.md 갱신**

세 곳을 고친다.

1. "Architecture: two runtimes joined by one table" 문단에서 지원 버전을 고친다: `process_meeting` accepts **v1, v2, and v3** — **v3** adds `models.summary_model` (the summary LLM chosen by the processing preset); 워커가 v1/v2를 내부 표현으로 변환할 때 그 필드는 `None`이고 워커 env로 폴백한다.
2. "Processing settings live in the API" 항목에 프리셋이 `summary_model`까지 정의한다는 사실과 `PRESET_REVISION='2026-08-12.1'`를 반영한다.
3. "Conversation summary is a fourth job type" 항목에 모델 출처를 적는다: 워커 자동 큐잉은 payload의 `models.summary_model`(없으면 워커 env), API 재생성(`POST /meetings/:id/summary/generate`)은 전역 설정값 또는 body의 `summary_model`이며 진행 중인 요약과 모델이 다르면 409.

- [ ] **Step 2: worker-architecture.md 갱신**

payload 버전을 언급하는 곳에 v3와 `models.summary_model`을 추가한다. 위치 확인: `grep -n "schema_version\|v2" docs/worker-architecture.md`

- [ ] **Step 3: .env.example 갱신**

`SUMMARY_LLM_MODEL` 줄 위에 주석을 넣는다:

```
# 목록 제한: qwen3.5:4b-mlx | qwen3.5:8b-mlx | qwen3.5:14b-mlx
# 목록 밖 값이면 API가 시작하지 않는다. 목록은 src/contracts/model-catalog.ts.
# 이 값은 처리 설정이 없을 때의 폴백 + summary_model이 없던 레거시 custom 행의 기본값이다.
SUMMARY_LLM_MODEL=qwen3.5:4b-mlx
```

- [ ] **Step 4: SMOKE.md 갱신**

"Per-Preset Smoke (light / standard / quality)" 절에 프리셋별 요약 모델 확인 항목을 추가한다:

```
- 프리셋별 요약 모델이 실제로 서빙되는지 먼저 확인한다:
  `curl -s http://127.0.0.1:11434/v1/models | jq -r '.data[].id'`
  light → qwen3.5:4b-mlx / standard → qwen3.5:8b-mlx / quality → qwen3.5:14b-mlx
  목록에 없으면 해당 프리셋의 첫 요약 job이 PERMANENT로 실패한다.
- 요약 완료 후 기록된 모델을 확인한다:
  `psql "$DATABASE_URL" -c "SELECT model, status FROM meeting_summary ORDER BY updated_at DESC LIMIT 1"`
```

- [ ] **Step 5: 커밋**

```bash
git add CLAUDE.md docs/worker-architecture.md .env.example worker/SMOKE.md
git commit -m "docs: 프리셋별 요약 모델 반영 (payload v3, 재생성 오버라이드)"
```

---

## 최종 검증

- [ ] **API 전체 스위트**: `npm test` → PASS
- [ ] **타입 체크**: `npx tsc --noEmit -p tsconfig.build.json` → 에러 없음
- [ ] **워커 스위트 + lint**: `cd worker && uv run pytest -q && uv run ruff check .` → PASS
- [ ] **잔여 v2 하드코딩 확인**: `grep -rn "schema_version" test/ src/ | grep -v fixtures | grep -v "z.literal"` — 남은 곳이 의도된 것인지 확인
- [ ] **FE 계획**: `../fe/docs/superpowers/plans/2026-08-12-summary-model-per-preset-fe.md`는 별도 레포에서 실행한다. BE가 먼저 머지되어야 FE e2e가 성립한다.
- [ ] **릴리스 체크리스트**: 스펙 §11의 5개 항목을 배포 전에 수행한다 (특히 `SUMMARY_LLM_MODEL` env 감사 — 목록 밖 값이면 API가 시작하지 않는다).
