import * as fs from "fs";
import * as path from "path";
import { PG_MAJOR } from "./layout";

/**
 * 클러스터와 스토리지가 같은 쌍임을 증명하는 판정 (Phase 3 스펙 §6.2).
 *
 * 스토리지 키는 `meetings/<meeting.id>/…`이고 id는 시퀀스라, 새 클러스터는 1번부터 다시 센다. 다른 DB의 행이 만든
 * 파일 옆에 새 DB를 짝지으면 그 번호에 닿는 순간 원본을 덮는다. 신원은 두 층이다 — 클러스터(system identifier)와
 * 데이터베이스(damwha의 oid). 같은 클러스터에서 DB만 지우고 다시 만들어도 시퀀스는 1로 돌아간다(외부 리뷰 #1).
 */

export interface ClusterMarker {
  clusterId: string;
  /** damwha 데이터베이스를 만들기 전에는 null. */
  databaseOid: number | null;
}

export function serializeMarker(m: ClusterMarker): string {
  return `${JSON.stringify({ clusterId: m.clusterId, databaseOid: m.databaseOid })}\n`;
}

export function parseMarker(text: string): ClusterMarker | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { clusterId, databaseOid } = value as Record<string, unknown>;
  if (typeof clusterId !== "string" || clusterId === "") return null;
  if (databaseOid === null) return { clusterId, databaseOid: null };
  if (typeof databaseOid !== "number" || !Number.isInteger(databaseOid) || databaseOid <= 0) return null;
  return { clusterId, databaseOid };
}

/** 임시 파일에 쓰고 rename한다. 반쯤 쓴 마커는 짝을 증명하지 못한다. */
export function writeMarkerAtomic(markerPath: string, m: ClusterMarker): void {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  const tmp = `${markerPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, serializeMarker(m), { mode: 0o600 });
  fs.renameSync(tmp, markerPath);
}

export interface StorageFacts {
  markerText: string | null;
  /** 마커·그 임시 파일·.DS_Store 말고 무엇이든 있으면 true. 빈 meetings/도 센다 — 누가 왜 만들었는지 모른다. */
  hasFiles: boolean;
}

const MARKER_NAME = ".damwha-cluster";

export function readStorageFacts(storageDir: string): StorageFacts {
  let names: string[];
  try {
    names = fs.readdirSync(storageDir);
  } catch {
    return { markerText: null, hasFiles: false };
  }
  let markerText: string | null = null;
  if (names.includes(MARKER_NAME)) {
    try {
      markerText = fs.readFileSync(path.join(storageDir, MARKER_NAME), "utf8");
    } catch {
      markerText = null;
    }
  }
  const hasFiles = names.some((n) => n !== MARKER_NAME && n !== ".DS_Store" && !n.startsWith(`${MARKER_NAME}.tmp-`));
  return { markerText, hasFiles };
}

/** `LC_ALL=C pg_controldata`의 한 줄. */
export function parseControldataClusterId(stdout: string): string | null {
  const m = /^Database system identifier:\s+(\d+)\s*$/m.exec(stdout);
  return m === null ? null : m[1];
}

/** `LC_ALL=C pg_controldata`의 `Database cluster state:` 줄 (Phase 6b-2 스펙 §5.2-8). */
export function parseControldataState(stdout: string): string | null {
  const m = /^Database cluster state:\s+(.+?)\s*$/m.exec(stdout);
  return m === null ? null : m[1];
}

export interface ClusterFacts {
  pgdataExists: boolean;
  /** PG_VERSION의 내용. 없거나 못 읽으면 null. */
  pgVersion: string | null;
  /** pg_controldata가 준 id. 부르지 않았거나 실패하면 null. */
  clusterId: string | null;
  storage: StorageFacts;
}

export type ClusterRefusal =
  | "storage-without-cluster"
  | "cluster-without-marker"
  | "marker-unreadable"
  | "marker-mismatch"
  | "version-mismatch"
  | "controldata-failed";

export type ClusterDecision =
  | { kind: "initdb" }
  | { kind: "start"; marker: ClusterMarker }
  | { kind: "refuse"; reason: ClusterRefusal; detail?: string | null };

/**
 * 판정표 1. 마커는 initdb가 끝난 임시 디렉터리를 data/postgres로 옮기기 **전에** 쓰므로(스펙 §6.4 기동 3단계),
 * "클러스터는 있는데 마커가 없다"는 앱이 만든 클러스터에서 생길 수 없다 — 누가 가져다 놓았는지 모르는 클러스터에
 * 마이그레이션을 실행하지 않도록 언제나 거부한다.
 */
export function decideCluster(f: ClusterFacts): ClusterDecision {
  if (!f.pgdataExists) {
    return f.storage.hasFiles ? { kind: "refuse", reason: "storage-without-cluster" } : { kind: "initdb" };
  }
  if (f.pgVersion !== PG_MAJOR) return { kind: "refuse", reason: "version-mismatch", detail: f.pgVersion };
  if (f.clusterId === null) return { kind: "refuse", reason: "controldata-failed" };
  if (f.storage.markerText === null) return { kind: "refuse", reason: "cluster-without-marker" };
  const marker = parseMarker(f.storage.markerText);
  if (marker === null) return { kind: "refuse", reason: "marker-unreadable" };
  if (marker.clusterId !== f.clusterId) return { kind: "refuse", reason: "marker-mismatch" };
  return { kind: "start", marker };
}

export type DatabaseRefusal = "database-dropped" | "database-recreated" | "storage-without-database";

export type DatabaseDecision =
  | { kind: "createdb" }
  | { kind: "record-oid"; oid: number }
  | { kind: "ok" }
  | { kind: "refuse"; reason: DatabaseRefusal };

/** 판정표 2. 서버가 물리적으로 준비된 뒤, 게이트를 열기 전에 한다. */
export function decideDatabase(input: { oid: number | null; marker: ClusterMarker; storageHasFiles: boolean }): DatabaseDecision {
  const { oid, marker, storageHasFiles } = input;
  if (oid === null) {
    if (marker.databaseOid !== null) return { kind: "refuse", reason: "database-dropped" };
    return storageHasFiles ? { kind: "refuse", reason: "storage-without-database" } : { kind: "createdb" };
  }
  if (marker.databaseOid === null) {
    return storageHasFiles ? { kind: "refuse", reason: "storage-without-database" } : { kind: "record-oid", oid };
  }
  return marker.databaseOid === oid ? { kind: "ok" } : { kind: "refuse", reason: "database-recreated" };
}
