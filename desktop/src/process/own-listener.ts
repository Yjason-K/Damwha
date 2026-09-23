/**
 * 소유권 판정(스펙 §6.4, R1-11) 메커니즘 (b) — "그 포트에 응답이 있다"를 준비 신호로 쓰지
 * 말라는 명시적 계약. 응답이 있어도 그 응답이 **우리 자식에서** 온 것인지 확인한다.
 *
 * 판정이 main.ts에 있는 동안 이 한 줄을 `true`로 바꾸는 변이가 259개 초록불 아래 살아남았다
 * (재리뷰 N4). 그 변이가 배포되면 남의 API가 3000을 쥐고 있어도 앱이 그것을 자기 자식으로
 * 보고 준비됐다고 판정한다 — 스펙이 정확히 금지하는 상태다. lsof/ps 왕복은 main.ts에 남기고
 * 판정만 여기로 옮긴다. services/worker-discovery.ts의 listExternalWorkers와 같은 분리다.
 */

export interface OwnListenerDeps {
  /** 그 포트에서 실제로 LISTEN 중인 pid들 (main.ts의 lsof -sTCP:LISTEN). */
  listeners(port: number): Promise<number[]>;
  /** rootPid의 자손. **root 자신은 들어 있지 않다** (process-tree.ts의 descendantPids). */
  descendants(rootPid: number): Promise<Set<number>>;
}

/**
 * 이 리스너들 중 하나라도 우리 것인가.
 *
 * `pid === childPid`를 함께 보는 이유는 descendants(root)가 root를 빼고 돌려주기 때문이다.
 * packaged에서는 자식(utilityProcess 헬퍼)이 리스너 **자신**이라 이 항이 없으면 우리가 띄운
 * API를 남의 것으로 보고 영영 준비되지 않는다. dev에서는 자식이 pnpm이고 실제 리스너는
 * 손자라 자손 집합 쪽이 답한다 — 두 항이 각각 한 모드를 덮는다.
 */
export function isOwnListener(
  owners: readonly number[],
  childPid: number,
  descendants: ReadonlySet<number>,
): boolean {
  return owners.some((pid) => pid === childPid || descendants.has(pid));
}

/**
 * 배선까지 포함한 판정. lsof/ps 자체가 실패하면 소유를 **증명할 수 없으므로** 안전하게
 * "아니오"로 본다 — 준비 판정은 실패 쪽으로 닫는다. 여기서 true로 열면 조회가 실패하는
 * 모든 환경에서 남의 리스너가 우리 것으로 통과한다.
 */
export async function verifyOwnListener(
  deps: OwnListenerDeps,
  port: number,
  childPid: number | undefined,
): Promise<boolean> {
  // 자식이 없으면 우리 리스너도 없다. ps/lsof를 부를 이유도 없다.
  if (childPid === undefined) return false;
  try {
    const [owners, descendants] = await Promise.all([
      deps.listeners(port),
      deps.descendants(childPid),
    ]);
    return isOwnListener(owners, childPid, descendants);
  } catch {
    return false;
  }
}
