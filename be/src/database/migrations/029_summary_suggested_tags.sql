-- 요약 job이 함께 고른 태그 추천. 기존 태그 이름만 담고(워커가 후보 밖 이름을 버린다),
-- 회의에 실제로 붙이는 건 사용자뿐이다 — 워커는 meeting_tag를 쓰지 않는다.
-- id가 아니라 이름으로 담는 이유: 요약이 도는 동안 태그가 지워졌다 같은 이름으로 다시
-- 만들어질 수 있고, 읽는 쪽이 지금 있는 태그와 이름(대소문자 무시)으로 다시 맞춘다.
ALTER TABLE meeting_summary ADD COLUMN suggested_tags jsonb NOT NULL DEFAULT '[]'::jsonb;
