-- '나'로 지정된 화자. app_setting에 화자 id를 두면 그 화자를 지웠을 때 지워진 id가 남는다 —
-- 컬럼이면 화자 행과 함께 사라진다. '최대 한 명'은 folder_single_default_idx(030)와 같은
-- 부분 유니크 인덱스로 DB가 강제한다.
ALTER TABLE speaker ADD COLUMN is_me boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX speaker_single_me_idx ON speaker ((true)) WHERE is_me;
