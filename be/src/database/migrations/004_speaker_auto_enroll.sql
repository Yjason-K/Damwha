-- provisional 상태값 추가 (text + CHECK 진화)
ALTER TABLE speaker DROP CONSTRAINT speaker_enrollment_status_check;
ALTER TABLE speaker ADD CONSTRAINT speaker_enrollment_status_check
  CHECK (enrollment_status IN ('pending','ready','provisional','failed'));

-- 기본 이름 전역 시퀀스 (Speaker_NNN, 중복 없음)
CREATE SEQUENCE speaker_default_seq;

-- voiceprint provenance: 어느 cluster centroid에서 만들어졌는가
-- (meeting_cluster.id는 읽기 쉬운 text PK이므로 FK 컬럼도 text)
ALTER TABLE voiceprint
  ADD COLUMN source_cluster_id text REFERENCES meeting_cluster(id) ON DELETE SET NULL;

-- cluster당 voiceprint ≤ 1 (중복 삽입 구조적 차단 + UPSERT 대상)
CREATE UNIQUE INDEX voiceprint_source_cluster_uniq
  ON voiceprint (source_cluster_id) WHERE source_cluster_id IS NOT NULL;
