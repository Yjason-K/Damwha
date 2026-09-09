-- Task 6 — 하이브리드 검색 쿼리 (스펙 P0-C2).
--
-- `be/src/search/search.repository.ts::hybrid()` 의 CTE 구조를 **그대로** 옮긴
-- 것이다. 옮긴 이유는 하나다 — 번들 PostgreSQL 안에서 pg_bigm 의 `likequery`
-- ·`bigm_similarity` 와 pgvector 의 `<=>` 가 **제품이 쓰는 그 형태로** 도는지
-- 봐야 하기 때문이다. 비슷한 다른 쿼리가 도는 것은 P0-C2 의 확인이 아니다.
--
-- 제품 코드는 한 줄도 고치지 않는다 (스펙 §3.2). 여기가 사본이고, 원본이
-- 바뀌면 이 파일이 낡는다. 대조 지점을 적어 둔다:
--
--   search.repository.ts:52-79  WITH kw / sem / fused + 최종 SELECT
--   search.repository.ts:29-38  filterSql() — 아래 <filter> 주석이 그것이다
--   search.service.ts:96,120-124  candK / ef_search / rrfK / limit+1
--
-- ## 파라미터
--
-- 제품은 $1..$11 바인드 파라미터를 쓴다. psql 에는 그것이 없으므로 같은 자리를
-- psql 변수로 받는다. 호출자(verify/t6-lib.sh)가 -v 로 넘긴다.
--
--   $1  q            :'q'            질의 문자열
--   $2  candK        :cand_k         두 arm 의 후보 수
--   $3  qvec         :'qvec'         질의 벡터 리터럴 '[...]' (embed 서비스가 만든다)
--   $4  model        :'model'        'BAAI/bge-m3'
--   $5  dim          :dim            1024
--   $6  rrfK         :rrf_k          60
--   $7  limit+1      :limit_plus1    21
--   $8  dateFrom     :date_from      NULL
--   $9  dateTo       :date_to        NULL
--   $10 speakerIds   :speaker_ids    NULL
--   $11 meetingIds   :meeting_ids    NULL
--
-- 필터 넷은 NULL 로 넘긴다. 제품의 기본 호출(필터 없는 검색)과 같은 값이며,
-- 그래도 `m.status='done'` 과 `u.processing_version = m.processing_version` 은
-- 그대로 걸린다 — 시드가 그 두 조건을 만족해야 하는 이유다.
--
-- ## 출력
--
-- 제품의 최종 SELECT 는 fused 결과 한 벌만 낸다. 여기서는 **kw / sem / fused 를
-- 각각** 봐야 한다 (계획 Task 6 V3: 한쪽이 0건인데 fused 만 보고 통과시키지
-- 않는다). CTE 를 세 번 베껴 쓰면 그중 하나만 손대도 셋이 갈리므로, 한 문장
-- 안에서 같은 kw / sem / fused 를 세 갈래로 내보낸다.
--
--   arm  rnk  score  utterance_id  meeting_id  text     (탭 구분)
--
-- ## 트랜잭션
--
-- 앞의 두 set_config 는 search.service.ts:118-122 그대로다. 세 번째 인자
-- is_local=true 는 트랜잭션 블록 안에서만 뜻이 있으므로 BEGIN 으로 감싼다.
-- hnsw.iterative_scan 은 pgvector >= 0.8 의 GUC 다 — 이름이 없으면 여기서
-- 오류가 나고, 그것 자체가 번들 pgvector 가 제품이 요구하는 버전인지의 확인이다.

\o /dev/null
BEGIN;
SELECT set_config('hnsw.iterative_scan', 'strict_order', true);
SELECT set_config('hnsw.ef_search', :'ef_search', true);
\o

WITH kw AS (
  SELECT u.id AS utterance_id,
         row_number() OVER (ORDER BY bigm_similarity(u.text, :'q') DESC) AS rnk
  FROM utterance u JOIN meeting m ON m.id = u.meeting_id
  WHERE u.status='ok' AND u.text IS NOT NULL AND u.text LIKE likequery(:'q')
        -- <filter> search.repository.ts::filterSql('u', 8, 9, 10, 11)
        AND m.status = 'done'
        AND u.processing_version = m.processing_version
        AND (:date_from::timestamptz IS NULL OR m.recorded_at >= :date_from::timestamptz)
        AND (:date_to::timestamptz   IS NULL OR m.recorded_at <  :date_to::timestamptz)
        AND (:speaker_ids::text[] IS NULL OR u.speaker_id = ANY(:speaker_ids::text[]))
        AND (:meeting_ids::text[] IS NULL OR u.meeting_id = ANY(:meeting_ids::text[]))
  ORDER BY bigm_similarity(u.text, :'q') DESC LIMIT :cand_k
),
sem AS (
  SELECT u.id AS utterance_id,
         row_number() OVER (ORDER BY e.embedding <=> :'qvec'::vector) AS rnk
  FROM utterance_embedding e
  JOIN utterance u ON u.id = e.utterance_id
  JOIN meeting m ON m.id = u.meeting_id
  WHERE e.model = :'model' AND e.dimension = :dim AND u.status='ok'
        AND :'qvec'::text IS NOT NULL
        -- <filter> 위와 같은 filterSql('u', 8, 9, 10, 11)
        AND m.status = 'done'
        AND u.processing_version = m.processing_version
        AND (:date_from::timestamptz IS NULL OR m.recorded_at >= :date_from::timestamptz)
        AND (:date_to::timestamptz   IS NULL OR m.recorded_at <  :date_to::timestamptz)
        AND (:speaker_ids::text[] IS NULL OR u.speaker_id = ANY(:speaker_ids::text[]))
        AND (:meeting_ids::text[] IS NULL OR u.meeting_id = ANY(:meeting_ids::text[]))
  ORDER BY e.embedding <=> :'qvec'::vector LIMIT :cand_k
),
fused AS (
  SELECT COALESCE(kw.utterance_id, sem.utterance_id) AS utterance_id,
         COALESCE(1.0/(:rrf_k + kw.rnk), 0) + COALESCE(1.0/(:rrf_k + sem.rnk), 0) AS score
  FROM kw FULL OUTER JOIN sem USING (utterance_id)
),
-- 제품의 최종 SELECT 다 (search.repository.ts:80-86). 아래 UNION 의 'fused'
-- 갈래가 이 결과를 그대로 내보낸다.
ranked AS (
  SELECT u.id AS utterance_id, u.meeting_id, m.title AS meeting_title, m.recorded_at,
         u.speaker_id, s.name AS speaker_name, u.diar_label, u.start_ms, u.end_ms, u.text,
         u.order_index, f.score
  FROM fused f
  JOIN utterance u ON u.id = f.utterance_id
  JOIN meeting m ON m.id = u.meeting_id
  LEFT JOIN speaker s ON s.id = u.speaker_id
  ORDER BY f.score DESC, u.meeting_id, u.order_index
  LIMIT :limit_plus1
)
SELECT 'kw' AS arm, k.rnk AS rnk, NULL::float8 AS score,
       u.id AS utterance_id, u.meeting_id, u.text
FROM kw k JOIN utterance u ON u.id = k.utterance_id
UNION ALL
SELECT 'sem', s.rnk, NULL::float8, u.id, u.meeting_id, u.text
FROM sem s JOIN utterance u ON u.id = s.utterance_id
UNION ALL
SELECT 'fused', row_number() OVER (ORDER BY r.score DESC, r.meeting_id, r.order_index),
       r.score::float8, r.utterance_id, r.meeting_id, r.text
FROM ranked r
ORDER BY 1, 2;

COMMIT;
