# Damwha 워커 — 모델 빌드 실패 처리 설계

> 상태: 확정 (설계 합의 완료) · 작성일: 2026-06-28 · 대상: Python 워커 `model build` 단계 예외를 job 처리 경로로 편입
> 선행: Plan 2 (Python ML 워커, 완료), Phase 2 (검색, 완료)
> 전체 스펙: `2026-06-23-damwha-ml-worker-design.md`

---

## 0. 이 문서의 범위

Python 워커가 job을 claim한 뒤 **실제 모델을 빌드하는 단계**(`build_models` / `build_text_embedder`)에서 발생하는 예외가, 현재는 job 처리 경로(`handle_job`의 `try/except`) **바깥**에서 터져 **워커 프로세스 전체를 죽인다.** 그 결과 job이 `running` 상태에 갇히고, API 측 reaper(`REAPER_STALE_MINUTES=30`)가 떠 있어야만, 그것도 최대 30분 뒤에야 구제된다.

이 설계는 모델 빌드를 `handle_job`의 guarded 경로 안으로 옮겨, 빌드 실패도 기존 `classify → requeue/fail` 정책을 그대로 타게 한다.

### 재현된 실제 사례 (2026-06-28)

`sentence-transformers` 미설치 상태에서 `index_meeting` job 처리 중 `build_text_embedder()`가 `ModuleNotFoundError`를 던짐 → 워커 루프가 통째로 크래시. job은 `running`(attempts=1)에 잔류. `process_meeting`은 이미 정상 커밋된 뒤였음. 설계 의도("index_meeting 실패는 job만 마킹, meeting은 done 유지")가 지켜지지 못한 지점.

**범위에 포함:**
- `handle_job` / `run_once` / `main()`에서 모델 빌드를 guarded `try` 안으로 이동 (빌더 콜백 주입)
- `classify()`에 import류 예외 분기 추가 (`ModuleNotFoundError`/`ImportError` → PERMANENT)
- 빌드 실패 경로의 결정적 테스트 (fake 모델, heavy import 없음)

**범위 밖 (비목표):**
- **API reaper 로직** — 크래시 경로 구제 장치는 유지. 본 수정은 정상 경로에서 빌드 실패를 즉시 분류해 reaper 의존을 없애는 것이지 reaper를 바꾸지 않는다.
- **빌드 외 파이프라인 단계** (normalize/VAD/diarization/STT/align/persist) — 이미 `handle_job` 안에서 보호됨.
- **모델 다운로드 재시도 백오프** — `job`에 `next_attempt_at`이 없다는 기존 제약(즉시 requeue, 타임드 백오프 없음)은 그대로 둔다.
- **src/ (NestJS API)** — 본 수정은 워커(`worker/`) 단독. TS 측 무변경.
- **`enroll_speaker`의 기능적 빌드 버그 수정** — enroll payload는 `models` 키가 없는데 `registry.build_models`는 `payload["models"]`를 요구한다 → 실 워커(`main`) 경로에서 enroll은 빌드 단계 `KeyError`로 깨진다(기존 latent 버그, 지금까지 `run_enroll_speaker` 직접 호출 유닛테스트로만 검증됨). **본 수정의 효과로 이 `KeyError`는 워커를 죽이지 않고 graceful하게 job fail로 떨어지지만(크래시-안전성 확보), enroll이 실제로 동작하게 만드는 전용 빌더 추가는 별도 기능 변경이라 backlog로 분리한다**(`docs/backlog.md`). 본 작업은 enroll의 *graceful-fail*까지만 책임진다.

---

## 1. 근본 원인

`worker/damwha_worker/__main__.py`의 `main()` 루프(현재):

```python
if job["type"] == "index_meeting":
    text_embedder = build_text_embedder(settings)        # ← try/except 밖, heartbeat 밖
    with Heartbeat(*hb_args):
        outcome = handle_job(conn, job, storage, worker_id, text_embedder=text_embedder)
else:
    models = build_models(job["payload"], settings)      # ← try/except 밖, heartbeat 밖
    with Heartbeat(*hb_args):
        outcome = handle_job(conn, job, storage, worker_id, models=models, search_embedding=...)
```

- 빌드 호출이 `handle_job`의 `try/except`(예외를 `classify`해 requeue/fail로 라우팅하는 유일한 지점) **밖**에 있다 → 빌드 예외는 분류되지 못하고 `main()` 밖으로 전파되어 프로세스를 종료시킨다.
- 빌드가 heartbeat 범위 **밖**이기도 하다 → BGE-M3 같은 대형 모델의 첫 다운로드(수 분)가 길어지면 그 사이 heartbeat가 돌지 않아 stale 위험도 있다(부차적 결함).

## 2. 핵심 변경: 빌더 콜백을 guarded 경로 안에서 호출

이미 테스트·heartbeat로 보호된 `handle_job`이 빌드까지 책임지게 한다. **이미 만들어진 모델**이 아니라 **빌더 콜백**을 주입받아, `parse_payload` 직후 `try` 안에서 호출한다.

### 2.1 `handle_job` 시그니처 (`__main__.py`)

변경 전:
```python
def handle_job(conn, job, storage, worker_id, *, models=None, text_embedder=None, search_embedding=None) -> str:
```
변경 후:
```python
def handle_job(conn, job, storage, worker_id, *, build_models=None, build_text_embedder=None, search_embedding=None) -> str:
```

`try` 블록 안, `payload = parse_payload(...)` 다음:
- `process_meeting`: `models = build_models()` 호출 후 `run_process_meeting(...)`
- `enroll_speaker`: `models = build_models()` 호출 후 `run_enroll_speaker(conn, job, payload, models.embedder, ...)`
- `index_meeting`: `text_embedder = build_text_embedder()` 호출 후 `run_index_meeting(...)`

**`except` 블록(타입별 requeue/fail 라우팅)은 변경 없음.** 빌드 콜백이 던진 예외는 그대로 이 블록으로 떨어져, 해당 job 타입의 정책대로 처리된다:
- `process_meeting` 빌드 실패: TRANSIENT+attempts 남음 → requeue / 아니면 `fail_process_meeting`(job `failed` + meeting `failed`)
- `index_meeting` 빌드 실패: TRANSIENT+attempts 남음 → requeue / 아니면 `fail_job`(job만 `failed`, meeting `done` 유지)
- `enroll_speaker` 빌드 실패: TRANSIENT+attempts 남음 → requeue / 아니면 `fail_enroll`(job `failed` + speaker `failed`)

> enroll 주의: enroll은 `build_models(payload)`가 `payload["models"]`를 요구하므로 실제로는 위 라우팅에 도달하기 전 `KeyError`(uncategorized → TRANSIENT)로 떨어진다 → 본 수정으로 워커 크래시 대신 graceful-fail(requeue 후 attempts 소진 시 `fail_enroll`). enroll을 정상 동작시키는 전용 빌더는 backlog(§0 비목표).

### 2.2 `run_once` (`__main__.py`)

빌더를 그대로 전달하도록 미러링 (positional `storage`는 현행 유지, keyword-only 인자만 `models`/`text_embedder` → `build_models`/`build_text_embedder`로 교체):
```python
def run_once(conn, worker_id, storage, *, build_models=None, build_text_embedder=None, search_embedding=None) -> str | None:
    job = db.claim(conn, worker_id)
    if job is None:
        return None
    return handle_job(conn, job, storage, worker_id,
                      build_models=build_models, build_text_embedder=build_text_embedder,
                      search_embedding=search_embedding)
```

### 2.3 `main()` (`__main__.py`)

registry import는 지금처럼 `main()` 내부에 둬 heavy import를 테스트 스위트에서 격리한다(CLAUDE.md 불변식). if/else 분기를 합치고, 빌더를 람다로 감싸 `with Heartbeat(...)` **안에서** handle_job에 전달한다. 타입별로 해당 람다만 실제 호출되므로 불필요한 빌드는 일어나지 않는다.

```python
from .heartbeat import Heartbeat
from .models.registry import build_models as _build_models, build_text_embedder as _build_text_embedder

with Heartbeat(*hb_args):
    outcome = handle_job(
        conn, job, storage, settings.worker_id,
        build_models=lambda: _build_models(job["payload"], settings),
        build_text_embedder=lambda: _build_text_embedder(settings),
        search_embedding=(settings.search_embedding_model, settings.search_embedding_dim),
    )
```

부수효과(의도된 개선): 빌드가 heartbeat 범위 안으로 들어와, 긴 모델 다운로드 중에도 `locked_at`이 갱신되어 stale 오판을 막는다.

## 3. 에러 분류 (`classify()`, `errors.py`)

Option A 확정 — import류는 즉시 실패, 그 외는 재시도.

`classify()`에 분기 추가 (기존 `UnsupportedPayloadVersion`/`MemoryError` 분기 사이/근처):
```python
if isinstance(exc, (ModuleNotFoundError, ImportError)):
    return WorkerError(MODEL_LOAD_FAILED, str(exc), ErrorKind.PERMANENT)
```

- `MODEL_LOAD_FAILED = "model_load_failed"` 상수는 현재 production `classify()`에서 미사용(정의만 존재) → 이 분기에서 실사용. 코드 문자열은 "model_load_failed", kind는 PERMANENT.
- errors.py의 `# Transient codes` 주석은 `model_load_failed`가 원인에 따라 kind가 갈릴 수 있음을 반영해 보정한다(코드 자체는 kind-중립).
- **그 외 빌드 오류**(예: HF 다운로드 네트워크 오류 `OSError`/HTTP 예외 등)는 기존 fall-through(`uncategorized` → TRANSIENT)로 떨어져 attempts 남으면 재시도. 별도 코드/분기 불필요.

근거: `ModuleNotFoundError`/`ImportError`는 의존성 미설치·환경 구성 오류로, 같은 환경에서 재시도해도 자명히 실패한다(`max_attempts=3`만큼 낭비). 즉시 fail로 운영자에게 1회에 노출하는 편이 정확하고 깔끔하다. 네트워크성 다운로드 실패는 재시도가 유효하므로 TRANSIENT 유지.

## 4. 테스트 (`tests/test_worker_loop.py`, TDD)

전부 fake 모델 + 실 Postgres(testcontainers). 빌더는 **콜백**이므로 "빌드가 실패하는 상황"을 heavy import 없이 그대로 재현할 수 있다(이번 수정의 핵심 효용).

**기존 호출부 갱신(시그니처 변경 반영):**
- `run_once(conn, "w1", _models(), Storage(...))` → 빌더 전달 형태로. `_models`는 무인자로 `Models`를 반환하므로 `build_models=_models` 로 그대로 넘긴다.
- `handle_job(..., models=boom)` → `build_models=lambda: boom`.

**신규 케이스:**
1. `test_index_meeting_build_failure_marks_job_only`
   - `index_meeting` job claim 후 `build_text_embedder=lambda: (_ for _ in ()).throw(ModuleNotFoundError("no sentence_transformers"))`
   - 기대: 반환 `"failed"`, job `failed`, **meeting `done` 유지**. (PERMANENT → 즉시 fail, job만)
2. `test_process_meeting_build_failure_fails_meeting`
   - `process_meeting` job claim 후 `build_models`가 `ImportError`
   - 기대: 반환 `"failed"`, job `failed`, **meeting `failed`**.
3. `test_build_transient_error_requeues_when_attempts_left`
   - `build_models`가 비-import TRANSIENT 오류(`WorkerError(io_error, ..., TRANSIENT)` 또는 uncategorized 예외) + attempts 남음
   - 기대: 반환 `"requeued"`, job `queued`.
4. `test_enroll_build_failure_fails_speaker`
   - `enroll_speaker` job claim 후 `build_models=lambda: (_ for _ in ()).throw(ModuleNotFoundError(...))`
   - 기대: 반환 `"failed"`, job `failed`, **speaker `failed`**. (enroll 브랜치의 크래시-안전성 라우팅 고정. enroll 정상동작 자체는 backlog.)

기존 `test_transient_error_requeues_when_attempts_left` / `test_permanent_error_fails`(파이프라인 단계 오류 경로)는 시그니처만 맞춰 유지 — 빌드 경로와 별개로 그대로 커버.

## 5. 변경 파일 (3개)

1. `worker/damwha_worker/__main__.py` — `handle_job`/`run_once`/`main()`: 빌더 콜백 도입, 빌드를 guarded·heartbeat 범위로 이동
2. `worker/damwha_worker/errors.py` — `classify()`에 import류 → PERMANENT 분기, 주석 보정
3. `worker/tests/test_worker_loop.py` — 호출부 갱신 + 빌드 실패 신규 케이스 3종

## 6. 검증 게이트

- `cd worker && uv run pytest -q` — 워커 전체 스위트 통과 (Docker 필요: testcontainers)
- `cd worker && uv run ruff check . && uv run ruff format --check .`
- src/(TS) 무변경 → npm 빌드/테스트 불필요
