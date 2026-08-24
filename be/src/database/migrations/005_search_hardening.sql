-- Phase 2 임베딩 차원 고정(1024) 방어. embedding 컬럼은 vector(1024)로 이미 고정이지만
-- dimension 메타 컬럼은 임의 정수를 허용했다 → 오설정 차원의 잘못된 행이 색인되지 않도록
-- CHECK 제약으로 봉인한다. (env.SEARCH_EMBEDDING_DIM / IndexMeetingPayload와 대칭)

-- 레거시 정리: 과거 오설정으로 이미 들어간 비-1024 차원 행을 먼저 제거해야 ADD CONSTRAINT가
-- 기존 행 검증에서 실패하지 않는다. 임베딩은 파괴적 데이터가 아니며 POST /meetings/reindex-missing
-- 로 언제든 재생성된다.
DELETE FROM utterance_embedding WHERE dimension <> 1024;

ALTER TABLE utterance_embedding
  ADD CONSTRAINT ue_dimension_1024 CHECK (dimension = 1024);
