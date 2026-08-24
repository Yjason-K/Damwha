ALTER TABLE lens_extraction_run
  ADD COLUMN job_id text REFERENCES job(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX lens_extraction_run_one_active_idx
  ON lens_extraction_run(meeting_id, processing_version)
  WHERE status IN ('queued', 'running');

CREATE INDEX lens_extraction_run_meeting_created_idx
  ON lens_extraction_run(meeting_id, created_at DESC);
