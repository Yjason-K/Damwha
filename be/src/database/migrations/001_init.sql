CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE speaker (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  enrollment_status text NOT NULL DEFAULT 'pending'
                      CHECK (enrollment_status IN ('pending','ready','failed')),
  current_job_id    uuid,
  enrollment_error  jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE voiceprint (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  speaker_id         uuid NOT NULL REFERENCES speaker(id) ON DELETE CASCADE,
  embedding          vector(192) NOT NULL,
  model              text NOT NULL,
  dimension          int NOT NULL,
  sample_duration_ms int,
  quality_score      real,
  source             text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voiceprint_model_dim_idx ON voiceprint (model, dimension);
CREATE INDEX voiceprint_embedding_idx ON voiceprint USING hnsw (embedding vector_cosine_ops);

CREATE TABLE meeting (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title              text,
  original_filename  text,
  audio_key          text NOT NULL,
  normalized_key     text,
  recorded_at        timestamptz,
  duration_ms        int,
  status             text NOT NULL DEFAULT 'uploaded'
                       CHECK (status IN ('uploaded','processing','done','failed')),
  current_job_id     uuid,
  processing_version int NOT NULL DEFAULT 0,
  error              jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meeting_cluster (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id          uuid NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  diar_label          text NOT NULL,
  centroid            vector(192),
  resolved_speaker_id uuid REFERENCES speaker(id),
  processing_version  int NOT NULL,
  job_id              uuid,
  UNIQUE (meeting_id, diar_label)
);

CREATE TABLE utterance (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id         uuid NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  speaker_id         uuid REFERENCES speaker(id),
  diar_label         text NOT NULL,
  start_ms           int NOT NULL,
  end_ms             int NOT NULL,
  text               text,
  confidence         real,
  status             text NOT NULL DEFAULT 'ok'
                       CHECK (status IN ('ok','silence','transcribe_failed')),
  transcript_error   jsonb,
  order_index        int NOT NULL,
  processing_version int NOT NULL,
  job_id             uuid,
  UNIQUE (meeting_id, order_index)
);

CREATE TABLE job (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text NOT NULL CHECK (type IN ('process_meeting','enroll_speaker')),
  meeting_id   uuid REFERENCES meeting(id) ON DELETE CASCADE,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','done','failed')),
  stage        text CHECK (stage IN
                 ('vad','diarize','identify','stt','align','persist',
                  'extract_embedding','enroll_persist')),
  progress     smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  locked_by    text,
  locked_at    timestamptz,
  error        jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_status_created_idx ON job (status, created_at);

ALTER TABLE meeting         ADD FOREIGN KEY (current_job_id) REFERENCES job(id) ON DELETE SET NULL;
ALTER TABLE speaker         ADD FOREIGN KEY (current_job_id) REFERENCES job(id) ON DELETE SET NULL;
ALTER TABLE meeting_cluster ADD FOREIGN KEY (job_id)         REFERENCES job(id) ON DELETE SET NULL;
ALTER TABLE utterance       ADD FOREIGN KEY (job_id)         REFERENCES job(id) ON DELETE SET NULL;
