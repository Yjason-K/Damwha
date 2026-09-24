import * as fs from "fs";
import * as path from "path";
import { CAUSES } from "../diagnostics/causes";
import type { CloneFn } from "../process/clone";
import { manualUnlessTagged, ServiceFailure } from "../services/failure";
import { needsSnapshot, readGeneration, readGenerationText, writeGenerationAtomic } from "../services/postgres/generation";
import { PG_MAJOR, type PgLayout } from "../services/postgres/layout";
import { clearPostmasterLock, type LockDeps } from "../services/postgres/lock";
import { decideCluster, parseControldataClusterId, parseMarker, readStorageFacts } from "../services/postgres/pairing";
import {
  advanceJournal,
  readJournal,
  removeJournal,
  RestoreIncomplete,
  type JournalStep,
  type RestoreJournal,
} from "../services/postgres/restore-journal";
import {
  findUnrecorded,
  listCompleteSnapshots,
  pruneSnapshots,
  removeIncompleteSnapshots,
  takeSnapshot,
  type SnapshotInfo,
  type SnapshotManifest,
} from "../services/postgres/snapshot";

/**
 * 데이터 가드 (Phase 6b-2 스펙 §5.2). postgres가 떠 있지 않을 때, 감독자가 postgres를 launch하기 **전에** 반드시 한 번
 * 통과한다 — 첫 기동과 "다시 시도" 둘 다. 순서: 외부 모드 → 저널(§6.3) → 판정표 1 → 락 → 스냅샷(§5.2-6~11).
 *
 * 대화상자는 여기 없다 — 보류는 결과로 돌려주고 main이 띄운다. 그래서 main은 이 함수 전체를 파일 I/O로 보고 종료
 * 흐름이 기다리게 등록할 수 있다(사람의 선택을 기다리는 순환이 없다).
 */

export interface DataGuardDeps {
  packaged: boolean;
  external: boolean;
  /**
   * 저널을 만났을 때. "advance" = 이어서 교체한다(첫 기동의 명시적 가드만). "refuse" = 아무것도 건드리지 않고
   * restorePending으로 거부한다 — postgres preLaunch 훅(자동 재시작·상태 창 재시작)은 API·worker가 떠 있을 수 있어
   * 그 자리에서 data/를 바꾸면 안 된다 (§3.1·§5.2).
   */
  journal: "advance" | "refuse";
  /** packaged에서 `Resources/build-info.json`을 읽은 값. dev·읽기 실패는 null. */
  currentBuild: string | null;
  buildInfoFile: string;
  layout: PgLayout;
  /** `LC_ALL=C pg_controldata -D <pgdata>`의 stdout. 실패하면 던진다. */
  readControldata(pgdata: string, signal: AbortSignal): Promise<string>;
  lock: LockDeps;
  clone: CloneFn;
  now(): Date;
  log(line: string): void;
  pauseAfterStep?(step: JournalStep): Promise<void>;
}

export type GuardOutcome =
  | { kind: "proceed"; snapshot: SnapshotInfo | null; notice: string | null }
  | { kind: "hold"; journal: RestoreJournal; snapshot: SnapshotInfo | null; replacedDir: string };

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function protectedIds(layout: PgLayout): Set<string> {
  const j = readJournal(layout.restoreJournal);
  return new Set(j.kind === "ok" ? [j.journal.snapshot] : []);
}

async function verifyIdentity(d: DataGuardDeps, dir: string, m: SnapshotManifest, signal: AbortSignal): Promise<boolean> {
  try {
    // 번들 메이저가 아니면 이 postgres로 열 수 없다 (§6.1). manifest가 아니라 사본의 실제 파일을 본다.
    if (fs.readFileSync(path.join(dir, "postgres", "PG_VERSION"), "utf8").trim() !== PG_MAJOR) return false;
    const id = parseControldataClusterId(await d.readControldata(path.join(dir, "postgres"), signal));
    const marker = parseMarker(fs.readFileSync(path.join(dir, "storage", ".damwha-cluster"), "utf8"));
    return id === m.clusterId && marker !== null && marker.clusterId === m.clusterId && marker.databaseOid === m.databaseOid;
  } catch {
    return false;
  }
}

export function runDataGuard(d: DataGuardDeps, signal: AbortSignal): Promise<GuardOutcome> {
  return manualUnlessTagged(async () => {
    const { layout } = d;
    if (d.external) return { kind: "proceed", snapshot: null, notice: null };

    let notice: string | null = null;
    const jr = readJournal(layout.restoreJournal);
    // 락 정리·파일 조작보다 **먼저** — 거부 경로는 아무것도 만들거나 지우지 않는다.
    if (d.journal === "refuse" && jr.kind !== "none") throw new ServiceFailure(CAUSES.restorePending.text(), "manual");
    if (jr.kind === "unreadable") throw new ServiceFailure(CAUSES.restoreJournalUnreadable.text(layout.restoreJournal, jr.why), "manual");
    if (jr.kind === "ok") {
      await clearPostmasterLock(d.lock);
      try {
        const out = await advanceJournal(
          {
            layout,
            clone: d.clone,
            // §6.1 조건을 저널 경로에서도 다시 본다 — 손상되거나 오래된 저널이 메이저가 다른 스냅샷을 가리킬 수 있다.
            // restorableSnapshots(최신 2개)를 쓰지 않는 이유: 저널이 보호하는 스냅샷은 상한 밖(3번째)일 수 있다.
            findSnapshot: (id) => listCompleteSnapshots(layout.snapshots).find((s) => s.id === id && s.manifest.pgVersion === PG_MAJOR) ?? null,
            verifyIdentity: (dir, m, sig) => verifyIdentity(d, dir, m, sig),
            now: d.now,
            log: d.log,
            pauseAfterStep: d.pauseAfterStep,
          },
          jr.journal,
          signal,
        );
        if (out.kind === "hold") {
          // 보류 중에도 정리는 돈다 — 저널이 가리키는 스냅샷만은 지키면서 (§5.3).
          pruneSnapshots(layout.snapshots, new Set([jr.journal.snapshot]), d.log);
          return out;
        }
        notice = CAUSES.restoreAborted.text(out.reason);
      } catch (e) {
        if (e instanceof RestoreIncomplete) throw new ServiceFailure(CAUSES.restoreIncomplete.text(e.message), "manual");
        if (e instanceof ServiceFailure) throw e;
        throw new ServiceFailure(CAUSES.restoreIncomplete.text(reasonOf(e)), "manual");
      }
    }

    if (d.packaged && d.currentBuild === null) throw new ServiceFailure(CAUSES.buildInfoMissing.text(d.buildInfoFile), "manual");

    // 판정표 1 (§5.2-4). 거부로 끝날 클러스터에서는 아무것도 만들지 않고 락도 건드리지 않는다 — 거부는 postgres 어댑터가 낸다.
    if (!fs.existsSync(layout.pgdata)) return { kind: "proceed", snapshot: null, notice };
    let pgVersion: string | null = null;
    try {
      pgVersion = fs.readFileSync(path.join(layout.pgdata, "PG_VERSION"), "utf8").trim();
    } catch {
      pgVersion = null;
    }
    let clusterId: string | null = null;
    if (pgVersion === PG_MAJOR) {
      try {
        clusterId = parseControldataClusterId(await d.readControldata(layout.pgdata, signal));
      } catch {
        clusterId = null;
      }
    }
    const decision = decideCluster({ pgdataExists: true, pgVersion, clusterId, storage: readStorageFacts(layout.storage) });
    if (decision.kind !== "start") return { kind: "proceed", snapshot: null, notice };

    await clearPostmasterLock(d.lock);

    const recordedText = readGenerationText(layout.generationFile);
    const recorded = readGeneration(layout.generationFile);
    if (!needsSnapshot({ packaged: d.packaged, currentBuild: d.currentBuild, recorded })) return { kind: "proceed", snapshot: null, notice };
    const currentBuild = d.currentBuild as string;

    let snapshot: SnapshotInfo;
    try {
      removeIncompleteSnapshots(layout.snapshots, d.log);
      snapshot =
        findUnrecorded(layout.snapshots, currentBuild, recordedText) ??
        (await takeSnapshot(
          { layout, clone: d.clone, readControldata: d.readControldata, now: d.now, log: d.log },
          { fromBuild: recorded?.build ?? null, toBuild: currentBuild, fromRecord: recordedText },
          signal,
        ));
      writeGenerationAtomic(layout.generationFile, { build: currentBuild, snapshot: snapshot.id });
    } catch (e) {
      throw new ServiceFailure(CAUSES.snapshotFailed.text(reasonOf(e), layout.snapshots), "manual");
    }
    // 방금 뜬 스냅샷도 지킨다 — 시계가 뒤로 가 있으면 그 id가 가장 오래된 것으로 정렬돼 상한 밖으로 밀린다.
    pruneSnapshots(layout.snapshots, new Set([...protectedIds(layout), snapshot.id]), d.log);
    return { kind: "proceed", snapshot, notice };
  });
}

/** 보류 해제 — [이 판으로 계속] (§7.3). 다음 가드가 새 스냅샷을 뜬다. */
export function releaseHold(layout: PgLayout): void {
  removeJournal(layout.restoreJournal);
}
