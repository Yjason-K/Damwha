import * as fs from "fs";
import * as path from "path";

/**
 * 판올림 판정의 재료 (Phase 6b-2 스펙 §4·§5.1). electron을 import하지 않는다.
 *
 * 빌드 식별자는 `package.mjs`가 `Resources/build-info.json`으로 싣는다 — `package.json` 버전만으로는 개발 빌드와
 * 발행판이 같은 `0.3.1`을 말한다. 세대 기록은 `data/` **안**에 둔다: 되돌리기가 들여놓은 `data/`는 스냅샷 당시의
 * 기록을 함께 가져오므로, 되돌린 뒤 재업그레이드가 스냅샷 없이 지나가지 않는다(스펙 §5.1).
 */

export interface BuildInfo {
  version: string;
  commit: string;
}

const COMMIT = /^[0-9a-f]{12}(-dirty)?$/;

function objectOf(text: string): Record<string, unknown> | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseBuildInfo(text: string): BuildInfo | null {
  const o = objectOf(text);
  if (o === null) return null;
  const { version, commit } = o;
  if (typeof version !== "string" || version === "" || typeof commit !== "string" || !COMMIT.test(commit)) return null;
  return { version, commit };
}

export function buildIdOf(b: BuildInfo): string {
  return `${b.version}+${b.commit}`;
}

export interface GenerationRecord {
  build: string | null;
  snapshot: string | null;
  /** 되돌리기 교체가 적는다 (스펙 §6.3). 기록 원문을 반드시 바꿔 옛 스냅샷의 재사용을 막는다. */
  restoredFrom?: string;
}

const nullableString = (x: unknown): x is string | null => x === null || typeof x === "string";

export function parseGeneration(text: string): GenerationRecord | null {
  const o = objectOf(text);
  if (o === null) return null;
  const { build, snapshot, restoredFrom } = o;
  if (!nullableString(build) || !nullableString(snapshot)) return null;
  if (restoredFrom !== undefined && typeof restoredFrom !== "string") return null;
  return restoredFrom === undefined ? { build, snapshot } : { build, snapshot, restoredFrom };
}

/** 원문(끝 개행 제외). 없거나 못 읽으면 null. 스냅샷 manifest의 `fromRecord`와 비교하는 값이다 (§5.2-7). */
export function readGenerationText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").trimEnd();
  } catch {
    return null;
  }
}

export function readGeneration(file: string): GenerationRecord | null {
  const text = readGenerationText(file);
  return text === null ? null : parseGeneration(text);
}

export function writeGenerationAtomic(file: string, rec: GenerationRecord): void {
  const tmp = path.join(path.dirname(file), `.damwha-generation.tmp-${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** §5.1 조건 4. dev는 스냅샷을 뜨지 않는다 — dev·packaged를 오갈 때마다 뜨면 보존 상한이 진짜 복원점을 밀어낸다. */
export function needsSnapshot(i: { packaged: boolean; currentBuild: string | null; recorded: GenerationRecord | null }): boolean {
  if (!i.packaged || i.currentBuild === null) return false;
  return i.recorded === null || i.recorded.build !== i.currentBuild;
}
