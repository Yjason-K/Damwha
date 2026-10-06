-- 회의 폴더. 폴더는 회의가 놓이는 곳(회의당 하나), 태그(028)는 회의에 붙는 분류(여럿)다.
-- 기본 폴더는 실제 행이고 지울 수 없다 — 폴더를 지우면 그 회의들은 기본 폴더로 옮겨진다.
CREATE SEQUENCE fld_id_seq;

CREATE TABLE folder (
  id          text PRIMARY KEY DEFAULT 'fld_' || nextval('fld_id_seq')
              CHECK (id ~ '^fld_[1-9][0-9]*$'),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30 AND name = btrim(name)),
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER SEQUENCE fld_id_seq OWNED BY folder.id;
CREATE UNIQUE INDEX folder_name_lower_idx ON folder (lower(name));
CREATE UNIQUE INDEX folder_single_default_idx ON folder ((true)) WHERE is_default;

INSERT INTO folder(name, is_default) VALUES ('기본 폴더', true);

-- 컨럼 DEFAULT는 서브쿼리를 받지 않지만 함수 호출은 받는다. folder_id를 생략한 raw INSERT(테스트·워커
-- 픽스처·스모크 스크립트)도 그대로 기본 폴더에 들어가고, 앱의 INSERT는 폴더 파라미터를
-- 바인딩하므로 COALESCE($n, default_folder_id())로 같은 함수를 부른다 — "기본 폴더가 무엇인가"는
-- 이 함수 한 곳에만 있다.
CREATE FUNCTION default_folder_id() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT id FROM folder WHERE is_default
$$;

ALTER TABLE meeting ADD COLUMN folder_id text REFERENCES folder(id) DEFAULT default_folder_id();
UPDATE meeting SET folder_id = (SELECT id FROM folder WHERE is_default);
ALTER TABLE meeting ALTER COLUMN folder_id SET NOT NULL;
CREATE INDEX meeting_folder_idx ON meeting (folder_id);
