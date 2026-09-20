-- 재시도 상한을 3에서 5로. 백오프가 30초 기준으로 길어졌으므로(worker db/queue.py의 requeue)
-- 3회는 90초 만에 소진돼 그보다 긴 네트워크 끊김이 job을 영구 실패로 만든다.
-- 시도 시각은 claim 직후 실패 기준으로 0 · 30s · 90s · 210s · 450s다.
--
-- **기존 행은 고치지 않는다.** 이미 max_attempts=3으로 적힌 job은 계속 3회에서 실패하고
-- reaper도 그 저장된 값을 본다. 새 기본값은 이 마이그레이션 이후 enqueue되는 job에만 붙는다.
-- live_session은 live.service.ts가 maxAttempts=1을 명시하므로 영향이 없다.
ALTER TABLE job ALTER COLUMN max_attempts SET DEFAULT 5;
