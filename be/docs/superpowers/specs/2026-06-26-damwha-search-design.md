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
| **embed 서비스** | 워커 코드베이스 (별도 프로세스) | 최소 HTTP `POST /embed`(text[] → vector[]). 워커 model registry의 bge-m3 어댑터 재사용. localhost 전용. **쿼리 임베딩만** 담당. |
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

원자 enqueue로도 못 덮는 경우 — ① Phase 2 이전에 이미 `done`인 회의, ② index 잡이 영구 실패한 회의, ③ 모델 교체 후 재색인 — 를 위해 복구 경로를 둔다:

```sql
-- "done인데 현재 모델 임베딩 없고, in-flight index 잡도 없는" 회의
SELECT m.id FROM meeting m
WHERE m.status='done'
  AND EXISTS (SELECT 1 FROM utterance u WHERE u.meeting_id=m.id AND u.status='ok')
  AND NOT EXISTS (SELECT 1 FROM job j
                  WHERE j.meeting_id=m.id AND j.type='index_meeting'
                    AND j.status IN ('queued','running'))
  AND NOT EXISTS (
    SELECT 1 FROM utterance u
    JOIN utterance_embedding e
      ON e.utterance_id=u.id AND e.model=:model AND e.dimension=:dim
    WHERE u.meeting_id=m.id AND u.status='ok');
```

- `POST /meetings/:id/reindex` — 단건 수동 재색인(백필·강제 재임베딩).
- 위 쿼리는 선택적 주기 작업으로도 돌릴 수 있다(Phase 2는 수동 엔드포인트 우선, 주기화는 향후).

### 4.3 인덱싱 실행 + 2-가드 (P2e)

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
  "limit": 20,                      // 기본 20, 최대 100
  "offset": 0
}

// 응답
{
  "mode": "hybrid",                 // "hybrid" | "keyword"(의미 degrade) | "browse"
  "semantic": true,                 // embed 서비스 불가 시 false
  "hasMore": true,                  // results.length == limit
  "results": [{
    "utteranceId", "meetingId", "meetingTitle", "recordedAt",
    "speaker": { "id", "name" } | null,
    "diarLabel", "startMs", "endMs", "text", "score"
  }]
}
```

- 점프용 좌표(회의·타임스탬프)만 반환. **앞뒤 맥락**은 기존 `GET /meetings/:id` 상세에서 로드(검색 응답 경량 유지).
- 정확 total은 비용상 v1 제외 — `hasMore`로 대체.

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
LIMIT :limit OFFSET :offset;
```

- `:rrf_k` 기본 60(표준), `:cand_k`(암별 후보 수) 기본 50 — env로 노출.
- 필터는 **양 암에 동일 적용**(AND). 점수 정규화 불필요(RRF는 순위 기반).
- 의미 암은 `status='ok'`만 임베딩되므로 자연 정합. 키워드 암은 `status='ok' AND text IS NOT NULL` 명시(P3).

### 5.3 browse / degrade 분기

- **q 비었음(browse)**: kw/sem 생략. `utterance WHERE status='ok' AND text IS NOT NULL` + 필터, `ORDER BY recorded_at DESC, order_index`. `mode='browse'`.
- **embed 서비스 불가(degrade)**: sem 암 생략, kw 암만. `mode='keyword'`, `semantic=false`.

---

## 6. embed 서비스 + degrade 계약 (P1a)

### 6.1 서비스

- 워커 코드베이스 내 별도 프로세스(예: `worker/damwha_worker/embed_service.py`, FastAPI). model registry의 bge-m3 어댑터 재사용.
- `POST /embed` body `{ "texts": ["..."] }` → `{ "model": "...", "dimension": 1024, "vectors": [[...]] }`.
- `GET /health` → 200(모델 로드 완료 시).
- **쿼리 임베딩 전용**(API만 호출). 인덱싱 잡은 호출하지 않음(모델 직접 로드).
- localhost 바인드(`127.0.0.1`), 외부 노출 금지(로컬 온리 유지).

### 6.2 API 측 계약 (`embed.client.ts`)

- env: `EMBED_SERVICE_URL`(기본 `http://127.0.0.1:<port>`), `EMBED_SERVICE_TIMEOUT_MS`(기본 800).
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
| index_meeting 모델 로드/임베딩 실패 | ErrorKind 분류(PERMANENT/TRANSIENT), reaper/재시도 |
| 'ok' utterance 0개 | no-op done |
| reprocess로 utterance 교체 | 옛 임베딩 CASCADE 삭제 + 새 index 잡으로 재색인 |

---

## 8. 컴포넌트 경계 (요약)

- `src/search/` — controller(HTTP) / service(orchestration: embed 호출 → repo → 조립) / repository(하이브리드 SQL) / `embed.client.ts`(RPC + degrade). ML 없음.
- `src/meetings/` — `POST /meetings/:id/reindex` 추가(reconciler 호출 + index 잡 enqueue).
- `worker/` — `index_meeting` 핸들러(2-가드, persist 미러) + persist TX의 자동 enqueue + `embed_service.py`.
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
- 차원 다른 임베딩 모델 마이그레이션(새 컬럼/테이블) — §2.3.
- reconciler 주기 자동화(현재 수동 엔드포인트 우선).
- 저장 검색·렌즈(Phase 3)가 이 검색 인프라를 재사용한다(concept §5.5).
