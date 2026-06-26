CREATE EXTENSION IF NOT EXISTS pg_bigm;

-- 의미검색 임베딩 (voiceprint 패턴 미러). 차원 고정 1024 (Phase 2).
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

-- 키워드 검색 (pg_bigm bigram GIN; 색인·쿼리 대칭).
CREATE INDEX utterance_text_bigm_idx ON utterance USING gin (text gin_bigm_ops);

-- job enum 확장: 새 type/stage 허용 (001의 익명 CHECK 이름은 Postgres 기본 규칙).
ALTER TABLE job DROP CONSTRAINT job_type_check;
ALTER TABLE job ADD CONSTRAINT job_type_check
  CHECK (type IN ('process_meeting','enroll_speaker','index_meeting'));

ALTER TABLE job DROP CONSTRAINT job_stage_check;
ALTER TABLE job ADD CONSTRAINT job_stage_check
  CHECK (stage IN ('vad','diarize','identify','stt','align','persist',
                   'extract_embedding','enroll_persist','embed'));
