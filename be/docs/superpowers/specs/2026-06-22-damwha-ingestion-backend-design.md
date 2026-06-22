# Damwha 백엔드 — Phase 1: 인제스션 백엔드 설계

> 상태: 확정 (설계 합의 완료) · 작성일: 2026-06-22 · 대상: Phase 1 (전체 백엔드 단계 분해 중 첫 스펙)

---

## 0. 이 문서의 범위

Damwha는 "누가 언제 무슨 말을 했는지"를 화자 단위로 기록·검색하는 개인용 회의 기록 플랫폼이다(서비스 개념 정의서 v0.6 참조). 백엔드는 한 번에 구축할 수 없는 크기라 페이즈로 분해하며, **이 문서는 첫 페이즈인 "인제스션 백엔드"만 다룬다.**

| # | 이름 | 범위 | 산출물 |
|---|---|---|---|
| **1** | **인제스션 백엔드** (이 문서) | NestJS 스켈레톤 + PG 스키마/마이그레이션 + PG 작업 큐 + 오디오 업로드 + Python 워커 파이프라인(VAD→diarization→화자식별→STT→정렬) + 화자 등록(성문) | 업로드한 회의가 **화자 귀속된 발언 타임라인**으로 저장·조회됨 |
| 2 | 검색 | FTS(한국어) + 의미검색(BGE-m3→pgvector) + 복합검색 API + 저장 검색(=주제 렌즈) | 복합 검색 |
| 3 | 렌즈·추출 | 로컬 LLM 추출(액션아이템·결정·약속) + 출처/비파괴 재추출 머지 + 회의별/전역 뷰 | 모아보기 렌즈 |
| 후 | 확장 | 공유·내보내기 가드레일, 회의 그래프 | 초기 범위 밖 |

발언 점프·화자별 타임라인은 Phase 1 데이터 모델 위에서 프론트가 그리는 것이므로, 백엔드는 그 데이터를 정확히 제공하는 것까지가 책임이다.

---

## 1. 공통 스택 결정 (전 페이즈 공유)

| 영역 | 선택 | 근거 |
|---|---|---|
| API/비즈니스 | **NestJS (TypeScript)**, REST | 구조화된 모듈/DI, 프론트(웹)와 언어 공유, 개인용 규모에 가볍고 빠름 |
| 데이터 | **Postgres + pgvector + 내장 FTS** | 관계형·벡터·키워드를 한 DB로 통합. 개인용 규모에서 운영·백업·일관성 최단. 추후 분리 가능 |
| 오디오 저장 | **로컬 FS** (추후 MinIO) | 자체서버·로컬 전용 전제 |
| 작업 큐 | **Postgres `jobs` 테이블** (`FOR UPDATE SKIP LOCKED`) | 추가 인프라(Redis/브로커) 없이 Nest↔Python 연동. 개인용 부하에 충분 |
| ML 워커 | **Python**, device 추상화(MPS/CPU/CUDA), 비동기 배치 | diarization·임베딩·STT는 Python 생태계. 실시간 아닌 배치라 속도보다 RAM이 스펙 바 |
| STT | **로컬 Whisper**, env로 `large-v3-turbo`/`large-v3` 전환 | 프라이버시 전제(오디오 외부 유출 없음) 유지. 한국어 품질 |
| 임베딩(성문) | ECAPA-TDNN 등 로컬 모델 | 로컬 전용 |

**핵심 전제 (개념 정의서 8장):** 단일 사용자 · 자체서버 · **로컬 전용** — 오디오/성문/텍스트가 사용자 통제를 벗어나지 않는다. 이것이 성문 저장의 법적 위험을 낮추는 근거이며, 공유·내보내기(후속 페이즈)가 이 전제를 깨는 유일한 경계선이다.

---

## 2. 서비스 토폴로지

세 프로세스 + 하나의 공유 DB. 추가 인프라 없음.

```
┌─────────────┐   HTTP    ┌──────────────────┐
│  Frontend   │ ───────▶  │  NestJS API      │
└─────────────┘           │  (REST)          │
                          └────────┬─────────┘
                                   │ SQL (enqueue job, read/write)
                                   ▼
                          ┌──────────────────┐
                          │   Postgres       │  ← jobs 테이블이 계약(contract)
                          │  + pgvector      │
                          └────────┬─────────┘
                                   │ poll (FOR UPDATE SKIP LOCKED)
                                   ▼
                          ┌──────────────────┐
                          │  Python Worker   │  VAD→Diar→ID→STT→정렬
                          │  (device 추상화)  │  models: pyannote, whisper
                          └────────┬─────────┘
                                   │ reads / writes
                                   ▼
                       로컬 FS (오디오 원본 + 정규화 wav)
```

**경계와 책임 (독립적으로 이해·테스트·교체 가능한 단위):**

- **NestJS API** — HTTP만 안다. ML을 전혀 모른다. 메타데이터 CRUD, 파일 저장, job enqueue, 상태/결과 서빙.
- **Python Worker** — HTTP를 모른다. `jobs` 테이블을 폴링해 오디오를 처리하고 결과 row를 쓴다.
- **둘의 유일한 접점 = `jobs` 테이블 스키마**(payload/status/stage). 이걸 계약으로 고정하면 양쪽을 독립 개발·테스트·교체할 수 있다.

---

## 3. 데이터 모델 (Postgres)

### 3.1 엔티티 개요

```
speaker            등록된 사람(화자 프로필)
voiceprint         화자의 성문 벡터 (1인 N개)
meeting            회의 1건
utterance          ★ 1급 객체 — 발언
meeting_cluster    회의 내 미식별 화자 클러스터 (나중에 사람으로 연결)
job                ★ Nest↔Python 계약
```

### 3.2 DDL (개념 스키마 — 마이그레이션의 기준)

```sql
-- 등록된 사람
CREATE TABLE speaker (
  id                uuid PRIMARY KEY,
  name              text NOT NULL,
  enrollment_status text NOT NULL DEFAULT 'pending'
                      CHECK (enrollment_status IN ('pending','ready','failed')),
  current_job_id    uuid,                   -- enroll_speaker job 추적 (FK는 아래 ALTER)
  enrollment_error  jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- 'pending'=성문 추출 대기/진행, 'ready'=voiceprint 1개 이상, 'failed'=추출 실패

-- 성문 벡터 (한 화자에 여러 샘플 누적 가능 → 식별 robust)
CREATE TABLE voiceprint (
  id                uuid PRIMARY KEY,
  speaker_id        uuid NOT NULL REFERENCES speaker(id) ON DELETE CASCADE,
  embedding         vector(192) NOT NULL,
  model             text NOT NULL,           -- 비교 필터용
  dimension         int  NOT NULL,           -- 비교 필터용
  sample_duration_ms int,
  quality_score     real,
  source            text,                    -- 'enroll' | 'cluster_resolve'
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- 식별 시 현재 model+dimension 일치 row만 비교
CREATE INDEX ON voiceprint (model, dimension);
CREATE INDEX ON voiceprint USING hnsw (embedding vector_cosine_ops);

-- 회의 1건
CREATE TABLE meeting (
  id                 uuid PRIMARY KEY,
  title              text,
  original_filename  text,                   -- 표시용. 신뢰/경로로 사용 금지
  audio_key          text NOT NULL,          -- 상대 스토리지 키. 절대경로 금지
  normalized_key     text,                   -- 정규화 wav 키
  recorded_at        timestamptz,
  duration_ms        int,
  status             text NOT NULL DEFAULT 'uploaded'
                       CHECK (status IN ('uploaded','processing','done','failed')),
  current_job_id     uuid,                   -- 상태 조회 단순화 (FK는 아래 ALTER)
  processing_version int NOT NULL DEFAULT 0,
  error              jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- 회의 내 미식별 화자 클러스터
CREATE TABLE meeting_cluster (
  id                  uuid PRIMARY KEY,
  meeting_id          uuid NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  diar_label          text NOT NULL,         -- 'SPEAKER_00'
  centroid            vector(192),
  resolved_speaker_id uuid REFERENCES speaker(id),
  processing_version  int NOT NULL,
  job_id              uuid,
  UNIQUE (meeting_id, diar_label)
);

-- ★ 발언 — 1급 객체
CREATE TABLE utterance (
  id                 uuid PRIMARY KEY,
  meeting_id         uuid NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  speaker_id         uuid REFERENCES speaker(id),   -- NULL = 미식별
  diar_label         text NOT NULL,                 -- 원시 클러스터 라벨
  start_ms           int NOT NULL,
  end_ms             int NOT NULL,
  text               text,                          -- 실패/무음 시 NULL
  confidence         real,
  status             text NOT NULL DEFAULT 'ok'
                       CHECK (status IN ('ok','silence','transcribe_failed')),
  transcript_error   jsonb,                         -- transcribe_failed일 때 {code,message}
  order_index        int NOT NULL,
  processing_version int NOT NULL,
  job_id             uuid,
  UNIQUE (meeting_id, order_index)
);

-- ★ Nest↔Python 계약
CREATE TABLE job (
  id           uuid PRIMARY KEY,
  type         text NOT NULL CHECK (type IN ('process_meeting','enroll_speaker')),
  meeting_id   uuid REFERENCES meeting(id) ON DELETE CASCADE,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','done','failed')),
  stage        text CHECK (stage IN
                 -- process_meeting 흐름
                 ('vad','diarize','identify','stt','align','persist',
                 -- enroll_speaker 흐름
                  'extract_embedding','enroll_persist')),
                 -- queued=NULL, running/done/failed=마지막 도달 stage
                 -- type↔stage 유효 조합은 앱 계층(zod/pydantic)에서 검증
  progress     smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  locked_by    text,
  locked_at    timestamptz,
  error        jsonb,                         -- { code, message, stage, traceback? }
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON job (status, created_at);

-- 스탬프/상태 FK — meeting↔job 순환 참조라 테이블 생성 후 ALTER로 건다.
-- 모두 nullable + ON DELETE SET NULL: job row가 정리돼도 본체 데이터는 보존.
ALTER TABLE meeting        ADD FOREIGN KEY (current_job_id) REFERENCES job(id) ON DELETE SET NULL;
ALTER TABLE speaker        ADD FOREIGN KEY (current_job_id) REFERENCES job(id) ON DELETE SET NULL;
ALTER TABLE meeting_cluster ADD FOREIGN KEY (job_id)        REFERENCES job(id) ON DELETE SET NULL;
ALTER TABLE utterance      ADD FOREIGN KEY (job_id)         REFERENCES job(id) ON DELETE SET NULL;
```

### 3.3 설계 포인트

- **발언(utterance)이 화자·시점(start/end_ms)·원문(text)·맥락(order_index)에 모두 연결** — 개념 정의서 4장의 추적성이 데이터 레벨에서 보장된다.
- **미식별 화자를 버리지 않는다.** `diar_label` + `meeting_cluster`로 보존했다가 나중에 사람으로 연결(점진적 식별). speaker_id를 억지로 생성하지 않는다.
- **버전·job_id 스탬프**(`processing_version`, `job_id`)는 *현재 row가 어느 job/버전 산출물인지*를 표시한다. **Phase 1은 현재 결과만 유지하고 과거 결과는 보존하지 않는다**(재처리 시 기존 row DELETE). 즉 이 스탬프는 과거 이력 추적용이 아니라, ① stale persist 가드(§6.3)와 ② Phase 3 비파괴 머지의 *토대*로만 쓴다. 진짜 이력 보존이 필요하면 Phase 3에서 `is_current`/`superseded_at` 또는 별도 snapshot 전략을 도입한다.
- **enum은 Postgres 네이티브 enum 대신 text + CHECK** — 진화(값 추가)가 쉽다.
- **스탬프 FK**(`current_job_id`, `job_id`)는 ON DELETE SET NULL로 건다 — 무결성은 지키되 job 정리가 본체 데이터를 지우지 않게 한다.

---

## 4. `jobs` 계약 (Nest↔Python 단일 진실원)

payload는 **enqueue 시점에 스냅샷**한다 — 워커 env가 아니라 job에 박아 넣어 재현성을 확보한다(이 job이 어떤 모델·설정으로 그 결과를 냈는지 추적 가능). env는 기본값을 제공하고, Nest가 그 값을 payload로 스냅샷한다.

payload는 **양쪽 앱에서 스키마 검증**한다 — Nest=zod, Python=pydantic. 동일 픽스처로 계약 테스트해 드리프트를 차단한다.

```jsonc
// type = process_meeting
{
  "meeting_id": "uuid",
  "audio_key": "meetings/<uuid>/original.m4a",   // 상대 스토리지 키 (절대경로 금지)
  "processing_version": 2,                         // 이 job이 생성할 목표 버전
  "reprocess": true,
  "models": {
    "whisper_model": "large-v3-turbo",             // 또는 "large-v3"
    "device": "mps",                               // "mps" | "cpu" | "cuda"
    "language": "ko",
    "diarization": {
      "model": "pyannote/speaker-diarization-3.1",
      "min_speakers": null, "max_speakers": null
    },
    "embedding": {
      "model": "speechbrain/spkrec-ecapa-voxceleb",
      "dimension": 192
    }
  },
  "identify": { "threshold": 0.70 }
}

// type = enroll_speaker
{
  "speaker_id": "uuid",
  "audio_key": "speakers/<uuid>/sample.wav",
  "embedding": { "model": "...", "dimension": 192 }
}
```

`error`도 jsonb로 `{ code, message, stage, traceback? }` — 단계별 분류·재시도 판단에 사용한다.

---

## 5. 데이터 흐름

### 5.1 업로드 → 처리 → 조회

1. `POST /meetings` (multipart: 오디오 + 메타) → 파일을 내부 UUID 키로 FS 저장, `meeting(status=uploaded)` 생성, `job(process_meeting, queued)` insert, `meeting.current_job_id` 설정 → meeting id 반환
2. **Worker 루프**: `SKIP LOCKED`로 job 1건 claim → 단계별 실행 (각 단계 끝에 `job.stage/progress` 갱신, meeting.status 함께 갱신):
   - `ffmpeg`로 16kHz mono wav 정규화
   - **VAD**(Silero) → 발화 구간
   - **Diarization**(pyannote 3.1) → 클러스터 라벨 부여
   - **임베딩**(ECAPA) → 클러스터 centroid
   - **식별**: centroid vs `voiceprint`(현재 model+dimension 일치분) 코사인 유사도, 임계치 넘으면 `speaker_id` 부여, 아니면 미식별 + `meeting_cluster` 저장
   - **STT**(Whisper, payload의 모델): 청크(25분/안전 마진) 처리, word 타임스탬프
   - **정렬**: STT 텍스트를 화자 구간에 매핑 → utterance 데이터 구성
   - **persist** (짧은 트랜잭션): 결과 반영만 원자화 (§6.3 참조)
3. `GET /meetings/:id` → 회의 + 화자 귀속 발언 타임라인 (프론트의 화자 타임라인/발언 점프의 원천 데이터)

### 5.2 화자 등록(성문)

`POST /speakers` (이름 + 샘플 오디오) → `speaker(enrollment_status='pending')` 생성 + `job(enroll_speaker, queued)` + `speaker.current_job_id` 설정 → Worker가 `extract_embedding`→`enroll_persist`로 임베딩 추출·`voiceprint` 저장 후 `speaker.enrollment_status='ready'`. 실패 시 `'failed'` + `enrollment_error` 기록.

> 비동기라 "이름은 있는데 성문 없음" 중간 상태가 존재한다. `enrollment_status`로 이를 명시적으로 드러내며, 식별(§5.1 식별 단계)은 `enrollment_status='ready'`인 화자의 voiceprint만 비교 대상으로 삼는다. `GET /speakers/:id`로 상태 폴링.

### 5.3 점진적 식별 (미식별 클러스터 → 사람)

`POST /meetings/:id/clusters/:clusterId/resolve {speaker_id | new_name}` = **단일 짧은 트랜잭션**. 경로 식별자는 `diar_label`이 아니라 **`meeting_cluster.id`(clusterId)** 를 쓴다 — 라벨 포맷 변화/특수문자로 인한 URL 인코딩·라우팅 문제를 피한다.
- cluster(`:clusterId`)에 `resolved_speaker_id` 설정
- 해당 meeting에서 그 cluster의 `diar_label`과 일치하는 utterance.speaker_id **일괄 UPDATE**
- (옵션) 그 centroid를 새 `voiceprint`(source='cluster_resolve')로 등록 → **다음 회의부터 자동 식별 정확도 향상**

---

## 6. 상태·동시성·재처리 정책

### 6.1 attempts 증가 시점

**claim(queued→running) 시 `attempts = attempts + 1`.** 워커가 죽어도 1회 시도로 카운트되어 reaper의 무한 재시도를 막는다. claim은 한 쿼리로 status·locked_by·locked_at·attempts를 원자적으로 갱신한다.

claim은 `stage`를 고정하지 않는다(type마다 첫 단계가 다름). 워커가 각 단계에 진입할 때 `stage`를 직접 갱신한다 — `process_meeting`은 `vad`부터, `enroll_speaker`는 `extract_embedding`부터.

```sql
UPDATE job SET status='running', locked_by=$worker, locked_at=now(),
               attempts = attempts + 1, updated_at=now()
WHERE id IN (
  SELECT id FROM job WHERE status='queued'
  ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
)
RETURNING *;   -- 워커는 RETURNING된 type을 보고 첫 stage를 정한다
```

### 6.2 stale lock reaper (워커 장애 복구)

워커가 죽어도 job이 영원히 멈추지 않도록:
- 긴 단계 동안 워커가 `locked_at`을 주기적 **heartbeat** 갱신.
- **Reaper**(워커 루프 틱마다 + NestJS 스케줄 백업): `status='running' AND locked_at < now() - interval '30 min'`인 job을 → `attempts < max_attempts`면 `status='queued'`로 환원(이미 attempts는 claim 시 증가됨), 아니면 `status='failed'` + error 기록.

### 6.3 재처리 (reprocess) — 트랜잭션 범위

ML 전체를 트랜잭션으로 감싸지 않는다(긴 처리 동안 DB 커넥션 점유 방지):
- **API enqueue 시 (짧은 TX)**: `meeting.processing_version` bump + job 생성 + `current_job_id` 갱신.
- **ML 파이프라인**: 트랜잭션 밖에서 실행.
- **Worker `persist` 단계만 (짧은 TX)**: 해당 meeting의 기존 utterance·meeting_cluster DELETE + 새 버전 INSERT + `meeting.status=done` — **결과 반영만 원자화**. (Phase 1은 과거 결과 미보존 — §3.3.)
- **stale 가드 (강화)**: persist TX는 다음 조건을 만족할 때만 반영하고, 아니면 **결과를 폐기**한다 — 더 높은 버전 job이 `queued`/`running`인 동안 낮은 버전 job이 뒤늦게 덮어쓰는 경합을 막는다:

  ```sql
  -- persist 진입 시 가드 (이 UPDATE의 영향 row=0이면 자기 결과 폐기)
  UPDATE meeting SET status='done', error=NULL
  WHERE id = :meeting_id
    AND processing_version = :payload_processing_version
    AND current_job_id = :job_id;
  ```
  즉 `meeting.processing_version = payload.processing_version` **AND** `meeting.current_job_id = job.id`. 둘 중 하나라도 어긋나면(더 새 job이 enqueue됨) 이 job의 산출물은 버린다.
- reprocess는 `meeting.status ∈ {done, failed}`에서만 허용.

### 6.4 meeting.status

`meeting.status`는 **denormalized 저장**한다 — 워커/job 업데이트 시 **항상 함께 갱신**. 상태 조회는 `meeting.current_job_id`로 단순화한다. job=failed → meeting=failed + error 표면화.

---

## 7. 에러 처리

- **재시도**: 일시 오류(모델 로드 실패, OOM 추정, ffmpeg 일시 실패)는 `attempts < max_attempts`까지 backoff 재시도. 영구 오류(손상 파일, 미지원 포맷)는 즉시 `failed` + `error.code`로 구분.
- **부분 실패**: STT가 특정 청크에서 실패해도 파이프라인을 중단하지 않는다. 해당 구간 utterance를 `status='transcribe_failed'`, `text=NULL`, `transcript_error={code,message}`로 남기고 계속한다(추적성 유지). 무음 구간은 `status='silence'`. **confidence 값 의미에 의존하지 않는다** — 상태는 `status` 컬럼으로 판별.
- **입력 검증**: 업로드 시 MIME/확장자/크기 한도, ffmpeg probe로 실제 오디오 여부 확인 후 정규화. 실패 시 meeting 생성 거부(400).
- **화자 등록 실패**: `enroll_speaker` job이 최종 실패하면 speaker row를 삭제하지 않고 `enrollment_status='failed'` + `enrollment_error`로 남긴다(재시도 가능). 식별은 `ready` 화자만 대상으로 하므로 실패한 화자는 식별에 영향 없음.
- **상태 일관성**: §6.4. reprocess는 done/failed에서만 허용.

---

## 8. 파일 경로 안전

- DB엔 **상대 스토리지 키만** 저장(`meetings/<uuid>/original.<ext>`). 절대경로·업로드 원본 파일명은 신뢰하지 않는다.
- 업로드 원본 파일명은 `meeting.original_filename`에 **표시용**으로만 보관.
- 저장 경로 = `STORAGE_ROOT` + 내부 UUID 기반 키. 해석 시 정규화 후 `STORAGE_ROOT` 밖이면 거부(path traversal 차단).
- 키→경로 해석은 **StorageService 한 곳**에서만. API가 임의 경로를 read 하지 못한다.
- `GET /meetings/:id/audio`는 StorageService를 통해서만 파일을 열고 Range 요청을 지원(발언 점프 재생).

---

## 9. API 표면 (REST, 단일 사용자라 인증 최소)

```
POST   /meetings                      업로드 + 처리 시작
GET    /meetings                      목록(좌측 내비)
GET    /meetings/:id                  회의 + 발언 타임라인
GET    /meetings/:id/status           진행률(stage/progress)
GET    /meetings/:id/audio            Range 지원 스트리밍(발언 점프 재생)
POST   /meetings/:id/reprocess        재처리 (§6.3)

POST   /speakers                      화자 등록(이름+샘플) → enrollment_status='pending'
GET    /speakers                      등록 화자 목록
GET    /speakers/:id                  화자 + enrollment_status(pending|ready|failed) 폴링
POST   /meetings/:id/clusters/:clusterId/resolve   미식별→사람 연결 (clusterId 기반)

GET    /health
```

---

## 10. 모델 메타 / pgvector 제약 (솔직한 한계)

- pgvector 컬럼은 차원 고정(`vector(192)`)이라 차원이 다른 모델로 바꾸면 같은 컬럼에 섞을 수 없다.
- 그래서 **식별 시 현재 `model`+`dimension`과 일치하는 voiceprint만 비교**한다(쿼리 필터).
- 모델 교체 = 새 모델로 voiceprint 재추출. 기존 row는 보존하되 미사용. 차원이 크게 달라지면 그때 컬럼/테이블을 분리한다.
- 지금은 **단일 임베딩 모델 가정 + 메타 기록**으로 충분. `UNIQUE(speaker_id, model)` 같은 빡빡한 제약은 걸지 않고 1:N을 유지한다(한 화자에 여러 샘플 누적 → 식별 robust).

---

## 11. 테스트 전략 (TDD)

- **NestJS**: 서비스 단위 테스트 + e2e(supertest). 테스트 Postgres는 Testcontainers. 명시적으로 테스트할 것:
  - job claim 동시성 (`SKIP LOCKED`로 두 워커가 같은 job을 안 집는지)
  - reaper 규칙 (stale lock 환원/실패 전이)
  - path traversal 거부
  - reprocess 트랜잭션 (결과 반영 원자성 + stale 가드: 낮은 버전 job persist가 `processing_version`/`current_job_id` 불일치 시 폐기되는지)
  - 화자 등록 상태 전이 (pending→ready / pending→failed) 및 식별이 `ready` 화자만 비교하는지
  - cluster resolve가 clusterId 기반으로 동작하고 같은 diar_label utterance를 일괄 갱신하는지
- **Python Worker**: 단계별 단위 테스트(작은 오디오 픽스처). 짧은 2화자 샘플(수 초)로 파이프라인 통합 테스트 — CI에선 tiny whisper로 속도 확보. 식별 임계치/미식별 경로 테스트.
- **계약 테스트**: `jobs` payload/enum을 zod·pydantic 양쪽에서 같은 픽스처로 검증해 스키마 드리프트 차단.

---

## 12. 셋업 의존성 (운영 주의)

- **pyannote 3.1은 게이트 모델** — HuggingFace 토큰(`HF_TOKEN`) + 라이선스 동의 필요. 최초 모델 다운로드 캐시.
- **ffmpeg** 시스템 바이너리 필요.
- **Whisper 백엔드 device 추상화**: Apple은 `mlx-whisper`, CUDA/CPU는 `faster-whisper`(CTranslate2). 공통 인터페이스 뒤에 두 구현. env `WHISPER_BACKEND`/`DEVICE`로 선택.
- 모델 가중치 **사전 다운로드 스크립트**(첫 실행 지연·오프라인 대비).
- 최소 스펙(권장): Apple Silicon(M1 이상) + 16GB RAM이면 `large-v3-turbo` + pyannote 쾌적. 비동기 배치라 속도가 아닌 RAM이 스펙 바.

---

## 13. 비목표 (Phase 1에서 제외)

- 검색(키워드/의미) — Phase 2
- 렌즈·LLM 추출 — Phase 3
- 공유·내보내기, 회의 그래프 — 후속
- 멀티유저·인증·권한 — 개인용 안정화 이후
- 비파괴 재추출 머지(사람 손댄 항목 보존) — Phase 3 (Phase 1 reprocess는 덮어쓰기, 단 버전·job_id 스탬프로 토대 마련)
