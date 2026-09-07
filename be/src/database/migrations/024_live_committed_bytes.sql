-- 확정 바이트 경계. append/stop이 fdatasync 완료 후 커밋하는 연속 prefix 길이다 —
-- 파일 자체의 길이는 크래시로 미확정 꼬리가 붙을 수 있어 신뢰할 수 없다 (설계 §3.1–3.2).
-- sealed_bytes(023)와 다르다: committed는 매 append마다 전진하고, sealed는 그 중 하나를
-- "이게 최종 길이다"로 확정한 것 — 그래서 sealed가 있으면 committed와 같아야 한다.
ALTER TABLE job ADD COLUMN committed_bytes bigint;
ALTER TABLE job ADD CONSTRAINT job_live_committed_bytes_check CHECK (
  committed_bytes IS NULL OR (
    type = 'live_session' AND committed_bytes >= 0 AND committed_bytes % 2 = 0
    AND (sealed_bytes IS NULL OR sealed_bytes = committed_bytes)
  )
);
