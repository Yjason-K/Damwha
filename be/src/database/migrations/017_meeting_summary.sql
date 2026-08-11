-- 회의당 1행. 요약은 읽기 전용이고 통째로 재생성되므로 topics/segments를
-- 정규화하지 않는다 — 재생성이 UPSERT 1회로 끝나고 원자적이다.
CREATE TABLE meeting_summary (
  meeting_id          text PRIMARY KEY REFERENCES meeting(id) ON DELETE CASCADE,
  processing_version  int  NOT NULL,
  job_id              text REFERENCES job(id) ON DELETE SET NULL,
  model               text NOT NULL,
  status              text NOT NULL CHECK (status IN ('queued','running','done','failed')),
  topics              jsonb NOT NULL DEFAULT '[]'::jsonb,
  segments            jsonb NOT NULL DEFAULT '[]'::jsonb,
  error               jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
