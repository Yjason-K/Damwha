import * as fs from "fs";
import * as path from "path";
import { CAUSES } from "../../diagnostics/causes";
import { ServiceFailure } from "../failure";
import type { PostmasterStopResult } from "./handle";
import type { PgLayout } from "./layout";
import { classifyLockOwner, parsePostmasterPid, type ProcessInfo } from "./pidfile";

/**
 * 앞 실행의 postmaster 락 처리 (Phase 3 스펙 §6.4, Phase 6b-2 스펙 §5.2-5). postgres 어댑터와 데이터 가드가 함께 쓴다 —
 * 가드는 스냅샷·교체 **전에** 살아 있는 postmaster가 없음을 증명해야 한다. 거부는 아무것도 지우지 않는다.
 */
export interface LockDeps {
  layout: PgLayout;
  psInfo(pid: number): Promise<ProcessInfo | null>;
  stopOrphan(pid: number): Promise<PostmasterStopResult>;
  log(line: string): void;
}

function refuse(text: string): never {
  throw new ServiceFailure(text, "manual");
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export async function clearPostmasterLock(deps: LockDeps): Promise<void> {
  const { layout } = deps;
  const pidPath = path.join(layout.pgdata, "postmaster.pid");
  const text = readIfExists(pidPath);
  const pidfile = text === null ? null : parsePostmasterPid(text);
  if (pidfile === null) return;
  let info: ProcessInfo | null;
  try {
    info = await deps.psInfo(pidfile.pid);
  } catch (e) {
    refuse(CAUSES.pgLockUnprovable.text(pidfile.pid, pidPath, reasonOf(e)));
  }
  const owner = classifyLockOwner(layout.pgdata, info, pidfile.pid);
  if (owner.kind === "none") return;
  if (owner.kind === "orphan") {
    deps.log(`postgres: 이전 실행이 남긴 postmaster(pid ${owner.pid})를 내린다 — 채택하지 않는다(옛 바이너리일 수 있다)`);
    const how = await deps.stopOrphan(owner.pid);
    deps.log(`postgres: 고아 postmaster(pid ${owner.pid}) 종료 결과 — ${how}`);
    if (how === "leaked") refuse(CAUSES.pgOrphanStuck.text(owner.pid));
    return;
  }
  // pid가 재사용됐다. 그 pid가 우리 postgres가 아님을 확인했으므로 락은 낡았다 (§5 두 번째 삭제).
  for (const lock of [pidPath, `${layout.socketFile}.lock`]) {
    try {
      if (!fs.lstatSync(lock).isFile()) continue;
    } catch {
      continue;
    }
    fs.rmSync(lock);
    deps.log(`postgres: 낡은 락을 지웠다 — ${lock} (pid ${owner.pid}는 ${info?.comm ?? "?"})`);
  }
}
