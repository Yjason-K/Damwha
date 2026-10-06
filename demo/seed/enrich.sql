-- 마이그레이션 028~031(태그·태그 추천·폴더·'나')이 생긴 뒤 데모에 그 기능이 보이도록 넣는 데이터.
-- 덤프를 마이그레이션한 데모 전용 DB에 한 번 돌리고 build.sh로 다시 굽는다 — 실제 로컬 DB에 돌리지 말 것.
-- mtg_7(투어 회의)은 업로드 시뮬레이션 전까지 숨겨지므로 태그를 붙이지 않는다: GET /tags의
-- meeting_count는 서버가 세서, 숨긴 회의까지 세면 사이드바 숫자가 화면과 어긋난다.
BEGIN;

INSERT INTO folder (name) VALUES ('AI 코딩 이야기');
UPDATE meeting SET folder_id = (SELECT id FROM folder WHERE name = 'AI 코딩 이야기')
 WHERE id IN ('mtg_5', 'mtg_6');

INSERT INTO tag (name) VALUES ('AI 코딩'), ('프론트엔드'), ('생산성');
INSERT INTO meeting_tag (meeting_id, tag_id)
SELECT m, (SELECT id FROM tag WHERE name = t)
  FROM (VALUES ('mtg_5', 'AI 코딩'), ('mtg_5', '프론트엔드'),
               ('mtg_6', 'AI 코딩'), ('mtg_6', '생산성')) AS v(m, t);

-- 요약의 태그 추천. 서버는 읽을 때 이미 붙은 태그를 빼므로, 붙지 않은 태그 하나씩이 칩으로 뜬다.
UPDATE meeting_summary SET suggested_tags = '["AI 코딩", "생산성"]' WHERE meeting_id = 'mtg_5';
UPDATE meeting_summary SET suggested_tags = '["AI 코딩", "프론트엔드"]' WHERE meeting_id = 'mtg_6';

-- 두 회의에 모두 나오는 화자를 '나'로 — '내가 참여한 회의' 탭에 두 건이 걸린다.
UPDATE speaker SET is_me = true WHERE id = 'spk_9';

COMMIT;
