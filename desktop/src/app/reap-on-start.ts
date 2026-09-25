import { CAUSES } from "../diagnostics/causes";
import { reapOrphans, survivingOrphans, type KnownTree, type ReapDeps } from "../process/orphans";
import { descendantPids, psArgs } from "../process/process-tree";
import { ServiceFailure } from "../services/failure";
import { processExists } from "../services/postgres/handle";

/**
 * 기동 전 고아 정리 (Phase 4 스펙 §6.5). main.ts의 createSupervisorFor가 HF 토큰 게이트 **다음**, 어떤 서비스
 * (postgres 포함)보다 **먼저** await한다 — 뒤에 하면 새로 띄운 것과 고아가 잠시 공존한다.
 *
 * 스캔이 실패하면 **manual** 실패로 던진다 (판정 R-7b, P4-C22). startOnce의 catch가 원인과 "다시 시도"
 * 안내를 그리고 자동 재시도는 걸지 않는다(retry-policy.ts). 감독자를 세우기 전이라 worker·embed를 포함해
 * 아무것도 뜨지 않고, 메뉴의 "다시 시도"가 supervisor가 null인 경로로 들어와 이 스캔부터 다시 돈다.
 *
 * 판정이 여기 있는 이유: main.ts는 electron을 값으로 import해 vitest가 부를 수 없다.
 */
export async function reapBeforeStart(d: ReapDeps): Promise<number[]> {
  const out = await reapOrphans(d);
  if ("failed" in out) throw new ServiceFailure(CAUSES.orphanScanFailed.text, "manual");
  // 회수가 성공을 돌려도 SIGKILL 뒤 생존자는 로그로만 남는다 (orphans.ts의 reapByKind 끝). 그 프로세스가 스토리지에
  // 쓰는 중일 수 있으므로, 데이터 가드가 스냅샷·교체를 하기 전에 여기서 멈춘다 (Phase 6b-2 스펙 §5.2-2).
  let alive: number[];
  try {
    alive = await survivingOrphans(d);
  } catch {
    throw new ServiceFailure(CAUSES.orphanScanFailed.text, "manual");
  }
  if (alive.length > 0) throw new ServiceFailure(CAUSES.writersAlive.text(alive), "manual");
  return out.reaped;
}

/**
 * 실제 커널에 닿는 ReapDeps. 종료 회수(Task 8)도 같은 배선을 쓴다.
 *
 * - `kill`·`terminate`는 신호가 닿지 않으면 **던진다**(ESRCH·EPERM) — reapOrphans가 그 pid를 회수 목록에서
 *   빼고 로그에 남긴다. 삼키면 "내렸다"는 기록이 거짓이 된다.
 * - `exists`는 신호 0이다. EPERM은 "있는데 내 것이 아니다"라 있는 쪽으로 센다 — 그 pid에 보낸 신호는
 *   EPERM으로 던져져 회수로 세지지 않는다.
 * - `descendantsOf`는 process-tree.ts의 BFS 순서(부모가 자식보다 앞)를 그대로 넘긴다.
 */
export function systemReapDeps(o: {
  runId: string;
  trees: readonly KnownTree[];
  log(line: string): void;
}): ReapDeps {
  return {
    runId: o.runId,
    trees: o.trees,
    ps: psArgs,
    descendantsOf: async (pid) => [...(await descendantPids(pid))],
    kill: (pid) => {
      process.kill(pid, "SIGKILL");
    },
    terminate: (pid) => {
      process.kill(pid, "SIGTERM");
    },
    exists: processExists,
    log: o.log,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
}
