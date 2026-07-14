CREATE SEQUENCE lens_id_seq;
CREATE TABLE lens_item (
  id text PRIMARY KEY DEFAULT 'lens_' || nextval('lens_id_seq') CHECK (id ~ '^lens_[1-9][0-9]*$'),
  meeting_id text NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('action','decision','promise')),
  text text NOT NULL CHECK (char_length(btrim(text)) BETWEEN 1 AND 1000),
  assignee_speaker_id text REFERENCES speaker(id), due_at date,
  completion_status text NOT NULL DEFAULT 'open' CHECK (completion_status IN ('open','done')),
  source text NOT NULL CHECK (source IN ('ai','user','edited')),
  user_modified boolean NOT NULL DEFAULT false,
  lifecycle_status text NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER SEQUENCE lens_id_seq OWNED BY lens_item.id;
CREATE INDEX lens_item_active_updated_idx ON lens_item(lifecycle_status, completion_status, updated_at DESC, id DESC);
CREATE TABLE lens_evidence (
  lens_item_id text NOT NULL REFERENCES lens_item(id) ON DELETE CASCADE,
  utterance_id text NOT NULL REFERENCES utterance(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN ('primary','supporting')),
  PRIMARY KEY (lens_item_id, utterance_id)
);
CREATE UNIQUE INDEX lens_evidence_one_primary_idx ON lens_evidence(lens_item_id) WHERE relation='primary';
CREATE SEQUENCE ler_id_seq;
CREATE TABLE lens_extraction_run (
  id text PRIMARY KEY DEFAULT 'ler_' || nextval('ler_id_seq') CHECK (id ~ '^ler_[1-9][0-9]*$'),
  meeting_id text NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  processing_version int NOT NULL, status text NOT NULL CHECK (status IN ('queued','running','done','failed')),
  model text, error jsonb, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
ALTER SEQUENCE ler_id_seq OWNED BY lens_extraction_run.id;
