# 렌즈 직접 DB 쓰기 불변식 설계

> 상태: 완료됨 · 작성일: 2026-07-15 · 완료일: 2026-07-21 · 선행: 렌즈 기반 서비스·자동 추출 워커

## 1. 목적과 범위

API·worker를 거치지 않는 직접 DB 쓰기 경로도 활성 AI 렌즈의 근거 규칙을 깨뜨리지
못하게 한다. 이 작업은 PostgreSQL의 deferred constraint trigger, migration, 회귀 테스트만
포함한다.

기존 `lens_evidence` 회의 소속 trigger는 유지한다. 렌즈 추출·대시보드·HTTP API의 기능
변경은 범위에서 제외한다.

## 2. 불변식

commit 시 다음이 항상 성립해야 한다.

- `source='ai'` 및 `lifecycle_status='active'`인 `lens_item`은
  `relation='primary'`인 `lens_evidence`를 정확히 하나 가진다.
- `source='user'`, `source='edited'`, 또는 `lifecycle_status='archived'` 항목은
  primary evidence 없이 허용한다.
- evidence의 utterance는 항목과 같은 회의에 속해야 한다. 이 규칙은 기존 deferred trigger가
  계속 담당한다.

기존 partial unique index가 primary evidence의 최대 하나를 보장한다. 새 trigger는 최소
하나를 강제한다.

## 3. 구현 설계

새 migration은 `active_ai_lens_has_primary()` 함수를 만든다. 함수는 영향을 받은 lens item이
활성 AI인지 확인하고, 그렇다면 primary evidence 존재 여부를 검사한다. 조건을 만족하지
않으면 SQLSTATE `23514`의 constraint violation을 발생시킨다.

두 constraint trigger를 `DEFERRABLE INITIALLY DEFERRED`로 등록한다.

1. `lens_item`의 INSERT와 `source`, `lifecycle_status` UPDATE는 항목 자체를 검사한다.
2. `lens_evidence`의 INSERT, `relation` UPDATE, DELETE는 OLD/NEW의 `lens_item_id`를
   검사한다.

따라서 같은 트랜잭션에서 AI item 생성 후 primary evidence를 추가하거나, 새 primary를
연결한 뒤 기존 primary를 제거하는 정상 다단계 쓰기는 commit한다. 반면 primary 없는 활성 AI
item 생성·활성화 또는 primary 삭제는 commit 시 전체 트랜잭션이 rollback된다.

## 4. 검증 기준

migration 통합 테스트는 직접 SQL로 다음을 확인한다.

- primary 없는 active AI item commit 실패
- active AI item의 primary 삭제 commit 실패
- AI item과 primary를 한 트랜잭션에서 생성하면 성공
- primary 교체를 한 트랜잭션에서 수행하면 성공
- user·edited·archived AI item은 primary 없이 성공
- 다른 회의 utterance evidence는 기존 회의 소속 trigger로 실패

변경 뒤 Nest 렌즈 E2E와 worker extraction 회귀 테스트가 통과해야 한다.
