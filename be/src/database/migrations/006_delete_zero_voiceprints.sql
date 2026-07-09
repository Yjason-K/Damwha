-- 006: 기존 zero-vector voiceprint 일회성 정리 (데이터만, 스키마 변경 없음).
--
-- 과거 워커는 100ms 미만 클립에 [0,...,0] sentinel 임베딩을 저장할 수 있었다
-- (auto_cluster/enroll source 모두). zero vector는 pgvector cosine 연산에 NaN을
-- 유입시켜 화자 식별을 오염시킨다. 워커는 이제 임베딩 불가 클립에 voiceprint를
-- 만들지 않으므로(None 계약), 남은 행만 정리하면 된다. 두 문장 모두 멱등.
--
-- vector_norm은 pgvector 0.5+ 필요 — 002의 HNSW 인덱스가 이미 같은 하한을
-- 요구하므로 새 제약이 아니다.
--
-- auto_cluster zero voiceprint: 삭제해도 provisional speaker는 meeting_cluster
-- 참조가 남아 유지된다 (persist GC 조건과 정합).
DELETE FROM voiceprint WHERE vector_norm(embedding) = 0;

-- 삭제로 voiceprint가 하나도 남지 않은 ready speaker는 "등록된 것처럼 보이지만
-- 영원히 매칭 불가" 상태가 된다 — failed로 전이해 재등록을 유도한다.
-- (ready + voiceprint 0개는 다른 경로로는 생기지 않는 비정상 상태.)
UPDATE speaker s
SET enrollment_status = 'failed',
    enrollment_error = jsonb_build_object(
      'code', 'sample_too_short',
      'message', 'legacy zero-vector voiceprint removed by migration 006; re-enroll this speaker'
    )
WHERE s.enrollment_status = 'ready'
  AND NOT EXISTS (SELECT 1 FROM voiceprint v WHERE v.speaker_id = s.id);
