-- 회의 태그. 폴더 대신 태그를 둔다 — 한 회의가 프로젝트·유형·상대 같은 여러 기준에
-- 동시에 걸리므로 한 곳에만 넣는 구조로는 담기지 않는다.
--
-- 태그는 이름으로만 다룬다: 회의에 붙일 때 없는 이름이면 만들고, 어느 회의에도
-- 붙어 있지 않게 된 태그는 같은 트랜잭션에서 지운다(TagsService.setForMeeting).
-- 그래서 "쓰이지 않는 태그"를 관리하는 화면이 따로 필요 없다.
-- 이름은 대소문자를 가리지 않고 하나다("API"와 "api"는 같은 태그).
CREATE SEQUENCE tag_id_seq;

CREATE TABLE tag (
  id          text PRIMARY KEY DEFAULT 'tag_' || nextval('tag_id_seq')
              CHECK (id ~ '^tag_[1-9][0-9]*$'),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30 AND name = btrim(name)),
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER SEQUENCE tag_id_seq OWNED BY tag.id;
CREATE UNIQUE INDEX tag_name_lower_idx ON tag (lower(name));

CREATE TABLE meeting_tag (
  meeting_id  text NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  tag_id      text NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, tag_id)
);
CREATE INDEX meeting_tag_tag_idx ON meeting_tag (tag_id);
