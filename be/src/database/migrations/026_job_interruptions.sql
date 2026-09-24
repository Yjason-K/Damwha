-- Phase 6b-3 (스펙 2026-09-24-electron-phase-6b-attempts-split-design.md §4).
--
-- attempts 한 컬럼이 크래시 회수와 일시 실패 재시도를 함께 셌다 — 강제 종료 N번이
-- 재시도 5회 중 N회를 먹었다. 회수(기동 회수·30분 reaper·worker 자기 고아 회수)만
-- interruptions를 올리고, 회수의 상한은 max_interruptions로 판정한다. attempts의 뜻은
-- 그대로다(claim +1, 정상 반납 −1). 재시도 예산 소비량은 attempts − interruptions.
--
-- **기존 행은 고치지 않는다.** 이 마이그레이션 전에 크래시로 먹은 시도는 구분할 정보가
-- 없어 예산 소비로 남는다 — 재시도를 더 얹지 않는 보수적 해석이다(025와 같은 규칙).
--
-- 불변식 0 ≤ interruptions ≤ attempts, running이면 interruptions < attempts 는 제약으로
-- 걸지 않는다. 회수 CTE 한가운데서 위반이 나면 기동 회수 전체가 실패하고 그 실패는 로그만
-- 남기고 삼켜진다(Phase 5 스펙 §4.5). 테스트가 고정한다.
ALTER TABLE job
  ADD COLUMN interruptions     int NOT NULL DEFAULT 0 CHECK (interruptions >= 0),
  ADD COLUMN max_interruptions int NOT NULL DEFAULT 3 CHECK (max_interruptions >= 1);
