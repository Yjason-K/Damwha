# Electron Phase 6b-2 — 업데이트 전 스냅샷·되돌리기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** packaged 판올림 때 `data/`를 APFS clone 스냅샷으로 뜨고, 앱 메뉴 → 재시작 → 기동 초기 교체 → 보류 대화상자로 업데이트 직전 상태(0.3.1 포함)로 되돌릴 수 있게 한다.

**Architecture:** 감독자가 postgres를 launch하기 전에 반드시 통과하는 **데이터 가드**(`app/data-guard.ts`)가 저널 처리 → 판정표 1 → 락 처리 → 스냅샷을 조립한다. 스냅샷·저널·세대 기록·락은 `services/postgres/` 아래 테스트 가능한 순수+얇은 fs 모듈이고, `main.ts`는 배선만 한다. clone은 `/bin/cp -c -R` 자식 프로세스다(Node `fs.cp`는 macOS에서 clone하지 않는다).

**Tech Stack:** Electron 44 / TypeScript / vitest (desktop), 번들 PostgreSQL 16 도구(`pg_controldata`), `/bin/cp -c`.

**Spec:** `docs/superpowers/specs/2026-09-24-electron-phase-6b-restore-design.md` (이하 "스펙"). 실행자는 계획과 스펙을 함께 읽는다. 스펙 §3(스파이크)·§3.1(코드 제약)·§6.3(교체 표)은 반드시 읽는다.

## Global Constraints

- 작업 디렉터리 규칙: 루트 `CLAUDE.md`·`desktop/CLAUDE.md`를 따른다. `npm install` 금지, 패키지를 루트에서 띄우지 않는다.
- **테스트 실행**: 단일 파일은 `pnpm --filter damwha-desktop exec vitest run <path>`. **`pnpm desktop exec vitest …`는 테스트 0개로 exit 0이 되는 거짓 초록불이다 — 쓰지 않는다.**
- `git add -A` 금지. 파일을 이름으로 add한다. 추적되지 않은 `docs/images/2026-09-20/`은 건드리지 않는다.
- 커밋 메시지는 한국어, 이 저장소 관례(`feat(desktop): …`, `test(phase6b): …`, `docs(phase6b): …`), 끝에 `Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77`.
- `desktop/package.json`의 `dependencies`는 비어 있어야 한다(번들 위생). 새 런타임 의존성 금지.
- `main.ts`는 electron을 값으로 import해 vitest가 못 부른다 — 판단은 테스트 가능한 모듈에, `main.ts`에는 배선만.
- `src/app/`·`src/windows/`의 순수 모듈은 electron을 **값으로** import하지 않는다(`import type`만).
- postmaster에는 SIGKILL을 보내지 않는다(`handle.ts`의 신호 타입이 막는다).
- 거부 경로(판정표 거부·락 확인 불가·저널 읽기 불가·교체 표의 "그 밖의 조합")는 아무것도 만들거나 지우지 않는다.
- 앱이 지우는 것(스펙 §10): initdb 임시물·증명한 낡은 락·5개 초과 덤프(+sidecar)·`.dump.partial`·보존 상한을 넘은 완료 스냅샷·미완료 스냅샷·`restore-staging/<rid>`. **`data.replaced-*`는 절대 지우지 않는다.**
- 모든 파일 삭제는 앱이 만드는 이름 형식 + `lstat`으로 심볼릭 링크가 아님을 확인한 뒤에만, 지운 경로를 로그에 남긴다.
- 스냅샷 보존 `KEEP_SNAPSHOTS = 2`. 빌드 식별자 = `<version>+<commit 12자>[-dirty]`.
- 문구는 스펙 §5.4·§7.2·§7.3의 한국어를 그대로 쓴다.
- 코드를 바꾼 Task의 끝에는 `graphify update .`를 루트에서 돌린다(그래프는 gitignore — 커밋하지 않음).

## Review Focus

1. **clone 목적지가 이미 있을 때** — `cp -c -R`은 그 안에 중첩한다(`dst/data`). 사람은 "이미 있으면 거부"를 기대한다. → Task 2의 실제 디렉터리 테스트 `refuses an existing destination`.
2. **스냅샷 중 앱 종료** — 감독자가 없으면 `stopServices`가 곧바로 끝나 `cp`가 Electron 뒤에 남는다. 사람은 "종료가 복사를 기다린다"를 기대한다. → Task 8의 `stopServices` 배선과 Task 7의 `trackIo` 테스트.
3. **되돌린 뒤 [이 판으로 계속]** — 옛 스냅샷이 재사용되면 이전 판에서 쓴 데이터가 복원점에서 빠진다. → Task 4의 `restoredFrom` 기록과 Task 2의 `findUnrecorded ignores a snapshot whose fromRecord differs`.
4. **마이그레이션 "다시 시도" 반복(부분 성공 포함)** — 업그레이드 시작 덤프가 남아야 한다. → Task 6의 `keeps the first dump of a generation through six partial-success retries`.
5. **교체 중 크래시 뒤 `data/` 없음** — 다음 기동이 `initdb`로 빠지면 회의가 전부 사라진 것처럼 보인다. → Task 5의 `journal is processed before decideCluster when data/ is missing`.

---

## 파일 구조

| 파일 | 책임 | Task |
| --- | --- | --- |
| `desktop/src/services/postgres/layout.ts` (수정) | `snapshots`·`restoreStaging`·`restoreJournal`·`generationFile` 경로 | 1 |
| `desktop/src/services/postgres/generation.ts` (신설) | 빌드 정보·세대 기록 파싱/쓰기·`needsSnapshot` | 1 |
| `desktop/scripts/package.mjs`, `desktop/scripts/check-bundle.mjs` (수정) | `build/build-info.json` 생성·단언 | 1 |
| `desktop/src/process/clone.ts` (신설) | `/bin/cp -c -R` 래퍼, 목적지 부재 강제 | 2 |
| `desktop/src/services/postgres/snapshot.ts` (신설) | 스냅샷 만들기·manifest·목록·재사용·정리·되돌릴 수 있는 것 | 2 |
| `desktop/src/services/postgres/pairing.ts` (수정) | `parseControldataState` | 2 |
| `desktop/src/services/postgres/lock.ts` (신설) | `handleLock()`을 꺼낸 `clearPostmasterLock` | 3 |
| `desktop/src/services/postgres/service.ts` (수정) | `lock.ts` 사용 | 3 |
| `desktop/src/services/postgres/restore-journal.ts` (신설) | 저널 파싱·쓰기·§6.3 step 기계 | 4 |
| `desktop/src/diagnostics/causes.ts`, `desktop/src/windows/shell-hints.ts` (수정) | 새 원인 6개와 안내 | 5 |
| `desktop/src/app/data-guard.ts` (신설) | 가드 조립 | 5 |
| `desktop/src/app/reap-on-start.ts` (수정) | 회수 뒤 생존자 재스캔 → `writersAlive` | 5 |
| `desktop/src/services/postgres/migration-gate.ts` (수정) | 덤프 sidecar·세대별 첫 덤프 고정 | 6 |
| `desktop/src/app/quit-flow.ts` (수정) | `commit` 단계 | 7 |
| `desktop/src/app/restore-flow.ts` (신설) | 메뉴 활성·대화상자 옵션·보류 선택·pause env·`trackIo` | 7 |
| `desktop/src/windows/menu-template.ts`, `desktop/src/windows/menu.ts` (수정) | 메뉴 항목·활성 | 7 |
| `desktop/src/windows/status-view.ts` (수정) | 실패 화면의 되돌리기 안내 한 줄 | 7 |
| `desktop/src/main.ts` (수정) | 배선 | 8 |
| `docs/RESTORE.md` (신설), `desktop/CLAUDE.md` (수정) | 수동 절차·계약 | 9 |
| `docs/superpowers/reports/2026-09-24-electron-phase-6b-restore-mutations.md` (신설) | 변이 기록 | 10 |
| `docs/superpowers/reports/2026-09-24-electron-phase-6b-restore-results.md` (신설), `docs/electron-migration-roadmap.md` (수정) | packaged 실측·결과 | 11 |

테스트는 `desktop/tests/`가 `src/`와 같은 트리다(`tests/services/postgres/snapshot.test.ts` ↔ `src/services/postgres/snapshot.ts`).

---

### Task 1: 경로·빌드 식별자·세대 기록

**Files:**
- Modify: `desktop/src/services/postgres/layout.ts` (`PgLayout`, `pgLayout`)
- Create: `desktop/src/services/postgres/generation.ts`
- Modify: `desktop/scripts/package.mjs` (electron-builder 호출 전), `desktop/scripts/check-bundle.mjs`
- Test: `desktop/tests/services/postgres/layout.test.ts`, `desktop/tests/services/postgres/generation.test.ts`

**Interfaces:**
- Produces:
  - `PgLayout.snapshots: string` (`<userData>/snapshots`), `PgLayout.restoreStaging: string` (`<userData>/restore-staging`), `PgLayout.restoreJournal: string` (`<userData>/restore-journal.json`), `PgLayout.generationFile: string` (`<userData>/data/.damwha-generation`)
  - `interface BuildInfo { version: string; commit: string }`, `parseBuildInfo(text: string): BuildInfo | null`, `buildIdOf(b: BuildInfo): string`
  - `interface GenerationRecord { build: string | null; snapshot: string | null; restoredFrom?: string }`
  - `parseGeneration(text: string): GenerationRecord | null`, `readGenerationText(file: string): string | null`, `readGeneration(file: string): GenerationRecord | null`, `writeGenerationAtomic(file: string, rec: GenerationRecord): void`
  - `needsSnapshot(i: { packaged: boolean; currentBuild: string | null; recorded: GenerationRecord | null }): boolean`

- [ ] **Step 1: layout 테스트에 새 경로를 더한다** — `desktop/tests/services/postgres/layout.test.ts`의 기존 `pgLayout` 테스트 옆에:

```ts
it("places snapshot, staging, journal next to data/ and the generation record inside it", () => {
  const l = pgLayout("/U");
  expect(l.snapshots).toBe("/U/snapshots");
  expect(l.restoreStaging).toBe("/U/restore-staging");
  expect(l.restoreJournal).toBe("/U/restore-journal.json");
  expect(l.generationFile).toBe("/U/data/.damwha-generation");
});
```

- [ ] **Step 2: 실패 확인** — `pnpm --filter damwha-desktop exec vitest run tests/services/postgres/layout.test.ts` → FAIL (`undefined`).

- [ ] **Step 3: layout 구현** — `PgLayout`에 네 필드(주석 포함)를 더하고 `pgLayout`이 채운다:

```ts
  /** 판올림 스냅샷 (Phase 6b-2 스펙 §4). data/와 같은 볼륨의 형제다 — 안에 두면 clone과 교체의 경계가 꼬인다. */
  snapshots: string;
  /** 되돌리기 교체용 임시 clone (§6.3). */
  restoreStaging: string;
  /** 되돌리기 저널 (§6.2). */
  restoreJournal: string;
  /** 이 data/를 마지막으로 연 packaged 빌드 (§5.1). data/ **안**이라 되돌리기가 함께 되감는다. */
  generationFile: string;
```

```ts
    snapshots: path.join(userData, "snapshots"),
    restoreStaging: path.join(userData, "restore-staging"),
    restoreJournal: path.join(userData, "restore-journal.json"),
    generationFile: path.join(dataDir, ".damwha-generation"),
```

- [ ] **Step 4: generation 테스트 작성** — `desktop/tests/services/postgres/generation.test.ts`:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildIdOf,
  needsSnapshot,
  parseBuildInfo,
  parseGeneration,
  readGeneration,
  readGenerationText,
  writeGenerationAtomic,
} from "../../../src/services/postgres/generation";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-gen-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("build info", () => {
  it("parses version and a 12-char commit, optionally dirty", () => {
    expect(parseBuildInfo('{"version":"0.4.0","commit":"0123456789ab"}')).toEqual({ version: "0.4.0", commit: "0123456789ab" });
    expect(parseBuildInfo('{"version":"0.4.0","commit":"0123456789ab-dirty"}')?.commit).toBe("0123456789ab-dirty");
    expect(buildIdOf({ version: "0.4.0", commit: "0123456789ab" })).toBe("0.4.0+0123456789ab");
  });
  it.each([
    ["not json", "nope"],
    ["empty version", '{"version":"","commit":"0123456789ab"}'],
    ["short commit", '{"version":"0.4.0","commit":"0123"}'],
    ["upper-case commit", '{"version":"0.4.0","commit":"0123456789AB"}'],
    ["array", "[]"],
  ])("rejects %s", (_n, text) => expect(parseBuildInfo(text)).toBeNull());
});

describe("generation record", () => {
  it("round-trips atomically and leaves no temp file", () => {
    const file = path.join(root, "data", ".damwha-generation");
    fs.mkdirSync(path.dirname(file));
    writeGenerationAtomic(file, { build: "0.4.0+0123456789ab", snapshot: "20260924T084933Z" });
    expect(readGeneration(file)).toEqual({ build: "0.4.0+0123456789ab", snapshot: "20260924T084933Z" });
    expect(fs.readdirSync(path.dirname(file))).toEqual([".damwha-generation"]);
    expect(readGenerationText(file)).toBe('{"build":"0.4.0+0123456789ab","snapshot":"20260924T084933Z"}');
  });
  it("keeps restoredFrom and accepts null build/snapshot", () => {
    expect(parseGeneration('{"build":null,"snapshot":null,"restoredFrom":"20260925T010203Z"}')).toEqual({
      build: null,
      snapshot: null,
      restoredFrom: "20260925T010203Z",
    });
  });
  it("reads missing or garbage as null", () => {
    expect(readGeneration(path.join(root, "nope"))).toBeNull();
    fs.writeFileSync(path.join(root, "bad"), "{");
    expect(readGeneration(path.join(root, "bad"))).toBeNull();
    expect(parseGeneration('{"build":3,"snapshot":null}')).toBeNull();
  });
});

describe("needsSnapshot", () => {
  const rec = { build: "0.4.0+0123456789ab", snapshot: "S" };
  it("never in dev, even with no record", () => {
    expect(needsSnapshot({ packaged: false, currentBuild: "0.4.0+0123456789ab", recorded: null })).toBe(false);
  });
  it("packaged: no record → yes, different build → yes, same build → no", () => {
    expect(needsSnapshot({ packaged: true, currentBuild: "0.4.0+0123456789ab", recorded: null })).toBe(true);
    expect(needsSnapshot({ packaged: true, currentBuild: "0.4.1+ba9876543210", recorded: rec })).toBe(true);
    expect(needsSnapshot({ packaged: true, currentBuild: "0.4.0+0123456789ab", recorded: rec })).toBe(false);
  });
  it("a restored record (build from before the update) needs a new snapshot", () => {
    expect(needsSnapshot({ packaged: true, currentBuild: "0.4.0+0123456789ab", recorded: { build: null, snapshot: null, restoredFrom: "R" } })).toBe(true);
  });
});
```

- [ ] **Step 5: 실패 확인** — `pnpm --filter damwha-desktop exec vitest run tests/services/postgres/generation.test.ts` → FAIL (모듈 없음).

- [ ] **Step 6: generation 구현** — `desktop/src/services/postgres/generation.ts`:

```ts
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
```

- [ ] **Step 7: 통과 확인** — Step 2·5의 두 명령 → PASS.

- [ ] **Step 8: package.mjs가 build-info를 스테이징한다** — `desktop/scripts/package.mjs`에서 `run("pnpm", ["exec", "electron-builder", "--dir"], desktop);` **바로 앞**에:

```js
// 빌드 식별자 (Phase 6b-2 스펙 §4). extraResources(from: build)가 Resources/build-info.json으로 싣는다.
// 앱은 이것을 data/.damwha-generation과 비교해 판올림을 알아챈다 — package.json 버전만으로는 개발 빌드와
// 발행판이 같은 값을 말한다. 작업 트리가 더러우면 -dirty를 붙인다(같은 커밋의 다른 코드를 구별한다).
const commit = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
const dirty = spawnSync("git", ["status", "--porcelain", "--", "desktop", "be", "fe", "packages"], { cwd: repo, encoding: "utf8" }).stdout.trim() !== "";
if (!/^[0-9a-f]{12}$/.test(commit)) throw new Error(`git 커밋을 읽지 못했어요: ${JSON.stringify(commit)}`);
fs.writeFileSync(
  path.join(desktop, "build", "build-info.json"),
  `${JSON.stringify({ version: desktopPkg.version, commit: dirty ? `${commit}-dirty` : commit })}\n`,
);
```

`spawnSync`가 import돼 있지 않으면 파일 머리의 `child_process` import에 더한다(`grep -n "child_process" desktop/scripts/package.mjs`로 확인). `desktopPkg`는 파일 위쪽(`assertReleaseTag(... desktopPkg.version)`)에서 이미 쓰는 변수다.

- [ ] **Step 9: check-bundle 단언** — `desktop/scripts/check-bundle.mjs`에서 `check("SPA is inside the api tree", …)` 다음 줄에:

```js
// Phase 6b-2 스펙 §4 — 판올림 판정의 빌드 식별자. 없으면 packaged 앱이 기동을 거부한다(buildInfoMissing).
const buildInfoPath = path.join(resources, "build-info.json");
let buildInfo = null;
try {
  buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
} catch {
  buildInfo = null;
}
check(
  "Resources/build-info.json carries this version and a 12-char commit",
  buildInfo !== null && buildInfo.version === pkg.version && /^[0-9a-f]{12}(-dirty)?$/.test(String(buildInfo.commit)),
  JSON.stringify(buildInfo),
);
```

`resources`·`pkg` 변수 이름은 파일에서 실제 이름을 확인해 맞춘다(`grep -n "const resources\|const pkg" desktop/scripts/check-bundle.mjs`). 없으면 같은 방식으로 `path.join(appPath, "Contents", "Resources")`를 만든다.

- [ ] **Step 10: 스크립트 테스트가 있으면 돌린다** — `ls desktop/tests/scripts/`; check-bundle·package를 다루는 테스트가 있으면 `pnpm --filter damwha-desktop exec vitest run tests/scripts` → PASS. 이어서 `pnpm --filter damwha-desktop exec tsc --noEmit -p tsconfig.json` → 오류 없음.

- [ ] **Step 11: 커밋**

```bash
git add desktop/src/services/postgres/layout.ts desktop/src/services/postgres/generation.ts desktop/scripts/package.mjs desktop/scripts/check-bundle.mjs desktop/tests/services/postgres/layout.test.ts desktop/tests/services/postgres/generation.test.ts
git commit -m "feat(desktop): 빌드 식별자와 data/ 세대 기록을 더한다

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 2: clone 도구와 스냅샷

**Files:**
- Create: `desktop/src/process/clone.ts`
- Modify: `desktop/src/services/postgres/pairing.ts` (`parseControldataState` 추가)
- Create: `desktop/src/services/postgres/snapshot.ts`
- Test: `desktop/tests/process/clone.test.ts`, `desktop/tests/services/postgres/snapshot.test.ts`, `desktop/tests/services/postgres/pairing.test.ts`

**Interfaces:**
- Consumes: `PgLayout` 새 필드(Task 1), `parseControldataClusterId`·`parseMarker`(`pairing.ts`), `runTool`/`toolOk`/`describeToolFailure`(`process/tool-runner.ts`)
- Produces:
  - `type CloneFn = (src: string, dst: string, signal?: AbortSignal) => Promise<void>`; `makeClone(run: (bin: string, args: readonly string[], opts: ToolOptions) => Promise<ToolResult>): CloneFn`; `CP_BIN = "/bin/cp"`
  - `parseControldataState(stdout: string): string | null`
  - `interface SnapshotManifest { id: string; createdAt: string; fromBuild: string | null; toBuild: string; fromRecord: string | null; pgVersion: string; clusterId: string; databaseOid: number | null; clusterState: string; complete: true }`
  - `interface SnapshotInfo { id: string; dir: string; manifest: SnapshotManifest }`
  - `KEEP_SNAPSHOTS = 2`, `parseManifest(text): SnapshotManifest | null`, `assertDataTree(dir: string): void`
  - `listCompleteSnapshots(snapshotsDir: string): SnapshotInfo[]` (최신 먼저)
  - `restorableSnapshots(snapshotsDir: string, pgMajor: string): SnapshotInfo[]` (최대 2)
  - `findUnrecorded(snapshotsDir: string, toBuild: string, fromRecord: string | null): SnapshotInfo | null`
  - `interface TakeSnapshotDeps { layout: PgLayout; clone: CloneFn; readControldata(pgdata: string, signal: AbortSignal): Promise<string>; now(): Date; log(line: string): void }`
  - `takeSnapshot(d: TakeSnapshotDeps, input: { fromBuild: string | null; toBuild: string; fromRecord: string | null }, signal: AbortSignal): Promise<SnapshotInfo>`
  - `removeIncompleteSnapshots(snapshotsDir: string, log: (l: string) => void): void`
  - `pruneSnapshots(snapshotsDir: string, protect: ReadonlySet<string>, log: (l: string) => void): void`

- [ ] **Step 1: clone 테스트(실제 `/bin/cp`)** — `desktop/tests/process/clone.test.ts`:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeClone } from "../../src/process/clone";
import { runTool } from "../../src/process/tool-runner";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-clone-"));
  fs.mkdirSync(path.join(root, "src", "postgres"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "src", "postgres", "PG_VERSION"), "16\n", { mode: 0o600 });
  fs.mkdirSync(path.join(root, "src", "storage"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const clone = makeClone(runTool);

describe("makeClone (real /bin/cp -c -R)", () => {
  it("copies the tree to a new destination with the tree directly under it and modes kept", async () => {
    const dst = path.join(root, "dst");
    await clone(path.join(root, "src"), dst);
    expect(fs.readFileSync(path.join(dst, "postgres", "PG_VERSION"), "utf8")).toBe("16\n");
    expect(fs.existsSync(path.join(dst, "storage"))).toBe(true);
    expect(fs.existsSync(path.join(dst, "src"))).toBe(false);
    expect(fs.statSync(path.join(dst, "postgres")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dst, "postgres", "PG_VERSION")).mode & 0o777).toBe(0o600);
  });
  it("refuses an existing destination instead of nesting into it", async () => {
    const dst = path.join(root, "dst");
    fs.mkdirSync(dst);
    await expect(clone(path.join(root, "src"), dst)).rejects.toThrow(/이미 있어요/);
    expect(fs.readdirSync(dst)).toEqual([]);
  });
  it("refuses a dangling symlink at the destination", async () => {
    const dst = path.join(root, "dst");
    fs.symlinkSync(path.join(root, "nowhere"), dst);
    await expect(clone(path.join(root, "src"), dst)).rejects.toThrow(/이미 있어요/);
  });
  it("fails when the source is missing", async () => {
    await expect(clone(path.join(root, "missing"), path.join(root, "dst"))).rejects.toThrow(/cp -c -R/);
  });
});
```

- [ ] **Step 2: 실패 확인** — `pnpm --filter damwha-desktop exec vitest run tests/process/clone.test.ts` → FAIL.

- [ ] **Step 3: clone 구현** — `desktop/src/process/clone.ts`:

```ts
import * as fs from "fs";
import { describeToolFailure, toolOk, type ToolOptions, type ToolResult } from "./tool-runner";

/**
 * APFS clone (Phase 6b-2 스펙 §3 P4). Node 22의 `fs.cp`는 macOS에서 clone하지 않는다 — `COPYFILE_FICLONE`은 조용히
 * 전체 복사, `COPYFILE_FICLONE_FORCE`는 `ENOSYS`(2026-09-24 실측). `/bin/cp -c`만 clone한다. APFS가 아닌 볼륨에서는
 * `cp -c`가 rc=0으로 일반 복사로 넘어간다 — 실패가 아니라 느리고 공간을 쓰는 복사일 뿐이다.
 *
 * `cp -R src dst`는 dst가 **이미 있으면 그 안에** src를 넣는다(`dst/src`). 그래서 목적지는 반드시 없어야 한다.
 */
export const CP_BIN = "/bin/cp";

export type CloneFn = (src: string, dst: string, signal?: AbortSignal) => Promise<void>;

function occupied(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function makeClone(run: (bin: string, args: readonly string[], opts: ToolOptions) => Promise<ToolResult>): CloneFn {
  return async (src, dst, signal) => {
    if (occupied(dst)) throw new Error(`복사할 자리가 이미 있어요: ${dst}`);
    // deadline이 없다 — 데이터 크기에 비례한다(APFS면 1초 미만). 종료는 main이 이 작업을 기다린다(스펙 §5.2).
    const r = await run(CP_BIN, ["-c", "-R", src, dst], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, signal });
    if (!toolOk(r)) throw new Error(describeToolFailure("cp -c -R", r));
  };
}
```

- [ ] **Step 4: 통과 확인** — Step 2 명령 → PASS.

- [ ] **Step 5: `parseControldataState` 테스트** — `desktop/tests/services/postgres/pairing.test.ts`에:

```ts
import { parseControldataState } from "../../../src/services/postgres/pairing";

describe("parseControldataState", () => {
  it("reads the cluster state line", () => {
    const out = "Database system identifier:           7687238228739395787\nDatabase cluster state:               shut down\n";
    expect(parseControldataState(out)).toBe("shut down");
    expect(parseControldataState("Database cluster state:               in production\n")).toBe("in production");
  });
  it("returns null without the line", () => expect(parseControldataState("nothing")).toBeNull());
});
```

(import는 파일 머리의 기존 `pairing` import에 합친다.)

- [ ] **Step 6: 구현** — `pairing.ts`의 `parseControldataClusterId` 아래:

```ts
/** `LC_ALL=C pg_controldata`의 `Database cluster state:` 줄 (Phase 6b-2 스펙 §5.2-8). */
export function parseControldataState(stdout: string): string | null {
  const m = /^Database cluster state:\s+(.+?)\s*$/m.exec(stdout);
  return m === null ? null : m[1];
}
```

- [ ] **Step 7: 스냅샷 테스트** — `desktop/tests/services/postgres/snapshot.test.ts`. clone은 실제 `makeClone(runTool)`을 쓰고, `readControldata`만 가짜다:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeClone, type CloneFn } from "../../../src/process/clone";
import { runTool } from "../../../src/process/tool-runner";
import { pgLayout, type PgLayout } from "../../../src/services/postgres/layout";
import { serializeMarker } from "../../../src/services/postgres/pairing";
import {
  findUnrecorded,
  KEEP_SNAPSHOTS,
  listCompleteSnapshots,
  parseManifest,
  pruneSnapshots,
  removeIncompleteSnapshots,
  restorableSnapshots,
  takeSnapshot,
  type SnapshotManifest,
  type TakeSnapshotDeps,
} from "../../../src/services/postgres/snapshot";

let root: string;
let layout: PgLayout;
const CONTROL = "Database system identifier:           7687238228739395787\nDatabase cluster state:               shut down\n";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-snap-"));
  layout = pgLayout(path.join(root, "ud"));
  fs.mkdirSync(layout.pgdata, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(layout.pgdata, "PG_VERSION"), "16\n");
  fs.mkdirSync(layout.storage, { recursive: true });
  fs.writeFileSync(layout.marker, serializeMarker({ clusterId: "7687238228739395787", databaseOid: 16384 }));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function deps(over: Partial<TakeSnapshotDeps> = {}, at = "2026-09-24T08:49:33.000Z"): TakeSnapshotDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    layout,
    clone: makeClone(runTool),
    readControldata: async () => CONTROL,
    now: () => new Date(at),
    log: (l) => void lines.push(l),
    lines,
    ...over,
  };
}
const INPUT = { fromBuild: null, toBuild: "0.4.0+0123456789ab", fromRecord: null };
const signal = new AbortController().signal;

function fakeSnapshot(id: string, m: Partial<SnapshotManifest> = {}, withData = true): void {
  const dir = path.join(layout.snapshots, id);
  fs.mkdirSync(path.join(dir, "data", "postgres"), { recursive: true });
  if (withData) {
    fs.writeFileSync(path.join(dir, "data", "postgres", "PG_VERSION"), "16\n");
    fs.mkdirSync(path.join(dir, "data", "storage"), { recursive: true });
    fs.writeFileSync(path.join(dir, "data", "storage", ".damwha-cluster"), serializeMarker({ clusterId: "7687238228739395787", databaseOid: 16384 }));
  }
  const manifest: SnapshotManifest = {
    id, createdAt: "2026-09-24T00:00:00.000Z", fromBuild: null, toBuild: "0.4.0+0123456789ab", fromRecord: null,
    pgVersion: "16", clusterId: "7687238228739395787", databaseOid: 16384, clusterState: "shut down", complete: true, ...m,
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
}

describe("takeSnapshot", () => {
  it("clones data/ under <id>/data, writes a complete manifest read from the copy, and leaves no .partial", async () => {
    const info = await takeSnapshot(deps(), INPUT, signal);
    expect(info.id).toBe("20260924T084933Z");
    expect(fs.readFileSync(path.join(info.dir, "data", "postgres", "PG_VERSION"), "utf8")).toBe("16\n");
    expect(info.manifest).toMatchObject({ toBuild: "0.4.0+0123456789ab", fromBuild: null, fromRecord: null, clusterId: "7687238228739395787", databaseOid: 16384, clusterState: "shut down", pgVersion: "16", complete: true });
    expect(fs.readdirSync(layout.snapshots)).toEqual(["20260924T084933Z"]);
  });
  it("reads pg_controldata from the copy, not the live cluster", async () => {
    const seen: string[] = [];
    await takeSnapshot(deps({ readControldata: async (p) => (seen.push(p), CONTROL) }), INPUT, signal);
    expect(seen).toEqual([path.join(layout.snapshots, "20260924T084933Z.partial", "data", "postgres")]);
  });
  it("records a null databaseOid from the copy's marker", async () => {
    fs.writeFileSync(layout.marker, serializeMarker({ clusterId: "7687238228739395787", databaseOid: null }));
    expect((await takeSnapshot(deps(), INPUT, signal)).manifest.databaseOid).toBeNull();
  });
  it("suffixes a second snapshot in the same second", async () => {
    await takeSnapshot(deps(), INPUT, signal);
    expect((await takeSnapshot(deps(), INPUT, signal)).id).toBe("20260924T084933Z-2");
  });
  it("removes its .partial when the clone fails and rethrows", async () => {
    const boom: CloneFn = async () => { throw new Error("ENOSPC"); };
    await expect(takeSnapshot(deps({ clone: boom }), INPUT, signal)).rejects.toThrow(/ENOSPC/);
    expect(fs.readdirSync(layout.snapshots)).toEqual([]);
  });
  it("removes its .partial when controldata has no identifier", async () => {
    await expect(takeSnapshot(deps({ readControldata: async () => "garbage" }), INPUT, signal)).rejects.toThrow();
    expect(fs.readdirSync(layout.snapshots)).toEqual([]);
  });
});

describe("listing, reuse and retention", () => {
  it("lists only complete snapshots, newest first", () => {
    fakeSnapshot("20260920T000000Z");
    fakeSnapshot("20260922T000000Z");
    fs.mkdirSync(path.join(layout.snapshots, "20260923T000000Z.partial"));
    fs.mkdirSync(path.join(layout.snapshots, "20260921T000000Z"));
    expect(listCompleteSnapshots(layout.snapshots).map((s) => s.id)).toEqual(["20260922T000000Z", "20260920T000000Z"]);
  });
  it("restorable: same PG major and a readable marker, at most KEEP_SNAPSHOTS", () => {
    fakeSnapshot("20260920T000000Z");
    fakeSnapshot("20260921T000000Z", { pgVersion: "17" });
    fakeSnapshot("20260922T000000Z");
    fakeSnapshot("20260923T000000Z");
    fakeSnapshot("20260924T000000Z", {}, false);
    expect(restorableSnapshots(layout.snapshots, "16").map((s) => s.id)).toEqual(["20260923T000000Z", "20260922T000000Z"]);
    expect(KEEP_SNAPSHOTS).toBe(2);
  });
  it("findUnrecorded matches toBuild AND fromRecord", () => {
    fakeSnapshot("20260924T000000Z", { toBuild: "0.4.0+0123456789ab", fromRecord: null });
    expect(findUnrecorded(layout.snapshots, "0.4.0+0123456789ab", null)?.id).toBe("20260924T000000Z");
  });
  it("findUnrecorded ignores a snapshot whose fromRecord differs (restored data)", () => {
    fakeSnapshot("20260924T000000Z", { toBuild: "0.4.0+0123456789ab", fromRecord: null });
    expect(findUnrecorded(layout.snapshots, "0.4.0+0123456789ab", '{"build":null,"snapshot":null,"restoredFrom":"R"}')).toBeNull();
    expect(findUnrecorded(layout.snapshots, "0.4.1+ba9876543210", null)).toBeNull();
  });
  it("removeIncompleteSnapshots deletes .partial and manifest-less dirs only", () => {
    fakeSnapshot("20260920T000000Z");
    fs.mkdirSync(path.join(layout.snapshots, "20260921T000000Z.partial"));
    fs.mkdirSync(path.join(layout.snapshots, "20260922T000000Z"));
    fs.mkdirSync(path.join(layout.snapshots, "keep-me"));
    const log: string[] = [];
    removeIncompleteSnapshots(layout.snapshots, (l) => void log.push(l));
    expect(fs.readdirSync(layout.snapshots).sort()).toEqual(["20260920T000000Z", "keep-me"]);
    expect(log).toHaveLength(2);
  });
  it("prune keeps the newest KEEP_SNAPSHOTS and never a protected one", () => {
    for (const id of ["20260920T000000Z", "20260921T000000Z", "20260922T000000Z", "20260923T000000Z"]) fakeSnapshot(id);
    pruneSnapshots(layout.snapshots, new Set(["20260920T000000Z"]), () => undefined);
    expect(fs.readdirSync(layout.snapshots).sort()).toEqual(["20260920T000000Z", "20260922T000000Z", "20260923T000000Z"]);
  });
  it("prune does not follow a symlinked snapshot", () => {
    for (const id of ["20260921T000000Z", "20260922T000000Z"]) fakeSnapshot(id);
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "manifest.json"), fs.readFileSync(path.join(layout.snapshots, "20260921T000000Z", "manifest.json")));
    fs.symlinkSync(outside, path.join(layout.snapshots, "20260920T000000Z"));
    pruneSnapshots(layout.snapshots, new Set(), () => undefined);
    expect(fs.existsSync(path.join(outside, "manifest.json"))).toBe(true);
  });
  it("parseManifest rejects complete:false and wrong types", () => {
    expect(parseManifest('{"complete":false}')).toBeNull();
    expect(parseManifest("nope")).toBeNull();
  });
});
```

- [ ] **Step 8: 실패 확인** — `pnpm --filter damwha-desktop exec vitest run tests/services/postgres/snapshot.test.ts tests/services/postgres/pairing.test.ts` → snapshot FAIL.

- [ ] **Step 9: 스냅샷 구현** — `desktop/src/services/postgres/snapshot.ts`:

```ts
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
```

- [ ] **Step 10: 통과 확인** — Step 8 명령 → PASS.

- [ ] **Step 11: 커밋**

```bash
git add desktop/src/process/clone.ts desktop/src/services/postgres/pairing.ts desktop/src/services/postgres/snapshot.ts desktop/tests/process/clone.test.ts desktop/tests/services/postgres/snapshot.test.ts desktop/tests/services/postgres/pairing.test.ts
git commit -m "feat(desktop): APFS clone 도구와 판올림 스냅샷을 더한다

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 3: 락 처리를 `lock.ts`로 꺼낸다 (동작 불변)

**Files:**
- Create: `desktop/src/services/postgres/lock.ts`
- Modify: `desktop/src/services/postgres/service.ts:144-173` (`handleLock` 본문 제거, 호출 교체)
- Test: `desktop/tests/services/postgres/lock.test.ts`; 기존 `service.test.ts`는 수정 없이 통과해야 한다

**Interfaces:**
- Consumes: `classifyLockOwner`·`parsePostmasterPid`·`ProcessInfo`(`pidfile.ts`), `PostmasterStopResult`(`handle.ts`), `CAUSES.pgLockUnprovable`·`CAUSES.pgOrphanStuck`
- Produces: `interface LockDeps { layout: PgLayout; psInfo(pid: number): Promise<ProcessInfo | null>; stopOrphan(pid: number): Promise<PostmasterStopResult>; log(line: string): void }`, `clearPostmasterLock(d: LockDeps): Promise<void>` — 거부는 `ServiceFailure(…, "manual")`

- [ ] **Step 1: 테스트 작성** — `desktop/tests/services/postgres/lock.test.ts`. `service.test.ts`의 락 테스트(`grep -n "orphan\|stale\|lock" tests/services/postgres/service.test.ts`)를 참고해 네 경우를 `clearPostmasterLock`에 직접 건다:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceFailure } from "../../../src/services/failure";
import { pgLayout, type PgLayout } from "../../../src/services/postgres/layout";
import { clearPostmasterLock, type LockDeps } from "../../../src/services/postgres/lock";

let root: string;
let layout: PgLayout;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-lock-"));
  layout = pgLayout(path.join(root, "ud"));
  fs.mkdirSync(layout.pgdata, { recursive: true });
  fs.mkdirSync(layout.runDir, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const pidfile = (pid: number) =>
  fs.writeFileSync(path.join(layout.pgdata, "postmaster.pid"), [String(pid), layout.pgdata, "0", "5432", layout.runDir, "", "", "ready   ", ""].join("\n"));
const ours = (): LockDeps["psInfo"] => async () => ({ comm: "/B/postgres/bin/postgres", args: `/B/postgres/bin/postgres -D ${layout.pgdata}` });

function deps(over: Partial<LockDeps> = {}): LockDeps & { lines: string[]; stopped: number[] } {
  const lines: string[] = [];
  const stopped: number[] = [];
  return { layout, psInfo: async () => null, stopOrphan: async (pid) => (stopped.push(pid), "fast"), log: (l) => void lines.push(l), lines, stopped, ...over };
}

describe("clearPostmasterLock", () => {
  it("does nothing without a pid file", async () => {
    const d = deps();
    await clearPostmasterLock(d);
    expect(d.stopped).toEqual([]);
  });
  it("stops our orphan postmaster", async () => {
    pidfile(4242);
    const d = deps({ psInfo: ours() });
    await clearPostmasterLock(d);
    expect(d.stopped).toEqual([4242]);
  });
  it("refuses when the orphan leaks", async () => {
    pidfile(4242);
    await expect(clearPostmasterLock(deps({ psInfo: ours(), stopOrphan: async () => "leaked" }))).rejects.toBeInstanceOf(ServiceFailure);
  });
  it("removes a stale lock whose pid was reused", async () => {
    pidfile(4242);
    fs.writeFileSync(`${layout.socketFile}.lock`, "x");
    await clearPostmasterLock(deps({ psInfo: async () => ({ comm: "/usr/bin/vim", args: "vim" }) }));
    expect(fs.existsSync(path.join(layout.pgdata, "postmaster.pid"))).toBe(false);
    expect(fs.existsSync(`${layout.socketFile}.lock`)).toBe(false);
  });
  it("refuses and deletes nothing when ps fails", async () => {
    pidfile(4242);
    await expect(clearPostmasterLock(deps({ psInfo: async () => { throw new Error("ps timed out"); } }))).rejects.toBeInstanceOf(ServiceFailure);
    expect(fs.existsSync(path.join(layout.pgdata, "postmaster.pid"))).toBe(true);
  });
});
```

`stopOrphan`의 반환 타입 `PostmasterStopResult`의 실제 값("fast"/"immediate"/"leaked" 등)은 `grep -n "PostmasterStopResult" -A3 desktop/src/services/postgres/handle.ts`로 확인해 가짜 값을 맞춘다. `classifyLockOwner`가 "ours"로 보는 `args` 형식도 `pidfile.ts:42`에서 확인해 `ours()`를 맞춘다.

- [ ] **Step 2: 실패 확인** — `pnpm --filter damwha-desktop exec vitest run tests/services/postgres/lock.test.ts` → FAIL.

- [ ] **Step 3: 구현** — `desktop/src/services/postgres/lock.ts`에 `service.ts`의 `handleLock()` 본문을 **그대로 옮긴다**(로그 문구·주석 포함). `refuse`·`readIfExists`·`reasonOf`는 같은 모양의 지역 함수로 둔다:

```ts
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
```

`service.ts`에서 `async function handleLock()` 전체를 지우고, 호출(`await handleLock();`)을 `await clearPostmasterLock(deps);`로 바꾼다. `EmbeddedPostgresDeps`는 `layout`·`psInfo`·`stopOrphan`·`log`를 이미 가지므로 그대로 넘긴다. 쓰지 않게 된 import(`classifyLockOwner`·`parsePostmasterPid`가 readiness에서 계속 쓰이는지 확인)만 정리한다 — `parsePostmasterPid`는 readiness가 계속 쓴다.

- [ ] **Step 4: 통과 확인** — `pnpm --filter damwha-desktop exec vitest run tests/services/postgres/lock.test.ts tests/services/postgres/service.test.ts` → 둘 다 PASS(`service.test.ts`는 수정 없이).

- [ ] **Step 5: 커밋**

```bash
git add desktop/src/services/postgres/lock.ts desktop/src/services/postgres/service.ts desktop/tests/services/postgres/lock.test.ts
git commit -m "refactor(desktop): postmaster 락 처리를 lock.ts로 꺼낸다

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 4: 되돌리기 저널과 교체 step 기계

**Files:**
- Create: `desktop/src/services/postgres/restore-journal.ts`
- Test: `desktop/tests/services/postgres/restore-journal.test.ts`

**Interfaces:**
- Consumes: `CloneFn`(Task 2), `SnapshotInfo`·`SnapshotManifest`·`assertDataTree`(Task 2), `readGeneration`·`writeGenerationAtomic`(Task 1), `PgLayout`(Task 1)
- Produces:
  - `type JournalStep = "requested" | "staged" | "moved-aside" | "hold"`
  - `interface RestoreJournal { id: string; snapshot: string; step: JournalStep; requestedAt: string; completedAt: string | null }`
  - `parseJournal(text): RestoreJournal | null`; `type JournalRead = { kind: "none" } | { kind: "ok"; journal: RestoreJournal } | { kind: "unreadable"; why: string }`; `readJournal(file): JournalRead`; `writeJournalAtomic(file, j): void`; `removeJournal(file): void`
  - `replacedDirOf(layout, rid): string`, `stagingDirOf(layout, rid): string`, `chooseRestoreId(layout, now: Date): string`
  - `interface AdvanceDeps { layout: PgLayout; clone: CloneFn; findSnapshot(id: string): SnapshotInfo | null; verifyIdentity(dir: string, m: SnapshotManifest, signal: AbortSignal): Promise<boolean>; now(): Date; log(line: string): void; pauseAfterStep?(step: JournalStep): Promise<void> }`
  - `type AdvanceOutcome = { kind: "hold"; journal: RestoreJournal; snapshot: SnapshotInfo | null; replacedDir: string } | { kind: "aborted"; reason: string }`
  - `advanceJournal(d: AdvanceDeps, j: RestoreJournal, signal: AbortSignal): Promise<AdvanceOutcome>` — "그 밖의 조합"·rename 실패·신원 불일치(requested 이후)는 `ServiceFailure(CAUSES.restoreIncomplete.text(...), "manual")`

`CAUSES.restoreIncomplete`는 Task 5에서 생긴다. **이 Task에서는** `restore-journal.ts` 안에 `export class RestoreIncomplete extends Error {}`를 던지고, Task 5의 데이터 가드가 그것을 `ServiceFailure(CAUSES.restoreIncomplete.text(err.message), "manual")`로 감싼다(순환 import와 순서 의존을 피한다).

- [ ] **Step 1: 테스트 작성** — `desktop/tests/services/postgres/restore-journal.test.ts`. 실제 임시 디렉터리 + 실제 `makeClone(runTool)`. `verifyIdentity`는 `assertDataTree` + 마커 비교로 가짜를 만든다:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeClone } from "../../../src/process/clone";
import { runTool } from "../../../src/process/tool-runner";
import { readGeneration, writeGenerationAtomic } from "../../../src/services/postgres/generation";
import { pgLayout, type PgLayout } from "../../../src/services/postgres/layout";
import { parseMarker, serializeMarker } from "../../../src/services/postgres/pairing";
import {
  advanceJournal,
  chooseRestoreId,
  parseJournal,
  readJournal,
  replacedDirOf,
  RestoreIncomplete,
  stagingDirOf,
  writeJournalAtomic,
  type AdvanceDeps,
  type JournalStep,
  type RestoreJournal,
} from "../../../src/services/postgres/restore-journal";
import type { SnapshotInfo } from "../../../src/services/postgres/snapshot";

let root: string;
let layout: PgLayout;
let snap: SnapshotInfo;
const RID = "20260925T010203Z";
const signal = new AbortController().signal;

function makeData(dir: string, tag: string, clusterId = "111"): void {
  fs.mkdirSync(path.join(dir, "postgres"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "postgres", "PG_VERSION"), "16\n");
  fs.writeFileSync(path.join(dir, "postgres", "TAG"), tag);
  fs.mkdirSync(path.join(dir, "storage"), { recursive: true });
  fs.writeFileSync(path.join(dir, "storage", ".damwha-cluster"), serializeMarker({ clusterId, databaseOid: 16384 }));
}
const tagOf = (dir: string) => fs.readFileSync(path.join(dir, "postgres", "TAG"), "utf8");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-journal-"));
  layout = pgLayout(path.join(root, "ud"));
  makeData(layout.dataDir, "current");
  const sdir = path.join(layout.snapshots, "20260924T084933Z");
  makeData(path.join(sdir, "data"), "snapshot");
  snap = {
    id: "20260924T084933Z",
    dir: sdir,
    manifest: { id: "20260924T084933Z", createdAt: "x", fromBuild: null, toBuild: "0.4.0+0123456789ab", fromRecord: null, pgVersion: "16", clusterId: "111", databaseOid: 16384, clusterState: "shut down", complete: true },
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function deps(over: Partial<AdvanceDeps> = {}): AdvanceDeps & { paused: JournalStep[] } {
  const paused: JournalStep[] = [];
  return {
    layout,
    clone: makeClone(runTool),
    findSnapshot: (id) => (id === snap.id ? snap : null),
    verifyIdentity: async (dir, m) => {
      const marker = parseMarker(fs.readFileSync(path.join(dir, "storage", ".damwha-cluster"), "utf8"));
      return marker !== null && marker.clusterId === m.clusterId && marker.databaseOid === m.databaseOid;
    },
    now: () => new Date("2026-09-25T01:05:00.000Z"),
    log: () => undefined,
    pauseAfterStep: async (s) => void paused.push(s),
    paused,
    ...over,
  };
}
const journal = (step: JournalStep): RestoreJournal => ({ id: RID, snapshot: snap.id, step, requestedAt: "2026-09-25T01:02:03.000Z", completedAt: null });
const R = () => replacedDirOf(layout, RID);
const S = () => stagingDirOf(layout, RID);

describe("advanceJournal — happy path", () => {
  it("requested → hold swaps data/ for a clone of the snapshot and keeps the old data aside", async () => {
    writeJournalAtomic(layout.restoreJournal, journal("requested"));
    const d = deps();
    const out = await advanceJournal(d, journal("requested"), signal);
    expect(out.kind).toBe("hold");
    expect(tagOf(layout.dataDir)).toBe("snapshot");
    expect(tagOf(R())).toBe("current");
    expect(fs.existsSync(S())).toBe(false);
    expect(tagOf(path.join(snap.dir, "data"))).toBe("snapshot");
    expect(d.paused).toEqual(["staged", "moved-aside", "hold"]);
    const saved = readJournal(layout.restoreJournal);
    expect(saved.kind === "ok" && saved.journal.step).toBe("hold");
    expect(saved.kind === "ok" && saved.journal.completedAt).toBe("2026-09-25T01:05:00.000Z");
  });
  it("marks the restored data's generation record with restoredFrom, keeping build and snapshot", async () => {
    writeGenerationAtomic(path.join(snap.dir, "data", ".damwha-generation"), { build: "0.3.9+aaaaaaaaaaaa", snapshot: "OLD" });
    await advanceJournal(deps(), journal("requested"), signal);
    expect(readGeneration(layout.generationFile)).toEqual({ build: "0.3.9+aaaaaaaaaaaa", snapshot: "OLD", restoredFrom: RID });
  });
  it("writes restoredFrom with null build/snapshot when the snapshot had no record", async () => {
    await advanceJournal(deps(), journal("requested"), signal);
    expect(readGeneration(layout.generationFile)).toEqual({ build: null, snapshot: null, restoredFrom: RID });
  });
});

describe("advanceJournal — resume after a crash at every point", () => {
  it("staged with data/ already moved aside (crash after rename, before step write)", async () => {
    await advanceJournal(deps(), journal("requested"), signal).catch(() => undefined);
    // 다시 처음부터 만든다: requested까지 해 두고 D→R만 손으로 한 상태
    fs.rmSync(layout.dataDir, { recursive: true, force: true });
    fs.rmSync(R(), { recursive: true, force: true });
    makeData(layout.dataDir, "current");
    await makeClone(runTool)(path.join(snap.dir, "data"), S());
    fs.renameSync(layout.dataDir, R());
    const out = await advanceJournal(deps(), journal("staged"), signal);
    expect(out.kind).toBe("hold");
    expect(tagOf(layout.dataDir)).toBe("snapshot");
    expect(tagOf(R())).toBe("current");
  });
  it("moved-aside with staging already renamed into data/ (crash after rename, before step write)", async () => {
    fs.renameSync(layout.dataDir, R());
    await makeClone(runTool)(path.join(snap.dir, "data"), layout.dataDir);
    const out = await advanceJournal(deps(), journal("moved-aside"), signal);
    expect(out.kind).toBe("hold");
    expect(readGeneration(layout.generationFile)?.restoredFrom).toBe(RID);
  });
  it("requested with a stale staging dir from an interrupted clone re-clones it", async () => {
    fs.mkdirSync(S(), { recursive: true });
    fs.writeFileSync(path.join(S(), "junk"), "half");
    const out = await advanceJournal(deps(), journal("requested"), signal);
    expect(out.kind).toBe("hold");
    expect(fs.existsSync(path.join(layout.dataDir, "junk"))).toBe(false);
  });
  it("hold is idempotent and moves nothing", async () => {
    await advanceJournal(deps(), journal("requested"), signal);
    const before = tagOf(layout.dataDir);
    const out = await advanceJournal(deps(), { ...journal("hold"), completedAt: "t" }, signal);
    expect(out.kind).toBe("hold");
    expect(tagOf(layout.dataDir)).toBe(before);
  });
});

describe("advanceJournal — refusals move nothing", () => {
  it.each<[string, JournalStep, () => void]>([
    ["requested with R present", "requested", () => makeData(R(), "stray")],
    ["staged without staging", "staged", () => undefined],
    ["staged with both D and R", "staged", () => { makeData(R(), "stray"); makeData(S(), "snapshot"); }],
    ["moved-aside with neither D nor S", "moved-aside", () => { fs.renameSync(layout.dataDir, R()); }],
    ["moved-aside with D, R and S all present", "moved-aside", () => { makeData(R(), "stray"); makeData(S(), "snapshot"); }],
  ])("%s", async (_n, step, arrange) => {
    arrange();
    const snapshotOf = (p: string) => (fs.existsSync(p) ? tagOf(p) : null);
    const before = [snapshotOf(layout.dataDir), snapshotOf(R()), snapshotOf(S())];
    await expect(advanceJournal(deps(), journal(step), signal)).rejects.toBeInstanceOf(RestoreIncomplete);
    expect([snapshotOf(layout.dataDir), snapshotOf(R()), snapshotOf(S())]).toEqual(before);
  });
  it("moved-aside where data/ is not the snapshot (identity mismatch) refuses", async () => {
    fs.renameSync(layout.dataDir, R());
    makeData(layout.dataDir, "someone-else", "999");
    await expect(advanceJournal(deps(), journal("moved-aside"), signal)).rejects.toBeInstanceOf(RestoreIncomplete);
  });
});

describe("advanceJournal — requested failures abort before touching data/", () => {
  it("snapshot missing → aborted, journal removed, data/ untouched", async () => {
    writeJournalAtomic(layout.restoreJournal, journal("requested"));
    const out = await advanceJournal(deps({ findSnapshot: () => null }), journal("requested"), signal);
    expect(out.kind).toBe("aborted");
    expect(tagOf(layout.dataDir)).toBe("current");
    expect(readJournal(layout.restoreJournal).kind).toBe("none");
  });
  it("clone failure → aborted, staging removed", async () => {
    writeJournalAtomic(layout.restoreJournal, journal("requested"));
    const out = await advanceJournal(deps({ clone: async (_s, dst) => { fs.mkdirSync(dst); throw new Error("ENOSPC"); } }), journal("requested"), signal);
    expect(out).toEqual({ kind: "aborted", reason: expect.stringMatching(/ENOSPC/) });
    expect(fs.existsSync(S())).toBe(false);
    expect(tagOf(layout.dataDir)).toBe("current");
  });
  it("staging identity mismatch → aborted", async () => {
    const out = await advanceJournal(deps({ verifyIdentity: async () => false }), journal("requested"), signal);
    expect(out.kind).toBe("aborted");
    expect(tagOf(layout.dataDir)).toBe("current");
  });
});

describe("journal file and ids", () => {
  it("parses a valid journal and rejects garbage", () => {
    expect(parseJournal(JSON.stringify(journal("staged")))).toEqual(journal("staged"));
    expect(parseJournal('{"id":"x","snapshot":"y","step":"weird","requestedAt":"t","completedAt":null}')).toBeNull();
    expect(parseJournal("nope")).toBeNull();
  });
  it("readJournal distinguishes none from unreadable", () => {
    expect(readJournal(layout.restoreJournal).kind).toBe("none");
    fs.writeFileSync(layout.restoreJournal, "{");
    expect(readJournal(layout.restoreJournal).kind).toBe("unreadable");
  });
  it("chooseRestoreId skips ids whose replaced or staging dir exists", () => {
    const now = new Date("2026-09-25T01:02:03.000Z");
    makeData(replacedDirOf(layout, RID), "x");
    fs.mkdirSync(stagingDirOf(layout, `${RID}-2`), { recursive: true });
    expect(chooseRestoreId(layout, now)).toBe(`${RID}-3`);
  });
});
```

- [ ] **Step 2: 실패 확인** — `pnpm --filter damwha-desktop exec vitest run tests/services/postgres/restore-journal.test.ts` → FAIL.

- [ ] **Step 3: 구현** — `desktop/src/services/postgres/restore-journal.ts`:

```ts
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
```

주의: `case "hold"`에서 `advance("hold")`는 `pauseAfterStep("hold")`를 다시 부른다. happy path 테스트의 기대 `["staged","moved-aside","hold"]`가 맞도록, moved-aside가 `completedAt`을 채우므로 hold 분기에서는 `completedAt !== null`이라 다시 부르지 않는다.

- [ ] **Step 4: 통과 확인** — Step 2 명령 → PASS. 실패하는 테스트가 있으면 테스트가 아니라 구현을 스펙 §6.3 표에 맞춘다.

- [ ] **Step 5: 커밋**

```bash
git add desktop/src/services/postgres/restore-journal.ts desktop/tests/services/postgres/restore-journal.test.ts
git commit -m "feat(desktop): 되돌리기 저널과 교체 step 기계를 더한다

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 5: 원인 문구·데이터 가드·쓰는 주체 재스캔

**Files:**
- Modify: `desktop/src/diagnostics/causes.ts` (원인 6개), `desktop/src/windows/shell-hints.ts` (`HINTS` 6개)
- Create: `desktop/src/app/data-guard.ts`
- Modify: `desktop/src/app/reap-on-start.ts` (`reapBeforeStart`)
- Modify: `desktop/src/process/orphans.ts` (`survivingOrphans` 추가)
- Test: `desktop/tests/app/data-guard.test.ts`, `desktop/tests/app/reap-on-start.test.ts`, 기존 `desktop/tests/diagnostics/causes.test.ts`·`desktop/tests/recovery-hint.test.ts`(경로는 `grep -rln "HINTS\|causeIn" desktop/tests`로 확인)

**Interfaces:**
- Consumes: Task 1~4 전부. `decideCluster`·`readStorageFacts`·`parseControldataClusterId`(`pairing.ts`), `PG_MAJOR`(`layout.ts`), `manualUnlessTagged`·`ServiceFailure`
- Produces:
  - `CAUSES.writersAlive.text(pids: readonly number[])`, `CAUSES.buildInfoMissing.text(file: string)`, `CAUSES.snapshotFailed.text(reason: string, dir: string)`, `CAUSES.restoreJournalUnreadable.text(file: string, why: string)`, `CAUSES.restoreIncomplete.text(detail: string)`, `CAUSES.restoreAborted.text(reason: string)`
  - `survivingOrphans(d: Pick<ReapDeps, "ps" | "trees" | "runId" | "exists">): Promise<number[]>`
  - `interface DataGuardDeps { packaged: boolean; external: boolean; currentBuild: string | null; buildInfoFile: string; layout: PgLayout; readControldata(pgdata: string, signal: AbortSignal): Promise<string>; lock: LockDeps; clone: CloneFn; now(): Date; log(line: string): void; pauseAfterStep?(step: JournalStep): Promise<void> }`
  - `type GuardOutcome = { kind: "proceed"; snapshot: SnapshotInfo | null; notice: string | null } | { kind: "hold"; journal: RestoreJournal; snapshot: SnapshotInfo | null; replacedDir: string }`
  - `runDataGuard(d: DataGuardDeps, signal: AbortSignal): Promise<GuardOutcome>` — 실패는 모두 `ServiceFailure(…, "manual")`
  - `releaseHold(layout: PgLayout): void` (저널 삭제)

- [ ] **Step 1: 원인 6개** — `causes.ts`에서 `migrationsStillPending` 항목 **뒤**, `spawnNotFound` 앞에 넣는다(각 문구가 한국어 머리로 시작해 기존 원인과 겹치지 않는다):

```ts
  /** 데이터 가드 — 앞 실행의 앱 소유 Python이 회수 뒤에도 살아 있다 (Phase 6b-2 스펙 §5.2-2). 쓰는 중일 수 있어 스냅샷·교체를 하지 않는다. */
  writersAlive: {
    match: /이전 실행의 처리 프로세스가 아직 남아 있어요/,
    text: (pids: readonly number[]) => `이전 실행의 처리 프로세스가 아직 남아 있어요 (pid ${pids.join(", ")}).`,
    selfRecovers: false,
  },
  /** 데이터 가드 — packaged인데 빌드 식별자가 없다 (§4). 번들 결함이다. */
  buildInfoMissing: {
    match: /앱의 빌드 정보를 읽지 못했어요/,
    text: (file: string) => `앱의 빌드 정보를 읽지 못했어요 (${file}).`,
    selfRecovers: false,
  },
  /** 데이터 가드 — 판올림 스냅샷 실패 (§5.4). 기동하지 않는다. */
  snapshotFailed: {
    match: /업데이트 전 스냅샷을 만들지 못해 시작하지 않았어요/,
    text: (reason: string, dir: string) => `업데이트 전 스냅샷을 만들지 못해 시작하지 않았어요 (${dir}).\n${reason}`,
    selfRecovers: false,
  },
  /** 데이터 가드 — 되돌리기 저널을 읽을 수 없다 (§6.3). 아무것도 옮기지 않았다. */
  restoreJournalUnreadable: {
    match: /되돌리기 기록을 읽을 수 없어요/,
    text: (file: string, why: string) => `되돌리기 기록을 읽을 수 없어요 (${file}): ${why}`,
    selfRecovers: false,
  },
  /** 데이터 가드 — 교체를 이어 갈 수 없다 (§6.3 "그 밖의 조합"·rename 실패·신원 불일치). */
  restoreIncomplete: {
    match: /업데이트 전 데이터로 되돌리는 작업을 마치지 못했어요/,
    text: (detail: string) => `업데이트 전 데이터로 되돌리는 작업을 마치지 못했어요.\n${detail}`,
    selfRecovers: false,
  },
  /** 데이터 가드 — 되돌리기를 시작 전에 취소했다 (§6.3 requested 실패). 실패가 아니라 알림이다. */
  restoreAborted: {
    match: /되돌리기를 취소했어요/,
    text: (reason: string) => `되돌리기를 취소했어요. 지금 데이터는 그대로예요.\n${reason}`,
    selfRecovers: false,
  },
```

`shell-hints.ts`의 `HINTS`에(`migrationsStillPending` 다음):

```ts
  writersAlive: "활성 상태 보기에서 그 pid를 종료한 뒤 다시 시도해 주세요. 앱은 아무것도 복사하거나 옮기지 않았어요.",
  buildInfoMissing: "앱을 다시 설치해 주세요.",
  snapshotFailed: "디스크 여유 공간을 확인한 뒤 다시 시도해 주세요.",
  restoreJournalUnreadable: "docs/RESTORE.md의 수동 절차를 따르거나, 기록 파일을 확인한 뒤 다시 시도해 주세요. 앱은 아무것도 옮기지 않았어요.",
  restoreIncomplete: "위 세 폴더를 옮기거나 지우지 말고 다시 시도해 주세요. 계속 실패하면 docs/RESTORE.md의 수동 절차를 따르세요.",
  restoreAborted: null,
```

- [ ] **Step 2: 원인·안내 테스트** — 원인 카탈로그를 도는 테스트는 `desktop/tests/windows/recovery-hint.test.ts`다. 그 파일의 `SAMPLE_ARGS`(타입이 템플릿 원인 **전부**를 요구한다 — 빠지면 타입 오류)에 새 템플릿 원인 여섯의 예시 인자를 더한다:

```ts
  writersAlive: [[7777]],
  buildInfoMissing: ["/Applications/Damwha.app/Contents/Resources/build-info.json"],
  snapshotFailed: ["cp -c -R: 종료 코드 1\nNo space left on device", "/u/snapshots"],
  restoreJournalUnreadable: ["/u/restore-journal.json", "형식이 맞지 않아요"],
  restoreIncomplete: ["교체를 이어 갈 수 없는 상태예요 (data/ 있음, 보관본 있음, 임시 사본 있음)"],
  restoreAborted: ["되돌릴 스냅샷을 찾지 못했어요 (20260924T084933Z)"],
```

그 테스트는 모든 원인을 돌며 match 겹침·안내 매핑을 본다. 돌린다: `pnpm --filter damwha-desktop exec vitest run tests/windows tests/diagnostics` → PASS. 실패하면 문구가 기존 원인과 겹치는 것이니 문구를 고친다(테스트의 판정을 고치지 않는다). 이 파일을 Step 10 커밋에 더한다.

- [ ] **Step 3: 생존자 재스캔 테스트** — `desktop/tests/app/reap-on-start.test.ts`. 기존 `deps(ps)` 도우미(파일 14~32행)는 `ps`가 **정적**이고 `kill`이 `alive`에서 pid를 지운다. 그래서 재스캔은 `ps` 결과를 `exists`로 한 번 더 걸러야 기존 테스트 `resolves with what it reaped when the scan works`가 계속 초록이다(실제 커널에서는 `ps`가 새로 읽혀 이미 없다). 추가:

```ts
it("refuses to start when an orphan survives the reap (writersAlive)", async () => {
  const line = `  PID ARGS\n    1 /sbin/launchd\n 4001 ${ROOT}/bin/python3.12 -m damwha_worker --run-id=${OLD}`;
  const { d } = deps(async () => line);
  // SIGKILL이 닿지 않은 경우(EPERM) — 던지고, 프로세스는 남는다.
  d.kill = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
  await expect(reapBeforeStart(d)).rejects.toMatchObject({
    recovery: "manual",
    message: expect.stringMatching(/이전 실행의 처리 프로세스가 아직 남아 있어요 \(pid 4001\)/),
  });
});
```

기존 `resolves with what it reaped…` 테스트는 **수정하지 않는다** — 재스캔이 있어도 초록이어야 한다(회귀 방지).

- [ ] **Step 4: 구현** — `orphans.ts`에:

```ts
/**
 * 회수 **뒤** 다시 스캔해 아직 남은 앞 실행의 앱 소유 프로세스 (Phase 6b-2 스펙 §5.2-2). reapOrphans는 SIGKILL 뒤
 * 생존자를 로그로만 남긴다. `exists`로 한 번 더 거른다 — 방금 죽인 pid가 스캔과 신호 사이에 남아 보이는 것을 빼고,
 * 정말 살아 있는 것만 센다.
 */
export async function survivingOrphans(d: Pick<ReapDeps, "ps" | "trees" | "runId" | "exists">): Promise<number[]> {
  return parseDamwhaProcesses(await d.ps(), d.trees)
    .filter((p) => classify(p, d.runId) === "orphan" && d.exists(p.pid))
    .map((p) => p.pid);
}
```

`reap-on-start.ts`의 `reapBeforeStart`:

```ts
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
```

(스펙 §5.2-2는 이 확인을 가드 안에 두었으나, 가드는 첫 기동에서 `reapBeforeStart` 바로 뒤에 돈다 — 같은 지점이므로 회수 함수에 둔다. 재시도 경로에서는 감독자가 이미 있어 앞 실행의 고아가 새로 생기지 않는다.)

- [ ] **Step 5: 통과 확인** — `pnpm --filter damwha-desktop exec vitest run tests/app/reap-on-start.test.ts tests/process/orphans.test.ts` → PASS.

- [ ] **Step 6: 데이터 가드 테스트** — `desktop/tests/app/data-guard.test.ts`. 실제 임시 디렉터리 + 실제 clone, `readControldata`·`lock`은 가짜:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { releaseHold, runDataGuard, type DataGuardDeps } from "../../src/app/data-guard";
import { makeClone } from "../../src/process/clone";
import { runTool } from "../../src/process/tool-runner";
import { ServiceFailure } from "../../src/services/failure";
import { readGeneration, writeGenerationAtomic } from "../../src/services/postgres/generation";
import { pgLayout, type PgLayout } from "../../src/services/postgres/layout";
import { serializeMarker } from "../../src/services/postgres/pairing";
import { replacedDirOf, writeJournalAtomic } from "../../src/services/postgres/restore-journal";
import { listCompleteSnapshots, takeSnapshot } from "../../src/services/postgres/snapshot";

let root: string;
let layout: PgLayout;
const BUILD = "0.4.0+0123456789ab";
const CONTROL = "Database system identifier:           111\nDatabase cluster state:               shut down\n";
const signal = new AbortController().signal;

function makeCluster(): void {
  fs.mkdirSync(layout.pgdata, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(layout.pgdata, "PG_VERSION"), "16\n");
  fs.mkdirSync(layout.storage, { recursive: true });
  fs.writeFileSync(layout.marker, serializeMarker({ clusterId: "111", databaseOid: 16384 }));
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-guard-"));
  layout = pgLayout(path.join(root, "ud"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function deps(over: Partial<DataGuardDeps> = {}): DataGuardDeps & { events: string[] } {
  const events: string[] = [];
  return {
    packaged: true,
    external: false,
    currentBuild: BUILD,
    buildInfoFile: "/R/build-info.json",
    layout,
    readControldata: async () => CONTROL,
    lock: { layout, psInfo: async () => null, stopOrphan: async () => "fast", log: () => undefined },
    clone: makeClone(runTool),
    now: () => new Date("2026-09-24T08:49:33.000Z"),
    log: (l) => void events.push(l),
    events,
    ...over,
  } as DataGuardDeps & { events: string[] };
}

describe("runDataGuard — snapshots", () => {
  it("packaged, no record: takes a snapshot, then records the generation", async () => {
    makeCluster();
    const out = await runDataGuard(deps(), signal);
    expect(out.kind).toBe("proceed");
    expect(out.kind === "proceed" && out.snapshot?.manifest.toBuild).toBe(BUILD);
    expect(readGeneration(layout.generationFile)).toEqual({ build: BUILD, snapshot: "20260924T084933Z" });
  });
  it("same build recorded: no snapshot", async () => {
    makeCluster();
    writeGenerationAtomic(layout.generationFile, { build: BUILD, snapshot: "X" });
    const out = await runDataGuard(deps(), signal);
    expect(out.kind === "proceed" && out.snapshot).toBeNull();
    expect(fs.existsSync(layout.snapshots)).toBe(false);
  });
  it("dev: no snapshot and no record written", async () => {
    makeCluster();
    await runDataGuard(deps({ packaged: false, currentBuild: null }), signal);
    expect(fs.existsSync(layout.snapshots)).toBe(false);
    expect(fs.existsSync(layout.generationFile)).toBe(false);
  });
  it("external DB mode: does nothing at all", async () => {
    makeCluster();
    writeJournalAtomic(layout.restoreJournal, { id: "20260925T010203Z", snapshot: "S", step: "requested", requestedAt: "t", completedAt: null });
    const out = await runDataGuard(deps({ external: true }), signal);
    expect(out).toEqual({ kind: "proceed", snapshot: null, notice: null });
    expect(fs.existsSync(layout.restoreJournal)).toBe(true);
  });
  it("first install (no pgdata): no snapshot", async () => {
    const out = await runDataGuard(deps(), signal);
    expect(out.kind === "proceed" && out.snapshot).toBeNull();
  });
  it("pairing refusal (marker missing): creates nothing and does not touch the lock", async () => {
    makeCluster();
    fs.rmSync(layout.marker);
    let lockTouched = false;
    const out = await runDataGuard(deps({ lock: { layout, psInfo: async () => { lockTouched = true; return null; }, stopOrphan: async () => "fast", log: () => undefined } }), signal);
    expect(out.kind === "proceed" && out.snapshot).toBeNull();
    expect(fs.existsSync(layout.snapshots)).toBe(false);
    expect(lockTouched).toBe(false);
  });
  it("snapshot failure: manual snapshotFailed, no record, no .partial left", async () => {
    makeCluster();
    const err = await runDataGuard(deps({ clone: async () => { throw new Error("ENOSPC"); } }), signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceFailure);
    expect((err as ServiceFailure).recovery).toBe("manual");
    expect((err as Error).message).toMatch(/업데이트 전 스냅샷을 만들지 못해 시작하지 않았어요/);
    expect(fs.existsSync(layout.generationFile)).toBe(false);
    expect(fs.readdirSync(layout.snapshots)).toEqual([]);
  });
  it("crash between snapshot rename and record write: reuses that snapshot instead of taking another", async () => {
    makeCluster();
    await takeSnapshot({ layout, clone: makeClone(runTool), readControldata: async () => CONTROL, now: () => new Date("2026-09-24T08:49:33.000Z"), log: () => undefined },
      { fromBuild: null, toBuild: BUILD, fromRecord: null }, signal);
    for (let i = 0; i < 3; i += 1) {
      fs.rmSync(layout.generationFile, { force: true });
      await runDataGuard(deps({ now: () => new Date(`2026-09-24T09:0${i}:00.000Z`) }), signal);
    }
    expect(listCompleteSnapshots(layout.snapshots).map((s) => s.id)).toEqual(["20260924T084933Z"]);
  });
  it("packaged without build info: manual buildInfoMissing", async () => {
    makeCluster();
    await expect(runDataGuard(deps({ currentBuild: null }), signal)).rejects.toMatchObject({ recovery: "manual", message: expect.stringMatching(/빌드 정보/) });
  });
  it("lock refusal propagates as manual", async () => {
    makeCluster();
    fs.writeFileSync(path.join(layout.pgdata, "postmaster.pid"), ["4242", layout.pgdata, "0", "5432", layout.runDir, "", "", "ready   ", ""].join("\n"));
    const lock = { layout, psInfo: async () => { throw new Error("ps timed out"); }, stopOrphan: async () => "fast" as const, log: () => undefined };
    await expect(runDataGuard(deps({ lock }), signal)).rejects.toMatchObject({ recovery: "manual" });
  });
});

describe("runDataGuard — journal", () => {
  async function snapshotThenRequest(): Promise<string> {
    makeCluster();
    const out = await runDataGuard(deps(), signal);
    const sid = out.kind === "proceed" ? out.snapshot!.id : "";
    writeJournalAtomic(layout.restoreJournal, { id: "20260925T010203Z", snapshot: sid, step: "requested", requestedAt: "t", completedAt: null });
    return sid;
  }
  it("requested → hold, before decideCluster", async () => {
    await snapshotThenRequest();
    const out = await runDataGuard(deps(), signal);
    expect(out.kind).toBe("hold");
    expect(fs.existsSync(replacedDirOf(layout, "20260925T010203Z"))).toBe(true);
  });
  it("journal is processed before decideCluster when data/ is missing (never initdb-shaped)", async () => {
    await snapshotThenRequest();
    // staged까지 진행된 뒤 D→R rename 직후 끊긴 상태를 만든다
    await runDataGuard(deps({ pauseAfterStep: async (s) => { if (s === "staged") throw new Error("crash"); } }), signal).catch(() => undefined);
    fs.renameSync(layout.dataDir, replacedDirOf(layout, "20260925T010203Z"));
    expect(fs.existsSync(layout.dataDir)).toBe(false);
    const out = await runDataGuard(deps(), signal);
    expect(out.kind).toBe("hold");
    expect(fs.existsSync(path.join(layout.pgdata, "PG_VERSION"))).toBe(true);
  });
  it("unreadable journal: manual refusal, nothing moved", async () => {
    makeCluster();
    fs.writeFileSync(layout.restoreJournal, "{");
    await expect(runDataGuard(deps(), signal)).rejects.toMatchObject({ recovery: "manual", message: expect.stringMatching(/되돌리기 기록을 읽을 수 없어요/) });
    expect(fs.existsSync(layout.pgdata)).toBe(true);
  });
  it("aborted restore: proceeds normally with a restoreAborted notice", async () => {
    makeCluster();
    writeJournalAtomic(layout.restoreJournal, { id: "20260925T010203Z", snapshot: "20990101T000000Z", step: "requested", requestedAt: "t", completedAt: null });
    const out = await runDataGuard(deps(), signal);
    expect(out.kind).toBe("proceed");
    expect(out.kind === "proceed" && out.notice).toMatch(/되돌리기를 취소했어요/);
  });
  it("hold then release: next guard takes a NEW snapshot (fromRecord differs), not the old one", async () => {
    const sid = await snapshotThenRequest();
    await runDataGuard(deps(), signal);
    releaseHold(layout);
    const out = await runDataGuard(deps({ now: () => new Date("2026-10-01T00:00:00.000Z") }), signal);
    expect(out.kind === "proceed" && out.snapshot?.id).not.toBe(sid);
    expect(out.kind === "proceed" && out.snapshot?.manifest.fromRecord).toMatch(/restoredFrom/);
  });
  it("prune never deletes the snapshot a journal points at", async () => {
    const sid = await snapshotThenRequest();
    // 저널이 있는 동안 두 번 더 판올림이 일어난 것처럼 스냅샷을 쌓는다
    await takeSnapshot({ layout, clone: makeClone(runTool), readControldata: async () => CONTROL, now: () => new Date("2026-09-26T00:00:00.000Z"), log: () => undefined }, { fromBuild: null, toBuild: "b2", fromRecord: "x" }, signal);
    await takeSnapshot({ layout, clone: makeClone(runTool), readControldata: async () => CONTROL, now: () => new Date("2026-09-27T00:00:00.000Z"), log: () => undefined }, { fromBuild: null, toBuild: "b3", fromRecord: "y" }, signal);
    await runDataGuard(deps(), signal);
    expect(listCompleteSnapshots(layout.snapshots).map((s) => s.id)).toContain(sid);
  });
});
```

마지막 테스트: 저널이 `requested`인 채로 스냅샷이 둘 더 쌓인 상태에서 가드가 교체를 마치고 hold를 돌려줄 때, hold 경로의 정리가 저널의 스냅샷(`sid`, 가장 오래됨)을 지키는지 본다.

- [ ] **Step 7: 실패 확인** — `pnpm --filter damwha-desktop exec vitest run tests/app/data-guard.test.ts` → FAIL.

- [ ] **Step 8: 가드 구현** — `desktop/src/app/data-guard.ts`:

```ts
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
    if (jr.kind === "unreadable") throw new ServiceFailure(CAUSES.restoreJournalUnreadable.text(layout.restoreJournal, jr.why), "manual");
    if (jr.kind === "ok") {
      await clearPostmasterLock(d.lock);
      try {
        const out = await advanceJournal(
          {
            layout,
            clone: d.clone,
            findSnapshot: (id) => listCompleteSnapshots(layout.snapshots).find((s) => s.id === id) ?? null,
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
    pruneSnapshots(layout.snapshots, protectedIds(layout), d.log);
    return { kind: "proceed", snapshot, notice };
  });
}

/** 보류 해제 — [이 판으로 계속] (§7.3). 다음 가드가 새 스냅샷을 뜬다. */
export function releaseHold(layout: PgLayout): void {
  removeJournal(layout.restoreJournal);
}
```

`prune never deletes…` 테스트는 hold 경로의 정리(위 `pruneSnapshots(… new Set([jr.journal.snapshot]) …)`)가 저널의 스냅샷을 지키는지 본다 — 보호가 없으면 가장 오래된 `sid`가 상한 밖이라 지워진다.

- [ ] **Step 9: 통과 확인** — Step 7 명령 → PASS. 이어서 `pnpm --filter damwha-desktop exec vitest run tests/services/postgres tests/app` → 전부 PASS.

- [ ] **Step 10: 커밋**

```bash
git add desktop/src/diagnostics/causes.ts desktop/src/windows/shell-hints.ts desktop/src/app/data-guard.ts desktop/src/app/reap-on-start.ts desktop/src/process/orphans.ts desktop/tests/app/data-guard.test.ts desktop/tests/app/reap-on-start.test.ts desktop/tests/windows/recovery-hint.test.ts
git commit -m "feat(desktop): 데이터 가드와 되돌리기·스냅샷 원인 문구를 더한다

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 6: 마이그레이션 전 덤프 — sidecar와 세대별 첫 덤프 고정

**Files:**
- Modify: `desktop/src/services/postgres/migration-gate.ts` (`MigrationGateDeps`, `backup`, 정리)
- Test: `desktop/tests/services/postgres/migration-gate.test.ts`

**Interfaces:**
- Consumes: `PgLayout.snapshots`(Task 1)
- Produces: `MigrationGateDeps.generation?: () => string | null` (그때 `.damwha-generation`의 `snapshot`), sidecar `<dump>.json` = `{"firstPending","applied","generation"}`

- [ ] **Step 1: 테스트 작성** — `migration-gate.test.ts` 끝에. 기존 `setup()`이 `deps`를 돌려준다 — `deps.generation`을 끼우고 `layout.snapshots/<gen>`을 만들어 스냅샷이 있는 세대로 만든다:

```ts
describe("upgrade-start dump pinning (Phase 6b-2 §8)", () => {
  const dumpsIn = (dir: string) => fs.readdirSync(dir).filter((n) => n.endsWith(".dump")).sort();

  it("writes a sidecar next to each dump", async () => {
    const t = setup(ok(statusLine(25, ["026_x.sql"])), ok(statusLine(26, [])));
    t.deps.generation = () => "20260924T084933Z";
    await runMigrationGate(t.deps, new AbortController().signal);
    const dump = dumpsIn(t.deps.layout.backups)[0];
    expect(JSON.parse(fs.readFileSync(path.join(t.deps.layout.backups, `${dump}.json`), "utf8"))).toEqual({
      firstPending: "026_x.sql",
      applied: 25,
      generation: "20260924T084933Z",
    });
  });

  it("keeps the first dump of a generation through six partial-success retries", async () => {
    const gen = "20260924T084933Z";
    const files = ["026_a.sql", "027_b.sql", "028_c.sql", "029_d.sql", "030_e.sql", "031_f.sql", "032_g.sql"];
    let first: string | null = null;
    for (let i = 0; i < 7; i += 1) {
      // 매 재시도마다 한 파일이 더 성공하고 다음 파일에서 실패한다
      const t = setup(ok(statusLine(25 + i, files.slice(i))), fail(1, "error: boom"));
      t.deps.layout = pgLayout(path.join(root, "ud"));
      fs.mkdirSync(path.join(t.deps.layout.snapshots, gen), { recursive: true });
      t.deps.generation = () => gen;
      t.deps.now = () => new Date(Date.UTC(2026, 8, 24, 10, i, 0));
      await runMigrationGate(t.deps, new AbortController().signal).catch(() => undefined);
      if (first === null) first = dumpsIn(t.deps.layout.backups)[0];
    }
    const left = dumpsIn(pgLayout(path.join(root, "ud")).backups);
    expect(left).toContain(first);
    expect(left.length).toBe(KEEP_BACKUPS + 1);
  });

  it("same failing file five times also keeps the first dump", async () => {
    const gen = "20260924T084933Z";
    let first: string | null = null;
    for (let i = 0; i < 6; i += 1) {
      const t = setup(ok(statusLine(25, ["026_x.sql"])), fail(1, "error: boom"));
      t.deps.layout = pgLayout(path.join(root, "ud"));
      fs.mkdirSync(path.join(t.deps.layout.snapshots, gen), { recursive: true });
      t.deps.generation = () => gen;
      t.deps.now = () => new Date(Date.UTC(2026, 8, 24, 11, i, 0));
      await runMigrationGate(t.deps, new AbortController().signal).catch(() => undefined);
      if (first === null) first = dumpsIn(t.deps.layout.backups)[0];
    }
    expect(dumpsIn(pgLayout(path.join(root, "ud")).backups)).toContain(first);
  });

  it("null generation and sidecar-less dumps follow the plain 5-dump rule", async () => {
    for (let i = 0; i < 7; i += 1) {
      const t = setup(ok(statusLine(25, ["026_x.sql"])), fail(1, "error: boom"));
      t.deps.layout = pgLayout(path.join(root, "ud"));
      t.deps.generation = () => null;
      t.deps.now = () => new Date(Date.UTC(2026, 8, 24, 12, i, 0));
      await runMigrationGate(t.deps, new AbortController().signal).catch(() => undefined);
    }
    expect(dumpsIn(pgLayout(path.join(root, "ud")).backups).length).toBe(KEEP_BACKUPS);
  });

  it("unpins a generation whose snapshot no longer exists", async () => {
    for (let i = 0; i < 7; i += 1) {
      const t = setup(ok(statusLine(25, ["026_x.sql"])), fail(1, "error: boom"));
      t.deps.layout = pgLayout(path.join(root, "ud"));
      t.deps.generation = () => "20200101T000000Z"; // snapshots/ 아래에 없음
      t.deps.now = () => new Date(Date.UTC(2026, 8, 24, 13, i, 0));
      await runMigrationGate(t.deps, new AbortController().signal).catch(() => undefined);
    }
    expect(dumpsIn(pgLayout(path.join(root, "ud")).backups).length).toBe(KEEP_BACKUPS);
  });

  it("deletes a pruned dump's sidecar with it", async () => {
    for (let i = 0; i < 7; i += 1) {
      const t = setup(ok(statusLine(25, ["026_x.sql"])), fail(1, "error: boom"));
      t.deps.layout = pgLayout(path.join(root, "ud"));
      t.deps.generation = () => null;
      t.deps.now = () => new Date(Date.UTC(2026, 8, 24, 14, i, 0));
      await runMigrationGate(t.deps, new AbortController().signal).catch(() => undefined);
    }
    const dir = pgLayout(path.join(root, "ud")).backups;
    const sidecars = fs.readdirSync(dir).filter((n) => n.endsWith(".dump.json"));
    expect(sidecars.sort()).toEqual(dumpsIn(dir).map((n) => `${n}.json`));
  });
});
```

`setup()`의 `deps`가 `const`로 layout을 고정하면(`pgLayout(path.join(root, "ud"))`) 위처럼 재대입이 필요 없다 — 모든 `setup()`이 같은 `root/ud`를 쓰므로 `t.deps.layout = …` 줄은 지워도 된다. 실제 `setup` 본문을 보고 맞춘다. `fail`로 러너가 실패해도 `status`는 매번 새로 불리므로 반복 호출이 재시도를 흉내 낸다.

- [ ] **Step 2: 실패 확인** — `pnpm --filter damwha-desktop exec vitest run tests/services/postgres/migration-gate.test.ts` → 새 테스트 FAIL.

- [ ] **Step 3: 구현** — `migration-gate.ts`:
  1. `MigrationGateDeps`에 `/** 그때 data/.damwha-generation의 snapshot (Phase 6b-2 스펙 §8). 없으면 null. */ generation?: () => string | null;`
  2. `const SIDECAR_NAME = /^\d{8}T\d{6}Z-before-[A-Za-z0-9._-]+\.dump\.json$/;`
  3. `backup(deps, firstPending, signal)`을 `backup(deps, firstPending, applied, signal)`로 바꾸고 호출부를 `backup(deps, status.pending[0], status.applied, signal)`로.
  4. `fs.renameSync(partial, final);` 뒤에 sidecar:

```ts
  const generation = deps.generation?.() ?? null;
  fs.writeFileSync(`${final}.json`, `${JSON.stringify({ firstPending, applied, generation })}\n`, { mode: 0o600 });
```

  5. 정리 블록을 교체:

```ts
  // 새 백업이 검증된 **뒤에만** 오래된 것을 지운다. 방금 만든 파일 자신은 후보에서 뺀다(시계가 되돌아간 경우).
  // 세대(스냅샷 id)마다 **가장 오래된 덤프 하나**는 지우지 않는다 — 업그레이드 시작 덤프다. 부분 성공하는 재시도는
  // 매번 firstPending이 달라져 덤프가 5개를 넘고, 고정이 없으면 시작 덤프가 밀려난다 (Phase 6b-2 스펙 §8).
  // 스냅샷 디렉터리가 더 없는 세대는 고정을 푼다 — 묶음마다 하나씩 영원히 쌓이지 않게.
  const finalName = path.basename(final);
  const dumps = fs.readdirSync(dir).filter((n) => DUMP_NAME.test(n) && n !== finalName).sort();
  const pinned = new Set<string>();
  const seen = new Set<string>();
  for (const name of dumps) {
    const gen = sidecarGeneration(path.join(dir, `${name}.json`));
    if (gen === null || seen.has(gen)) continue;
    seen.add(gen);
    if (fs.existsSync(path.join(deps.layout.snapshots, gen))) pinned.add(name);
  }
  const candidates = dumps.filter((n) => !pinned.has(n));
  for (const name of candidates.slice(0, Math.max(0, candidates.length - (KEEP_BACKUPS - 1)))) {
    removeOwned(path.join(dir, name), DUMP_NAME, deps.log);
    removeOwned(path.join(dir, `${name}.json`), SIDECAR_NAME, deps.log);
  }
```

  6. 파일 위쪽 도우미:

```ts
/** sidecar의 generation. 없거나 못 읽거나 null이면 null — 그 덤프는 고정 대상이 아니다. */
function sidecarGeneration(file: string): string | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as { generation?: unknown };
    return typeof v.generation === "string" ? v.generation : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 통과 확인** — Step 2 명령 → 전부 PASS(기존 테스트 포함).

- [ ] **Step 5: 커밋**

```bash
git add desktop/src/services/postgres/migration-gate.ts desktop/tests/services/postgres/migration-gate.test.ts
git commit -m "fix(desktop): 마이그레이션 재시도가 업그레이드 시작 덤프를 밀어내지 않게 한다

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 7: 종료 흐름 `commit`·되돌리기 정책·메뉴·실패 화면 안내

**Files:**
- Modify: `desktop/src/app/quit-flow.ts` (`QuitFlowDeps.commit?`, `runQuitFlow`)
- Create: `desktop/src/app/restore-flow.ts`
- Modify: `desktop/src/windows/menu-template.ts`, `desktop/src/windows/menu.ts`
- Modify: `desktop/src/windows/status-view.ts` (`ShellInput.restoreAvailable?`, `shellStatusFrom`)
- Test: `desktop/tests/app/quit-flow.test.ts`, `desktop/tests/app/restore-flow.test.ts`, `desktop/tests/windows/menu-template.test.ts`(있으면; 없으면 만든다), `desktop/tests/windows/status-view.test.ts`

**Interfaces:**
- Consumes: `SnapshotInfo`·`SnapshotManifest`(Task 2), `RestoreJournal`·`JournalStep`(Task 4), `GuardOutcome`(Task 5)
- Produces:
  - `QuitFlowDeps.commit?(): Promise<void>` — 확인 뒤·`beginQuit` 전. 던지면 로그 한 줄 남기고 종료하지 않는다.
  - `restore-flow.ts`: `RELEASES_PAGE_URL`, `restoreMenuEnabled(s: { external: boolean; restorable: readonly SnapshotInfo[]; journalPresent: boolean }): boolean`, `versionOfBuild(build: string | null): string | null`, `snapshotLine(m: SnapshotManifest, fmt: (iso: string) => string): string`, `confirmRestoreDialog(snaps: readonly SnapshotInfo[], fmt): { options: MessageBoxOptions; choices: (string | null)[] }`, `type HoldChoice = "quit" | "download" | "continue"`, `holdDialog(h: { journal: RestoreJournal; snapshot: SnapshotInfo | null; replacedDir: string }, fmt): { options: MessageBoxOptions; choices: HoldChoice[] }`, `parsePauseStep(v: string | undefined): JournalStep | null`, `createIoTracker(): { track<T>(p: Promise<T>): Promise<T>; settled(): Promise<void> }`
  - `MenuHandlers.onRestore(): void`; `buildMenuTemplate(handlers, appName, opts?: { restoreEnabled: boolean })`; `installMenu(handlers, opts?)`
  - `ShellInput.restoreAvailable?: boolean`; `RESTORE_MENU_NOTE` (status-view.ts export)

- [ ] **Step 1: quit-flow 테스트** — `quit-flow.test.ts`의 기존 `recorder()`를 써서:

```ts
describe("commit step (Phase 6b-2 §6.2)", () => {
  it("runs commit after the decision and before beginQuit", async () => {
    const r = recorder({ commit: async () => void r.log.push("commit") });
    await runQuitFlow(r.deps);
    expect(r.log.indexOf("commit")).toBeLessThan(r.log.indexOf("beginQuit"));
  });
  it("a throwing commit starts no quit: no beginQuit, no stopServices, no quit", async () => {
    const r = recorder({ commit: async () => { throw new Error("ENOSPC"); } });
    await runQuitFlow(r.deps);
    expect(r.log).not.toContain("beginQuit");
    expect(r.log.some((l) => l.startsWith("stopServices"))).toBe(false);
    expect(r.log).not.toContain("quit");
    expect(r.lines.join("\n")).toMatch(/ENOSPC/);
  });
  it("cancelling the recording confirm never reaches commit", async () => {
    let committed = false;
    const r = recorder({ commit: async () => { committed = true; }, confirm: async () => false }, { recording: true, analysing: false });
    await runQuitFlow(r.deps);
    expect(committed).toBe(false);
  });
});
```

`recorder()`가 돌려주는 모양(`r.deps`·`r.log`·`r.lines`)과 `beginQuit`·`quit`·`stopServices` 기록 이름은 파일에서 실제 이름을 확인해 맞춘다(`sed -n 30,90p desktop/tests/app/quit-flow.test.ts`).

- [ ] **Step 2: 실패 확인** — `pnpm --filter damwha-desktop exec vitest run tests/app/quit-flow.test.ts` → FAIL.

- [ ] **Step 3: quit-flow 구현** — `QuitFlowDeps`에:

```ts
  /**
   * 종료를 되돌릴 수 없게 만들기 **전에** 끝나야 하는 기록 (Phase 6b-2 스펙 §6.2 — 되돌리기 저널). beginQuit은 동기이고
   * 정리용 try/finally 밖이라 거기서 던지면 서비스 정지를 건너뛴다. 던지면 이번 종료를 시작하지 않는다.
   */
  commit?(): Promise<void>;
```

`runQuitFlow`의 `if (!decision.quit) return;` 다음, `deps.beginQuit();` 앞에:

```ts
  if (deps.commit !== undefined) {
    try {
      await deps.commit();
    } catch (e) {
      deps.log(`종료 전 기록을 남기지 못해 종료하지 않았어요 — ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
  }
```

- [ ] **Step 4: 통과 확인** — Step 2 명령 → PASS.

- [ ] **Step 5: restore-flow 테스트** — `desktop/tests/app/restore-flow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  confirmRestoreDialog,
  createIoTracker,
  holdDialog,
  parsePauseStep,
  RELEASES_PAGE_URL,
  restoreMenuEnabled,
  snapshotLine,
  versionOfBuild,
} from "../../src/app/restore-flow";
import type { SnapshotInfo, SnapshotManifest } from "../../src/services/postgres/snapshot";

const fmt = (iso: string) => `T(${iso})`;
const manifest = (m: Partial<SnapshotManifest> = {}): SnapshotManifest => ({
  id: "20260924T084933Z", createdAt: "2026-09-24T08:49:33.000Z", fromBuild: "0.3.1+0123456789ab", toBuild: "0.4.0+ba9876543210",
  fromRecord: null, pgVersion: "16", clusterId: "1", databaseOid: 1, clusterState: "shut down", complete: true, ...m,
});
const info = (m: Partial<SnapshotManifest> = {}): SnapshotInfo => ({ id: m.id ?? "20260924T084933Z", dir: "/d", manifest: manifest(m) });

describe("menu enablement", () => {
  it("enabled only with a restorable snapshot, no journal, embedded mode", () => {
    expect(restoreMenuEnabled({ external: false, restorable: [info()], journalPresent: false })).toBe(true);
    expect(restoreMenuEnabled({ external: true, restorable: [info()], journalPresent: false })).toBe(false);
    expect(restoreMenuEnabled({ external: false, restorable: [], journalPresent: false })).toBe(false);
    expect(restoreMenuEnabled({ external: false, restorable: [info()], journalPresent: true })).toBe(false);
  });
});

describe("wording", () => {
  it("versionOfBuild strips the commit", () => {
    expect(versionOfBuild("0.4.0+ba9876543210")).toBe("0.4.0");
    expect(versionOfBuild(null)).toBeNull();
  });
  it("snapshot line names versions and time, and flags an unclean cluster", () => {
    expect(snapshotLine(manifest(), fmt)).toBe("0.3.1 → 0.4.0 업데이트 직전 · T(2026-09-24T08:49:33.000Z)");
    expect(snapshotLine(manifest({ fromBuild: null, clusterState: "in production" }), fmt)).toBe(
      "이전 판 → 0.4.0 업데이트 직전 · T(2026-09-24T08:49:33.000Z) (비정상 종료 뒤의 상태)",
    );
  });
});

describe("confirm dialog", () => {
  it("one button per snapshot plus cancel; Escape picks cancel", () => {
    const d = confirmRestoreDialog([info(), info({ id: "20260920T000000Z", createdAt: "2026-09-20T00:00:00.000Z" })], fmt);
    expect(d.options.buttons).toHaveLength(3);
    expect(d.options.cancelId).toBe(2);
    expect(d.choices).toEqual(["20260924T084933Z", "20260920T000000Z", null]);
    expect(String(d.options.detail)).toMatch(/data\.replaced-/);
    expect(String(d.options.detail)).toMatch(/토큰·마이크 권한·모델은 그대로/);
  });
});

describe("hold dialog", () => {
  const journal = { id: "20260925T010203Z", snapshot: "20260924T084933Z", step: "hold" as const, requestedAt: "r", completedAt: "2026-09-25T01:05:00.000Z" };
  it("speaks in dates, names the replaced dir, offers quit/download/continue with quit as cancel", () => {
    const d = holdDialog({ journal, snapshot: info(), replacedDir: "/U/data.replaced-20260925T010203Z" }, fmt);
    expect(String(d.options.message)).toMatch(/T\(2026-09-25T01:05:00.000Z\)에 업데이트 전 데이터/);
    expect(String(d.options.detail)).toMatch(/그 뒤 이전 판에서 쓴 내용은 지금 데이터에 그대로 있어요/);
    expect(String(d.options.detail)).toMatch(/\/U\/data\.replaced-20260925T010203Z/);
    expect(String(d.options.detail)).toMatch(/이전 판\(0\.3\.1\)/);
    expect(d.choices).toEqual(["quit", "download", "continue"]);
    expect(d.options.cancelId).toBe(0);
  });
  it("names 'the version you used before the update' when fromBuild is null or the snapshot is gone", () => {
    expect(String(holdDialog({ journal, snapshot: info({ fromBuild: null }), replacedDir: "/r" }, fmt).options.detail)).toMatch(/업데이트 전에 쓰던 판/);
    expect(String(holdDialog({ journal, snapshot: null, replacedDir: "/r" }, fmt).options.detail)).toMatch(/업데이트 전에 쓰던 판/);
  });
  it("releases page url", () => expect(RELEASES_PAGE_URL).toBe("https://github.com/Yjason-K/Damwha/releases"));
});

describe("pause env and io tracker", () => {
  it("parses only known steps", () => {
    expect(parsePauseStep("staged")).toBe("staged");
    expect(parsePauseStep("moved-aside")).toBe("moved-aside");
    expect(parsePauseStep("bogus")).toBeNull();
    expect(parsePauseStep(undefined)).toBeNull();
  });
  it("settled waits for tracked work, including rejected work", async () => {
    const t = createIoTracker();
    let done = false;
    void t.track(new Promise<void>((resolve) => setTimeout(() => { done = true; resolve(); }, 20)));
    void t.track(Promise.reject(new Error("x"))).catch(() => undefined);
    await t.settled();
    expect(done).toBe(true);
  });
});
```

- [ ] **Step 6: 실패 확인** — `pnpm --filter damwha-desktop exec vitest run tests/app/restore-flow.test.ts` → FAIL.

- [ ] **Step 7: restore-flow 구현** — `desktop/src/app/restore-flow.ts`:

```ts
import type { MessageBoxOptions } from "electron";
import type { JournalStep, RestoreJournal } from "../services/postgres/restore-journal";
import type { SnapshotInfo, SnapshotManifest } from "../services/postgres/snapshot";

/**
 * 되돌리기의 정책과 문구 (Phase 6b-2 스펙 §7). 대화상자를 띄우는 것은 main.ts다. electron을 값으로 import하지 않는다.
 * `cancelId`를 반드시 준다 — 한국어 라벨은 취소로 인식되지 않아 Escape가 파괴적 선택을 고를 수 있다(6b-1 스펙 §3-11).
 */

export const RELEASES_PAGE_URL = "https://github.com/Yjason-K/Damwha/releases";

export function restoreMenuEnabled(s: { external: boolean; restorable: readonly SnapshotInfo[]; journalPresent: boolean }): boolean {
  return !s.external && !s.journalPresent && s.restorable.length > 0;
}

export function versionOfBuild(build: string | null): string | null {
  return build === null ? null : build.split("+")[0];
}

export function snapshotLine(m: SnapshotManifest, fmt: (iso: string) => string): string {
  const from = versionOfBuild(m.fromBuild) ?? "이전 판";
  const unclean = m.clusterState === "shut down" ? "" : " (비정상 종료 뒤의 상태)";
  return `${from} → ${versionOfBuild(m.toBuild)} 업데이트 직전 · ${fmt(m.createdAt)}${unclean}`;
}

export function confirmRestoreDialog(
  snaps: readonly SnapshotInfo[],
  fmt: (iso: string) => string,
): { options: MessageBoxOptions; choices: (string | null)[] } {
  const buttons = [...snaps.map((s) => `${fmt(s.manifest.createdAt)} 상태로 되돌리고 다시 시작`), "취소"];
  return {
    options: {
      type: "warning",
      message: "업데이트 전으로 되돌릴까요?",
      detail: [
        ...snaps.map((s) => `• ${snapshotLine(s.manifest, fmt)}`),
        "",
        "그 뒤에 만든 회의와 바꾼 설정은 지우지 않고 data.replaced-… 폴더로 옮겨 둬요. 토큰·마이크 권한·모델은 그대로예요. 앱이 다시 시작돼요.",
      ].join("\n"),
      buttons,
      defaultId: buttons.length - 1,
      cancelId: buttons.length - 1,
      noLink: true,
    },
    choices: [...snaps.map((s) => s.id), null],
  };
}

export type HoldChoice = "quit" | "download" | "continue";

export function holdDialog(
  h: { journal: RestoreJournal; snapshot: SnapshotInfo | null; replacedDir: string },
  fmt: (iso: string) => string,
): { options: MessageBoxOptions; choices: HoldChoice[] } {
  const when = fmt(h.journal.completedAt ?? h.journal.requestedAt);
  const at = h.snapshot === null ? "" : `(${fmt(h.snapshot.manifest.createdAt)} 상태)`;
  const prev = versionOfBuild(h.snapshot?.manifest.fromBuild ?? null);
  const prevName = prev === null ? "업데이트 전에 쓰던 판" : `이전 판(${prev})`;
  return {
    options: {
      type: "info",
      message: `${when}에 업데이트 전 데이터${at}로 되돌렸어요.`,
      detail: [
        "그 뒤 이전 판에서 쓴 내용은 지금 데이터에 그대로 있어요.",
        `되돌리기 전 데이터는 ${h.replacedDir}에 있어요.`,
        "",
        `${prevName}을 쓰려면 앱을 종료하고 그 판을 설치하세요. 이 판으로 계속하면 데이터를 다시 업데이트해요.`,
      ].join("\n"),
      buttons: ["종료", "다운로드 페이지 열고 종료", "이 판으로 계속"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    },
    choices: ["quit", "download", "continue"],
  };
}

const STEPS: readonly JournalStep[] = ["requested", "staged", "moved-aside", "hold"];

/** 실측용 `DAMWHA_RESTORE_PAUSE_AFTER_STEP` (스펙 §12.2-6). 모르는 값은 무시한다. */
export function parsePauseStep(v: string | undefined): JournalStep | null {
  return v !== undefined && (STEPS as readonly string[]).includes(v) ? (v as JournalStep) : null;
}

/**
 * 데이터 가드의 파일 I/O를 종료 흐름이 기다리게 한다 (스펙 §5.2 "종료와의 관계"). 감독자가 없으면 stopServices가 곧바로
 * 끝나 `/bin/cp`가 Electron 뒤에 남는다. 대화상자(보류)는 넣지 않는다 — 종료가 사람의 선택을 기다리면 순환이다.
 */
export function createIoTracker(): { track<T>(p: Promise<T>): Promise<T>; settled(): Promise<void> } {
  const pending = new Set<Promise<unknown>>();
  return {
    track<T>(p: Promise<T>): Promise<T> {
      const tracked = p.catch(() => undefined);
      pending.add(tracked);
      void tracked.finally(() => pending.delete(tracked));
      return p;
    },
    async settled(): Promise<void> {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}
```

- [ ] **Step 8: 통과 확인** — Step 6 명령 → PASS.

- [ ] **Step 9: 메뉴** — `menu-template.ts`:
  - `MenuHandlers`에 `/** 업데이트 전으로 되돌리기 (Phase 6b-2 스펙 §7.1). */ onRestore(): void;`
  - 시그니처 `buildMenuTemplate(handlers: MenuHandlers, appName: string, opts: { restoreEnabled: boolean } = { restoreEnabled: false })`
  - "업데이트 확인…" 바로 아래: `{ label: "업데이트 전으로 되돌리기…", enabled: opts.restoreEnabled, click: () => handlers.onRestore() },`
  - `menu.ts`: `export function installMenu(handlers: MenuHandlers, opts?: { restoreEnabled: boolean }): void { Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(handlers, app.name, opts))); }`

  테스트(`desktop/tests/windows/menu-template.test.ts`, 없으면 만든다 — 기존 것이 있으면 거기에 더하고 `onRestore`를 기존 가짜 handlers에 추가):

```ts
import { describe, expect, it } from "vitest";
import { buildMenuTemplate, type MenuHandlers } from "../../src/windows/menu-template";

const handlers = (): MenuHandlers & { restored: number } => {
  const h = { restored: 0, onRetry: () => undefined, onShowStatus: () => undefined, onCheckForUpdates: () => undefined, onRestore: () => { h.restored += 1; } };
  return h;
};
const restoreItem = (enabled?: boolean) => {
  const app = buildMenuTemplate(handlers(), "Damwha", enabled === undefined ? undefined : { restoreEnabled: enabled })[0];
  return (app.submenu as Array<{ label?: string; enabled?: boolean }>).find((i) => i.label === "업데이트 전으로 되돌리기…");
};

describe("restore menu item", () => {
  it("sits in the app menu, disabled by default", () => expect(restoreItem()?.enabled).toBe(false));
  it("follows restoreEnabled", () => expect(restoreItem(true)?.enabled).toBe(true));
  it("calls onRestore", () => {
    const h = handlers();
    const app = buildMenuTemplate(h, "Damwha", { restoreEnabled: true })[0];
    const item = (app.submenu as Array<{ label?: string; click?: () => void }>).find((i) => i.label === "업데이트 전으로 되돌리기…");
    item?.click?.();
    expect(h.restored).toBe(1);
  });
});
```

- [ ] **Step 10: 실패 화면 안내** — `status-view.ts`:

```ts
/** 업데이트와 관계된 실패에서, 되돌리기가 실제로 가능할 때만 덧붙인다 (Phase 6b-2 스펙 §7.1). */
export const RESTORE_MENU_NOTE = "앱 메뉴 → 업데이트 전으로 되돌리기…로 업데이트 전 데이터로 돌아갈 수 있어요.";
const RESTORE_RELEVANT = new Set(["migrationFailed", "migrationsStillPending"]);
```

`ShellInput`에 `restoreAvailable?: boolean;`. `shellStatusFrom`의 `failed` 분기에서:

```ts
  const failedCause = failed.detail === undefined ? undefined : causeIn(failed.detail);
  const note = input.restoreAvailable === true && failedCause !== undefined && RESTORE_RELEVANT.has(failedCause) ? [RESTORE_MENU_NOTE] : [];
  return { state: "failed", detail: [...lines, ...note].join("\n"), logPath: input.logPathOf(failed.id) };
```

(`causeIn`은 `../diagnostics/causes`에서 import한다 — 이미 import돼 있으면 재사용. `ServiceStatus.detail`의 실제 필드 이름은 `grep -n "detail" desktop/src/services/types.ts`로 확인.)

테스트(`status-view.test.ts`에 추가):

```ts
it("appends the restore note only for update failures and only when restorable", () => {
  const failedApi = (detail: string) => ({ ...baseStatus("api"), process: "failed" as const, recovery: "manual" as const, detail });
  const mig = CAUSES.migrationFailed.text("마이그레이션 러너: error: boom", null);
  const on = shellStatusFrom({ statuses: [failedApi(mig)], restartNotice: null, logPathOf: () => "/l", restoreAvailable: true });
  const off = shellStatusFrom({ statuses: [failedApi(mig)], restartNotice: null, logPathOf: () => "/l", restoreAvailable: false });
  const other = shellStatusFrom({ statuses: [failedApi(CAUSES.portInUse.text(3000))], restartNotice: null, logPathOf: () => "/l", restoreAvailable: true });
  expect(on.detail).toContain(RESTORE_MENU_NOTE);
  expect(off.detail).not.toContain(RESTORE_MENU_NOTE);
  expect(other.detail).not.toContain(RESTORE_MENU_NOTE);
});
```

`baseStatus`·`CAUSES.portInUse.text`의 실제 인자는 파일에서 확인해 맞춘다(없으면 기존 테스트의 `ServiceStatus` 픽스처를 복사).

- [ ] **Step 11: 통과 확인** — `pnpm --filter damwha-desktop exec vitest run tests/app tests/windows` → 전부 PASS.

- [ ] **Step 12: 커밋**

```bash
git add desktop/src/app/quit-flow.ts desktop/src/app/restore-flow.ts desktop/src/windows/menu-template.ts desktop/src/windows/menu.ts desktop/src/windows/status-view.ts desktop/tests/app/quit-flow.test.ts desktop/tests/app/restore-flow.test.ts desktop/tests/windows/menu-template.test.ts desktop/tests/windows/status-view.test.ts
git commit -m "feat(desktop): 되돌리기 메뉴·대화상자 정책과 종료 흐름의 commit 단계를 더한다

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 8: main.ts 배선

**Files:**
- Modify: `desktop/src/main.ts`
- Test: 컴파일·전 테스트·lint (main.ts는 vitest가 부를 수 없다 — 판단은 Task 1~7이 이미 테스트했다)

**Interfaces:**
- Consumes: `runDataGuard`·`releaseHold`·`GuardOutcome`(Task 5), `makeClone`(Task 2), `restorableSnapshots`(Task 2), `readJournal`·`writeJournalAtomic`·`chooseRestoreId`(Task 4), `parseBuildInfo`·`buildIdOf`·`readGeneration`(Task 1), `confirmRestoreDialog`·`holdDialog`·`restoreMenuEnabled`·`parsePauseStep`·`createIoTracker`·`RELEASES_PAGE_URL`(Task 7), `QuitFlowDeps.commit`(Task 7), `installMenu(handlers, opts)`(Task 7), `ShellInput.restoreAvailable`(Task 7)

배선 지점과 코드(각 지점은 `grep -n`으로 찾는다 — 줄 번호는 이 브랜치에서 바뀔 수 있다):

- [ ] **Step 1: 모듈 상태와 도우미** — 파일 위쪽 전역 상태 근처(`let supervisor` 부근)에:

```ts
/** 데이터 가드의 파일 I/O. stopServices가 기다린다 (Phase 6b-2 스펙 §5.2). */
const guardIo = createIoTracker();
/** 감독자 없이 던진 마지막 기동 실패. 창 재열기가 manual 실패를 자동 재시도하지 않게 한다 (§5.2 "가드 실패의 상태"). */
let lastStartFailure: unknown = null;
/** 메뉴에서 고른 되돌리기. before-quit의 commit이 저널을 쓰고, quit이 relaunch한다 (§6.2·§7.2). */
let pendingRestore: { snapshot: string } | null = null;
let restoreCommitted = false;
let menuHandlers: MenuHandlers | null = null;

function currentBuildId(): string | null {
  if (!app.isPackaged) return null;
  try {
    const info = parseBuildInfo(fs.readFileSync(path.join(process.resourcesPath, "build-info.json"), "utf8"));
    return info === null ? null : buildIdOf(info);
  } catch {
    return null;
  }
}

const localTime = (iso: string) => new Date(iso).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });

function refreshMenu(): void {
  if (menuHandlers === null) return;
  const layout = pgLayout(app.getPath("userData"));
  installMenu(menuHandlers, {
    restoreEnabled: restoreMenuEnabled({
      external: currentDatabaseMode()?.kind === "external",
      restorable: restorableSnapshots(layout.snapshots, PG_MAJOR),
      journalPresent: readJournal(layout.restoreJournal).kind !== "none",
    }),
  });
}
```

import를 더한다: `MenuHandlers`(type), `createIoTracker`·`confirmRestoreDialog`·`holdDialog`·`restoreMenuEnabled`·`parsePauseStep`·`RELEASES_PAGE_URL`(`./app/restore-flow`), `runDataGuard`·`releaseHold`·`type GuardOutcome`(`./app/data-guard`), `makeClone`(`./process/clone`), `restorableSnapshots`(`./services/postgres/snapshot`), `readJournal`·`writeJournalAtomic`·`chooseRestoreId`(`./services/postgres/restore-journal`), `parseBuildInfo`·`buildIdOf`(`./services/postgres/generation`), `PG_MAJOR`(`./services/postgres/layout`, 이미 있으면 생략), `shell`(electron, 이미 있으면 생략).

- [ ] **Step 2: 가드 실행 함수** — `createSupervisorFor` 위에:

```ts
/** 데이터 가드 한 번 (스펙 §5.2). 파일 I/O 전체를 guardIo에 등록한다 — 보류 대화상자는 밖에서 띄운다. */
function guardOnce(layout: PgLayout, binaries: PgBinaries, external: boolean, signal: AbortSignal): Promise<GuardOutcome> {
  const pause = parsePauseStep(process.env.DAMWHA_RESTORE_PAUSE_AFTER_STEP);
  const env = pgToolEnv();
  return guardIo.track(
    runDataGuard(
      {
        packaged: app.isPackaged,
        external,
        currentBuild: currentBuildId(),
        buildInfoFile: path.join(process.resourcesPath, "build-info.json"),
        layout,
        readControldata: async (pgdata, signal) => {
          const r = await runTool(binaries.pgControldata, ["-D", pgdata], { env, deadlineMs: PG_TOOL_DEADLINES.controldata, signal });
          if (!toolOk(r)) throw new Error(describeToolFailure("pg_controldata", r));
          return r.stdout;
        },
        lock: {
          layout,
          psInfo,
          stopOrphan: (pid) => stopOrphanPostmaster(pid, PG_FAST_GRACE_MS, PG_IMMEDIATE_GRACE_MS),
          log: appendSupervisorLog,
        },
        clone: makeClone(runTool),
        now: () => new Date(),
        log: appendSupervisorLog,
        pauseAfterStep: pause === null ? undefined : async (step) => {
          if (step !== pause) return;
          appendSupervisorLog(`되돌리기: 실측용 대기 60초 — ${step}`);
          await new Promise((resolve) => setTimeout(resolve, 60_000));
        },
      },
      signal,
    ),
  );
}

/**
 * 가드를 돌리고 보류면 사람에게 묻는다 (스펙 §7.3). true = 기동을 잇는다, false = 종료로 간다.
 * [이 판으로 계속]은 저널을 지우고 가드를 다시 돌린다 — 그때 새 스냅샷이 뜬다.
 */
async function passDataGuard(mine: number, layout: PgLayout, binaries: PgBinaries, external: boolean): Promise<boolean> {
  for (;;) {
    const out = await guardOnce(layout, binaries, external, new AbortController().signal);
    if (out.kind === "proceed") {
      refreshMenu();
      if (out.notice !== null) {
        const target = activeWindow(mine);
        const opts = { type: "info" as const, message: out.notice, buttons: ["확인"], defaultId: 0, cancelId: 0 };
        void modals.track(target === null ? dialog.showMessageBox(opts) : dialog.showMessageBox(target, opts));
      }
      return true;
    }
    const d = holdDialog(out, localTime);
    const target = activeWindow(mine);
    const { response } = await modals.track(target === null ? dialog.showMessageBox(d.options) : dialog.showMessageBox(target, d.options));
    const choice = d.choices[response] ?? "quit";
    if (choice === "continue") {
      releaseHold(layout);
      continue;
    }
    if (choice === "download") await shell.openExternal(RELEASES_PAGE_URL).catch(() => undefined);
    app.quit();
    return false;
  }
}
```

`PgLayout`·`PgBinaries`·`pgToolEnv`·`PG_TOOL_DEADLINES`·`PG_FAST_GRACE_MS`·`PG_IMMEDIATE_GRACE_MS`·`toolOk`·`describeToolFailure`·`psInfo`·`stopOrphanPostmaster`·`modals`·`activeWindow`는 main.ts에 이미 있거나 import돼 있다 — 없는 것만 더한다(`grep -n "^import\|psInfo\|stopOrphanPostmaster\|const modals" src/main.ts`).

- [ ] **Step 3: 첫 기동 호출 지점** — `createSupervisorFor` 안, `await reapBeforeStart(…);` 다음이면서 `const layout = pgLayout(userData);`·`const binaries = …`가 정의된 **뒤**, 감독자를 만들기 **전**(= `embeddedPostgresSpec` 조립 전)에:

```ts
  // 데이터 가드 (Phase 6b-2 스펙 §5.2) — 감독자가 postgres를 launch하기 전에 반드시 통과한다. 고아를 내린 뒤라
  // 스토리지에 쓰는 앱 소유 프로세스가 없다(reapBeforeStart가 생존자를 거부한다).
  if (!(await passDataGuard(mine, layout, binaries, mode.kind === "external"))) return false;
```

`layout`·`binaries`·`mode` 정의가 `reapBeforeStart`보다 뒤에 있으면 가드 호출을 그 정의들 바로 다음으로 둔다(순서: reap → layout/binaries/mode 정의 → 가드 → 감독자 조립).

- [ ] **Step 4: 모든 postgres launch가 가드를 거친다 — `preLaunch` 훅** — "다시 시도"(`existing.retry()`)와 상태 창의 "postgres 다시 시작"(`restartOnce` → `bring` → `launch`, `supervisor.ts:711~`)은 둘 다 `createSupervisorFor`를 건너뛰고 postgres `launch()`로 곧장 간다. 첫 가드가 판정표 거부로 스냅샷을 건너뛴 뒤 사람이 마커를 고치고 둘 중 하나를 누르면 스냅샷 없이 마이그레이션까지 간다(코덱스 스펙 리뷰 [2], 계획 검증 [4]). 호출 지점을 늘리는 대신 **어댑터가 launch 맨 앞에서 훅을 부르게** 한다.

  1. `desktop/src/services/postgres/service.ts`의 `EmbeddedPostgresDeps`에:

  ```ts
  /**
   * launch의 맨 앞, 어떤 판정·파일 작업보다 먼저 (Phase 6b-2 스펙 §5.2). main이 데이터 가드를 건다 — 첫 기동·다시 시도·
   * 상태 창 재시작이 모두 이 한 곳을 지난다. 던지면 launch가 거부로 끝난다.
   */
  preLaunch?(signal: AbortSignal): Promise<void>;
  ```

  `launch(ctx)`의 `manualUnlessTagged(async () => {` 바로 안, 번들 확인보다 **앞**에 `await deps.preLaunch?.(ctx.signal);`.

  2. 테스트 — `desktop/tests/services/postgres/service.test.ts`에(기존 `setup()` 사용):

  ```ts
  it("calls preLaunch before anything else and refuses without creating anything when it throws", async () => {
    const order: string[] = [];
    const t = setup({ preLaunch: async () => { order.push("preLaunch"); throw new ServiceFailure("guard said no", "manual"); } });
    await expect(t.spec.launch(t.ctx)).rejects.toThrow(/guard said no/);
    expect(order).toEqual(["preLaunch"]);
    expect(fs.existsSync(t.deps.layout.dataDir)).toBe(false);
  });
  ```

  `setup()`의 인자·반환 모양(`t.spec`·`t.ctx`·`t.deps`)은 파일에서 확인해 맞춘다. 돌린다: `pnpm --filter damwha-desktop exec vitest run tests/services/postgres/service.test.ts` → PASS.

  3. main.ts — `embeddedPostgresSpec({ … })` 조립에 훅을 넣는다:

  ```ts
          preLaunch: async (signal) => {
            const out = await guardOnce(layout, binaries, false, signal);
            // 보류는 첫 기동의 passDataGuard만 사람에게 묻는다. 여기(다시 시도·재시작)에서 보류를 만나는 것은 앱이 떠 있는
            // 동안 저널이 생긴 경우뿐이라 다시 시작하라고만 말한다.
            if (out.kind === "hold") throw new ServiceFailure(CAUSES.restoreIncomplete.text("되돌리기가 보류 중이에요 — 앱을 다시 시작해 주세요."), "manual");
            refreshMenu();
          },
  ```

  (`guardOnce`는 Step 2에서 이미 `signal`을 받는다.) 첫 기동은 Step 3의 명시 호출(보류 대화상자) 뒤 이 훅이 한 번 더 도는데, 이미 기록이 있어 스냅샷은 뜨지 않고 락도 비어 있어 비용이 없다. `ServiceFailure`·`CAUSES` import를 확인한다.

- [ ] **Step 5: 실패 보존과 창 재열기** — `startOnce`:

```ts
  try {
    await startServices(mine);
    lastStartFailure = null;
  } catch (e) {
    if (supervisor === null) lastStartFailure = e;
    await reportFailure(mine, "앱을 시작하지 못했어요", e);
  }
```

창 재열기(`openWindowFlow` deps, `main.ts:1632` 부근)를 둘 다 바꾼다 — 재시도를 막기만 하면 감독자가 없는 상태의 `shellStatusOf()`가 빈 "준비 중" 화면을 그려, 사람은 원인도 "다시 시도" 안내도 없이 멈춘 화면을 본다(계획 검증 [3]):

```ts
      showShell: () =>
        showShell(
          opened,
          supervisor === null && lastStartFailure !== null
            ? { state: "failed", detail: failureDetail("앱을 시작하지 못했어요", reasonOf(lastStartFailure)), logPath: logPathOf("supervisor") }
            : shellStatusOf(),
        ),
      autoRetryAllowed: () => mayAutoRetry(supervisor?.statuses() ?? null, lastStartFailure ?? undefined),
```

(`failureDetail`은 `windows/status-view.ts`에서 이미 import돼 있다 — `reportFailure`가 쓴다.)

- [ ] **Step 6: stopServices가 가드 I/O를 기다린다** — `async function stopServices(): Promise<StopOutcome>`의 **첫 줄**에:

```ts
  // 감독자가 없어도 가드의 /bin/cp가 돌고 있을 수 있다 — 끝나기 전에 앱이 나가면 .partial·staging에 계속 쓴다 (스펙 §5.2).
  await guardIo.settled();
```

- [ ] **Step 7: 메뉴 핸들러와 되돌리기 시작** — `installMenu({ … })` 호출을 `menuHandlers = { … }; refreshMenu();`로 바꾸고 handlers에 추가:

```ts
      onRestore: () => {
        void (async () => {
          const layout = pgLayout(app.getPath("userData"));
          const snaps = restorableSnapshots(layout.snapshots, PG_MAJOR);
          if (snaps.length === 0 || currentDatabaseMode()?.kind === "external" || readJournal(layout.restoreJournal).kind !== "none") return;
          const d = confirmRestoreDialog(snaps, localTime);
          const target = win !== null && !win.isDestroyed() ? win : null;
          const { response } = await modals.track(target === null ? dialog.showMessageBox(d.options) : dialog.showMessageBox(target, d.options));
          const sid = d.choices[response] ?? null;
          if (sid === null) return;
          pendingRestore = { snapshot: sid };
          app.quit();
        })().catch((e: unknown) => appendSupervisorLog(`되돌리기 시작 중 예외 — ${reasonOf(e)}`));
      },
```

- [ ] **Step 8: 종료 흐름에 commit·relaunch** — before-quit의 `runQuitFlow({ … })` deps에:

```ts
      commit:
        pendingRestore === null
          ? undefined
          : async () => {
              const layout = pgLayout(app.getPath("userData"));
              const sid = pendingRestore!.snapshot;
              try {
                writeJournalAtomic(layout.restoreJournal, {
                  id: chooseRestoreId(layout, new Date()),
                  snapshot: sid,
                  step: "requested",
                  requestedAt: new Date().toISOString(),
                  completedAt: null,
                });
                restoreCommitted = true;
                appendSupervisorLog(`되돌리기: 예약했다 — 스냅샷 ${sid}`);
              } catch (e) {
                pendingRestore = null;
                const opts = { type: "error" as const, message: "되돌리기를 예약하지 못했어요", detail: reasonOf(e), buttons: ["확인"], defaultId: 0, cancelId: 0 };
                void modals.track(dialog.showMessageBox(opts));
                throw e;
              }
            },
```

`quit: quitNow`를:

```ts
      quit: () => {
        if (restoreCommitted) app.relaunch();
        quitNow();
      },
```

그리고 그 `runQuitFlow(...)` 체인의 `.finally(() => { … })` 안(진입 래치를 내리는 곳)에 `if (!quitting) pendingRestore = null;`를 더한다 — 녹음 확인에서 "취소"하면 다음 ⌘Q가 되돌리기로 이어지지 않게.

- [ ] **Step 9: 실패 화면 안내** — `shellStatusOf()`의 `shellStatusFrom({ … })`에:

```ts
    restoreAvailable: (() => {
      const layout = pgLayout(app.getPath("userData"));
      return restoreMenuEnabled({
        external: currentDatabaseMode()?.kind === "external",
        restorable: restorableSnapshots(layout.snapshots, PG_MAJOR),
        journalPresent: readJournal(layout.restoreJournal).kind !== "none",
      });
    })(),
```

- [ ] **Step 10: 마이그레이션 게이트에 세대 연결** — API 스펙 조립부에서 `runMigrationGate`에 넘기는 deps(`grep -n "runMigrationGate\|MigrationGateDeps" src/main.ts src/services/api.ts`)에 `generation: () => readGeneration(layout.generationFile)?.snapshot ?? null`을 더한다. 게이트 deps를 `api.ts`가 조립하면 `api.ts`의 deps 타입에 선택 필드로 통과시킨다.

- [ ] **Step 11: 컴파일·테스트·lint** —

```bash
pnpm --filter damwha-desktop exec tsc --noEmit -p tsconfig.json
pnpm --filter damwha-desktop exec vitest run
pnpm lint
```

Expected: 타입 오류 0, 테스트 전부 PASS, lint 0 error. `pnpm lint`가 desktop을 덮지 않으면 `pnpm --filter damwha-desktop run lint`도 돌린다(`grep -n '"lint"' desktop/package.json`).

- [ ] **Step 12: dev 기동 연기 확인** — 앱이 꺼져 있는지 `pgrep -fl "Damwha.app/Contents|Electron.app/Contents/MacOS/Electron|electron/cli.js|bin/postgres -D .*Damwha|damwha_worker|mlx_lm"`로 확인한 뒤 `pnpm desktop:dev`(루트)로 띄운다. **dev는 스냅샷을 뜨지 않으므로** `supervisor.log`에 스냅샷 줄이 없고, 앱 메뉴에 "업데이트 전으로 되돌리기…"가 보이며(스냅샷이 없으면 비활성), 평소처럼 회의 목록이 뜨는지만 본다. ⌘Q로 끄고 쓰는 주체가 모두 꺼졌는지 다시 확인한다. GUI 확인이 필요하면 사용자에게 요청한다.

- [ ] **Step 13: 커밋·graphify**

```bash
git add desktop/src/main.ts desktop/src/services/api.ts desktop/src/services/postgres/service.ts desktop/tests/services/postgres/service.test.ts
git commit -m "feat(desktop): 데이터 가드·되돌리기 흐름을 main에 배선한다

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
(cd /Users/jason/projects/Damwha2 && graphify update .)
```

(`api.ts`를 바꾸지 않았으면 add에서 뺀다.)

---

### Task 9: 수동 절차 문서와 `desktop/CLAUDE.md`

**Files:**
- Create: `docs/RESTORE.md`
- Modify: `desktop/CLAUDE.md` ("데이터 위치" 표, "지키는 것", 새 절 "업데이트 전 스냅샷·되돌리기")

- [ ] **Step 1: `docs/RESTORE.md` 작성**:

````markdown
# 업데이트 전 데이터로 되돌리기 — 수동 절차

앱 메뉴 **업데이트 전으로 되돌리기…**를 쓸 수 없을 때(창이 뜨지 않음, 토큰 입력 창에서 막힘 등)의 절차다.
앱은 0.4.0부터 판이 바뀔 때마다 `snapshots/` 아래에 업데이트 직전 데이터를 떠 둔다.

데이터 폴더: `~/Library/Application Support/Damwha` (아래에서 `$D`)

```bash
D="$HOME/Library/Application Support/Damwha"
```

## 1. 앱과 관련 프로세스를 모두 끈다

```bash
pgrep -fl "Damwha.app/Contents|bin/postgres -D .*Damwha|damwha_worker|mlx_lm"
```

아무것도 나오지 않아야 한다. 앱이 떠 있으면 종료한다. 데이터베이스(`bin/postgres`)만 남았으면:

```bash
"/Applications/Damwha.app/Contents/Resources/postgres/bin/pg_ctl" -D "$D/data/postgres" -m fast stop
```

**`kill -9`로 데이터베이스를 끄지 않는다.**

## 2. 되돌릴 스냅샷을 고른다

```bash
for m in "$D"/snapshots/*/manifest.json; do echo "$m"; cat "$m"; echo; done
```

`fromBuild`는 업데이트 전 판, `toBuild`는 업데이트한 판, `createdAt`은 뜬 시각이다.

## 3. 지금 데이터를 옆으로 옮기고 스냅샷을 들여놓는다

```bash
SID=20260924T084933Z          # 2에서 고른 id
mv "$D/data" "$D/data.replaced-manual-$(date +%Y%m%d%H%M%S)"
cp -c -R "$D/snapshots/$SID/data" "$D/data"
```

`cp -c`는 복사본을 거의 공간 없이 만든다. 옮겨 둔 `data.replaced-…`는 지우지 않는 한 그대로 남는다.
`restore-journal.json`이 있으면 지운다(앱의 되돌리기가 중간에 멈췄던 흔적이다 — 이 절차가 그 일을 대신했다):

```bash
rm -f "$D/restore-journal.json"
```

## 4. 이전 판을 설치하고 연다

[릴리스 페이지](https://github.com/Yjason-K/Damwha/releases)에서 `fromBuild`의 판을 받아 설치한다.

## 최후 수단 — 스냅샷이 없고 덤프만 있을 때

`backups/*-before-*.dump`는 데이터베이스만 담는다. **녹음 파일은 담지 않는다.** 복원하면 회의 번호가
덤프 시점으로 되돌아가므로, 그 뒤에 생긴 녹음 폴더를 먼저 옮겨야 새 회의가 그 파일을 덮지 않는다.

```bash
mkdir -p "$D/storage-after-dump"
# 덤프 뒤에 생긴 회의 폴더(meetings/mtg_N)를 옮긴다 — 어느 것이 뒤에 생겼는지 모르면 전부 옮긴다
mv "$D/data/storage/meetings/"* "$D/storage-after-dump/" 2>/dev/null
B=/Applications/Damwha.app/Contents/Resources/postgres/bin
SQL="$HOME/damwha-restore-$(date +%Y%m%d%H%M%S).sql"
# 먼저 SQL 파일을 만들고 성공했는지 확인한다. 파이프로 바로 넘기면 pg_restore가 도중에 실패해도 psql이 잘린 입력을
# 커밋할 수 있다 — 그러면 스키마만 지워진 채로 남는다.
{ echo "drop schema public cascade; create schema public authorization pg_database_owner; grant usage on schema public to public;";
  "$B/pg_restore" -f - "$D/backups/<파일>.dump" || { echo "pg_restore 실패" >&2; exit 1; }; } > "$SQL" && echo "SQL 준비됨: $SQL"
"$B/pg_ctl" -D "$D/data/postgres" -o "-c listen_addresses= -c unix_socket_directories=$D/run" -w start
"$B/psql" -h "$D/run" -U damwha damwha -X -q -1 -v ON_ERROR_STOP=1 -f "$SQL"
"$B/pg_ctl" -D "$D/data/postgres" -m fast stop
```

"SQL 준비됨"이 찍히지 않았으면 멈춘다. `psql -1 -f`는 파일 전체를 한 트랜잭션으로 돌려, 도중에 실패하면 아무것도 바뀌지 않는다. 이 방식은 데이터베이스와 짝 표시를 그대로 둔다
(`DROP DATABASE`로 지우고 다시 만들면 앱이 "다시 만든 데이터베이스"로 보고 기동을 거부한다).
````

- [ ] **Step 2: `desktop/CLAUDE.md` 갱신**:
  1. "데이터 위치" 표에 행 추가: `data/.damwha-generation`(이 data/를 마지막으로 연 packaged 빌드, 되돌리기가 함께 되감는다), `snapshots/`(판올림 스냅샷, 최근 2개), `restore-journal.json`(되돌리기 진행 상태), `restore-staging/`(교체용 임시 사본), `data.replaced-*`(되돌리기가 옮겨 둔 그때의 data/ — **앱은 지우지 않는다**).
  2. "지키는 것"의 "앱이 지우는 것은 넷뿐" 줄을: "앱이 지우는 것은 데이터 영역(`data/`·`snapshots/`·`backups/`·`restore-staging/`)에서 일곱 가지뿐 — `data/postgres.initdb-*`, 증명한 낡은 락, 5개 초과 백업(+sidecar, 단 세대별 첫 덤프는 고정), `*.dump.partial`, 보존 상한(2)을 넘은 완료 스냅샷, 미완료 스냅샷, `restore-staging/<rid>`. `data.replaced-*`는 지우지 않는다."
  3. `manual` 실패 줄에 `writersAlive`·`snapshotFailed`·`restoreIncomplete`·`restoreJournalUnreadable`을 더하고, 감독자 없는 실패도 창 재열기로 재시도하지 않는다(`lastStartFailure`)를 적는다.
  4. 새 절 `## 업데이트 전 스냅샷·되돌리기 (Phase 6b-2)` — 다섯 줄 이내로: 데이터 가드의 위치(첫 기동 `reapBeforeStart` 뒤·"다시 시도"의 `existing.retry()` 전), packaged만 스냅샷(빌드 식별자 `Resources/build-info.json` vs `data/.damwha-generation`), clone은 `/bin/cp -c -R`(Node `fs.cp`는 clone하지 않는다), 되돌리기는 메뉴 → commit에서 저널 → relaunch → 가드가 교체 → 보류 대화상자, 실측용 env `DAMWHA_RESTORE_PAUSE_AFTER_STEP`, 수동 절차 `docs/RESTORE.md`. 스펙 링크.

- [ ] **Step 3: 커밋**

```bash
git add docs/RESTORE.md desktop/CLAUDE.md
git commit -m "docs(phase6b): 되돌리기 수동 절차와 desktop 계약을 적는다

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 10: 변이 검증

**Files:**
- Create: `docs/superpowers/reports/2026-09-24-electron-phase-6b-restore-mutations.md`

각 변이는 **한 줄만** 바꾸고, 지정한 테스트 파일을 돌려 **빨간불**을 확인한 뒤 `git checkout -- <file>`로 되돌린다. 초록불로 살아남으면 그 판정을 지키는 테스트가 없다는 뜻이다 — 테스트를 더하고(해당 Task 파일에) 다시 돌린다. 동치 변이는 이유를 적는다.

| # | 파일 | 변이 | 빨개야 할 테스트 |
| --- | --- | --- | --- |
| M1 | `process/clone.ts` | `if (occupied(dst)) throw …` 줄 삭제 | `tests/process/clone.test.ts` |
| M2 | `services/postgres/generation.ts` | `needsSnapshot`의 `if (!i.packaged …) return false;`를 `return true` 없이 삭제 | `tests/services/postgres/generation.test.ts` |
| M3 | `services/postgres/snapshot.ts` | `findUnrecorded`의 `&& s.manifest.fromRecord === fromRecord` 삭제 | `tests/services/postgres/snapshot.test.ts` |
| M4 | `services/postgres/snapshot.ts` | `pruneSnapshots`의 `if (protect.has(s.id)) continue;` 삭제 | `tests/services/postgres/snapshot.test.ts` |
| M5 | `services/postgres/snapshot.ts` | `takeSnapshot`의 `readControldata(path.join(copy, "postgres"))`를 `readControldata(d.layout.pgdata)`로 | `tests/services/postgres/snapshot.test.ts` |
| M6 | `services/postgres/snapshot.ts` | `catch`의 `removeDir(partial, …)` 삭제 | `tests/services/postgres/snapshot.test.ts` |
| M7 | `services/postgres/restore-journal.ts` | `staged`의 `else if (!(!D && R && S)) throw …`를 삭제 | `tests/services/postgres/restore-journal.test.ts` |
| M8 | `services/postgres/restore-journal.ts` | `moved-aside`의 `verifyIdentity` 검사 삭제 | `tests/services/postgres/restore-journal.test.ts` |
| M9 | `services/postgres/restore-journal.ts` | `markRestored();` 삭제 | `tests/services/postgres/restore-journal.test.ts`, `tests/app/data-guard.test.ts` |
| M10 | `services/postgres/restore-journal.ts` | `requested`의 `catch` 안 `removeJournal(...)` 삭제 | `tests/services/postgres/restore-journal.test.ts` |
| M11 | `app/data-guard.ts` | 저널 처리 블록(`if (jr.kind === "ok") { … }`)을 판정표 1 **뒤**로 옮김 | `tests/app/data-guard.test.ts` |
| M12 | `app/data-guard.ts` | `if (decision.kind !== "start") return …` 삭제 | `tests/app/data-guard.test.ts` |
| M13 | `app/data-guard.ts` | `writeGenerationAtomic(...)`을 `takeSnapshot` **앞**으로 옮김 | `tests/app/data-guard.test.ts` |
| M14 | `app/reap-on-start.ts` | `if (alive.length > 0) throw …` 삭제 | `tests/app/reap-on-start.test.ts` |
| M15 | `services/postgres/migration-gate.ts` | `candidates = dumps.filter((n) => !pinned.has(n))`를 `candidates = dumps`로 | `tests/services/postgres/migration-gate.test.ts` |
| M16 | `services/postgres/migration-gate.ts` | `if (fs.existsSync(path.join(deps.layout.snapshots, gen)))` 조건을 `if (true)`로 | `tests/services/postgres/migration-gate.test.ts` |
| M17 | `app/quit-flow.ts` | commit `catch`의 `return;` 삭제 | `tests/app/quit-flow.test.ts` |
| M18 | `app/restore-flow.ts` | `confirmRestoreDialog`의 `cancelId: buttons.length - 1`을 `cancelId: 0`으로 | `tests/app/restore-flow.test.ts` |
| M19 | `app/restore-flow.ts` | `restoreMenuEnabled`의 `!s.journalPresent &&` 삭제 | `tests/app/restore-flow.test.ts` |
| M20 | `windows/status-view.ts` | `input.restoreAvailable === true &&` 삭제 | `tests/windows/status-view.test.ts` |
| M21 | `services/postgres/service.ts` | `await deps.preLaunch?.(ctx.signal);` 삭제 | `tests/services/postgres/service.test.ts` |
| M22 | `process/orphans.ts` | `survivingOrphans`의 `&& d.exists(p.pid)` 삭제 | `tests/app/reap-on-start.test.ts` (기존 `resolves with what it reaped…`) |

- [ ] **Step 1: 변이를 차례로 돌린다** — 변이마다: 편집 → `pnpm --filter damwha-desktop exec vitest run <테스트>` → 결과(빨강/초록, 실패한 테스트 이름) 기록 → `git checkout -- <file>`.
- [ ] **Step 2: 살아남은 변이가 있으면** 테스트를 더하고 그 Task의 테스트 파일로 커밋한 뒤 그 변이만 다시 돌린다.
- [ ] **Step 3: 전체 초록 재확인** — `pnpm --filter damwha-desktop exec vitest run` → PASS, `git status --short`에 src 변경이 없어야 한다.
- [ ] **Step 4: 기록 문서 작성·커밋** — 표(M#·변이·결과·잡은 테스트 이름)와 요약("20/20 빨간불, 동치 0" 등)을 쓴다.

```bash
git add docs/superpowers/reports/2026-09-24-electron-phase-6b-restore-mutations.md
git commit -m "test(phase6b): 6b-2 변이 M1~M22를 돌려 기록한다

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 11: packaged 실측·결과 문서·로드맵 (최종 whole-branch 리뷰 뒤)

이 Task는 최종 whole-branch 리뷰가 clean이 된 뒤에 한다. GUI 조작은 **사용자**가 한다 — 실행자는 명령·확인·기록을 맡고, 각 GUI 단계 앞에서 무엇을 눌러 달라고 요청한다.

**Files:**
- Create: `docs/superpowers/reports/2026-09-24-electron-phase-6b-restore-results.md`
- Modify: `docs/electron-migration-roadmap.md` (Phase 6b 절에 6b-2 상태 문단, 완료 기준 두 번째 줄 충족 근거)

- [ ] **Step 1: 준비** — 스펙 §12.2의 "재료"와 "매 단계 전후 확인"을 따른다. 디스크 여유를 본다(`df -h ~`, 10 GB 이상이어야 빌드 산출물 1.7 GB + 사본을 감당). 앱을 끄고 `pgrep` 확인 → 현재 userData를 `models/`·Chromium 캐시를 빼고 `rsync -a --exclude models --exclude 'Cache*' --exclude 'Code Cache' --exclude GPUCache "$HOME/Library/Application Support/Damwha/" ~/damwha-6b2-before-<stamp>/`로 백업.
- [ ] **Step 2: 빌드** — `pnpm desktop package:desktop`(루트). `desktop/out/mac-arm64/Damwha.app`의 `Contents/Resources/build-info.json`을 확인하고 `check-bundle`이 통과했는지 출력을 본다.
- [ ] **Step 3: 스펙 §12.2 1~8을 순서대로 수행** — 1(준비·기준선), 2(C1), 3(새 판 회의), 4(C2·C4), 5(C3·C4), 6(C5 — `DAMWHA_RESTORE_PAUSE_AFTER_STEP=staged`와 `=moved-aside`로 각각, 앱을 터미널에서 `DAMWHA_RESTORE_PAUSE_AFTER_STEP=staged open -a /Applications/Damwha.app`이 env를 넘기지 않으면 `/Applications/Damwha.app/Contents/MacOS/Damwha`를 직접 env와 함께 실행), 7(예비), 8(C6 — 커밋 하나를 더한 빌드가 필요: 빈 커밋 `git commit --allow-empty -m "chore: 6b-2 C6 실측용 빌드 식별자"`를 만들고 재빌드, 실측 뒤 `git reset --hard HEAD~1`은 **사용자 확인 뒤에만**). 각 단계의 명령 출력(`supervisor.log` 새 줄, `manifest.json`, `pg_controldata` id, psql 기준선, 디렉터리 목록)을 결과 문서에 그대로 옮긴다.
- [ ] **Step 4: C10 수동 절차** — 스펙 §12.2 끝의 C10 절차: 복구 전에 userData를 한 번 더 복사하고, `docs/RESTORE.md`를 글자 그대로 따라 해 0.3.1 기동까지 확인한다.
- [ ] **Step 5: 복구** — 앱 종료·`pgrep` 확인 → Step 1 백업을 userData로 되돌린다(`rsync -a --delete --exclude models …`). 최신 새 빌드로 기동해 평소 상태인지 확인한다.
- [ ] **Step 6: 결과 문서** — 6b-3 결과 문서(`docs/superpowers/reports/2026-09-24-electron-phase-6b-attempts-split-results.md`)의 구성을 따른다: §0 전 패키지 초록, §1 변이(Task 10 문서 링크), §2 완료 기준 판정표(C1~C11), §3 실측 기록(단계별), §4 관찰, §5 최종 리뷰와 수정, §6 남은 일.
- [ ] **Step 7: 로드맵** — Phase 6b 절의 6b-3 상태 문단 뒤에 `**상태 (2026-09-2x): 6b-2 완료 — …**` 문단(스펙·결과 링크, 브랜치, 완료 기준 요약)을 넣고, "업데이트 실패 시 정의된 복구 절차로 데이터와 실행 상태 복구 가능" 기준의 충족 근거(C2·C5·C10)를 적는다. "0.4.0은 6b-2까지 병합된 뒤에 낸다"를 "이제 낼 수 있다"로 갱신한다.
- [ ] **Step 8: 커밋**

```bash
git add docs/superpowers/reports/2026-09-24-electron-phase-6b-restore-results.md docs/electron-migration-roadmap.md
git commit -m "docs(phase6b): 6b-2 packaged 실측 결과를 기록하고 로드맵을 갱신한다

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```
