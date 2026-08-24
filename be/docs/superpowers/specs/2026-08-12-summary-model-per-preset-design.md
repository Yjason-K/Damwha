# Damwha — 프리셋별 요약 모델 선택 설계

> 상태: 확정 (설계 합의 완료) · 작성일: 2026-08-12 · 대상: `src/` (NestJS API) + `worker/` (Python ML 워커) + `../fe` (웹 FE)
> 배경: 처리 설정의 프리셋(light/standard/quality)이 지금은 Whisper 모델·디바이스만 정의한다. 대화 요약에 쓰는 로컬 LLM은 env 하나로 고정이라 회의 길이·기대 품질에 맞춰 바꿀 수 없다.
> 선행 문서: `2026-07-13-processing-settings-design.md` (처리 설정), `2026-08-11-conversation-summary-design.md` (대화 요약)

---

## 0. 이 문서의 범위

프리셋이 **요약 LLM 모델**까지 정의하게 하고, 사용자가 고급 설정·job 오버라이드·요약 재생성 시점에 바꿀 수 있게 한다.

- 프리셋이 요약 모델의 **기본값**을 제공하고, 개별 수정 시 `custom`으로 전환한다 (기존 `whisper_model` 패턴과 동일).
- 후보 목록은 **API 코드 상수 enum**. 자유 문자열 입력 없음.
- 선택된 모델은 **job payload로 흘러간다** — process_meeting payload **v3** 신설.
- 요약 재생성 API는 **요청 단위 오버라이드**를 받는다 (저장하지 않음).

**설계 원칙 (선행 문서 계승):** 설정은 유저 의도, payload는 실행 계약. 이름 프리셋은 이름만 저장하고 서버 상수에서 항상 resolve하며, 이미 enqueue된 job의 payload는 불변·완전 해석된 구체 값이다.

**범위 밖 (non-goals):**

- **렌즈 추출 모델(`lens_llm_model`) 프리셋화** — 요약과 구조가 동일하나 이번 요청 범위가 아니다. 별도 작업.
- **모델 목록 동적 조회** — LLM 서버 `GET /v1/models` 호출은 "`src/`에 ML/외부 호출 금지" 규칙의 예외를 하나 더 만든다. 이득 대비 비용이 크다. 목록은 코드 상수.
- **env를 통한 목록 확장** (`SUMMARY_LLM_EXTRA_MODELS` 같은 것) — 목록 밖 모델이 필요하면 `job-payload.schema.ts` 상수 한 줄을 고친다.
- **모델 사전 다운로드** — 첫 요약 job에서 런타임이 lazy 로드. 기존 non-goal 유지.
- **요약 모델별 메모리 적합성 검증(API 측)** — `gpu_eligible` 같은 하드웨어 게이트를 요약 모델에는 두지 않는다. LLM은 워커가 아니라 **상주 LLM 서버**가 로드하므로 API가 적합성을 주장할 근거가 없다. 부적합 모델은 요약 job이 실패하며 드러난다.

### 후보 모델 목록과 프리셋 매핑

| preset | 타겟 RAM | whisper_model | summary_model |
|---|---|---|---|
| `light` | 8GB | `small` | `qwen3.5:4b-mlx` |
| `standard` | 16–32GB | `large-v3-turbo` | `qwen3.5:8b-mlx` |
| `quality` | 64GB+ | `large-v3` | `qwen3.5:14b-mlx` |

**검증되지 않은 가정:** 개발 머신(Apple M2 / 16GB)에는 `qwen3.5:4b-mlx`만 받혀 있다. `8b`/`14b` 태그의 존재와 실제 성능은 SMOKE 단계에서 수동 확인한다. 상수 한 줄이라 교체 비용은 낮다.

**Qwen3.6 미채택 근거 (2026-04 릴리스 조사 결과):** 오픈웨이트가 `Qwen3.6-35B-A3B`(MoE)·`Qwen3.6-27B` 둘뿐이고 4B급 소형 체크포인트가 없다. MLX 4bit 기준 각각 약 19–20GB·15GB로 16GB 머신에서 구동 불가. 나머지 Plus/Flash/Max-Preview는 호스팅 전용 API라 로컬 전용 전제에 어긋난다. `quality` 프리셋 후보로는 유효하나 실측 불가라 이번 목록에서 제외한다.

---

## 1. 상수와 타입 배치

`SUMMARY_MODELS`는 **의존이 없는 새 잎(leaf) 모듈** `src/contracts/model-catalog.ts`에 둔다.

세 곳이 이 목록을 필요로 하는데(`env.ts`, `job-payload.schema.ts`, `settings/`), 기존 파일 어디에 두어도 순환이 생긴다:

- `presets.ts`에 두면 → `job-payload.schema.ts`가 되받아 import (그 파일 3–5행 주석이 경고하는 기존 함정).
- `job-payload.schema.ts`에 두면 → `env.ts`가 import해야 하는데 `job-payload.schema.ts`는 이미 `env.ts`의 `loadEnv`를 import한다(2행). `env.ts` → `job-payload.schema.ts` → `env.ts` 순환.

`env.ts:9`가 `WHISPER_MODEL` enum을 손으로 중복해 적어둔 것이 바로 이 제약의 흔적이다. 요약 모델은 중복 대신 잎 모듈로 푼다.

```ts
// src/contracts/model-catalog.ts — import 없음. 이 파일은 아무것도 의존하지 않는다.
export const SUMMARY_MODELS = ['qwen3.5:4b-mlx', 'qwen3.5:8b-mlx', 'qwen3.5:14b-mlx'] as const;
export type SummaryModel = (typeof SUMMARY_MODELS)[number];
```

`env.ts`·`job-payload.schema.ts`·`settings/presets.ts`·`settings/processing-config.ts`·`settings/resolve-processing.ts`가 여기서 import한다.

기존 `WHISPER_MODELS`는 옮기지 않는다 — 이번 변경과 무관한 이동이고, `env.ts:9`의 중복도 그대로 둔다(불필요한 인접 수정 금지).

```ts
// src/settings/presets.ts
import { SummaryModel } from '../contracts/model-catalog';

export const PRESET_REVISION = '2026-08-12.1'; // 프리셋 정의 변경 — bump

export interface ProcessingConfig {
  preset: PresetName | 'custom';
  preset_revision: string | null;
  language: string;
  whisper_model: WhisperModel;
  devices: { diarization: Device; stt: Device };
  summary_model: SummaryModel;   // 신규
}

const PRESETS: Record<PresetName, Pick<ProcessingConfig, 'whisper_model' | 'devices' | 'summary_model'>> = {
  light:    { whisper_model: 'small',          devices: { diarization: 'gpu', stt: 'cpu' }, summary_model: 'qwen3.5:4b-mlx' },
  standard: { whisper_model: 'large-v3-turbo', devices: { diarization: 'gpu', stt: 'gpu' }, summary_model: 'qwen3.5:8b-mlx' },
  quality:  { whisper_model: 'large-v3',       devices: { diarization: 'gpu', stt: 'gpu' }, summary_model: 'qwen3.5:14b-mlx' },
};
```

`resolvePreset()`은 `summary_model`을 포함해 반환한다.

## 2. 저장 값과 기존 행 호환 (`app_setting`)

`src/settings/processing-config.ts`:

- **읽기 스키마와 쓰기 스키마를 분리한다.** 지금은 `StoredProcessingValueSchema` 하나를 PUT body 검증(`settings.controller.ts:24`)과 저장값 파싱(`settings.service.ts:19`) 양쪽에 쓴다. `summary_model`의 필수 여부가 두 지점에서 달라지므로 나눈다:
  - `StoredProcessingValueSchema` (읽기, `settings.service.getProcessingConfig`) — custom 브랜치에 `summary_model: z.enum(SUMMARY_MODELS).optional()`.
  - `PutProcessingValueSchema` (쓰기, 컨트롤러) — custom 브랜치에 `summary_model: z.enum(SUMMARY_MODELS)` 필수. 나머지 필드·이름 프리셋 브랜치는 읽기 스키마와 동일.
  - 쓰기 타입은 읽기 타입의 부분집합이라 `putProcessing(value)` 시그니처는 그대로 성립한다.
- **이름 프리셋 브랜치는 불변** — `{preset, language}`만. `summary_model`이 섞여 오면 `.strict()`가 400을 낸다 (이름 프리셋 + 개별 노브 혼합 금지, 선행 문서 §3).
- `resolveStoredValue()` custom 경로: `summary_model: value.summary_model ?? loadEnv().SUMMARY_LLM_MODEL`.
- `envFallbackProcessingConfig()`에 `summary_model: env.SUMMARY_LLM_MODEL` 추가.

### 기존 custom 행 처리 — 마이그레이션을 두지 않는다

이미 저장된 `preset='custom'` 행에는 `summary_model`이 없다. 새 zod가 필수로 요구하면 검증 실패 → 전체 config가 env 폴백으로 떨어져 사용자가 고른 whisper/devices까지 조용히 날아간다.

SQL 마이그레이션으로 리터럴을 넣는 방법은 **틀렸다.** 그 행들의 실제 이전 동작은 "그 배포의 `SUMMARY_LLM_MODEL` 값"이었고, SQL은 그 값을 모른다. `qwen3.5:4b-mlx`를 하드코딩하면 env를 다른 값으로 운영하던 배포의 요약 모델이 조용히 바뀐다.

따라서 **읽기 시점 env 기본값**을 쓴다:

- 저장된 custom 값에 `summary_model`이 없으면 → `env.SUMMARY_LLM_MODEL`. 이전 동작과 정확히 같다.
- PUT은 필수라 다음 저장 때 행이 명시 값으로 자연 치유된다.
- 마이그레이션 파일 없음.

이 한 필드에 한해 "custom = 저장된 개별 값이 진실" 원칙에 예외를 둔다. 근거: 그 필드는 해당 행이 쓰일 당시 **존재하지 않았고**, 진실은 처음부터 env였다. 예외 범위는 "필드 부재"로 한정된다 — 저장된 값이 있으면 언제나 그 값이 진실이다.

### env 스키마 좁히기 (breaking change)

`src/config/env.ts`의 `SUMMARY_LLM_MODEL`을 `z.string()` → `z.enum(SUMMARY_MODELS).default('qwen3.5:4b-mlx')`로 좁힌다 (`SUMMARY_MODELS`는 §1의 잎 모듈에서 import — `job-payload.schema.ts`에서 가져오면 순환).

- 필요조건: 위의 읽기 시점 기본값이 `ProcessingConfig.summary_model: SummaryModel` 타입을 만족하려면 env 값이 목록 안이어야 한다.
- **목록 밖 값을 쓰던 배포는 API 시작이 실패한다.** 의도된 동작이다 — 조용히 목록 안 값으로 강등하면 "선택한 적 없는 모델로 요약"이 되고, 이 프로젝트가 지켜온 조용한 폴백 금지 방침(선행 문서 §6)에 어긋난다.
- 릴리스 체크리스트(§11)에 env 감사 항목을 둔다.
- 워커 env(`summary_llm_model`)는 **좁히지 않는다** — §3 참조.

## 3. job payload v3

### v3 `models` 블록 (process_meeting)

```jsonc
{
  "schema_version": 3,
  // ...meeting_id, audio_key, processing_version, reprocess, identify 불변...
  "models": {
    "whisper_model": "large-v3-turbo",
    "language": "ko",
    "devices": { "diarization": "gpu", "stt": "gpu" },
    "preset": "standard",
    "preset_revision": "2026-08-12.1",
    "summary_model": "qwen3.5:8b-mlx",   // 신규
    "diarization": { "model": "...", "min_speakers": null, "max_speakers": null },
    "embedding": { "model": "...", "dimension": 192 }
  }
}
```

### TS (`src/contracts/job-payload.schema.ts`)

- `ModelsSchemaV3` = `ModelsSchemaV2` 필드 전부 + `summary_model: z.enum(SUMMARY_MODELS)`, `.strict()`.
- `ProcessMeetingPayloadV3Schema` (`schema_version: z.literal(3)`)를 `discriminatedUnion`에 추가. V1/V2 스키마는 보존하고, version 누락 payload를 v1로 귀속시키는 `preprocess`도 그대로 둔다.
- `buildProcessMeetingPayload`는 `ProcessMeetingPayloadV3`를 반환하고 `schema_version: 3`, `models.summary_model: p.summary_model`을 채운다.
- **API가 새로 enqueue하는 것은 v3만.**

### Python (`worker/damwha_worker/contracts.py`)

현재 `ModelsV2`가 wire v2와 내부 정규 표현을 겸한다. **wire 모델과 내부 정규 모델을 분리한다** — 이 분리가 없으면 v3 payload에서 `summary_model`을 생략해도 통과해 워커가 env로 조용히 폴백하고, "v3 payload는 완전 해석된 불변 계약"이 깨진다.

- `ModelsV2` — **wire 전용**으로 격하.
- `ModelsWireV3` — wire v3. **`summary_model: str` 필수** (nullable 아님, default 없음).
- `ModelsConfig` — 내부 정규 표현. `summary_model: str | None = None`.
  - **이름 주의:** `Models`는 쓸 수 없다 — `pipeline/process_meeting.py:24`에 로드된 ML 어댑터 묶음(VAD/Diarizer/Embedder/Transcriber) dataclass가 이미 그 이름을 쓰고 `models/registry.py:14`가 import한다.
  - nullable인 이유는 `preset`/`preset_revision`과 같다: **v1/v2 변환 유래** payload에는 값이 없다. v3 유래는 항상 채워진다.
  - 타입이 `Literal`이 아니라 `str`인 이유: 워커는 API의 큐레이션 목록을 알 필요가 없고, **워커 env 폴백** 값이 목록 밖일 수 있다. 목록 검증은 API 경계의 책임.
  - 여기서 말하는 워커 env는 `worker/damwha_worker/config.py`의 `summary_llm_model`이며, §2에서 enum으로 좁히는 API 쪽 `SUMMARY_LLM_MODEL`(`src/config/env.ts`)과는 **별개의 값**이다. 전자는 자유 문자열로 남는다.
- 변환 함수 3개: `_v1_models_to_internal`(`summary_model=None`), `_v2_models_to_internal`(`summary_model=None`), `_v3_models_to_internal`(값 그대로).
- `ProcessMeetingPayload.models: ModelsConfig` (내부 표현).
- `SUPPORTED_SCHEMA_VERSIONS['process_meeting'] = frozenset({1, 2, 3})`.
- `parse_models()`는 반환 타입만 바뀐다 — `models/registry.py`는 `whisper_model`/`devices`만 읽으므로 무영향.

### `extra="forbid"` — TS `.strict()`와 등가 맞추기

지금 Python wire 모델에는 `ConfigDict`가 없어 알 수 없는 필드를 조용히 무시한다. TS `ModelsSchemaV2`는 `.strict()`라 거절한다. 이 비대칭은 계약 드리프트를 숨긴다(예: v2 payload에 `summary_model`이 섞여 들어와도 Python은 무시).

- `ModelsV2`, `ModelsWireV3`에 `model_config = ConfigDict(extra="forbid")` 적용.
- **`ModelsV1`에는 적용하지 않는다** — TS `ModelsSchemaV1`도 `.strict()`가 아니다(`job-payload.schema.ts:19`). V1까지 막으면 반대 방향 비대칭이 생긴다. 두 스키마의 엄격도를 짝지어 유지하는 것이 규칙이다.

`summarize_meeting` payload는 **v1 그대로**, `model`도 자유 문자열(`z.string().min(1)` / `NonEmptyString`) 유지한다. 이 시점에는 이미 해석이 끝난 구체 값이고, 워커 env 폴백이 목록 밖 문자열일 수 있다.

### fixture

`test/fixtures/job-payloads/`에 v3 추가. v1·v2(및 `schema_version` 누락 v1)는 유지. TS/Python 양측 동시 검증 메커니즘은 현행 그대로.

## 4. 워커 — 요약 job 큐잉

워커는 `persist` 트랜잭션 안에서 `summarize_meeting`을 넣는다(`db.py`). 지금은 모델이 워커 env `summary_llm_model`에서 온다.

`pipeline/process_meeting.py`의 `run_process_meeting`은 이미 `summary_llm_model: str | None` 파라미터를 받는다(`__main__.py`가 settings에서 주입). 해석 한 줄을 추가한다:

```python
summary_model = payload.models.summary_model or summary_llm_model
```

이 값을 `db.persist_...(summary_llm_model=summary_model)`로 넘긴다.

- v3 payload → 사용자가 고른 모델.
- v1/v2 잔존 job → `None` → 워커 env 폴백. 기존 동작 그대로.
- **워커 env `summary_llm_model`은 유지한다** (제거하지 않는다). v1/v2 폴백이자 최후 기본값.

렌즈 큐잉(`lens_llm_model`) 경로는 손대지 않는다.

## 5. 설정 API

`src/settings/resolve-processing.ts`:

- `ProcessingOverrideSchema` += `summary_model: z.enum(SUMMARY_MODELS).optional()`.
- `resolveProcessingConfig()`의 `individual` 판정에 `override.summary_model !== undefined`를 추가 — **요약 모델만 지정해도 결과 preset은 `custom`**. 기존 병합 규칙 3과 일관된다.
- 병합에 `summary_model: override.summary_model ?? cfg.summary_model`.
- gpu 적격성 검사는 그대로. 요약 모델에는 하드웨어 게이트를 두지 않는다(§0 non-goals).

`GET /settings/processing`은 `ProcessingConfig`를 그대로 내보내므로 `summary_model`이 자동으로 resolved 뷰에 포함된다. `PUT`은 §2의 스키마 변경으로 충족된다. 컨트롤러 변경 없음.

업로드 multipart `processing` JSON 문자열 필드와 재처리 JSON body는 스키마만 넓어질 뿐 경로 변경 없음.

## 6. 요약 재생성 API

`POST /meetings/:id/summary/generate` (`meetings.controller.ts:65` → `SummaryService.request`).

### 모듈 의존성 (선행 조건)

`SummaryModule`은 현재 `imports`가 비어 있다. `DatabaseModule`·`JobsModule`은 `@Global()`이라 주입되지만 **`SettingsModule`은 전역이 아니다**. 전역 설정을 읽으려면:

```ts
@Module({
  imports: [SettingsModule],           // 신규
  providers: [SummaryRepository, SummaryService],
  exports: [SummaryService],
})
export class SummaryModule {}
```

`SettingsModule`은 이미 `SettingsService`를 export하므로 그쪽 변경은 없다. `SettingsModule` → `SystemModule` 의존이 이미 있고 `SummaryModule`을 되참조하지 않으므로 순환은 생기지 않는다.

### 요청 body (신규, optional)

```ts
export const SummaryGenerateBodySchema = z.object({
  summary_model: z.enum(SUMMARY_MODELS).optional(),
}).strict();
```

파싱 책임은 **재처리 엔드포인트와 같은 패턴**을 따른다(`meetings.controller.ts:120`): 컨트롤러는 `@Body() body: { summary_model?: unknown }`로 원본을 받고 `@ApiBody({ required: false, ... })`로 문서화만 하며, 서비스가 `safeParse` 후 실패 시 `BadRequestException`으로 변환한다. body 자체가 없어도(`undefined`) 정상 — 전역 설정값을 쓴다.

### 모델 해석

- `loadEnv().SUMMARY_LLM_MODEL` 직접 참조를 **제거**한다(`summary.service.ts:28`).
- 모델 = `body.summary_model ?? 전역 처리 설정의 summary_model`.
- 전역 설정 로드(DB)는 **트랜잭션 진입 전에** 수행한다 — 선행 문서 §5의 순서 원칙 그대로.
- 오버라이드는 **저장하지 않는다**. 해당 요청 한정.
- 해석된 모델은 `meeting_summary.model`에 기록된다(컬럼 기존재).

### active run + 다른 모델 → 409

현재 동작: active run이 있으면 재큐잉 없이 기존 상태를 반환한다(멱등 재시도).

여기에 규칙 하나를 더한다: **해석된 모델이 active run의 `model`과 다르면 `409 Conflict`**. 사유 문구에 진행 중인 모델명을 담는다.

이를 위해 `SummaryRepository.findActive()`가 `model`을 함께 조회해야 한다 — 현재 쿼리는 `SELECT status, job_id`뿐이다(`summary.repository.ts:33`):

```sql
SELECT status, job_id, model FROM meeting_summary
 WHERE meeting_id = $1 AND processing_version = $2
   AND status IN ('queued','running')
```

반환 타입 제네릭도 `{ status: string; job_id: string | null; model: string }`으로 넓힌다.

근거: 큐에 든 job의 payload는 불변 계약이라 모델을 갈아끼울 수 없다. 그렇다고 "14b로 다시 눌렀는데 4b 결과가 나오는" 조용한 무시를 허용하면 이 프로젝트가 일관되게 지켜온 "조용한 폴백 금지"(워커 GPU 폴백 금지, 선행 문서 §6)와 어긋난다. 같은 모델로의 재요청은 종전대로 기존 상태를 반환한다.

## 7. FE (`../fe`, 별도 레포)

- `src/features/settings/api/types.ts` — `ProcessingConfig`에 `summary_model` 추가, `SUMMARY_MODELS` 목록 상수 미러링.
- `src/features/settings/lib/presets.ts` — `PRESET_META`에 프리셋별 요약 모델 표기 추가(카드 요약줄).
- `src/features/settings/ui/processing-settings-form.tsx` — 고급 섹션에 요약 모델 select. 수정 시 `custom` 전환은 기존 로직 재사용.
- `src/features/settings/ui/override-section.tsx` — 동일 select 추가.
- 요약 재생성 UI — 버튼 옆에 모델 select(기본값 = 현재 전역 설정값), 요청 body로 전달. 정확한 컴포넌트 위치는 구현 계획 단계에서 확정한다.
- 409 응답은 "다른 모델로 요약이 진행 중" 안내로 표시한다.

### 목록 미러링과 드리프트

FE는 API 목록을 **손으로 미러링한다**. `WhisperModel`이 이미 그렇게 되어 있다(`fe/src/features/settings/api/types.ts:8`) — 요약 모델만 서버가 목록을 내려주면 두 노브의 취급이 갈린다.

드리프트가 나도 조용하지 않다: FE에만 있는 값을 고르면 PUT이 zod enum 400을 낸다. 반대로 FE에 없는 신규 모델은 선택지에 안 보일 뿐 기존 설정을 깨지 않는다.

- 채택: 상수 미러링 + **릴리스 체크리스트로 양쪽 변경을 한 항목에 묶는다**(§11).
- 보류: `GET /settings/processing` 응답에 허용 목록(`available.whisper_models` / `available.summary_models`)을 실어 드리프트 자체를 없애는 안. 두 노브를 함께 옮겨야 일관되므로 별도 작업으로 분리한다. 되돌리기 쉬운 후속이다.

## 8. 에러/엣지 요약

| 상황 | 처리 |
|---|---|
| 기존 custom 행에 `summary_model` 없음 | 읽기 시점 `env.SUMMARY_LLM_MODEL` 적용 (이전 동작과 동일). 다음 PUT에서 명시 값으로 치유. 마이그레이션 없음 |
| v3 payload에 `summary_model` 누락 | pydantic 필수 필드 위반 → 계약 오류 (env 폴백 없음) |
| v2 payload에 `summary_model` 혼입 | `extra="forbid"` → 거절 (TS `.strict()`와 등가) |
| `SUMMARY_LLM_MODEL` env가 목록 밖 | **API 시작 실패** — 의도된 breaking change (§2, §11) |
| 이름 프리셋 PUT에 `summary_model` 혼입 | 400 (기존 혼합 금지 규칙) |
| override에 `summary_model`만 지정 | 병합 후 `preset: 'custom'` |
| 목록 밖 모델 문자열 | zod enum 400 (API 경계) |
| v1/v2 잔존 job | `summary_model=None` → 워커 env 폴백 |
| active run과 다른 모델로 재생성 요청 | 409 Conflict |
| active run과 같은 모델로 재생성 요청 | 기존 상태 반환 (멱등, 종전과 동일) |
| 선택한 모델이 LLM 서버에 없음 | 요약 job이 LLM 400 → PERMANENT 실패. meeting은 `done` 유지 (기존 분리 원칙) |
| 큰 모델로 메모리 부족 | 워커/LLM 서버 오류로 드러남. API는 사전 차단하지 않음 (§0) |

## 9. 테스트

- **API e2e**: settings GET/PUT `summary_model`(프리셋 resolve, custom 필수 필드, 이름 프리셋 혼입 400, 목록 밖 값 400), **`summary_model` 없는 레거시 custom 행이 env 값으로 읽히고 whisper/devices가 폴백으로 날아가지 않는지**, 그 행에 PUT 후 명시 값이 저장되는지, enqueue 병합(`summary_model` 단독 override → `custom`), v3 payload fixture 검증, 요약 재생성(body 없음 / override 반영 / 목록 밖 값 400 / active run 모델 불일치 409 / 동일 모델 멱등).
- **계약**: v3 fixture 추가, v1·v2·`schema_version` 누락 v1 유지, TS/Python 양측 동시 검증. **네거티브 fixture 2건** — `summary_model` 없는 v3(양측 거절), 알 수 없는 필드가 섞인 v2(양측 거절).
- **워커**: v1→내부·v2→내부 변환 unit(`summary_model is None`), v3→내부 변환 unit(값 보존), v3에서 `summary_model` 누락 시 `ValidationError` unit, payload 값 우선 vs 워커 env 폴백 unit(`run_process_meeting`이 `db.persist_...`에 넘기는 모델 확인).
- **FE**: vitest — 프리셋 카드의 요약 모델 표시, 고급 select 수정 시 custom 전환, 오버라이드 섹션 select, 409 안내.
- **SMOKE** (`worker/SMOKE.md`): 프리셋별 시나리오에 요약 모델 항목 추가. `qwen3.5:8b-mlx`/`14b-mlx` 태그 존재와 로컬 구동은 여기서 수동 확인한다.

## 10. 문서 갱신

- `be/CLAUDE.md` — payload 버전 문단(`process_meeting`은 v1/v2/v3), 처리 설정 문단, 요약 job 문단.
- `be/docs/worker-architecture.md` — payload v3 표기.
- `be/.env.example` — `SUMMARY_LLM_MODEL`이 이제 목록 제한임을 주석으로 명시.
- `worker/SMOKE.md` — §9 참조.

## 11. 릴리스 체크리스트

이 변경은 배포 시 수동 확인이 필요한 항목을 남긴다.

1. **env 감사 (breaking).** 배포된 `SUMMARY_LLM_MODEL` 값이 `SUMMARY_MODELS` 목록 안인지 확인한다. 목록 밖이면 API가 **시작에 실패한다**. 목록 밖 모델을 계속 쓰려면 `job-payload.schema.ts`의 상수에 그 값을 추가하고 FE 미러도 같이 고친다.
2. **레거시 custom 행.** `app_setting`의 `processing_defaults`가 `preset='custom'`이고 `summary_model`이 없다면, 배포 후 첫 GET은 env 값을 보여준다. 의도한 모델인지 확인하고 설정 화면에서 한 번 저장해 명시 값으로 굳힌다.
3. **모델 목록 변경은 두 레포 한 묶음.** `SUMMARY_MODELS`(be)와 FE 미러(`fe/src/features/settings/api/types.ts`)는 같은 릴리스에서 함께 바꾼다(§7).
4. **LLM 서버 준비.** 프리셋에 올린 모델(`qwen3.5:8b-mlx`, `qwen3.5:14b-mlx`)을 로컬 런타임에 미리 받아둔다. 없으면 해당 프리셋의 첫 요약 job이 PERMANENT로 실패한다.
5. **큐 잔존 job.** 배포 시점에 `queued`인 v1/v2 `process_meeting` job은 워커 env 폴백으로 요약된다. 워커 `summary_llm_model`을 그대로 두었는지 확인한다.
