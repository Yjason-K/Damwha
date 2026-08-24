CREATE EXTENSION IF NOT EXISTS vector;

CREATE SEQUENCE spk_id_seq;
CREATE TABLE speaker (
  id                text PRIMARY KEY DEFAULT 'spk_' || nextval('spk_id_seq')
                      CHECK (id ~ '^spk_[1-9][0-9]*$'),
  name              text NOT NULL,
  enrollment_status text NOT NULL DEFAULT 'pending'
                      CHECK (enrollment_status IN ('pending','ready','failed')),
  current_job_id    text,
  enrollment_error  jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
ALTER SEQUENCE spk_id_seq OWNED BY speaker.id;

CREATE SEQUENCE vp_id_seq;
CREATE TABLE voiceprint (
  id                 text PRIMARY KEY DEFAULT 'vp_' || nextval('vp_id_seq')
                       CHECK (id ~ '^vp_[1-9][0-9]*$'),
  speaker_id         text NOT NULL REFERENCES speaker(id) ON DELETE CASCADE,
  embedding          vector(192) NOT NULL,
  model              text NOT NULL,
  dimension          int NOT NULL,
  sample_duration_ms int,
  quality_score      real,
  source             text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
ALTER SEQUENCE vp_id_seq OWNED BY voiceprint.id;
CREATE INDEX voiceprint_model_dim_idx ON voiceprint (model, dimension);
CREATE INDEX voiceprint_embedding_idx ON voiceprint USING hnsw (embedding vector_cosine_ops);

CREATE SEQUENCE mtg_id_seq;
CREATE TABLE meeting (
  id                 text PRIMARY KEY DEFAULT 'mtg_' || nextval('mtg_id_seq')
                       CHECK (id ~ '^mtg_[1-9][0-9]*$'),
  title              text,
  original_filename  text,
  audio_key          text NOT NULL,
  normalized_key     text,
  recorded_at        timestamptz,
  duration_ms        int,
  status             text NOT NULL DEFAULT 'uploaded'
                       CHECK (status IN ('uploaded','processing','done','failed')),
  current_job_id     text,
  processing_version int NOT NULL DEFAULT 0,
  error              jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
ALTER SEQUENCE mtg_id_seq OWNED BY meeting.id;

CREATE SEQUENCE clu_id_seq;
CREATE TABLE meeting_cluster (
  id                  text PRIMARY KEY DEFAULT 'clu_' || nextval('clu_id_seq')
                        CHECK (id ~ '^clu_[1-9][0-9]*$'),
  meeting_id          text NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  diar_label          text NOT NULL,
  centroid            vector(192),
  resolved_speaker_id text REFERENCES speaker(id),
  processing_version  int NOT NULL,
  job_id              text,
  UNIQUE (meeting_id, diar_label)
);
ALTER SEQUENCE clu_id_seq OWNED BY meeting_cluster.id;

CREATE SEQUENCE utt_id_seq;
CREATE TABLE utterance (
  id                 text PRIMARY KEY DEFAULT 'utt_' || nextval('utt_id_seq')
                       CHECK (id ~ '^utt_[1-9][0-9]*$'),
  meeting_id         text NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  speaker_id         text REFERENCES speaker(id),
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
  job_id             text,
  UNIQUE (meeting_id, order_index)
);
ALTER SEQUENCE utt_id_seq OWNED BY utterance.id;

CREATE SEQUENCE job_id_seq;
CREATE TABLE job (
  id           text PRIMARY KEY DEFAULT 'job_' || nextval('job_id_seq')
                 CHECK (id ~ '^job_[1-9][0-9]*$'),
  type         text NOT NULL CHECK (type IN ('process_meeting','enroll_speaker')),
  meeting_id   text REFERENCES meeting(id) ON DELETE CASCADE,
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
ALTER SEQUENCE job_id_seq OWNED BY job.id;
CREATE INDEX job_status_created_idx ON job (status, created_at);

ALTER TABLE meeting         ADD FOREIGN KEY (current_job_id) REFERENCES job(id) ON DELETE SET NULL;
ALTER TABLE speaker         ADD FOREIGN KEY (current_job_id) REFERENCES job(id) ON DELETE SET NULL;
ALTER TABLE meeting_cluster ADD FOREIGN KEY (job_id)         REFERENCES job(id) ON DELETE SET NULL;
ALTER TABLE utterance       ADD FOREIGN KEY (job_id)         REFERENCES job(id) ON DELETE SET NULL;
