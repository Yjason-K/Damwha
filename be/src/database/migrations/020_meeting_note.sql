-- 회의당 마크다운 메모 1장.
-- processing_version이 없다: 사람이 쓴 글은 재처리로 낡지 않으므로
-- utterance/lens_item/meeting_summary의 버전 규칙 밖에 둔다.
-- 빈 본문 행은 존재하지 않는다 — 서비스가 공백 PUT을 DELETE로 처리하므로
-- "메모 없음" 상태는 '행이 없음' 하나뿐이다.
CREATE SEQUENCE note_id_seq;

CREATE TABLE meeting_note (
  id          text PRIMARY KEY DEFAULT 'note_' || nextval('note_id_seq')
              CHECK (id ~ '^note_[1-9][0-9]*$'),
  meeting_id  text NOT NULL UNIQUE REFERENCES meeting(id) ON DELETE CASCADE,
  body_md     text NOT NULL CHECK (char_length(body_md) BETWEEN 1 AND 100000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
