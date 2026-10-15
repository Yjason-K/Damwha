-- 렌즈 정확도 보강 (2026-10).
--
-- confidence: 추출 모델이 매긴 확신도. UI에서 막지 않는 힌트로만 쓴다. 사용자가
-- 만든 항목과 이 컬럼 이전에 뽑힌 항목은 NULL이다.
ALTER TABLE lens_item
  ADD COLUMN confidence text CHECK (confidence IN ('high','medium','low'));

-- dismissed: 사용자가 "결정 아님"(할 일·약속도 같다)으로 치운 항목. archived(재추출이
-- 내려놓은 항목)와 따로 두는 이유는, 재추출이 같은 (kind, 근거 발화)를 다시 내도
-- 되살리지 않아야 하기 때문이다. 근거 행은 그 대조를 위해 남긴다.
ALTER TABLE lens_item DROP CONSTRAINT lens_item_lifecycle_status_check;
ALTER TABLE lens_item
  ADD CONSTRAINT lens_item_lifecycle_status_check
  CHECK (lifecycle_status IN ('active','archived','dismissed'));
