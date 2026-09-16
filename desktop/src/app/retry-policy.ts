import { recoveryOf } from "../services/failure";
import type { ServiceStatus } from "../services/types";

/**
 * 실패 화면이 자동 재시도 타이머를 걸어도 되는가 (Phase 3 스펙 §6.7).
 *
 * Phase 2의 scheduleRetry는 원인을 받지 않고 게이트가 서지 않으면 무조건 3·8·20초로 재시도했다(Phase 2 결과
 * §5.2-1). 실행 게이트가 생긴 뒤에는 그 루프가 마이그레이션을 20초마다 재실행하고 백업을 하나씩 쌓는다. 실패한
 * 서비스 중 하나라도 manual이면 걸지 않는다 — 사람이 "다시 시도"를 누를 때까지 기다린다. 감독자를 세우기 전에 던진
 * 실패는 그 예외의 부류를 본다.
 */
export function mayAutoRetry(statuses: readonly ServiceStatus[] | null, thrown?: unknown): boolean {
  if (recoveryOf(thrown) === "manual") return false;
  return !(statuses ?? []).some((s) => s.process === "failed" && s.recovery === "manual");
}
