/**
 * postmaster.pid와 락 주인 판정 (Phase 3 스펙 §6.4). 순수 모듈이다 — ps를 부르는 일은 handle.ts의 psInfo가 한다.
 */

export type PmStatus = "starting" | "stopping" | "ready" | "standby" | "unknown";

export interface PostmasterPid {
  pid: number;
  dataDir: string;
  /** 8번째 줄. PostgreSQL 10+가 pg_ctl의 기동 대기용으로 쓰는 값이고, 공백으로 8자를 채운다("ready   "). */
  status: PmStatus;
}

const STATUSES: readonly PmStatus[] = ["starting", "stopping", "ready", "standby"];

export function parsePostmasterPid(text: string): PostmasterPid | null {
  const lines = text.split("\n");
  const pid = Number((lines[0] ?? "").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const raw = (lines[7] ?? "").trim() as PmStatus;
  return { pid, dataDir: (lines[1] ?? "").trim(), status: STATUSES.includes(raw) ? raw : "unknown" };
}

export interface ProcessInfo {
  /** `ps -o comm=` — 실행 파일 경로. */
  comm: string;
  /** `ps -o args=` — 인자를 공백으로 이은 한 줄. PGDATA의 공백은 그대로 나온다. */
  args: string;
}

export type LockOwner = { kind: "none" } | { kind: "orphan"; pid: number } | { kind: "stale"; pid: number };

/**
 * 락 파일의 pid가 누구인가.
 *
 * - 없음(프로세스가 없다) → PostgreSQL이 낡은 락을 스스로 처리한다.
 * - 실행 파일 **이름**이 postgres이고 `-D <우리 PGDATA>`를 가진다 → 이전 실행의 고아. 경로는 보지 않는다 — dev와
 *   packaged가 같은 클러스터를 다른 경로의 바이너리로 열고, 빌드된 .app의 위치도 정해져 있지 않다. 같은 PGDATA를
 *   쥔 postmaster는 PostgreSQL의 락 때문에 하나뿐이다.
 * - 그 밖 → pid가 재사용된 낡은 락. PostgreSQL은 이 경우 "lock file already exists"로 기동을 거부한다.
 */
export function classifyLockOwner(pgdata: string, info: ProcessInfo | null, pid: number): LockOwner {
  if (info === null) return { kind: "none" };
  const name = info.comm.split("/").pop() ?? "";
  const flag = ` -D ${pgdata}`;
  const at = info.args.indexOf(flag);
  const holdsOurs = at >= 0 && (at + flag.length === info.args.length || info.args[at + flag.length] === " ");
  return name === "postgres" && holdsOurs ? { kind: "orphan", pid } : { kind: "stale", pid };
}
