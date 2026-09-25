# 모델 다운로드 관리 — 설정에서 모델 상태를 보고, 미리 받고, 지운다 (구현 스펙)

작성일: 2026-09-25 (같은 날 서브에이전트 리뷰 2건 반영 — §12)
선행: `dev` = `7536228` (PR #34 HF 토큰 UX 병합 뒤). 작업 브랜치 `feat/model-download-management`.
출처: Notion「Electron 전환 이후 개선 사항」P2-D — "설정 화면에서 사용 모델을 미리 다운 받을 수 있도록",
"다운 및 삭제 가능하도록 — whisper나 qwen 모델만 삭제 가능, 고정 모델은 미리 다운받을 수만 있고 삭제는 불가",
"설정에서 내가 지금 어떤 모델을 사용하고 있는지 확인 불가".

## 1. 목표

**설정 화면에서 지금 어떤 모델을 쓰는지, 각 모델을 받았는지와 용량이 얼마인지 한눈에 본다(D1). 그 위에서
쓸 모델을 미리 받고, 안 쓰는 전사·요약 모델은 지운다(D2).**

지금은 모델을 처음 쓰는 순간 worker가 받는다. 그래서 첫 회의 처리가 수 GB를 받느라 수 분씩 멈춘 것처럼
보인다. 설정의 프리셋 카드에는 전사·요약 모델의 **이름만** 보이고, 받았는지·용량·고정 모델은 보이지 않는다.
고급 설정에서 한 항목을 바꿔 `custom`이 되면 실제로 무엇을 쓰는지는 셀렉트를 하나씩 열어 봐야 안다.

## 2. 범위와 단계

하나의 스펙에서 D1과 D2를 함께 설계하되, **구현은 D1 → D2 순서**로 한다. D2는 D1의 구조(명세 표·inventory·
`GET /models`)에 필드와 동작을 **덧붙이기만** 한다.

### 2.1 D1 — 설치·사용 상태 보기 (읽기 전용)

- worker: 받기 명세 표(§4.1), 캐시 스캔과 `app_setting.model_inventory` 쓰기(§4.2).
- contracts: `MODEL_ROLES`·`DELETABLE_ROLES`·`STT_BACKENDS`(§4.3).
- be: `GET /models`(§5.1).
- fe: 설정 › "모델" 카드 — "지금 설정에서 쓰는 모델" 요약 + 모델 목록(§6.1~§6.3).
- 문서: `docs/MODELS.md` 신설(D1 부분), README 링크, 개발 문서(§9).

### 2.2 D2 — 받기·삭제

- job 두 종류 `download_model`·`delete_model`: 마이그레이션 027(type·stage CHECK, 참조 검사 SQL 함수),
  zod·pydantic payload v1(§4.4).
- be: `POST /models/download`·`/models/delete`·`/models/cancel`, 삭제 안전장치(§5.2~§5.4), 오류 code 전달(§5.5).
- worker: 두 handler, 취소, readiness key 제거, 남은 임시 파일 청소(§7).
- fe: 받기·삭제·취소 버튼, 진행·실패 표시, 삭제 확인, 토큰 게이트 경유(§6.4). `ApiError`가 code를 싣게(§5.5).
- 문서: `docs/MODELS.md`의 D2 부분, `docs/HUGGINGFACE.md` §5(§9).

### 2.3 제외

- 카탈로그 밖 캐시(옛 모델·직접 받은 저장소)의 표시·삭제. 합계 용량에는 포함한다.
- 끊긴 다운로드의 바이트 이어받기(huggingface_hub 1.20.1이 지원하지 않음 — `downloads.py` `_needed_bytes` 주석).
- 받기의 병렬 처리·우선순위 조정. job 큐의 FIFO(`live_session` 우선만 유지)를 그대로 쓴다.
- 파일 단위 무결성 검증(해시 대조). complete 판정은 §4.2의 로컬 규칙까지만 한다.
- 모델 **선택** UI의 변경. 모델을 고르는 곳은 계속 처리 설정 폼이다.
- desktop 상태 창의 변경. 필요한 조정은 worker 쪽에서 한다(§7.4).

### 2.4 계획 분할

스펙은 하나, **계획은 둘**이다. D1 계획은 이 스펙 직후에 쓴다. D2 계획은 **D1이 실측(§10.1)을 통과한 뒤에**
쓴다. D1-C4(명세가 실제 로더와 맞는가)의 결과가 D2 받기 handler의 전제이기 때문이다. 실측에서 명세를 고치면
D2 계획은 고친 명세 위에서 쓴다.

## 3. 결정 요약

| # | 질문 | 결정 | 버린 안 |
|---|---|---|---|
| 1 | 설치 여부를 누가 판단하나 | worker가 HF 캐시를 직접 스캔해 새 공유 행 `model_inventory`에 스냅샷을 쓴다. API는 읽기 전용 | `model_readiness` 확장(진행 기록과 설치 목록이 섞이고, 한 번도 적재 안 된 모델은 여전히 모름) / desktop main이 직접 스캔(dev 웹 흐름에 없음, Postgres 원칙 이탈) |
| 2 | 받기·삭제 통로 | 새 job 종류 `download_model`·`delete_model`, `meeting_id` null, FIFO | 별도 요청 행 + worker 부모 스레드(재시도·회수·취소를 새로 만듦) / desktop이 직접 실행 |
| 3 | 삭제 안전장치 | 쓰는 모델은 못 지운다 — 현재 설정·렌즈 모델·queued/running job이 참조하면 API 409 + worker 재검사 | 확인 후 허용 / 검사 없음 |
| 4 | 디스크·진행률 | 모델별 받기 명세를 로더 옆에 한 번 두고, 미리 받기와 실제 적재가 같은 명세를 쓴다. 기존 훅(디스크 점검·진행 보고·무진행 감시) 재사용. 취소 포함 | 실제 적재로 받기(27B는 램 28GB) / 저장소 통째 받기(이중 다운로드) |
| 5 | 모델 목록의 출처 | "무엇이 있나"는 contracts·BE env, "어느 저장소인가"는 worker. worker가 풀이 결과를 inventory에 싣는다. 받기·삭제·참조 검사의 **식별자는 논리 키**(`role·name·backend`)다 | 이름→저장소 표를 contracts에 복제(faster-whisper 표 베끼기 금지 원칙 위반) |

## 4. 데이터와 계약

### 4.1 받기 명세 표 — `be/worker/damwha_worker/models/specs.py` (신설)

```python
@dataclass(frozen=True)
class ModelSpec:
    role: str            # MODEL_ROLES 중 하나
    name: str            # 사용자가 고르는 이름 (전사: "small", 요약·고정: repo id)
    backend: str | None  # 전사만 "mlx" | "faster"
    repo_id: str
    revision: str | None # None = main
    allow_patterns: tuple[str, ...] | None   # None = 저장소 전체 (그 로더가 실제로 그렇게 받을 때만)
    required: tuple[str, ...]  # complete 판정 — snapshot 안에 **전부** 있어야 하는 상대 경로
    approx_bytes: int | None   # 실측한 대략 용량(1000 기준). 안 받은 모델의 "약 X GB" 표시 전용
```

- **줄의 범위**: 모든 `WHISPER_MODELS` × {mlx, faster}, 모든 `SUMMARY_MODELS`, 고정 3개
  (`pyannote/speaker-diarization-community-1`, `speechbrain/spkrec-ecapa-voxceleb`, `BAAI/bge-m3`).
- **이 모듈은 순수하다.** `huggingface_hub`·`faster_whisper`·torch·mlx를 import하지 않는다. worker 부모와
  `worker:sync:test` 가상환경(모델 extra 없음)에서 import된다. `huggingface_hub`는 기본 의존성이 아니라
  models extra에만 있다(`be/worker/pyproject.toml`).
- **전사 mlx**: repo는 지금의 `whisper_mlx._REPO`를 이 표로 옮기고 `MlxWhisper`는 이 표에서 읽는다. 로더는
  `allow_patterns` 없이 받으므로(`whisper_mlx.py:46`) 명세도 None이다. `required`는 `config.json`과 가중치 —
  turbo는 `weights.safetensors`, 나머지 다섯은 `weights.npz`다(구현 시 HF에서 확인해 고정).
- **전사 faster**: repo를 **표에 베끼지 않는다.** `faster_whisper/utils.py`의 `_MODELS` 리터럴을 **소스에서
  읽는다**: `importlib.util.find_spec("faster_whisper").origin`의 디렉터리에서 `utils.py`를 열어 `ast`로
  `_MODELS` 대입을 찾아 `literal_eval`한다. `faster_whisper`를 import하면 `__init__`이 `transcribe`를 통해
  ctranslate2·av·torch를 끌어온다(부모 RSS +248 MB). 하위 모듈을 `find_spec`해도 부모 패키지가 import되므로
  최상위만 찾는다. 읽기에 실패하면 그 크기 이름을 repo로 쓴다(지금 `_repo_id`의 규칙 그대로).
  `allow_patterns`는 faster-whisper `download_model`의 지역 리터럴(`utils.py`)과 같게 둔다 — import할 수 없어
  베낄 수밖에 없으므로, **같은 ast 방식으로 라이브러리 소스를 읽어 대조하는 고정 테스트**를 둔다.
  `required`는 `config.json`·`model.bin`·`tokenizer.json`.
- **요약(mlx_lm)**: `allow_patterns`는 `mlx_lm` 적재가 쓰는 지역 리터럴과 같게 두고, faster와 같은 ast 대조
  테스트를 둔다. `required`는 `config.json`, 토크나이저 파일, 가중치다. 가중치가 여러 shard이면(9B 2개, 27B
  6개) `required`에 인덱스 `model.safetensors.index.json`을 넣고, **인덱스의 `weight_map`에 나오는 shard를
  전부** 요구한다(§4.2).
- **bge-m3**: 고정 리비전(`bge_embed._PINNED_REVISIONS`)을 이 표로 옮기고 `BgeM3TextEmbedder`가 여기서 읽는다.
  `allow_patterns`에 지금 캐시에 있는 파일 11개를 **명시**한다. 저장소 전체를 받으면 `pytorch_model.bin`과
  `onnx/`까지 약 6.8 GB를 받는다(지금 캐시 2.29 GB).
- **pyannote·speechbrain**: 라이브러리가 받는 파일과 같게 둔다. `required`는 화자 분리가
  `segmentation/…`·`embedding/…` 가중치와 `plda/*.npz` 두 개, 화자 식별이 ckpt 3개와 `label_encoder.txt`다.
  하위 모델은 같은 저장소의 하위 폴더에 있어 다른 저장소를 받지 않는다.
- `approx_bytes`는 구현 시 HF `repo_info`의 파일 크기 합(명세의 `allow_patterns`로 거른 것)으로 채운다. 모르면 None.
- **수용 기준**: 명세로 받은 캐시에서 그 모델의 실제 로더가 `load_cache_first`의 캐시 전용 시도로 네트워크 없이
  적재된다. 모델 종류(mlx 전사, faster 전사, 요약, 화자 분리, 화자 식별, 검색 임베딩)마다 실측한다(§10.1 D1-C4).

### 4.2 `app_setting.model_inventory` — worker 부모가 쓰고 API가 읽는다

```json
{
  "scanned_at": "2026-09-25T10:00:00.000000Z",
  "repos": {
    "mlx-community/whisper-large-v3-turbo": { "size_bytes": 1612345678, "complete": true }
  },
  "resolved": [
    { "role": "stt", "name": "small", "backend": "faster", "repo_id": "Systran/faster-whisper-small" }
  ],
  "approx": { "Systran/faster-whisper-small": 484000000 },
  "worker_llm": { "lens_model": "mlx-community/Qwen3.5-4B-8bit", "summary_fallback": "mlx-community/Qwen3.5-4B-8bit" }
}
```

**writer는 worker 부모 하나다.** 부모가 inventory 스레드를 하나 띄운다(`report_host_capabilities`처럼 daemon
스레드, 자기 연결). embed와 `llm_entry`는 inventory를 쓰지 않는다.

**스캔은 `huggingface_hub` 없이 직접 한다**(`models/cache_scan.py`, 순수 모듈). 이유는 셋이다: hub가 기본
의존성이 아니다. `scan_cache_dir`는 `.incomplete`와 어디서도 가리키지 않는 blob을 크기에서 빼고, 끊긴 symlink가
하나라도 있으면 저장소를 통째로 경고로 보내며(→ `partial`이 아니라 `no`), 스캔 도중 폴더가 지워지면 전체가
던진다. 캐시 구조(`models--<org>--<name>/{blobs,snapshots/<rev>/…,refs/<ref>}`)만 안다.

- **`size_bytes`**: 그 저장소 `blobs/` 안 모든 파일의 `st_size` 합(`.incomplete` 포함) — 실제 디스크 사용량이고
  `du`와 맞는다.
- **`complete`**:
  - 명세가 있는 저장소: 명세 리비전의 snapshot(`revision` None이면 `refs/main`이 가리키는 커밋)에서 `required`
    경로가 **전부** 존재하고 symlink가 풀린다. `required`에 `model.safetensors.index.json`이 있으면 그 `weight_map`의
    shard도 전부 풀려야 한다.
  - 명세가 없는 저장소: snapshot이 하나 이상 있고 그 안의 symlink가 모두 풀린다.
  - `.incomplete` 파일은 판정에 쓰지 않는다. 받다 끊긴 저장소는 `required`가 모자라 `partial`로 잡힌다.
    임시 파일 이름이 `<etag>.<uuid8>.incomplete`로 매번 달라, 버려진 것이 남으면 "없음"을 조건으로 쓰는 규칙은
    그 모델을 영원히 `partial`로 만든다.
- 손상된 저장소(끊긴 symlink, refs가 없는 커밋)는 `partial`이다. 개별 저장소를 읽다 난 예외는 그 저장소만
  `partial`로 두고 계속한다.
- **스캔 주기**: `poll_interval_seconds`마다 **캐시 지문**을 계산하고, 지문이 바뀌었거나 마지막 쓰기에서 5분이
  지났으면 다시 스캔해 행 전체를 덮어쓴다. 시작 시 한 번은 무조건 쓴다.
- **캐시 지문**: 캐시 루트, 각 `models--*`와 그 `blobs/`, `snapshots/` **아래 모든 디렉터리**, `refs/` 안의 **파일**의
  mtime 목록. APFS에서 `snapshots/<rev>/sub/`에 symlink가 생겨도 `snapshots/`의 mtime은 바뀌지 않고, `refs/main`을
  덮어써도 `refs/`의 mtime은 바뀌지 않는다 — 그래서 하위 디렉터리 전부와 refs 파일을 본다. 경로가 없으면(고정
  리비전으로 받은 bge-m3에는 `refs/`가 없다) 건너뛴다. 5분 무조건 스캔은 지문이 놓친 경우의 안전망이다.
- **실패**: 캐시 루트가 없으면(첫 실행) 빈 `repos`로 쓰고 `scanned_at`을 찍는다. 그 밖의 예외는 **쓰지 않고**
  다음 주기에 다시 본다 — 한 번의 실패로 모든 모델이 "안 받음"으로 깜빡이지 않게.
- **`resolved`**: 전사 모델 크기 × 백엔드 전부의 repo 풀이. 요약·고정은 이름이 곧 repo라 싣지 않는다.
- **`approx`**: 명세 표의 `approx_bytes` 중 None이 아닌 것.
- **`worker_llm`**: worker 설정의 `lens_llm_model`·`summary_llm_model`. 렌즈 자동 추출과 옛 payload의 요약
  대체값은 **worker env**를 쓴다(`dispatch.py:189-190`, `pipeline/process_meeting.py:202-204`). BE env만 보면
  dev에서 두 `.env`가 갈릴 때 틀린다. packaged 앱은 둘 다 기본값(Qwen 4B)이다.
- `DAMWHA_SHARED_STATE=off`면 쓰지 않는다(`merge_model_readiness`와 같은 규칙).
- API 쪽 파서(`be/src/models/model-inventory.ts`)는 `model-readiness.ts`처럼 **던지지 않는다.** 알아볼 수 없는
  항목은 버린다. 행이 없으면 `scannedAt: null`.

`app_setting`의 공유 행은 이로써 세 개다: `worker_capabilities`(worker), `model_readiness`(worker·embed·
`llm_entry`), `model_inventory`(worker 부모). 셋 다 worker 쪽이 쓰고 API는 읽기만 한다.

### 4.3 `@damwha/contracts` 추가

```ts
export const MODEL_ROLES = ['stt', 'summary', 'diarization', 'speaker_embedding', 'search_embedding'] as const;
export const DELETABLE_ROLES = ['stt', 'summary'] as const;
export const STT_BACKENDS = ['mlx', 'faster'] as const;
```

값 목록만 둔다. 모델 목록 자체는 기존 `WHISPER_MODELS`·`SUMMARY_MODELS`, 고정 모델 이름은 BE env
(`DIARIZATION_MODEL`·`EMBEDDING_MODEL`·`SEARCH_EMBEDDING_MODEL`)다. 전사 백엔드 규칙은 `devices.stt`가 gpu면
mlx, cpu면 faster다(`models/registry.py`와 같은 규칙). 렌즈 추출 모델은 BE env `LENS_LLM_MODEL`(수동 재추출)과
worker env `lens_llm_model`(자동 추출) 두 곳에서 온다. 둘 다 `z.string()`/`str`이라 `SUMMARY_MODELS` 밖일 수
있다. 역할은 `summary`로 친다.

### 4.4 (D2) job 계약

- 마이그레이션 `027_model_jobs.sql`:
  - `job_type_check`에 `download_model`·`delete_model` 추가.
  - `job_stage_check`에 두 handler가 쓰는 stage(`download_model`·`delete_model`) 추가.
  - 참조 검사 SQL 함수 `model_job_refs(...)`(§5.4). API와 worker가 **같은 함수**를 부른다 — 검사 규칙의 사본을
    TS·Python 양쪽에 두지 않는다.
- TS `JobType`, zod(`be/src/contracts/job-payload.schema.ts`), pydantic(`contracts.py`의
  `SUPPORTED_SCHEMA_VERSIONS`·payload 모델)에 v1 추가:

```json
{ "schema_version": 1, "role": "stt", "name": "small", "backend": "faster" }
```

  `backend`는 `role == "stt"`일 때만 필수이고, 그 밖에서는 없어야 한다. worker는 payload를 §4.1 명세로 푼다.
  명세가 없으면(env가 고정 모델·렌즈 모델을 표에 없는 저장소로 바꾼 경우) 받기는 `snapshot_download(repo_id=name)`으로
  하고, 삭제는 역할 검사를 통과한 경우에만 한다.
- `meeting_id`는 null이다. 회수 SQL의 type별 분기 — worker `db/queue.py`와 TS `JobsRepository`의 회수
  (`be/src/jobs/jobs.repository.ts`) — 에 두 type이 걸리는 곳은 없다(리뷰 확인). 일반 job처럼 재queue된다.

## 5. API — `be/src/models/` (신설 모듈)

`SettingsModule`(`SettingsService.getProcessingConfig()` — 프리셋·오버라이드를 푼 값)과 `SystemModule`
(`ModelReadinessService`)을 import한다. 전역 `DemoReadOnlyGuard`가 새 POST에도 걸린다.

### 5.1 `GET /models` (D1)

```ts
{
  scannedAt: string | null,           // null = worker가 아직 한 번도 스캔하지 않음
  totalBytes: number | null,          // inventory repos의 size_bytes 합 (카탈로그 밖 포함)
  pending: boolean,                   // 화면이 계속 새로 읽어야 하는가 (§6.3)
  models: Array<{
    role: ModelRole;
    name: string;
    backend: 'mlx' | 'faster' | null;
    repoId: string | null;            // 풀이 못 하면 null (resolved 없음)
    inUseFor: Array<'stt' | 'summary' | 'lens' | 'fixed'>;   // 빈 배열 = 안 씀
    installed: 'yes' | 'no' | 'partial' | 'unknown';
    sizeBytes: number | null;         // installed yes|partial일 때
    approxBytes: number | null;
    downloading: { bytesDone: number; bytesTotal: number } | null;
    deletable: boolean;               // D1은 표시에만 쓴다
    // (D2) job: { id, type, status, error: { code, message } | null } | null
  }>
}
```

- **`inUseFor`** — 현재 설정은 `getProcessingConfig()`의 값이다.
  - 전사: `whisper_model == name` 이고 백엔드(gpu→mlx, cpu→faster) == `backend` → `'stt'`
  - 요약: `summary_model == name` → `'summary'`; `name`이 BE `LENS_LLM_MODEL` 또는 inventory
    `worker_llm.lens_model`과 같으면 → `'lens'` (둘 다일 수 있다)
  - 고정 역할: 항상 `['fixed']`
- **행의 범위**: 전사는 현재 백엔드의 `WHISPER_MODELS` 6개 + 다른 백엔드 중 inventory에 있는 것. 요약은
  `SUMMARY_MODELS` 전부 + 목록 밖 렌즈 모델(BE·worker 값). 고정 3개.
- **`installed`**: inventory 행이 없거나 `repoId`가 null이면 `unknown`. repo가 `repos`에 없으면 `no`,
  `complete`면 `yes`, 아니면 `partial`.
- **`downloading`**: `model_readiness[repoId]`가 `downloading`이고 멈추지 않았을 때만 채운다. `fromReadinessRow`는
  멈춤을 판정하지 않으므로 BE에 판정 함수를 둔다 — fe `MODEL_STALL_MS`·desktop `STALL_MS`와 **같은 120000**을
  쓰고, 세 사본이 같은 값이라는 것을 주석과 테스트(상수 대조)로 묶는다.
- **`pending`**: 받는 중인 행이 있거나, 카탈로그 repo의 readiness 항목이 `updated_at > scannedAt`인 것이 있으면
  참이다. 두 번째 조건은 "받기는 끝났는데 inventory가 아직 다시 안 쓰였다"는 구간이다 — 없으면 fe 폴링이
  `ready` 순간에 멈추고 행이 "일부만 받음"에 굳는다. (D2에서는 queued/running 모델 job이 있을 때도 참.)
- **`deletable`**: `DELETABLE_ROLES`에 들고 `inUseFor`가 비었을 때. (D2에서는 job 참조도 본다.)
- 이 엔드포인트는 inventory·readiness·설정을 읽기만 한다.

### 5.2 (D2) `POST /models/download` · `POST /models/delete`

본문 `{ role, name, backend? }`. **식별자는 논리 키 `role:name:backend`**다. 풀이가 필요 없어 inventory가 없을
때도 동작하고, 요약·고정은 이름이 곧 repo라 결과가 같다.

- **검증**: `role ∈ MODEL_ROLES`. 전사면 `name ∈ WHISPER_MODELS`이고 `backend ∈ STT_BACKENDS`. 요약이면
  `name ∈ SUMMARY_MODELS ∪ {BE LENS_LLM_MODEL, inventory worker_llm.lens_model}`. 고정 역할이면 `name`이 그 역할의
  env 값과 같아야 한다. 실패하면 400 — 본문에 필드와 허용 값을 적는다(contracts 머리 주석의 `Invalid input`
  사고를 되풀이하지 않는다).
- **delete 추가 검사**(순서대로, 첫 걸림에서 409):
  1. `role ∉ DELETABLE_ROLES` → `model_not_deletable`
  2. `inUseFor` 비어 있지 않음 → `model_in_use_by_settings`
  3. `model_job_refs(...)`가 행을 돌려줌 → `model_in_use_by_job` (§5.4)
  4. 같은 키의 `download_model`이 queued/running → `model_busy`
- **download 추가 검사**: 같은 키의 `delete_model`이 queued/running → 409 `model_busy`.
- **멱등**: 같은 type·같은 키의 job이 이미 queued/running이면 새로 넣지 않고 그 job을 200으로 돌려준다.
  새로 넣으면 201. 응답 `{ job: { id, type, status } }`.
- 검사와 insert는 한 트랜잭션에서, 키 단위 advisory lock
  `pg_advisory_xact_lock(<모델 job 네임스페이스 int>, hashtext(key))`(두 인자 형태 — 마이그레이션 lock과 공간을
  나눈다)을 잡은 뒤 한다.

### 5.3 (D2) `POST /models/cancel`

본문 `{ jobId }`. `download_model` job만 받는다(그 밖은 400).
- `UPDATE job SET status='failed', error=<download_cancelled> WHERE id=$1 AND status='queued'` — 1행이면 끝.
- 0행이면(그 사이 claim됐거나 이미 running) `UPDATE … SET stop_requested_at=now() WHERE id=$1 AND status='running'`.
  끝내는 것은 worker다(§7.2).
- 둘 다 0행 → 409 `job_not_active`.

### 5.4 (D2) job 참조 검사 — SQL 함수 `model_job_refs`

```sql
model_job_refs(p_role text, p_name text, p_backend text,
               p_lens_model text, p_summary_fallback text, p_exclude_job text) RETURNS SETOF text  -- job id
```

queued/running job 중 그 논리 키의 모델을 쓰는 것. **논리 키로 비교**하므로 repo 풀이가 필요 없다.
- `process_meeting`: `schema_version`이 없으면 v1로 본다.
  - 전사: `models.whisper_model = p_name` 그리고 백엔드 = `p_backend`. 백엔드는
    `COALESCE(models->'devices'->>'stt', CASE models->>'device' WHEN 'mps' THEN 'gpu' ELSE 'cpu' END)`를
    gpu→mlx, cpu→faster로 바꾼 값이다. v1의 `mps→gpu`는 pydantic `_v1_models_to_internal`에만 있고 zod에는 없다
    — 그 규칙을 이 함수가 SQL로 한 번 더 갖는다(규칙의 세 번째 자리가 아니라, TS·Python 대신 **유일한** 검사 자리다).
  - 요약: `summary_model`이 null이면(v1·v2) `p_summary_fallback`을 쓴다.
  - 렌즈: `followups.lens`가 참이거나 그 필드가 없는 버전(v1~v4는 항상 참)이면 `p_lens_model`을 쓴다.
- `summarize_meeting`·`extract_lenses`: `model`.
- `live_session`: `process` 안의 `models.whisper_model`·`devices.stt`와 `summary_model`(위와 같은 규칙).
- `p_exclude_job`은 worker가 자기 job을 빼려고 넘긴다.
- 호출: API는 `p_lens_model`에 BE `LENS_LLM_MODEL`과 inventory `worker_llm.lens_model`을 각각 넣어 두 번 부르거나
  (둘이 같으면 한 번), `p_summary_fallback`에 inventory `worker_llm.summary_fallback`을 넣는다. worker는 자기
  설정값을 넣는다.

### 5.5 (D2) 오류 응답과 fe 전달

- 409·400 본문은 `DemoReadOnlyGuard`와 같은 모양 `{ statusCode, code, message }`다.
- fe `shared/api/client.ts`는 지금 `DISK_FULL`에만 `code`를 싣고 나머지는 `new ApiError(status, message)`로 버린다.
  응답에 문자열 `code`가 있으면 **항상** `ApiError`에 싣도록 고친다(기존 DISK_FULL 경로는 그대로).

## 6. 화면 — 설정 › "모델" 카드

코드는 `fe/src/features/models/`(api·lib·ui)에 둔다. 카드는 `ProcessingSettingsForm`과
`HfTokenSettingsSection` 사이에 놓는다.

### 6.1 "지금 설정에서 쓰는 모델" 요약 (카드 맨 위)

```
 모델                                               받은 모델 합계 9.2 GB
 회의를 처리할 때 쓰는 모델이에요. 처음 쓸 때 받고, 받은 뒤에는 이 Mac에 남아요.
 ┌ 지금 설정에서 쓰는 모델 ─────────────────────────────────────────┐
 │ 전사        large-v3-turbo · GPU          받음 · 1.6 GB            │
 │ 요약        qwen3.5 9B                     받는 중 42% · 4.1 / 9.8 GB│
 │ 렌즈 추출   qwen3.5 4B                     받음 · 5.2 GB            │
 │ 기본        화자 분리 · 화자 식별 · 검색 임베딩   모두 받음 · 2.4 GB  │
 └──────────────────────────────────────────────────────────────────┘
```

- 기준은 서버가 풀어 준 **실제 적용 값**이다. 프리셋이 `custom`이어도 실제로 쓰는 모델을 보인다.
- 전사 줄에는 장치(GPU/CPU)를 붙인다. 같은 이름이라도 장치에 따라 받는 파일이 다르다.
- 요약 모델과 렌즈 추출 모델이 같으면 한 줄로 합친다: "요약·렌즈 추출 qwen3.5 4B". 렌즈 모델이 둘(BE·worker
  값이 다름)이면 둘 다 적는다.
- 기본 줄: 셋 다 `yes`면 "모두 받음 · 합계". 아니면 받지 않은 것의 이름과 상태를 풀어 쓴다.
- 안 받은 줄: "안 받음 · 처음 회의를 처리할 때 받아요 (약 3.1 GB)". D2에서는 여기에 "미리 받기" 버튼이 붙는다.
- 제목이 "지금 **설정에서**"인 이유: 이미 줄에 선 회의는 넣을 때의 모델로 처리된다(payload 고정). 설정을 막
  바꾼 직후에는 둘이 다를 수 있다.

### 6.2 모델 목록 (요약 아래)

```
 받아 둔 모델                                          [모든 모델 보기 ▾]
 전사 모델
   large-v3-turbo      [사용 중]                받음 · 1.6 GB
   small · CPU용                                받음 · 480 MB
 요약 모델
   qwen3.5 9B          [사용 중]                받는 중 42% · 4.1 / 9.8 GB
   qwen3.5 4B          [사용 중]                받음 · 5.2 GB
 기본 모델 · 항상 사용
   화자 분리 모델                                받음 · 32 MB
   화자 식별 모델                                받음 · 89 MB
   검색 임베딩 모델                              받음 · 2.3 GB
```

- 기본으로 보이는 행: 사용 중이거나 받았거나(yes/partial) 받는 중인 모델, 그리고 고정 모델. "모든 모델 보기"를
  펼치면 나머지 카탈로그 행이 나온다. 펼침은 컴포넌트 state로만 둔다(저장하지 않음).
- 다른 백엔드로 받아 둔 전사 모델은 이름 뒤에 "· CPU용"/"· GPU용"을 붙인다(처리 설정이 이미 "전사 GPU"라는
  말을 쓴다).
- 제목은 사용자가 이미 화면에서 본 이름만 쓴다: "전사 모델", "요약 모델", "화자 분리 모델", "화자 식별 모델"
  (처리 단계 이름 "화자 식별" — `pages/meeting.tsx`), "검색 임베딩 모델"(`app-shell.tsx`의 검색 안내 문구).
  서비스·라이브러리 이름(worker, embed, pyannote, speechbrain, bge)은 쓰지 않는다.
- 모델 이름표(`large-v3-turbo`, `qwen3.5 9B`)는 `presets.ts`의 라벨 Record에서 파생한다. 그 Record는 지금
  export되지 않으므로 `modelShortLabel(role, name)`을 `presets.ts`에 export한다(라벨의 " — " 앞부분). 목록 밖
  모델(렌즈 env 값 등)은 repo id의 마지막 부분을 쓴다.

### 6.3 상태 문구와 갱신

| `installed` / 상태 | 문구 |
|---|---|
| `downloading` 있음 | "받는 중 42% · 4.1 / 9.8 GB" (`bytesTotal` 0이면 "받는 중") |
| `yes` | "받음 · 1.6 GB" |
| `partial` | "일부만 받음 · 1.1 GB" |
| `no` | "안 받음 · 약 3.1 GB" (`approxBytes` 없으면 "안 받음") |
| `unknown` | "확인 중" |

- `scannedAt`이 null이면 카드 본문 대신: "모델 상태를 아직 확인하지 못했어요. 작업 처리기가 준비되면 보여요."
- 크기는 1000 기준(`disk.py` `format_bytes`와 같은 규칙 — Finder와 맞춘다).
- `useModels()`는 응답의 `pending`이 참일 때 3초 폴링한다. 판정은 서버가 한다 — fe가 멈춤 규칙을 다시 갖지 않는다.
- 처리 설정을 저장하면 `["models"]` 쿼리를 무효화한다 — "사용 중"과 요약이 즉시 옮겨 간다.
- **useEffect+setState 금지**(lint `react-hooks/set-state-in-effect`). 파생 값은 렌더 중에 계산하고, 상태를
  맞춰야 하면 "렌더 중 상태 조정"(prev 값 state) 패턴을 쓴다.
- 색·타이포는 기존 `Card`와 `--text-*` 토큰, "사용 중"은 기존 `Badge`(`badgeVariants`, DESIGN.md 등재)를 쓴다.

### 6.4 (D2) 버튼과 오류

- 행 동작:
  - `no`/`partial` → "받기" (`partial`은 "다시 받기")
  - 받는 중 또는 queued `download_model` → "취소"
  - `yes` + `deletable` → "삭제"
  - `yes` + 삭제 불가 → 버튼 없이 이유만 흐리게: 사용 중이면 "지금 설정에서 쓰고 있어요", 고정이면 없음
- 요약(§6.1)의 안 받은 줄에도 "미리 받기"를 둔다.
- **화자 분리 모델 받기**는 기존 `useDiarizationGate().run()`(`HfTokenGateProvider`)을 거친다. 토큰이 없으면
  다이얼로그를 먼저 띄우고, 토큰을 넣은 뒤 **자동으로 이어서 받지 않는다** — 기존 게이트처럼 사용자가 "받기"를
  다시 누른다.
- **삭제 확인**: "qwen3.5 27B를 지울까요? 27 GB가 비워져요. 다시 쓰려면 다시 받아야 해요." [지우기] [취소]
  (용량은 그 행의 `sizeBytes`)
- 받기는 확인 없이 진행한다.
- 오류 표시 — 행의 마지막 job `error.code`로 고른다(자유 문구로 고르지 않는다):

| code | 문구 |
|---|---|
| `disk_full` | worker 문구 그대로 ("디스크 공간이 부족해요 — 남은 용량 X, 필요한 용량 Y.") |
| `hf_token_invalid` | "허깅페이스 토큰이 유효하지 않아 받지 못했어요. 토큰을 확인해 주세요." |
| `hf_gate_not_accepted` | "모델 사용 조건에 동의해야 받을 수 있어요." + 기존 "사용 조건 페이지 열기" 동작 |
| `model_in_use` | "처리 중인 작업이 쓰고 있어 지우지 않았어요." |
| `download_cancelled` | 표시하지 않는다 |
| 그 밖 | 받기 "받지 못했어요. 인터넷 연결을 확인하고 다시 받아 주세요." / 삭제 "지우지 못했어요." |

  `failure-copy.ts`는 회의 맥락 문구("회의를 처리하지 못했어요 … 재처리해 주세요")라 그대로 쓰지 않는다. 코드
  판정만 공유하고 모델 행 문구는 `features/models`에 둔다.
- API 409는 행 아래 한 줄로 보인다(§5.5로 code가 온다): `model_in_use_by_settings` → "지금 설정에서 쓰고 있어요.
  다른 모델로 바꾼 뒤 지울 수 있어요." / `model_in_use_by_job` → "처리 중인 작업이 쓰고 있어요. 끝난 뒤 지울 수
  있어요." / `model_busy` → "이 모델에 대한 다른 작업이 진행 중이에요."

## 7. (D2) worker handler

### 7.1 `download_model`

1. **시작 시 `stop_requested_at`을 확인한다.** TRANSIENT로 재queue된 job에 이미 찍혀 있을 수 있다 — 찍혀 있으면
   받지 않고 취소로 닫는다(§7.2의 마무리).
2. payload를 명세로 푼다(§4.4).
3. `snapshot_download(repo_id, revision, allow_patterns, token=settings.hf_token)`을 부른다. 설치된 훅이 디스크
   점검(`check_free_space`), 진행 보고(`model_readiness[repo]`), 무진행 감시(90초)를 맡는다.
4. 받는 도중 실제로 디스크가 차면(`OSError` errno `ENOSPC`) PERMANENT `disk_full`로 분류한다. 지금은
   `uncategorized` TRANSIENT로 떨어져 "인터넷 연결" 안내가 붙는다.
5. 재시도는 기존 분류를 따른다(TRANSIENT만, `max_attempts` 기본값).
6. 끝. inventory는 §4.2의 지문 규칙이 알아서 다시 쓴다.

디스크 부족(사전 점검)은 `report_download` **앞에서** 던져지므로 readiness에 실패 항목이 남지 않는다 — 실패
사유의 출처가 readiness가 아니라 job `error`인 이유다(§6.4).

### 7.2 취소

- `_run_watched`는 handler가 아니라 훅(`hooked`)이 부른다. 그래서 취소 술어는 `load_cache_first`의 스레드 로컬
  (`_CACHE_FIRST`)과 같은 방식으로 건다: `downloads.cancel_when(predicate)` 컨텍스트 매니저가 이 스레드의 술어를
  세우고, `_run_watched`의 1초 감시 루프가 그것을 읽는다. `download_model` handler는 이 job의
  `stop_requested_at`을 읽는 술어를 넣는다.
- 술어가 참이면 무진행 감시와 같은 방식으로 호출자를 풀고 스레드를 버린다(`report.abandon()` 포함 — 뒤늦은
  진행이 덮어쓰지 않게). 던지는 예외는 전용 코드 `download_cancelled`이고, **`report_download`가 이것을
  `failed`로 적지 않도록** `_is_benign`과 같은 자리에서 거른다.
- handler는 readiness key를 제거하고(§7.3의 SQL) job을 `failed`(`download_cancelled`, 재시도 없음)로 닫는다.
- **파일 청소는 handler가 하지 않는다.** `snapshot_download`의 다운로드 스레드(최대 8개)는 `--once` 자식이 끝날
  때까지 계속 돌아, handler가 지운 뒤에도 임시 파일과 다 받은 shard가 생긴다. 청소는 §7.5가 자식 종료 뒤에 한다.
  그래서 취소 뒤 저장소는 `partial`일 수 있다 — 이미 받은 shard를 버리지 않는 것은 다음 받기에 이득이다.

### 7.3 `delete_model`

1. 역할이 `DELETABLE_ROLES`인지 다시 확인한다. 아니면 PERMANENT `model_not_deletable`.
2. `model_job_refs(..., p_exclude_job = 자기 id)`로 참조를 다시 검사한다. 걸리면 PERMANENT `model_in_use`,
   지우지 않는다.
3. `HF_HUB_CACHE/models--<org>--<name>` 디렉터리를 지운다.
4. `model_readiness.entries`에서 그 key를 제거한다. `merge_model_readiness`와 같은 한 SQL 문의 원자적 갱신
   (`value #- '{entries,<key>}'`)으로 한다. 남겨 두면 지운 모델이 처리 배너·상태 창에 옛 상태로 남는다.
5. 재시도 없음. 실패는 PERMANENT로 닫는다.

### 7.4 미리 받기 실패와 desktop 상태 창

readiness의 `failed` 항목은 desktop 상태 창에서 "모델을 받지 못했어요"가 되고, PERMANENT면 2층(서비스 다시
시작)을 권한다(`desktop/src/diagnostics/causes.ts` `modelDownloadFailed`, `status-view.ts`). 선택적인 미리 받기의
실패에 서비스 재시작을 권하는 것은 틀린 안내다. 그래서 **`download_model` job이 최종 실패(재시도 없음)로 닫힐
때 handler가 그 repo의 readiness key를 제거한다.** 사유는 job `error`에 있고 설정 화면이 그것을 보인다.
TRANSIENT 재시도 사이에 남는 `failed`는 1층(기다림)이라 둔다. desktop 코드는 고치지 않는다.

받는 동안 회의 화면의 처리 배너가 "모델을 받는 중"을 보이는 것은 사실 그대로라 둔다(그 사이 줄에 선 회의는
실제로 기다린다).

### 7.5 남은 임시 파일 청소

worker 부모가 **시작 시와 `--once` 자식이 끝날 때마다** 캐시 전체의 `*.incomplete` 중 mtime이
`2 × HF_STALL_SECONDS`보다 오래된 것을 지운다. 받는 중인 임시 파일은 계속 쓰여 mtime이 새롭다. 오래된 것은
무진행 감시·취소·강제 종료가 버린 스레드의 잔해다. 이 청소는 inventory와 무관하다(complete 판정은
`.incomplete`를 보지 않는다) — 디스크를 돌려주는 일이다.

## 8. 오류 처리 요약

- inventory 스캔 실패 → 캐시 루트 없음만 빈 `repos`로 기록하고, 나머지는 쓰지 않고 다음 주기에 다시 본다.
- inventory 행이 망가짐 → API 파서가 던지지 않고 `scannedAt: null` 또는 해당 항목 버림 → 화면 "확인 중".
- (D2) 받기 실패 → job `failed` + 코드별 문구(§6.4), readiness key 제거(§7.4). TRANSIENT는 기존 백오프로 재시도된
  뒤 소진될 때만 보인다.
- (D2) worker가 받기 도중 죽음 → 기존 회수(reaper·고아 회수)가 재queue한다. 남은 임시 파일은 §7.5가 치우고,
  저장소는 `partial`로 보이며 다음 받기가 모자란 파일만 받는다.
- (D2) 삭제 도중 실패(권한 등) → PERMANENT. 일부 삭제된 저장소는 `partial`로 보이고 "다시 받기"로 복구한다.

## 9. 문서

- **`docs/MODELS.md` (신설)**: 모델 저장 위치 — 앱은 `~/Library/Application Support/Damwha/models/hub`
  (`desktop/src/config/config.ts`의 `HF_HOME`), dev 웹 흐름은 기본 HF 캐시. 어떤 모델이 있는지(사용자 이름으로),
  설정에서 확인하는 법(D1), 미리 받기·지우기와 못 지우는 경우(D2), 대략 용량 표.
- **`docs/HUGGINGFACE.md` §5** 마지막 줄 "모델 가중치는 첫 회의를 처리할 때 알아서 받는다" → 설정 › 모델에서
  미리 받을 수 있다는 안내를 더한다(D2).
- **`README.md`·`README.ko.md`**: 기존 docs 링크 관례대로 `docs/MODELS.md` 링크 한 줄(D1).
- **루트 `CLAUDE.md`**: "the one other shared row is `app_setting.worker_capabilities`"는 `model_readiness` 때부터
  틀렸다 — 공유 행 세 개와 각 writer로 고친다(D1).
- **`be/CLAUDE.md`**: `models` 모듈, `model_inventory` 읽기 전용 규칙(D1), 새 job type 두 개와 `model_job_refs`(D2).
- **`fe/CLAUDE.md`**: `features/models`(D1), `ApiError.code` 일반화(D2).
- 완료 후 `docs/electron-migration-roadmap.md`와 Notion P2-D를 갱신한다.

## 10. 테스트와 완료 기준

테스트 명령: worker `pnpm worker:test`, be `pnpm be test`, fe `pnpm --filter damwha-fe exec vitest run`.
(`pnpm desktop exec`는 테스트 0개로 exit 0이 나는 거짓 초록불이다 — desktop을 건드리면
`pnpm --filter damwha-desktop exec vitest run`.) worker 단위 테스트는 `worker:sync:test` 가상환경(모델 extra
없음)에서 돈다 — `specs.py`·`cache_scan.py`가 hub 없이 import되는 것 자체가 검사 대상이다.

### 10.1 D1

**단위·통합 테스트**
- worker 명세: 표가 `WHISPER_MODELS`×백엔드·`SUMMARY_MODELS`·고정 3개를 모두 덮는다(pydantic Literal과 대조).
  faster repo 풀이가 라이브러리 소스를 ast로 읽는다(가짜 소스 파일로도 검사). faster·mlx_lm의 `allow_patterns`가
  라이브러리 소스의 지역 리터럴과 같다(라이브러리가 없는 환경에서는 skip이 아니라 **실 가상환경에서 도는 표시된
  테스트**로 둔다). `specs.py` import가 `faster_whisper`·`huggingface_hub`를 `sys.modules`에 올리지 않는다.
- worker 스캔: 가짜 캐시 디렉터리로 — shard 일부만 있음(인덱스 weight_map), `required` 하나 빠짐, 끊긴 symlink,
  refs 없는 커밋, 고정 리비전(`refs/` 없음), 버려진 `.incomplete`가 있어도 `required`가 다 있으면 `yes`,
  `size_bytes`가 blobs 합. 지문: 하위 snapshot 디렉터리에 symlink 추가, refs 파일 덮어쓰기가 지문을 바꾼다.
  지문 불변이면 쓰지 않고, 5분이 지나면 쓴다. 캐시 루트 없음 → 빈 repos, 그 밖 예외 → 쓰지 않음.
  `DAMWHA_SHARED_STATE=off`면 쓰지 않는다. `worker_llm`이 설정값을 싣는다.
- be: inventory 파서가 망가진 jsonb(스칼라·배열·필드 누락)에 던지지 않는다. `GET /models` 조립 — `inUseFor`
  (프리셋·custom·BE 렌즈·worker 렌즈), 다른 백엔드 행, 목록 밖 렌즈 행, `unknown`, 받는 중(멈춤 120초 제외),
  `pending`(받는 중 / readiness가 scannedAt보다 새로움), `deletable`. 멈춤 상수 120000이 fe·desktop과 같다.
- fe: 요약 줄(요약=렌즈 합치기, 렌즈 둘, 기본 줄 접기), 행 문구 5상태, 펼침, `scannedAt` null, `pending`일 때만
  폴링, 설정 저장 시 무효화, `modelShortLabel`.
- **변이 검증**: complete 판정(shard 전부 요구), 지문(하위 디렉터리), `inUseFor`, `pending`을 일부러 깨 보고
  테스트가 빨개지는지 확인한다.

**실측 (dev 또는 packaged)** — D1-C4 전에 `pnpm worker:sync`(models extra — 지금 가상환경에 `mlx_lm`이 없다).
- **D1-C1**: 지금 캐시의 저장소 5개가 "받음 · 크기"로 나오고, 크기가 `du -sk`의 1000 기준 변환과 맞는다. 합계가 맞는다.
- **D1-C2**: 프리셋을 바꾸면 요약과 "사용 중" 배지가 저장 직후 옮겨 간다. 고급 설정에서 전사 장치만 바꾸면
  전사 줄의 백엔드와 받음 여부가 바뀐다.
- **D1-C3**: 안 받은 모델을 쓰는 회의를 처리하면 그 줄이 "받는 중 N%"로 움직이고, 끝나면 폴링이 멈추기 전에
  "받음"이 된다(`pending`의 두 번째 조건).
- **D1-C4**: 모델 종류(mlx 전사, faster 전사, 요약, 화자 분리, 화자 식별, 검색 임베딩)마다 명세의
  `allow_patterns`·리비전으로 받은 캐시에서 실제 로더의 캐시 전용 적재가 네트워크 없이 성공하고, 스캔이 `yes`로
  판정한다. 실패하면 명세를 고치고, D2 계획은 고친 명세 위에서 쓴다.
- **D1-C5**: Finder에서 모델 폴더 하나를 지우면(백업 후) 설정 화면을 다시 열었을 때 "안 받음"이 된다
  (지문 규칙, 늦어도 5분).

### 10.2 D2

**단위·통합 테스트**
- 마이그레이션 027(type·stage CHECK), zod↔pydantic 계약(`contract-fixtures.spec.ts` 방식에 두 type 추가).
- `model_job_refs`(실 DB): process_meeting v1(`device: mps`/`cpu`)·v2~v5, `schema_version` 없음, 요약 null →
  fallback, `followups.lens` 참/거짓/없음, summarize·extract·live_session(전사·요약), `p_exclude_job`.
- be: 400(필드·허용 값 명시), 409 네 종류와 본문 `{statusCode, code, message}`, 멱등 enqueue, advisory lock으로
  동시 요청이 하나만 insert, 목록 밖 렌즈 모델 받기 허용, cancel의 queued/claim 경합/running/끝난 job.
- worker: download handler(명세 풀이, 명세 없는 모델, 시작 시 `stop_requested_at`, ENOSPC → `disk_full`),
  `cancel_when` 술어로 호출자가 풀리고 readiness에 `failed`가 남지 않음, 최종 실패 시 readiness key 제거,
  delete 재검사(자기 제외), readiness key 제거 SQL(실 DB), 역할 거부, §7.5 청소(오래된 것만).
- fe: `ApiError.code` 일반화(기존 DISK_FULL 경로 유지), 버튼 활성 규칙, 오류 코드→문구, 409 문구, 삭제 확인,
  화자 분리 받기의 게이트 경유(토큰 넣은 뒤 자동 진행 없음), 취소.
- 변이 검증: 409 검사, 멱등, 취소 술어, `model_job_refs`의 v1 장치 풀이, readiness key 제거.

**실측** — 파괴적 단계 전에 대상 `models/hub/models--…`를 백업한다. `desktop/out/` 앱이 떠 있으면 빌드 전에 종료를 요청한다.
- **D2-C1**: 안 받은 전사 모델(mlx·faster 각각)을 미리 받기 → 진행률(mlx만 — faster는 라이브러리가 진행을
  보고하지 않는다) → "받음". 그 모델로 회의를 처리해도 새로 받지 않는다 — 판정은 그 저장소 `blobs/`의 파일
  목록·mtime이 처리 전후로 같은 것으로 한다.
- **D2-C2**: 큰 모델 받기 중 취소 → job `failed`(`download_cancelled`), 화면에 오류 없음, 상태 창에 실패 없음,
  자식 종료 뒤 `*.incomplete` 없음. 저장소는 `partial`이거나 없음.
- **D2-C3**: 현재 설정의 모델 삭제는 버튼이 없고, API를 직접 불러도 409다. 렌즈 모델도 같다.
- **D2-C4**: 안 쓰는 모델 삭제 → 디스크가 그만큼 비고(`df`), readiness에서 key가 사라지고, 화면이 "안 받음"이 된다.
- **D2-C5**: 디스크 부족 상황(큰 모델을 여유보다 크게) → 받기 전에 실패하고 "남은 용량 X, 필요한 용량 Y"가 행에
  뜨고, 상태 창에 실패가 남지 않는다.
- **D2-C6**: 토큰이 없을 때 화자 분리 모델 받기 → 토큰 다이얼로그가 먼저 뜬다. 넣은 뒤 "받기"를 다시 누르면
  받기가 진행된다.

## 11. 판정 기록 (ledger)

계획이 스펙과 어긋나면 스펙을 따르고 여기에 적는다. 구현 중 스펙을 고칠 때도 여기에 적는다.

- **2026-09-25 (D1 계획)** §10.1의 "라이브러리가 없는 환경에서는 skip이 아니라 실 가상환경에서 도는 표시된
  테스트": `worker:sync:test` 가상환경에는 mlx_lm이 없어 대조 테스트를 항상 실패로 둘 수 없다. **skip하되
  이유를 `-ra`에 남기고, D1 계획 Task 8에서 `pnpm worker:sync` 가상환경으로 skip 0을 확인**한다 — 대조가 반드시
  한 번은 돈다는 의도를 지킨다.
- **2026-09-25 (D1 최종 리뷰)** 캐시로만 적재해도 `_mark_ready`가 readiness `updated_at`을 새로 찍어, 지문이
  그대로면 inventory가 5분 동안 다시 쓰이지 않고 `pending`이 참으로 남았다. §5.1의 `pending` 규칙은 두고,
  **inventory 루프가 readiness 행의 `updated_at`이 바뀌어도 다시 스캔**하게 했다(§4.2 트리거 추가).
- **2026-09-25 (D1 실측, desktop dev · 앱 데이터 디렉터리)** 전부 통과.
  - D1-C1: 저장소 5개 모두 `yes`, 크기가 `du`와 1000 기준으로 일치, 합계 9.2 GB. 카드 요약 "large-v3-turbo · GPU /
    요약·렌즈 추출 qwen3.5 4B / 기본 모두 받음 · 2.4 GB".
  - D1-C2: "가볍게" 저장 직후 요약이 "small · CPU · 안 받음 · 처음 회의를 처리할 때 받아요 (약 486.2 MB)"로, 배지가
    small로 옮겨 가고 turbo는 "· GPU용" 행으로 남았다. 설정은 원래 값으로 되돌렸다.
  - D1-C3: 회의 재처리 대신(기존 회의 결과를 덮어쓰지 않으려고) worker와 **같은 다운로드 훅**을 설치한 프로세스로
    mlx `small`을 받아 확인했다. 받는 중 "받는 중 0% · 3.9 MB / 481.3 MB", 끝난 뒤 "받음 · 481.3 MB", `pending`
    false. 자동화 브라우저 탭이 `hidden`이라 TanStack Query가 주기 재조회를 멈춰(라이브러리 기본값) 보이는 창에서의
    3초 갱신은 직접 보지 못했다 — 단위 테스트가 덮는다.
  - D1-C4: mlx 전사(turbo)·faster 전사(tiny, 명세로 새로 받음)·요약(4B)·화자 분리·화자 식별·검색 임베딩 6종이
    `HF_HUB_OFFLINE=1`에서 실제 로더로 적재됐고, 스캔이 모두 `complete=True`. `pnpm worker:sync` 뒤
    `test_model_specs.py` 10 passed, skip 0. **D2 받기 handler의 전제(명세로 받으면 로더가 다시 받지 않는다)가 섰다.**
  - D1-C5: faster tiny 폴더를 옮기자 약 1초 만에 API에서 사라졌고, 설정을 다시 열자 목록에서 빠졌다(합계 9.8 → 9.7 GB).
- **2026-09-25 (D1 계획 Task 8)** 계획은 실측 결과를 `docs/electron-migration-roadmap.md`에도 적으라고 했지만, 그
  문서는 Phase 단위만 기록하고 P2 항목(A·B·C)은 Notion이 관리해 왔다 — 로드맵은 고치지 않고 이 절과 Notion에 적는다.
- **2026-09-25 (D2 계획)** §6.4의 디스크 부족 코드는 `disk_full`이 아니라 worker 상수 `errors.DISK_FULL` =
  `"DISK_FULL"`이다 — 계획과 구현은 실제 값을 쓴다.
- **2026-09-25 (D2 계획)** §6.4의 "approx_bytes가 남은 용량보다 크면 경고"에 쓸 남은 용량이 API에 없었다.
  inventory(§4.2)에 `free_bytes`(worker가 캐시 볼륨을 `disk.free_bytes`로 잰 값)를 더하고 `GET /models`가
  `freeBytes`로 싣는다.
- **2026-09-25 (D2 계획)** §5.4 `model_job_refs`는 렌즈 모델을 `p_lens_models text[]` 하나로 받는다(BE·worker 값을
  함께 넘긴다 — 판정은 같고 호출이 한 번).

## 12. 리뷰 반영 (2026-09-25, 서브에이전트 2건 — 주요 주장은 코드로 재확인)

| 지적 | 반영 |
|---|---|
| complete가 "가중치 하나 이상"이면 shard 일부만 받아도 `yes` (9B 2개, 27B 6개) | `required` 전부 + 인덱스 `weight_map` shard 전부(§4.1·§4.2) |
| `.incomplete` 이름이 `<etag>.<uuid8>.incomplete`라 버려진 것이 영원히 `partial`을 만든다 | 판정에서 `.incomplete`를 빼고, 청소는 §7.5 |
| `faster_whisper` import가 부모에 ctranslate2·torch를 올리고, hub는 기본 의존성이 아니다 | `_MODELS`를 소스에서 ast로 읽음, 스캔을 hub 없이 직접 구현(§4.1·§4.2) |
| 지문이 하위 snapshot 디렉터리 symlink·refs 덮어쓰기를 놓친다(APFS 실측) | 하위 디렉터리 전부 + refs 파일 + 5분 무조건 스캔(§4.2) |
| `scan_cache_dir`가 크기에서 임시 파일을 빼고, 손상 저장소를 `no`로, 도중 삭제에 던진다 | 직접 스캔, 손상은 `partial`, 루트 없음만 빈 repos(§4.2·§8) |
| mlx 전사는 `allow_patterns` 없음·가중치 이름이 둘, bge-m3는 리비전만으로는 6.8 GB | 명세에 반영(§4.1) |
| faster·mlx_lm 패턴은 지역 리터럴이라 베껴야 한다 | ast 대조 고정 테스트(§4.1·§10.1) |
| 취소 술어를 handler가 넘길 경로가 없다 / 취소가 readiness에 `failed`를 남긴다 / 버린 스레드가 청소 뒤에도 파일을 만든다 / 재queue된 job에 이미 취소가 찍혀 있을 수 있다 | `cancel_when` 스레드 로컬, benign 처리, 청소는 자식 종료 뒤, 시작 시 확인(§7.1·§7.2·§7.5), D2-C2 기대치 수정 |
| `job_stage_check`도 넓혀야 한다 / TS 회수 코드도 확인 대상 | §4.4 |
| zod에는 v1 정규화가 없어 "기존 규칙 재사용"이 불가능하고, TS·Python 어느 쪽이든 사본이 된다 | SQL 함수 `model_job_refs` 하나를 양쪽이 부른다(§5.4) |
| repo 키는 inventory 없이는 풀리지 않는다 | 논리 키 `role:name:backend`(§5.2·§5.4) |
| fe `ApiError`가 DISK_FULL 외의 code를 버린다 | §5.5 |
| 렌즈 모델이 BE env와 worker env 두 곳에서 오고, `SUMMARY_MODELS` 밖일 수 있다 | inventory `worker_llm`, 검증 허용 목록 확장(§4.2·§4.3·§5.1·§5.2) |
| 참조 검사에 live_session 요약, `followups.lens`, v1/v2 요약 null이 빠졌다 | §5.4 |
| 받기가 끝나면 폴링이 inventory 갱신 전에 멈춘다 | `pending`(§5.1·§6.3) |
| 게이트 API가 `useDiarizationGate().run()`이고 토큰 입력 뒤 자동 진행이 없다 / `failure-copy.ts`는 회의 문구 | §6.4, D2-C6 수정 |
| "화자 인식"·"의미 검색"은 기존 화면 용어가 아니다 | "화자 식별 모델"·"검색 임베딩 모델"(§6.1·§6.2) |
| 미리 받기 실패가 desktop 상태 창에 "다시 시작"을 띄운다 | 최종 실패 시 readiness key 제거(§7.4) |
| 라벨 Record가 export되지 않는다 | `modelShortLabel` export(§6.2) |
| BE에 120초 멈춤 판정의 세 번째 사본이 생긴다 | 상수 대조 테스트로 묶음(§5.1) |
| cancel의 queued 경합, advisory lock 키 공간 | §5.3·§5.2 |
| 받는 도중 ENOSPC가 TRANSIENT "인터넷 연결"로 안내된다 | §7.1 |
| faster 경로는 진행 보고가 없어 D2-C1의 "새 downloading 0건"이 무의미하다 | blobs 목록·mtime으로 판정(§10.2) |
| 목업 수치가 GiB였다 | 1000 기준으로 고침(§6) |
| 가상환경에 `mlx_lm`이 없다 | D1-C4 전 `pnpm worker:sync`(§10.1) |
