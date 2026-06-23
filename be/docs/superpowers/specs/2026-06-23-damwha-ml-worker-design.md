# Damwha 백엔드 — Phase 1 / Plan 2: Python ML 워커 설계

> 상태: 확정 (설계 합의 완료) · 작성일: 2026-06-23 · 대상: Plan 2 (Python ML 워커)
> 선행: Plan 1 (NestJS 인제스션 API, 완료) · 전체 스펙: `2026-06-22-damwha-ingestion-backend-design.md`

---

## 0. 이 문서의 범위

Damwha 인제스션 백엔드의 두 런타임 중 **Python ML 워커**를 다룬다. 워커는 HTTP를 모르고, Postgres `job` 테이블만 폴링해 오디오를 처리하고 결과 row(`utterance`/`meeting_cluster`/`voiceprint`)를 쓴다. NestJS API(Plan 1)와의 **유일한 접점은 `job` 테이블 스키마와 payload 계약**이다.

**범위에 포함:**
- `process_meeting` 파이프라인: ffmpeg 정규화+probe → VAD → diarization → 임베딩 → 화자식별 → STT → 정렬 → persist
- `enroll_speaker` 흐름: 임베딩 추출 → voiceprint 저장 + 화자 상태전이
- persist 짧은 트랜잭션 + stale 가드 *적용*(Plan 1은 enqueue 측만 구현)
- job claim/heartbeat/상태전이, 실패 분류·재시도 제어
- payload 계약(pydantic)의 zod 미러 + 계약 테스트
- 로컬 전용(클라우드/외부 네트워크 호출 금지)

**범위 밖:** Nest reaper(Plan 1 구현됨), 검색/렌즈(Phase 2·3), timed backoff(향후), 비파괴 머지(Phase 3).

---

## 1. 아키텍처 결정

### 1.1 프로세스 모델 — 단일 프로세스 · 순차 1-job

모델(pyannote 3.1 + Whisper + ECAPA)이 RAM에 상주하고, 전체 스펙(§1)이 "비동기 배치라 속도가 아닌 RAM이 스펙 바"(권장 16GB)라고 못박았다. 따라서 **한 번에 job 하나만 처리하는 단순 폴 루프**가 정답이다. 동시 처리는 RAM을 초과시키고 개인용 배치 부하에서 이득이 없어 기각한다.

```
poll loop:  claim 1 job (SKIP LOCKED) → dispatch by type → 결과 persist → sleep(POLL_INTERVAL) → 반복
            claim 실패(큐 비어있음) → sleep(POLL_INTERVAL) → 반복
```

### 1.2 책임 분리 — 회수는 Nest, 실행·가드판정은 Worker

- **Nest cron reaper (Plan 1, 이미 구현)** = stale lock **회수 + 크래시 경로 전파**의 유일한 주체. key: `job.status='running' AND locked_at < now() - REAPER_STALE_MINUTES`. `attempts < max_attempts`면 `queued`로 환원(락 해제), 아니면 `job.status='failed'` + 연관 `meeting.status='failed'`/`speaker.enrollment_status='failed'`까지 전파한다(코드: `reapStale`, `jobs.repository.ts:85-96`).
- **Worker** = **실행**과 **persist 시점 stale-결과 가드**(§5)의 주체. reaper는 워커의 이 persist-시점 결과 가드(`processing_version`/`current_job_id` 비교)는 **실행하지 않는다** — 둘의 경계는 "lock 회수·크래시 전파 = reaper / 결과 commit 판정 = worker"다.
- **워커는 자체 reaper를 두지 않는다.** 두 reaper가 같은 stale job을 동시에 회수하면 `locked_at`/`attempts`/`status` 갱신 경쟁이 생겨 ownership이 흐려진다. 단일 워커·개인용 규모에선 Nest reaper 하나로 충분하다.

### 1.3 Ownership 모델 — 공유 상태 쓰기는 전부 가드 (at-least-once 큐 안전 규칙)

`job` 큐는 at-least-once다(reaper requeue / transient requeue로 같은 job이 두 번 실행될 수 있고, 좀비 워커가 lock을 잃은 뒤에도 살아있을 수 있다). 따라서 **워커가 공유 상태(`job`/`meeting`/`speaker` row)에 하는 모든 쓰기는 ownership 가드를 달고, 영향 row=0이면 "ownership 상실 → 로컬 결과 폐기·중단"으로 처리한다.** 두 종류의 가드가 **서로 다른 경합**을 막으므로 둘 다 필요하다:

- **Job ownership 가드** — `WHERE id=:job_id AND locked_by=:worker_id AND status='running'`. **같은 job이 requeue→다른 워커 재claim**된 경합을 막는다(이 경우 `processing_version`/`current_job_id`는 양쪽이 동일해 meeting 가드로는 구분 불가). `heartbeat`/`set_stage`/`complete`/`fail`/`requeue`/`discard` 등 **모든 job 쓰기**에 적용.
- **Meeting 가드(stale-결과)** — `WHERE id=:meeting_id AND processing_version=:payload_pv AND current_job_id=:job_id`. **더 높은 버전의 reprocess job이 enqueue된** 경합을 막는다(전체 스펙 §6.3). persist 및 그 외 모든 meeting 쓰기에 적용.

워커 측 `db.py`의 SQL은 **전부 가드 포함**으로 구현하고(Plan 1 TS `complete`/`fail`/`set_stage`가 무가드인 것을 그대로 답습하지 않는다), 0-row를 "ownership 상실"로 해석한다. 가드 통과를 매 stage 경계(`set_stage`)에서도 검사하면 ownership을 잃은 좀비가 조기에 중단할 수 있다.

> Plan 1의 Nest `JobsRepository.complete()`/`fail()`/`setStage()`는 무가드(`WHERE id=$1`)지만, **정상 경로에서 이들을 호출하는 주체는 Python 워커이고 워커는 자체 가드 SQL을 쓴다** — Nest의 해당 메서드는 SQL 계약 테스트용이며 운영 경로에선 사용되지 않는다(enqueue/claim/reapStale만 Nest가 사용). Plan 1 코드를 수정하지는 않되, 이 비대칭을 알고 워커는 처음부터 가드한다.

### 1.4 디렉터리 — 같은 repo의 `worker/`

런타임 경계(`job` 테이블 외 접점 없음)는 repo 레이아웃과 무관하게 유지된다. 모노레포는 **계약 드리프트(zod↔pydantic)를 한 PR·한 CI에서 같은 픽스처로 차단**하는 이점이 있고, 단일 머신 공유 FS·공유 DB로 운영 생애주기가 이미 묶여 있어 자연스럽다. Python 도구는 전부 `worker/` 아래에 격리되어 Node 쪽과 간섭하지 않는다.

```
be/                              ← 기존 NestJS (Plan 1, 그대로)
  src/contracts/job-payload.schema.ts   ← schema_version 필드 추가 (§3.1, 계약 변경)
  worker/                        ← Plan 2 (Python)
    pyproject.toml               uv + ruff + pytest + pydantic v2 + psycopg3
    damwha_worker/
      __main__.py                폴 루프 진입점
      config.py                  env 로딩 (pydantic-settings)
      db.py                      raw SQL: claim/heartbeat/set_stage/complete/fail/requeue/discard
      contracts.py               pydantic payload (zod 미러) + schema_version 검증
      storage.py                 STORAGE_ROOT 키→경로 해석 (TS StorageService.resolve 규칙 미러)
      heartbeat.py               데몬 스레드: 활성 job locked_at 주기 갱신
      errors.py                  ErrorKind enum (PERMANENT/TRANSIENT) + 분류 (§6)
      models/
        base.py                  VAD/Diarizer/Embedder/Transcriber 프로토콜
        silero_vad.py  pyannote_diar.py  ecapa_embed.py
        whisper_mlx.py  whisper_faster.py     device별 Transcriber 2구현
        registry.py              payload.models + DEVICE로 실구현 선택
      pipeline/
        process_meeting.py       ffmpeg→vad→diar→embed→identify→stt→align→persist
        enroll_speaker.py        extract_embedding→enroll_persist
        ffmpeg.py                normalize(16k mono wav) + probe(ffprobe)
        align.py                 word→segment 중점 귀속 + 연속 화자 병합
        identify.py              centroid vs voiceprint 코사인 (pgvector)
    tests/
      conftest.py                testcontainers-python Postgres + Plan 1 마이그레이션 적용
      fakes.py                   Fake{VAD,Diarizer,Embedder,Transcriber} (픽스처 출력)
      fixtures/                  계약 JSON 픽스처 (be/ 계약 테스트와 공유)
    scripts/download_models.py   모델 사전 다운로드 (오프라인·첫 실행 지연 대비)
```

### 1.5 도구 — uv + ruff + pytest + pydantic v2 + psycopg3, ORM 없음

워커의 핵심은 job claim, 상태전이, stale 가드, vector query다 — ORM의 추상화 비용이 이득보다 크다. TS 쪽과 동일하게 raw SQL을 쓴다(`SKIP LOCKED`·pgvector).

---

## 2. 모델 경계 (테스트 가능성의 핵심)

네 개의 프로토콜로 ML을 추상화한다. **파이프라인 오케스트레이션은 프로토콜에만 의존**하므로, fake 구현으로 결정적 테스트가 가능하다.

| 프로토콜 | 시그니처(개념) | 실구현 |
|---|---|---|
| `VAD` | `detect(wav) -> [(start, end)]` | Silero |
| `Diarizer` | `diarize(wav) -> [(diar_label, start, end)]` | pyannote 3.1 (gated) |
| `Embedder` | `embed(wav, segments) -> [vec(192)]` | ECAPA (speechbrain) |
| `Transcriber` | `transcribe(wav, lang) -> [word{text,start,end,conf}]` | mlx-whisper(Apple) / faster-whisper(CUDA·CPU) |

- **모델 선택의 진실원은 payload** — `payload.models`(whisper_model·device·diarization·embedding)와 `payload.identify.threshold`를 쓴다. env는 인프라(캐시 경로/토큰/poll·heartbeat 간격)만 제공한다. 이로써 "이 job이 어떤 모델·설정으로 그 결과를 냈는지" 재현 가능하다(전체 스펙 §4).
- `registry.py`가 payload.models + DEVICE를 보고 실구현을 조립한다. device별 Transcriber 2구현을 공통 인터페이스 뒤에 둔다.

---

## 3. payload 계약 (pydantic ↔ zod)

### 3.1 schema_version (계약 변경 — 롤아웃 안전하게)

payload 구조 진화에 대비해 두 payload 최상위에 `schema_version: int`를 추가한다. **현재 지원 집합 `SUPPORTED = {1}`.**

- **롤아웃 위험과 대응**: 현재 zod 빌더는 `schema_version`을 방출하지 않으므로(`src/contracts/job-payload.schema.ts:16,25`), 워커가 *엄격히* 필수 검증하면 빌더 수정 전에 쌓인 기존 payload가 전부 `unsupported_payload_version`으로 거절된다. 이를 막기 위해 **양쪽 모두 "없으면 1" 기본값**을 쓴다 — 빌더 변경 배포 순서에 대한 하드 의존이 사라진다(방어적).
- **Nest 측(Plan 1 코드 소폭 수정, 워커 배포 전 선행 태스크)**: zod에 `schema_version: z.literal(1).default(1)` 추가, 빌더가 `schema_version: 1` 스탬프. 양쪽 빌더(`buildProcessMeetingPayload`/`buildEnrollSpeakerPayload`)에 대한 테스트 포함. `job.payload`는 jsonb라 **DB 마이그레이션 불필요**.
- **Worker 측**: pydantic `schema_version: int = 1`(없으면 1). `schema_version not in SUPPORTED`(=미래 버전)이면 job을 **영구오류 `unsupported_payload_version`**로 거절(§6) — payload가 바뀌어도 워커가 조용히 오작동하지 않고 명시적으로 거절한다. 없거나 1이면 정상 처리.

### 3.2 pydantic 모델 (zod 필드 1:1 미러)

```
ProcessMeetingPayload:
  schema_version: int = 1   # 없으면 1; SUPPORTED={1} 밖이면 unsupported_payload_version
  meeting_id: UUID
  audio_key: str (min_length 1)
  processing_version: int >= 0
  reprocess: bool
  models: { whisper_model: 'large-v3-turbo'|'large-v3', device: 'mps'|'cpu'|'cuda',
            language: str,
            diarization: { model: str, min_speakers: int|None, max_speakers: int|None },
            embedding: { model: str, dimension: int } }
  identify: { threshold: float }

EnrollSpeakerPayload:
  schema_version: int = 1   # 없으면 1; SUPPORTED={1} 밖이면 unsupported_payload_version
  speaker_id: UUID
  audio_key: str (min_length 1)
  embedding: { model: str, dimension: int }
```

### 3.3 계약 테스트

`worker/tests/fixtures/`의 **같은 JSON 픽스처**를 pydantic(worker)과 zod(be) 양쪽에서 검증한다. 드리프트가 생기면 한쪽 테스트가 깨진다.

---

## 4. process_meeting 파이프라인

claim 직후 `meeting.status='processing'`를 **가드(§1.3) 세팅** — `WHERE id=:mid AND current_job_id=:job_id AND processing_version=:payload_pv` (+ job ownership 확인). 0-row면 이미 ownership을 잃은 것이므로 즉시 중단. 각 stage 진입 시 `set_stage`(job 가드 포함)로 `job.stage`/`progress`를 갱신한다(stage 값은 전체 스펙 §3.2 CHECK 목록 준수; set_stage가 0-row면 ownership 상실 → 중단).

> **중간 meeting 쓰기 금지(§1.3):** 파이프라인 도중에는 `normalized_key`/`duration_ms`를 meeting에 쓰지 않는다 — 이 값들은 §5의 가드된 persist TX 안에서만 기록한다(좀비/stale 워커가 가드 밖에서 meeting을 건드리는 창을 없앤다).

1. **`ffmpeg` normalize + probe** — `normalized.wav`(16kHz mono) 생성. **재사용은 파일시스템 존재 여부로 판단**(`storage.resolve(normalized_key)`가 디스크에 있으면 재정규화 생략) — DB 컬럼이 아니라 디스크를 진실원으로 본다. **ffprobe로 실제 오디오 검증 + `duration_ms` 산출**(값은 메모리에 들고 persist TX에서 기록). Plan 1에서 이월된 입력검증의 최종 관문 — 손상/위장/미지원 파일이면 **영구오류**(`corrupt_audio`/`unsupported_format`/`probe_failed`).
2. **VAD** (Silero) → 발화 구간.
3. **Diarize** (pyannote 3.1) → `diar_label` 부여된 세그먼트.
4. **Embed** (ECAPA) → 세그먼트 임베딩 → `diar_label`별 centroid(L2 정규화 평균).
5. **Identify** (`identify.py`) — centroid vs `voiceprint` 코사인. 비교 대상 필터: **현재 `model`+`dimension` 일치 AND 소속 speaker `enrollment_status='ready'`** 만(전체 스펙 §10). `threshold` 넘으면 `speaker_id` 부여, 아니면 미식별로 두고 `meeting_cluster`(centroid·diar_label) 보존. 미식별 화자를 speaker로 강제 생성하지 않는다.
6. **STT** (Whisper, payload 모델, **25분/안전마진 청크**) → word 타임스탬프.
7. **Align** (`align.py`) — **word 중점(midpoint)이 속한 diar 세그먼트의 화자에 귀속 → 연속 동일화자 word 병합 → utterance 구성**(whisperX 방식). `order_index` 순번 부여. 무음 구간은 `status='silence'`, STT 실패 청크 구간은 `status='transcribe_failed'`+`transcript_error={code,message}`로 남기고 **파이프라인 중단 없이 계속**(추적성). status는 `status` 컬럼으로만 판별 — confidence 의미에 의존하지 않는다.
8. **Persist** (§5).

---

## 5. persist 트랜잭션 — 두 가드 + 폐기 경로

**짧은 단일 트랜잭션, ML 처리는 트랜잭션 밖.** 결과 반영만 원자화한다(긴 처리 동안 DB 커넥션 점유 방지). §1.3의 **두 ownership 가드를 한 TX 안에서** 적용한다 — job 가드(같은-job 재claim 경합)와 meeting 가드(reprocess 경합)는 서로 다른 경합을 막으므로 둘 다 필요하다.

```sql
BEGIN;

-- (1) Job ownership 가드: 이 job의 lock을 내가 아직 쥐고 있는가?
--     requeue→다른 워커 재claim, 또는 reaper 회수 시 여기서 0-row.
SELECT 1 FROM job
  WHERE id = :job_id AND locked_by = :worker_id AND status = 'running'
  FOR UPDATE;
-- 0-row → ROLLBACK, 결과 전부 폐기·중단 (meeting/utterance 무변경, job도 건드리지 않음
--          — 정당한 소유자가 따로 있다).

-- (2) Meeting 가드(stale-결과): 이 job이 아직 meeting의 현재 job인가?
UPDATE meeting
  SET status = 'done', error = NULL,
      normalized_key = :normalized_key, duration_ms = :duration_ms
  WHERE id = :meeting_id
    AND processing_version = :payload_processing_version
    AND current_job_id = :job_id;
```

- **(2)의 영향 row = 1 → 반영**: 기존 `utterance`·`meeting_cluster` **DELETE** → 새 row **INSERT**(`processing_version`·`job_id` 스탬프). job `status='done'`(같은 TX, job 가드 포함). `COMMIT`.
- **(2)의 영향 row = 0 → stale 폐기**: 더 높은 버전 reprocess job이 enqueue된 것. **`meeting`/결과는 무변경**, 이 job만 `status='done'` + discard reason 기록(§7.2). `COMMIT`(job 표기만 커밋).
- **(1)에서 중단**: 아무것도 쓰지 않고 ROLLBACK — 이 job의 lock을 잃었으므로(좀비) job 표기조차 하지 않는다. 새 소유 워커가 책임진다.

> `normalized_key`/`duration_ms`도 이 가드된 UPDATE 안에서만 기록된다(§4) — 모든 meeting 쓰기가 가드를 통과한다. Phase 1은 과거 결과를 보존하지 않는다(덮어쓰기). 스탬프는 ① stale 가드와 ② Phase 3 비파괴 머지의 토대로만 쓴다.

---

## 6. 실패 분류 — 코드 레벨 enum

문자열 예외 매칭은 금세 흐트러지므로, `errors.py`에 분류를 enum으로 고정한다.

```
ErrorKind = PERMANENT | TRANSIENT

PERMANENT (재시도 안 함, 즉시 fail):
  corrupt_audio, unsupported_format, probe_failed, unsupported_payload_version
TRANSIENT (attempts 남으면 requeue):
  model_load_failed, oom, io_error, db_error
```

각 파이프라인 예외는 명시적으로 `ErrorKind`로 매핑된다. `job.error` jsonb = `{ code, message, stage, kind, traceback? }`. 분류되지 않은 예외는 보수적으로 **TRANSIENT**로 취급(일시적일 수 있으니 재시도 기회를 준다) 후 로그에 미분류 경고.

---

## 7. 상태 전이 (명문화 — Nest·Worker 불일치 방지)

### 7.1 job 상태 머신

모든 워커 쓰기는 §1.3 ownership 가드를 단다.

| from | event | to | 부수효과 |
|---|---|---|---|
| `queued` | worker claim (SKIP LOCKED) | `running` | `attempts++`, `locked_by`/`locked_at` 세팅 (Plan 1 claim) |
| `running` | persist 성공 (job 가드 + meeting 가드 통과) | `done` | `meeting.status='done'`, `normalized_key`/`duration_ms` 기록 (같은 TX, §5) |
| `running` | enroll_persist 성공 (job + speaker 가드 통과) | `done` | `speaker.enrollment_status='ready'` (같은 TX) |
| `running` | **meeting 가드 0-row** (reprocess가 추월) | `done` | **discard reason 기록, meeting 무변경** (§5, §7.2) |
| `running` | **job 가드 0-row** (lock 상실: 재claim/reaper) | (전이 없음) | **아무것도 쓰지 않고 중단** — 정당한 소유 워커가 책임 |
| `running` | PERMANENT 오류 | `failed` | `meeting.status='failed'`/`speaker.enrollment_status='failed'` + error (job 가드 하) |
| `running` | TRANSIENT 오류, `attempts < max_attempts` | `queued` | 락 해제(`locked_by`/`locked_at`=NULL, job 가드 하), 다음 poll에서 재claim |
| `running` | TRANSIENT 오류, `attempts >= max_attempts` | `failed` | `meeting`/`speaker` failed + error |
| `running` | **워커 크래시** (락 stale) | (Nest reaper가 처리) | reaper: `queued` 환원 또는 `failed`+연관 failed (§1.2) |

### 7.2 stale 폐기 표기 (현재 enum 유지)

job enum에 `discarded`를 추가하지 않는다(스키마 변경 회피). 대신:
- job `status='done'`
- `job.error = { code: 'discarded_by_stale_guard', message, stage: 'persist', kind: null }` (reason 표기)
- `meeting`은 무변경

> 장기적으로는 `job.status`에 `discarded`(또는 `stale_discarded`)를 추가하면 운영자가 "결과 반영 완료(done)"와 "stale로 폐기"를 혼동하지 않아 더 정확하다. Phase 1은 `done` + discard reason으로 충분.

### 7.3 enroll_speaker 흐름

`extract_embedding`(ffmpeg normalize 샘플 → ECAPA 임베딩 + 품질 점수) → `enroll_persist`(단일 TX, §1.3 가드: **job ownership**(`locked_by=worker AND status='running'`) **AND speaker ownership**(`speaker.current_job_id = job.id`) 둘 다 통과할 때만 `voiceprint` INSERT(source='enroll', model·dimension 메타) + `speaker.enrollment_status='ready'`). 실패 시 `enrollment_status='failed'` + `enrollment_error`. **이 정상 상태전이는 워커 책임**(Plan 1이 워커로 이월). 식별은 `ready` 화자만 비교하므로 실패 화자는 식별에 영향 없음.

---

## 8. heartbeat & 재시도 운영

- **heartbeat**: 긴 동기 추론(diar/STT)이 스레드를 블록하므로 **별도 데몬 스레드**가 `HEARTBEAT_INTERVAL`마다 활성 job의 `locked_at`을 갱신한다 — reaper가 살아있는 워커를 stale로 오인하지 않게.
- **재시도(requeue)**: TRANSIENT + `attempts < max_attempts`면 즉시 `queued` 환원. **timed backoff 없음**(현재 스키마에 `next_attempt_at` 없음). 다만:
  - requeue 후에도 **poll interval은 그대로 적용**(모델 로드/디스크 IO 장애가 빠르게 같은 실패를 반복하는 것을 약하게 완화).
  - 연속 실패 시 로그에 **`attempt/max_attempts` + `error_kind` + `stage`**를 명확히 남긴다.
  - 향후 스키마 변경이 가능해지면 `next_attempt_at` + exponential backoff로 확장한다.

---

## 9. 설정 & 모델 다운로드

env(`pydantic-settings`):
- 인프라: `DATABASE_URL`, `STORAGE_ROOT`(Nest와 공유 FS), `WORKER_ID`, `HF_TOKEN`, 모델 캐시 경로
- 동작: `WHISPER_BACKEND`/`DEVICE`(payload.device의 fallback), `POLL_INTERVAL`, `HEARTBEAT_INTERVAL`, `REAPER_STALE_MINUTES`(heartbeat가 그보다 충분히 짧아야 함), `STT_CHUNK_MINUTES`

`scripts/download_models.py` — pyannote(게이트, `HF_TOKEN`+라이선스 동의)·Whisper·ECAPA를 사전 캐시. 첫 실행 지연·오프라인 대비.

시스템 의존: **ffmpeg/ffprobe 바이너리**. 권장 스펙: Apple Silicon(M1+) + 16GB RAM.

---

## 10. 테스트 전략 (TDD)

- **결정적 테스트 (CI: real Postgres via testcontainers-python + fake 모델)** — 버그가 사는 glue를 전부 커버:
  - `align` 알고리즘(중점 귀속·연속 병합·경계·무음·STT 실패 청크)
  - `identify` 코사인 + `model`/`dimension`/`ready` 필터
  - persist DELETE/INSERT 원자성 + **두 가드(§1.3)**:
    - **meeting 가드 0-row**(reprocess가 pv/current_job_id 추월) → job done+reason, meeting·결과 무변경
    - **job 가드 0-row**(같은 job requeue→다른 워커 재claim, 또는 reaper 회수) → **아무 쓰기 없이 중단**, 정당한 소유 워커만 commit
    - 중간 meeting 쓰기 부재 검증: 파이프라인 도중 `normalized_key`/`duration_ms`/`status`가 가드 밖에서 바뀌지 않는지
  - 상태 전이 표(§7.1) 전 경로 — done/failed/requeue/discard/lost-ownership-abort
  - 실패 분류 enum(§6) — PERMANENT→fail, TRANSIENT→requeue/fail, 미분류→TRANSIENT
  - `schema_version` — 없음→1 수용, 1 수용, 2(미래)→`unsupported_payload_version` 거절(§3.1)
  - enroll TX 상태전이(pending→ready / pending→failed)
  - heartbeat가 `locked_at`을 갱신하는지
- **계약 테스트**: pydantic이 zod와 **같은 JSON 픽스처**(§3.3)로 검증, schema_version 포함.
- **실모델 smoke (로컬 수동, CI 제외)**: 짧은 2화자 샘플 end-to-end, `HF_TOKEN` + tiny whisper. gated·비결정·속도 때문에 CI에 넣지 않는다.

---

## 11. 비목표 (Plan 2에서 제외)

- Nest reaper 구현(Plan 1 완료) · 검색/렌즈(Phase 2·3)
- timed backoff(`next_attempt_at`) · job `discarded` 상태 — 향후 스키마 변경 시
- 비파괴 재추출 머지 · 멀티워커 동시처리 · 멀티 임베딩 모델 차원 분리
- 클라우드/외부 네트워크 호출 (로컬 전용 전제)
