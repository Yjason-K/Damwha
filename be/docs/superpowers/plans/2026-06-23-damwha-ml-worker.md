# Damwha Python ML 워커 (Plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Postgres `job` 테이블 계약을 소비하는 Python ML 워커를 구축한다 — `process_meeting`(ffmpeg→VAD→diarization→임베딩→화자식별→STT→정렬→persist)과 `enroll_speaker`(임베딩 추출→voiceprint 저장) 파이프라인, ownership 가드 기반 상태전이, 폴 루프. 결정적 glue는 fake 모델 + 실제 Postgres로 CI에서 완전히 테스트되고, 실제 ML 모델은 그 뒤에 인터페이스로 끼워진다.

**Architecture:** 단일 프로세스 순차 1-job 폴 루프. ML은 4개 프로토콜(VAD/Diarizer/Embedder/Transcriber)로 추상화되어 오케스트레이션이 fake로 결정적 테스트된다. 모든 공유 상태 쓰기는 두 종류의 ownership 가드(job: `locked_by`+`status='running'` / meeting: `processing_version`+`current_job_id`)를 통과한다 — at-least-once 큐에서 좀비/재claim/reprocess 경합을 막는다. ORM 없이 psycopg3 raw SQL.

**Tech Stack:** Python 3.12, uv(패키지/venv), ruff(lint/format), pytest + testcontainers-python(`pgvector/pgvector:pg16`), pydantic v2 + pydantic-settings, psycopg 3(raw SQL, pgvector). 실모델: silero-vad, pyannote.audio 3.1(gated), speechbrain ECAPA, mlx-whisper(Apple)/faster-whisper(CUDA·CPU). 시스템: ffmpeg/ffprobe.

설계 근거: `docs/superpowers/specs/2026-06-23-damwha-ml-worker-design.md`. 전체 스펙: `docs/superpowers/specs/2026-06-22-damwha-ingestion-backend-design.md`.

## Global Constraints

설계 스펙의 전역 요구. 모든 태스크에 암묵 적용된다.

- **로컬 전용** — 외부 네트워크/클라우드 호출 금지(모델은 사전 다운로드 캐시에서 로드).
- **모델 선택의 진실원은 payload** — `payload.models`(whisper_model·device·diarization·embedding)·`payload.identify.threshold`를 쓴다. env는 인프라(경로/토큰/poll·heartbeat 간격)만 제공.
- **Ownership 가드 (모든 워커 쓰기에 필수)**:
  - **Job 가드**: `WHERE id=:job_id AND locked_by=:worker_id AND status='running'`. 영향 row=0 → ownership 상실 → 로컬 결과 폐기·중단.
  - **Meeting 가드**: `WHERE id=:meeting_id AND processing_version=:payload_pv AND current_job_id=:job_id`. 영향 row=0 → reprocess가 추월 → stale 폐기.
- **중간 meeting 쓰기 금지** — `normalized_key`/`duration_ms`는 가드된 persist TX 안에서만 기록. `normalized.wav` 재사용 판단은 디스크 존재 여부로.
- **stale 폐기 job 표기** — `job.status='done'` + `job.error={code:'discarded_by_stale_guard',...}`, meeting 무변경 (enum에 `discarded` 추가 안 함).
- **vector 차원 192 고정.** 식별/voiceprint 비교는 `model`+`dimension` 일치 AND speaker `enrollment_status='ready'`만.
- **부분 실패** — STT 실패 청크 구간 utterance는 `status='transcribe_failed'`+`transcript_error`, 무음은 `status='silence'`. 파이프라인 중단 없음. 상태는 `status` 컬럼으로만 판별(confidence 의미 의존 금지).
- **재시도 = 즉시 requeue**(timed backoff 없음). `attempts`는 claim 시 증가(Plan 1). PERMANENT 오류는 즉시 fail.
- **워커는 자체 reaper 없음** — stale lock 회수·크래시 전파는 Nest reaper(Plan 1) 책임.
- **enum 값 (전체 스펙 §3.2, Plan 1 CHECK)**: `job.stage ∈ {vad,diarize,identify,stt,align,persist,extract_embedding,enroll_persist}`; `utterance.status ∈ {ok,silence,transcribe_failed}`; `meeting.status ∈ {uploaded,processing,done,failed}`; `speaker.enrollment_status ∈ {pending,ready,failed}`.
- **스키마 진실원은 Plan 1 마이그레이션** — `be/src/database/migrations/*.sql`. 워커는 스키마를 복제하지 않고 테스트에서 이 파일들을 실행한다.

---

## File Structure

> 모든 경로는 리포 루트 `/Users/jason/projects/Damwha/be`(현재 워크스페이스) 기준. Python 명령은 `worker/`에서 `uv run …`로 실행한다.

```
be/                                       ← Plan 1 (NestJS). Task 0만 수정.
  src/contracts/job-payload.schema.ts       Task 0: schema_version 추가
  test/job-payload.spec.ts                  Task 0: 갱신
  test/contract-fixtures.spec.ts            Task 0: 공유 픽스처 zod 검증
  test/fixtures/job-payloads/*.json         Task 0: 공유 계약 픽스처 (zod↔pydantic)
  worker/                                  ← Plan 2 (Python)
    pyproject.toml                          uv 프로젝트 + 의존성 + ruff/pytest 설정
    .python-version                         3.12
    .env.example
    damwha_worker/
      __init__.py
      config.py                             Settings (pydantic-settings)
      errors.py                             ErrorKind, WorkerError, classify
      storage.py                            Storage: 키→경로 (TS resolve 미러)
      contracts.py                          pydantic payload + schema_version
      db.py                                 raw SQL: claim/guards/persist/discard
      heartbeat.py                          데몬 스레드 (자체 DB 커넥션)
      models/
        __init__.py
        base.py                             VAD/Diarizer/Embedder/Transcriber 프로토콜 + IO 타입
        registry.py                         payload.models+device → 실구현 조립 (Task 14)
        silero_vad.py  pyannote_diar.py  ecapa_embed.py            (Task 14)
        whisper_mlx.py  whisper_faster.py                          (Task 14)
      pipeline/
        __init__.py
        ffmpeg.py                           normalize + probe (injectable runner)
        identify.py                         centroid + 코사인 식별
        align.py                            word→segment 중점 귀속 + 병합
        process_meeting.py                  오케스트레이션 + persist
        enroll_speaker.py                   임베딩 추출 + enroll_persist
      __main__.py                           폴 루프 진입점
    scripts/download_models.py              모델 사전 다운로드 (Task 14)
    tests/
      conftest.py                           testcontainers + Plan 1 마이그레이션 + 시드 유틸
      fakes.py                              Fake{VAD,Diarizer,Embedder,Transcriber}
      test_*.py
```

각 파일은 단일 책임. pipeline/*는 모델 프로토콜에만 의존(실구현 모름). db.py만 SQL을 안다.

---

## Task 0: schema_version 계약 추가 (Plan 1 / TS 선행)

워커가 strict 검증으로 배포되기 전에 zod 빌더가 `schema_version`을 방출해야 한다. 양쪽 모두 "없으면 1" 기본값으로 롤아웃 의존을 제거한다.

**Files:**
- Modify: `src/contracts/job-payload.schema.ts`
- Modify: `test/job-payload.spec.ts`
- Create: `test/fixtures/job-payloads/process_meeting.valid.json`, `test/fixtures/job-payloads/enroll_speaker.valid.json`, `test/fixtures/job-payloads/process_meeting.no_version.json`
- Create: `test/contract-fixtures.spec.ts`

**Interfaces:**
- Produces: zod `ProcessMeetingPayloadSchema`/`EnrollSpeakerPayloadSchema` with `schema_version: z.literal(1).default(1)`; builders stamp `schema_version: 1`.
- Produces: shared JSON fixtures consumed by both `test/contract-fixtures.spec.ts` (zod) and `worker/tests/test_contracts.py` (pydantic, Task 2).

- [ ] **Step 1: Write failing tests for schema_version**

`test/job-payload.spec.ts`에 케이스 추가(기존 describe 안):
```ts
  it('stamps schema_version=1 on process_meeting payload', () => {
    const p = buildProcessMeetingPayload({
      meetingId: '11111111-1111-1111-1111-111111111111',
      audioKey: 'meetings/x/original.wav',
      processingVersion: 2,
      reprocess: true,
    });
    expect(p.schema_version).toBe(1);
    expect(() => ProcessMeetingPayloadSchema.parse(p)).not.toThrow();
  });

  it('defaults missing schema_version to 1', () => {
    const raw = {
      meeting_id: '11111111-1111-1111-1111-111111111111',
      audio_key: 'meetings/x/original.wav',
      processing_version: 0, reprocess: false,
      models: {
        whisper_model: 'large-v3-turbo', device: 'mps', language: 'ko',
        diarization: { model: 'd', min_speakers: null, max_speakers: null },
        embedding: { model: 'e', dimension: 192 },
      },
      identify: { threshold: 0.7 },
    };
    expect(ProcessMeetingPayloadSchema.parse(raw).schema_version).toBe(1);
  });

  it('stamps schema_version=1 on enroll_speaker payload', () => {
    const p = buildEnrollSpeakerPayload({
      speakerId: '22222222-2222-2222-2222-222222222222',
      audioKey: 'speakers/y/sample.wav',
    });
    expect(p.schema_version).toBe(1);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest test/job-payload.spec.ts`
Expected: FAIL — `p.schema_version` is `undefined`.

- [ ] **Step 3: Add schema_version to zod schemas + builders**

`src/contracts/job-payload.schema.ts` — 두 스키마 객체 첫 필드로 추가, 빌더 반환에 스탬프:
```ts
export const ProcessMeetingPayloadSchema = z.object({
  schema_version: z.literal(1).default(1),
  meeting_id: z.string().uuid(),
  audio_key: z.string().min(1),
  processing_version: z.number().int().nonnegative(),
  reprocess: z.boolean(),
  models: ModelsSchema,
  identify: z.object({ threshold: z.number() }),
});

export const EnrollSpeakerPayloadSchema = z.object({
  schema_version: z.literal(1).default(1),
  speaker_id: z.string().uuid(),
  audio_key: z.string().min(1),
  embedding: z.object({ model: z.string(), dimension: z.number().int() }),
});
```
`buildProcessMeetingPayload` 반환 객체에 `schema_version: 1,`를 첫 필드로, `buildEnrollSpeakerPayload`에도 `schema_version: 1,` 추가.

- [ ] **Step 4: Create shared fixtures**

`test/fixtures/job-payloads/process_meeting.valid.json`:
```json
{
  "schema_version": 1,
  "meeting_id": "11111111-1111-1111-1111-111111111111",
  "audio_key": "meetings/11111111-1111-1111-1111-111111111111/original.m4a",
  "processing_version": 2,
  "reprocess": true,
  "models": {
    "whisper_model": "large-v3-turbo",
    "device": "mps",
    "language": "ko",
    "diarization": { "model": "pyannote/speaker-diarization-3.1", "min_speakers": null, "max_speakers": null },
    "embedding": { "model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192 }
  },
  "identify": { "threshold": 0.7 }
}
```
`test/fixtures/job-payloads/enroll_speaker.valid.json`:
```json
{
  "schema_version": 1,
  "speaker_id": "22222222-2222-2222-2222-222222222222",
  "audio_key": "speakers/22222222-2222-2222-2222-222222222222/sample.wav",
  "embedding": { "model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192 }
}
```
`test/fixtures/job-payloads/process_meeting.no_version.json` — `process_meeting.valid.json`을 복사하되 `"schema_version": 1,` 줄을 **삭제**(없으면-1 기본값 검증용).

- [ ] **Step 5: Write the shared-fixture zod test**

`test/contract-fixtures.spec.ts`:
```ts
import * as fs from 'fs';
import * as path from 'path';
import {
  ProcessMeetingPayloadSchema,
  EnrollSpeakerPayloadSchema,
} from '../src/contracts/job-payload.schema';

const dir = path.join(__dirname, 'fixtures', 'job-payloads');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

describe('contract fixtures (shared with pydantic worker)', () => {
  it('validates process_meeting.valid.json', () => {
    expect(() => ProcessMeetingPayloadSchema.parse(read('process_meeting.valid.json'))).not.toThrow();
  });
  it('validates enroll_speaker.valid.json', () => {
    expect(() => EnrollSpeakerPayloadSchema.parse(read('enroll_speaker.valid.json'))).not.toThrow();
  });
  it('accepts process_meeting.no_version.json (defaults to 1)', () => {
    expect(ProcessMeetingPayloadSchema.parse(read('process_meeting.no_version.json')).schema_version).toBe(1);
  });
});
```

- [ ] **Step 6: Run to verify all pass**

Run: `npx jest test/job-payload.spec.ts test/contract-fixtures.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/contracts/job-payload.schema.ts test/job-payload.spec.ts test/contract-fixtures.spec.ts test/fixtures/job-payloads
git commit -m "feat(contract): add schema_version (default 1) + shared payload fixtures"
```

---

## Task 1: 워커 스캐폴드 + config + 테스트 하네스

**Files:**
- Create: `worker/pyproject.toml`, `worker/.python-version`, `worker/.env.example`
- Create: `worker/damwha_worker/__init__.py`, `worker/damwha_worker/config.py`
- Create: `worker/tests/conftest.py`
- Test: `worker/tests/test_config.py`

**Interfaces:**
- Produces: `Settings` (pydantic-settings) with `database_url:str`, `storage_root:str`, `worker_id:str`, `hf_token:str|None`, `whisper_backend:str`, `device:str`, `poll_interval_seconds:float`, `heartbeat_interval_seconds:float`, `stt_chunk_minutes:float`, `model_cache_dir:str|None`. `load_settings()->Settings`.
- Produces (test): `conftest.py` fixtures `pg_url` (session, testcontainers + Plan 1 migrations), `conn` (function, psycopg `dict_row` connection + truncate between tests), and seed helpers `seed_meeting(conn, **kw)`, `seed_job(conn, **kw)`, `seed_speaker(conn, **kw)`, `seed_voiceprint(conn, **kw)`.

- [ ] **Step 1: Write pyproject + python-version + env example**

`worker/pyproject.toml`:
```toml
[project]
name = "damwha-worker"
version = "0.1.0"
requires-python = ">=3.12,<3.13"
dependencies = [
    "pydantic>=2.6",
    "pydantic-settings>=2.2",
    "psycopg[binary]>=3.1",
]

[dependency-groups]
dev = [
    "pytest>=8.0",
    "testcontainers[postgres]>=4.0",
    "ruff>=0.4",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-ra"

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]
```
> 실모델 의존(silero/pyannote/speechbrain/whisper)은 Task 14에서 추가한다 — 그 전 태스크는 무겁고 gated인 패키지 없이 설치/테스트된다.

`worker/.python-version`:
```
3.12
```
`worker/.env.example`:
```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/damwha
STORAGE_ROOT=../storage
WORKER_ID=worker-1
HF_TOKEN=
WHISPER_BACKEND=mlx
DEVICE=mps
POLL_INTERVAL_SECONDS=2
HEARTBEAT_INTERVAL_SECONDS=30
STT_CHUNK_MINUTES=25
MODEL_CACHE_DIR=
```

- [ ] **Step 2: Write config.py**

`worker/damwha_worker/__init__.py`: 빈 파일.

`worker/damwha_worker/config.py`:
```python
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # model_cache_dir가 pydantic 보호 네임스페이스(model_)와 겹쳐 경고가 나므로 끈다.
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", protected_namespaces=())

    database_url: str
    storage_root: str = "../storage"
    worker_id: str = "worker-1"
    hf_token: str | None = None
    whisper_backend: str = "mlx"
    device: str = "mps"
    poll_interval_seconds: float = 2.0
    heartbeat_interval_seconds: float = 30.0
    stt_chunk_minutes: float = 25.0
    model_cache_dir: str | None = None


def load_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
```

- [ ] **Step 3: Write conftest (testcontainers + Plan 1 migrations + seeds)**

`worker/tests/conftest.py`:
```python
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from testcontainers.postgres import PostgresContainer

# worker/tests/conftest.py → parents[2] == be/ (리포 루트)
MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "src" / "database" / "migrations"


def _run_migrations(url: str) -> None:
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    assert files, f"no migrations found in {MIGRATIONS_DIR}"
    with psycopg.connect(url, autocommit=True) as c:
        for f in files:
            c.execute(f.read_text())


@pytest.fixture(scope="session")
def pg_url():
    with PostgresContainer("pgvector/pgvector:pg16") as pg:
        url = pg.get_connection_url().replace("postgresql+psycopg2", "postgresql")
        _run_migrations(url)
        yield url


@pytest.fixture
def conn(pg_url):
    c = psycopg.connect(pg_url, row_factory=dict_row, autocommit=True)
    try:
        yield c
    finally:
        c.execute(
            "TRUNCATE job, utterance, meeting_cluster, voiceprint, meeting, speaker "
            "RESTART IDENTITY CASCADE"
        )
        c.close()


def seed_meeting(conn, *, status="uploaded", processing_version=0, audio_key="k", current_job_id=None):
    row = conn.execute(
        "INSERT INTO meeting(audio_key, status, processing_version, current_job_id) "
        "VALUES (%s,%s,%s,%s) RETURNING id",
        (audio_key, status, processing_version, current_job_id),
    ).fetchone()
    return row["id"]


def seed_job(conn, *, type="process_meeting", meeting_id=None, payload=None, status="queued",
             locked_by=None, attempts=0, max_attempts=3, locked_minutes_ago=None):
    locked_at = None if locked_minutes_ago is None else f"now() - interval '{locked_minutes_ago} minutes'"
    sql = (
        "INSERT INTO job(type, meeting_id, payload, status, locked_by, attempts, max_attempts, locked_at) "
        f"VALUES (%s,%s,%s,%s,%s,%s,%s,{locked_at or 'NULL'}) RETURNING id"
    )
    row = conn.execute(sql, (type, meeting_id, Jsonb(payload or {}), status, locked_by, attempts, max_attempts)).fetchone()
    return row["id"]


def seed_speaker(conn, *, name="t", enrollment_status="ready", current_job_id=None):
    row = conn.execute(
        "INSERT INTO speaker(name, enrollment_status, current_job_id) VALUES (%s,%s,%s) RETURNING id",
        (name, enrollment_status, current_job_id),
    ).fetchone()
    return row["id"]


def seed_voiceprint(conn, *, speaker_id, embedding, model="speechbrain/spkrec-ecapa-voxceleb", dimension=192):
    vec = "[" + ",".join(str(x) for x in embedding) + "]"
    conn.execute(
        "INSERT INTO voiceprint(speaker_id, embedding, model, dimension) VALUES (%s,%s::vector,%s,%s)",
        (speaker_id, vec, model, dimension),
    )
```

- [ ] **Step 4: Write the config test**

`worker/tests/test_config.py`:
```python
from damwha_worker.config import load_settings


def test_loads_settings_from_env(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@localhost:5432/db")
    monkeypatch.setenv("DEVICE", "cpu")
    s = load_settings()
    assert s.database_url.endswith("/db")
    assert s.device == "cpu"
    assert s.poll_interval_seconds == 2.0  # default
```

- [ ] **Step 5: Install + run**

Run: `cd worker && uv sync && uv run pytest tests/test_config.py -v`
Expected: PASS (1 test). `uv sync` resolves deps; testcontainers not exercised yet.

- [ ] **Step 6: Smoke the DB harness**

임시 확인용 `worker/tests/test_harness.py`:
```python
from tests.conftest import seed_meeting, seed_job


def test_migrations_and_seed(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    row = conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()
    assert row["status"] == "queued"
```
Run: `uv run pytest tests/test_harness.py -v`
Expected: PASS (pgvector 이미지 최초 pull). 확인 후 이 파일은 다음 커밋 전에 삭제한다.

- [ ] **Step 7: Commit**

```bash
rm worker/tests/test_harness.py
git add worker/pyproject.toml worker/.python-version worker/.env.example worker/uv.lock \
        worker/damwha_worker/__init__.py worker/damwha_worker/config.py \
        worker/tests/conftest.py worker/tests/test_config.py
git commit -m "feat(worker): scaffold (uv, config, testcontainers harness w/ Plan 1 migrations)"
```

---

## Task 2: contracts.py (pydantic) + 공유 계약 테스트

**Files:**
- Create: `worker/damwha_worker/contracts.py`
- Test: `worker/tests/test_contracts.py`

**Interfaces:**
- Consumes: shared fixtures `be/test/fixtures/job-payloads/*.json` (Task 0).
- Produces: `ProcessMeetingPayload`, `EnrollSpeakerPayload` (pydantic `BaseModel`), nested `Models`/`Diarization`/`Embedding`/`Identify`. `SUPPORTED_SCHEMA_VERSIONS = frozenset({1})`. `parse_payload(job_type:str, data:dict) -> ProcessMeetingPayload | EnrollSpeakerPayload` — raises `UnsupportedPayloadVersion` (subclass of `ValueError`) for versions outside SUPPORTED.

- [ ] **Step 1: Write the failing test**

`worker/tests/test_contracts.py`:
```python
import json
from pathlib import Path

import pytest

from damwha_worker.contracts import (
    ProcessMeetingPayload,
    UnsupportedPayloadVersion,
    parse_payload,
)

FIX = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "job-payloads"


def load(name):
    return json.loads((FIX / name).read_text())


def test_parses_process_meeting_fixture():
    p = parse_payload("process_meeting", load("process_meeting.valid.json"))
    assert isinstance(p, ProcessMeetingPayload)
    assert p.models.embedding.dimension == 192
    assert p.identify.threshold == 0.7


def test_parses_enroll_speaker_fixture():
    p = parse_payload("enroll_speaker", load("enroll_speaker.valid.json"))
    assert p.embedding.dimension == 192


def test_missing_schema_version_defaults_to_1():
    p = parse_payload("process_meeting", load("process_meeting.no_version.json"))
    assert p.schema_version == 1


def test_rejects_future_schema_version():
    data = load("process_meeting.valid.json") | {"schema_version": 2}
    with pytest.raises(UnsupportedPayloadVersion):
        parse_payload("process_meeting", data)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && uv run pytest tests/test_contracts.py -v`
Expected: FAIL — module `damwha_worker.contracts` not found.

- [ ] **Step 3: Implement contracts.py**

`worker/damwha_worker/contracts.py`:
```python
from typing import Literal

from pydantic import BaseModel

SUPPORTED_SCHEMA_VERSIONS = frozenset({1})


class UnsupportedPayloadVersion(ValueError):
    pass


class Diarization(BaseModel):
    model: str
    min_speakers: int | None
    max_speakers: int | None


class Embedding(BaseModel):
    model: str
    dimension: int


class Models(BaseModel):
    whisper_model: Literal["large-v3-turbo", "large-v3"]
    device: Literal["mps", "cpu", "cuda"]
    language: str
    diarization: Diarization
    embedding: Embedding


class Identify(BaseModel):
    threshold: float


class ProcessMeetingPayload(BaseModel):
    schema_version: int = 1
    meeting_id: str
    audio_key: str
    processing_version: int
    reprocess: bool
    models: Models
    identify: Identify


class EnrollSpeakerPayload(BaseModel):
    schema_version: int = 1
    speaker_id: str
    audio_key: str
    embedding: Embedding


def parse_payload(job_type: str, data: dict):
    version = data.get("schema_version", 1)
    if version not in SUPPORTED_SCHEMA_VERSIONS:
        raise UnsupportedPayloadVersion(f"schema_version {version} not in {sorted(SUPPORTED_SCHEMA_VERSIONS)}")
    if job_type == "process_meeting":
        return ProcessMeetingPayload.model_validate(data)
    if job_type == "enroll_speaker":
        return EnrollSpeakerPayload.model_validate(data)
    raise ValueError(f"unknown job type {job_type}")
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_contracts.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/contracts.py worker/tests/test_contracts.py
git commit -m "feat(worker): pydantic payload contract mirroring zod (schema_version)"
```

---

## Task 3: storage.py (키→경로, traversal 가드)

**Files:**
- Create: `worker/damwha_worker/storage.py`
- Test: `worker/tests/test_storage.py`

**Interfaces:**
- Produces: `Storage(root:str)` with `resolve(key:str)->str` (절대경로; traversal/absolute → raises `ValueError`), `normalized_key(meeting_id:str)->str` → `meetings/<id>/normalized.wav`, `exists(key:str)->bool`.

> TS `StorageService.resolve` 규칙(`src/storage/storage.service.ts`)을 미러한다: `root` 밖이면 거부. 워커는 읽기 위주 + `normalized.wav` 쓰기.

- [ ] **Step 1: Write the failing test**

`worker/tests/test_storage.py`:
```python
import os

import pytest

from damwha_worker.storage import Storage


def test_resolve_within_root(tmp_path):
    s = Storage(str(tmp_path))
    full = s.resolve("meetings/abc/original.m4a")
    assert full.startswith(os.path.realpath(str(tmp_path)))


def test_rejects_traversal_and_absolute(tmp_path):
    s = Storage(str(tmp_path))
    for bad in ["../../etc/passwd", "/etc/passwd", "meetings/../../secret"]:
        with pytest.raises(ValueError):
            s.resolve(bad)


def test_normalized_key():
    s = Storage("/tmp/x")
    assert s.normalized_key("abc") == "meetings/abc/normalized.wav"


def test_exists(tmp_path):
    s = Storage(str(tmp_path))
    key = "meetings/abc/original.wav"
    full = s.resolve(key)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    open(full, "wb").close()
    assert s.exists(key) is True
    assert s.exists("meetings/abc/missing.wav") is False
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_storage.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement storage.py**

`worker/damwha_worker/storage.py`:
```python
import os


class Storage:
    def __init__(self, root: str) -> None:
        self.root = os.path.realpath(root)

    def resolve(self, key: str) -> str:
        full = os.path.realpath(os.path.join(self.root, key))
        rel = os.path.relpath(full, self.root)
        if rel == "." or rel.startswith("..") or os.path.isabs(rel):
            raise ValueError(f"invalid storage key: {key!r}")
        return full

    def normalized_key(self, meeting_id: str) -> str:
        return f"meetings/{meeting_id}/normalized.wav"

    def exists(self, key: str) -> bool:
        return os.path.isfile(self.resolve(key))
```
> `os.path.realpath`로 root를 정규화하므로 macOS `/var`→`/private/var` 심볼릭링크에도 안전하다.

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_storage.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/storage.py worker/tests/test_storage.py
git commit -m "feat(worker): storage key resolution with traversal guard (mirrors TS)"
```

---

## Task 4: errors.py (ErrorKind enum + 분류)

**Files:**
- Create: `worker/damwha_worker/errors.py`
- Test: `worker/tests/test_errors.py`

**Interfaces:**
- Produces: `ErrorKind` (`Enum`: `PERMANENT`, `TRANSIENT`). `WorkerError(Exception)` with `code:str`, `message:str`, `kind:ErrorKind`, `stage:str|None`; `.to_json(stage:str|None=None)->dict` → `{code,message,kind,stage,traceback?}`. Constants for codes: `CORRUPT_AUDIO`, `UNSUPPORTED_FORMAT`, `PROBE_FAILED`, `UNSUPPORTED_PAYLOAD_VERSION` (PERMANENT); `MODEL_LOAD_FAILED`, `OOM`, `IO_ERROR`, `DB_ERROR` (TRANSIENT). `classify(exc:Exception)->WorkerError` — passes `WorkerError` through; maps `UnsupportedPayloadVersion`→PERMANENT; `MemoryError`→OOM; else → TRANSIENT (`uncategorized`) with a logged warning.

- [ ] **Step 1: Write the failing test**

`worker/tests/test_errors.py`:
```python
from damwha_worker.contracts import UnsupportedPayloadVersion
from damwha_worker.errors import ErrorKind, WorkerError, classify


def test_workererror_to_json():
    e = WorkerError("corrupt_audio", "bad header", ErrorKind.PERMANENT)
    j = e.to_json(stage="persist")
    assert j["code"] == "corrupt_audio"
    assert j["kind"] == "PERMANENT"
    assert j["stage"] == "persist"


def test_classify_passthrough_workererror():
    e = WorkerError("oom", "x", ErrorKind.TRANSIENT)
    assert classify(e) is e


def test_classify_unsupported_version_is_permanent():
    w = classify(UnsupportedPayloadVersion("schema_version 2"))
    assert w.kind is ErrorKind.PERMANENT
    assert w.code == "unsupported_payload_version"


def test_classify_memoryerror_is_oom():
    w = classify(MemoryError())
    assert w.kind is ErrorKind.TRANSIENT
    assert w.code == "oom"


def test_classify_unknown_defaults_transient():
    w = classify(RuntimeError("weird"))
    assert w.kind is ErrorKind.TRANSIENT
    assert w.code == "uncategorized"
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_errors.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement errors.py**

`worker/damwha_worker/errors.py`:
```python
import logging
import traceback as _tb
from enum import Enum

from .contracts import UnsupportedPayloadVersion

log = logging.getLogger("damwha_worker")


class ErrorKind(Enum):
    PERMANENT = "PERMANENT"
    TRANSIENT = "TRANSIENT"


class WorkerError(Exception):
    def __init__(self, code: str, message: str, kind: ErrorKind, stage: str | None = None) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.kind = kind
        self.stage = stage

    def to_json(self, stage: str | None = None) -> dict:
        out = {
            "code": self.code,
            "message": self.message,
            "kind": self.kind.value,
            "stage": stage or self.stage,
        }
        tb = "".join(_tb.format_exception(type(self), self, self.__traceback__)).strip()
        if tb and tb != "None":
            out["traceback"] = tb
        return out


# Permanent codes
CORRUPT_AUDIO = "corrupt_audio"
UNSUPPORTED_FORMAT = "unsupported_format"
PROBE_FAILED = "probe_failed"
UNSUPPORTED_PAYLOAD_VERSION = "unsupported_payload_version"
# Transient codes
MODEL_LOAD_FAILED = "model_load_failed"
OOM = "oom"
IO_ERROR = "io_error"
DB_ERROR = "db_error"


def classify(exc: Exception) -> WorkerError:
    if isinstance(exc, WorkerError):
        return exc
    if isinstance(exc, UnsupportedPayloadVersion):
        return WorkerError(UNSUPPORTED_PAYLOAD_VERSION, str(exc), ErrorKind.PERMANENT)
    if isinstance(exc, MemoryError):
        return WorkerError(OOM, "out of memory", ErrorKind.TRANSIENT)
    log.warning("uncategorized exception treated as TRANSIENT: %r", exc)
    return WorkerError("uncategorized", str(exc), ErrorKind.TRANSIENT)
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_errors.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/errors.py worker/tests/test_errors.py
git commit -m "feat(worker): ErrorKind enum + classify (permanent vs transient)"
```

---

## Task 5: db.py — claim + ownership 가드 (job lifecycle)

**Files:**
- Create: `worker/damwha_worker/db.py`
- Test: `worker/tests/test_db_lifecycle.py`

**Interfaces:**
- Produces (all take a psycopg `Connection` with `dict_row`):
  - `claim(conn, worker_id:str) -> dict | None` — SKIP LOCKED, `attempts++`, no stage.
  - `mark_processing(conn, meeting_id:str, job_id:str, processing_version:int) -> int` — meeting 가드, returns rowcount.
  - `set_stage(conn, job_id:str, worker_id:str, stage:str, progress:int) -> int` — job 가드, returns rowcount.
  - `heartbeat(conn, job_id:str, worker_id:str) -> int` — job 가드.
  - `requeue(conn, job_id:str, worker_id:str) -> int` — job 가드, → `queued`, clears lock.
  - `fail_process_meeting(conn, job_id:str, worker_id:str, meeting_id:str, error:dict) -> bool` — job 가드 + meeting 가드된 failed 전파; False = ownership 상실.
  - `fail_enroll(conn, job_id:str, worker_id:str, speaker_id:str, error:dict) -> bool` — job 가드 + speaker 가드된 failed 전파.

- [ ] **Step 1: Write the failing test**

`worker/tests/test_db_lifecycle.py`:
```python
from damwha_worker import db
from tests.conftest import seed_job, seed_meeting, seed_speaker


def test_claim_increments_attempts_and_locks(conn):
    mid = seed_meeting(conn)
    seed_job(conn, meeting_id=mid)
    j = db.claim(conn, "w1")
    assert j is not None
    assert j["status"] == "running"
    assert j["attempts"] == 1
    assert j["locked_by"] == "w1"
    assert j["stage"] is None


def test_claim_empty_returns_none(conn):
    assert db.claim(conn, "w1") is None


def test_set_stage_guarded_by_ownership(conn):
    mid = seed_meeting(conn)
    seed_job(conn, meeting_id=mid)
    j = db.claim(conn, "w1")
    assert db.set_stage(conn, j["id"], "w1", "diarize", 40) == 1
    assert db.set_stage(conn, j["id"], "someone-else", "stt", 60) == 0  # lost ownership
    row = conn.execute("SELECT stage, progress FROM job WHERE id=%s", (j["id"],)).fetchone()
    assert row["stage"] == "diarize" and row["progress"] == 40


def test_mark_processing_guarded_by_meeting(conn):
    mid = seed_meeting(conn, processing_version=2)
    jid = seed_job(conn, meeting_id=mid)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    assert db.mark_processing(conn, mid, jid, 2) == 1
    assert db.mark_processing(conn, mid, jid, 1) == 0  # version mismatch → stale
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == "processing"


def test_requeue_clears_lock(conn):
    mid = seed_meeting(conn)
    seed_job(conn, meeting_id=mid)
    j = db.claim(conn, "w1")
    assert db.requeue(conn, j["id"], "w1") == 1
    row = conn.execute("SELECT status, locked_by, locked_at FROM job WHERE id=%s", (j["id"],)).fetchone()
    assert row["status"] == "queued" and row["locked_by"] is None and row["locked_at"] is None


def test_fail_process_meeting_propagates(conn):
    mid = seed_meeting(conn, processing_version=0)
    jid = seed_job(conn, meeting_id=mid)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    ok = db.fail_process_meeting(conn, jid, "w1", mid, {"code": "corrupt_audio", "message": "x"})
    assert ok is True
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "failed"
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == "failed"


def test_fail_process_meeting_lost_ownership(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    assert db.fail_process_meeting(conn, jid, "OTHER", mid, {"code": "x", "message": "y"}) is False
    # job not failed by a non-owner
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "running"
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_db_lifecycle.py -v`
Expected: FAIL — module `damwha_worker.db` not found.

- [ ] **Step 3: Implement db.py (lifecycle portion)**

`worker/damwha_worker/db.py`:
```python
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


def connect(url: str) -> psycopg.Connection:
    return psycopg.connect(url, row_factory=dict_row, autocommit=True)


def claim(conn, worker_id: str) -> dict | None:
    return conn.execute(
        """
        UPDATE job SET status='running', locked_by=%s, locked_at=now(),
               attempts = attempts + 1, updated_at=now()
        WHERE id IN (
          SELECT id FROM job WHERE status='queued'
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
        ) RETURNING *
        """,
        (worker_id,),
    ).fetchone()


def mark_processing(conn, meeting_id: str, job_id: str, processing_version: int) -> int:
    cur = conn.execute(
        """
        UPDATE meeting SET status='processing'
        WHERE id=%s AND current_job_id=%s AND processing_version=%s
        """,
        (meeting_id, job_id, processing_version),
    )
    return cur.rowcount


def set_stage(conn, job_id: str, worker_id: str, stage: str, progress: int) -> int:
    cur = conn.execute(
        """
        UPDATE job SET stage=%s, progress=%s, updated_at=now()
        WHERE id=%s AND locked_by=%s AND status='running'
        """,
        (stage, progress, job_id, worker_id),
    )
    return cur.rowcount


def heartbeat(conn, job_id: str, worker_id: str) -> int:
    cur = conn.execute(
        """
        UPDATE job SET locked_at=now(), updated_at=now()
        WHERE id=%s AND locked_by=%s AND status='running'
        """,
        (job_id, worker_id),
    )
    return cur.rowcount


def requeue(conn, job_id: str, worker_id: str) -> int:
    cur = conn.execute(
        """
        UPDATE job SET status='queued', locked_by=NULL, locked_at=NULL, updated_at=now()
        WHERE id=%s AND locked_by=%s AND status='running'
        """,
        (job_id, worker_id),
    )
    return cur.rowcount


def fail_process_meeting(conn, job_id: str, worker_id: str, meeting_id: str, error: dict) -> bool:
    with conn.transaction():
        cur = conn.execute(
            """
            UPDATE job SET status='failed', error=%s, updated_at=now()
            WHERE id=%s AND locked_by=%s AND status='running'
            """,
            (Jsonb(error), job_id, worker_id),
        )
        if cur.rowcount == 0:
            raise _Abort
        conn.execute(
            """
            UPDATE meeting SET status='failed',
                   error=%s
            WHERE id=%s AND current_job_id=%s
            """,
            (Jsonb({"code": error["code"], "message": error["message"]}), meeting_id, job_id),
        )
    return True


def fail_enroll(conn, job_id: str, worker_id: str, speaker_id: str, error: dict) -> bool:
    with conn.transaction():
        cur = conn.execute(
            """
            UPDATE job SET status='failed', error=%s, updated_at=now()
            WHERE id=%s AND locked_by=%s AND status='running'
            """,
            (Jsonb(error), job_id, worker_id),
        )
        if cur.rowcount == 0:
            raise _Abort
        conn.execute(
            """
            UPDATE speaker SET enrollment_status='failed', enrollment_error=%s
            WHERE id=%s AND current_job_id=%s
            """,
            (Jsonb({"code": error["code"], "message": error["message"]}), speaker_id, job_id),
        )
    return True


class _Abort(Exception):
    """Internal: rollback a guarded transaction when ownership is lost."""
```
> `fail_*`는 `_Abort`로 트랜잭션을 롤백한 뒤 `False`를 돌려줘야 한다. `with conn.transaction()`은 예외 시 롤백하므로, 호출부 래퍼로 감싼다 — 아래처럼 함수 본문을 `try/except _Abort: return False`로 교체한다:

위 `fail_process_meeting`/`fail_enroll`을 다음 패턴으로 감싼다(최종 형태):
```python
def fail_process_meeting(conn, job_id, worker_id, meeting_id, error) -> bool:
    try:
        with conn.transaction():
            cur = conn.execute(
                "UPDATE job SET status='failed', error=%s, updated_at=now() "
                "WHERE id=%s AND locked_by=%s AND status='running'",
                (Jsonb(error), job_id, worker_id),
            )
            if cur.rowcount == 0:
                raise _Abort
            conn.execute(
                "UPDATE meeting SET status='failed', error=%s WHERE id=%s AND current_job_id=%s",
                (Jsonb({"code": error["code"], "message": error["message"]}), meeting_id, job_id),
            )
        return True
    except _Abort:
        return False
```
`fail_enroll`도 동일하게 `try/except _Abort: return False`로 감싼다.

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_db_lifecycle.py -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/db.py worker/tests/test_db_lifecycle.py
git commit -m "feat(worker): db job lifecycle with ownership guards (claim/stage/requeue/fail)"
```

---

## Task 6: db.py — persist (두 가드 + stale 폐기) + enroll persist

**Files:**
- Modify: `worker/damwha_worker/db.py` (append `persist_process_meeting`, `persist_enroll`)
- Test: `worker/tests/test_db_persist.py`

**Interfaces:**
- Consumes: Task 5 db connection convention.
- Produces:
  - `persist_process_meeting(conn, *, job_id, worker_id, meeting_id, processing_version, normalized_key, duration_ms, utterances:list[dict], clusters:list[dict]) -> str` → `"committed" | "discarded" | "lost"`. `utterances` dict keys: `speaker_id|None, diar_label, start_ms, end_ms, text|None, confidence|None, status, transcript_error|None, order_index`. `clusters` dict keys: `diar_label, centroid:list[float]|None, resolved_speaker_id|None`.
  - `persist_enroll(conn, *, job_id, worker_id, speaker_id, embedding:list[float], model, dimension, sample_duration_ms|None, quality_score|None) -> str` → `"committed" | "lost"`.

- [ ] **Step 1: Write the failing test**

`worker/tests/test_db_persist.py`:
```python
from damwha_worker import db
from tests.conftest import seed_job, seed_meeting, seed_speaker


def _claimed_pm_job(conn, *, pv=0):
    mid = seed_meeting(conn, processing_version=pv, status="processing")
    jid = seed_job(conn, meeting_id=mid)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    return mid, jid


def test_persist_commits_results(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    out = db.persist_process_meeting(
        conn, job_id=jid, worker_id="w1", meeting_id=mid, processing_version=0,
        normalized_key="meetings/x/normalized.wav", duration_ms=12345,
        utterances=[
            {"speaker_id": None, "diar_label": "SPEAKER_00", "start_ms": 0, "end_ms": 1000,
             "text": "안녕", "confidence": 0.9, "status": "ok", "transcript_error": None, "order_index": 0},
        ],
        clusters=[{"diar_label": "SPEAKER_00", "centroid": [0.1] * 192, "resolved_speaker_id": None}],
    )
    assert out == "committed"
    m = conn.execute("SELECT status, duration_ms, normalized_key FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert m["status"] == "done" and m["duration_ms"] == 12345
    assert conn.execute("SELECT count(*) c FROM utterance WHERE meeting_id=%s", (mid,)).fetchone()["c"] == 1
    assert conn.execute("SELECT count(*) c FROM meeting_cluster WHERE meeting_id=%s", (mid,)).fetchone()["c"] == 1
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "done"


def test_persist_replaces_existing_rows(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    db.persist_process_meeting(conn, job_id=jid, worker_id="w1", meeting_id=mid, processing_version=0,
        normalized_key="k", duration_ms=1,
        utterances=[{"speaker_id": None, "diar_label": "S0", "start_ms": 0, "end_ms": 1, "text": "a",
                     "confidence": None, "status": "ok", "transcript_error": None, "order_index": 0}],
        clusters=[])
    # re-persist same job/version replaces, not appends
    db.persist_process_meeting(conn, job_id=jid, worker_id="w1", meeting_id=mid, processing_version=0,
        normalized_key="k", duration_ms=1,
        utterances=[{"speaker_id": None, "diar_label": "S0", "start_ms": 0, "end_ms": 1, "text": "b",
                     "confidence": None, "status": "ok", "transcript_error": None, "order_index": 0}],
        clusters=[])
    rows = conn.execute("SELECT text FROM utterance WHERE meeting_id=%s", (mid,)).fetchall()
    assert [r["text"] for r in rows] == ["b"]


def test_persist_discarded_when_meeting_superseded(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    # a newer reprocess bumped the meeting to pv=1 + a different current_job_id
    conn.execute("UPDATE meeting SET processing_version=1, current_job_id=gen_random_uuid() WHERE id=%s", (mid,))
    out = db.persist_process_meeting(conn, job_id=jid, worker_id="w1", meeting_id=mid, processing_version=0,
        normalized_key="k", duration_ms=1, utterances=[], clusters=[])
    assert out == "discarded"
    # meeting untouched (still pv=1), job done with discard reason
    j = conn.execute("SELECT status, error FROM job WHERE id=%s", (jid,)).fetchone()
    assert j["status"] == "done" and j["error"]["code"] == "discarded_by_stale_guard"
    assert conn.execute("SELECT count(*) c FROM utterance WHERE meeting_id=%s", (mid,)).fetchone()["c"] == 0


def test_persist_lost_when_not_owner(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    out = db.persist_process_meeting(conn, job_id=jid, worker_id="OTHER", meeting_id=mid, processing_version=0,
        normalized_key="k", duration_ms=1, utterances=[], clusters=[])
    assert out == "lost"
    # nothing written; job still running, meeting not done
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "running"
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == "processing"


def test_persist_enroll_sets_ready(conn):
    sid = seed_speaker(conn, enrollment_status="pending")
    jid = seed_job(conn, type="enroll_speaker", meeting_id=None)
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    db.claim(conn, "w1")
    out = db.persist_enroll(conn, job_id=jid, worker_id="w1", speaker_id=sid,
                            embedding=[0.2] * 192, model="m", dimension=192,
                            sample_duration_ms=3000, quality_score=0.8)
    assert out == "committed"
    assert conn.execute("SELECT enrollment_status FROM speaker WHERE id=%s", (sid,)).fetchone()["enrollment_status"] == "ready"
    assert conn.execute("SELECT count(*) c FROM voiceprint WHERE speaker_id=%s", (sid,)).fetchone()["c"] == 1


def test_persist_enroll_lost_when_speaker_superseded(conn):
    sid = seed_speaker(conn, enrollment_status="pending")
    jid = seed_job(conn, type="enroll_speaker")
    conn.execute("UPDATE speaker SET current_job_id=gen_random_uuid() WHERE id=%s", (sid,))  # newer job owns it
    db.claim(conn, "w1")
    out = db.persist_enroll(conn, job_id=jid, worker_id="w1", speaker_id=sid,
                            embedding=[0.2] * 192, model="m", dimension=192,
                            sample_duration_ms=None, quality_score=None)
    assert out == "lost"
    assert conn.execute("SELECT count(*) c FROM voiceprint WHERE speaker_id=%s", (sid,)).fetchone()["c"] == 0
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_db_persist.py -v`
Expected: FAIL — `persist_process_meeting` not defined.

- [ ] **Step 3: Implement persist (append to db.py)**

`worker/damwha_worker/db.py`에 추가:
```python
def _vec(values):
    return "[" + ",".join(repr(float(x)) for x in values) + "]"


def persist_process_meeting(conn, *, job_id, worker_id, meeting_id, processing_version,
                            normalized_key, duration_ms, utterances, clusters) -> str:
    try:
        with conn.transaction():
            # (1) job ownership
            owned = conn.execute(
                "SELECT 1 FROM job WHERE id=%s AND locked_by=%s AND status='running' FOR UPDATE",
                (job_id, worker_id),
            ).fetchone()
            if owned is None:
                raise _Abort

            # (2) meeting guard
            cur = conn.execute(
                """
                UPDATE meeting SET status='done', error=NULL,
                       normalized_key=%s, duration_ms=%s
                WHERE id=%s AND processing_version=%s AND current_job_id=%s
                """,
                (normalized_key, duration_ms, meeting_id, processing_version, job_id),
            )
            if cur.rowcount == 0:
                conn.execute(
                    "UPDATE job SET status='done', error=%s, updated_at=now() WHERE id=%s",
                    (Jsonb({"code": "discarded_by_stale_guard",
                            "message": "meeting superseded by newer processing_version/current_job_id",
                            "stage": "persist", "kind": None}), job_id),
                )
                return "discarded"

            # fresh: replace results
            conn.execute("DELETE FROM utterance WHERE meeting_id=%s", (meeting_id,))
            conn.execute("DELETE FROM meeting_cluster WHERE meeting_id=%s", (meeting_id,))
            for u in utterances:
                conn.execute(
                    """
                    INSERT INTO utterance(meeting_id, speaker_id, diar_label, start_ms, end_ms,
                        text, confidence, status, transcript_error, order_index, processing_version, job_id)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (meeting_id, u["speaker_id"], u["diar_label"], u["start_ms"], u["end_ms"],
                     u["text"], u["confidence"], u["status"],
                     Jsonb(u["transcript_error"]) if u["transcript_error"] is not None else None,
                     u["order_index"], processing_version, job_id),
                )
            for c in clusters:
                centroid = _vec(c["centroid"]) if c["centroid"] is not None else None
                conn.execute(
                    """
                    INSERT INTO meeting_cluster(meeting_id, diar_label, centroid, resolved_speaker_id,
                        processing_version, job_id)
                    VALUES (%s,%s,%s::vector,%s,%s,%s)
                    """,
                    (meeting_id, c["diar_label"], centroid, c["resolved_speaker_id"],
                     processing_version, job_id),
                )
            conn.execute(
                "UPDATE job SET status='done', progress=100, updated_at=now() WHERE id=%s",
                (job_id,),
            )
            return "committed"
    except _Abort:
        return "lost"


def persist_enroll(conn, *, job_id, worker_id, speaker_id, embedding, model, dimension,
                   sample_duration_ms, quality_score) -> str:
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
                UPDATE speaker SET enrollment_status='ready', enrollment_error=NULL
                WHERE id=%s AND current_job_id=%s
                """,
                (speaker_id, job_id),
            )
            if cur.rowcount == 0:
                raise _Abort  # speaker superseded by a newer enroll job
            conn.execute(
                """
                INSERT INTO voiceprint(speaker_id, embedding, model, dimension,
                    sample_duration_ms, quality_score, source)
                VALUES (%s,%s::vector,%s,%s,%s,%s,'enroll')
                """,
                (speaker_id, _vec(embedding), model, dimension, sample_duration_ms, quality_score),
            )
            conn.execute(
                "UPDATE job SET status='done', progress=100, updated_at=now() WHERE id=%s",
                (job_id,),
            )
            return "committed"
    except _Abort:
        return "lost"
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_db_persist.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/db.py worker/tests/test_db_persist.py
git commit -m "feat(worker): guarded persist (two guards + stale discard) + enroll persist"
```

---

## Task 7: 모델 프로토콜 + fakes

**Files:**
- Create: `worker/damwha_worker/models/__init__.py`, `worker/damwha_worker/models/base.py`
- Create: `worker/tests/fakes.py`
- Test: `worker/tests/test_fakes.py`

**Interfaces:**
- Produces: dataclasses `SpeechSpan(start_ms:int, end_ms:int)`, `DiarSegment(diar_label:str, start_ms:int, end_ms:int)`, `Word(text:str, start_ms:int, end_ms:int, confidence:float|None)`. Protocols: `VAD.detect(wav_path:str)->list[SpeechSpan]`, `Diarizer.diarize(wav_path:str)->list[DiarSegment]`, `Embedder.embed(wav_path:str, segments:list[DiarSegment])->list[list[float]]` (one 192-vector per segment), `Transcriber.transcribe(wav_path:str, language:str)->list[Word]`.
- Produces (test): `FakeVAD`, `FakeDiarizer`, `FakeEmbedder`, `FakeTranscriber` (constructor takes the canned output to return).

- [ ] **Step 1: Write the failing test**

`worker/tests/test_fakes.py`:
```python
from damwha_worker.models.base import DiarSegment, SpeechSpan, Word
from tests.fakes import FakeDiarizer, FakeEmbedder, FakeTranscriber, FakeVAD


def test_fakes_return_canned_output():
    vad = FakeVAD([SpeechSpan(0, 1000)])
    diar = FakeDiarizer([DiarSegment("SPEAKER_00", 0, 1000)])
    emb = FakeEmbedder([[0.1] * 192])
    stt = FakeTranscriber([Word("안녕", 0, 500, 0.9)])
    assert vad.detect("x")[0].end_ms == 1000
    assert diar.diarize("x")[0].diar_label == "SPEAKER_00"
    assert len(emb.embed("x", diar.diarize("x"))[0]) == 192
    assert stt.transcribe("x", "ko")[0].text == "안녕"
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_fakes.py -v`
Expected: FAIL — module `damwha_worker.models.base` not found.

- [ ] **Step 3: Implement base.py + fakes**

`worker/damwha_worker/models/__init__.py`: 빈 파일.

`worker/damwha_worker/models/base.py`:
```python
from dataclasses import dataclass
from typing import Protocol


@dataclass
class SpeechSpan:
    start_ms: int
    end_ms: int


@dataclass
class DiarSegment:
    diar_label: str
    start_ms: int
    end_ms: int


@dataclass
class Word:
    text: str
    start_ms: int
    end_ms: int
    confidence: float | None


class VAD(Protocol):
    def detect(self, wav_path: str) -> list[SpeechSpan]: ...


class Diarizer(Protocol):
    def diarize(self, wav_path: str) -> list[DiarSegment]: ...


class Embedder(Protocol):
    def embed(self, wav_path: str, segments: list[DiarSegment]) -> list[list[float]]: ...


class Transcriber(Protocol):
    def transcribe(self, wav_path: str, language: str) -> list[Word]: ...
```

`worker/tests/fakes.py`:
```python
from damwha_worker.models.base import DiarSegment, SpeechSpan, Word


class FakeVAD:
    def __init__(self, spans: list[SpeechSpan]) -> None:
        self._spans = spans

    def detect(self, wav_path: str) -> list[SpeechSpan]:
        return self._spans


class FakeDiarizer:
    def __init__(self, segments: list[DiarSegment]) -> None:
        self._segments = segments

    def diarize(self, wav_path: str) -> list[DiarSegment]:
        return self._segments


class FakeEmbedder:
    def __init__(self, vectors: list[list[float]]) -> None:
        self._vectors = vectors

    def embed(self, wav_path: str, segments) -> list[list[float]]:
        return self._vectors


class FakeTranscriber:
    def __init__(self, words: list[Word]) -> None:
        self._words = words

    def transcribe(self, wav_path: str, language: str) -> list[Word]:
        return self._words
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_fakes.py -v`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/models/__init__.py worker/damwha_worker/models/base.py worker/tests/fakes.py worker/tests/test_fakes.py
git commit -m "feat(worker): model protocols (VAD/Diarizer/Embedder/Transcriber) + fakes"
```

---

## Task 8: align.py (word→segment 중점 귀속 + 병합)

**Files:**
- Create: `worker/damwha_worker/pipeline/__init__.py`, `worker/damwha_worker/pipeline/align.py`
- Test: `worker/tests/test_align.py`

**Interfaces:**
- Consumes: `Word`, `DiarSegment`, `SpeechSpan` (Task 7).
- Produces: dataclass `Utterance(speaker_label:str|None, diar_label:str, start_ms:int, end_ms:int, text:str|None, confidence:float|None, status:str, order_index:int)` where `status ∈ {ok, silence, transcribe_failed}` and `speaker_label` is the `diar_label` (speaker_id 매핑은 식별 단계가 함). `build_utterances(words:list[Word], segments:list[DiarSegment], failed_spans:list[SpeechSpan]|None=None) -> list[Utterance]`.
- 규칙: 각 word를 중점(`(start+end)//2`)이 속한 diar 세그먼트에 귀속(어느 세그먼트에도 안 들면 가장 가까운 세그먼트). 연속된 동일 `diar_label` word를 하나의 utterance(`status='ok'`)로 병합(text 공백 결합, confidence 평균, start=첫 word start, end=마지막 word end). `failed_spans`와 겹치는데 word가 없는 세그먼트는 `transcribe_failed`(text=None). word도 failed_span도 없는 세그먼트는 `silence`. `order_index`는 start_ms 오름차순 0..n.

- [ ] **Step 1: Write the failing test**

`worker/tests/test_align.py`:
```python
from damwha_worker.models.base import DiarSegment, SpeechSpan, Word
from damwha_worker.pipeline.align import build_utterances


def test_assigns_words_by_midpoint_and_merges_consecutive():
    segments = [DiarSegment("S0", 0, 1000), DiarSegment("S1", 1000, 2000)]
    words = [
        Word("안녕", 0, 400, 0.9),       # mid 200 → S0
        Word("하세요", 400, 900, 0.8),   # mid 650 → S0
        Word("반가워", 1100, 1500, 0.7), # mid 1300 → S1
    ]
    utts = build_utterances(words, segments)
    assert len(utts) == 2
    assert utts[0].diar_label == "S0" and utts[0].text == "안녕 하세요" and utts[0].status == "ok"
    assert utts[0].order_index == 0
    assert abs(utts[0].confidence - 0.85) < 1e-6
    assert utts[1].diar_label == "S1" and utts[1].text == "반가워"


def test_speaker_change_splits_even_if_adjacent():
    segments = [DiarSegment("S0", 0, 500), DiarSegment("S1", 500, 1000)]
    words = [Word("a", 0, 200, None), Word("b", 600, 800, None)]
    utts = build_utterances(words, segments)
    assert [u.diar_label for u in utts] == ["S0", "S1"]


def test_silence_segment_with_no_words():
    segments = [DiarSegment("S0", 0, 1000)]
    utts = build_utterances([], segments)
    assert len(utts) == 1 and utts[0].status == "silence" and utts[0].text is None


def test_transcribe_failed_span():
    segments = [DiarSegment("S0", 0, 1000)]
    utts = build_utterances([], segments, failed_spans=[SpeechSpan(0, 1000)])
    assert utts[0].status == "transcribe_failed" and utts[0].text is None


def test_order_index_is_time_ordered():
    segments = [DiarSegment("S1", 1000, 2000), DiarSegment("S0", 0, 1000)]
    words = [Word("late", 1100, 1200, None), Word("early", 100, 200, None)]
    utts = build_utterances(words, segments)
    assert [u.order_index for u in utts] == [0, 1]
    assert utts[0].start_ms < utts[1].start_ms
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_align.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement align.py**

`worker/damwha_worker/pipeline/__init__.py`: 빈 파일.

`worker/damwha_worker/pipeline/align.py`:
```python
from dataclasses import dataclass

from ..models.base import DiarSegment, SpeechSpan, Word


@dataclass
class Utterance:
    speaker_label: str | None
    diar_label: str
    start_ms: int
    end_ms: int
    text: str | None
    confidence: float | None
    status: str
    order_index: int


def _segment_for(word: Word, segments: list[DiarSegment]) -> DiarSegment:
    mid = (word.start_ms + word.end_ms) // 2
    for s in segments:
        if s.start_ms <= mid < s.end_ms:
            return s
    # 어느 세그먼트에도 안 들면 중점에 가장 가까운 세그먼트
    return min(segments, key=lambda s: min(abs(mid - s.start_ms), abs(mid - s.end_ms)))


def _overlaps(a_start, a_end, b_start, b_end) -> bool:
    return a_start < b_end and b_start < a_end


def build_utterances(
    words: list[Word],
    segments: list[DiarSegment],
    failed_spans: list[SpeechSpan] | None = None,
) -> list[Utterance]:
    failed_spans = failed_spans or []
    # 1) word를 세그먼트에 귀속
    by_seg: dict[int, list[Word]] = {i: [] for i in range(len(segments))}
    seg_index = {id(s): i for i, s in enumerate(segments)}
    for w in words:
        seg = _segment_for(w, segments)
        by_seg[seg_index[id(seg)]].append(w)

    raw: list[Utterance] = []
    for i, seg in enumerate(segments):
        ws = sorted(by_seg[i], key=lambda w: w.start_ms)
        if ws:
            # 같은 세그먼트(=같은 화자) word들을 하나의 발언으로 병합
            confs = [w.confidence for w in ws if w.confidence is not None]
            raw.append(Utterance(
                speaker_label=seg.diar_label, diar_label=seg.diar_label,
                start_ms=ws[0].start_ms, end_ms=ws[-1].end_ms,
                text=" ".join(w.text for w in ws),
                confidence=(sum(confs) / len(confs)) if confs else None,
                status="ok", order_index=-1,
            ))
        else:
            failed = any(_overlaps(seg.start_ms, seg.end_ms, f.start_ms, f.end_ms) for f in failed_spans)
            raw.append(Utterance(
                speaker_label=seg.diar_label, diar_label=seg.diar_label,
                start_ms=seg.start_ms, end_ms=seg.end_ms, text=None, confidence=None,
                status="transcribe_failed" if failed else "silence", order_index=-1,
            ))

    raw.sort(key=lambda u: u.start_ms)
    for idx, u in enumerate(raw):
        u.order_index = idx
    return raw
```
> 세그먼트 1개당 발언 1개를 만들고 그 안에서 word를 병합한다 — diarization 세그먼트가 곧 화자 경계이므로 "연속 동일화자 병합"이 세그먼트 단위 병합으로 자연히 구현된다.

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_align.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/pipeline/__init__.py worker/damwha_worker/pipeline/align.py worker/tests/test_align.py
git commit -m "feat(worker): align (word→segment midpoint, merge, silence/failed status)"
```

---

## Task 9: identify.py (centroid + 코사인 식별)

**Files:**
- Create: `worker/damwha_worker/pipeline/identify.py`
- Test: `worker/tests/test_identify.py`

**Interfaces:**
- Consumes: `DiarSegment` (Task 7), db connection.
- Produces:
  - `centroids_by_label(segments:list[DiarSegment], embeddings:list[list[float]]) -> dict[str, list[float]]` — diar_label별 L2 정규화 평균.
  - `identify_clusters(conn, centroids:dict[str,list[float]], model:str, dimension:int, threshold:float) -> dict[str, str | None]` — 각 라벨 centroid에 대해 `voiceprint`(현재 `model`+`dimension` AND speaker `ready`) 코사인 최근접; similarity ≥ threshold면 그 `speaker_id`, 아니면 `None`.

- [ ] **Step 1: Write the failing test**

`worker/tests/test_identify.py`:
```python
from damwha_worker.models.base import DiarSegment
from damwha_worker.pipeline.identify import centroids_by_label, identify_clusters
from tests.conftest import seed_speaker, seed_voiceprint


def test_centroids_l2_normalized_mean():
    segs = [DiarSegment("S0", 0, 1), DiarSegment("S0", 1, 2), DiarSegment("S1", 2, 3)]
    embs = [[3.0, 0.0] + [0.0] * 190, [0.0, 4.0] + [0.0] * 190, [1.0, 0.0] + [0.0] * 190]
    c = centroids_by_label(segs, embs)
    assert set(c) == {"S0", "S1"}
    # S0 mean = (1.5, 2.0,...) → normalized magnitude 1
    import math
    assert abs(math.sqrt(sum(x * x for x in c["S0"])) - 1.0) < 1e-6


def test_identify_matches_ready_speaker_above_threshold(conn):
    sid = seed_speaker(conn, enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0] + [0.0] * 191)
    centroids = {"S0": [1.0] + [0.0] * 191}  # identical direction → similarity 1.0
    out = identify_clusters(conn, centroids, model="speechbrain/spkrec-ecapa-voxceleb", dimension=192, threshold=0.7)
    assert out["S0"] == sid


def test_identify_below_threshold_is_none(conn):
    sid = seed_speaker(conn, enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0] + [0.0] * 191)
    centroids = {"S0": [0.0, 1.0] + [0.0] * 190}  # orthogonal → similarity 0
    out = identify_clusters(conn, centroids, model="speechbrain/spkrec-ecapa-voxceleb", dimension=192, threshold=0.7)
    assert out["S0"] is None


def test_identify_ignores_non_ready_and_wrong_model(conn):
    pending = seed_speaker(conn, enrollment_status="pending")
    seed_voiceprint(conn, speaker_id=pending, embedding=[1.0] + [0.0] * 191)
    ready_other_model = seed_speaker(conn, enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=ready_other_model, embedding=[1.0] + [0.0] * 191, model="other-model")
    out = identify_clusters(conn, {"S0": [1.0] + [0.0] * 191},
                            model="speechbrain/spkrec-ecapa-voxceleb", dimension=192, threshold=0.5)
    assert out["S0"] is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_identify.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement identify.py**

`worker/damwha_worker/pipeline/identify.py`:
```python
import math

from ..models.base import DiarSegment


def _normalize(v: list[float]) -> list[float]:
    mag = math.sqrt(sum(x * x for x in v))
    if mag == 0:
        return v
    return [x / mag for x in v]


def centroids_by_label(segments: list[DiarSegment], embeddings: list[list[float]]) -> dict[str, list[float]]:
    groups: dict[str, list[list[float]]] = {}
    for seg, emb in zip(segments, embeddings, strict=True):
        groups.setdefault(seg.diar_label, []).append(emb)
    out: dict[str, list[float]] = {}
    for label, vecs in groups.items():
        dim = len(vecs[0])
        mean = [sum(v[i] for v in vecs) / len(vecs) for i in range(dim)]
        out[label] = _normalize(mean)
    return out


def _vec(values: list[float]) -> str:
    return "[" + ",".join(repr(float(x)) for x in values) + "]"


def identify_clusters(conn, centroids, model, dimension, threshold) -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    for label, centroid in centroids.items():
        row = conn.execute(
            """
            SELECT v.speaker_id, 1 - (v.embedding <=> %s::vector) AS similarity
            FROM voiceprint v
            JOIN speaker s ON s.id = v.speaker_id
            WHERE v.model = %s AND v.dimension = %s AND s.enrollment_status = 'ready'
            ORDER BY v.embedding <=> %s::vector ASC
            LIMIT 1
            """,
            (_vec(centroid), model, dimension, _vec(centroid)),
        ).fetchone()
        out[label] = row["speaker_id"] if row and row["similarity"] >= threshold else None
    return out
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_identify.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/pipeline/identify.py worker/tests/test_identify.py
git commit -m "feat(worker): identify (centroid + pgvector cosine, ready+model filter)"
```

---

## Task 10: ffmpeg.py (normalize + probe, injectable runner)

**Files:**
- Create: `worker/damwha_worker/pipeline/ffmpeg.py`
- Test: `worker/tests/test_ffmpeg.py`

**Interfaces:**
- Produces:
  - `@dataclass ProbeResult(duration_ms:int)`.
  - `Runner = Callable[[list[str]], subprocess.CompletedProcess]` (default `_run` uses `subprocess.run(capture_output=True)`).
  - `probe(path:str, runner:Runner=_run) -> ProbeResult` — `ffprobe -v error -show_entries format=duration -of json`로 duration 파싱. ffprobe 실패(returncode≠0)나 duration 없음 → `WorkerError(PROBE_FAILED|UNSUPPORTED_FORMAT, PERMANENT)`.
  - `normalize(src_path:str, dst_path:str, runner:Runner=_run) -> None` — `ffmpeg -i src -ac 1 -ar 16000 -f wav dst`. 실패 → `WorkerError(CORRUPT_AUDIO, PERMANENT)`.
- 실제 ffmpeg 바이너리 호출은 Task 14 로컬 smoke에서 검증; 여기선 fake runner로 명령 구성·파싱·오류 분류만 테스트(결정적, CI).

- [ ] **Step 1: Write the failing test**

`worker/tests/test_ffmpeg.py`:
```python
import subprocess

import pytest

from damwha_worker.errors import WorkerError
from damwha_worker.pipeline import ffmpeg


def ok_proc(stdout=b"", returncode=0):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=b"")


def test_probe_parses_duration_ms():
    captured = {}

    def runner(cmd):
        captured["cmd"] = cmd
        return ok_proc(stdout=b'{"format": {"duration": "12.345"}}')

    res = ffmpeg.probe("/x/a.m4a", runner=runner)
    assert res.duration_ms == 12345
    assert "ffprobe" in captured["cmd"][0]


def test_probe_failure_is_permanent():
    def runner(cmd):
        return ok_proc(returncode=1)

    with pytest.raises(WorkerError) as ei:
        ffmpeg.probe("/x/bad", runner=runner)
    assert ei.value.kind.value == "PERMANENT"


def test_probe_missing_duration_is_permanent():
    def runner(cmd):
        return ok_proc(stdout=b'{"format": {}}')

    with pytest.raises(WorkerError):
        ffmpeg.probe("/x/a", runner=runner)


def test_normalize_builds_16k_mono_wav_command():
    captured = {}

    def runner(cmd):
        captured["cmd"] = cmd
        return ok_proc()

    ffmpeg.normalize("/in/a.m4a", "/out/n.wav", runner=runner)
    cmd = captured["cmd"]
    assert "-ar" in cmd and "16000" in cmd and "-ac" in cmd and "1" in cmd
    assert cmd[-1] == "/out/n.wav"


def test_normalize_failure_is_permanent():
    def runner(cmd):
        return ok_proc(returncode=1)

    with pytest.raises(WorkerError) as ei:
        ffmpeg.normalize("/in/a", "/out/n.wav", runner=runner)
    assert ei.value.kind.value == "PERMANENT"
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_ffmpeg.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ffmpeg.py**

`worker/damwha_worker/pipeline/ffmpeg.py`:
```python
import json
import subprocess
from collections.abc import Callable
from dataclasses import dataclass

from ..errors import CORRUPT_AUDIO, PROBE_FAILED, UNSUPPORTED_FORMAT, ErrorKind, WorkerError

Runner = Callable[[list[str]], subprocess.CompletedProcess]


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True)


@dataclass
class ProbeResult:
    duration_ms: int


def probe(path: str, runner: Runner = _run) -> ProbeResult:
    cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", path]
    proc = runner(cmd)
    if proc.returncode != 0:
        raise WorkerError(PROBE_FAILED, f"ffprobe failed: {proc.stderr!r}", ErrorKind.PERMANENT)
    try:
        data = json.loads(proc.stdout or b"{}")
        duration = data["format"]["duration"]
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        raise WorkerError(UNSUPPORTED_FORMAT, f"no duration in probe output: {e}", ErrorKind.PERMANENT) from e
    if duration is None:
        raise WorkerError(UNSUPPORTED_FORMAT, "duration is null", ErrorKind.PERMANENT)
    return ProbeResult(duration_ms=int(float(duration) * 1000))


def normalize(src_path: str, dst_path: str, runner: Runner = _run) -> None:
    cmd = ["ffmpeg", "-y", "-i", src_path, "-ac", "1", "-ar", "16000", "-f", "wav", dst_path]
    proc = runner(cmd)
    if proc.returncode != 0:
        raise WorkerError(CORRUPT_AUDIO, f"ffmpeg normalize failed: {proc.stderr!r}", ErrorKind.PERMANENT)
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_ffmpeg.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/pipeline/ffmpeg.py worker/tests/test_ffmpeg.py
git commit -m "feat(worker): ffmpeg normalize + probe (injectable runner, permanent errors)"
```

---

## Task 11: process_meeting 오케스트레이션

**Files:**
- Create: `worker/damwha_worker/pipeline/process_meeting.py`
- Test: `worker/tests/test_process_meeting.py`

**Interfaces:**
- Consumes: `db`(Task 5,6), `align`(8), `identify`(9), `ffmpeg`(10), model protocols(7), `Storage`(3), `ProcessMeetingPayload`(2).
- Produces: `@dataclass Models(vad:VAD, diarizer:Diarizer, embedder:Embedder, transcriber:Transcriber)`. `run_process_meeting(conn, job:dict, payload:ProcessMeetingPayload, models:Models, storage:Storage, *, worker_id:str) -> str` → persist 결과(`"committed"|"discarded"|"lost"`). 각 stage 진입 시 `db.set_stage` 호출(0-row면 `WorkerError`로 ownership 상실 → 중단). normalize는 디스크에 `normalized.wav` 있으면 생략. 식별 결과로 utterance.speaker_id 매핑 + 미식별 라벨만 `meeting_cluster` 생성.

> 이 태스크는 fake 모델로 파이프라인 전체를 결정적으로 검증한다. 실제 ffmpeg 호출을 피하려고 `run_process_meeting`은 ffmpeg 함수를 주입 가능한 인자(`normalize_fn`, `probe_fn`)로 받는다(기본은 `ffmpeg.normalize`/`ffmpeg.probe`).

- [ ] **Step 1: Write the failing test**

`worker/tests/test_process_meeting.py`:
```python
from damwha_worker import db
from damwha_worker.contracts import ProcessMeetingPayload
from damwha_worker.models.base import DiarSegment, Word
from damwha_worker.pipeline.ffmpeg import ProbeResult
from damwha_worker.pipeline.process_meeting import Models, run_process_meeting
from damwha_worker.storage import Storage
from tests.conftest import seed_job, seed_meeting, seed_speaker, seed_voiceprint
from tests.fakes import FakeDiarizer, FakeEmbedder, FakeTranscriber, FakeVAD


def _payload(meeting_id, audio_key, pv=0, threshold=0.7):
    return ProcessMeetingPayload.model_validate({
        "schema_version": 1, "meeting_id": str(meeting_id), "audio_key": audio_key,
        "processing_version": pv, "reprocess": pv > 0,
        "models": {"whisper_model": "large-v3-turbo", "device": "cpu", "language": "ko",
                   "diarization": {"model": "d", "min_speakers": None, "max_speakers": None},
                   "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192}},
        "identify": {"threshold": threshold},
    })


def _models():
    return Models(
        vad=FakeVAD([]),
        diarizer=FakeDiarizer([DiarSegment("SPEAKER_00", 0, 1000), DiarSegment("SPEAKER_01", 1000, 2000)]),
        embedder=FakeEmbedder([[1.0] + [0.0] * 191, [0.0, 1.0] + [0.0] * 190]),
        transcriber=FakeTranscriber([Word("안녕", 0, 500, 0.9), Word("반가워", 1100, 1500, 0.8)]),
    )


def test_full_pipeline_with_identification(conn, tmp_path):
    # known speaker matches SPEAKER_00's centroid direction
    sid = seed_speaker(conn, enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0] + [0.0] * 191)

    mid = seed_meeting(conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a")
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")

    storage = Storage(str(tmp_path))
    out = run_process_meeting(
        conn, conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(mid, "meetings/m/original.m4a"), _models(), storage, worker_id="w1",
        normalize_fn=lambda s, d: None, probe_fn=lambda p: ProbeResult(2000),
    )
    assert out == "committed"
    utts = conn.execute("SELECT diar_label, speaker_id, text FROM utterance WHERE meeting_id=%s ORDER BY order_index", (mid,)).fetchall()
    assert utts[0]["diar_label"] == "SPEAKER_00" and utts[0]["speaker_id"] == sid
    assert utts[1]["speaker_id"] is None  # SPEAKER_01 unidentified
    # only the unidentified label is preserved as a cluster
    clusters = conn.execute("SELECT diar_label FROM meeting_cluster WHERE meeting_id=%s", (mid,)).fetchall()
    assert [c["diar_label"] for c in clusters] == ["SPEAKER_01"]
    assert conn.execute("SELECT duration_ms FROM meeting WHERE id=%s", (mid,)).fetchone()["duration_ms"] == 2000


def test_stage_progress_recorded(conn, tmp_path):
    mid = seed_meeting(conn, status="processing", audio_key="meetings/m/original.m4a")
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    run_process_meeting(conn, conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(mid, "meetings/m/original.m4a"), _models(), Storage(str(tmp_path)), worker_id="w1",
        normalize_fn=lambda s, d: None, probe_fn=lambda p: ProbeResult(2000))
    assert conn.execute("SELECT stage FROM job WHERE id=%s", (jid,)).fetchone()["stage"] == "persist"
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_process_meeting.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement process_meeting.py**

`worker/damwha_worker/pipeline/process_meeting.py`:
```python
import os
from collections.abc import Callable
from dataclasses import dataclass

from ..contracts import ProcessMeetingPayload
from ..errors import ErrorKind, WorkerError
from ..models.base import Diarizer, Embedder, Transcriber, VAD
from ..storage import Storage
from . import ffmpeg
from .align import build_utterances
from .identify import centroids_by_label, identify_clusters
from .. import db


@dataclass
class Models:
    vad: VAD
    diarizer: Diarizer
    embedder: Embedder
    transcriber: Transcriber


def _stage(conn, job_id, worker_id, stage, progress):
    if db.set_stage(conn, job_id, worker_id, stage, progress) == 0:
        raise WorkerError("lost_ownership", f"lock lost at {stage}", ErrorKind.TRANSIENT, stage=stage)


def run_process_meeting(
    conn, job: dict, payload: ProcessMeetingPayload, models: Models, storage: Storage, *,
    worker_id: str,
    normalize_fn: Callable[[str, str], None] | None = None,
    probe_fn: Callable[[str], ffmpeg.ProbeResult] | None = None,
) -> str:
    # 기본값은 호출 시점에 해석한다 — def-time에 모듈 속성을 캡처하지 않으므로
    # 테스트가 ffmpeg.normalize/probe를 monkeypatch할 수 있다.
    normalize_fn = normalize_fn or ffmpeg.normalize
    probe_fn = probe_fn or ffmpeg.probe
    job_id = job["id"]
    meeting_id = payload.meeting_id

    # mark processing (meeting guard); 0-row → lost ownership
    if db.mark_processing(conn, meeting_id, job_id, payload.processing_version) == 0:
        return "lost"

    # 1) normalize + probe (정규화는 'vad' stage 이전 — stage enum에 normalize 없음)
    src = storage.resolve(payload.audio_key)
    norm_key = storage.normalized_key(meeting_id)
    norm_path = storage.resolve(norm_key)
    if not storage.exists(norm_key):
        os.makedirs(os.path.dirname(norm_path), exist_ok=True)
        normalize_fn(src, norm_path)
    duration_ms = probe_fn(norm_path).duration_ms

    # 2) VAD (구간은 STT 실패 추적/무음 판정 보조용)
    _stage(conn, job_id, worker_id, "vad", 15)
    speech_spans = models.vad.detect(norm_path)

    # 3) diarize
    _stage(conn, job_id, worker_id, "diarize", 35)
    segments = models.diarizer.diarize(norm_path)

    # 4) embed → centroids
    _stage(conn, job_id, worker_id, "identify", 50)
    embeddings = models.embedder.embed(norm_path, segments)
    centroids = centroids_by_label(segments, embeddings)

    # 5) identify
    label_to_speaker = identify_clusters(
        conn, centroids, model=payload.models.embedding.model,
        dimension=payload.models.embedding.dimension, threshold=payload.identify.threshold,
    )

    # 6) STT
    _stage(conn, job_id, worker_id, "stt", 75)
    words = models.transcriber.transcribe(norm_path, payload.models.language)

    # 7) align
    _stage(conn, job_id, worker_id, "align", 90)
    utts = build_utterances(words, segments, failed_spans=speech_spans if not words else None)

    utterance_rows = [{
        "speaker_id": label_to_speaker.get(u.diar_label),
        "diar_label": u.diar_label, "start_ms": u.start_ms, "end_ms": u.end_ms,
        "text": u.text, "confidence": u.confidence, "status": u.status,
        "transcript_error": None, "order_index": u.order_index,
    } for u in utts]

    # 미식별 라벨만 cluster로 보존 (centroid 포함)
    cluster_rows = [{
        "diar_label": label, "centroid": centroids.get(label), "resolved_speaker_id": None,
    } for label, sid in label_to_speaker.items() if sid is None]

    # 8) persist
    _stage(conn, job_id, worker_id, "persist", 95)
    return db.persist_process_meeting(
        conn, job_id=job_id, worker_id=worker_id, meeting_id=meeting_id,
        processing_version=payload.processing_version, normalized_key=norm_key,
        duration_ms=duration_ms, utterances=utterance_rows, clusters=cluster_rows,
    )
```
> `failed_spans`는 단순화: word가 하나도 없으면 VAD 구간을 transcribe_failed 후보로 넘긴다(STT 전면 실패 케이스). 청크 단위 부분 실패의 정교한 매핑은 실제 STT 백엔드(Task 14)가 청크별 예외를 잡아 `failed_spans`를 채우는 방식으로 확장한다.

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_process_meeting.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/pipeline/process_meeting.py worker/tests/test_process_meeting.py
git commit -m "feat(worker): process_meeting orchestration (fake-model end-to-end)"
```

---

## Task 12: enroll_speaker 오케스트레이션

**Files:**
- Create: `worker/damwha_worker/pipeline/enroll_speaker.py`
- Test: `worker/tests/test_enroll_speaker.py`

**Interfaces:**
- Consumes: `db`(6), `Embedder`(7), `Storage`(3), `EnrollSpeakerPayload`(2), `ffmpeg`(10).
- Produces: `run_enroll_speaker(conn, job:dict, payload:EnrollSpeakerPayload, embedder:Embedder, storage:Storage, *, worker_id:str, normalize_fn=ffmpeg.normalize, probe_fn=ffmpeg.probe) -> str` → `"committed"|"lost"`. `extract_embedding` stage → `enroll_persist` stage. 전체 샘플을 하나의 세그먼트로 임베딩.

- [ ] **Step 1: Write the failing test**

`worker/tests/test_enroll_speaker.py`:
```python
from damwha_worker import db
from damwha_worker.contracts import EnrollSpeakerPayload
from damwha_worker.pipeline.enroll_speaker import run_enroll_speaker
from damwha_worker.pipeline.ffmpeg import ProbeResult
from damwha_worker.storage import Storage
from tests.conftest import seed_job, seed_speaker
from tests.fakes import FakeEmbedder


def _payload(speaker_id, audio_key):
    return EnrollSpeakerPayload.model_validate({
        "schema_version": 1, "speaker_id": str(speaker_id), "audio_key": audio_key,
        "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
    })


def test_enroll_sets_ready_and_writes_voiceprint(conn, tmp_path):
    sid = seed_speaker(conn, enrollment_status="pending")
    jid = seed_job(conn, type="enroll_speaker", payload={})
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    db.claim(conn, "w1")
    out = run_enroll_speaker(
        conn, conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(sid, "speakers/s/sample.wav"), FakeEmbedder([[0.3] * 192]), Storage(str(tmp_path)),
        worker_id="w1", normalize_fn=lambda s, d: None, probe_fn=lambda p: ProbeResult(3000),
    )
    assert out == "committed"
    assert conn.execute("SELECT enrollment_status FROM speaker WHERE id=%s", (sid,)).fetchone()["enrollment_status"] == "ready"
    vp = conn.execute("SELECT sample_duration_ms, source FROM voiceprint WHERE speaker_id=%s", (sid,)).fetchone()
    assert vp["sample_duration_ms"] == 3000 and vp["source"] == "enroll"
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_enroll_speaker.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement enroll_speaker.py**

`worker/damwha_worker/pipeline/enroll_speaker.py`:
```python
import os
from collections.abc import Callable

from ..contracts import EnrollSpeakerPayload
from ..models.base import DiarSegment, Embedder
from ..storage import Storage
from . import ffmpeg
from .. import db


def run_enroll_speaker(
    conn, job: dict, payload: EnrollSpeakerPayload, embedder: Embedder, storage: Storage, *,
    worker_id: str,
    normalize_fn: Callable[[str, str], None] | None = None,
    probe_fn: Callable[[str], ffmpeg.ProbeResult] | None = None,
) -> str:
    # 기본값은 호출 시점 해석 (monkeypatch 가능) — run_process_meeting와 동일 이유.
    normalize_fn = normalize_fn or ffmpeg.normalize
    probe_fn = probe_fn or ffmpeg.probe
    job_id = job["id"]
    speaker_id = payload.speaker_id

    db.set_stage(conn, job_id, worker_id, "extract_embedding", 30)
    src = storage.resolve(payload.audio_key)
    norm_key = f"speakers/{speaker_id}/normalized.wav"
    norm_path = storage.resolve(norm_key)
    if not storage.exists(norm_key):
        os.makedirs(os.path.dirname(norm_path), exist_ok=True)
        normalize_fn(src, norm_path)
    duration_ms = probe_fn(norm_path).duration_ms

    segment = DiarSegment("FULL", 0, duration_ms)
    embedding = embedder.embed(norm_path, [segment])[0]

    db.set_stage(conn, job_id, worker_id, "enroll_persist", 80)
    return db.persist_enroll(
        conn, job_id=job_id, worker_id=worker_id, speaker_id=speaker_id,
        embedding=embedding, model=payload.embedding.model, dimension=payload.embedding.dimension,
        sample_duration_ms=duration_ms, quality_score=None,
    )
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_enroll_speaker.py -v`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/pipeline/enroll_speaker.py worker/tests/test_enroll_speaker.py
git commit -m "feat(worker): enroll_speaker orchestration (extract→persist, ready transition)"
```

---

## Task 13: 폴 루프 + heartbeat + 재시도 제어

**Files:**
- Create: `worker/damwha_worker/heartbeat.py`, `worker/damwha_worker/__main__.py`
- Test: `worker/tests/test_worker_loop.py`, `worker/tests/test_heartbeat.py`

**Interfaces:**
- Consumes: 모든 이전 태스크.
- Produces:
  - `heartbeat.Heartbeat(url:str, job_id:str, worker_id:str, interval:float)` — 컨텍스트 매니저. 자체 DB 커넥션을 연 데몬 스레드가 `interval`마다 `db.heartbeat`. `__exit__`에서 정지.
  - `__main__.handle_job(conn, job:dict, models, storage, worker_id) -> str` — type 디스패치 + 예외→`classify`→requeue/fail 제어. 반환: `"committed"|"discarded"|"lost"|"requeued"|"failed"`.
  - `__main__.run_once(conn, worker_id, models, storage) -> str | None` — claim 1건 처리, 없으면 None.
  - `__main__.main()` — `load_settings` + 실모델 `registry.build_models`(Task 14) + 무한 루프.

- [ ] **Step 1: Write the failing tests**

`worker/tests/test_heartbeat.py`:
```python
import time

from damwha_worker import db
from damwha_worker.heartbeat import Heartbeat
from tests.conftest import seed_job, seed_meeting


def test_heartbeat_advances_locked_at(conn, pg_url):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    before = conn.execute("SELECT locked_at FROM job WHERE id=%s", (jid,)).fetchone()["locked_at"]
    with Heartbeat(pg_url, jid, "w1", interval=0.05):
        time.sleep(0.2)
    after = conn.execute("SELECT locked_at FROM job WHERE id=%s", (jid,)).fetchone()["locked_at"]
    assert after > before
```

`worker/tests/test_worker_loop.py`:
```python
from damwha_worker import db
from damwha_worker.__main__ import handle_job, run_once
from damwha_worker.contracts import ProcessMeetingPayload
from damwha_worker.errors import ErrorKind, WorkerError
from damwha_worker.models.base import DiarSegment, Word
from damwha_worker.pipeline.ffmpeg import ProbeResult
from damwha_worker.pipeline.process_meeting import Models
from damwha_worker.storage import Storage
from tests.conftest import seed_job, seed_meeting
from tests.fakes import FakeDiarizer, FakeEmbedder, FakeTranscriber, FakeVAD


def _models():
    return Models(FakeVAD([]), FakeDiarizer([DiarSegment("S0", 0, 1000)]),
                  FakeEmbedder([[0.1] * 192]), FakeTranscriber([Word("hi", 0, 500, 0.9)]))


def _enqueue_pm(conn, pv=0):
    mid = seed_meeting(conn, status="uploaded", processing_version=pv, audio_key="meetings/m/original.m4a")
    payload = {"schema_version": 1, "meeting_id": str(mid), "audio_key": "meetings/m/original.m4a",
               "processing_version": pv, "reprocess": False,
               "models": {"whisper_model": "large-v3-turbo", "device": "cpu", "language": "ko",
                          "diarization": {"model": "d", "min_speakers": None, "max_speakers": None},
                          "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192}},
               "identify": {"threshold": 0.7}}
    jid = seed_job(conn, meeting_id=mid, payload=payload)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    return mid, jid


def test_run_once_processes_to_done(conn, tmp_path, monkeypatch):
    import damwha_worker.pipeline.process_meeting as pm
    monkeypatch.setattr(pm.ffmpeg, "normalize", lambda s, d: None)
    monkeypatch.setattr(pm.ffmpeg, "probe", lambda p: ProbeResult(1000))
    mid, jid = _enqueue_pm(conn)
    out = run_once(conn, "w1", _models(), Storage(str(tmp_path)))
    assert out == "committed"
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "done"


def test_run_once_empty_returns_none(conn, tmp_path):
    assert run_once(conn, "w1", _models(), Storage(str(tmp_path))) is None


def _stub_ffmpeg(monkeypatch):
    import damwha_worker.pipeline.process_meeting as pm
    monkeypatch.setattr(pm.ffmpeg, "normalize", lambda s, d: None)
    monkeypatch.setattr(pm.ffmpeg, "probe", lambda p: ProbeResult(1000))


def test_transient_error_requeues_when_attempts_left(conn, tmp_path, monkeypatch):
    _stub_ffmpeg(monkeypatch)  # 진짜 ffmpeg가 diarizer 전에 실패하지 않도록
    mid, jid = _enqueue_pm(conn)
    job = db.claim(conn, "w1")  # attempts=1, max=3
    boom = _models()
    boom.diarizer = _RaisingDiarizer(WorkerError("io_error", "x", ErrorKind.TRANSIENT))
    out = handle_job(conn, job, boom, Storage(str(tmp_path)), "w1")
    assert out == "requeued"
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "queued"


def test_permanent_error_fails(conn, tmp_path, monkeypatch):
    _stub_ffmpeg(monkeypatch)
    mid, jid = _enqueue_pm(conn)
    job = db.claim(conn, "w1")
    boom = _models()
    boom.diarizer = _RaisingDiarizer(WorkerError("corrupt_audio", "x", ErrorKind.PERMANENT))
    out = handle_job(conn, job, boom, Storage(str(tmp_path)), "w1")
    assert out == "failed"
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "failed"
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == "failed"


class _RaisingDiarizer:
    def __init__(self, exc):
        self._exc = exc

    def diarize(self, wav_path):
        raise self._exc
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_heartbeat.py tests/test_worker_loop.py -v`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement heartbeat.py + __main__.py**

`worker/damwha_worker/heartbeat.py`:
```python
import threading

from . import db


class Heartbeat:
    def __init__(self, url: str, job_id: str, worker_id: str, interval: float) -> None:
        self._url = url
        self._job_id = job_id
        self._worker_id = worker_id
        self._interval = interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        conn = db.connect(self._url)  # 별도 커넥션 (psycopg는 스레드 간 공유 불가)
        try:
            while not self._stop.wait(self._interval):
                db.heartbeat(conn, self._job_id, self._worker_id)
        finally:
            conn.close()

    def __enter__(self) -> "Heartbeat":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._thread.join(timeout=5)
```

`worker/damwha_worker/__main__.py`:
```python
import logging
import time

from . import db
from .config import load_settings
from .contracts import parse_payload
from .errors import ErrorKind, classify
from .pipeline.enroll_speaker import run_enroll_speaker
from .pipeline.process_meeting import Models, run_process_meeting
from .storage import Storage

log = logging.getLogger("damwha_worker")


def handle_job(conn, job: dict, models: Models, storage: Storage, worker_id: str) -> str:
    try:
        payload = parse_payload(job["type"], job["payload"])
        if job["type"] == "process_meeting":
            return run_process_meeting(conn, job, payload, models, storage, worker_id=worker_id)
        if job["type"] == "enroll_speaker":
            return run_enroll_speaker(conn, job, payload, models.embedder, storage, worker_id=worker_id)
        raise ValueError(f"unknown job type {job['type']}")
    except Exception as exc:  # noqa: BLE001 — 분류해서 requeue/fail
        werr = classify(exc)
        error_json = werr.to_json(stage=job.get("stage"))
        log.warning("job %s failed: code=%s kind=%s attempt=%s/%s",
                    job["id"], werr.code, werr.kind.value, job["attempts"], job["max_attempts"])
        if job["type"] == "enroll_speaker":
            speaker_id = (job["payload"] or {}).get("speaker_id")
            if werr.kind is ErrorKind.TRANSIENT and job["attempts"] < job["max_attempts"]:
                return "requeued" if db.requeue(conn, job["id"], worker_id) else "lost"
            return "failed" if db.fail_enroll(conn, job["id"], worker_id, speaker_id, error_json) else "lost"
        # process_meeting
        meeting_id = job["meeting_id"]
        if werr.kind is ErrorKind.TRANSIENT and job["attempts"] < job["max_attempts"]:
            return "requeued" if db.requeue(conn, job["id"], worker_id) else "lost"
        return "failed" if db.fail_process_meeting(conn, job["id"], worker_id, meeting_id, error_json) else "lost"


def run_once(conn, worker_id: str, models: Models, storage: Storage) -> str | None:
    job = db.claim(conn, worker_id)
    if job is None:
        return None
    return handle_job(conn, job, models, storage, worker_id)


def main() -> None:  # pragma: no cover — 실모델 + 무한 루프 (로컬 실행)
    logging.basicConfig(level=logging.INFO)
    settings = load_settings()
    storage = Storage(settings.storage_root)
    from .models.registry import build_models  # Task 14
    conn = db.connect(settings.database_url)
    log.info("worker %s started", settings.worker_id)
    while True:
        job = db.claim(conn, settings.worker_id)
        if job is None:
            time.sleep(settings.poll_interval_seconds)
            continue
        models = build_models(job["payload"], settings)
        from .heartbeat import Heartbeat
        with Heartbeat(settings.database_url, job["id"], settings.worker_id, settings.heartbeat_interval_seconds):
            outcome = handle_job(conn, job, models, storage, settings.worker_id)
        log.info("job %s → %s", job["id"], outcome)
        time.sleep(settings.poll_interval_seconds)  # requeue 후에도 poll 간격 유지


if __name__ == "__main__":  # pragma: no cover
    main()
```
> `handle_job`은 `process_meeting`/`enroll_speaker` 모두에서 `Models`를 받지만 enroll은 `models.embedder`만 쓴다. 테스트는 `Models`를 그대로 넘긴다.

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_heartbeat.py tests/test_worker_loop.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite**

Run: `cd worker && uv run pytest -v`
Expected: PASS (모든 결정적 테스트).
Run: `uv run ruff check --fix . && uv run ruff format .`
Expected: import 정렬·포맷 자동 적용 후 클린(에러 0). 변경분은 다음 커밋에 포함.

- [ ] **Step 6: Commit**

```bash
git add worker/damwha_worker/heartbeat.py worker/damwha_worker/__main__.py worker/tests/test_heartbeat.py worker/tests/test_worker_loop.py
git commit -m "feat(worker): poll loop + heartbeat thread + transient/permanent retry control"
```

---

## Task 14: 실제 모델 구현 + registry + 다운로드 (로컬 smoke)

> 이 태스크는 CI TDD 대상이 아니다 — 모델이 무겁고 pyannote는 gated다. 이미 테스트된 프로토콜 뒤에 실구현을 끼우고, 짧은 2화자 샘플로 **로컬 end-to-end smoke**로만 검증한다.

**Files:**
- Modify: `worker/pyproject.toml` (실모델 의존 추가)
- Create: `worker/damwha_worker/models/silero_vad.py`, `pyannote_diar.py`, `ecapa_embed.py`, `whisper_mlx.py`, `whisper_faster.py`, `registry.py`
- Create: `worker/scripts/download_models.py`
- Create: `worker/SMOKE.md` (로컬 검증 절차)

**Interfaces:**
- Produces: 각 실구현이 Task 7 프로토콜을 만족. `registry.build_models(payload:dict, settings:Settings) -> Models` — `payload["models"]`와 `settings.device`/`whisper_backend`로 4개 구현 조립. mlx-whisper(device=mps)/faster-whisper(cpu·cuda) 선택.

- [ ] **Step 1: Add real-model dependencies**

`worker/pyproject.toml`의 `dependencies`에 추가(설치는 무겁다):
```toml
    "silero-vad>=5.1",
    "pyannote.audio>=3.1",
    "speechbrain>=1.0",
    "soundfile>=0.12",
    "numpy>=1.26",
```
플랫폼별 STT(둘 중 환경에 맞는 하나):
```toml
    # Apple Silicon: "mlx-whisper>=0.3"
    # CUDA/CPU:     "faster-whisper>=1.0"
```
Run: `cd worker && uv sync`
Expected: 설치 성공(첫 실행은 오래 걸림).

- [ ] **Step 2: Implement the four adapters**

각 어댑터는 프로토콜 메서드 하나만 구현하고 ms 단위로 변환한다. 예시 골격:

`worker/damwha_worker/models/silero_vad.py`:
```python
from .base import SpeechSpan


class SileroVAD:
    def __init__(self) -> None:
        from silero_vad import load_silero_vad
        self._model = load_silero_vad()

    def detect(self, wav_path: str) -> list[SpeechSpan]:
        from silero_vad import get_speech_timestamps, read_audio
        wav = read_audio(wav_path, sampling_rate=16000)
        ts = get_speech_timestamps(wav, self._model, sampling_rate=16000)
        return [SpeechSpan(int(t["start"] / 16000 * 1000), int(t["end"] / 16000 * 1000)) for t in ts]
```

`worker/damwha_worker/models/pyannote_diar.py`:
```python
from .base import DiarSegment


class PyannoteDiarizer:
    def __init__(self, model: str, hf_token: str | None, device: str) -> None:
        import torch
        from pyannote.audio import Pipeline
        self._pipeline = Pipeline.from_pretrained(model, use_auth_token=hf_token)
        self._pipeline.to(torch.device("cpu" if device == "cpu" else device))

    def diarize(self, wav_path: str) -> list[DiarSegment]:
        ann = self._pipeline(wav_path)
        out = []
        for turn, _, label in ann.itertracks(yield_label=True):
            out.append(DiarSegment(label, int(turn.start * 1000), int(turn.end * 1000)))
        return out
```

`worker/damwha_worker/models/ecapa_embed.py`:
```python
from .base import DiarSegment


class EcapaEmbedder:
    def __init__(self, model: str, device: str) -> None:
        from speechbrain.inference.speaker import EncoderClassifier
        self._enc = EncoderClassifier.from_hparams(source=model, run_opts={"device": "cpu" if device == "cpu" else device})

    def embed(self, wav_path: str, segments: list[DiarSegment]) -> list[list[float]]:
        import soundfile as sf
        import torch
        audio, sr = sf.read(wav_path)
        out = []
        for seg in segments:
            a = audio[int(seg.start_ms / 1000 * sr):int(seg.end_ms / 1000 * sr)]
            emb = self._enc.encode_batch(torch.tensor(a).float().unsqueeze(0)).squeeze().tolist()
            out.append(emb)
        return out
```

`worker/damwha_worker/models/whisper_mlx.py` / `whisper_faster.py` — `transcribe(wav_path, language)->list[Word]`를 각 백엔드의 word 타임스탬프로 채운다(`mlx_whisper.transcribe(..., word_timestamps=True)` / `faster_whisper.WhisperModel(...).transcribe(..., word_timestamps=True)`), `Word(text, int(start*1000), int(end*1000), prob)`로 변환. 청크 처리는 `settings.stt_chunk_minutes` 기준으로 분할 후 오프셋 보정.

- [ ] **Step 3: Implement registry.py**

`worker/damwha_worker/models/registry.py`:
```python
from ..config import Settings
from ..pipeline.process_meeting import Models
from .ecapa_embed import EcapaEmbedder
from .pyannote_diar import PyannoteDiarizer
from .silero_vad import SileroVAD


def build_models(payload: dict, settings: Settings) -> Models:
    m = payload["models"]
    device = m["device"]
    if settings.whisper_backend == "mlx":
        from .whisper_mlx import MlxWhisper
        transcriber = MlxWhisper(m["whisper_model"])
    else:
        from .whisper_faster import FasterWhisper
        transcriber = FasterWhisper(m["whisper_model"], device=device)
    return Models(
        vad=SileroVAD(),
        diarizer=PyannoteDiarizer(m["diarization"]["model"], settings.hf_token, device),
        embedder=EcapaEmbedder(m["embedding"]["model"], device),
        transcriber=transcriber,
    )
```

- [ ] **Step 4: Implement download_models.py**

`worker/scripts/download_models.py` — `HF_TOKEN`으로 pyannote, Whisper, ECAPA, silero를 사전 캐시:
```python
import os

from damwha_worker.config import load_settings


def main() -> None:
    s = load_settings()
    from silero_vad import load_silero_vad
    load_silero_vad()
    from pyannote.audio import Pipeline
    Pipeline.from_pretrained(s.__dict__.get("diarization_model", "pyannote/speaker-diarization-3.1"),
                             use_auth_token=s.hf_token)
    from speechbrain.inference.speaker import EncoderClassifier
    EncoderClassifier.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb")
    print("models cached", os.environ.get("HF_HOME", "~/.cache/huggingface"))


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Local smoke test (수동, CI 아님)**

`worker/SMOKE.md`에 절차 기록 + 실행:
1. `cp .env.example .env` 후 `DATABASE_URL`/`HF_TOKEN`/`DEVICE` 설정, `WHISPER_MODEL`은 smoke용 `large-v3-turbo` 또는 더 가벼운 값.
2. `uv run python scripts/download_models.py` — 모델 캐시.
3. Plan 1 API를 띄우고(`npm run start:dev`) 짧은 2화자 wav를 `POST /meetings` 업로드 → `job(process_meeting, queued)` 생성.
4. `uv run python -m damwha_worker` — 워커가 job을 claim·처리.
5. 검증: `GET /meetings/:id` 가 화자 귀속 발언 타임라인을 반환(`status=done`, utterance 존재, 최소 1개 cluster/speaker_id). `GET /speakers` 등록 흐름도 동일하게 1건 smoke.

Expected: end-to-end로 발언 타임라인 생성. (이 단계는 환경 의존이라 CI 게이트가 아니다.)

- [ ] **Step 6: Commit**

```bash
git add worker/pyproject.toml worker/uv.lock worker/damwha_worker/models/*.py worker/scripts/download_models.py worker/SMOKE.md
git commit -m "feat(worker): real model adapters (silero/pyannote/ecapa/whisper) + registry + smoke"
```

---

## Self-Review

**Spec coverage** (design spec §→task):
- §1.1 단일 프로세스 순차 → Task 13 폴 루프. §1.2 reaper 경계 → Global Constraints(워커 reaper 없음).
- §1.3 ownership 모델(두 가드) → Task 5(job/meeting 가드) + Task 6(persist 두 가드 + lost/discard) + 모든 쓰기.
- §1.4 디렉터리 `worker/` → File Structure. §1.5 도구 → Task 1.
- §2 모델 경계(4 프로토콜 + fake) → Task 7. registry/실구현 → Task 14.
- §3 payload 계약 + schema_version(없으면 1, 미래 거절) → Task 0(zod) + Task 2(pydantic) + 공유 픽스처 계약 테스트.
- §4 파이프라인(normalize+probe/VAD/diar/embed/identify/STT/align/persist, 중간 meeting 쓰기 금지, 디스크 재사용) → Task 10,8,9,11.
- §5 persist 두 가드 + 폐기 → Task 6.
- §6 ErrorKind enum(PERMANENT/TRANSIENT, 미분류→TRANSIENT) → Task 4 + Task 13 제어.
- §7.1 상태 전이 표(done/failed/requeue/discard/lost-ownership) → Task 5,6,13 테스트.
- §7.2 stale 폐기 done+reason → Task 6 `discarded_by_stale_guard`.
- §7.3 enroll 상태전이(pending→ready/failed, 가드) → Task 6,12.
- §8 heartbeat 데몬 스레드 + 즉시 requeue + poll 간격 유지 + 로그 → Task 13.
- §9 설정/모델 다운로드 → Task 1(config) + Task 14(download script). §10 테스트 전략 → 각 태스크 + Task 14 smoke.
- §11 비목표 → 범위에서 제외(timed backoff/discarded enum/멀티워커).

**Placeholder scan:** 모든 코드 스텝에 실제 코드 포함. Task 14만 "골격 + 로컬 smoke"이며 이는 의도적(gated/heavy 모델, CI 불가)이고 명시됨.

**Type consistency:** `db.*` 시그니처는 Task 5/6에서 정의, Task 11/12/13이 동일 호출. `Models`(process_meeting.py)는 Task 11 정의, Task 13/14가 동일 사용. `Word`/`DiarSegment`/`SpeechSpan`(models/base.py, Task 7)을 align(8)·process_meeting(11)이 공유. `parse_payload`(Task 2)를 Task 13이 호출. `run_process_meeting`/`run_enroll_speaker`의 `normalize_fn`/`probe_fn` 주입 인자는 Task 11/12 정의 = Task 13 테스트 사용. persist 반환값 `"committed"|"discarded"|"lost"`는 Task 6 정의 = Task 11/13 일치.

**의존 그래프:** Task 0(TS, 독립) → 1(스캐폴드) → 2,3,4(병렬 가능) → 5 → 6 → 7 → 8,9,10(병렬 가능) → 11 → 12 → 13 → 14. 각 태스크는 독립 테스트 가능한 산출물로 끝난다.
