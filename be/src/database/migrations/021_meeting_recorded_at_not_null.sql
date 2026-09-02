-- 모든 회의에 기준일시를 보장한다. 렌즈 추출이 "오늘"·"다음 주 목요일" 같은 상대
-- 날짜를 절대 날짜로 환산하려면 기준이 되는 날짜가 반드시 있어야 한다.
--
-- 순서가 중요하다: 백필이 먼저다. SET NOT NULL을 먼저 걸면 기존 NULL 행 때문에
-- 실패한다. 백필 값은 created_at — 등록 시각은 이 회의에 대해 시스템이 아는 유일한
-- 시점이고, 미지정 업로드의 기본값과 같은 규칙이라 신·구 데이터가 같은 의미를 갖는다.
UPDATE meeting SET recorded_at = created_at WHERE recorded_at IS NULL;
ALTER TABLE meeting ALTER COLUMN recorded_at SET DEFAULT now();
ALTER TABLE meeting ALTER COLUMN recorded_at SET NOT NULL;
