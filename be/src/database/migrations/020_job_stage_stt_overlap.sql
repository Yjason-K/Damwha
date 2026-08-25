-- process_meeting에 겹침 구간 2차 전사 단계(stt_overlap) 추가 — align과 persist 사이.
ALTER TABLE job DROP CONSTRAINT job_stage_check;
ALTER TABLE job ADD CONSTRAINT job_stage_check
  CHECK (stage IN ('vad','diarize','identify','stt','align','stt_overlap','persist',
                   'extract_embedding','enroll_persist','embed',
                   'extract_lenses','persist_lenses',
                   'summarize_meeting','persist_summary'));
