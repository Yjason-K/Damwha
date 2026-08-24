CREATE SEQUENCE sav_id_seq;

CREATE TABLE saved_utterance (
  id text PRIMARY KEY DEFAULT 'sav_' || nextval('sav_id_seq') CHECK (id ~ '^sav_[1-9][0-9]*$'),
  meeting_id text NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  utterance_id text REFERENCES utterance(id) ON DELETE SET NULL,
  text_snapshot text NOT NULL CHECK (char_length(btrim(text_snapshot)) BETWEEN 1 AND 4000),
  speaker_name_snapshot text,
  start_ms_snapshot int NOT NULL CHECK (start_ms_snapshot >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (utterance_id)
);

CREATE INDEX saved_utterance_created_idx ON saved_utterance(created_at DESC, id DESC);
