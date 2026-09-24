import * as fs from "fs";
import * as path from "path";
import type { CloneFn } from "../../process/clone";
import { readGeneration, writeGenerationAtomic } from "./generation";
import type { PgLayout } from "./layout";
import { assertDataTree, type SnapshotInfo, type SnapshotManifest } from "./snapshot";

/**
 * 되돌리기 저널과 교체 (Phase 6b-2 스펙 §6.2·§6.3). D = data/, R = data.replaced-<rid>/, S = restore-staging/<rid>/.
 * step은 **일을 마친 뒤에** 다음 값으로 쓴다. 표에 없는 경로 조합은 아무것도 옮기지 않고 RestoreIncomplete로 멈춘다 —
 * 그 상태에서 initdb로 빠지는 길은 없다(가드가 저널을 처리하지 못하면 postgres launch로 넘어가지 않는다).
 */

export type JournalStep = "requested" | "staged" | "moved-aside" | "hold";
const STEPS: readonly JournalStep[] = ["requested", "staged", "moved-aside", "hold"];

export interface RestoreJournal {
  id: string;
  snapshot: string;
  step: JournalStep;
  requestedAt: string;
  completedAt: string | null;
}

export class RestoreIncomplete extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreIncomplete";
  }
}

const RID = /^\d{8}T\d{6}Z(-\d+)?$/;

export function parseJournal(text: string): RestoreJournal | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !RID.test(o.id) || typeof o.snapshot !== "string" || typeof o.requestedAt !== "string") return null;
  if (typeof o.step !== "string" || !STEPS.includes(o.step as JournalStep)) return null;
  if (!(o.completedAt === null || typeof o.completedAt === "string")) return null;
  return { id: o.id, snapshot: o.snapshot, step: o.step as JournalStep, requestedAt: o.requestedAt, completedAt: o.completedAt };
}

export type JournalRead = { kind: "none" } | { kind: "ok"; journal: RestoreJournal } | { kind: "unreadable"; why: string };

export function readJournal(file: string): JournalRead {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return { kind: "unreadable", why: e instanceof Error ? e.message : String(e) };
  }
  const journal = parseJournal(text);
  return journal === null ? { kind: "unreadable", why: "형식이 맞지 않아요" } : { kind: "ok", journal };
}

export function writeJournalAtomic(file: string, j: RestoreJournal): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(j)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function removeJournal(file: string): void {
  fs.rmSync(file, { force: true });
}

export function replacedDirOf(layout: PgLayout, rid: string): string {
  return path.join(layout.userData, `data.replaced-${rid}`);
}

export function stagingDirOf(layout: PgLayout, rid: string): string {
  return path.join(layout.restoreStaging, rid);
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** §6.2 — 목적지 둘이 모두 비어 있는 rid. 충돌을 요청 시점에 없앤다. */
export function chooseRestoreId(layout: PgLayout, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  for (let i = 1; ; i += 1) {
    const rid = i === 1 ? stamp : `${stamp}-${i}`;
    if (!exists(replacedDirOf(layout, rid)) && !exists(stagingDirOf(layout, rid))) return rid;
  }
}

export interface AdvanceDeps {
  layout: PgLayout;
  clone: CloneFn;
  findSnapshot(id: string): SnapshotInfo | null;
  verifyIdentity(dir: string, m: SnapshotManifest, signal: AbortSignal): Promise<boolean>;
  now(): Date;
  log(line: string): void;
  /** 실측용(`DAMWHA_RESTORE_PAUSE_AFTER_STEP`, 스펙 §12.2-6). step을 쓴 **뒤**에 부른다. */
  pauseAfterStep?(step: JournalStep): Promise<void>;
}

export type AdvanceOutcome =
  | { kind: "hold"; journal: RestoreJournal; snapshot: SnapshotInfo | null; replacedDir: string }
  | { kind: "aborted"; reason: string };

function removeStaging(dir: string, log: (l: string) => void): void {
  try {
    if (!fs.lstatSync(dir).isDirectory()) return;
  } catch {
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  log(`되돌리기: 교체용 임시 사본을 지웠다 — ${dir}`);
}

function state(D: boolean, R: boolean, S: boolean): string {
  return `data/ ${D ? "있음" : "없음"}, 보관본 ${R ? "있음" : "없음"}, 임시 사본 ${S ? "있음" : "없음"}`;
}

export async function advanceJournal(d: AdvanceDeps, start: RestoreJournal, signal: AbortSignal): Promise<AdvanceOutcome> {
  const { layout } = d;
  const Rdir = replacedDirOf(layout, start.id);
  const Sdir = stagingDirOf(layout, start.id);
  let j = start;
  const advance = async (step: JournalStep, extra: Partial<RestoreJournal> = {}) => {
    j = { ...j, step, ...extra };
    writeJournalAtomic(layout.restoreJournal, j);
    d.log(`되돌리기: ${start.id} — ${step}`);
    await d.pauseAfterStep?.(step);
  };
  const markRestored = () => {
    const prev = readGeneration(layout.generationFile);
    writeGenerationAtomic(layout.generationFile, { build: prev?.build ?? null, snapshot: prev?.snapshot ?? null, restoredFrom: start.id });
  };

  for (;;) {
    const D = exists(layout.dataDir);
    const R = exists(Rdir);
    const S = exists(Sdir);
    switch (j.step) {
      case "requested": {
        if (R) throw new RestoreIncomplete(`요청할 때 없던 보관본이 있어요 (${state(D, R, S)}) — ${Rdir}`);
        const snap = d.findSnapshot(j.snapshot);
        try {
          if (snap === null) throw new Error(`되돌릴 스냅샷을 찾지 못했어요 (${j.snapshot})`);
          if (S) removeStaging(Sdir, d.log);
          fs.mkdirSync(layout.restoreStaging, { recursive: true, mode: 0o700 });
          await d.clone(path.join(snap.dir, "data"), Sdir, signal);
          assertDataTree(Sdir);
          if (!(await d.verifyIdentity(Sdir, snap.manifest, signal))) throw new Error("임시 사본이 스냅샷과 다른 데이터예요");
        } catch (e) {
          removeStaging(Sdir, d.log);
          removeJournal(layout.restoreJournal);
          const reason = e instanceof Error ? e.message : String(e);
          d.log(`되돌리기: 취소했다 — ${reason}`);
          return { kind: "aborted", reason };
        }
        await advance("staged");
        continue;
      }
      case "staged": {
        if (D && !R && S) fs.renameSync(layout.dataDir, Rdir);
        else if (!(!D && R && S)) throw new RestoreIncomplete(`교체를 이어 갈 수 없는 상태예요 (${state(D, R, S)})`);
        await advance("moved-aside");
        continue;
      }
      case "moved-aside": {
        const snap = d.findSnapshot(j.snapshot);
        if (snap === null) throw new RestoreIncomplete(`되돌릴 스냅샷을 찾지 못했어요 (${j.snapshot})`);
        if (!D && R && S) fs.renameSync(Sdir, layout.dataDir);
        else if (!(D && R && !S)) throw new RestoreIncomplete(`교체를 이어 갈 수 없는 상태예요 (${state(D, R, S)})`);
        if (!(await d.verifyIdentity(layout.dataDir, snap.manifest, signal))) {
          throw new RestoreIncomplete(`data/가 되돌리려던 스냅샷과 달라요 — ${layout.dataDir}`);
        }
        markRestored();
        await advance("hold", { completedAt: d.now().toISOString() });
        continue;
      }
      case "hold": {
        if (j.completedAt === null) await advance("hold", { completedAt: d.now().toISOString() });
        return { kind: "hold", journal: j, snapshot: d.findSnapshot(j.snapshot), replacedDir: Rdir };
      }
    }
  }
}
