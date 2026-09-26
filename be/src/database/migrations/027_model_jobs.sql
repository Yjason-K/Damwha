-- 모델 받기·삭제 job (모델 다운로드 관리 스펙 §4.4·§5.4).
--
-- 1. job type·stage에 download_model·delete_model을 더한다. meeting_id는 null이다.
-- 2. model_job_refs — "그 모델을 쓰는 queued/running job" 판정. API(삭제 409)와 worker(delete_model
--    실행 직전 재검사)가 **같은 함수**를 부른다. 규칙을 TS·Python에 따로 두면 v1 payload의
--    device(mps→gpu) 해석처럼 한쪽에만 있는 규칙이 갈린다.
--
-- 식별자는 논리 키(role·name·backend)다 — payload도 저장소가 아니라 이름·장치를 싣기 때문이다.
--   전사: models.whisper_model = name 이고 백엔드(devices.stt, v1은 device: mps→gpu, 그 밖→cpu;
--         gpu→mlx, cpu→faster) = backend.
--   요약: summary_model(v1·v2는 없음 → p_summary_fallback) — followups.summary가 거짓이면 안 쓴다
--         (v1~v4는 그 필드가 없고 항상 참). 렌즈 모델(p_lens_models)은 followups.lens가 참이거나 필드가
--         없을 때 쓴다. summarize_meeting·extract_lenses는 payload.model.
--   live_session: payload.process가 v5 process_meeting payload다 — 같은 규칙.
--   고정 역할: 삭제 대상이 아니므로 아무것도 돌려주지 않는다.
--
-- followups.summary/lens의 ::boolean 캐스트는 jsonb_typeof로 먼저 감싼다. zod v5 스키마(.strict())가
-- 그 필드를 boolean만 받으므로 API가 넣는 payload는 항상 이 모양이지만, 이 함수는 job 테이블 전체를
-- 스캔하는 SQL이라 스키마 보증 밖의 값(수기 수정, 오래된 fixture)이 섞여도 ::boolean이 예외를 던지며
-- 함수 전체를 실패시키지 않도록 방어한다 — 값이 boolean이 아니면 필드가 없는 것과 같이 취급한다.
ALTER TABLE job DROP CONSTRAINT job_type_check;
ALTER TABLE job ADD CONSTRAINT job_type_check
  CHECK (type IN ('process_meeting','enroll_speaker','index_meeting',
                  'extract_lenses','summarize_meeting','live_session',
                  'download_model','delete_model'));

ALTER TABLE job DROP CONSTRAINT job_stage_check;
ALTER TABLE job ADD CONSTRAINT job_stage_check
  CHECK (stage IN ('vad','diarize','identify','stt','align','persist',
                   'extract_embedding','enroll_persist','embed',
                   'extract_lenses','persist_lenses',
                   'summarize_meeting','persist_summary',
                   'capture','finalize',
                   'download_model','delete_model'));

CREATE OR REPLACE FUNCTION model_job_refs(
  p_role text, p_name text, p_backend text,
  p_lens_models text[], p_summary_fallback text, p_exclude_job text
) RETURNS SETOF text LANGUAGE sql STABLE AS $$
  WITH active AS (
    SELECT id, type, payload FROM job
    WHERE status IN ('queued', 'running')
      AND (p_exclude_job IS NULL OR id <> p_exclude_job)
  ),
  proc AS (
    SELECT id, payload AS p FROM active WHERE type = 'process_meeting'
    UNION ALL
    SELECT id, payload -> 'process' FROM active WHERE type = 'live_session'
  ),
  norm AS (
    SELECT id,
           p -> 'models' ->> 'whisper_model' AS whisper,
           CASE COALESCE(p -> 'models' -> 'devices' ->> 'stt',
                         CASE p -> 'models' ->> 'device' WHEN 'mps' THEN 'gpu' ELSE 'cpu' END)
             WHEN 'gpu' THEN 'mlx' ELSE 'faster' END AS backend,
           COALESCE(p -> 'models' ->> 'summary_model', p_summary_fallback) AS summary,
           COALESCE(
             CASE WHEN jsonb_typeof(p -> 'followups' -> 'summary') = 'boolean'
                  THEN (p -> 'followups' ->> 'summary')::boolean END,
             true
           ) AS uses_summary,
           COALESCE(
             CASE WHEN jsonb_typeof(p -> 'followups' -> 'lens') = 'boolean'
                  THEN (p -> 'followups' ->> 'lens')::boolean END,
             true
           ) AS uses_lens
    FROM proc
  )
  SELECT id FROM norm
   WHERE p_role = 'stt' AND whisper = p_name AND backend = p_backend
  UNION
  SELECT id FROM norm
   WHERE p_role = 'summary'
     AND ((uses_summary AND summary = p_name) OR (uses_lens AND p_name = ANY (p_lens_models)))
  UNION
  SELECT id FROM active
   WHERE p_role = 'summary'
     AND type IN ('summarize_meeting', 'extract_lenses')
     AND payload ->> 'model' = p_name
$$;
