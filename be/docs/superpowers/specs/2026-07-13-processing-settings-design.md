# Damwha — 처리 설정(모델/디바이스 선택) 설계

> 상태: 확정 (설계 합의 완료) · 작성일: 2026-07-13 · 대상: `src/` (NestJS API) + `worker/` (Python ML 워커) + `../fe` (웹 FE)
> 배경: 오픈소스 공개 대비. ARM Mac 사용자가 자기 머신 스펙에 맞춰 Whisper 모델과 파이프라인 단계별 CPU/GPU를 선택할 수 있게 한다.

---

## 0. 이 문서의 범위

사용자별 맥북 스펙(칩/RAM)에 따라 **전역 처리 기본값 + job별 오버라이드**를 제공한다.

- 전역 기본값: DB `app_setting` 테이블 + 설정 API + FE 설정 화면. 스펙 자동 감지 + 추천 프리셋(수정 가능).
- job별 오버라이드: 업로드/재처리 요청의 optional `processing` 블록. 저장하지 않음 — 해당 job 한정.
- 선택 범위: **Whisper 모델 크기 + 단계별(diarization/STT) 디바이스**. VAD/ECAPA/bge-m3는 고정.
- job payload 스키마 v2 (`schema_version: 2`) + v1 하위호환.

**설계 원칙 — 설정은 유저 의도, payload는 실행 계약.** 전역 설정은 발전 가능(프리셋 정의 개선 시 자동 반영)하지만, 이미 enqueue된 job의 payload는 불변·완전 해석된 구체 값이다. 기존 재현성 불변식("모델 선택은 payload 책임", `worker/damwha_worker/models/registry.py`) 유지.

**범위 밖 (non-goals):**

- cuda / 비 ARM Mac 지원. Phase 1은 Apple Silicon macOS 전용.
- VAD 디바이스 노브 — silero는 CPU 고정 (현 구현이 디바이스를 받지 않음, 모델이 작아 GPU 이득 미미). 스키마/UI 미노출.
- 임베딩 모델(ECAPA, bge-m3) 교체 — pgvector 차원 고정과 얽힘, 별도 설계.
- 모델 사전 다운로드 API — 새 모델 첫 job에서 HF lazy 다운로드, 문서화로 수용.
- GPU 미가용 시 CPU 자동 폴백 — 재현성 위반이라 금지 (§6).

---

## 1. 데이터 모델 — `app_setting` (마이그레이션 `007_app_setting.sql`)

```sql
CREATE TABLE app_setting (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

단일 행 `key = 'processing_defaults'`. value는 두 형태 중 하나:

```jsonc
// 이름 있는 프리셋 — 프리셋 이름만 의도로 저장. 개별 값은 저장하지 않는다.
{ "preset": "standard", "language": "ko" }

// custom — 개별 값이 진실.
{
  "preset": "custom",
  "language": "ko",
  "whisper_model": "large-v3",
  "devices": { "diarization": "gpu", "stt": "gpu" }
}
```

**프리셋 진실원 규칙:**

- `preset !== "custom"`: DB에는 프리셋 이름만. GET/enqueue 시 서버 상수에서 **항상 resolve** — 이후 릴리스에서 프리셋 정의를 개선하면 기존 사용자가 자동 혜택.
- `preset === "custom"`: 저장된 개별 값을 그대로 사용.
- `language`는 프리셋과 독립 — 항상 저장.

**행 없음/손상 폴백:** 행이 없거나 jsonb가 zod 검증에 실패하면 env 기반 기본값(`WHISPER_MODEL` 등, 현행 유지)으로 동작 + 경고 로그. 이 폴백은 **GET과 enqueue 양쪽에 동일하게** 적용 (동일한 `loadProcessingSettings()` 한 함수를 공유).

## 2. 프리셋 정의 — API 코드 상수 (`src/settings/presets.ts`)

워커는 프리셋 개념을 모른다. payload에는 resolved 값만 간다. 진실 공급원은 API 한 곳.

| preset | whisper_model | diarization | stt | 대상 |
|---|---|---|---|---|
| `light` | `small` | gpu | cpu | 8GB RAM |
| `standard` | `large-v3-turbo` | gpu | gpu | 16–32GB |
| `quality` | `large-v3` | gpu | gpu | 64GB+ |

- `PRESET_REVISION: number` 상수 — 프리셋 정의를 바꿀 때마다 증가. payload에 기록되어(§4) "이 job이 어느 정의로 실행됐나" 표시/디버그용. 실행 재현성은 payload의 구체 값이 이미 보장하므로 revision은 참조 정보일 뿐.
- VAD는 모든 프리셋에서 CPU 고정(스키마 미노출).

## 3. 설정 API + 스펙 감지

### `GET /settings/processing` / `PUT /settings/processing` (`src/settings/`)

기존 도메인 패턴(repository/service/controller) 그대로.

- **GET** — resolved 뷰 반환: `{ preset, language, whisper_model, devices, preset_revision }`. 이름 프리셋이면 상수에서 resolve한 값 포함(FE 표시용).
- **PUT** — 두 형태만 허용 (zod discriminated union):
  - `{ preset: "light"|"standard"|"quality", language }` — 개별 노브 필드가 오면 **400** (이름 프리셋 + 오버라이드 혼합 금지; 개별 수정 = custom).
  - `{ preset: "custom", language, whisper_model, devices }` — 전 필드 필수.
  - `language`: 빈 문자열 거부(trim 후 min 1).
  - `gpu_eligible`(§3.2)이 false인 머신에서 gpu 디바이스 포함 PUT → **400** (조용한 폴백 금지 원칙의 API 측 방어).

### `GET /system/capabilities` (`src/system/`)

```jsonc
{
  "platform": "darwin",
  "arch": "arm64",
  "chip": "Apple M2 Pro",     // sysctl machdep.cpu.brand_string (darwin만)
  "memory_gb": 32,             // os.totalmem()
  "gpu_eligible": true,        // darwin && arm64 — 하드웨어 적합성만 주장
  "recommended_preset": "standard"
}
```

- **`gpu_eligible`이지 `gpu_available`이 아니다** — 워커가 실제 MLX/MPS를 쓸 수 있는지(optional deps 설치 여부, Rosetta 등)는 API가 알 수 없다. Phase 1은 하드웨어 적합성만 보고. 워커 capability 실측 보고는 범위 밖.
- 추천 규칙: RAM < 16GB → `light`, < 48GB → `standard`, 이상 → `quality`. `!gpu_eligible`이면 `recommended_preset: null` — 모든 프리셋이 diarization gpu를 포함하므로 추천 불가; Phase 1은 이런 환경을 지원하지 않으며 FE가 미지원 경고를 표시한다 (custom 전-CPU 구성은 가능하나 권장하지 않음).
- `sysctl`은 shell이 아닌 `execFile` + timeout(1s)으로 호출, 실패 시 `chip: null`. 프로세스 시작 후 최초 요청 시 1회 감지·캐시.
- 서버가 추천을 자동 적용하지 않음 — 적용은 항상 사용자 PUT.

## 4. job payload 스키마 v2

### v2 `models` 블록 (process_meeting)

```jsonc
{
  "schema_version": 2,
  // ...meeting_id, audio_key, processing_version, reprocess, identify 불변...
  "models": {
    "whisper_model": "large-v3-turbo",   // tiny|base|small|medium|large-v3|large-v3-turbo
    "language": "ko",
    "devices": { "diarization": "gpu", "stt": "gpu" },   // cpu|gpu
    "preset": "standard",                // 참조 정보 (custom 포함)
    "preset_revision": 1,                // 참조 정보
    "diarization": { "model": "...", "min_speakers": null, "max_speakers": null },
    "embedding": { "model": "...", "dimension": 192 }
  }
}
```

- 최상위 `device: mps|cpu|cuda` 제거 → 단계별 `devices.{diarization,stt}: cpu|gpu`. `gpu` = Apple Metal/MPS.
- `preset`/`preset_revision`은 표시/디버그용 참조 정보 — 워커 실행은 구체 값만 사용.
- enroll/index payload 불변 (임베딩 고정이라 선택 노브 없음, v1 유지).

### v1/v2 명시적 parser 분리 (단순 enum 교체로 불가 — v1은 `models.device` 필수)

- **TS** (`src/contracts/job-payload.schema.ts`): `schema_version` 기준 discriminated union. v1 스키마(현행 `device: mps|cpu|cuda`) 보존 + v2 스키마 신설. **API가 새로 enqueue하는 것은 v2만.**
- **Python** (`worker/damwha_worker/contracts.py`): v1/v2 pydantic 모델 분리. **v1은 파싱 즉시 내부 v2 표현으로 변환** — 파이프라인/registry는 v2 표현만 다룬다.
  - v1 `device: "mps"` → `devices: {diarization: gpu, stt: gpu}`
  - v1 `device: "cpu"` → 전 단계 cpu
  - v1 `device: "cuda"` → **전 단계 cpu 변환 + 경고 로그** (cuda→gpu는 Metal 의미와 달라 오변환; ARM Mac 전용 서비스라 cuda job은 실존하지 않으나 계약상 방어)
  - v1엔 `preset` 없음 → `preset: null`.
- fixture: `test/fixtures/job-payloads/`에 v2 추가, v1 유지. 양쪽 동시 검증 메커니즘 현행 그대로.

## 5. enqueue — 설정 로드 + 오버라이드 병합

### payload builder 순수화

`buildProcessMeetingPayload`가 env를 직접 읽는 현 구조(`src/contracts/job-payload.schema.ts:44`)를 바꾼다: **resolved 처리 설정을 인자로 받는 순수 함수**로. 설정 조회(DB)는 호출부(`meetings.service.ts`)가 **트랜잭션 진입 전에** 수행.

### 병합 규칙 — 단일 함수 `resolveProcessingConfig(global, override?)`

1. 전역 설정 로드(§1 폴백 포함) → 프리셋이면 상수 resolve → 완전한 config.
2. override에 `preset`(이름) 있으면: 그 프리셋 resolve가 **통째로 대체**.
3. override에 개별 필드(`whisper_model`, `devices.*`, `language`) 있으면: 그 위에 얕은 병합(devices는 필드 단위). 이때 결과 `preset`은 `"custom"`.
4. 결과에 gpu가 있는데 `!gpu_eligible` → 400 (PUT과 동일 방어).
5. 결과를 payload에 고정.

- override는 **저장하지 않음** — 해당 job 한정.
- **업로드는 multipart** (`POST /meetings`, `meetings.controller.ts`): nested JSON body 불가 → `processing`을 **multipart의 JSON 문자열 필드**로 받고 서버에서 `JSON.parse` + zod 검증. 재처리(`POST /meetings/:id/reprocess`)는 JSON body라 그대로 nested 객체.

## 6. 워커 변경

### 디바이스/백엔드 (`registry.py`, `config.py`)

- `config.py`에서 `whisper_backend`, `device` 제거 — 둘 다 payload 파생으로 이동. (enroll의 ECAPA는 CPU 강제라 `settings.device` 의존 제거 무해 — `build_embedder` 시그니처에서 device 소스만 정리.)
- STT: `devices.stt == "gpu"` → `MlxWhisper`, `"cpu"` → `FasterWhisper(device="cpu", compute_type="int8")`. 백엔드 선택이 워커 로컬 설정에서 payload로 이동 — 재현성 강화.
- diarization: `devices.diarization` → pyannote에 `mps`/`cpu` 전달.
- `gpu` → torch 계열 `mps` 번역은 한 곳(`models/device.py`).
- VAD: 변경 없음(CPU 고정). ECAPA: 변경 없음(CPU 강제 유지).

### 폴백 금지 — 명확한 영구 오류

payload가 gpu인데 실제 실행 환경이 불가(MLX import 실패, `torch.backends.mps.is_available()` false 등)이면 **PERMANENT 설정 오류로 fail** (`errors.ErrorKind.PERMANENT`). CPU로 조용히 폴백하지 않는다 — payload와 실제 실행이 달라지면 재현성이 깨지고, 느려진 원인도 숨는다. API 측 방어(§3, §5)가 정상 경로에서 이 상황을 막고, 워커 오류는 최후 방어선.

### Whisper 모델 확장 — 한 변경 단위로 묶음

enum만 늘리면 런타임 오류(`whisper_mlx.py`의 `_REPO` 맵이 2개만 매핑). 다음을 하나의 단위로:

1. zod/pydantic enum 확장: `tiny|base|small|medium|large-v3|large-v3-turbo`
2. `whisper_mlx.py` `_REPO` 맵에 mlx-community repo 추가 (tiny/base/small/medium)
3. faster-whisper는 크기 이름 네이티브 지원 — CPU 경로 다운로드/메모리 확인
4. `scripts/download_models.py` + `SMOKE.md` 갱신 (프리셋별 스모크 시나리오)

## 7. FE (`../fe`, 별도 레포)

### 설정 화면 (신규 라우트 `/app/settings/processing`)

- 상단 카드: `GET /system/capabilities` — 칩/RAM 표시 + 추천 프리셋 배지.
- 프리셋 라디오 3개 (light/standard/quality), 추천에 "권장" 표시, 각 카드에 whisper 모델·디바이스 요약.
- "고급" 펼침: whisper 모델 select + diarization/stt cpu/gpu 토글. 아무 값이나 수정하면 preset이 `custom`으로 전환.
- `gpu_eligible: false`면 gpu 토글 비활성 + 사유 툴팁 + 미지원 환경 경고 배너(`recommended_preset: null`).
- 저장 = `PUT /settings/processing`, TanStack Query mutation + invalidate.
- 큰 모델 첫 선택 시 "첫 처리에서 모델 다운로드로 오래 걸릴 수 있음" 안내 문구 (§0 lazy 다운로드 수용).

### job 오버라이드 UI

업로드 dialog + 재처리 확인 dialog에 "이번 작업만 다른 설정" 접힌 섹션 — 기본 접힘, 열면 현재 전역 설정이 기본값으로 보이는 프리셋 선택 + 고급. 업로드는 multipart JSON 문자열 필드로 전송(§5).

## 8. 에러/엣지 요약

| 상황 | 처리 |
|---|---|
| settings 행 없음/jsonb 손상 | env 기본값 폴백 + 경고 (GET·enqueue 동일) |
| 이름 프리셋 PUT에 개별 노브 혼합 | 400 |
| `!gpu_eligible` 머신에서 gpu 저장/enqueue | 400 |
| 워커에서 MLX/MPS 실제 미가용 | PERMANENT fail (폴백 금지) |
| 큐 잔존 v1 job | v1 parser → 내부 v2 변환, 정상 처리 |
| v1 `cuda` payload | cpu 변환 + 경고 로그 |
| 새 모델 첫 job HF 다운로드 지연 | 수용 + FE 안내 + 문서화 |

## 9. 테스트

- **API e2e**: settings CRUD(프리셋 resolve, custom, 혼합 400, gpu 400, 폴백), capabilities(os/execFile mock, 캐시), enqueue 병합(전역만/preset override/개별 override/multipart 문자열 파싱), v2 payload fixture 검증.
- **계약**: v2 fixture 추가 + v1 유지, TS/Python 양측 동시 검증(기존 메커니즘).
- **워커**: v1→v2 변환 unit(mps/cpu/cuda 각각), device 번역 unit, STT 백엔드 선택 unit(fake), gpu 미가용 PERMANENT 오류 unit. 실모델은 SMOKE.md 프리셋별 시나리오(로컬 전용, CI 밖).
- **FE**: 설정 화면 vitest — 추천 배지, custom 전환, gpu_eligible=false 비활성, 오버라이드 섹션 기본 접힘.
