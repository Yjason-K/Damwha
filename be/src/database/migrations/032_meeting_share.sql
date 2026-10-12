-- 회의 공유 링크 (spec 2026-10-09-meeting-share §2.7). 활성 링크이자 철회 대기열이다.
-- meeting에 CASCADE로 묶지 않는다: 회의와 함께 삭제 토큰이 사라지면 서버 객체를 철회할 수 없다.
-- 그래서 SET NULL로 행을 살리고, 회의 삭제는 같은 트랜잭션에서 active를 revoke_pending으로 바꾼다.
-- share_key는 링크의 #뒤에 들어가는 복호화 키 — 회의 원본과 같은 Mac 안에만 있고, 끝나면 NULL이다.
CREATE SEQUENCE shr_id_seq;
CREATE TABLE meeting_share (
  id                  text PRIMARY KEY DEFAULT 'shr_' || nextval('shr_id_seq') CHECK (id ~ '^shr_[1-9][0-9]*$'),
  meeting_id          text REFERENCES meeting(id) ON DELETE SET NULL,
  status              text NOT NULL CHECK (status IN ('creating','active','revoke_pending','revoked','expired')),
  remote_id           text UNIQUE,     -- 공유 id. be가 만들어 예약(creating) 때 넣는다
  share_key           text,            -- 링크의 #뒤 복호화 키. active일 때만, 끝나면 NULL
  delete_token        text,            -- be가 만든 삭제 토큰. 예약 때 넣고 철회가 끝나면 NULL
  scope               jsonb NOT NULL,
  duration_days       int NOT NULL,
  expires_at          timestamptz,
  consent_version     int NOT NULL,
  consented_at        timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  revoke_attempted_at timestamptz,
  revoke_attempts     int NOT NULL DEFAULT 0,
  revoke_error        jsonb
);
ALTER SEQUENCE shr_id_seq OWNED BY meeting_share.id;
-- 동시 공유 요청 두 개가 둘 다 링크를 남기지 못하게 한다 (spec §2.7 1단계).
CREATE UNIQUE INDEX meeting_share_one_creating_idx ON meeting_share(meeting_id) WHERE status = 'creating';
CREATE UNIQUE INDEX meeting_share_one_active_idx   ON meeting_share(meeting_id) WHERE status = 'active';
CREATE INDEX meeting_share_status_idx ON meeting_share(status, created_at DESC);
