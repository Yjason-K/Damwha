-- 라이브 세션(실시간 녹음). 설계: docs/superpowers/specs/2026-09-05-live-recording-design.md §3.1
--
-- 새 상태는 recording 하나뿐이다. 종료 시 워커가 uploaded로 바꾸면 그 뒤는 기존 흐름이다.
ALTER TABLE meeting DROP CONSTRAINT meeting_status_check;
ALTER TABLE meeting ADD CONSTRAINT meeting_status_check
  CHECK (status IN ('recording','uploaded','processing','done','failed'));

ALTER TABLE job DROP CONSTRAINT job_type_check;
ALTER TABLE job ADD CONSTRAINT job_type_check
  CHECK (type IN ('process_meeting','enroll_speaker','index_meeting',
                  'extract_lenses','summarize_meeting','live_session'));

ALTER TABLE job DROP CONSTRAINT job_stage_check;
ALTER TABLE job ADD CONSTRAINT job_stage_check
  CHECK (stage IN ('vad','diarize','identify','stt','align','persist',
                   'extract_embedding','enroll_persist','embed',
                   'extract_lenses','persist_lenses',
                   'summarize_meeting','persist_summary',
                   'capture','finalize'));

-- 동시에 recording인 회의는 하나뿐이다. status 컬럼의 부분 유일 인덱스라 그 값의 행이
-- 둘이 될 수 없다. 동시 시작 요청은 둘 다 "recording 없음"을 읽어도 INSERT에서 하나만 산다.
CREATE UNIQUE INDEX meeting_single_recording_idx ON meeting (status) WHERE status = 'recording';

-- API → 워커 종료 신호. cancel(job을 failed로)과 달리 파일을 살려 최종 패스로 넘긴다.
ALTER TABLE job ADD COLUMN stop_requested_at timestamptz;

-- 라이브 미리보기 발화. utterance에 버전 0으로 섞지 않는다 — 모든 리더가 처리 버전으로
-- 거르고 렌즈 근거·저장 발화가 FK로 물고 있어 임시 행이 새어 나갈 길을 막는다.
-- 최종 패스의 persist가 같은 트랜잭션에서 지운다.
CREATE SEQUENCE lut_id_seq;
CREATE TABLE live_utterance (
  id          text PRIMARY KEY DEFAULT 'lut_' || nextval('lut_id_seq')
                CHECK (id ~ '^lut_[1-9][0-9]*$'),
  meeting_id  text NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  job_id      text NOT NULL,
  seq         int  NOT NULL,
  start_ms    int  NOT NULL,
  end_ms      int  NOT NULL CHECK (end_ms > start_ms),
  text        text NOT NULL CHECK (char_length(text) > 0),
  speaker_id  text REFERENCES speaker(id) ON DELETE SET NULL,
  similarity  real,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, seq)
);
ALTER SEQUENCE lut_id_seq OWNED BY live_utterance.id;
