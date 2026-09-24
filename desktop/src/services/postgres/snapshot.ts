import * as fs from "fs";
import * as path from "path";
import type { CloneFn } from "../../process/clone";
import type { PgLayout } from "./layout";
import { parseControldataClusterId, parseControldataState, parseMarker } from "./pairing";

/**
 * 판올림 스냅샷 (Phase 6b-2 스펙 §5). `<userData>/snapshots/<id>/{data/, manifest.json}`.
 * `manifest.complete === true`이고 이름이 `.partial`이 아닌 것만 스냅샷이다. 스냅샷은 **불변**이다 — 되돌리기는 늘
 * staging clone을 거친다(§6.3).
 */

export interface SnapshotManifest {
  id: string;
  createdAt: string;
  fromBuild: string | null;
  toBuild: string;
  /** 스냅샷 당시 `.damwha-generation` 원문. 미기록 스냅샷 재사용의 열쇠 (§5.2-7). */
  fromRecord: string | null;
  pgVersion: string;
  clusterId: string;
  databaseOid: number | null;
  clusterState: string;
  complete: true;
}

export interface SnapshotInfo {
  id: string;
  dir: string;
  manifest: SnapshotManifest;
}

export const KEEP_SNAPSHOTS = 2;
const SNAPSHOT_NAME = /^\d{8}T\d{6}Z(-\d+)?$/;
const PARTIAL_NAME = /^\d{8}T\d{6}Z(-\d+)?\.partial$/;

const str = (x: unknown): x is string => typeof x === "string";
const strOrNull = (x: unknown): x is string | null => x === null || typeof x === "string";

export function parseManifest(text: string): SnapshotManifest | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.complete !== true) return null;
  if (!str(o.id) || !str(o.createdAt) || !strOrNull(o.fromBuild) || !str(o.toBuild) || !strOrNull(o.fromRecord)) return null;
  if (!str(o.pgVersion) || !str(o.clusterId) || !str(o.clusterState)) return null;
  const oid = o.databaseOid;
  if (!(oid === null || (typeof oid === "number" && Number.isInteger(oid) && oid > 0))) return null;
  return {
    id: o.id, createdAt: o.createdAt, fromBuild: o.fromBuild, toBuild: o.toBuild, fromRecord: o.fromRecord,
    pgVersion: o.pgVersion, clusterId: o.clusterId, databaseOid: oid, clusterState: o.clusterState, complete: true,
  };
}

/** clone이 트리를 **바로 아래에** 놓았는가 (§3 P4 — `cp -R`의 중첩을 잡는다). */
export function assertDataTree(dir: string): void {
  if (!fs.statSync(path.join(dir, "postgres", "PG_VERSION")).isFile()) throw new Error(`${dir}/postgres/PG_VERSION이 없어요`);
  if (!fs.statSync(path.join(dir, "storage")).isDirectory()) throw new Error(`${dir}/storage가 없어요`);
}

function isRealDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readManifest(dir: string): SnapshotManifest | null {
  try {
    return parseManifest(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

function names(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function listCompleteSnapshots(snapshotsDir: string): SnapshotInfo[] {
  const out: SnapshotInfo[] = [];
  for (const name of names(snapshotsDir)) {
    if (!SNAPSHOT_NAME.test(name)) continue;
    const dir = path.join(snapshotsDir, name);
    if (!isRealDir(dir)) continue;
    const manifest = readManifest(dir);
    if (manifest === null || manifest.id !== name) continue;
    out.push({ id: name, dir, manifest });
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** §6.1 — 같은 PG 메이저이고 사본의 마커가 읽히는 것, 최신 KEEP_SNAPSHOTS개. */
export function restorableSnapshots(snapshotsDir: string, pgMajor: string): SnapshotInfo[] {
  return listCompleteSnapshots(snapshotsDir)
    .filter((s) => {
      if (s.manifest.pgVersion !== pgMajor) return false;
      try {
        return parseMarker(fs.readFileSync(path.join(s.dir, "data", "storage", ".damwha-cluster"), "utf8")) !== null;
      } catch {
        return false;
      }
    })
    .slice(0, KEEP_SNAPSHOTS);
}

/** §5.2-7 — 앞 기동이 세대 기록 전에 끊긴 완료 스냅샷. 기록 원문까지 같아야 같은 데이터의 사본이다. */
export function findUnrecorded(snapshotsDir: string, toBuild: string, fromRecord: string | null): SnapshotInfo | null {
  return listCompleteSnapshots(snapshotsDir).find((s) => s.manifest.toBuild === toBuild && s.manifest.fromRecord === fromRecord) ?? null;
}

function removeDir(dir: string, log: (l: string) => void, why: string): void {
  if (!isRealDir(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
  log(`스냅샷: 지웠다 (${why}) — ${dir}`);
}

export function removeIncompleteSnapshots(snapshotsDir: string, log: (l: string) => void): void {
  for (const name of names(snapshotsDir)) {
    const dir = path.join(snapshotsDir, name);
    if (PARTIAL_NAME.test(name)) removeDir(dir, log, "미완료");
    else if (SNAPSHOT_NAME.test(name) && isRealDir(dir) && readManifest(dir) === null) removeDir(dir, log, "manifest 없음");
  }
}

/** §5.3 — 최신 KEEP_SNAPSHOTS개와 보호 대상(저널이 가리키는 것)만 남긴다. */
export function pruneSnapshots(snapshotsDir: string, protect: ReadonlySet<string>, log: (l: string) => void): void {
  const all = listCompleteSnapshots(snapshotsDir);
  for (const s of all.slice(KEEP_SNAPSHOTS)) {
    if (protect.has(s.id)) continue;
    removeDir(s.dir, log, "보존 상한 초과");
  }
}

export interface TakeSnapshotDeps {
  layout: PgLayout;
  clone: CloneFn;
  readControldata(pgdata: string, signal: AbortSignal): Promise<string>;
  now(): Date;
  log(line: string): void;
}

function stampOf(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function freshId(snapshotsDir: string, stamp: string): string {
  for (let i = 1; ; i += 1) {
    const id = i === 1 ? stamp : `${stamp}-${i}`;
    if (!fs.existsSync(path.join(snapshotsDir, id)) && !fs.existsSync(path.join(snapshotsDir, `${id}.partial`))) return id;
  }
}

export async function takeSnapshot(
  d: TakeSnapshotDeps,
  input: { fromBuild: string | null; toBuild: string; fromRecord: string | null },
  signal: AbortSignal,
): Promise<SnapshotInfo> {
  const dir = d.layout.snapshots;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = freshId(dir, stampOf(d.now()));
  const partial = path.join(dir, `${id}.partial`);
  fs.mkdirSync(partial, { mode: 0o700 });
  try {
    const copy = path.join(partial, "data");
    await d.clone(d.layout.dataDir, copy, signal);
    assertDataTree(copy);
    const control = await d.readControldata(path.join(copy, "postgres"), signal);
    const clusterId = parseControldataClusterId(control);
    const clusterState = parseControldataState(control);
    if (clusterId === null || clusterState === null) throw new Error("스냅샷의 pg_controldata 출력을 읽지 못했어요");
    const marker = parseMarker(fs.readFileSync(path.join(copy, "storage", ".damwha-cluster"), "utf8"));
    if (marker === null) throw new Error("스냅샷의 짝 표시를 읽지 못했어요");
    const pgVersion = fs.readFileSync(path.join(copy, "postgres", "PG_VERSION"), "utf8").trim();
    const manifest: SnapshotManifest = {
      id,
      createdAt: d.now().toISOString(),
      fromBuild: input.fromBuild,
      toBuild: input.toBuild,
      fromRecord: input.fromRecord,
      pgVersion,
      clusterId,
      databaseOid: marker.databaseOid,
      clusterState,
      complete: true,
    };
    fs.writeFileSync(path.join(partial, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    const final = path.join(dir, id);
    fs.renameSync(partial, final);
    d.log(`스냅샷: 떴다 — ${final} (${input.fromBuild ?? "기록 없음"} → ${input.toBuild}, ${clusterState})`);
    return { id, dir: final, manifest };
  } catch (e) {
    removeDir(partial, d.log, "실패한 스냅샷");
    throw e;
  }
}
