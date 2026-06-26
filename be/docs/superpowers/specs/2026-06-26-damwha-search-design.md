# Damwha 백엔드 — Phase 2: 검색(하이브리드) 설계

> 상태: 확정 (설계 합의 완료) · 작성일: 2026-06-26 · 대상: Phase 2 (검색)
> 선행: Phase 1 (Plan 1 NestJS API + Plan 2 Python 워커, 완료) · 전체 스펙: `2026-06-22-damwha-ingestion-backend-design.md`
> 개념: `docs/concept.md` §5.2 (다차원/구조화 검색)

---

## 0. 이 문서의 범위

Phase 1이 닫은 "업로드 → 화자 귀속 발언 타임라인" 위에, **utterance를 키워드 + 의미 + 구조화 필터로 찾는 하이브리드 검색**을 얹는다. 검색 단위는 Phase 1과 동일한 **utterance**이며, 결과는 원본 회의의 정확한 발언으로 점프할 좌표(meeting·timestamp)를 반환한다.

**범위에 포함:**
- 한국어 키워드 검색 (pg_bigm) + 의미 검색 (bge-m3 임베딩, pgvector) + 구조화 필터(날짜·참석자·회의)
- RRF(Reciprocal Rank Fusion)로 두 암(arm)을 한 랭킹으로 융합
- 비동기 임베딩 인덱싱: 새 job type `index_meeting` (워커)
- 동기 쿼리 임베딩: 로컬 **embed 서비스**(워커 코드베이스, bge-m3 호스트)
- 검색 API: `POST /search` + 재색인 트리거 `POST /meetings/:id/reindex` (API)
- 계약 변경(zod/pydantic/CHECK/fixture 동기화) + 커스텀 Postgres 이미지(pgvector + pg_bigm)
- 로컬 전용(클라우드/외부 네트워크 호출 금지) 유지

**범위 밖 (비목표):**
- **자연어 쿼리 파싱** — "지난주 김영재가 말한 UI 개선안" → `{date, speaker, q}` 분해는 UI(또는 Phase 3 LLM)의 몫. Phase 2는 `구조화 필터 + free-text q` 프리미티브만 제공한다.
- **저장 검색·렌즈 영속화** — Phase 3. (검색 인프라가 그 토대)
- 회의 제목 검색, 하이라이트 서버 생성, 차원이 바뀌는 임베딩 모델 공존(아래 §2.3) — v1 제외.

---

## 1. 아키텍처 결정

### 1.1 추가되는 컴포넌트 4개

| 컴포넌트 | 런타임 | 역할 |
|---|---|---|
| **`index_meeting` job** | 워커 (`worker/`) | utterance → bge-m3 임베딩 → `utterance_embedding` 기록. 인덱싱 경로. |
| **embed 서비스** | 워커 코드베이스 (별도 프로세스) | 최소 HTTP `POST /embed`(text[] → vector[]). 신규 `TextEmbedder` 어댑터(bge-m3) 사용. localhost 전용. **쿼리 임베딩만** 담당. |
| **search 모듈** | API (`src/search/`) | `POST /search` — 쿼리 임베딩(embed 서비스 호출) → 하이브리드 SQL → 결과 조립. controller/service/repository + `embed.client.ts`. |
| **reindex 트리거 + reconciler** | API | `POST /meetings/:id/reindex` (수동·백필) + "done인데 미색인" 복구 로직. |

### 1.2 불변식 변경 — job-table-only의 단일 예외 (P1a)

Phase 1 불변식은 "API↔워커는 Postgres `job` 테이블로만 통신, HTTP 금지"였다. Phase 2는 **이 불변식에 정확히 하나의 예외를 도입한다**:

> **동기 쿼리 임베딩에 한해, API → embed 서비스 localhost RPC를 허용한다.** 읽기전용·무상태·요청 스코프. 무거운 비동기 파이프라인(인덱싱)은 여전히 `job` 테이블로만 흐른다.

이 예외는 의도적이며, "기존 불변식 유지"가 **아니다**. 근거: 의미검색은 쿼리를 벡터로 변환해야 하는데(저지연 동기), 잡 큐의 폴 지연으로는 대화형 검색이 불가능하다. ML은 여전히 `src/` 밖(embed 서비스)에 둔다. degrade·timeout·미기동 동작은 §6에서 계약화한다.

**참고**: 인덱싱(`index_meeting`)은 워커 폴 프로세스가 bge-m3를 **직접** 로드해 임베딩한다(embed 서비스를 거치지 않음). 즉 bge-m3는 두 곳에 로드된다 — ① 워커 폴 프로세스(인덱싱), ② embed 서비스(쿼리). 트레이드오프: 모델 2벌 ≈ +2GB RAM. 이득: **인덱싱이 embed 서비스 가동과 무관**해 실패가 격리된다(embed 서비스 다운 → 쿼리 의미검색만 degrade, 인덱싱은 정상). 16GB 권장 스펙에서 수용 가능(§10).

---

## 2. 데이터 모델 (마이그레이션 `002_search.sql`)

### 2.1 확장 + 스키마

```sql
CREATE EXTENSION IF NOT EXISTS pg_bigm;

-- 의미검색: voiceprint 패턴 미러
CREATE TABLE utterance_embedding (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utterance_id       uuid NOT NULL REFERENCES utterance(id) ON DELETE CASCADE,
  embedding          vector(1024) NOT NULL,
  model              text NOT NULL,
  dimension          int  NOT NULL,
  processing_version int  NOT NULL,
  job_id             uuid REFERENCES job(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (utterance_id, model)
);
CREATE INDEX utterance_embedding_model_dim_idx ON utterance_embedding (model, dimension);
CREATE INDEX utterance_embedding_hnsw_idx ON utterance_embedding
  USING hnsw (embedding vector_cosine_ops);

-- 키워드: pg_bigm GIN (색인·쿼리 대칭)
CREATE INDEX utterance_text_bigm_idx ON utterance USING gin (text gin_bigm_ops);
```

### 2.2 설계 근거

- **별도 테이블**(utterance 컬럼이 아님): voiceprint와 동일 패턴. utterance가 reprocess로 DELETE되면 `ON DELETE CASCADE`로 임베딩도 자동 정리되어, 스테일 임베딩이 남지 않는다.
- `vector(1024)`는 voiceprint `vector(192)`와 완전 별개 테이블이라 충돌 없음.
- `UNIQUE (utterance_id, model)`: 한 utterance·한 모델당 임베딩 1개. 재임베딩은 UPSERT.

### 2.3 차원 고정의 한계 — 정직한 서술 (P2d)

`embedding vector(1024)`는 **고정 차원**이다. 따라서 `model`/`dimension` 컬럼이 주는 "모델 교체 지원"은 **동일 1024차원 모델끼리만** 성립한다(예: bge-m3 → 다른 1024d 모델). **차원이 바뀌는 모델로의 교체는 같은 컬럼에 공존 불가**이며, 새 컬럼/테이블 + 마이그레이션을 요한다. Phase 2는 **1024차원 검색 임베딩만 지원**한다. `dimension` 컬럼은 그럼에도 유지하는데, voiceprint invariant(`model`+`dimension` 쌍 필터)와 정합을 맞춰 의미검색 arm이 동일 원칙으로 필터하기 위함이다(§5.2, P2f).

---

## 3. 계약 변경 (3중 동기화)

`src/contracts/` (zod) · `worker/damwha_worker/contracts.py` (pydantic) · `001/002 CHECK` · `test/fixtures/job-payloads/` 를 함께 바꾼다.

### 3.1 job 테이블 enum 확장

```sql
-- 002_search.sql (CHECK 재정의)
job.type  CHECK 에 'index_meeting' 추가
job.stage CHECK 에 'embed' 추가
```

### 3.2 IndexMeetingPayload (신규) — 검색 임베딩 config 분리 (P1c)

기존 `EMBEDDING_MODEL=speechbrain/spkrec-ecapa-voxceleb` / `EMBEDDING_DIM=192`는 **voiceprint(화자)용**이며 `ProcessMeetingPayload.models.embedding`·`EnrollSpeakerPayload.embedding`에서 재사용 중이다. 검색 임베딩을 같은 이름에 섞으면 계약이 깨진다. 따라서 **별도 필드명**을 쓴다:

```ts
// zod
export const IndexMeetingPayloadSchema = z.object({
  schema_version: z.literal(1).default(1),
  meeting_id: z.string().uuid(),
  processing_version: z.number().int().nonnegative(),
  search_embedding: z.object({ model: z.string(), dimension: z.number().int() }),
});
```

- 신규 env (양쪽): `SEARCH_EMBEDDING_MODEL`(기본 `BAAI/bge-m3`) · `SEARCH_EMBEDDING_DIM`(기본 `1024`).
- `embedding`(voiceprint)과 `search_embedding`(검색)은 계약상 명확히 분리된다.
- payload는 **양쪽에서 생성**된다: 워커는 persist TX에서 자동 enqueue 시(Python), API는 reindex 시(TS). 동일 fixture로 양측 검증해 드리프트 차단.

---

## 4. 인덱싱 흐름 (비동기, `index_meeting`)

### 4.1 자동 enqueue — persist와 원자적으로 (P1b)

process_meeting의 persist는 이미 **가드된 짧은 TX**다. `index_meeting` enqueue를 **그 같은 TX 안의 INSERT**로 넣는다:

```
process_meeting persist TX:
  (guarded) utterance/meeting_cluster upsert + meeting.status='done'
  + INSERT job(type='index_meeting', meeting_id, payload{pv, search_embedding}, status='queued')
  COMMIT
```

→ **persist 커밋 ⟺ index 잡 존재**(원자적). persist는 성공했는데 enqueue만 유실되어 영구 미색인되는 갭이 닫힌다. reprocess도 새 process_meeting을 돌리므로 자연히 새 index 잡을 enqueue한다(옛 utterance DELETE → 옛 임베딩 CASCADE 정리).

### 4.2 reconciler / 백필 (안전망 + 기존 데이터)

원자 enqueue로도 못 덮는 경우 — ① Phase 2 이전에 이미 `done`인 회의, ② index 잡이 영구 실패한 회의, ③ 모델 교체 후 재색인, ④ **부분 색인**(일부 utterance만 임베딩된 상태) — 를 위해 복구 경로를 둔다. 후보 판정은 **회의 단위 all-or-nothing이 아니라 utterance 단위 갭**으로 해야 한다(부분 색인이 "완료"로 오인되어 영구 누락되는 것을 막음):

```sql
-- "done이고, in-flight index 잡이 없고, 색인 가능한 utterance 중 현재 모델
--  임베딩이 빠진 게 하나라도 있는" 회의
SELECT m.id FROM meeting m
WHERE m.status='done'
  AND NOT EXISTS (SELECT 1 FROM job j
                  WHERE j.meeting_id=m.id AND j.type='index_meeting'
                    AND j.status IN ('queued','running'))
  AND EXISTS (
    SELECT 1 FROM utterance u
    WHERE u.meeting_id=m.id AND u.status='ok' AND u.text IS NOT NULL  -- 색인 대상만
      AND NOT EXISTS (
        SELECT 1 FROM utterance_embedding e
        WHERE e.utterance_id=u.id AND e.model=:model AND e.dimension=:dim));
```

- `u.text IS NOT NULL`을 명시하므로, `ok`+text NULL utterance만 있는 회의(색인 대상 0개)는 후보가 되지 않아 **무한 재색인 루프를 피한다**.

- `POST /meetings/:id/reindex` — 단건 수동 재색인(백필·강제 재임베딩).
- 위 쿼리는 선택적 주기 작업으로도 돌릴 수 있다(Phase 2는 수동 엔드포인트 우선, 주기화는 향후).

### 4.3 인덱싱 실행 + 2-가드 (P2e)

**dispatch 분기 (필수 변경)**: 현재 워커 `main()`은 claim한 **모든** 잡에 대해 `build_models(job["payload"], settings)`를 호출하고(`__main__.py:76`), `build_models`는 `payload["models"]`에서 whisper/pyannote/ECAPA를 빌드한다(`registry.py:19`). `index_meeting` payload엔 `models`가 없어 **핸들러 진입 전 `KeyError`**가 난다. 따라서 dispatch를 **`build_models()` 이전에 job type으로 분기**하고, `index_meeting`은 **bge-m3 search embedder(TextEmbedder)만** 빌드해야 한다(Phase 1 모델을 불필요하게 로드하지 않음 → RAM 절약). 플랜에서 이 분기를 명시한다.

**실패 경로 분기 (필수 변경)**: 현재 `handle_job` 예외 처리는 `enroll_speaker`가 아니면 **전부 `process_meeting` 분기로 폴스루**해 `fail_process_meeting(meeting_id, ...)` → `meeting.status='failed'`를 호출한다(`__main__.py:45-53`). `index_meeting`이 이 분기에 빠지면 **이미 `done`인 회의가 색인 실패로 오염**된다. 검색 색인 실패는 **job만** failed/requeued 되고 **meeting은 `done`으로 남아야** 한다. 따라서 `handle_job`에 `index_meeting` 전용 실패 분기를 추가한다:
- TRANSIENT + 잔여 시도 → requeue(다른 타입과 공유).
- 그 외(PERMANENT / 시도 소진) → **job만** failed (신규 `db.fail_job`: `job.status='failed'`+error). **meeting은 절대 건드리지 않는다.**
- 영구 실패한 index 잡은 job error로 진단을 남기고, 임베딩 갭은 reconciler(§4.2)가 재enqueue로 복구한다(Phase 2는 수동).

참고 — **크래시 경로(Nest reaper)는 이미 안전**하다: `reapStale`의 meeting 실패 전파는 `type='process_meeting'`, speaker는 `type='enroll_speaker'`로 스코프돼 있어(`jobs.repository.ts:88,94`) stale `index_meeting` 잡은 job-only로 fail되고 meeting을 건드리지 않는다. **reaper 변경 불필요.**

워커가 `index_meeting`을 claim → 폴 프로세스가 bge-m3 직접 로드 → 대상 utterance 임베딩 → **한 짧은 TX에서 2-가드 적용** (persist의 2-가드 구조 미러):

```
stage='embed'
SELECT u.id, u.text FROM utterance u
  WHERE u.meeting_id=:mid AND u.status='ok' AND u.text IS NOT NULL
    AND u.processing_version=:pv          -- 이 pv 산출물만
배치 임베딩 (bge-m3)

TX:
  ① 잡 가드:   job WHERE id=:job_id AND locked_by=:worker AND status='running'
  ② meeting 가드: meeting.processing_version = :pv (더 새 reprocess 없음)
  → 둘 다 충족: UPSERT utterance_embedding (UNIQUE utterance_id,model) + job done(progress=100)
  → 잡 가드 0 rows:   lost ownership → ROLLBACK, 로컬 결과 폐기
  → meeting pv 불일치: stale → 임베딩 안 씀, job done + reason='stale_pv' (discard)
COMMIT
```

- **두 가드 모두 필요**: ① 잡 가드(`locked_by`+`running`)는 같은 잡의 requeue+reclaim을 잡고, ② meeting 가드(pv)는 더 새 reprocess가 utterance를 갈아치운 경우를 잡는다.
- 'ok' utterance 0개 → no-op done.
- 실패 분류는 기존 `ErrorKind`(PERMANENT/TRANSIENT) 그대로. embed 서비스와 무관(인덱싱은 모델 직접 로드).

---

## 5. 쿼리 흐름 (동기, `POST /search`)

### 5.1 요청 / 응답

```jsonc
// 요청
{
  "q": "UI 개선안",                 // optional. 비거나 없으면 browse 모드
  "filters": {
    "dateFrom": "2026-06-01T00:00:00Z",  // optional, meeting.recorded_at >=
    "dateTo":   "2026-06-08T00:00:00Z",  // optional, meeting.recorded_at <
    "speakerIds": ["<uuid>"],            // optional, utterance.speaker_id
    "meetingIds": ["<uuid>"]             // optional
  },
  "limit": 20                       // 기본 20, 최대 100. offset 없음(top-K) — §5.4
}

// 응답
{
  "mode": "hybrid",                 // "hybrid" | "keyword"(의미 degrade) | "browse"
  "semantic": true,                 // embed 서비스 불가 시 false
  "hasMore": true,                  // limit+1 페치 후 초과분 존재 여부 — §5.4
  "results": [{
    "utteranceId", "meetingId", "meetingTitle", "recordedAt",
    "speaker": { "id", "name" } | null,
    "diarLabel", "startMs", "endMs", "text", "score"
  }]
}
```

- 점프용 좌표(회의·타임스탬프)만 반환. **앞뒤 맥락**은 기존 `GET /meetings/:id` 상세에서 로드(검색 응답 경량 유지).
- 정확 total은 비용상 v1 제외 — `hasMore`로 대체. 페이지네이션은 §5.4.

### 5.2 하이브리드 SQL (q 있을 때) — 2-arm + RRF

```sql
WITH kw AS (   -- 키워드 암 (pg_bigm)
  SELECT u.id AS utterance_id,
         row_number() OVER (ORDER BY bigm_similarity(u.text, :q) DESC) AS rnk
  FROM utterance u JOIN meeting m ON m.id = u.meeting_id
  WHERE u.status='ok' AND u.text IS NOT NULL          -- (P3)
    AND u.text LIKE likequery(:q)                      -- bigm GIN 가속
    AND (:date_from IS NULL OR m.recorded_at >= :date_from)
    AND (:date_to   IS NULL OR m.recorded_at <  :date_to)
    AND (:speaker_ids IS NULL OR u.speaker_id = ANY(:speaker_ids))
    AND (:meeting_ids IS NULL OR u.meeting_id = ANY(:meeting_ids))
  ORDER BY bigm_similarity(u.text, :q) DESC LIMIT :cand_k
),
sem AS (       -- 의미 암 (pgvector)
  SELECT u.id AS utterance_id,
         row_number() OVER (ORDER BY e.embedding <=> :qvec) AS rnk
  FROM utterance_embedding e
  JOIN utterance u ON u.id = e.utterance_id
  JOIN meeting m ON m.id = u.meeting_id
  WHERE e.model = :model AND e.dimension = :dim       -- (P2f) model+dimension 둘 다
    AND u.status='ok'
    AND (:date_from IS NULL OR m.recorded_at >= :date_from)
    AND (:date_to   IS NULL OR m.recorded_at <  :date_to)
    AND (:speaker_ids IS NULL OR u.speaker_id = ANY(:speaker_ids))
    AND (:meeting_ids IS NULL OR u.meeting_id = ANY(:meeting_ids))
  ORDER BY e.embedding <=> :qvec LIMIT :cand_k
),
fused AS (     -- RRF
  SELECT COALESCE(kw.utterance_id, sem.utterance_id) AS utterance_id,
         COALESCE(1.0/(:rrf_k + kw.rnk), 0)
       + COALESCE(1.0/(:rrf_k + sem.rnk), 0) AS score
  FROM kw FULL OUTER JOIN sem USING (utterance_id)
)
SELECT u.id, u.meeting_id, m.title, m.recorded_at, u.speaker_id, s.name,
       u.diar_label, u.start_ms, u.end_ms, u.text, f.score
FROM fused f
JOIN utterance u ON u.id = f.utterance_id
JOIN meeting m ON m.id = u.meeting_id
LEFT JOIN speaker s ON s.id = u.speaker_id
ORDER BY f.score DESC, u.meeting_id, u.order_index
LIMIT :limit + 1;          -- limit+1 페치 → hasMore 판정 (§5.4)
```

- `:rrf_k` 기본 60(표준). `:cand_k`(암별 후보 수) = `max(SEARCH_CANDIDATE_K(기본 100), :limit*5)` — env로 노출. **bounded candidate approximation**: 각 암을 cand_k로 절단하므로 결과는 **정확 top-K가 아니라 근사**다. 양 암에서 모두 cand_k 바로 밖(cand_k+1등)인 문서가, 한쪽 암 상위 문서보다 융합 점수가 높을 수 있으나 후보에서 빠진다. 그래서 cand_k를 limit보다 **충분히 크게** 둔다(§5.4).
- 필터는 **양 암에 동일 적용**(AND). 점수 정규화 불필요(RRF는 순위 기반).
- 의미 암은 `status='ok'`만 임베딩되므로 자연 정합. 키워드 암은 `status='ok' AND text IS NOT NULL` 명시(P3).

### 5.3 browse / degrade 분기

- **q 비었음(browse)**: kw/sem 생략. `utterance u JOIN meeting m` WHERE `u.status='ok' AND u.text IS NOT NULL` + 필터, `ORDER BY m.recorded_at DESC NULLS LAST, m.created_at DESC, u.order_index`. `mode='browse'`. (`meeting.recorded_at`는 nullable(`001_init.sql:33`)이라 `NULLS LAST`로 미상정 회의가 최신 위로 떠오르지 않게 한다.)
- **embed 서비스 불가(degrade)**: sem 암 생략, kw 암만. `mode='keyword'`, `semantic=false`.

### 5.4 페이지네이션 — top-K (offset 없음)

하이브리드 RRF는 **후보 풀 크기에 따라 점수·순위가 흔들리므로** 안정적 deep offset이 불가능하다. 각 암이 `:cand_k`로 잘리는데, offset이 융합 풀(최대 ~2·cand_k)을 넘어서면 빈/불완전 페이지가 나온다(특히 키워드 degrade 모드). 따라서 **offset을 두지 않고 top-K만 제공**한다:

- 요청은 `limit`만(기본 20, 최대 100). `cand_k = max(SEARCH_CANDIDATE_K(기본 100), limit*5)` — limit보다 충분히 크게 두어 절단 근사 오차를 줄인다(정확 top-K 보장은 아님, §5.2).
- 융합 후 `LIMIT :limit + 1`로 페치 → 앞 `limit`개만 반환, `hasMore = (페치 수 > limit)`. 정확한 마지막 페이지에서도 false positive 없음.
- "더 보기"는 `limit` 상향(+ cand_k 동반 상승) 또는 **필터 좁히기**로 한다. 브라우즈 우선 셸(concept §6)과도 정합 — deep pagination 대신 필터로 좁힌다.

---

## 6. embed 서비스 + degrade 계약 (P1a)

### 6.1 서비스 + 신규 TextEmbedder 프로토콜

**TextEmbedder는 기존 `Embedder`와 별개다.** 현재 `Embedder` protocol은 `embed(wav_path, segments) -> list[list[float]]`(오디오+diar segment → voiceprint)이고(`models/base.py:34`), `build_models()`는 ECAPA/pyannote/whisper 묶음을 반환한다(`registry.py:18`). search embedder는 시그니처가 다르므로 **새 protocol + 빌더**를 둔다:

```python
class TextEmbedder(Protocol):
    def embed_texts(self, texts: list[str]) -> list[list[float]]: ...
```

- bge-m3 어댑터는 이 `TextEmbedder`를 구현한다. **인덱싱(워커 폴 프로세스)과 embed 서비스 둘 다 이 어댑터를 쓴다** — 기존 `Embedder`/`build_models()` 경로에 끼워넣지 않는다(별도 빌더).
- 서비스: 워커 코드베이스 내 별도 프로세스(예: `worker/damwha_worker/embed_service.py`, FastAPI).
- `POST /embed` body `{ "texts": ["..."] }` → `{ "model": "...", "dimension": 1024, "vectors": [[...]] }`.
- `GET /health` → 200(모델 로드 완료 시).
- **쿼리 임베딩 전용**(API만 호출). 인덱싱 잡은 호출하지 않음(모델 직접 로드).
- localhost 바인드(`127.0.0.1`), 외부 노출 금지(로컬 온리 유지).

### 6.2 API 측 계약 (`embed.client.ts`)

- env: `EMBED_SERVICE_URL`(기본 `http://127.0.0.1:<port>`), `EMBED_SERVICE_TIMEOUT_MS`(기본 800).
- **loopback 강제(로컬 온리 보증)**: API 기동 시 `EMBED_SERVICE_URL` 호스트가 loopback(`127.0.0.1`/`::1`/`localhost`)인지 검증하고, 아니면 **기동 거부**한다. 의도적 비-loopback이 필요하면 명시적 override(`EMBED_SERVICE_ALLOW_NON_LOOPBACK=true`)를 요구한다. concept의 "외부 네트워크 호출 금지"(§0)를 문서가 아니라 코드로 강제.
- **timeout/연결실패/non-200/미기동** → 예외를 삼키고 `null` 반환 → search.service가 **키워드 전용으로 degrade**(`mode='keyword'`, `semantic=false`) + 경고 로그. **검색 요청 자체는 실패시키지 않는다.**
- 차원 불일치(응답 dimension ≠ `SEARCH_EMBEDDING_DIM`) → degrade + 에러 로그(설정 드리프트 신호).

### 6.3 기동 순서

운영 기동: ① Postgres → ② embed 서비스(`/health` 200 대기) → ③ API → ④ 워커. embed 서비스가 늦거나 죽어도 API 검색은 degrade로 동작(crash 안 함). `worker/SMOKE.md`·실행 명령에 기동 순서 문서화.

---

## 7. 에러 처리 요약

| 상황 | 동작 |
|---|---|
| embed 서비스 timeout/다운 | 검색 = 키워드 전용 degrade, `semantic=false`, 경고 로그 (요청 성공) |
| index_meeting 잡 가드 0 rows | lost ownership → 로컬 폐기 |
| index_meeting meeting pv 불일치 | stale → 임베딩 안 씀, job done + reason='stale_pv' |
| index_meeting 모델 로드/임베딩 실패 | ErrorKind 분류. TRANSIENT+잔여→requeue, 그 외→**job만 failed**(`db.fail_job`). **meeting은 `done` 유지**(`fail_process_meeting` 호출 금지). 복구는 reconciler 재enqueue. reaper는 type-scoped라 안전(§4.3) |
| 'ok' utterance 0개 | no-op done |
| reprocess로 utterance 교체 | 옛 임베딩 CASCADE 삭제 + 새 index 잡으로 재색인 |

---

## 8. 컴포넌트 경계 (요약)

- `src/search/` — controller(HTTP) / service(orchestration: embed 호출 → repo → 조립) / repository(하이브리드 SQL) / `embed.client.ts`(RPC + degrade). ML 없음.
- `src/meetings/` — `POST /meetings/:id/reindex` 추가(reconciler 호출 + index 잡 enqueue).
- `worker/` — `index_meeting` 핸들러(2-가드, persist 미러) + persist TX의 자동 enqueue + `embed_service.py` + 신규 `TextEmbedder`/빌더 + `db.fail_job`(job-only 실패). `handle_job`은 dispatch·실패 경로를 type별로 분기(§4.3).
- 검색 SQL·결과 소유권은 전부 API. bge-m3는 embed 서비스(쿼리)와 워커 폴 프로세스(인덱싱)에만 존재.

---

## 9. 테스트 전략

- **API search.repository** (testcontainers, 커스텀 PG 이미지): utterance + 가짜 임베딩 벡터 시드 → RRF 정렬, 필터(날짜·참석자·회의) 정확성, pg_bigm 키워드 매칭, browse/degrade 분기 검증.
- **API search.e2e**: `embed.client`를 stub(쿼리 벡터 주입)해 CI에서 모델 불필요. degrade(서비스 null) 경로도 테스트.
- **워커 index_meeting**: fake embedder + 실 Postgres(process_meeting 패턴). 2-가드(잡 가드 lost / pv stale discard), persist TX 자동 enqueue, reprocess 재색인 검증.
- **embed 서비스**: fake 모델 계약 테스트(shape). 실 bge-m3는 로컬 smoke만(`worker/SMOKE.md`).
- **계약**: IndexMeetingPayload fixture를 zod·pydantic 양측 검증(드리프트 차단).
- ⚠️ pg_bigm 의존 테스트는 **커스텀 PG 이미지 필수**(§10).

---

## 10. 인프라 영향

- **커스텀 Postgres 이미지**: `pgvector/pgvector:pg16` + pg_bigm 빌드/설치하는 Dockerfile. docker-compose **및** `test/db.ts`(testcontainers) 이미지 교체. 모든 DB 컨테이너에 영향(일회성).
- **RAM**: bge-m3 2벌(워커 폴 프로세스 인덱싱 시 + embed 서비스). whisper/pyannote/ECAPA와 합산해도 16GB 권장 스펙에서 수용 가능. 워커 폴 프로세스는 index 잡 첫 실행 시 lazy 로드.
- **프로세스 수**: Phase 1 대비 embed 서비스(1) 추가 → Postgres / embed 서비스 / API / 워커.

---

## 11. 향후 / 미해결

- 회의 제목 검색, 서버측 하이라이트(ts_headline on 'simple'), 정확 total/커서 페이지네이션 — 필요 시 후속.
- 정확 hybrid top-K(현재는 bounded candidate approximation, §5.2) — 코퍼스가 커져 절단 오차가 체감되면 cand_k 상향 또는 정확 융합 전략 도입.
- 차원 다른 임베딩 모델 마이그레이션(새 컬럼/테이블) — §2.3.
- reconciler 주기 자동화(현재 수동 엔드포인트 우선).
- 저장 검색·렌즈(Phase 3)가 이 검색 인프라를 재사용한다(concept §5.5).
