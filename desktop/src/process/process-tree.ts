import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** `lsof -sTCP:LISTEN`으로 그 포트에서 실제로 LISTEN 중인 pid들을 얻는다. 매치가
 *  없으면 lsof가 exit 1을 내는데, 이는 "리스너 없음"과 같은 뜻이라 빈 배열로 다룬다. */
export async function listenerPids(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/sbin/lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { timeout: 1_000 },
    );
    return stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

/**
 * rootPid의 모든 자손 pid를 `ps`의 pid/ppid 목록에서 BFS로 모은다. 개발 모드의 자식은
 * pnpm → nest(CLI) → node(dist/main) 체인이라, 실제로 포트를 bind하는 것은 추적 중인
 * pid의 손자다 — 직계 비교만으로는 dev를 오판한다(실측: Fix round 1 보고서).
 *
 * **root 자신은 결과에 들어 있지 않다.** 부르는 쪽이 합쳐야 한다 — verifyOwnListener는
 * `pid === childPid || …`로, listExternalWorkers는 `ours.add(pid)`로 그렇게 한다.
 */
export async function descendantPids(rootPid: number): Promise<Set<number>> {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid,ppid"], { timeout: 1_000 });
  const rows = stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((row): row is [number, number] => row.length === 2 && row.every(Number.isInteger));

  const result = new Set<number>();
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const [pid, ppid] of rows) {
      if (frontier.includes(ppid) && !result.has(pid)) {
        result.add(pid);
        next.push(pid);
      }
    }
    frontier = next;
  }
  return result;
}
