-- 봉인된 최종 PCM 바이트 수(헤더 제외). 워커가 tail을 끝낼 유일한 근거다 (설계 §2.7).
-- 파일 크기가 아니라 이 값이 EOF를 정하는 이유: 파일 append·헤더 재작성·DB commit은
-- 한 트랜잭션이 될 수 없어서, 셋 중 무엇이 진실인지 정해야 하기 때문이다.
ALTER TABLE job ADD COLUMN sealed_bytes bigint;

-- producer(브라우저) 생존 신호. append 커밋마다 갱신한다. 워커 heartbeat(locked_at)는
-- tail 대기 중에도 계속 뛰므로 브라우저 생존의 증거가 될 수 없다 (설계 §4.7).
ALTER TABLE job ADD COLUMN last_input_at timestamptz;

-- 캡처 이력. meeting.error와 다르다 — error는 "이 회의의 처리가 실패했는가"이고
-- 이것은 "이 녹음이 어떻게 얻어졌는가"다. finalize와 최종 persist가 error=NULL로
-- 덮으므로 캡처 사건을 error에 넣으면 조용히 지워진다 (설계 §2.10).
ALTER TABLE meeting ADD COLUMN capture_error jsonb;
