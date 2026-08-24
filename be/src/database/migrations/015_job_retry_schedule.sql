ALTER TABLE job ADD COLUMN next_attempt_at timestamptz;
CREATE INDEX job_status_next_attempt_created_idx ON job (status, next_attempt_at, created_at);
