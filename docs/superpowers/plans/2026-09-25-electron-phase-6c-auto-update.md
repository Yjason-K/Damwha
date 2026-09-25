# Electron Phase 6c — 앱 안에서 받아 설치하는 업데이트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 새 버전 알림에서 "다운로드 후 설치"로 zip을 캐시에 받아 두고, "재시작하여 업데이트"를 누르면 기존 종료 흐름을 끝까지 탄 뒤 Squirrel.Mac이 앱을 새 판으로 바꿔 다시 띄운다.

**Architecture:** 판정은 전부 `desktop/src/update/`·`desktop/src/app/`의 순수 모듈(electron 값 import 없음)에 두고 잎만 주입한다 — 6b-1·6b-2와 같은 나눔. electron-updater와 내장 `autoUpdater`에 닿는 잎은 `desktop/src/platform/updater-port.ts` 하나에 모은다. 상태 기계(`install-flow.ts`)가 `resolving → downloading → downloaded → committing → staging → installing`을 소유하고, 종료 흐름(`quit-flow.ts`)은 결과(`QuitOutcome`)를 마지막 잎 `finish`에 넘겨 설치 여부를 main이 고르게 한다. 발행은 `package.mjs --release`가 zip·blockmap·`latest-mac.yml`을 만들고 `publish.sh`가 draft로 올려 검증한 뒤 공개한다.

**Tech Stack:** Electron(Task 1이 정하는 판, 현재 44.3.0), electron-updater 6.8.9(정확한 버전), TypeScript 5.9 (CommonJS), vitest 4, Node 22, bash, `gh`.

**Spec:** `docs/superpowers/specs/2026-09-25-electron-phase-6c-auto-update-design.md` (2판) — 계획은 스펙을 근거로 한다. 실행자는 둘 다 읽는다. 스펙의 절 번호(§)를 그대로 쓴다.

## Global Constraints

- **착수 조건(스펙 §4)이 채워지기 전에는 Task 2 이후를 시작하지 않는다.** Task 1 Step 1이 exit 0이어야 한다.
- Squirrel.Mac 수정 커밋: `5c9e2133c09d6f8e2e3c5a45c5b0ffc00448c58a`. 판정: 채택할 Electron 태그의 DEPS 핀과의 compare가 `ahead` 또는 `identical`.
- 새 런타임 의존성은 `electron-updater` **하나, 정확히 `6.8.9`**(`^` 없음). 그 밖의 새 의존성 없음(YAML 라이브러리·semver 금지).
- electron-updater 설정: `autoDownload = false`, `autoInstallOnAppQuit = false`, `allowDowngrade = false`.
- 런타임 feed: `{ provider: "generic", url: "https://github.com/<repo>/releases/download/<tag>/", useMultipleRangeRequest: false }`. `<repo>` 기본 `Yjason-K/Damwha`.
- 캐시 이름 `damwha-desktop-updater` → `~/Library/Caches/damwha-desktop-updater/{pending/, update.zip}`. `Resources/app-update.yml`에 `updaterCacheDirName: damwha-desktop-updater`.
- 설치 시도 기록 `<userData>/install-attempt.json`. 6b-1의 `update-state.json`과 섞지 않는다.
- 발행 자산 5개: `Damwha-<ver>-arm64.dmg`, `Damwha-<ver>-arm64.dmg.sha256`, `Damwha-<ver>-arm64-mac.zip`, `Damwha-<ver>-arm64-mac.zip.blockmap`, `latest-mac.yml`.
- `latest-mac.yml`의 Damwha 필드: `damwhaBuildId`(`<ver>+<12자리 커밋>`), `damwhaMinMacos`(= `LSMinimumSystemVersion`), `damwhaAppSize`(바이트). electron-updater의 `minimumSystemVersion`은 쓰지 않는다.
- 새 버전 대화상자(자동 설치 가능): 버튼 `["다운로드 후 설치", "나중에", "이 버전 건너뛰기"]`, `defaultId: 0`, `cancelId: 1`. 불가능하면 6b-1 그대로.
- 받음 대화상자: 버튼 `["재시작하여 업데이트", "나중에"]`, `defaultId: 0`, `cancelId: 1`.
- 시간 상한: `STAGING_TIMEOUT_MS = 600_000`, `INSTALL_QUIT_TIMEOUT_MS = 30_000`(Task 19 C10 실측으로 조정). 디스크 여유 `MARGIN = 0.1`.
- `src/update/*`·`src/app/*`는 electron·electron-updater를 **값으로** import하지 않는다(`import type`만). 그 둘을 값으로 쓰는 새 코드는 `src/platform/updater-port.ts`와 `src/main.ts`뿐.
- 명령은 저장소 루트(**worktree `/Users/jason/projects/Damwha2-6c`**)에서: `pnpm desktop test`, `pnpm desktop lint`. 단일 파일은 `pnpm --filter damwha-desktop exec vitest run <path>`(경로는 `desktop/` 기준). **`pnpm desktop exec …`를 쓰지 않는다** — `run exec`로 펼쳐져 테스트 0개로 exit 0이 난다.
- `tsconfig`의 `include`는 `src/**`뿐이라 테스트는 타입 검사를 받지 않는다. 테스트의 가짜 deps는 필드를 빠뜨리지 않는다.
- 커밋 메시지 관례: `feat(desktop): …`, `test(desktop): …`, `build(desktop): …`, `build(release): …`, `docs(phase6c): …`, 한국어 본문, 끝에 세션 줄.

## Review Focus

스펙이 암시하지만 어느 Task의 기본 테스트도 직접 부르지 않는 입력 — 사람이 가장 먼저 밟을 순서. 각 줄의 테스트는 표시한 Task에 들어 있다.

1. **받는 중에 ⌘Q** — 종료 흐름이 이기고, 다음 실행에 "받는 중" 메뉴나 설치 시도 기록이 남지 않는다(Task 10 `abandon`, Task 16 `beginQuit`).
2. **메뉴와 받음 대화상자에서 "재시작하여 업데이트"를 거의 동시에 두 번** — `committing`은 한 번, `app.quit()`도 한 번(Task 10 `commit` 두 번째는 거부, Task 11 표시 잠금).
3. **받는 중(`downloading`)에 더 새 판이 조회됨** — 두 번째 작업을 시작하지 않고 안내만 한다(Task 11 `heldVersion`).
4. **받아 둔 뒤 앱을 DMG 안에서 다시 실행하거나 다른 폴더로 옮김** — `commit`의 설치 가능 재판정이 거짓 → 페이지 안내(Task 10).
5. **받는 중 네트워크가 끊겼다가 메뉴 "업데이트 확인…"으로 다시 시도** — `failed` 뒤 `start`가 새 작업 ID로 다시 돈다(Task 10).

---

## File Structure

| 파일 | 책임 |
| --- | --- |
| `desktop/scripts/check-squirrel-fix.sh` (신규) | 착수 조건 판정 — Electron 태그의 Squirrel 핀이 #335를 포함하는가 |
| `desktop/src/app/build-identity.ts` (신규) | 실행 빌드 식별자를 기동 때 고정 (§13.1) |
| `desktop/src/app/quit-flow.ts` (수정) | `runQuitFlow`가 `QuitOutcome`을 돌려주고 마지막 잎 `finish(outcome)`를 부른다 (§5.3) |
| `desktop/src/update/install-eligibility.ts` (신규) | 설치 가능 판정, `df`·`diskutil` 출력 해석 (§5.2) |
| `desktop/src/update/install-attempt.ts` (신규) | 설치 시도 기록 저장소와 다음 기동 판정 (§5.6) |
| `desktop/src/app/maintenance.ts` (신규) | 되돌리기·설치 상호 배제 예약 (§5.4) |
| `desktop/src/app/restore-flow.ts` (수정) | `restoreMenuEnabled`에 `installBlocking` |
| `desktop/src/update/release-check.ts` (수정) | 실제 태그·릴리스 ID·자동 설치 가능 여부, feed URL, macOS 비교, 저장소 env (§5.5·§6.1) |
| `desktop/src/update/manifest.ts` (신규) | electron-updater `updateInfo` → Damwha manifest 검증 (§6.2) |
| `desktop/src/update/disk-budget.ts` (신규) | 단계별 볼륨 예산 (§7) |
| `desktop/src/update/updater-cache.ts` (신규) | `pending/`만 비우는 판정 (§5.7) |
| `desktop/src/update/install-flow.ts` (신규) | 상태 기계·호출 계약·설치 경로 (§5.1·§5.3) |
| `desktop/src/update/dialogs.ts` (수정) | 새 대화상자 옵션·선택 해석 |
| `desktop/src/update/update-flow.ts` (수정) | 설치 선택·받음·실패·"더 새 판" 알림을 표시 잠금 하나로 (§5.5) |
| `desktop/src/windows/menu-template.ts` (수정) | 업데이트 메뉴 항목 |
| `desktop/src/platform/updater-port.ts` (신규) | electron-updater·내장 `autoUpdater` 잎 |
| `desktop/src/main.ts` (수정) | 배선 |
| `desktop/package.json` (수정) | `dependencies: { "electron-updater": "6.8.9" }`, Electron 판 |
| `desktop/scripts/package.mjs` (수정) | `app-update.yml`, `--publish never`, 릴리스 zip·검증·blockmap·yml·단언 (§6.2) |
| `desktop/scripts/lib/update-manifest.mjs` (신규) | yml 생성·발행 신원 단언 (순수) |
| `desktop/scripts/lib/publish-plan.mjs` (신규) | draft 재개 판정 (순수) |
| `desktop/scripts/check-bundle.mjs` (수정) | 의존성·asar 폐포·`app-update.yml` 단언 |
| `desktop/scripts/publish.sh` (수정) | 신원 재확인·draft·재개·재다운로드 검증·공개 (§6.3) |
| `desktop/tests/…` (신규·수정) | 단위 테스트 |
| `desktop/CLAUDE.md`, `docs/RESTORE.md`, `docs/electron-migration-roadmap.md` (수정) | 문서 |
| `docs/superpowers/reports/2026-09-25-electron-phase-6c-auto-update-results.md` (신규) | 변이·실측 결과 |

**스펙과 다르게 정한 것(계획 결정)** — 결과 문서에 옮긴다:

- **D1. 데이터 볼륨 몫(§7).** 스펙은 "6b-2 데이터 가드의 기존 점검을 미리 부른다"고 했으나 **데스크톱에 디스크 여유 점검이 없다**(`grep statfs|bavail desktop/src` 0건, 2026-09-25). 그래서 몫을 정의한다: `pgdata 크기`(마이그레이션 직전 `pg_dump -Fc`의 상한) + 데이터 볼륨이 APFS가 아니면 `data/` 크기(스냅샷 `cp -c`가 일반 복사로 넘어간다 — `process/clone.ts` 주석). 설치 가능 판정(§5.2)이 내장 볼륨만 받으므로 macOS 15+에서는 사실상 APFS다.
- **D2. 시험용 저장소 env.** packaged 실측(C1·C2·C9)을 공개 저장소에 시험 릴리스를 내지 않고 하려고 `DAMWHA_UPDATE_REPO`(값은 `^Yjason-K/[A-Za-z0-9._-]+$`만)로 조회·feed 저장소를 바꾼다. 6b-1의 `DAMWHA_UPDATE_CHECK_INTERVAL_MS`와 같은 개발용 손잡이다. 서명 검증(Squirrel의 designated requirement)은 저장소와 무관하게 그대로다.
- **D3. 시간 상한 초기값.** `STAGING_TIMEOUT_MS = 600_000`, `INSTALL_QUIT_TIMEOUT_MS = 30_000`. C10 실측으로 조정한다(값만 바꾸고 결과 문서에 근거를 적는다).

---

### Task 1: 착수 조건 판정과 Electron 업그레이드

**Files:**
- Create: `desktop/scripts/check-squirrel-fix.sh`
- Modify: `desktop/package.json` (`devDependencies.electron`)
- Modify: `pnpm-lock.yaml` (자동)

**Interfaces:**
- Produces: 이후 모든 Task가 쓰는 Electron 판. `bash desktop/scripts/check-squirrel-fix.sh <tag>` — 포함이면 exit 0.

- [ ] **Step 1: 판정 스크립트를 쓰고 후보 태그로 돌린다**

`desktop/scripts/check-squirrel-fix.sh`:

```bash
#!/bin/bash
# desktop/scripts/check-squirrel-fix.sh <electron-tag>
#
# Phase 6c 착수 조건(스펙 §4). 그 Electron 판이 고정한 Squirrel.Mac이 PR #335(설치 중단이 앱을 망가뜨리는 결함의
# 수정, 병합 커밋 5c9e2133)를 포함하는가. 판 번호가 아니라 커밋 포함 여부로 본다 — 2026-09-25에는 v44.4.5도
# v45.0.0-alpha.12도 포함하지 않았다.
set -euo pipefail
FIX=5c9e2133c09d6f8e2e3c5a45c5b0ffc00448c58a
TAG="${1:?사용: check-squirrel-fix.sh <electron-tag>}"
PIN=$(curl -fsSL "https://raw.githubusercontent.com/electron/electron/${TAG}/DEPS" \
  | grep -A1 "'squirrel.mac_version'" | tail -1 | tr -d " ',")
[[ "$PIN" =~ ^[0-9a-f]{40}$ ]] || { echo "DEPS에서 squirrel.mac_version을 못 찾음: '${PIN}'" >&2; exit 1; }
STATUS=$(gh api "repos/Squirrel/Squirrel.Mac/compare/${FIX}...${PIN}" --jq .status)
case "$STATUS" in
  ahead|identical) echo "OK ${TAG} → ${PIN} (${STATUS})" ;;
  *) echo "미포함 ${TAG} → ${PIN} (${STATUS})" >&2; exit 1 ;;
esac
```

후보는 최신 안정판부터 본다:

```bash
chmod +x desktop/scripts/check-squirrel-fix.sh
gh api "repos/electron/electron/releases?per_page=30" --jq '.[] | select(.prerelease==false) | .tag_name' | head -5
bash desktop/scripts/check-squirrel-fix.sh <위 목록의 첫 태그>
```

Expected: `OK <tag> → <pin> (ahead)` 그리고 exit 0.
**exit 1이면 여기서 멈추고 사용자에게 보고한다.** 이 Phase는 착수하지 않는다(스펙 §4). prerelease를 쓰지 않는다.

- [ ] **Step 2: 그 판에서도 `quitAndInstall`의 "창이 없으면 즉시" 경로가 그대로인지 소스로 확인한다**

```bash
curl -fsSL "https://raw.githubusercontent.com/electron/electron/<tag>/shell/browser/api/electron_api_auto_updater.cc" \
  | grep -n -A12 "void AutoUpdater::QuitAndInstall"
```

Expected: `if (WindowList::IsEmpty())` 뒤에 `auto_updater::AutoUpdater::QuitAndInstall();`가 있다(스펙 §3.1 S3의 전제). 없으면 멈추고 보고한다 — §5.3의 창 `destroy()` 전략이 성립하지 않는다.

- [ ] **Step 3: Electron을 올린다**

`desktop/package.json`의 `"electron": "44.3.0"`을 Step 1의 태그에서 `v`를 뗀 정확한 버전으로 바꾼다(`^` 없음). 그리고:

```bash
pnpm install
pnpm --filter damwha-desktop exec electron --version
```

Expected: 새 버전 문자열.

- [ ] **Step 4: 전 패키지 회귀**

```bash
pnpm desktop lint && pnpm desktop test && pnpm fe test && pnpm worker:test
pnpm be test
```

Expected: 전부 초록. `be`는 testcontainers 포트(`No host port found`)·`socket hang up` 플레이크가 알려져 있다(로드맵 Phase 6b 절 v0.4.0 상태) — 실패하면 실패한 파일만 `pnpm --filter damwha-be exec jest <file>`로 다시 돌려 초록인지 본다. 단언 실패면 멈춘다.

- [ ] **Step 5: packaged 회귀**

```bash
pnpm desktop:build
```

Expected: `Bundle hygiene: all checks passed.` 그 뒤 사람과 함께 `desktop/out/mac-arm64/Damwha.app`을 띄워: 상태 창에서 네 서비스 `준비됨`, 회의 목록·전사·검색 화면, 짧은 오디오 하나 업로드 → `done`, ⌘Q가 확인 없이 끝남(진행 중 없음). 앱 메뉴 "업데이트 확인…"이 "최신 버전을 쓰고 있어요" 또는 새 버전 대화상자를 띄움. 하나라도 어긋나면 멈추고 보고한다.

- [ ] **Step 6: 호출 계약 실측 — 버리는 앱으로 §5.1의 순서 그대로**

스파이크(스펙 §3.1)는 `autoInstallOnAppQuit=true` 경로에서 준비를 electron-updater에 맡겼다. 이 계획의 순서 —
`autoInstallOnAppQuit=false`로 받기만 하고, **우리가** 내장 `autoUpdater.checkForUpdates()`로 준비시킨 뒤 창 `destroy()` →
내장 `quitAndInstall()` — 은 아직 아무도 돌려 보지 않았다(코덱스 R3: "MacUpdater 내부 proxy 동작에 의존"). 새 Electron 판에서
확인한다. **저장소 밖**(scratchpad)에서 하고 코드는 버린다. 실데이터와 섞이지 않게 번들 ID를 다르게 한다.

```bash
S=$(mktemp -d)/c6-contract && mkdir -p "$S/app" && cd "$S/app"
cat > package.json <<'EOF'
{ "name": "c6-contract", "productName": "C6Contract", "version": "1.0.0", "main": "main.js", "author": "spike",
  "dependencies": { "electron-updater": "6.8.9" },
  "devDependencies": { "electron": "<Step 3의 버전>", "electron-builder": "26.15.3" } }
EOF
printf 'node-linker=hoisted\n' > .npmrc
pnpm install --ignore-workspace
cp /Users/jason/projects/Damwha2-6c/desktop/build-resources/entitlements.mac.plist .
cat > builder.json <<'EOF'
{ "appId": "kr.damwha.c6contract", "files": ["main.js", "package.json"],
  "mac": { "target": ["zip"], "identity": "C35965CC0997E3897DED5C0975B4064D8AA4E27A", "hardenedRuntime": true,
           "entitlements": "entitlements.mac.plist", "entitlementsInherit": "entitlements.mac.plist", "notarize": false },
  "publish": { "provider": "generic", "url": "http://127.0.0.1:8765/" } }
EOF
cat > main.js <<EOF
// 버리는 코드 — Phase 6c 계획 Task 1 Step 6. install-flow.ts의 호출 계약을 그대로 따른다.
const { app, BrowserWindow, autoUpdater: native } = require("electron");
const { autoUpdater: updater } = require("electron-updater");
const fs = require("fs");
const LOG = "$S/contract.log";
const log = (m) => fs.appendFileSync(LOG, new Date().toISOString() + " [" + app.getVersion() + "] " + m + "\n");
let allowed = false;
app.on("before-quit", (e) => { if (allowed) return; e.preventDefault(); log("before-quit 막음"); });
app.whenReady().then(async () => {
  log("started");
  const w = new BrowserWindow({ width: 200, height: 100 });
  w.on("close", (e) => { log("close 핸들러 불림 — 계약 위반"); e.preventDefault(); });
  if (process.argv.includes("--done")) { setTimeout(() => { allowed = true; w.destroy(); app.quit(); }, 2000); return; }
  updater.autoDownload = false; updater.autoInstallOnAppQuit = false; updater.allowDowngrade = false;
  updater.on("error", (e) => log("updater error " + e.message));
  updater.setFeedURL({ provider: "generic", url: "http://127.0.0.1:8765/", useMultipleRangeRequest: false });
  const r = await updater.checkForUpdates();
  log("resolve available=" + r.isUpdateAvailable + " version=" + r.updateInfo.version);
  await updater.downloadUpdate();
  log("downloaded (electron-updater) — 네이티브 준비는 아직");
  await new Promise((res, rej) => { native.once("update-downloaded", res); native.once("error", rej); native.checkForUpdates(); });
  log("staged (native update-downloaded)");
  for (const x of BrowserWindow.getAllWindows()) x.destroy();
  allowed = true;
  native.quitAndInstall();
  log("quitAndInstall 불림");
});
EOF
npx electron-builder --mac --arm64 -c builder.json -c.directories.output=out-100 --publish never
sed -i '' 's/"version": "1.0.0"/"version": "1.0.1"/' package.json
sed -i '' 's/process.argv.includes("--done")/(process.argv.includes("--done") || app.getVersion() === "1.0.1")/' main.js
npx electron-builder --mac --arm64 -c builder.json -c.directories.output=out-101 --publish never
(cd out-101 && python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &) ; sleep 1
mkdir -p "$S/install" && ditto out-100/mac-arm64/C6Contract.app "$S/install/C6Contract.app"
for i in 1 2 3; do
  rm -rf ~/Library/Caches/c6-contract-updater "$S/install/C6Contract.app" && ditto out-100/mac-arm64/C6Contract.app "$S/install/C6Contract.app"
  : > "$S/contract.log"; open "$S/install/C6Contract.app"; sleep 25
  echo "run $i: $(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$S/install/C6Contract.app/Contents/Info.plist")"
  cat "$S/contract.log"; pkill -f C6Contract.app || true; sleep 1
done
pkill -f "http.server 8765"; codesign --verify --deep --strict "$S/install/C6Contract.app" && echo codesign OK
rm -rf ~/Library/Caches/c6-contract-updater ~/Library/Caches/kr.damwha.c6contract.ShipIt "$S"
```

Expected: 세 번 모두 `run N: 1.0.1`, 로그에 `resolve available=true version=1.0.1` → `downloaded` → `staged` → `quitAndInstall 불림` → `[1.0.1] started`, **`close 핸들러 불림`이 없다**, `codesign OK`. 하나라도 어긋나면 멈추고 로그를 붙여 보고한다 — §5.1 호출 계약이 성립하지 않는다는 뜻이다. 로그를 결과 문서 초안(Task 19)에 붙인다.

- [ ] **Step 7: Commit**

```bash
git add desktop/scripts/check-squirrel-fix.sh desktop/package.json pnpm-lock.yaml
git commit -m "build(desktop): Electron <ver> — Squirrel.Mac #335를 포함하는 판으로 올린다

착수 조건(Phase 6c 스펙 §4)을 check-squirrel-fix.sh로 판정했다: <tag> → <pin> (ahead).
quitAndInstall의 창 없는 즉시 경로도 그 판 소스에서 확인했다.

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 2: 실행 빌드 식별자를 기동 때 고정 (§13.1)

**Files:**
- Create: `desktop/src/app/build-identity.ts`
- Modify: `desktop/src/main.ts:260-268` (`currentBuildId`), `desktop/src/main.ts:~1410` (`runDataGuard` 호출부)
- Test: `desktop/tests/app/build-identity.test.ts`

**Interfaces:**
- Produces: `createBuildIdentity(read: () => string | null): BuildIdentity`, `BuildIdentity.running(): string | null`, `BuildIdentity.changedOnDisk(): boolean`. main에서 `buildIdentity` 전역.

- [ ] **Step 1: Write the failing test**

`desktop/tests/app/build-identity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createBuildIdentity } from "../../src/app/build-identity";

describe("createBuildIdentity", () => {
  it("reads once and keeps the first value even if the disk changes", () => {
    const values = ["0.5.0+aaaaaaaaaaaa", "0.6.0+bbbbbbbbbbbb"];
    let reads = 0;
    const id = createBuildIdentity(() => values[Math.min(reads++, 1)]);
    expect(id.running()).toBe("0.5.0+aaaaaaaaaaaa");
    expect(id.running()).toBe("0.5.0+aaaaaaaaaaaa");
    expect(reads).toBe(1);
  });

  it("reports a change on disk against the pinned value", () => {
    let disk: string | null = "0.5.0+aaaaaaaaaaaa";
    const id = createBuildIdentity(() => disk);
    expect(id.changedOnDisk()).toBe(false);
    disk = "0.6.0+bbbbbbbbbbbb";
    expect(id.changedOnDisk()).toBe(true);
    expect(id.running()).toBe("0.5.0+aaaaaaaaaaaa");
  });

  it("never reports a change when either side is unknown", () => {
    let disk: string | null = null;
    const id = createBuildIdentity(() => disk);
    expect(id.running()).toBeNull();
    disk = "0.6.0+bbbbbbbbbbbb";
    expect(id.changedOnDisk()).toBe(false);

    let later: string | null = "0.5.0+aaaaaaaaaaaa";
    const id2 = createBuildIdentity(() => later);
    id2.running();
    later = null;
    expect(id2.changedOnDisk()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter damwha-desktop exec vitest run tests/app/build-identity.test.ts`
Expected: FAIL — `Cannot find module '../../src/app/build-identity'`.

- [ ] **Step 3: Write minimal implementation**

`desktop/src/app/build-identity.ts`:

```ts
/**
 * 실행 중인 빌드의 식별자 (Phase 6c 스펙 §13.1). electron을 import하지 않는다.
 *
 * **기동 때 한 번 읽어 고정한다.** 실행 중 `.app`이 바뀌면(사람의 수동 설치, 6c 뒤로는 ShipIt) 디스크의
 * `build-info.json`은 새 판을 말하지만 이 프로세스의 JS는 옛 판이다. 매번 다시 읽으면 데이터 가드가 옛 코드로
 * 새 빌드 식별자를 generation에 기록한다 — 다음 기동이 판올림을 못 알아채 스냅샷 없이 마이그레이션한다.
 */
export interface BuildIdentity {
  /** 처음 부를 때 읽고 그 뒤로는 같은 값. dev·읽기 실패면 null. */
  running(): string | null;
  /** 디스크 값이 지금 running()과 다른가. 둘 중 하나라도 null이면 false. */
  changedOnDisk(): boolean;
}

export function createBuildIdentity(read: () => string | null): BuildIdentity {
  let pinned: { value: string | null } | null = null;
  const running = (): string | null => {
    if (pinned === null) pinned = { value: read() };
    return pinned.value;
  };
  return {
    running,
    changedOnDisk() {
      const now = running();
      if (now === null) return false;
      const disk = read();
      return disk !== null && disk !== now;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter damwha-desktop exec vitest run tests/app/build-identity.test.ts`
Expected: PASS (3).

- [ ] **Step 5: main.ts를 고정값으로 바꾼다**

`desktop/src/main.ts`에서 `function currentBuildId(): string | null { … }`(260~268줄)를 아래로 바꾼다:

```ts
/** 디스크의 build-info.json. 기동 고정은 buildIdentity가 한다 (Phase 6c 스펙 §13.1). */
function readBuildIdFromDisk(): string | null {
  if (!app.isPackaged) return null;
  try {
    const info = parseBuildInfo(fs.readFileSync(path.join(process.resourcesPath, "build-info.json"), "utf8"));
    return info === null ? null : buildIdOf(info);
  } catch {
    return null;
  }
}
const buildIdentity = createBuildIdentity(readBuildIdFromDisk);

function currentBuildId(): string | null {
  return buildIdentity.running();
}
```

import 추가: `import { createBuildIdentity } from "./app/build-identity";`

`app.whenReady().then(async () => {` 블록의 **첫 줄**에 `buildIdentity.running();`을 넣어 기동 시점에 고정한다(주석: `// 기동 시점의 빌드를 고정한다 — 뒤에서 처음 읽으면 그 사이 교체된 판을 읽을 수 있다.`).

`runDataGuard(` 호출(약 1410줄) 바로 앞에:

```ts
    if (buildIdentity.changedOnDisk()) {
      appendSupervisorLog("앱 파일이 실행 중에 바뀌었어요 — 새 판은 앱을 다시 시작해야 적용돼요.");
    }
```

- [ ] **Step 6: 전체 확인**

Run: `pnpm desktop lint && pnpm desktop test`
Expected: 초록.

- [ ] **Step 7: Commit**

```bash
git add desktop/src/app/build-identity.ts desktop/tests/app/build-identity.test.ts desktop/src/main.ts
git commit -m "fix(desktop): 실행 빌드 식별자를 기동 때 고정한다

currentBuildId()가 호출마다 build-info.json을 다시 읽어, 실행 중 앱이 바뀌면 옛 코드가 새 빌드
식별자로 generation을 기록할 수 있었다(Phase 6c 스펙 §13.1).

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 3: 종료 흐름이 결과를 돌려준다 (§5.3)

**Files:**
- Modify: `desktop/src/app/quit-flow.ts` (`QuitFlowDeps.quit` → `finish`, `runQuitFlow` 반환)
- Modify: `desktop/src/main.ts` (before-quit의 `quit:` 잎 → `finish:`)
- Test: `desktop/tests/app/quit-flow.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type QuitOutcome = { kind: "cancelled" } | { kind: "prepared" } | { kind: "cleanup-failed" };
  export type FinishOutcome = Exclude<QuitOutcome, { kind: "cancelled" }>;
  QuitFlowDeps.finish(outcome: FinishOutcome): void | Promise<void>;
  runQuitFlow(deps: QuitFlowDeps): Promise<QuitOutcome>;
  ```

- [ ] **Step 1: recorder를 새 계약으로 바꾸고 실패하는 테스트를 더한다**

`desktop/tests/app/quit-flow.test.ts`의 `recorder`에서 `quit: () => log.push("quit"),`(72줄)를 아래로 바꾸고, 반환에 `finished`를 더한다:

```ts
    finish: (outcome) => {
      finished.push(outcome);
      log.push("quit");
    },
```

`recorder` 함수 첫머리에 `const finished: Array<{ kind: string }> = [];`를 두고 `return { log, lines, warned, asked, deps, finished };`로 바꾼다. 기존 테스트의 `"quit"` 단언은 그대로 유효하다.

`describe("runQuitFlow", …)` 안 끝에 더한다:

```ts
  describe("outcome (Phase 6c §5.3)", () => {
    it("returns cancelled and never finishes when the person cancels", async () => {
      const { deps, finished } = recorder({ confirm: async () => false }, { recording: true, analysing: false });
      await expect(runQuitFlow(deps)).resolves.toEqual({ kind: "cancelled" });
      expect(finished).toEqual([]);
    });

    it("returns cancelled and never finishes when commit throws", async () => {
      const { deps, finished } = recorder({
        commit: async () => {
          throw new Error("저널을 못 썼다");
        },
      });
      await expect(runQuitFlow(deps)).resolves.toEqual({ kind: "cancelled" });
      expect(finished).toEqual([]);
    });

    it("finishes with prepared only when the services reported stopped:true", async () => {
      const { deps, finished } = recorder();
      await expect(runQuitFlow(deps)).resolves.toEqual({ kind: "prepared" });
      expect(finished).toEqual([{ kind: "prepared" }]);
    });

    it("treats stopped:false with nothing leaked as cleanup-failed", async () => {
      // `{stopped:false, leaked:[]}`는 "깨끗한지 증명하지 못한 것"이다 — 설치로 가면 안 된다.
      const { deps, finished } = recorder({
        stopServices: async () => ({ stopped: false, leaked: [], detail: STOP_DETAIL.orphans }),
      });
      await expect(runQuitFlow(deps)).resolves.toEqual({ kind: "cleanup-failed" });
      expect(finished).toEqual([{ kind: "cleanup-failed" }]);
    });

    it("finishes with cleanup-failed and still rejects when stopping throws", async () => {
      const boom = new Error("감독자가 터졌다");
      const { deps, finished } = recorder({
        stopServices: async () => {
          throw boom;
        },
      });
      await expect(runQuitFlow(deps)).rejects.toBe(boom);
      expect(finished).toEqual([{ kind: "cleanup-failed" }]);
    });

    it("keeps prepared even when the recording handshake failed", async () => {
      const { deps, finished } = recorder(
        { stopRecording: async () => ({ stopped: false, reason: "no-bridge" }) },
        { recording: true, analysing: false },
      );
      await expect(runQuitFlow(deps)).resolves.toEqual({ kind: "prepared" });
      expect(finished).toEqual([{ kind: "prepared" }]);
    });

    it("waits for an async finish before resolving", async () => {
      const order: string[] = [];
      const { deps } = recorder({
        finish: async () => {
          order.push("finish:start");
          await tick();
          order.push("finish:end");
        },
      });
      await runQuitFlow(deps);
      order.push("resolved");
      expect(order).toEqual(["finish:start", "finish:end", "resolved"]);
    });

    it("logs a rejecting finish and still resolves with the outcome", async () => {
      const { deps, lines } = recorder({
        finish: async () => {
          throw new Error("설치 잎이 던졌다");
        },
      });
      await expect(runQuitFlow(deps)).resolves.toEqual({ kind: "prepared" });
      expect(lines.join("\n")).toContain("설치 잎이 던졌다");
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter damwha-desktop exec vitest run tests/app/quit-flow.test.ts`
Expected: FAIL — 새 describe의 테스트들(`resolves.toEqual`가 `undefined`를 받음, `deps.quit is not a function`).

- [ ] **Step 3: quit-flow.ts를 고친다**

`QuitNotice` 선언 바로 뒤에 추가:

```ts
/**
 * `runQuitFlow`의 결과 (Phase 6c 스펙 §5.3). 일반 종료는 결과와 무관하게 끝난다 — 결과가 필요한 것은 업데이트
 * 설치뿐이다: **`prepared`일 때만** 설치로 간다. 녹음 핸드셰이크 실패는 결과를 바꾸지 않는다(지금처럼 종료는
 * 진행하고 다음 실행의 sweeper가 봉인한다). 서비스 정지의 성공은 `stopped === true`다 — `leaked.length === 0`이
 * 아니다(`{stopped:false, leaked:[]}`는 깨끗한지 증명하지 못한 것).
 */
export type QuitOutcome = { kind: "cancelled" } | { kind: "prepared" } | { kind: "cleanup-failed" };
export type FinishOutcome = Exclude<QuitOutcome, { kind: "cancelled" }>;
```

`QuitFlowDeps`에서 `/** 진짜 종료. */ quit(): void;`를 바꾼다:

```ts
  /**
   * 마지막 동작. `cancelled`가 아니면 **반드시 한 번** 불린다(finally — Phase 1의 규칙). 일반 종료는 app.quit(),
   * 업데이트 설치는 `prepared`일 때만 설치로 간다(main.ts). 흐름은 이것이 끝날 때까지 기다린다 — 설치 경로가
   * 준비하는 동안 main.ts의 settle이 종료 래치를 내리지 않게(스펙 §5.3). 거부하지 않아야 한다. 거부하면 로그만.
   */
  finish(outcome: FinishOutcome): void | Promise<void>;
```

`export async function runQuitFlow(deps: QuitFlowDeps): Promise<void> {`를 `Promise<QuitOutcome>`로 바꾼다.

`if (!decision.quit) return;` → `if (!decision.quit) return { kind: "cancelled" };`

commit의 catch 안 `return;` → `return { kind: "cancelled" };`

`deps.beginQuit();` 바로 다음 줄에:

```ts
  // 정지가 stopped:true를 말하기 전까지는 실패로 둔다 — 도중에 던지면 이 값으로 finish가 불린다.
  let outcome: FinishOutcome = { kind: "cleanup-failed" };
```

`const out = await deps.stopServices();` 다음의 `if (!out.stopped) {` 앞에:

```ts
    if (out.stopped) outcome = { kind: "prepared" };
```

`} finally { deps.quit(); }`를 바꾼다:

```ts
  } finally {
    try {
      await deps.finish(outcome);
    } catch (e) {
      deps.log(`종료 마무리 중 예외 — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return outcome;
```

- [ ] **Step 4: main.ts의 잎 이름을 바꾼다**

before-quit의 `runQuitFlow({ … })` 인자에서 `quit: () => { if (restoreCommitted) app.relaunch(); quitNow(); },`를:

```ts
      // 일반 종료. 설치 경로는 Task 16이 이 잎에서 가른다.
      finish: () => {
        if (restoreCommitted) app.relaunch();
        quitNow();
      },
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter damwha-desktop exec vitest run tests/app/quit-flow.test.ts && pnpm desktop lint && pnpm desktop test`
Expected: PASS. 기존 "quits even when stopping the services throws"의 `rejects.toBe(boom)`도 그대로 초록.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/app/quit-flow.ts desktop/tests/app/quit-flow.test.ts desktop/src/main.ts
git commit -m "refactor(desktop): 종료 흐름이 결과를 돌려주고 마지막 잎이 그것을 받는다

runQuitFlow가 cancelled/prepared/cleanup-failed를 돌려주고 finish(outcome)를 부른다. 성공은
stopServices의 stopped === true다. 일반 종료의 동작은 그대로다(Phase 6c 스펙 §5.3).

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 4: 설치 가능 판정 (§5.2)

**Files:**
- Create: `desktop/src/update/install-eligibility.ts`
- Test: `desktop/tests/update/install-eligibility.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface VolumeInfo { device: string; internal: boolean; writable: boolean; apfs: boolean }
  export interface EligibilityDeps { packaged: boolean; exePath: string; realpath(p: string): string;
    writable(p: string): boolean; ownerUid(p: string): number; uid: number; volumeOf(dir: string): VolumeInfo | null }
  export type Eligibility = { ok: true; appPath: string; volume: VolumeInfo } | { ok: false; reason: string };
  export function checkEligibility(d: EligibilityDeps): Eligibility;
  export function appBundleOf(exe: string): string | null;
  export function isTranslocated(p: string): boolean;
  export function deviceFromDf(stdout: string): string | null;
  export function volumeFromDiskutil(device: string, json: unknown): VolumeInfo | null;
  ```

- [ ] **Step 1: Write the failing test**

`desktop/tests/update/install-eligibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  appBundleOf,
  checkEligibility,
  deviceFromDf,
  isTranslocated,
  volumeFromDiskutil,
  type EligibilityDeps,
} from "../../src/update/install-eligibility";

const EXE = "/Applications/Damwha.app/Contents/MacOS/Damwha";
const VOL = { device: "/dev/disk3s1", internal: true, writable: true, apfs: true };

function deps(over: Partial<EligibilityDeps> = {}): EligibilityDeps {
  return {
    packaged: true,
    exePath: EXE,
    realpath: (p) => p,
    writable: () => true,
    ownerUid: () => 501,
    uid: 501,
    volumeOf: () => VOL,
    ...over,
  };
}

describe("appBundleOf / isTranslocated", () => {
  it("finds the .app of the main executable", () => {
    expect(appBundleOf(EXE)).toBe("/Applications/Damwha.app");
    expect(appBundleOf("/Users/a/Apps/Damwha.app/Contents/MacOS/Damwha")).toBe("/Users/a/Apps/Damwha.app");
  });
  it("rejects anything that is not an app's main executable", () => {
    expect(appBundleOf("/usr/local/bin/electron")).toBeNull();
    expect(appBundleOf("/Applications/Damwha.app/Contents/Frameworks/x")).toBeNull();
  });
  it("detects App Translocation by path", () => {
    expect(isTranslocated("/private/var/folders/xy/abc/T/AppTranslocation/1234/d/Damwha.app")).toBe(true);
    expect(isTranslocated("/Applications/Damwha.app")).toBe(false);
  });
});

describe("checkEligibility", () => {
  it("accepts an internal writable app owned by this user", () => {
    expect(checkEligibility(deps())).toEqual({ ok: true, appPath: "/Applications/Damwha.app", volume: VOL });
  });

  it("uses the realpath, not the reported exe path", () => {
    const r = checkEligibility(deps({ exePath: "/tmp/link", realpath: () => EXE }));
    expect(r).toMatchObject({ ok: true, appPath: "/Applications/Damwha.app" });
  });

  it.each<[string, Partial<EligibilityDeps>]>([
    ["dev", { packaged: false }],
    ["realpath throws", { realpath: () => { throw new Error("ENOENT"); } }],
    ["not an app bundle", { realpath: () => "/usr/local/bin/electron" }],
    ["translocated", { realpath: () => "/private/var/folders/x/T/AppTranslocation/9/d/Damwha.app/Contents/MacOS/Damwha" }],
    ["app not writable", { writable: (p) => !p.endsWith(".app") }],
    ["parent not writable", { writable: (p) => p.endsWith(".app") }],
    ["other owner", { ownerUid: () => 0 }],
    ["owner check throws", { ownerUid: () => { throw new Error("EPERM"); } }],
    ["volume undecidable", { volumeOf: () => null }],
    ["volume query throws", { volumeOf: () => { throw new Error("diskutil failed"); } }],
    ["external volume", { volumeOf: () => ({ ...VOL, internal: false }) }],
    ["read-only volume", { volumeOf: () => ({ ...VOL, writable: false }) }],
  ])("refuses when %s", (_label, over) => {
    const r = checkEligibility(deps(over));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason.length > 0).toBe(true);
  });
});

describe("deviceFromDf", () => {
  it("takes the device of a local volume", () => {
    const out =
      "Filesystem   512-blocks      Used Available Capacity iused      ifree %iused  Mounted on\n" +
      "/dev/disk3s1  965595304 879801968  36306776    97% 4323624  181533880    2%   /System/Volumes/Data\n";
    expect(deviceFromDf(out)).toBe("/dev/disk3s1");
  });
  it("returns null for network and autofs mounts", () => {
    expect(deviceFromDf("Filesystem 512-blocks\n//me@nas/share 100 50 50 50% /Volumes/share\n")).toBeNull();
    expect(deviceFromDf("Filesystem 512-blocks\nmap auto_home 0 0 0 100% /System/Volumes/Data/home\n")).toBeNull();
    expect(deviceFromDf("")).toBeNull();
  });
});

describe("volumeFromDiskutil", () => {
  it("reads Internal, WritableVolume and the filesystem", () => {
    const json = { Internal: true, WritableVolume: true, FilesystemType: "apfs", MountPoint: "/System/Volumes/Data" };
    expect(volumeFromDiskutil("/dev/disk3s1", json)).toEqual(VOL);
    expect(volumeFromDiskutil("/dev/disk4s1", { Internal: false, WritableVolume: true, FilesystemType: "exfat" }))
      .toEqual({ device: "/dev/disk4s1", internal: false, writable: true, apfs: false });
  });
  it("returns null when a field is missing or not a boolean", () => {
    expect(volumeFromDiskutil("/dev/disk3s1", { WritableVolume: true })).toBeNull();
    expect(volumeFromDiskutil("/dev/disk3s1", { Internal: "Yes", WritableVolume: true })).toBeNull();
    expect(volumeFromDiskutil("/dev/disk3s1", null)).toBeNull();
    expect(volumeFromDiskutil("/dev/disk3s1", { Error: true })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/install-eligibility.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`desktop/src/update/install-eligibility.ts`:

```ts
import * as path from "path";

/**
 * 이 앱을 앱 안에서 교체할 수 있는가 (Phase 6c 스펙 §5.2). electron을 import하지 않는다 — 잎(realpath·권한·소유자·
 * 볼륨)은 main.ts가 주입한다. **판정할 수 없으면 거짓이다** — 그때는 지금처럼 다운로드 페이지를 연다.
 *
 * 표준 사용자도 앱과 부모 디렉터리를 자기 권한으로 교체할 수 있으면 허용한다(§15.1 확정) — 그 경우 Squirrel은
 * privileged helper 없이 교체한다. 관리자 인증 창은 이 Phase에서 다루지 않는다.
 *
 * 볼륨은 `df <dir>` → 장치 → `diskutil info -plist <장치>`로 본다. 경로를 diskutil에 바로 주면 오류가 나고
 * (`diskutil info -plist /Applications` → Error, 2026-09-25 실측), Node `fs.statfs`는 mount flag를 주지 않는다.
 */
export interface VolumeInfo {
  device: string;
  internal: boolean;
  writable: boolean;
  apfs: boolean;
}

export interface EligibilityDeps {
  packaged: boolean;
  exePath: string;
  realpath(p: string): string;
  writable(p: string): boolean;
  ownerUid(p: string): number;
  uid: number;
  /** null = 판정 불가(네트워크 볼륨 등). */
  volumeOf(dir: string): VolumeInfo | null;
}

export type Eligibility = { ok: true; appPath: string; volume: VolumeInfo } | { ok: false; reason: string };

/** `…/X.app/Contents/MacOS/X` → `…/X.app`. 모양이 아니면 null. */
export function appBundleOf(exe: string): string | null {
  const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe);
  return m === null ? null : m[1];
}

/** quarantine 속성이나 `/Applications` 문자열로 판정하지 않는다(스펙 §3.2 C10). */
export function isTranslocated(p: string): boolean {
  return p.includes("/AppTranslocation/");
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function checkEligibility(d: EligibilityDeps): Eligibility {
  if (!d.packaged) return { ok: false, reason: "개발 실행이에요" };
  let real: string;
  try {
    real = d.realpath(d.exePath);
  } catch (e) {
    return { ok: false, reason: `실행 경로를 확인하지 못했어요 — ${reasonOf(e)}` };
  }
  const app = appBundleOf(real);
  if (app === null) return { ok: false, reason: `앱 번들 경로가 아니에요: ${real}` };
  if (isTranslocated(app)) return { ok: false, reason: "다운로드 폴더나 DMG에서 바로 실행 중이에요" };
  const parent = path.dirname(app);
  try {
    if (!d.writable(app) || !d.writable(parent)) return { ok: false, reason: "앱 또는 앱이 있는 폴더에 쓸 수 없어요" };
    if (d.ownerUid(app) !== d.uid) return { ok: false, reason: "앱의 소유자가 지금 사용자가 아니에요" };
  } catch (e) {
    return { ok: false, reason: `권한을 확인하지 못했어요 — ${reasonOf(e)}` };
  }
  let volume: VolumeInfo | null;
  try {
    volume = d.volumeOf(parent);
  } catch (e) {
    return { ok: false, reason: `디스크를 확인하지 못했어요 — ${reasonOf(e)}` };
  }
  if (volume === null) return { ok: false, reason: "앱이 있는 디스크를 판정하지 못했어요" };
  if (!volume.internal) return { ok: false, reason: "앱이 내장 디스크에 있지 않아요" };
  if (!volume.writable) return { ok: false, reason: "앱이 있는 디스크가 읽기 전용이에요" };
  return { ok: true, appPath: app, volume };
}

/** `df <dir>` 출력의 둘째 줄 첫 칸. `/dev/diskNsM`이 아니면(네트워크·autofs) null. */
export function deviceFromDf(stdout: string): string | null {
  const line = stdout.split("\n").filter((l) => l.trim() !== "")[1];
  if (line === undefined) return null;
  const dev = line.trim().split(/\s+/)[0];
  return /^\/dev\/disk\d+(?:s\d+)*$/.test(dev) ? dev : null;
}

/** `diskutil info -plist <dev> | plutil -convert json -o - -`의 결과. 필드가 불리언이 아니면 null. */
export function volumeFromDiskutil(device: string, json: unknown): VolumeInfo | null {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (typeof o.Internal !== "boolean" || typeof o.WritableVolume !== "boolean") return null;
  return { device, internal: o.Internal, writable: o.WritableVolume, apfs: o.FilesystemType === "apfs" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/install-eligibility.test.ts`
Expected: PASS.

- [ ] **Step 5: 실측 한 번 — 이 맥에서 잎 조합이 통하는가**

```bash
DEV=$(df /Applications | tail -1 | awk '{print $1}'); diskutil info -plist "$DEV" | plutil -convert json -o - - | head -c 300
```

Expected: `"Internal":true`와 `"WritableVolume":true`가 보인다. 결과 문서 초안에 붙여 둔다(Task 19).

- [ ] **Step 6: Commit**

```bash
git add desktop/src/update/install-eligibility.ts desktop/tests/update/install-eligibility.test.ts
git commit -m "feat(desktop): 앱을 앱 안에서 교체할 수 있는지 판정한다

실제 경로·Translocation·앱과 부모의 쓰기 권한·소유자·내장/쓰기 가능 볼륨. 판정할 수 없으면
거짓이다(Phase 6c 스펙 §5.2).

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 5: 설치 시도 기록과 다음 기동 판정 (§5.6)

**Files:**
- Create: `desktop/src/update/install-attempt.ts`
- Test: `desktop/tests/update/install-attempt.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const INSTALL_ATTEMPT_FILE = "install-attempt.json";
  export type AttemptPhase = "staging" | "installing" | "outcome-unknown";
  export interface InstallAttempt { jobId: string; fromBuild: string; expectedBuild: string; tag: string; phase: AttemptPhase; at: string }
  export type AttemptRead = { kind: "none" } | { kind: "ok"; attempt: InstallAttempt } | { kind: "unreadable"; detail: string };
  export interface AttemptStore { read(): AttemptRead; write(a: InstallAttempt): void /* throws */; clear(): void }
  export function makeAttemptStore(userData: string): AttemptStore;
  export type AttemptVerdict = { kind: "none" } | { kind: "applied" | "not-applied" | "other-build"; attempt: InstallAttempt } | { kind: "undecidable"; detail: string };
  export function judgeAttempt(read: AttemptRead, runningBuild: string | null): AttemptVerdict;
  export function verdictLine(v: AttemptVerdict, runningBuild: string | null): string | null;
  export function clearsRecord(v: AttemptVerdict): boolean;
  ```

- [ ] **Step 1: Write the failing test**

`desktop/tests/update/install-attempt.test.ts`:

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  INSTALL_ATTEMPT_FILE,
  clearsRecord,
  judgeAttempt,
  makeAttemptStore,
  verdictLine,
  type InstallAttempt,
} from "../../src/update/install-attempt";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "attempt-"));
  dirs.push(d);
  return d;
}

const A: InstallAttempt = {
  jobId: "job-1",
  fromBuild: "0.5.0+aaaaaaaaaaaa",
  expectedBuild: "0.6.0+bbbbbbbbbbbb",
  tag: "v0.6.0",
  phase: "staging",
  at: "2026-09-25T00:00:00.000Z",
};

describe("makeAttemptStore", () => {
  it("reads none when the file is absent", () => {
    expect(makeAttemptStore(tmp()).read()).toEqual({ kind: "none" });
  });

  it("round-trips a record atomically and leaves no temp file", () => {
    const d = tmp();
    const s = makeAttemptStore(d);
    s.write(A);
    expect(s.read()).toEqual({ kind: "ok", attempt: A });
    expect(fs.readdirSync(d)).toEqual([INSTALL_ATTEMPT_FILE]);
  });

  it("calls a malformed file unreadable instead of none", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, INSTALL_ATTEMPT_FILE), JSON.stringify({ ...A, phase: "done" }));
    expect(makeAttemptStore(d).read().kind).toBe("unreadable");
    fs.writeFileSync(path.join(d, INSTALL_ATTEMPT_FILE), "{");
    expect(makeAttemptStore(d).read().kind).toBe("unreadable");
    fs.writeFileSync(path.join(d, INSTALL_ATTEMPT_FILE), JSON.stringify({ ...A, expectedBuild: "0.6.0" }));
    expect(makeAttemptStore(d).read().kind).toBe("unreadable");
  });

  it("throws when it cannot write, so the caller can refuse to stage", () => {
    const s = makeAttemptStore(path.join(tmp(), "missing-dir"));
    expect(() => s.write(A)).toThrow();
  });

  it("clears without complaining when nothing is there", () => {
    const d = tmp();
    const s = makeAttemptStore(d);
    s.clear();
    s.write(A);
    s.clear();
    expect(s.read()).toEqual({ kind: "none" });
  });
});

describe("judgeAttempt", () => {
  const ok = { kind: "ok" as const, attempt: A };
  it("applied when running the expected build", () => {
    expect(judgeAttempt(ok, "0.6.0+bbbbbbbbbbbb")).toEqual({ kind: "applied", attempt: A });
  });
  it("not-applied when still running the old build", () => {
    expect(judgeAttempt(ok, "0.5.0+aaaaaaaaaaaa")).toEqual({ kind: "not-applied", attempt: A });
  });
  it("other-build when a third build runs (a person installed another)", () => {
    expect(judgeAttempt(ok, "0.7.0+cccccccccccc")).toEqual({ kind: "other-build", attempt: A });
  });
  it("undecidable when unreadable or the running build is unknown", () => {
    expect(judgeAttempt({ kind: "unreadable", detail: "x" }, "0.6.0+bbbbbbbbbbbb").kind).toBe("undecidable");
    expect(judgeAttempt(ok, null).kind).toBe("undecidable");
  });
  it("none when there is no record", () => {
    expect(judgeAttempt({ kind: "none" }, "0.6.0+bbbbbbbbbbbb")).toEqual({ kind: "none" });
  });
});

describe("verdictLine / clearsRecord", () => {
  it("says what happened and clears all but undecidable", () => {
    const applied = judgeAttempt({ kind: "ok", attempt: A }, A.expectedBuild);
    expect(verdictLine(applied, A.expectedBuild)).toContain("0.5.0+aaaaaaaaaaaa → 0.6.0+bbbbbbbbbbbb");
    expect(clearsRecord(applied)).toBe(true);
    const other = judgeAttempt({ kind: "ok", attempt: A }, "0.7.0+cccccccccccc");
    expect(verdictLine(other, "0.7.0+cccccccccccc")).toContain("요청한 빌드와 달라요");
    expect(clearsRecord(other)).toBe(true);
    const undecidable = judgeAttempt({ kind: "unreadable", detail: "모양" }, A.expectedBuild);
    expect(clearsRecord(undecidable)).toBe(false);
    expect(verdictLine({ kind: "none" }, null)).toBeNull();
    expect(clearsRecord({ kind: "none" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/install-attempt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`desktop/src/update/install-attempt.ts`:

```ts
import * as fs from "fs";
import * as path from "path";

/**
 * 설치 시도 기록 (Phase 6c 스펙 §5.6). electron을 import하지 않는다.
 *
 * **내장 준비 호출 전에** `phase: "staging"`으로 쓴다 — 준비 도중 크래시하면 Squirrel이 이미 예약을 기록했을 수 있고,
 * 그때 이 파일만이 다음 기동에게 "교체가 일어났을 수 있다"고 말한다. 쓰지 못하면 준비하지 않는다(쓰기는 던진다).
 * 판정은 **바이너리 교체**만 말한다 — 서비스 기동 성공은 따로다.
 */
export const INSTALL_ATTEMPT_FILE = "install-attempt.json";

export type AttemptPhase = "staging" | "installing" | "outcome-unknown";
const PHASES: readonly AttemptPhase[] = ["staging", "installing", "outcome-unknown"];
const BUILD_ID = /^\d+\.\d+\.\d+\+[0-9a-f]{12}(?:-dirty)?$/;

export interface InstallAttempt {
  jobId: string;
  fromBuild: string;
  expectedBuild: string;
  tag: string;
  phase: AttemptPhase;
  at: string;
}

export type AttemptRead = { kind: "none" } | { kind: "ok"; attempt: InstallAttempt } | { kind: "unreadable"; detail: string };

export interface AttemptStore {
  read(): AttemptRead;
  /** 원자적(tmp → rename). 못 쓰면 던진다. */
  write(a: InstallAttempt): void;
  clear(): void;
}

function parseAttempt(text: string): InstallAttempt | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" && o[k] !== "" ? (o[k] as string) : null);
  const jobId = str("jobId");
  const fromBuild = str("fromBuild");
  const expectedBuild = str("expectedBuild");
  const tag = str("tag");
  const at = str("at");
  const phase = o.phase;
  if (jobId === null || tag === null || at === null) return null;
  if (fromBuild === null || !BUILD_ID.test(fromBuild) || expectedBuild === null || !BUILD_ID.test(expectedBuild)) return null;
  if (typeof phase !== "string" || !(PHASES as readonly string[]).includes(phase)) return null;
  return { jobId, fromBuild, expectedBuild, tag, phase: phase as AttemptPhase, at };
}

export function makeAttemptStore(userData: string): AttemptStore {
  const file = path.join(userData, INSTALL_ATTEMPT_FILE);
  return {
    read() {
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
        return { kind: "unreadable", detail: e instanceof Error ? e.message : String(e) };
      }
      const a = parseAttempt(text);
      return a === null ? { kind: "unreadable", detail: "기록의 모양이 맞지 않아요" } : { kind: "ok", attempt: a };
    },
    write(a) {
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(a));
        fs.renameSync(tmp, file);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
    },
    clear() {
      fs.rmSync(file, { force: true });
    },
  };
}

export type AttemptVerdict =
  | { kind: "none" }
  | { kind: "applied" | "not-applied" | "other-build"; attempt: InstallAttempt }
  | { kind: "undecidable"; detail: string };

export function judgeAttempt(read: AttemptRead, runningBuild: string | null): AttemptVerdict {
  if (read.kind === "none") return { kind: "none" };
  if (read.kind === "unreadable") return { kind: "undecidable", detail: read.detail };
  if (runningBuild === null) return { kind: "undecidable", detail: "실행 중인 빌드를 모르는 실행이에요(개발 실행)" };
  const a = read.attempt;
  if (runningBuild === a.expectedBuild) return { kind: "applied", attempt: a };
  if (runningBuild === a.fromBuild) return { kind: "not-applied", attempt: a };
  return { kind: "other-build", attempt: a };
}

export function verdictLine(v: AttemptVerdict, runningBuild: string | null): string | null {
  switch (v.kind) {
    case "none":
      return null;
    case "applied":
      return `업데이트를 적용했어요 (${v.attempt.fromBuild} → ${v.attempt.expectedBuild})`;
    case "not-applied":
      return `업데이트가 적용되지 않았어요 (${v.attempt.expectedBuild} 요청, ${v.attempt.fromBuild} 그대로)`;
    case "other-build":
      return `요청한 빌드와 달라요 (${v.attempt.expectedBuild} 요청, ${runningBuild ?? "알 수 없음"} 실행)`;
    case "undecidable":
      return `업데이트 기록을 판정하지 못했어요 — ${v.detail}`;
  }
}

/** 판정 뒤 기록을 지우는가. 판정 불가만 남긴다 — 사람이 메뉴로 지운다(스펙 §5.4). */
export function clearsRecord(v: AttemptVerdict): boolean {
  return v.kind === "applied" || v.kind === "not-applied" || v.kind === "other-build";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/install-attempt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/update/install-attempt.ts desktop/tests/update/install-attempt.test.ts
git commit -m "feat(desktop): 설치 시도를 기록하고 다음 기동이 판정한다

적용됨·미적용·다른 빌드·판정 불가. 판정 불가만 기록을 남긴다(Phase 6c 스펙 §5.6).

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 6: 되돌리기·설치 상호 배제 (§5.4)

**Files:**
- Create: `desktop/src/app/maintenance.ts`
- Modify: `desktop/src/app/restore-flow.ts:12-14` (`restoreMenuEnabled`)
- Modify: `desktop/tests/app/restore-flow.test.ts:24-27`
- Test: `desktop/tests/app/maintenance.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MaintenanceKind = "restore" | "install";
  export interface MaintenanceLock { take(kind: MaintenanceKind): boolean; release(kind: MaintenanceKind): void; held(): MaintenanceKind | null }
  export function createMaintenanceLock(): MaintenanceLock;
  export function installBlockedByRestore(s: { journalPresent: boolean; pendingRestore: boolean }): boolean;
  restoreMenuEnabled(s: { external: boolean; restorable: readonly SnapshotInfo[]; journalPresent: boolean; installBlocking: boolean }): boolean;
  ```

- [ ] **Step 1: Write the failing test**

`desktop/tests/app/maintenance.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createMaintenanceLock, installBlockedByRestore } from "../../src/app/maintenance";

describe("createMaintenanceLock", () => {
  it("lets one kind hold at a time", () => {
    const m = createMaintenanceLock();
    expect(m.take("restore")).toBe(true);
    expect(m.take("install")).toBe(false);
    expect(m.take("restore")).toBe(false);
    expect(m.held()).toBe("restore");
  });

  it("ignores a release by the kind that does not hold", () => {
    const m = createMaintenanceLock();
    m.take("install");
    m.release("restore");
    expect(m.held()).toBe("install");
    m.release("install");
    expect(m.held()).toBeNull();
    expect(m.take("restore")).toBe(true);
  });
});

describe("installBlockedByRestore", () => {
  it("blocks while a restore is journaled or requested", () => {
    expect(installBlockedByRestore({ journalPresent: true, pendingRestore: false })).toBe(true);
    expect(installBlockedByRestore({ journalPresent: false, pendingRestore: true })).toBe(true);
    expect(installBlockedByRestore({ journalPresent: false, pendingRestore: false })).toBe(false);
  });
});
```

`desktop/tests/app/restore-flow.test.ts` 24~27줄의 네 호출 각각에 `installBlocking: false`를 넣고, 그 아래에 한 줄을 더한다:

```ts
    expect(restoreMenuEnabled({ external: false, restorable: [info()], journalPresent: false, installBlocking: false })).toBe(true);
    expect(restoreMenuEnabled({ external: true, restorable: [info()], journalPresent: false, installBlocking: false })).toBe(false);
    expect(restoreMenuEnabled({ external: false, restorable: [], journalPresent: false, installBlocking: false })).toBe(false);
    expect(restoreMenuEnabled({ external: false, restorable: [info()], journalPresent: true, installBlocking: false })).toBe(false);
    // 설치가 예약됐거나 판정 안 된 설치 기록이 있으면 막는다 (Phase 6c 스펙 §5.4).
    expect(restoreMenuEnabled({ external: false, restorable: [info()], journalPresent: false, installBlocking: true })).toBe(false);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter damwha-desktop exec vitest run tests/app/maintenance.test.ts tests/app/restore-flow.test.ts`
Expected: FAIL — maintenance module not found, 그리고 `installBlocking: true` 줄이 `true`를 받음.

- [ ] **Step 3: Write minimal implementation**

`desktop/src/app/maintenance.ts`:

```ts
/**
 * 되돌리기와 업데이트 설치의 상호 배제 (Phase 6c 스펙 §5.4). electron을 import하지 않는다.
 *
 * 둘 다 "앱을 끄고 다른 판/데이터로 다시 뜨게" 만든다. 되돌리기는 저널 → `app.relaunch()`, 설치는 Squirrel 예약 →
 * `quitAndInstall()`이다. 둘이 겹치면 스파이크 S2의 relaunch 경쟁을 제품에 넣는다. **확인창을 띄우기 전에** 잡고,
 * 취소하면 놓는다 — 확인창이 열린 동안에는 `pendingRestore`가 아직 null이라 그것만 보면 막지 못한다.
 */
export type MaintenanceKind = "restore" | "install";

export interface MaintenanceLock {
  take(kind: MaintenanceKind): boolean;
  release(kind: MaintenanceKind): void;
  held(): MaintenanceKind | null;
}

export function createMaintenanceLock(): MaintenanceLock {
  let holder: MaintenanceKind | null = null;
  return {
    take(kind) {
      if (holder !== null) return false;
      holder = kind;
      return true;
    },
    release(kind) {
      if (holder === kind) holder = null;
    },
    held: () => holder,
  };
}

export function installBlockedByRestore(s: { journalPresent: boolean; pendingRestore: boolean }): boolean {
  return s.journalPresent || s.pendingRestore;
}
```

`desktop/src/app/restore-flow.ts`의 `restoreMenuEnabled`:

```ts
/**
 * `installBlocking` — 설치가 예약됐거나(`maintenance.held() === "install"`) 판정 안 된 설치 시도 기록이 남아 있다
 * (Phase 6c 스펙 §5.4). 기록이 남은 동안은 다음 프로세스에서도 막는다 — ShipIt 예약이 남았는지 앱이 증명할 수 없다.
 */
export function restoreMenuEnabled(s: {
  external: boolean;
  restorable: readonly SnapshotInfo[];
  journalPresent: boolean;
  installBlocking: boolean;
}): boolean {
  return !s.external && !s.journalPresent && !s.installBlocking && s.restorable.length > 0;
}
```

`desktop/src/main.ts`의 `restoreAllowedNow()`가 부르는 `restoreMenuEnabled({ … })`에 임시로 `installBlocking: false,`를 넣는다(Task 16이 실제 값으로 바꾼다).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter damwha-desktop exec vitest run tests/app/maintenance.test.ts tests/app/restore-flow.test.ts && pnpm desktop lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/app/maintenance.ts desktop/tests/app/maintenance.test.ts desktop/src/app/restore-flow.ts desktop/tests/app/restore-flow.test.ts desktop/src/main.ts
git commit -m "feat(desktop): 되돌리기와 업데이트 설치를 서로 배제한다

확인창 전에 잡는 예약 하나와, 설치가 예약됐거나 판정 안 된 설치 기록이 있으면 되돌리기 메뉴를 막는
조건(Phase 6c 스펙 §5.4).

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 7: 조회가 실제 태그·자동 설치 가능 여부를 보존한다 (§5.5·§6.1)

**Files:**
- Modify: `desktop/src/update/release-check.ts`
- Modify: `desktop/tests/update/release-check.test.ts:62,67`
- Test: `desktop/tests/update/release-check.test.ts` (추가)

**Interfaces:**
- Produces:
  ```ts
  export const DEFAULT_REPO = "Yjason-K/Damwha";
  export function repoFromEnv(raw: string | undefined): { repo: string; ignored: string | null };
  export function releasesUrlFor(repo: string): string;
  export function releasePageUrl(tag: string, repo?: string): string;
  export function feedUrlFor(tag: string, repo?: string): string;
  export const MANIFEST_NAME = "latest-mac.yml";
  export function hasAutoInstallAssets(assets: unknown): boolean;
  export function parseMacos(s: string): Version | null;
  export function macosSatisfies(current: string, min: string): boolean | null;
  // Candidate에 releaseId: number | null, autoInstall: boolean
  // CheckResult newer: { kind: "newer"; version: string; url: string; tag: string; releaseId: number | null; autoInstall: boolean }
  // CheckDeps에 repo?: string
  ```

- [ ] **Step 1: Write the failing tests**

`desktop/tests/update/release-check.test.ts`의 import에 `feedUrlFor, hasAutoInstallAssets, macosSatisfies, parseMacos, releasesUrlFor, repoFromEnv, DEFAULT_REPO`를 더한다. 62·67줄의 `toEqual({ kind: "newer", …})`를 `toMatchObject(`로 바꾼다(새 필드가 늘어서):

```bash
sed -i '' 's/expect(r).toEqual({ kind: "newer"/expect(r).toMatchObject({ kind: "newer"/' desktop/tests/update/release-check.test.ts
```

파일 끝에 더한다:

```ts
const zipAssets = [{ name: "Damwha-0.6.0-arm64.dmg" }, { name: "Damwha-0.6.0-arm64-mac.zip" }, { name: "latest-mac.yml" }];

describe("자동 설치 가능 여부 (Phase 6c §5.5)", () => {
  it("needs both latest-mac.yml and an arm64 mac zip", () => {
    expect(hasAutoInstallAssets(zipAssets)).toBe(true);
    expect(hasAutoInstallAssets([{ name: "Damwha-0.6.0-arm64.dmg" }, { name: "latest-mac.yml" }])).toBe(false);
    expect(hasAutoInstallAssets([{ name: "Damwha-0.6.0-arm64-mac.zip" }])).toBe(false);
    expect(hasAutoInstallAssets(undefined)).toBe(false);
    expect(hasAutoInstallAssets([null, { name: 3 }])).toBe(false);
  });

  it("keeps the real tag, the release id and autoInstall on newer", async () => {
    const r = await run("0.5.0", [rel("v0.6.0", { id: 42, assets: zipAssets }), rel("desktop-v0.3.1")]);
    expect(r).toEqual({
      kind: "newer",
      version: "0.6.0",
      url: `${RELEASE_PAGE_BASE}v0.6.0`,
      tag: "v0.6.0",
      releaseId: 42,
      autoInstall: true,
    });
  });

  it("marks an old desktop-v release without assets as not auto-installable", async () => {
    const r = await run("0.3.0", [rel("desktop-v0.3.1", { id: 7, assets: [{ name: "Damwha-0.3.1-arm64.dmg" }] })]);
    expect(r).toMatchObject({ kind: "newer", tag: "desktop-v0.3.1", releaseId: 7, autoInstall: false });
  });

  it("drops a non-integer release id", async () => {
    const r = await run("0.5.0", [rel("v0.6.0", { id: "42", assets: zipAssets })]);
    expect(r).toMatchObject({ releaseId: null, autoInstall: true });
  });
});

describe("feed URL과 저장소 (Phase 6c §6.1, 계획 D2)", () => {
  it("builds the download feed from the real tag", () => {
    expect(feedUrlFor("v0.6.0")).toBe("https://github.com/Yjason-K/Damwha/releases/download/v0.6.0/");
    expect(feedUrlFor("desktop-v0.3.1")).toBe("https://github.com/Yjason-K/Damwha/releases/download/desktop-v0.3.1/");
    expect(feedUrlFor("v0.6.0", "Yjason-K/Damwha-update-test")).toBe(
      "https://github.com/Yjason-K/Damwha-update-test/releases/download/v0.6.0/",
    );
  });

  it("accepts only Yjason-K repositories from the env", () => {
    expect(repoFromEnv(undefined)).toEqual({ repo: DEFAULT_REPO, ignored: null });
    expect(repoFromEnv("Yjason-K/Damwha-update-test")).toEqual({ repo: "Yjason-K/Damwha-update-test", ignored: null });
    expect(repoFromEnv("evil/Damwha")).toEqual({ repo: DEFAULT_REPO, ignored: "evil/Damwha" });
    expect(repoFromEnv("Yjason-K/../x")).toEqual({ repo: DEFAULT_REPO, ignored: "Yjason-K/../x" });
    expect(releasesUrlFor(DEFAULT_REPO)).toBe(RELEASES_URL);
  });

  it("queries the chosen repository", async () => {
    const repo = "Yjason-K/Damwha-update-test";
    const f = fakeFetch({ [releasesUrlFor(repo)]: { body: [rel("v0.6.0", { id: 1, assets: zipAssets })] } });
    const r = await checkForUpdate("0.5.0", { fetch: f.fetch, now: () => 0, repo });
    expect(r).toMatchObject({ kind: "newer", url: `https://github.com/${repo}/releases/tag/v0.6.0` });
  });
});

describe("macOS 버전 (Phase 6c §5.5)", () => {
  it("parses one to three parts", () => {
    expect(parseMacos("15")).toEqual([15, 0, 0]);
    expect(parseMacos("15.0")).toEqual([15, 0, 0]);
    expect(parseMacos("26.1.2")).toEqual([26, 1, 2]);
    expect(parseMacos("15.0.0.1")).toBeNull();
    expect(parseMacos("")).toBeNull();
  });
  it("compares numerically and says null when unreadable", () => {
    expect(macosSatisfies("26.1", "15.0")).toBe(true);
    expect(macosSatisfies("15.0", "15.0")).toBe(true);
    expect(macosSatisfies("14.7.1", "15.0")).toBe(false);
    expect(macosSatisfies("15.10", "15.9")).toBe(true);
    expect(macosSatisfies("x", "15.0")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/release-check.test.ts`
Expected: FAIL — `feedUrlFor is not a function` 등.

- [ ] **Step 3: Implement**

`desktop/src/update/release-check.ts` 상단 상수를 바꾼다:

```ts
export const DEFAULT_REPO = "Yjason-K/Damwha";
/** 개발·실측용 저장소 env (계획 D2). 이 계정의 저장소만 받는다 — 다른 값은 무시하고 기본으로. */
const REPO_SHAPE = /^Yjason-K\/[A-Za-z0-9._-]+$/;
export function repoFromEnv(raw: string | undefined): { repo: string; ignored: string | null } {
  if (raw === undefined || raw === "") return { repo: DEFAULT_REPO, ignored: null };
  return REPO_SHAPE.test(raw) && !raw.includes("..") ? { repo: raw, ignored: null } : { repo: DEFAULT_REPO, ignored: raw };
}
export function releasesUrlFor(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases?per_page=100`;
}
export const RELEASES_URL = releasesUrlFor(DEFAULT_REPO);
export const RELEASE_PAGE_BASE = `https://github.com/${DEFAULT_REPO}/releases/tag/`;
```

`releasePageUrl`을 바꾸고 `feedUrlFor`·자산·macOS 함수를 더한다(`releasePageUrl` 자리):

```ts
export function releasePageUrl(tag: string, repo: string = DEFAULT_REPO): string {
  return `https://github.com/${repo}/releases/tag/${tag}`;
}

/** electron-updater generic feed. 응답의 URL이 아니라 정규식을 통과한 태그로 만든다(스펙 §6.1). */
export function feedUrlFor(tag: string, repo: string = DEFAULT_REPO): string {
  return `https://github.com/${repo}/releases/download/${tag}/`;
}

export const MANIFEST_NAME = "latest-mac.yml";
/** 자동 설치 자산이 있는가 — manifest와 arm64 mac zip 둘 다. 없으면 6b-1처럼 페이지만 연다. */
export function hasAutoInstallAssets(assets: unknown): boolean {
  if (!Array.isArray(assets)) return false;
  const names = assets
    .map((a) => (a !== null && typeof a === "object" ? (a as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === "string");
  return names.includes(MANIFEST_NAME) && names.some((n) => /-arm64-mac\.zip$/.test(n));
}

/** "15", "15.0", "26.1.2". 빠진 자리는 0. */
export function parseMacos(s: string): Version | null {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(s.trim());
  if (m === null) return null;
  const v = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] as const;
  return v.every(Number.isSafeInteger) ? v : null;
}

export function macosSatisfies(current: string, min: string): boolean | null {
  const c = parseMacos(current);
  const m = parseMacos(min);
  if (c === null || m === null) return null;
  return compareVersions(c, m) >= 0;
}
```

`Candidate`와 `pickLatest`:

```ts
export interface Candidate {
  version: Version;
  tag: string;
  releaseId: number | null;
  autoInstall: boolean;
}
```

`pickLatest` 안 `const c: Candidate = { version, tag: r.tag_name };`를:

```ts
    const releaseId = typeof r.id === "number" && Number.isSafeInteger(r.id) ? r.id : null;
    const c: Candidate = { version, tag: r.tag_name, releaseId, autoInstall: hasAutoInstallAssets(r.assets) };
```

`CheckResult`의 `newer`:

```ts
  | { kind: "newer"; version: string; url: string; tag: string; releaseId: number | null; autoInstall: boolean }
```

`CheckDeps`에 `repo?: string;`. `readAllPages`의 `let url = RELEASES_URL;` → `let url = releasesUrlFor(deps.repo ?? DEFAULT_REPO);`. `checkForUpdate`의 newer 반환:

```ts
      return {
        kind: "newer",
        version: formatVersion(latest.version),
        url: releasePageUrl(latest.tag, deps.repo ?? DEFAULT_REPO),
        tag: latest.tag,
        releaseId: latest.releaseId,
        autoInstall: latest.autoInstall,
      };
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update && pnpm desktop lint`
Expected: PASS (update-flow 테스트의 가짜 `newer`는 새 필드가 없어 `autoInstall`이 undefined → 기존 동작 그대로).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/update/release-check.ts desktop/tests/update/release-check.test.ts
git commit -m "feat(desktop): 조회 결과에 실제 태그·릴리스 ID·자동 설치 가능 여부를 싣는다

feed URL을 실제 태그로 만들고(desktop-v*도 그대로), macOS 버전 비교와 개발용 저장소 env를 더한다
(Phase 6c 스펙 §5.5·§6.1, 계획 D2).

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 8: electron-updater 의존성과 manifest 검증 (§6.2)

**Files:**
- Modify: `desktop/package.json` (`dependencies`), `pnpm-lock.yaml`
- Create: `desktop/src/update/manifest.ts`
- Test: `desktop/tests/update/manifest.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Manifest { version: string; buildId: string; minMacos: string; zipSize: number; appSize: number }
  export function parseManifest(info: unknown): { ok: true; manifest: Manifest } | { ok: false; reason: string };
  ```

- [ ] **Step 1: 의존성을 정확한 버전으로 더한다**

```bash
pnpm add --filter damwha-desktop electron-updater@6.8.9 --save-exact
node -p "require('./desktop/package.json').dependencies"
```

Expected: `{ 'electron-updater': '6.8.9' }`. (이 시점부터 Task 13 전까지 `pnpm desktop:build`의 check-bundle 1번이 실패한다 — Task 13이 고친다.)

- [ ] **Step 2: Write the failing test**

`desktop/tests/update/manifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseManifest } from "../../src/update/manifest";

const good = {
  version: "0.6.0",
  files: [{ url: "Damwha-0.6.0-arm64-mac.zip", sha512: "x", size: 540_000_000 }],
  path: "Damwha-0.6.0-arm64-mac.zip",
  sha512: "x",
  releaseDate: "2026-10-01T00:00:00.000Z",
  damwhaBuildId: "0.6.0+0123456789ab",
  damwhaMinMacos: "15.0",
  damwhaAppSize: 1_780_000_000,
};

describe("parseManifest", () => {
  it("reads the Damwha fields and the zip size", () => {
    expect(parseManifest(good)).toEqual({
      ok: true,
      manifest: { version: "0.6.0", buildId: "0.6.0+0123456789ab", minMacos: "15.0", zipSize: 540_000_000, appSize: 1_780_000_000 },
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["missing build id", { damwhaBuildId: undefined }],
    ["dirty build id", { damwhaBuildId: "0.6.0+0123456789ab-dirty" }],
    ["build id of another version", { damwhaBuildId: "0.5.0+0123456789ab" }],
    ["minMacos as a number (unquoted yaml)", { damwhaMinMacos: 15 }],
    ["bad version", { version: "v0.6.0" }],
    ["no app size", { damwhaAppSize: undefined }],
    ["no zip in files", { files: [{ url: "Damwha-0.6.0-arm64.dmg", size: 1 }] }],
    ["zip without size", { files: [{ url: "Damwha-0.6.0-arm64-mac.zip" }] }],
  ])("refuses %s", (_label, over) => {
    const r = parseManifest({ ...good, ...over });
    expect(r.ok).toBe(false);
  });

  it("refuses non-objects", () => {
    expect(parseManifest(null).ok).toBe(false);
    expect(parseManifest("version: 0.6.0").ok).toBe(false);
  });
});

describe("electron-updater keeps unknown manifest fields (계약)", () => {
  it("passes damwha* fields through its yaml parser untouched", async () => {
    // electron-updater 6.8.9의 providers/Provider.parseUpdateInfo는 js-yaml load 결과를 그대로 돌려준다.
    // 이 계약이 깨지면 buildId·minMacos가 사라진다 — 판을 올리면 이 테스트가 먼저 알린다.
    const { parseUpdateInfo } = await import("electron-updater/out/providers/Provider");
    const yml = [
      "version: 0.6.0",
      "files:",
      "  - url: Damwha-0.6.0-arm64-mac.zip",
      "    sha512: x",
      "    size: 540000000",
      "path: Damwha-0.6.0-arm64-mac.zip",
      "sha512: x",
      "releaseDate: '2026-10-01T00:00:00.000Z'",
      "damwhaBuildId: '0.6.0+0123456789ab'",
      "damwhaMinMacos: '15.0'",
      "damwhaAppSize: 1780000000",
      "",
    ].join("\n");
    const info = parseUpdateInfo(yml, "latest-mac.yml", new URL("https://example.invalid/latest-mac.yml"));
    expect(parseManifest(info)).toMatchObject({ ok: true, manifest: { buildId: "0.6.0+0123456789ab", minMacos: "15.0" } });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/manifest.test.ts`
Expected: FAIL — `../../src/update/manifest` not found.

- [ ] **Step 4: Write minimal implementation**

`desktop/src/update/manifest.ts`:

```ts
import { INSTALLED_VERSION_SHAPE } from "./release-check";

/**
 * electron-updater가 읽은 `latest-mac.yml`(updateInfo)에서 Damwha가 믿는 것만 꺼낸다 (Phase 6c 스펙 §6.2).
 * electron을 import하지 않는다.
 *
 * - `damwhaBuildId` — 설치 뒤 판정의 기준(§5.6). `<version>+<12자리 커밋>`, dirty 금지, version과 같은 판.
 * - `damwhaMinMacos` — 설치 전 확인(§5.5). **문자열**이어야 한다 — 따옴표 없이 쓰면 yaml이 15로 읽는다.
 * - `damwhaAppSize`·zip `size` — 디스크 예산(§7).
 */
export interface Manifest {
  version: string;
  buildId: string;
  minMacos: string;
  zipSize: number;
  appSize: number;
}

const BUILD_ID = /^(\d+\.\d+\.\d+)\+[0-9a-f]{12}$/;
const MACOS = /^\d+(?:\.\d+){0,2}$/;
const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export function parseManifest(info: unknown): { ok: true; manifest: Manifest } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason: `manifest: ${reason}` });
  if (info === null || typeof info !== "object" || Array.isArray(info)) return fail("객체가 아니에요");
  const o = info as Record<string, unknown>;
  const version = o.version;
  if (typeof version !== "string" || !INSTALLED_VERSION_SHAPE.test(version)) return fail(`version ${String(version)}`);
  const buildId = o.damwhaBuildId;
  const b = typeof buildId === "string" ? BUILD_ID.exec(buildId) : null;
  if (b === null || b[1] !== version) return fail(`damwhaBuildId ${String(buildId)}`);
  const minMacos = o.damwhaMinMacos;
  if (typeof minMacos !== "string" || !MACOS.test(minMacos)) return fail(`damwhaMinMacos ${String(minMacos)}`);
  const appSize = o.damwhaAppSize;
  if (!positiveInt(appSize)) return fail(`damwhaAppSize ${String(appSize)}`);
  const files = Array.isArray(o.files) ? o.files : [];
  const zip = files.find(
    (f): f is { url: string; size: unknown } =>
      f !== null && typeof f === "object" && typeof (f as { url?: unknown }).url === "string" &&
      (f as { url: string }).url.endsWith("-arm64-mac.zip"),
  );
  if (zip === undefined) return fail("arm64 mac zip이 없어요");
  if (!positiveInt(zip.size)) return fail(`zip size ${String(zip.size)}`);
  return { ok: true, manifest: { version, buildId: buildId as string, minMacos, zipSize: zip.size, appSize } };
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/manifest.test.ts && pnpm desktop lint`
Expected: PASS. 계약 테스트가 `Cannot find module 'electron-updater/out/providers/Provider'`로 실패하면 멈추고 보고한다 — 6.8.9의 내부 경로가 다르다는 뜻이고 §5.1 호출 계약도 다시 봐야 한다.

- [ ] **Step 6: Commit**

```bash
git add desktop/package.json pnpm-lock.yaml desktop/src/update/manifest.ts desktop/tests/update/manifest.test.ts
git commit -m "feat(desktop): electron-updater 6.8.9를 더하고 manifest의 Damwha 필드를 검증한다

damwhaBuildId·damwhaMinMacos·damwhaAppSize와 zip 크기. electron-updater가 모르는 필드를 그대로
넘긴다는 계약을 테스트로 잠근다(Phase 6c 스펙 §6.2).

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 9: 디스크 예산과 캐시 정리 (§7·§5.7)

**Files:**
- Create: `desktop/src/update/disk-budget.ts`
- Create: `desktop/src/update/updater-cache.ts`
- Test: `desktop/tests/update/disk-budget.test.ts`, `desktop/tests/update/updater-cache.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // disk-budget.ts
  export const MARGIN = 0.1;
  export interface VolumeRef { device: string; apfs: boolean; freeBytes: number }
  export interface Sizes { zip: number; app: number; pgdata: number; data: number }
  export interface Places { cache: VolumeRef; app: VolumeRef; data: VolumeRef }
  export type BudgetStage = "download" | "commit";
  export interface Shortfall { device: string; need: number; free: number }
  export function needsByVolume(stage: BudgetStage, s: Sizes, p: Places): Map<string, number>;
  export function shortfalls(stage: BudgetStage, s: Sizes, p: Places): Shortfall[];
  export function shortfallText(sf: readonly Shortfall[]): string;
  // updater-cache.ts
  export const UPDATER_CACHE_NAME = "damwha-desktop-updater";
  export function pendingVersion(files: readonly string[]): Version | null;
  export function shouldDropPending(files: readonly string[], running: Version, skipped: Version | null): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

`desktop/tests/update/disk-budget.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MARGIN, needsByVolume, shortfalls, shortfallText, type Places, type Sizes } from "../../src/update/disk-budget";

const GB = 1_000_000_000;
const S: Sizes = { zip: 0.52 * GB, app: 1.7 * GB, pgdata: 0.3 * GB, data: 5 * GB };
const one = (free: number, apfs = true): Places => {
  const v = { device: "/dev/disk3s1", apfs, freeBytes: free };
  return { cache: v, app: v, data: v };
};

describe("needsByVolume", () => {
  it("download plans the whole road: 2Z now, then Z+B, B and the data share", () => {
    const n = needsByVolume("download", S, one(100 * GB));
    expect(n.get("/dev/disk3s1")).toBeCloseTo(2 * S.zip + (S.zip + S.app) + S.app + S.pgdata);
  });

  it("commit no longer counts what the download already holds", () => {
    const n = needsByVolume("commit", S, one(100 * GB));
    expect(n.get("/dev/disk3s1")).toBeCloseTo(S.zip + S.app + S.app + S.pgdata);
  });

  it("adds the whole data dir when the data volume is not APFS (clone becomes a copy — D1)", () => {
    const n = needsByVolume("commit", S, one(100 * GB, false));
    expect(n.get("/dev/disk3s1")).toBeCloseTo(S.zip + 2 * S.app + S.pgdata + S.data);
  });

  it("splits by device", () => {
    const cache = { device: "/dev/disk3s1", apfs: true, freeBytes: 100 * GB };
    const app = { device: "/dev/disk5s1", apfs: true, freeBytes: 100 * GB };
    const n = needsByVolume("commit", S, { cache, app, data: cache });
    expect(n.get("/dev/disk3s1")).toBeCloseTo(S.zip + S.app + S.pgdata);
    expect(n.get("/dev/disk5s1")).toBeCloseTo(S.app);
  });
});

describe("shortfalls", () => {
  it("is empty when free covers need plus margin", () => {
    const need = S.zip + 2 * S.app + S.pgdata;
    expect(shortfalls("commit", S, one(need * (1 + MARGIN) + 1))).toEqual([]);
  });

  it("reports the device, the need with margin and the free bytes", () => {
    const need = S.zip + 2 * S.app + S.pgdata;
    const sf = shortfalls("commit", S, one(need));
    expect(sf).toEqual([{ device: "/dev/disk3s1", need: Math.ceil(need * (1 + MARGIN)), free: need }]);
    expect(shortfallText(sf)).toMatch(/디스크 공간이 부족해요 — 남은 용량 [\d.]+ GB, 필요한 용량 [\d.]+ GB/);
  });
});
```

`desktop/tests/update/updater-cache.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pendingVersion, shouldDropPending } from "../../src/update/updater-cache";

describe("pendingVersion", () => {
  it("reads the version from the pending zip name", () => {
    expect(pendingVersion(["update-info.json", "Damwha-0.6.0-arm64-mac.zip"])).toEqual([0, 6, 0]);
    expect(pendingVersion(["update-info.json"])).toBeNull();
    expect(pendingVersion([])).toBeNull();
  });
});

describe("shouldDropPending", () => {
  const files = ["update-info.json", "Damwha-0.6.0-arm64-mac.zip"];
  it("drops when the running build already reached that version", () => {
    expect(shouldDropPending(files, [0, 6, 0], null)).toBe(true);
    expect(shouldDropPending(files, [0, 7, 0], null)).toBe(true);
  });
  it("keeps a newer pending version", () => {
    expect(shouldDropPending(files, [0, 5, 0], null)).toBe(false);
  });
  it("drops a skipped version", () => {
    expect(shouldDropPending(files, [0, 5, 0], [0, 6, 0])).toBe(true);
  });
  it("keeps nothing it cannot read", () => {
    expect(shouldDropPending(["junk"], [0, 5, 0], null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/disk-budget.test.ts tests/update/updater-cache.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`desktop/src/update/disk-budget.ts`:

```ts
import { CAUSES } from "../diagnostics/causes";

/**
 * 업데이트 단계별 디스크 예산 (Phase 6c 스펙 §7, 계획 D1). electron을 import하지 않는다.
 *
 * **예산은 계산하고, 실측은 검증 자료로만 쓴다.** APFS clone 덕에 실제 감소가 작아도 예산을 줄이지 않는다 —
 * 틀리면 막는 쪽으로 틀린다. Z = zip, B = 앱 번들. 논리 점유(코덱스 C8):
 *   download: 캐시에 2Z(받는 중 + electron-updater의 update.zip 복사), 그리고 뒤 단계 몫을 미리 본다.
 *   commit  : 캐시에 Z(Squirrel 사본) + B(해제본), 앱 볼륨에 B(설치 사본), 데이터 볼륨에 가드 몫.
 * 가드 몫(D1) = pgdata(마이그레이션 직전 pg_dump -Fc의 상한) + (APFS가 아니면 data/ 전체 — 스냅샷 cp -c가 복사로 넘어간다).
 */
export const MARGIN = 0.1;

export interface VolumeRef {
  device: string;
  apfs: boolean;
  freeBytes: number;
}
export interface Sizes {
  zip: number;
  app: number;
  pgdata: number;
  data: number;
}
export interface Places {
  cache: VolumeRef;
  app: VolumeRef;
  data: VolumeRef;
}
export type BudgetStage = "download" | "commit";
export interface Shortfall {
  device: string;
  need: number;
  free: number;
}

export function needsByVolume(stage: BudgetStage, s: Sizes, p: Places): Map<string, number> {
  const need = new Map<string, number>();
  const add = (v: VolumeRef, bytes: number) => need.set(v.device, (need.get(v.device) ?? 0) + bytes);
  if (stage === "download") add(p.cache, 2 * s.zip);
  add(p.cache, s.zip + s.app);
  add(p.app, s.app);
  add(p.data, s.pgdata + (p.data.apfs ? 0 : s.data));
  return need;
}

export function shortfalls(stage: BudgetStage, s: Sizes, p: Places): Shortfall[] {
  const free = new Map<string, number>();
  for (const v of [p.cache, p.app, p.data]) free.set(v.device, v.freeBytes);
  const out: Shortfall[] = [];
  for (const [device, bytes] of needsByVolume(stage, s, p)) {
    const need = Math.ceil(bytes * (1 + MARGIN));
    const have = free.get(device) ?? 0;
    if (have < need) out.push({ device, need, free: have });
  }
  return out;
}

const gb = (b: number) => `${(b / 1_000_000_000).toFixed(1)} GB`;

/** P5-C6의 문구를 그대로 쓴다 — 원인 매칭(`/디스크 공간이 부족해요/`)이 같은 줄을 알아본다. */
export function shortfallText(sf: readonly Shortfall[]): string {
  return sf.map((x) => CAUSES.diskFull.text(gb(x.free), gb(x.need))).join(" ");
}
```

`desktop/src/update/updater-cache.ts`:

```ts
import { compareVersions, type Version } from "./release-check";

/**
 * electron-updater 캐시 정리 판정 (Phase 6c 스펙 §5.7). electron을 import하지 않는다.
 *
 * 캐시 루트 `~/Library/Caches/damwha-desktop-updater/`에는 `pending/`(받은 판 — 설치 제안용)과 `update.zip`(다음 차분의
 * 기준 — MacUpdater가 다운로드 뒤 복사)이 있다. **버릴 때는 `pending/`만 비운다.** update.zip을 지우면 다음 업데이트가
 * 전체를 받는다(스펙 §11 C2).
 */
export const UPDATER_CACHE_NAME = "damwha-desktop-updater";
const PENDING_ZIP = /^Damwha-(\d+)\.(\d+)\.(\d+)-arm64-mac\.zip$/;

export function pendingVersion(files: readonly string[]): Version | null {
  for (const f of files) {
    const m = PENDING_ZIP.exec(f);
    if (m === null) continue;
    const v = [Number(m[1]), Number(m[2]), Number(m[3])] as const;
    if (v.every(Number.isSafeInteger)) return v;
  }
  return null;
}

/** 실행 판이 그 판 이상이거나, 사람이 그 판을 건너뛰었으면 버린다. 읽지 못하면 두다. */
export function shouldDropPending(files: readonly string[], running: Version, skipped: Version | null): boolean {
  const v = pendingVersion(files);
  if (v === null) return false;
  if (compareVersions(running, v) >= 0) return true;
  return skipped !== null && compareVersions(skipped, v) === 0;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/disk-budget.test.ts tests/update/updater-cache.test.ts && pnpm desktop lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/update/disk-budget.ts desktop/src/update/updater-cache.ts desktop/tests/update/disk-budget.test.ts desktop/tests/update/updater-cache.test.ts
git commit -m "feat(desktop): 업데이트 단계별 디스크 예산과 캐시 정리 판정

볼륨별 논리 점유에 10% 여유, 데이터 볼륨 몫은 pgdata(+APFS가 아니면 data/). 캐시는 pending/만
버린다(Phase 6c 스펙 §7·§5.7, 계획 D1).

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 10: 상태 기계와 호출 계약 — `install-flow.ts` (§5.1·§5.3)

**Files:**
- Create: `desktop/src/update/install-flow.ts`
- Test: `desktop/tests/update/install-flow.test.ts`

**Interfaces:**
- Consumes: `feedUrlFor`, `macosSatisfies`(Task 7), `parseManifest`, `Manifest`(Task 8), `Eligibility`(Task 4), `AttemptStore`, `InstallAttempt`(Task 5).
- Produces:
  ```ts
  export const STAGING_TIMEOUT_MS = 600_000;
  export const INSTALL_QUIT_TIMEOUT_MS = 30_000;
  export interface Target { version: string; tag: string; releaseId: number | null }
  export interface Job extends Target { jobId: string }
  export type InstallFailReason = "offline" | "disk" | "checksum" | "mismatch" | "os-too-old" | "unsupported-location" | "other";
  export type InstallState =
    | { kind: "idle" }
    | { kind: "resolving"; job: Job }
    | { kind: "downloading"; job: Job; manifest: Manifest; percent: number }
    | { kind: "downloaded" | "committing" | "staging" | "installing"; job: Job; manifest: Manifest }
    | { kind: "failed"; version: string; tag: string; reason: InstallFailReason; detail: string };
  export interface UpdaterPort {
    resolve(feedUrl: string): Promise<{ available: boolean; info: unknown }>;
    download(onProgress: (percent: number) => void): Promise<void>;
    stage(): Promise<void>;
    install(): void;
    onInstallError(cb: (e: unknown) => void): void;
  }
  export interface InstallFlowDeps { port: UpdaterPort; repo: string; eligibility(): Eligibility;
    budget(stage: "download" | "commit", m: Manifest): string | null; attempts: AttemptStore;
    runningBuild(): string | null; currentMacos(): string; newJobId(): string; now(): Date;
    setTimer(fn: () => void, ms: number): () => void; log(line: string): void; onChange(s: InstallState, prev: InstallState): void }
  export interface InstallQuitDeps { destroyWindows(): void; allowQuit(): void; quitNow(): void }
  export interface InstallFlow { state(): InstallState; start(t: Target): Promise<void>;
    commit(): { ok: true } | { ok: false; reason: string }; cancelled(): void;
    proceed(q: InstallQuitDeps): Promise<void>; abandon(): void; heldVersion(): string | null }
  export function createInstallFlow(deps: InstallFlowDeps): InstallFlow;
  export function classifyDownloadError(e: unknown): InstallFailReason;
  ```

- [ ] **Step 1: Write the failing test**

`desktop/tests/update/install-flow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  INSTALL_QUIT_TIMEOUT_MS,
  STAGING_TIMEOUT_MS,
  classifyDownloadError,
  createInstallFlow,
  type InstallFlowDeps,
  type InstallState,
  type UpdaterPort,
} from "../../src/update/install-flow";
import type { InstallAttempt } from "../../src/update/install-attempt";

const INFO = {
  version: "0.6.0",
  files: [{ url: "Damwha-0.6.0-arm64-mac.zip", sha512: "x", size: 540_000_000 }],
  damwhaBuildId: "0.6.0+0123456789ab",
  damwhaMinMacos: "15.0",
  damwhaAppSize: 1_780_000_000,
};
const TARGET = { version: "0.6.0", tag: "v0.6.0", releaseId: 42 };
const OK_EL = { ok: true as const, appPath: "/Applications/Damwha.app", volume: { device: "/dev/disk3s1", internal: true, writable: true, apfs: true } };

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(over: Partial<InstallFlowDeps> = {}, portOver: Partial<UpdaterPort> = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const states: InstallState[] = [];
  const written: InstallAttempt[] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  let installErrorCb: ((e: unknown) => void) | null = null;
  const stage = deferred();
  let jobs = 0;
  const port: UpdaterPort = {
    resolve: async (url) => {
      calls.push(`resolve ${url}`);
      return { available: true, info: INFO };
    },
    download: async (onProgress) => {
      calls.push("download");
      onProgress(50);
      onProgress(100);
    },
    stage: () => {
      calls.push("stage");
      return stage.promise;
    },
    install: () => {
      calls.push("install");
    },
    onInstallError: (cb) => {
      installErrorCb = cb;
    },
    ...portOver,
  };
  const deps: InstallFlowDeps = {
    port,
    repo: "Yjason-K/Damwha",
    eligibility: () => OK_EL,
    budget: () => null,
    attempts: {
      read: () => ({ kind: "none" }),
      write: (a) => {
        calls.push(`write ${a.phase}`);
        written.push(a);
      },
      clear: () => undefined,
    },
    runningBuild: () => "0.5.0+aaaaaaaaaaaa",
    currentMacos: () => "26.1",
    newJobId: () => `job-${++jobs}`,
    now: () => new Date("2026-10-01T00:00:00.000Z"),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    log: (l) => logs.push(l),
    onChange: (s) => states.push(s),
    ...over,
  };
  const quit = {
    destroyWindows: () => calls.push("destroy"),
    allowQuit: () => calls.push("allow"),
    quitNow: () => calls.push("quitNow"),
  };
  const fire = (ms: number) => {
    for (const t of timers) if (t.ms === ms && !t.cancelled) t.fn();
  };
  return { flow: createInstallFlow(deps), calls, logs, states, written, timers, quit, stage, fire, installError: (e: unknown) => installErrorCb?.(e) };
}

async function downloaded(h: ReturnType<typeof harness>) {
  await h.flow.start(TARGET);
  expect(h.flow.state().kind).toBe("downloaded");
}

describe("start → downloaded", () => {
  it("resolves the real tag's feed, checks the manifest, then downloads", async () => {
    const h = harness();
    await h.flow.start(TARGET);
    expect(h.calls).toEqual(["resolve https://github.com/Yjason-K/Damwha/releases/download/v0.6.0/", "download"]);
    expect(h.states.map((s) => s.kind)).toEqual(["resolving", "downloading", "downloading", "downloading", "downloaded"]);
    expect(h.flow.heldVersion()).toBe("0.6.0");
  });

  it.each<[string, Partial<InstallFlowDeps>, Partial<UpdaterPort>, string]>([
    ["not eligible", { eligibility: () => ({ ok: false, reason: "DMG" }) }, {}, "unsupported-location"],
    ["manifest says not available", {}, { resolve: async () => ({ available: false, info: INFO }) }, "mismatch"],
    ["manifest is another version", {}, { resolve: async () => ({ available: true, info: { ...INFO, version: "0.6.1", damwhaBuildId: "0.6.1+0123456789ab" } }) }, "mismatch"],
    ["manifest lacks damwha fields", {}, { resolve: async () => ({ available: true, info: { version: "0.6.0" } }) }, "mismatch"],
    ["macOS too old", { currentMacos: () => "14.7" }, {}, "os-too-old"],
    ["macOS unreadable", { currentMacos: () => "?" }, {}, "os-too-old"],
    ["disk short", { budget: () => "디스크 공간이 부족해요 — 남은 용량 1.0 GB, 필요한 용량 3.0 GB." }, {}, "disk"],
    ["resolve rejects", {}, { resolve: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); } }, "offline"],
  ])("fails without downloading when %s", async (_label, over, portOver, reason) => {
    const h = harness(over, portOver);
    await h.flow.start(TARGET);
    expect(h.calls).not.toContain("download");
    expect(h.flow.state()).toMatchObject({ kind: "failed", version: "0.6.0", reason });
  });

  it("classifies download failures", () => {
    expect(classifyDownloadError(Object.assign(new Error("x"), { code: "ENOSPC" }))).toBe("disk");
    expect(classifyDownloadError(Object.assign(new Error("sha512 checksum mismatch"), { code: "ERR_CHECKSUM_MISMATCH" }))).toBe("checksum");
    expect(classifyDownloadError(Object.assign(new Error("net::ERR_INTERNET_DISCONNECTED"), {}))).toBe("offline");
    expect(classifyDownloadError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe("offline");
    expect(classifyDownloadError(new Error("무엇"))).toBe("other");
  });

  it("ignores a second start while one is running (Review Focus 3)", async () => {
    const gate = deferred();
    const h = harness({}, { download: async () => { await gate.promise; } });
    const first = h.flow.start(TARGET);
    await flush();
    await h.flow.start({ ...TARGET, version: "0.7.0", tag: "v0.7.0" });
    gate.resolve();
    await first;
    expect(h.calls.filter((c) => c.startsWith("resolve"))).toHaveLength(1);
    expect(h.flow.state()).toMatchObject({ kind: "downloaded", job: { version: "0.6.0" } });
  });

  it("retries after a failure with a new job id (Review Focus 5)", async () => {
    let fail = true;
    const h = harness({}, {
      download: async () => {
        if (fail) throw Object.assign(new Error("net::ERR_NETWORK_CHANGED"), {});
      },
    });
    await h.flow.start(TARGET);
    expect(h.flow.state()).toMatchObject({ kind: "failed", reason: "offline" });
    fail = false;
    await h.flow.start(TARGET);
    expect(h.flow.state()).toMatchObject({ kind: "downloaded", job: { jobId: "job-2" } });
  });

  it("drops late download events after abandon (Review Focus 1)", async () => {
    const gate = deferred();
    let progress: ((p: number) => void) | null = null;
    const h = harness({}, {
      download: async (onProgress) => {
        progress = onProgress;
        await gate.promise;
      },
    });
    const run = h.flow.start(TARGET);
    await flush();
    h.flow.abandon();
    progress!(80);
    gate.resolve();
    await run;
    expect(h.flow.state()).toEqual({ kind: "idle" });
    expect(h.flow.heldVersion()).toBeNull();
  });
});

describe("commit / cancelled", () => {
  it("moves downloaded → committing once; a second commit is refused (Review Focus 2)", async () => {
    const h = harness();
    await downloaded(h);
    expect(h.flow.commit()).toEqual({ ok: true });
    expect(h.flow.state().kind).toBe("committing");
    expect(h.flow.commit()).toMatchObject({ ok: false });
  });

  it("re-checks eligibility at commit (Review Focus 4)", async () => {
    let el: ReturnType<InstallFlowDeps["eligibility"]> = OK_EL;
    const h = harness({ eligibility: () => el });
    await downloaded(h);
    el = { ok: false, reason: "다운로드 폴더나 DMG에서 바로 실행 중이에요" };
    expect(h.flow.commit()).toEqual({ ok: false, reason: "다운로드 폴더나 DMG에서 바로 실행 중이에요" });
    expect(h.flow.state().kind).toBe("downloaded");
  });

  it("refuses commit when nothing is downloaded", () => {
    expect(harness().flow.commit()).toMatchObject({ ok: false });
  });

  it("goes back to downloaded when the quit is cancelled", async () => {
    const h = harness();
    await downloaded(h);
    h.flow.commit();
    h.flow.cancelled();
    expect(h.flow.state().kind).toBe("downloaded");
  });
});

describe("proceed — staging and installing", () => {
  async function committed(over: Partial<InstallFlowDeps> = {}, portOver: Partial<UpdaterPort> = {}) {
    const h = harness(over, portOver);
    await downloaded(h);
    h.flow.commit();
    return h;
  }

  it("writes the attempt before staging, then destroys, allows and installs in that order", async () => {
    const h = await committed();
    const p = h.flow.proceed(h.quit);
    await flush();
    expect(h.calls.slice(-2)).toEqual(["write staging", "stage"]);
    expect(h.flow.state().kind).toBe("staging");
    h.stage.resolve();
    await p;
    expect(h.calls.slice(-6)).toEqual(["write staging", "stage", "write installing", "destroy", "allow", "install"]);
    expect(h.flow.state().kind).toBe("installing");
    expect(h.written[0]).toEqual({
      jobId: "job-1",
      fromBuild: "0.5.0+aaaaaaaaaaaa",
      expectedBuild: "0.6.0+0123456789ab",
      tag: "v0.6.0",
      phase: "staging",
      at: "2026-10-01T00:00:00.000Z",
    });
    expect(h.calls).not.toContain("quitNow");
  });

  it("never stages when the attempt cannot be written", async () => {
    const h = await committed({
      attempts: { read: () => ({ kind: "none" }), write: () => { throw new Error("EACCES"); }, clear: () => undefined },
    });
    await h.flow.proceed(h.quit);
    expect(h.calls).not.toContain("stage");
    expect(h.calls.at(-1)).toBe("quitNow");
  });

  it("never stages when the commit-time budget is short", async () => {
    let short: string | null = null;
    const h = await committed({ budget: (stage) => (stage === "commit" ? short : null) });
    short = "디스크 공간이 부족해요 — 남은 용량 1.0 GB, 필요한 용량 4.9 GB.";
    await h.flow.proceed(h.quit);
    expect(h.calls).not.toContain("stage");
    expect(h.calls.at(-1)).toBe("quitNow");
  });

  it("never stages without a running build id (dev)", async () => {
    const h = await committed({ runningBuild: () => null });
    await h.flow.proceed(h.quit);
    expect(h.calls).not.toContain("stage");
    expect(h.calls.at(-1)).toBe("quitNow");
  });

  it("falls back to a plain quit with outcome-unknown when staging rejects", async () => {
    const h = await committed();
    const p = h.flow.proceed(h.quit);
    await flush();
    h.stage.reject(new Error("Squirrel: 서명 불일치"));
    await p;
    expect(h.written.at(-1)?.phase).toBe("outcome-unknown");
    expect(h.calls).not.toContain("install");
    expect(h.calls.at(-1)).toBe("quitNow");
  });

  it("falls back when staging exceeds its limit", async () => {
    const h = await committed();
    const p = h.flow.proceed(h.quit);
    await flush();
    h.fire(STAGING_TIMEOUT_MS);
    await p;
    expect(h.written.at(-1)?.phase).toBe("outcome-unknown");
    expect(h.calls).not.toContain("install");
    expect(h.calls.at(-1)).toBe("quitNow");
  });

  it("falls back when stage throws synchronously", async () => {
    const h = await committed({}, { stage: () => { throw new Error("no feed"); } });
    await h.flow.proceed(h.quit);
    expect(h.calls).not.toContain("install");
    expect(h.calls.at(-1)).toBe("quitNow");
  });

  it("falls back once when install throws, errors later, or never quits", async () => {
    for (const how of ["throw", "error", "timeout"] as const) {
      const h = await committed({}, how === "throw" ? { install: () => { throw new Error("relaunch 실패"); } } : {});
      const p = h.flow.proceed(h.quit);
      await flush();
      h.stage.resolve();
      await p;
      if (how === "error") {
        h.installError(new Error("ShipIt 실패"));
        h.installError(new Error("두 번째"));
      }
      if (how === "timeout") h.fire(INSTALL_QUIT_TIMEOUT_MS);
      expect(h.calls.filter((c) => c === "quitNow")).toHaveLength(1);
      expect(h.written.at(-1)?.phase).toBe("outcome-unknown");
    }
  });

  it("stages at most once per run", async () => {
    const h = await committed();
    const p = h.flow.proceed(h.quit);
    await flush();
    h.stage.resolve();
    await p;
    await h.flow.proceed(h.quit);
    expect(h.calls.filter((c) => c === "stage")).toHaveLength(1);
    expect(h.calls.at(-1)).toBe("quitNow");
  });

  it("quits plainly when proceed is called outside committing", async () => {
    const h = harness();
    await h.flow.proceed(h.quit);
    expect(h.calls).toEqual(["quitNow"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/install-flow.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`desktop/src/update/install-flow.ts`:

```ts
import type { AttemptPhase, AttemptStore, InstallAttempt } from "./install-attempt";
import type { Eligibility } from "./install-eligibility";
import { parseManifest, type Manifest } from "./manifest";
import { feedUrlFor, macosSatisfies } from "./release-check";

/**
 * 앱 안 업데이트의 상태 기계 (Phase 6c 스펙 §5.1·§5.3). electron·electron-updater를 값으로 import하지 않는다 —
 * 그 둘에 닿는 것은 `UpdaterPort`(platform/updater-port.ts)다.
 *
 * 호출 계약(electron-updater 6.8.9에 고정 — 판을 올리면 다시 확인한다):
 *   resolving   : electron-updater setFeedURL({generic, 실제 태그, useMultipleRangeRequest:false}) → checkForUpdates()
 *                 → manifest 버전 = 고른 버전, isUpdateAvailable. 아니면 받지 않는다. (setFeedURL 뒤 바로 downloadUpdate()는
 *                 "Please check update first"로 거절된다 — 코덱스 R2)
 *   downloading : electron-updater downloadUpdate(). autoInstallOnAppQuit=false라 zip을 받고 127.0.0.1 proxy에 내장 feed를
 *                 맞추지만 **내장 준비는 부르지 않는다**.
 *   staging     : 내장 autoUpdater listener 먼저, checkForUpdates() **정확히 한 번**. update-downloaded가 준비 완료.
 *   installing  : 모든 창 destroy() → allow → 내장 quitAndInstall(). 창이 없으면 Electron이 즉시 교체·재실행한다(스파이크 S3).
 * electron-updater의 quitAndInstall()은 부르지 않는다 — 준비 뒤 자동 설치 listener를 붙여 우리 흐름을 우회한다(R3).
 *
 * "나중에"는 캐시만 남긴다. 준비는 설치를 누른 순간에만 한다 — 준비된 예약은 크래시·강제 종료에도 교체를 일으킨다(C3).
 * 한 실행에 준비는 한 번(C5). 작업 ID가 바뀐 뒤 도착한 이벤트는 버린다(C11).
 */
export const STAGING_TIMEOUT_MS = 600_000;
export const INSTALL_QUIT_TIMEOUT_MS = 30_000;

export interface Target {
  version: string;
  tag: string;
  releaseId: number | null;
}
export interface Job extends Target {
  jobId: string;
}
export type InstallFailReason = "offline" | "disk" | "checksum" | "mismatch" | "os-too-old" | "unsupported-location" | "other";

export type InstallState =
  | { kind: "idle" }
  | { kind: "resolving"; job: Job }
  | { kind: "downloading"; job: Job; manifest: Manifest; percent: number }
  | { kind: "downloaded" | "committing" | "staging" | "installing"; job: Job; manifest: Manifest }
  | { kind: "failed"; version: string; tag: string; reason: InstallFailReason; detail: string };

export interface UpdaterPort {
  resolve(feedUrl: string): Promise<{ available: boolean; info: unknown }>;
  download(onProgress: (percent: number) => void): Promise<void>;
  /** 내장 준비. listener를 먼저 달고 checkForUpdates() 한 번. update-downloaded에 resolve, error에 reject. */
  stage(): Promise<void>;
  /** 내장 quitAndInstall(). 동기로 던질 수 있다. 이후 비동기 오류는 onInstallError. */
  install(): void;
  onInstallError(cb: (e: unknown) => void): void;
}

export interface InstallFlowDeps {
  port: UpdaterPort;
  repo: string;
  eligibility(): Eligibility;
  /** 부족하면 문구, 충분하면 null. 판정하지 못하면 던진다. */
  budget(stage: "download" | "commit", m: Manifest): string | null;
  attempts: AttemptStore;
  runningBuild(): string | null;
  currentMacos(): string;
  newJobId(): string;
  now(): Date;
  /** 타이머를 걸고 취소 함수를 돌려준다. */
  setTimer(fn: () => void, ms: number): () => void;
  log(line: string): void;
  onChange(s: InstallState, prev: InstallState): void;
}

export interface InstallQuitDeps {
  destroyWindows(): void;
  /** flows.quit.allow(). 내장 quitAndInstall 바로 앞, 같은 동기 구간에서만. */
  allowQuit(): void;
  /** 일반 종료(allow + app.quit). */
  quitNow(): void;
}

export interface InstallFlow {
  state(): InstallState;
  start(t: Target): Promise<void>;
  commit(): { ok: true } | { ok: false; reason: string };
  cancelled(): void;
  proceed(q: InstallQuitDeps): Promise<void>;
  abandon(): void;
  /** 받는 중이거나 받아 둔(또는 설치로 가는) 판. 있으면 새 버전 알림 대신 "더 새 판" 안내만 한다. */
  heldVersion(): string | null;
}

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const NETWORK_CODES = new Set(["ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EPIPE"]);

export function classifyDownloadError(e: unknown): InstallFailReason {
  const code = e !== null && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  if (code === "ENOSPC") return "disk";
  if (code === "ERR_CHECKSUM_MISMATCH" || /sha512 checksum mismatch/i.test(reasonOf(e))) return "checksum";
  if ((typeof code === "string" && NETWORK_CODES.has(code)) || /net::ERR_/.test(reasonOf(e))) return "offline";
  return "other";
}

function withTimeout(
  run: () => Promise<void>,
  ms: number,
  setTimer: InstallFlowDeps["setTimer"],
): Promise<{ ok: true } | { ok: false; why: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { ok: true } | { ok: false; why: string }) => {
      if (done) return;
      done = true;
      cancel();
      resolve(r);
    };
    const cancel = setTimer(() => finish({ ok: false, why: `${ms / 1000}초 안에 준비가 끝나지 않았어요` }), ms);
    Promise.resolve()
      .then(run)
      .then(
        () => finish({ ok: true }),
        (e: unknown) => finish({ ok: false, why: reasonOf(e) }),
      );
  });
}

export function createInstallFlow(deps: InstallFlowDeps): InstallFlow {
  let st: InstallState = { kind: "idle" };
  let stagedOnce = false;

  const set = (next: InstallState) => {
    const prev = st;
    st = next;
    deps.onChange(next, prev);
  };
  const jobOf = (s: InstallState): Job | null => ("job" in s ? s.job : null);
  const live = (job: Job) => jobOf(st)?.jobId === job.jobId;
  const fail = (job: Target, reason: InstallFailReason, detail: string) => {
    deps.log(`업데이트 ${job.version}: 실패 (${reason}) — ${detail}`);
    set({ kind: "failed", version: job.version, tag: job.tag, reason, detail });
  };

  return {
    state: () => st,

    async start(t) {
      if (st.kind !== "idle" && st.kind !== "failed") {
        deps.log(`업데이트: 이미 진행 중이에요(${st.kind}) — ${t.version} 요청을 버려요`);
        return;
      }
      const el = deps.eligibility();
      if (!el.ok) return fail(t, "unsupported-location", el.reason);
      const job: Job = { ...t, jobId: deps.newJobId() };
      set({ kind: "resolving", job });

      let resolved: { available: boolean; info: unknown };
      try {
        resolved = await deps.port.resolve(feedUrlFor(t.tag, deps.repo));
      } catch (e) {
        if (live(job)) fail(job, classifyDownloadError(e) === "other" ? "offline" : classifyDownloadError(e), reasonOf(e));
        return;
      }
      if (!live(job)) return;
      const parsed = parseManifest(resolved.info);
      if (!parsed.ok) return fail(job, "mismatch", parsed.reason);
      const m = parsed.manifest;
      if (!resolved.available || m.version !== t.version) {
        return fail(job, "mismatch", `manifest ${m.version}(available=${resolved.available})가 고른 ${t.version}과 달라요`);
      }
      const current = deps.currentMacos();
      if (macosSatisfies(current, m.minMacos) !== true) {
        return fail(job, "os-too-old", `이 판은 macOS ${m.minMacos} 이상이 필요해요 (지금 ${current})`);
      }
      let short: string | null;
      try {
        short = deps.budget("download", m);
      } catch (e) {
        return fail(job, "disk", `디스크 공간을 확인하지 못했어요 — ${reasonOf(e)}`);
      }
      if (short !== null) return fail(job, "disk", short);

      set({ kind: "downloading", job, manifest: m, percent: 0 });
      try {
        await deps.port.download((p) => {
          if (!live(job) || st.kind !== "downloading") return;
          const percent = Math.max(0, Math.min(100, Math.floor(p)));
          if (percent !== st.percent) set({ kind: "downloading", job, manifest: m, percent });
        });
      } catch (e) {
        if (live(job)) fail(job, classifyDownloadError(e), reasonOf(e));
        return;
      }
      if (!live(job) || st.kind !== "downloading") return;
      set({ kind: "downloaded", job, manifest: m });
    },

    commit() {
      if (st.kind !== "downloaded") return { ok: false, reason: `받아 둔 업데이트가 없어요 (${st.kind})` };
      const el = deps.eligibility();
      if (!el.ok) return { ok: false, reason: el.reason };
      set({ kind: "committing", job: st.job, manifest: st.manifest });
      return { ok: true };
    },

    cancelled() {
      if (st.kind === "committing") set({ kind: "downloaded", job: st.job, manifest: st.manifest });
    },

    abandon() {
      if (st.kind === "resolving" || st.kind === "downloading") {
        deps.log(`업데이트 ${st.job.version}: 종료가 시작돼 받기를 그만둬요`);
        set({ kind: "idle" });
      }
    },

    heldVersion() {
      const job = jobOf(st);
      return job === null ? null : job.version;
    },

    async proceed(q) {
      if (st.kind !== "committing" || stagedOnce) {
        deps.log(`업데이트: 설치할 상태가 아니에요(${st.kind}${stagedOnce ? ", 이미 한 번 준비함" : ""}) — 일반 종료`);
        q.quitNow();
        return;
      }
      const { job, manifest } = st;

      let short: string | null;
      try {
        short = deps.budget("commit", manifest);
      } catch (e) {
        short = `디스크 공간을 확인하지 못했어요 — ${reasonOf(e)}`;
      }
      if (short !== null) {
        fail(job, "disk", short);
        q.quitNow();
        return;
      }
      const from = deps.runningBuild();
      if (from === null) {
        deps.log("업데이트: 실행 중인 빌드를 몰라 설치하지 않아요 — 일반 종료");
        q.quitNow();
        return;
      }
      const attempt: InstallAttempt = {
        jobId: job.jobId,
        fromBuild: from,
        expectedBuild: manifest.buildId,
        tag: job.tag,
        phase: "staging",
        at: deps.now().toISOString(),
      };
      try {
        deps.attempts.write(attempt);
      } catch (e) {
        deps.log(`업데이트: 설치 기록을 쓰지 못해 설치하지 않아요 — ${reasonOf(e)}`);
        q.quitNow();
        return;
      }
      const writePhase = (phase: AttemptPhase) => {
        try {
          deps.attempts.write({ ...attempt, phase, at: deps.now().toISOString() });
        } catch (e) {
          deps.log(`업데이트: 설치 기록(${phase})을 쓰지 못했어요 — ${reasonOf(e)}`);
        }
      };
      let finished = false;
      const unknown = (why: string) => {
        if (finished) return;
        finished = true;
        deps.log(`업데이트 ${job.version}: ${why} — 일반 종료, 결과는 다음 기동이 판정해요`);
        writePhase("outcome-unknown");
        q.quitNow();
      };

      stagedOnce = true;
      set({ kind: "staging", job, manifest });
      const staged = await withTimeout(() => deps.port.stage(), STAGING_TIMEOUT_MS, deps.setTimer);
      if (!staged.ok) return unknown(`준비 실패 (${staged.why})`);

      writePhase("installing");
      set({ kind: "installing", job, manifest });
      let cancelTimer = () => undefined as void;
      deps.port.onInstallError((e) => {
        cancelTimer();
        unknown(`설치 요청 오류 — ${reasonOf(e)}`);
      });
      cancelTimer = deps.setTimer(() => unknown(`${INSTALL_QUIT_TIMEOUT_MS / 1000}초 안에 종료되지 않았어요`), INSTALL_QUIT_TIMEOUT_MS);
      q.destroyWindows();
      // allow와 install 사이에 await가 없다 — 그 사이의 before-quit은 게이트가 막는다(스펙 §5.3).
      q.allowQuit();
      try {
        deps.port.install();
      } catch (e) {
        cancelTimer();
        unknown(`설치 요청이 던졌어요 — ${reasonOf(e)}`);
      }
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/install-flow.test.ts && pnpm desktop lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/update/install-flow.ts desktop/tests/update/install-flow.test.ts
git commit -m "feat(desktop): 앱 안 업데이트 상태 기계와 호출 계약

resolving → downloading → downloaded → committing → staging → installing. manifest 대조, 설치 전
기록, 한 번뿐인 준비, allow 직후 설치, 준비·설치 실패의 일반 종료(outcome-unknown)
(Phase 6c 스펙 §5.1·§5.3).

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 11: 알림 — 대화상자와 `update-flow.ts` (§5.5)

**Files:**
- Modify: `desktop/src/update/dialogs.ts`
- Modify: `desktop/src/update/update-flow.ts` (전체 교체)
- Modify: `desktop/tests/update/update-flow.test.ts` (harness·한 단언)
- Test: `desktop/tests/update/dialogs.test.ts`, `desktop/tests/update/update-flow.test.ts` (추가)

**Interfaces:**
- Consumes: `CheckResult`의 `tag`·`releaseId`·`autoInstall`(Task 7).
- Produces:
  ```ts
  // dialogs.ts
  export type NewerChoice = "install" | "open" | "later" | "skip";
  export const INSTALL_BUTTONS: readonly ["다운로드 후 설치", "나중에", "이 버전 건너뛰기"];
  export function newerDialogOptions(current: string, latest: string, autoInstall?: boolean): MessageBoxOptions;
  export function newerChoice(response: number, autoInstall?: boolean): NewerChoice;
  export type DownloadedChoice = "restart" | "later";
  export const DOWNLOADED_BUTTONS: readonly ["재시작하여 업데이트", "나중에"];
  export function downloadedDialogOptions(version: string): MessageBoxOptions;
  export function downloadedChoice(response: number): DownloadedChoice;
  export type InstallFailedChoice = "open" | "ok";
  export function installFailedDialogOptions(version: string, detail: string): MessageBoxOptions;
  export function installFailedChoice(response: number): InstallFailedChoice;
  export function laterReleaseDialogOptions(newer: string, held: string): MessageBoxOptions;
  export function installBlockedDialogOptions(reason: string): MessageBoxOptions;
  // update-flow.ts — UpdateFlowDeps에 더함
  showNewer(info: { current: string; latest: string; autoInstall: boolean }): Promise<NewerChoice>;
  canInstall(): boolean; heldVersion(): string | null;
  startInstall(t: { version: string; tag: string; releaseId: number | null }): void;
  showLater(info: { newer: string; held: string }): Promise<void>;
  showDownloaded(version: string): Promise<DownloadedChoice>;
  showInstallFailed(info: { version: string; detail: string }): Promise<InstallFailedChoice>;
  requestRestart(): void;
  // UpdateFlow에 더함
  announceDownloaded(version: string): Promise<void>;
  announceFailed(info: { version: string; detail: string; url: string }): Promise<void>;
  ```

- [ ] **Step 1: dialogs 테스트를 더한다**

`desktop/tests/update/dialogs.test.ts`의 import에 `INSTALL_BUTTONS, DOWNLOADED_BUTTONS, downloadedChoice, downloadedDialogOptions, installBlockedDialogOptions, installFailedChoice, installFailedDialogOptions, laterReleaseDialogOptions`를 더하고 끝에:

```ts
describe("자동 설치 (Phase 6c §5.5)", () => {
  it("offers 다운로드 후 설치 first with Escape as 나중에", () => {
    const o = newerDialogOptions("0.5.0", "0.6.0", true);
    expect(o.buttons).toEqual([...INSTALL_BUTTONS]);
    expect(o.buttons).toEqual(["다운로드 후 설치", "나중에", "이 버전 건너뛰기"]);
    expect([o.defaultId, o.cancelId]).toEqual([0, 1]);
    expect(o.message).toBe("새 버전 0.6.0이 나왔어요");
  });

  it("keeps the 6b-1 dialog when auto install is off", () => {
    expect(newerDialogOptions("0.5.0", "0.6.0", false)).toEqual(newerDialogOptions("0.5.0", "0.6.0"));
  });

  it("maps button 0 to install only when auto install was offered", () => {
    expect(newerChoice(0, true)).toBe("install");
    expect(newerChoice(0, false)).toBe("open");
    expect(newerChoice(2, true)).toBe("skip");
    expect(newerChoice(1, true)).toBe("later");
  });

  it("asks to restart once downloaded", () => {
    const o = downloadedDialogOptions("0.6.0");
    expect(o.buttons).toEqual([...DOWNLOADED_BUTTONS]);
    expect(o.buttons).toEqual(["재시작하여 업데이트", "나중에"]);
    expect([o.defaultId, o.cancelId]).toEqual([0, 1]);
    expect(o.message).toBe("담화 0.6.0을 받았어요");
    expect(downloadedChoice(0)).toBe("restart");
    expect(downloadedChoice(1)).toBe("later");
    expect(downloadedChoice(-1)).toBe("later");
  });

  it("says a failure and offers the page, defaulting to 확인", () => {
    const o = installFailedDialogOptions("0.6.0", "디스크 공간이 부족해요 — 남은 용량 1.0 GB, 필요한 용량 3.0 GB.");
    expect(o.message).toBe("업데이트 0.6.0을 받지 못했어요");
    expect(o.buttons).toEqual(["다운로드 페이지 열기", "확인"]);
    expect([o.defaultId, o.cancelId]).toEqual([1, 1]);
    expect(installFailedChoice(0)).toBe("open");
    expect(installFailedChoice(1)).toBe("ok");
  });

  it("explains a later release or the same one being held", () => {
    expect(laterReleaseDialogOptions("0.7.0", "0.6.0")).toMatchObject({ message: "새 버전 0.7.0이 나왔어요", buttons: ["확인"] });
    expect(laterReleaseDialogOptions("0.7.0", "0.6.0").detail).toContain("0.6.0을 설치한 뒤");
    expect(laterReleaseDialogOptions("0.6.0", "0.6.0").message).toBe("담화 0.6.0을 이미 받고 있거나 받아 뒀어요");
    expect(installBlockedDialogOptions("되돌리기가 예약돼 있어요")).toMatchObject({ message: "지금은 업데이트할 수 없어요", buttons: ["확인"] });
  });
});
```

- [ ] **Step 2: update-flow 테스트의 harness를 새 deps로 늘리고 새 테스트를 더한다**

`desktop/tests/update/update-flow.test.ts`:

`newer()`를 새 필드를 가진 모양으로 바꾼다:

```ts
const newer = (version = "0.4.0", autoInstall = false): CheckResult => ({
  kind: "newer",
  version,
  url: `https://github.com/Yjason-K/Damwha/releases/tag/v${version}`,
  tag: `v${version}`,
  releaseId: 1,
  autoInstall,
});
```

`harness`의 `state`에 `held: null as string | null, can: true, downloadedAnswer: "later" as "restart" | "later", failedAnswer: "ok" as "open" | "ok"`를 더하고 `deps`에 더한다:

```ts
    canInstall: () => state.can,
    heldVersion: () => state.held,
    startInstall: vi.fn(),
    showLater: vi.fn(async () => undefined),
    showDownloaded: vi.fn(async () => state.downloadedAnswer),
    showInstallFailed: vi.fn(async () => state.failedAnswer),
    requestRestart: vi.fn(),
```

52줄 근처 `expect(h.deps.showNewer).toHaveBeenCalledWith({ current: "0.3.1", latest: "0.4.0" });`를:

```ts
    expect(h.deps.showNewer).toHaveBeenCalledWith({ current: "0.3.1", latest: "0.4.0", autoInstall: false });
```

파일 끝에 더한다:

```ts
describe("앱 안 설치 (Phase 6c §5.5)", () => {
  it("offers install only when the release has the assets and this run can install", async () => {
    const h = harness({ check: vi.fn(async () => newer("0.4.0", true)) });
    await h.flow.autoCheck();
    expect(h.deps.showNewer).toHaveBeenLastCalledWith({ current: "0.3.1", latest: "0.4.0", autoInstall: true });

    const h2 = harness({ check: vi.fn(async () => newer("0.4.0", true)) });
    h2.state.can = false;
    await h2.flow.autoCheck();
    expect(h2.deps.showNewer).toHaveBeenLastCalledWith({ current: "0.3.1", latest: "0.4.0", autoInstall: false });
  });

  it("starts the install with the real tag when chosen", async () => {
    const h = harness({ check: vi.fn(async () => newer("0.4.0", true)), showNewer: vi.fn(async () => "install" as const) });
    await h.flow.manualCheck();
    expect(h.deps.startInstall).toHaveBeenCalledWith({ version: "0.4.0", tag: "v0.4.0", releaseId: 1 });
    expect(h.opened).toEqual([]);
  });

  it("only explains when a version is already held (Review Focus 3)", async () => {
    const h = harness({ check: vi.fn(async () => newer("0.5.0", true)) });
    h.state.held = "0.4.0";
    await h.flow.manualCheck();
    expect(h.deps.showNewer).not.toHaveBeenCalled();
    expect(h.deps.showLater).toHaveBeenCalledWith({ newer: "0.5.0", held: "0.4.0" });
    expect(h.deps.startInstall).not.toHaveBeenCalled();
  });

  it("asks to restart when downloaded and requests it on restart", async () => {
    const h = harness();
    h.state.downloadedAnswer = "restart";
    await h.flow.announceDownloaded("0.4.0");
    expect(h.deps.showDownloaded).toHaveBeenCalledWith("0.4.0");
    expect(h.deps.requestRestart).toHaveBeenCalledTimes(1);
  });

  it("holds the downloaded question while recording, with no other modal and before attach", async () => {
    for (const over of [
      { isRecording: async () => true },
      { isOtherModalOpen: () => true },
      { isAttached: () => false },
      { isShuttingDown: () => true },
    ] satisfies Partial<UpdateFlowDeps>[]) {
      const h = harness(over);
      await h.flow.announceDownloaded("0.4.0");
      expect(h.deps.showDownloaded).not.toHaveBeenCalled();
    }
  });

  it("shares one presentation lock with the newer dialog (Review Focus 2)", async () => {
    const gate = deferred<NewerChoice>();
    const h = harness({ check: vi.fn(async () => newer("0.4.0", true)), showNewer: vi.fn(() => gate.promise) });
    const manual = h.flow.manualCheck();
    await new Promise((r) => setTimeout(r, 0));
    await h.flow.announceDownloaded("0.4.0");
    expect(h.deps.showDownloaded).not.toHaveBeenCalled();
    gate.resolve("later");
    await manual;
  });

  it("drops a restart answer if the app started quitting meanwhile", async () => {
    let quitting = false;
    const h = harness({
      isShuttingDown: () => quitting,
      showDownloaded: vi.fn(async () => {
        quitting = true;
        return "restart" as const;
      }),
    });
    await h.flow.announceDownloaded("0.4.0");
    expect(h.deps.requestRestart).not.toHaveBeenCalled();
  });

  it("says a failure and opens the page when asked", async () => {
    const h = harness();
    h.state.failedAnswer = "open";
    await h.flow.announceFailed({ version: "0.4.0", detail: "끊겼어요", url: URL_040 });
    expect(h.deps.showInstallFailed).toHaveBeenCalledWith({ version: "0.4.0", detail: "끊겼어요" });
    expect(h.opened).toEqual([URL_040]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/dialogs.test.ts tests/update/update-flow.test.ts`
Expected: FAIL — 새 함수 없음, `autoInstall` 단언 불일치, `announceDownloaded is not a function`.

- [ ] **Step 4: dialogs.ts에 더한다**

`desktop/src/update/dialogs.ts`의 `NewerChoice`·`newerDialogOptions`·`newerChoice`를 바꾸고 새 함수를 더한다:

```ts
export type NewerChoice = "install" | "open" | "later" | "skip";

export const NEWER_BUTTONS = ["다운로드 페이지 열기", "나중에", "이 버전 건너뛰기"] as const;
/** 자동 설치 자산이 있고 이 실행이 설치할 수 있을 때 (Phase 6c 스펙 §5.5). */
export const INSTALL_BUTTONS = ["다운로드 후 설치", "나중에", "이 버전 건너뛰기"] as const;

export function newerDialogOptions(current: string, latest: string, autoInstall = false): MessageBoxOptions {
  return {
    type: "info",
    message: `새 버전 ${latest}이 나왔어요`,
    detail: autoInstall
      ? `지금 ${current}을 쓰고 있어요. 받는 동안에도 계속 쓸 수 있고, 다 받으면 재시작할지 물어볼게요.`
      : `지금 ${current}을 쓰고 있어요. 다운로드 페이지에서 DMG를 받아 설치해 주세요.`,
    buttons: autoInstall ? [...INSTALL_BUTTONS] : [...NEWER_BUTTONS],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
}

export function newerChoice(response: number, autoInstall = false): NewerChoice {
  if (response === 0) return autoInstall ? "install" : "open";
  if (response === 2) return "skip";
  return "later";
}

export type DownloadedChoice = "restart" | "later";
export const DOWNLOADED_BUTTONS = ["재시작하여 업데이트", "나중에"] as const;

export function downloadedDialogOptions(version: string): MessageBoxOptions {
  return {
    type: "info",
    message: `담화 ${version}을 받았어요`,
    detail:
      "재시작하면 업데이트돼요. 녹음과 분석은 앱을 끌 때처럼 안전하게 마무리해요. 나중에 하려면 앱 메뉴의 “재시작하여 업데이트”를 누르세요.",
    buttons: [...DOWNLOADED_BUTTONS],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
}

export function downloadedChoice(response: number): DownloadedChoice {
  return response === 0 ? "restart" : "later";
}

export type InstallFailedChoice = "open" | "ok";

export function installFailedDialogOptions(version: string, detail: string): MessageBoxOptions {
  return {
    type: "warning",
    message: `업데이트 ${version}을 받지 못했어요`,
    detail: `${detail} 다운로드 페이지에서 직접 받을 수도 있어요.`,
    buttons: ["다운로드 페이지 열기", "확인"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

export function installFailedChoice(response: number): InstallFailedChoice {
  return response === 0 ? "open" : "ok";
}

export function laterReleaseDialogOptions(newer: string, held: string): MessageBoxOptions {
  return newer === held
    ? {
        type: "info",
        message: `담화 ${held}을 이미 받고 있거나 받아 뒀어요`,
        detail: "다 받으면 재시작할지 물어볼게요. 앱 메뉴의 “재시작하여 업데이트”로도 설치할 수 있어요.",
        buttons: ["확인"],
      }
    : {
        type: "info",
        message: `새 버전 ${newer}이 나왔어요`,
        detail: `지금 받아 둔 ${held}을 설치한 뒤 다시 확인해 주세요.`,
        buttons: ["확인"],
      };
}

export function installBlockedDialogOptions(reason: string): MessageBoxOptions {
  return { type: "info", message: "지금은 업데이트할 수 없어요", detail: reason, buttons: ["확인"] };
}
```

- [ ] **Step 5: update-flow.ts를 교체한다**

`desktop/src/update/update-flow.ts` 전체:

```ts
import { failureMessage, type DownloadedChoice, type InstallFailedChoice, type NewerChoice } from "./dialogs";
import { DEFAULT_RATE_LIMIT_WAIT_MS, type CheckResult } from "./release-check";

/**
 * 새 버전 알림의 정책 (Phase 6b-1 스펙 §4.3, Phase 6c 스펙 §5.5). 잎은 main.ts가 주입한다.
 *
 * - **자동**은 방해하지 않는다: 실패는 로그만, 건너뛴 버전·이미 보인 버전은 조용히, 화면이 안 붙었거나
 *   녹음 중이거나 다른 모달이 떠 있거나 종료 중이면 보류한다. 받음 알림도 같은 규칙이다 — 보류되면 메뉴 항목만 남는다.
 * - **수동**은 사람이 방금 누른 메뉴에 대한 답이라 결과를 항상 말한다.
 * - 대화상자는 동시에 하나다 — 새 버전·받음·실패·"더 새 판"이 `presenting` 하나를 공유한다. 업데이트 대화상자는
 *   모달 카운터 밖이라 카운터로는 서로를 막지 못한다(코덱스 R13).
 * - 받고 있거나 받아 둔 판이 있으면(heldVersion) 새 버전 알림 대신 안내만 한다 — 한 실행에 준비는 한 번(스펙 §5.1).
 * - 한도(rate_limited)를 받으면 만료까지 요청 없이 실패로 답한다.
 */
export interface UpdateFlowDeps {
  check(): Promise<CheckResult>;
  now(): number;
  isAttached(): boolean;
  isRecording(): Promise<boolean>;
  isShuttingDown(): boolean;
  isOtherModalOpen(): boolean;
  loadSkipped(): string | null;
  saveSkipped(version: string): void;
  showNewer(info: { current: string; latest: string; autoInstall: boolean }): Promise<NewerChoice>;
  showInfo(info: { kind: "current"; current: string } | { kind: "failed"; detail: string }): Promise<void>;
  openExternal(url: string): Promise<void>;
  log(line: string): void;
  /** 이 실행이 앱 안 설치를 할 수 있는가(packaged·설치 가능 판정). 거짓이면 6b-1처럼 페이지만. */
  canInstall(): boolean;
  heldVersion(): string | null;
  startInstall(t: { version: string; tag: string; releaseId: number | null }): void;
  showLater(info: { newer: string; held: string }): Promise<void>;
  showDownloaded(version: string): Promise<DownloadedChoice>;
  showInstallFailed(info: { version: string; detail: string }): Promise<InstallFailedChoice>;
  requestRestart(): void;
}

export interface UpdateFlow {
  autoCheck(): Promise<void>;
  manualCheck(): Promise<void>;
  announceDownloaded(version: string): Promise<void>;
  announceFailed(info: { version: string; detail: string; url: string }): Promise<void>;
}

type Newer = Extract<CheckResult, { kind: "newer" }>;

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createUpdateFlow(deps: UpdateFlowDeps, current: string): UpdateFlow {
  let inflight: Promise<CheckResult> | null = null;
  let blockedUntil = 0;
  let presenting = false;
  const shown = new Set<string>();

  function check(): Promise<CheckResult> {
    const now = deps.now();
    if (now < blockedUntil) {
      return Promise.resolve({ kind: "failed", reason: "rate_limited", detail: "쿨다운", retryAfterMs: blockedUntil - now });
    }
    if (inflight !== null) return inflight;
    const started = deps.check().then(
      (r) => {
        if (r.kind === "failed" && r.reason === "rate_limited") {
          blockedUntil = deps.now() + (r.retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS);
        }
        return r;
      },
      (e: unknown): CheckResult => ({ kind: "failed", reason: "offline", detail: reasonOf(e) }),
    );
    inflight = started.finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function holdReason(): string | null {
    if (deps.isShuttingDown()) return "종료 중";
    if (!deps.isAttached()) return "담화 화면이 붙지 않음";
    if (deps.isOtherModalOpen()) return "다른 대화상자가 떠 있음";
    return null;
  }

  /** 자동으로 뜨는 것의 보류 판정. 녹음 조회 **뒤에** 다시 본다(그 사이 창이 사라질 수 있다). */
  async function heldBack(what: string, version: string): Promise<boolean> {
    const before = holdReason();
    if (before !== null) {
      deps.log(`${what} 보류: ${before} (${version})`);
      return true;
    }
    let recording: boolean;
    try {
      recording = await deps.isRecording();
    } catch {
      recording = true;
    }
    if (recording) {
      deps.log(`${what} 보류: 녹음 중 (${version})`);
      return true;
    }
    const after = holdReason();
    if (after !== null) {
      deps.log(`${what} 보류: ${after} (${version})`);
      return true;
    }
    return false;
  }

  async function presentNewer(r: Newer): Promise<void> {
    shown.add(r.version);
    const held = deps.heldVersion();
    if (held !== null) {
      await deps.showLater({ newer: r.version, held });
      return;
    }
    const autoInstall = r.autoInstall === true && deps.canInstall();
    const choice = await deps.showNewer({ current, latest: r.version, autoInstall });
    if (deps.isShuttingDown()) {
      deps.log(`업데이트 알림: 종료가 시작돼 선택(${choice})을 버렸어요`);
      return;
    }
    if (choice === "install") deps.startInstall({ version: r.version, tag: r.tag, releaseId: r.releaseId });
    else if (choice === "open") await deps.openExternal(r.url);
    else if (choice === "skip") deps.saveSkipped(r.version);
  }

  return {
    async autoCheck() {
      if (deps.isShuttingDown()) return;
      const r = await check();
      if (r.kind === "failed") {
        deps.log(`업데이트 확인 실패 (${r.reason}) — ${r.detail}`);
        return;
      }
      if (r.kind === "current") {
        deps.log(`업데이트 확인: 최신 (${r.latest})`);
        return;
      }
      if (r.version === deps.loadSkipped()) {
        deps.log(`업데이트 확인: ${r.version} (건너뛴 버전)`);
        return;
      }
      if (shown.has(r.version)) {
        deps.log(`업데이트 확인: ${r.version} (이번 실행에서 이미 알림)`);
        return;
      }
      if (await heldBack("업데이트 알림", r.version)) return;
      if (presenting || shown.has(r.version) || r.version === deps.loadSkipped()) {
        deps.log(`업데이트 알림 버림: 이미 처리됨 (${r.version})`);
        return;
      }
      presenting = true;
      try {
        await presentNewer(r);
      } catch (e) {
        deps.log(`업데이트 알림을 띄우지 못했어요 — ${reasonOf(e)}`);
      } finally {
        presenting = false;
      }
    },

    async manualCheck() {
      if (deps.isShuttingDown() || presenting) return;
      presenting = true;
      try {
        const r = await check();
        if (deps.isShuttingDown()) return;
        if (r.kind === "newer") await presentNewer(r);
        else if (r.kind === "current") await deps.showInfo({ kind: "current", current });
        else await deps.showInfo({ kind: "failed", detail: failureMessage(r) });
      } catch (e) {
        deps.log(`업데이트 알림을 띄우지 못했어요 — ${reasonOf(e)}`);
      } finally {
        presenting = false;
      }
    },

    async announceDownloaded(version) {
      if (await heldBack("받음 알림", version)) return;
      if (presenting) {
        deps.log(`받음 알림 버림: 다른 업데이트 대화상자가 떠 있음 (${version}) — 앱 메뉴에 남아 있어요`);
        return;
      }
      presenting = true;
      try {
        const choice = await deps.showDownloaded(version);
        if (deps.isShuttingDown()) {
          deps.log(`받음 알림: 종료가 시작돼 선택(${choice})을 버렸어요`);
          return;
        }
        if (choice === "restart") deps.requestRestart();
      } catch (e) {
        deps.log(`받음 알림을 띄우지 못했어요 — ${reasonOf(e)}`);
      } finally {
        presenting = false;
      }
    },

    async announceFailed({ version, detail, url }) {
      // 사람이 시작한 받기의 결과라 녹음 중이어도 말한다. 다른 대화상자가 떠 있으면 로그만.
      if (deps.isShuttingDown()) return;
      if (presenting) {
        deps.log(`업데이트 실패 알림 버림: 다른 업데이트 대화상자가 떠 있음 (${version}) — ${detail}`);
        return;
      }
      presenting = true;
      try {
        const choice = await deps.showInstallFailed({ version, detail });
        if (!deps.isShuttingDown() && choice === "open") await deps.openExternal(url);
      } catch (e) {
        deps.log(`업데이트 실패 알림을 띄우지 못했어요 — ${reasonOf(e)}`);
      } finally {
        presenting = false;
      }
    },
  };
}
```

- [ ] **Step 6: main.ts의 기존 `showNewer` 잎을 새 인자에 맞춘다**

`desktop/src/main.ts`의 `createUpdateFlow({ … })`에서:

```ts
        showNewer: async ({ current, latest, autoInstall }) =>
          newerChoice((await showUpdateBox(newerDialogOptions(current, latest, autoInstall))).response, autoInstall),
```

그리고 나머지 새 deps는 Task 16 전까지 설치하지 않는 기본값으로 둔다:

```ts
        canInstall: () => false,
        heldVersion: () => null,
        startInstall: () => undefined,
        showLater: async () => undefined,
        showDownloaded: async () => "later",
        showInstallFailed: async () => "ok",
        requestRestart: () => undefined,
```

- [ ] **Step 7: Run tests**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update && pnpm desktop lint && pnpm desktop test`
Expected: PASS — 기존 6b-1 테스트 전부 포함.

- [ ] **Step 8: Commit**

```bash
git add desktop/src/update/dialogs.ts desktop/src/update/update-flow.ts desktop/tests/update/dialogs.test.ts desktop/tests/update/update-flow.test.ts desktop/src/main.ts
git commit -m "feat(desktop): 알림에 다운로드 후 설치·받음·실패·더 새 판 안내를 더한다

넷이 표시 잠금 하나를 공유하고, 받음 알림은 자동 알림의 보류 규칙을 탄다. 받아 둔 판이 있으면
새 버전 알림 대신 안내만 한다(Phase 6c 스펙 §5.5).

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 12: 앱 메뉴의 업데이트 항목 (§5.5·§5.4)

**Files:**
- Modify: `desktop/src/windows/menu-template.ts`
- Modify: `desktop/src/windows/menu.ts`
- Modify: `desktop/src/update/install-flow.ts` (`updateMenuItemOf` 추가)
- Test: `desktop/tests/windows/menu-template.test.ts`, `desktop/tests/update/install-flow.test.ts` (추가)

**Interfaces:**
- Produces:
  ```ts
  // menu-template.ts
  export type UpdateMenuItem =
    | { kind: "restart"; version: string }
    | { kind: "progress"; version: string; percent: number }
    | { kind: "notice"; text: string }
    | { kind: "clear-record" };
  MenuHandlers.onInstallUpdate(): void; MenuHandlers.onClearInstallAttempt(): void;
  buildMenuTemplate(handlers, appName, opts?: { restoreEnabled: boolean; update?: UpdateMenuItem | null })
  // install-flow.ts
  export function updateMenuItemOf(s: InstallState, notice: string | null, recordUnresolved: boolean): UpdateMenuItem | null;
  // menu.ts
  installMenu(handlers, opts?: { restoreEnabled: boolean; update?: UpdateMenuItem | null }): void
  ```

- [ ] **Step 1: Write the failing tests**

`desktop/tests/windows/menu-template.test.ts`의 `handlers()`에 `onInstallUpdate: vi.fn(), onClearInstallAttempt: vi.fn()`를 더하고 끝에:

```ts
describe("업데이트 항목 (Phase 6c)", () => {
  const labels = (update: Parameters<typeof buildMenuTemplate>[2]) =>
    (buildMenuTemplate(handlers(), "Damwha", update)[0].submenu as MenuItemConstructorOptions[]).map((i) => i.role ?? i.type ?? i.label);

  it("puts nothing extra when there is no update item", () => {
    expect(labels({ restoreEnabled: false })).toHaveLength(11);
    expect(labels({ restoreEnabled: false, update: null })).toHaveLength(11);
  });

  it("puts the item right after 업데이트 확인…", () => {
    const l = labels({ restoreEnabled: false, update: { kind: "restart", version: "0.6.0" } });
    expect(l.slice(1, 3)).toEqual(["업데이트 확인…", "재시작하여 업데이트 (0.6.0)"]);
  });

  it("wires restart and clear-record, and disables progress and notice", () => {
    const h = handlers();
    const items = (u: UpdateMenuItem) => buildMenuTemplate(h, "Damwha", { restoreEnabled: false, update: u })[0].submenu as MenuItemConstructorOptions[];
    (items({ kind: "restart", version: "0.6.0" })[2].click as () => void)();
    expect(h.onInstallUpdate).toHaveBeenCalledTimes(1);
    (items({ kind: "clear-record" })[2].click as () => void)();
    expect(h.onClearInstallAttempt).toHaveBeenCalledTimes(1);
    expect(items({ kind: "progress", version: "0.6.0", percent: 42 })[2]).toMatchObject({ label: "업데이트 받는 중… 42% (0.6.0)", enabled: false });
    expect(items({ kind: "notice", text: "업데이트가 적용되지 않았어요" })[2]).toMatchObject({ label: "업데이트가 적용되지 않았어요", enabled: false });
  });
});
```

import에 `type UpdateMenuItem`을 더한다.

`desktop/tests/update/install-flow.test.ts` 끝에:

```ts
describe("updateMenuItemOf", () => {
  const job = { jobId: "j", version: "0.6.0", tag: "v0.6.0", releaseId: 1 };
  const manifest = { version: "0.6.0", buildId: "0.6.0+0123456789ab", minMacos: "15.0", zipSize: 1, appSize: 1 };
  it("prefers the clear-record item while a record is unresolved", () => {
    expect(updateMenuItemOf({ kind: "downloaded", job, manifest }, null, true)).toEqual({ kind: "clear-record" });
  });
  it("maps states to items", () => {
    expect(updateMenuItemOf({ kind: "idle" }, null, false)).toBeNull();
    expect(updateMenuItemOf({ kind: "resolving", job }, null, false)).toEqual({ kind: "progress", version: "0.6.0", percent: 0 });
    expect(updateMenuItemOf({ kind: "downloading", job, manifest, percent: 42 }, null, false)).toEqual({ kind: "progress", version: "0.6.0", percent: 42 });
    expect(updateMenuItemOf({ kind: "downloaded", job, manifest }, null, false)).toEqual({ kind: "restart", version: "0.6.0" });
    expect(updateMenuItemOf({ kind: "staging", job, manifest }, null, false)).toEqual({ kind: "notice", text: "업데이트를 준비하고 있어요…" });
    expect(updateMenuItemOf({ kind: "idle" }, "업데이트가 적용되지 않았어요", false)).toEqual({ kind: "notice", text: "업데이트가 적용되지 않았어요" });
  });
});
```

import에 `updateMenuItemOf`를 더한다.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows/menu-template.test.ts tests/update/install-flow.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`desktop/src/windows/menu-template.ts`:

`MenuHandlers`에 더한다:

```ts
  /** 받아 둔 업데이트를 설치한다 — 종료 흐름을 거쳐 재시작 (Phase 6c 스펙 §5.1). */
  onInstallUpdate(): void;
  /** 판정 못 한 설치 시도 기록을 사람이 지운다 (Phase 6c 스펙 §5.4). */
  onClearInstallAttempt(): void;
```

`MenuHandlers` 위에:

```ts
/** 앱 메뉴의 업데이트 항목 (Phase 6c). 계산은 update/install-flow.ts의 updateMenuItemOf. */
export type UpdateMenuItem =
  | { kind: "restart"; version: string }
  | { kind: "progress"; version: string; percent: number }
  | { kind: "notice"; text: string }
  | { kind: "clear-record" };

function updateItem(u: UpdateMenuItem, handlers: MenuHandlers): MenuItemConstructorOptions {
  switch (u.kind) {
    case "restart":
      return { label: `재시작하여 업데이트 (${u.version})`, click: () => handlers.onInstallUpdate() };
    case "progress":
      return { label: `업데이트 받는 중… ${u.percent}% (${u.version})`, enabled: false };
    case "notice":
      return { label: u.text, enabled: false };
    case "clear-record":
      return { label: "업데이트 기록 지우기…", click: () => handlers.onClearInstallAttempt() };
  }
}
```

`buildMenuTemplate`의 시그니처와 앱 메뉴:

```ts
export function buildMenuTemplate(
  handlers: MenuHandlers,
  appName: string,
  opts: { restoreEnabled: boolean; update?: UpdateMenuItem | null } = { restoreEnabled: false },
): MenuItemConstructorOptions[] {
  const update = opts.update ?? null;
  return [
    {
      label: appName,
      submenu: [
        { role: "about" },
        { label: "업데이트 확인…", click: () => handlers.onCheckForUpdates() },
        ...(update === null ? [] : [updateItem(update, handlers)]),
        { label: "업데이트 전으로 되돌리기…", enabled: opts.restoreEnabled, click: () => handlers.onRestore() },
```

(나머지 항목은 그대로.)

`desktop/src/windows/menu.ts`:

```ts
import { app, Menu } from "electron";
import { buildMenuTemplate, type MenuHandlers, type UpdateMenuItem } from "./menu-template";

export type { MenuHandlers, UpdateMenuItem };

/** 템플릿과 그 이유는 menu-template.ts에 있다. 여기는 electron에 닿는 잎뿐이다. */
export function installMenu(handlers: MenuHandlers, opts?: { restoreEnabled: boolean; update?: UpdateMenuItem | null }): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(handlers, app.name, opts)));
}
```

`desktop/src/update/install-flow.ts` 끝에:

```ts
import type { UpdateMenuItem } from "../windows/menu-template";

/** 앱 메뉴 항목. 판정 못 한 기록이 있으면 그것부터 — 되돌리기를 막는 이유가 거기 있다(스펙 §5.4). */
export function updateMenuItemOf(s: InstallState, notice: string | null, recordUnresolved: boolean): UpdateMenuItem | null {
  if (recordUnresolved) return { kind: "clear-record" };
  switch (s.kind) {
    case "resolving":
      return { kind: "progress", version: s.job.version, percent: 0 };
    case "downloading":
      return { kind: "progress", version: s.job.version, percent: s.percent };
    case "downloaded":
      return { kind: "restart", version: s.job.version };
    case "committing":
    case "staging":
    case "installing":
      return { kind: "notice", text: "업데이트를 준비하고 있어요…" };
    default:
      return notice === null ? null : { kind: "notice", text: notice };
  }
}
```

(`import type`은 파일 맨 위 import 묶음으로 옮긴다.)

`desktop/src/main.ts`의 `menuHandlers = { … }`에 Task 16 전까지 빈 잎을 둔다:

```ts
      onInstallUpdate: () => undefined,
      onClearInstallAttempt: () => undefined,
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows tests/update && pnpm desktop lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/windows/menu-template.ts desktop/src/windows/menu.ts desktop/src/update/install-flow.ts desktop/tests/windows/menu-template.test.ts desktop/tests/update/install-flow.test.ts desktop/src/main.ts
git commit -m "feat(desktop): 앱 메뉴에 업데이트 진행·재시작·기록 지우기 항목을 둔다

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 13: 번들 — 런타임 의존성·`app-update.yml`·`--publish never` (§6.1)

**Files:**
- Modify: `desktop/scripts/package.mjs:100-111` (build-info 옆에 `app-update.yml`, electron-builder 호출)
- Modify: `desktop/scripts/package.mjs:~247` (`--prepackaged` 호출)
- Modify: `desktop/scripts/check-bundle.mjs:80-91` (1·2번 단언)
- Modify: `desktop/electron-builder.yml:6-7` (주석)

**Interfaces:**
- Produces: `Resources/app-update.yml`(`updaterCacheDirName: damwha-desktop-updater`), `app.asar/node_modules` = electron-updater prod 폐포.

- [ ] **Step 1: package.mjs — `app-update.yml`과 `--publish never`**

`fs.writeFileSync(path.join(desktop, "build", "build-info.json"), …)` 바로 뒤에:

```js
// electron-updater가 캐시 이름을 읽는 파일 (Phase 6c 스펙 §6.1). feed는 런타임 setFeedURL이 준다 — provider 옵션은
// 이 파일에서 읽히지 않는다(코덱스 R4). extraResources(from: build)가 Resources/app-update.yml로 싣고, 아래 서명이 봉인한다.
fs.writeFileSync(
  path.join(desktop, "build", "app-update.yml"),
  "provider: generic\nurl: https://github.com/Yjason-K/Damwha/releases/download/\nupdaterCacheDirName: damwha-desktop-updater\n",
);
```

`run("pnpm", ["exec", "electron-builder", "--dir"], desktop);` → `run("pnpm", ["exec", "electron-builder", "--dir", "--publish", "never"], desktop);`

`run("pnpm", ["exec", "electron-builder", "--prepackaged", appPath, "--mac", "dmg"], desktop);` → `run("pnpm", ["exec", "electron-builder", "--prepackaged", appPath, "--mac", "dmg", "--publish", "never"], desktop);`

- [ ] **Step 2: check-bundle.mjs — 1·2번 단언을 바꾼다**

`// 1. desktop 패키지에 runtime 의존성이 없다`부터 `check("app.asar has no node_modules", …); }`까지를:

```js
// 1. desktop의 runtime 의존성은 정확히 electron-updater 6.8.9 하나다 (Phase 6c 스펙 §6.1). 그 밖의 것이 끼면
//    Phase 1의 번들 위생(P1-C11)이 무너진다 — 무엇이 asar에 들어가는지 아무도 모르게 된다.
const EXPECTED_DEPS = { "electron-updater": "6.8.9" };
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
const deps = pkg.dependencies ?? {};
check("desktop runtime dependencies are exactly electron-updater 6.8.9", JSON.stringify(deps) === JSON.stringify(EXPECTED_DEPS), JSON.stringify(deps));

// 2. app.asar의 node_modules = pnpm이 말하는 prod 폐포. 비교 단위는 이름@버전이다 — lockfile에는 파일 목록이 없다
//    (코덱스 R16). 전이 의존성 하나가 빠지면 packaged 첫 require에서야 드러난다.
function prodClosure() {
  const out = execFileSync("pnpm", ["list", "--prod", "--depth", "Infinity", "--json"], { cwd: desktop, encoding: "utf8" });
  const set = new Set();
  const walk = (tree) => {
    for (const [name, d] of Object.entries(tree ?? {})) {
      set.add(`${name}@${d.version}`);
      walk(d.dependencies);
    }
  };
  for (const root of JSON.parse(out)) walk(root.dependencies);
  return set;
}
function asarPackages(asarFile, entries) {
  const set = new Set();
  for (const e of entries) {
    const rel = e.replace(/^[/\\]/, "");
    // node_modules 바로 아래 패키지의 package.json만 — 패키지 안의 하위 package.json(dist/esm 등)은 건너뛴다.
    const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/@][^/]*)\/package\.json$/.exec(rel);
    if (m === null) continue;
    const pj = JSON.parse(asar.extractFile(asarFile, rel).toString("utf8"));
    set.add(`${m[1]}@${pj.version}`);
  }
  return set;
}
const asarPath = path.join(contents, "Resources", "app.asar");
check("app.asar exists", fs.existsSync(asarPath));
if (fs.existsSync(asarPath)) {
  const entries = asar.listPackage(asarPath, { isPack: false });
  const inAsar = asarPackages(asarPath, entries);
  const expected = prodClosure();
  const missing = [...expected].filter((p) => !inAsar.has(p));
  const extra = [...inAsar].filter((p) => !expected.has(p));
  check(
    "app.asar node_modules equals the electron-updater production closure",
    missing.length === 0 && extra.length === 0 && expected.size > 0,
    `missing ${missing.join(", ") || "-"}; extra ${extra.join(", ") || "-"}`,
  );
}

// 2c. electron-updater의 캐시 이름 (Phase 6c 스펙 §6.1). 없으면 첫 다운로드가 "updaterCacheDirName is not specified"로 실패한다.
const appUpdateYml = path.join(contents, "Resources", "app-update.yml");
check(
  "Resources/app-update.yml names the updater cache",
  fs.existsSync(appUpdateYml) && /^updaterCacheDirName: damwha-desktop-updater$/m.test(fs.readFileSync(appUpdateYml, "utf8")),
);
```

(기존 코드가 `const pkg`·`const asarPath`를 이미 선언했다면 중복 선언을 지운다 — 위 블록이 그 둘을 대신한다. 2b는 그대로 둔다.)

`desktop/electron-builder.yml`의 주석 `# asar 안에는 컴파일된 main과 셸 화면만 들어간다. desktop에는 dependencies가 없으므로 electron-builder가 훑을 prod 의존성이 없다 (스펙 P1-C11).`을:

```yaml
# asar 안에는 컴파일된 main과 셸 화면, 그리고 유일한 런타임 의존성 electron-updater(6.8.9)의 prod 폐포가 들어간다
# (Phase 6c 스펙 §6.1). check-bundle 1·2번이 그 집합을 단언한다 (스펙 P1-C11).
```

- [ ] **Step 3: 빌드해 단언이 통과하는지 본다**

```bash
pnpm desktop:build 2>&1 | grep -E "PASS|FAIL" | grep -E "runtime dependencies|production closure|app-update|Bundle hygiene|tsc"
```

Expected: 새 세 줄 `PASS`와 `Bundle hygiene: all checks passed.` **`production closure`가 FAIL이면 고쳐 맞추지 말고 멈춰 보고한다** — electron-builder가 pnpm 폐포를 다르게 담는다는 뜻이고(선택적 의존성·hoist), 그 차이가 packaged에서 require 실패로 이어지는지 먼저 봐야 한다.

- [ ] **Step 4: packaged에서 require가 되는지 본다**

```bash
ELECTRON_RUN_AS_NODE=1 desktop/out/mac-arm64/Damwha.app/Contents/MacOS/Damwha -e \
  "const u=require(process.resourcesPath+'/app.asar/node_modules/electron-updater/out/main.js'); console.log(typeof u.MacUpdater)"
```

Expected: `function`.

- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/package.mjs desktop/scripts/check-bundle.mjs desktop/electron-builder.yml
git commit -m "build(desktop): electron-updater를 번들에 싣고 app-update.yml을 서명 전에 쓴다

런타임 의존성은 정확히 electron-updater 6.8.9, asar node_modules는 그 prod 폐포(이름@버전)와
같아야 한다. electron-builder 호출에 --publish never(Phase 6c 스펙 §6.1).

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 14: 릴리스 — zip·재검증·blockmap·`latest-mac.yml`·신원 단언 (§6.2)

**Files:**
- Create: `desktop/scripts/lib/update-manifest.mjs`
- Modify: `desktop/scripts/package.mjs` (스테이플·check-bundle 블록과 DMG 블록 사이)
- Test: `desktop/tests/scripts/update-manifest.test.ts`

**Interfaces:**
- Produces:
  ```js
  export function zipNameFor(version: string): string;               // Damwha-<ver>-arm64-mac.zip
  export function manifestYaml(m: { version, zipName, sha512, size, buildId, minMacos, appSize, releaseDate }): string;
  export function releaseIdentityProblems(x: { tag, pkgVersion, bundleVersion, buildInfo: { version, commit },
    tagCommit, plistMinMacos, manifest: { version, damwhaBuildId, damwhaMinMacos } }): string[];
  export function artifactIdentityProblems(x: { tagCommit, version, manifestBuildId, zipBuildInfoText, dmgBuildInfoText }): string[];
  ```

- [ ] **Step 1: Write the failing test**

`desktop/tests/scripts/update-manifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  artifactIdentityProblems,
  manifestYaml,
  releaseIdentityProblems,
  zipNameFor,
} from "../../scripts/lib/update-manifest.mjs";
import { parseManifest } from "../../src/update/manifest";

const M = {
  version: "0.6.0",
  zipName: zipNameFor("0.6.0"),
  sha512: "q2k9abc+/==",
  size: 540_123_456,
  buildId: "0.6.0+0123456789ab",
  minMacos: "15.0",
  appSize: 1_780_000_000,
  releaseDate: "2026-10-01T00:00:00.000Z",
};

describe("manifestYaml", () => {
  it("round-trips through electron-updater's own parser into our manifest", async () => {
    const { parseUpdateInfo } = await import("electron-updater/out/providers/Provider");
    const info = parseUpdateInfo(manifestYaml(M), "latest-mac.yml", new URL("https://example.invalid/latest-mac.yml"));
    expect(info.version).toBe("0.6.0");
    expect(info.files).toEqual([{ url: "Damwha-0.6.0-arm64-mac.zip", sha512: M.sha512, size: M.size }]);
    // 따옴표가 빠지면 15.0이 숫자 15로 읽힌다 — parseManifest가 그것을 거절한다.
    expect(parseManifest(info)).toEqual({
      ok: true,
      manifest: { version: "0.6.0", buildId: M.buildId, minMacos: "15.0", zipSize: M.size, appSize: M.appSize },
    });
  });

  it("refuses values that would break the hand-written yaml", () => {
    expect(() => manifestYaml({ ...M, version: "0.6.0\nx: 1" })).toThrow();
    expect(() => manifestYaml({ ...M, buildId: "0.6.0+0123456789ab-dirty" })).toThrow();
    expect(() => manifestYaml({ ...M, sha512: "a'b" })).toThrow();
    expect(() => manifestYaml({ ...M, size: 1.5 })).toThrow();
  });
});

const X = {
  tag: "v0.6.0",
  pkgVersion: "0.6.0",
  bundleVersion: "0.6.0",
  buildInfo: { version: "0.6.0", commit: "0123456789ab" },
  tagCommit: "0123456789abcdef0123456789abcdef01234567",
  plistMinMacos: "15.0",
  manifest: { version: "0.6.0", damwhaBuildId: "0.6.0+0123456789ab", damwhaMinMacos: "15.0" },
};

describe("releaseIdentityProblems", () => {
  it("is empty when everything agrees", () => {
    expect(releaseIdentityProblems(X)).toEqual([]);
  });
  it.each<[string, Partial<typeof X>]>([
    ["tag", { tag: "v0.6.1" }],
    ["bundle version", { bundleVersion: "0.5.0" }],
    ["dirty build", { buildInfo: { version: "0.6.0", commit: "0123456789ab-dirty" } }],
    ["build from another commit", { tagCommit: "fedcba9876543210fedcba9876543210fedcba98" }],
    ["manifest version", { manifest: { ...X.manifest, version: "0.6.1" } }],
    ["manifest build id", { manifest: { ...X.manifest, damwhaBuildId: "0.6.0+ffffffffffff" } }],
    ["min macOS", { plistMinMacos: "26.0" }],
  ])("names a mismatch in %s", (_l, over) => {
    expect(releaseIdentityProblems({ ...X, ...over }).length).toBeGreaterThan(0);
  });
});

describe("artifactIdentityProblems", () => {
  const bi = JSON.stringify({ version: "0.6.0", commit: "0123456789ab" });
  const base = { tagCommit: X.tagCommit, version: "0.6.0", manifestBuildId: "0.6.0+0123456789ab", zipBuildInfoText: bi, dmgBuildInfoText: bi };
  it("accepts matching zip, dmg and manifest", () => {
    expect(artifactIdentityProblems(base)).toEqual([]);
  });
  it("catches an old zip whose own hash still matches (코덱스 R15)", () => {
    const old = JSON.stringify({ version: "0.5.0", commit: "aaaaaaaaaaaa" });
    expect(artifactIdentityProblems({ ...base, zipBuildInfoText: old }).length).toBeGreaterThan(0);
    expect(artifactIdentityProblems({ ...base, dmgBuildInfoText: old }).length).toBeGreaterThan(0);
    expect(artifactIdentityProblems({ ...base, manifestBuildId: "0.6.0+ffffffffffff" }).length).toBeGreaterThan(0);
    expect(artifactIdentityProblems({ ...base, zipBuildInfoText: "{" }).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter damwha-desktop exec vitest run tests/scripts/update-manifest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the library**

`desktop/scripts/lib/update-manifest.mjs`:

```js
// desktop/scripts/lib/update-manifest.mjs
// 앱 안 업데이트의 발행물 — latest-mac.yml과 발행 신원 (Phase 6c 스펙 §6.2·§6.3).
//
// yml은 손으로 쓴다 — YAML 라이브러리를 의존성에 더하지 않는다. 그래서 값은 전부 모양을 검사한 스칼라만 받는다.
// 따옴표를 빼면 안 되는 것: damwhaMinMacos(15.0 → 숫자 15), damwhaBuildId('+'), releaseDate.
// electron-updater의 minimumSystemVersion은 쓰지 않는다 — Darwin 버전(os.release())과 비교한다(코덱스 C13).

const VERSION = /^\d+\.\d+\.\d+$/;
const BUILD_ID = /^(\d+\.\d+\.\d+)\+([0-9a-f]{12})$/;
const MACOS = /^\d+(?:\.\d+){0,2}$/;
const SHA512_B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ZIP = /^Damwha-\d+\.\d+\.\d+-arm64-mac\.zip$/;

export function zipNameFor(version) {
  return `Damwha-${version}-arm64-mac.zip`;
}

function must(ok, what) {
  if (!ok) throw new Error(`latest-mac.yml: ${what}`);
}

export function manifestYaml(m) {
  must(VERSION.test(m.version), `version ${JSON.stringify(m.version)}`);
  must(ZIP.test(m.zipName) && m.zipName === zipNameFor(m.version), `zipName ${JSON.stringify(m.zipName)}`);
  must(SHA512_B64.test(m.sha512), "sha512");
  must(Number.isSafeInteger(m.size) && m.size > 0, `size ${m.size}`);
  const b = BUILD_ID.exec(m.buildId);
  must(b !== null && b[1] === m.version, `buildId ${JSON.stringify(m.buildId)}`);
  must(MACOS.test(m.minMacos), `minMacos ${JSON.stringify(m.minMacos)}`);
  must(Number.isSafeInteger(m.appSize) && m.appSize > 0, `appSize ${m.appSize}`);
  must(ISO.test(m.releaseDate), `releaseDate ${JSON.stringify(m.releaseDate)}`);
  return [
    `version: ${m.version}`,
    "files:",
    `  - url: ${m.zipName}`,
    `    sha512: ${m.sha512}`,
    `    size: ${m.size}`,
    `path: ${m.zipName}`,
    `sha512: ${m.sha512}`,
    `releaseDate: '${m.releaseDate}'`,
    `damwhaBuildId: '${m.buildId}'`,
    `damwhaMinMacos: '${m.minMacos}'`,
    `damwhaAppSize: ${m.appSize}`,
    "",
  ].join("\n");
}

/** 빌드 때의 단언 (스펙 §6.2 7). 문제 목록 — 비면 통과. */
export function releaseIdentityProblems(x) {
  const p = [];
  if (x.tag !== `v${x.pkgVersion}`) p.push(`태그 ${x.tag} ≠ v${x.pkgVersion}`);
  if (x.bundleVersion !== x.pkgVersion) p.push(`번들 CFBundleShortVersionString ${x.bundleVersion} ≠ ${x.pkgVersion}`);
  if (x.buildInfo.version !== x.pkgVersion) p.push(`build-info version ${x.buildInfo.version} ≠ ${x.pkgVersion}`);
  if (!/^[0-9a-f]{12}$/.test(x.buildInfo.commit)) p.push(`build-info commit ${x.buildInfo.commit} (dirty이거나 모양이 틀림)`);
  else if (!x.tagCommit.startsWith(x.buildInfo.commit)) p.push(`build-info commit ${x.buildInfo.commit} ≠ 태그 커밋 ${x.tagCommit.slice(0, 12)}`);
  if (x.manifest.version !== x.pkgVersion) p.push(`yml version ${x.manifest.version} ≠ ${x.pkgVersion}`);
  const expectedBuild = `${x.buildInfo.version}+${x.buildInfo.commit}`;
  if (x.manifest.damwhaBuildId !== expectedBuild) p.push(`yml damwhaBuildId ${x.manifest.damwhaBuildId} ≠ ${expectedBuild}`);
  if (x.manifest.damwhaMinMacos !== x.plistMinMacos) p.push(`yml damwhaMinMacos ${x.manifest.damwhaMinMacos} ≠ LSMinimumSystemVersion ${x.plistMinMacos}`);
  return p;
}

/** 발행 직전의 재확인 (스펙 §6.3, 코덱스 R15) — 자체 해시만 맞는 옛 산출물을 막는다. */
export function artifactIdentityProblems(x) {
  const p = [];
  const expected = x.manifestBuildId;
  const check = (label, text) => {
    let bi;
    try {
      bi = JSON.parse(text);
    } catch {
      p.push(`${label}의 build-info.json을 읽지 못했다`);
      return;
    }
    const id = `${bi.version}+${bi.commit}`;
    if (bi.version !== x.version) p.push(`${label} build-info version ${bi.version} ≠ ${x.version}`);
    if (typeof bi.commit !== "string" || !x.tagCommit.startsWith(bi.commit)) p.push(`${label} build-info commit ${bi.commit} ≠ 태그 커밋 ${x.tagCommit.slice(0, 12)}`);
    if (id !== expected) p.push(`${label} build ${id} ≠ yml damwhaBuildId ${expected}`);
  };
  check("zip", x.zipBuildInfoText);
  check("DMG", x.dmgBuildInfoText);
  return p;
}
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter damwha-desktop exec vitest run tests/scripts/update-manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: package.mjs — 배포용 zip과 manifest**

`desktop/scripts/package.mjs` 맨 위 import에 더한다:

```js
import { createRequire } from "node:module";
import * as os from "node:os";
import { manifestYaml, releaseIdentityProblems, zipNameFor } from "./lib/update-manifest.mjs";
```


`let dmgPath = null;` 옆에 `let zipPath = null;`.

스테이플·check-bundle 블록(`run("node", [path.join("scripts", "check-bundle.mjs")], desktop); }`로 끝나는 `if (RELEASE)`) **바로 뒤**, DMG 블록 앞에 새 블록:

```js
if (RELEASE) {
  // 배포용 zip (Phase 6c 스펙 §6.2 3~7). **스테이플한 뒤의 .app**을 담는다 — 위의 공증 제출용 zip은 스테이플 전이라
  // 배포하지 않는다(코덱스 C15). ditto는 Squirrel이 푸는 도구와 같고 심볼릭 링크·확장 속성을 지킨다.
  const out = path.join(desktop, "out");
  const zipName = zipNameFor(desktopPkg.version);
  zipPath = path.join(out, zipName);
  for (const f of [zipPath, `${zipPath}.blockmap`, path.join(out, "latest-mac.yml")]) fs.rmSync(f, { force: true });
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath], desktop);

  // 다시 풀어 본다. out의 .app이 통과하는 것과 zip 안의 .app이 통과하는 것은 다른 질문이다(P6a-C13과 같은 이유).
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-zip-"));
  try {
    run("ditto", ["-x", "-k", zipPath, scratch], desktop);
    const inner = path.join(scratch, "Damwha.app");
    run("codesign", ["--verify", "--deep", "--strict", inner], desktop);
    run("xcrun", ["stapler", "validate", inner], desktop);
    run("spctl", ["--assess", "--type", "execute", "-vv", inner], desktop);
    const links = (dir) => execFileSync("find", [dir, "-type", "l"], { encoding: "utf8" }).split("\n").filter(Boolean).length;
    const a = links(appPath);
    const b = links(inner);
    if (a !== b) throw new Error(`zip 안의 심볼릭 링크 수가 다르다: ${b} ≠ ${a}`);
    const bi = (p) => fs.readFileSync(path.join(p, "Contents", "Resources", "build-info.json"), "utf8");
    if (bi(inner) !== bi(appPath)) throw new Error("zip 안의 build-info.json이 원본과 다르다");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // blockmap은 **밖에** 쓴다 — 세 번째 인자를 빼면 zip 끝에 덧붙여 방금 검증한 바이트가 바뀐다(코덱스 R16).
  const sha512 = () => Buffer.from(execFileSync("shasum", ["-a", "512", zipPath], { encoding: "utf8" }).split(/\s+/)[0], "hex").toString("base64");
  const before = sha512();
  const requireFromBuilder = createRequire(createRequire(import.meta.url).resolve("electron-builder/package.json"));
  const { buildBlockMap } = requireFromBuilder("app-builder-lib/out/targets/blockmap/blockmap");
  await buildBlockMap(zipPath, "gzip", `${zipPath}.blockmap`);
  if (sha512() !== before) throw new Error("blockmap을 만들며 zip이 바뀌었다");

  const plist = (key) => execFileSync("plutil", ["-extract", key, "raw", path.join(appPath, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
  const buildInfo = JSON.parse(fs.readFileSync(path.join(resources, "build-info.json"), "utf8"));
  const appSize = Number(execFileSync("du", ["-sk", appPath], { encoding: "utf8" }).split(/\s+/)[0]) * 1024;
  const yml = manifestYaml({
    version: desktopPkg.version,
    zipName,
    sha512: before,
    size: fs.statSync(zipPath).size,
    buildId: `${buildInfo.version}+${buildInfo.commit}`,
    minMacos: plist("LSMinimumSystemVersion"),
    appSize,
    releaseDate: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(out, "latest-mac.yml"), yml);

  // electron-updater 자신의 파서로 다시 읽어 단언한다 — 손으로 쓴 yml의 따옴표 실수를 여기서 잡는다.
  const { parseUpdateInfo } = createRequire(import.meta.url)("electron-updater/out/providers/Provider");
  const parsed = parseUpdateInfo(yml, "latest-mac.yml", new URL("https://example.invalid/latest-mac.yml"));
  const tag = describeReleaseTag(repo);
  const problems = releaseIdentityProblems({
    tag,
    pkgVersion: desktopPkg.version,
    bundleVersion: plist("CFBundleShortVersionString"),
    buildInfo,
    tagCommit: execFileSync("git", ["rev-parse", `${tag}^{commit}`], { cwd: repo, encoding: "utf8" }).trim(),
    plistMinMacos: plist("LSMinimumSystemVersion"),
    manifest: parsed,
  });
  if (problems.length > 0) throw new Error(`발행 신원이 맞지 않는다:\n- ${problems.join("\n- ")}`);
  console.log(`latest-mac.yml: ${parsed.version} ${parsed.damwhaBuildId} zip ${parsed.files[0].size} bytes`);
}
```

- [ ] **Step 6: 드라이런 — 릴리스 없이 zip 경로만 시험한다**

릴리스 경로는 태그·공증이 필요하다. 이 Task에서는 문법과 로직만 본다:

```bash
node --check desktop/scripts/package.mjs && pnpm desktop test
```

Expected: 문법 오류 없음, 테스트 초록. 실제 릴리스 경로는 Task 19 C9 전에 시험 판(`v0.90.0`)으로 처음 돈다.

- [ ] **Step 7: Commit**

```bash
git add desktop/scripts/lib/update-manifest.mjs desktop/tests/scripts/update-manifest.test.ts desktop/scripts/package.mjs
git commit -m "build(release): 스테이플한 앱의 zip·외부 blockmap·latest-mac.yml을 만들고 신원을 단언한다

zip을 다시 풀어 서명·스테이플·링크·build-info를 확인하고, blockmap은 밖에 쓰며 zip 해시 불변을
단언한다. yml은 electron-updater 파서로 다시 읽어 태그·번들·build-info·최소 macOS와 대조한다
(Phase 6c 스펙 §6.2).

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 15: 발행 — 신원 재확인·draft·재개·재다운로드 검증 (§6.3)

**Files:**
- Create: `desktop/scripts/lib/publish-plan.mjs`
- Create: `desktop/scripts/verify-release-artifacts.mjs`
- Modify: `desktop/scripts/publish.sh`
- Test: `desktop/tests/scripts/publish-plan.test.ts`

**Interfaces:**
- Consumes: `artifactIdentityProblems`, `zipNameFor`(Task 14).
- Produces:
  ```js
  export function releaseAssetNames(version: string): string[];      // 5개, 순서 고정
  export function planPublish(release: null | { draft: boolean; assets: { name: string; size: number }[] },
    local: { name: string; size: number }[]): { kind: "create" | "resume"; upload: string[] } | { kind: "stop"; why: string };
  // CLI: node desktop/scripts/lib/publish-plan.mjs <version> <out-dir> <release-json|null>  → JSON 한 줄
  // CLI: node desktop/scripts/verify-release-artifacts.mjs <version> <tag>  → 문제가 있으면 exit 1
  ```
- 환경: `DAMWHA_PUBLISH_REPO`(기본 `Yjason-K/Damwha`, `^Yjason-K/[A-Za-z0-9._-]+$`만), `DAMWHA_PUBLISH_REMOTE`(기본 `origin`) — 계획 D2의 시험 저장소 발행용.

- [ ] **Step 1: Write the failing test**

`desktop/tests/scripts/publish-plan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { planPublish, releaseAssetNames } from "../../scripts/lib/publish-plan.mjs";

const names = releaseAssetNames("0.6.0");
const local = names.map((name, i) => ({ name, size: 100 + i }));

describe("releaseAssetNames", () => {
  it("lists the five assets", () => {
    expect(names).toEqual([
      "Damwha-0.6.0-arm64.dmg",
      "Damwha-0.6.0-arm64.dmg.sha256",
      "Damwha-0.6.0-arm64-mac.zip",
      "Damwha-0.6.0-arm64-mac.zip.blockmap",
      "latest-mac.yml",
    ]);
  });
});

describe("planPublish", () => {
  it("creates a draft and uploads everything when there is no release", () => {
    expect(planPublish(null, local)).toEqual({ kind: "create", upload: names });
  });

  it("refuses a published release", () => {
    expect(planPublish({ draft: false, assets: [] }, local)).toMatchObject({ kind: "stop" });
  });

  it("resumes a draft by uploading only what is missing", () => {
    const r = planPublish({ draft: true, assets: local.slice(0, 2) }, local);
    expect(r).toEqual({ kind: "resume", upload: names.slice(2) });
  });

  it("stops when a draft asset differs in size or is unknown", () => {
    expect(planPublish({ draft: true, assets: [{ name: names[0], size: 1 }] }, local)).toMatchObject({ kind: "stop" });
    expect(planPublish({ draft: true, assets: [{ name: "other.zip", size: 1 }] }, local)).toMatchObject({ kind: "stop" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter damwha-desktop exec vitest run tests/scripts/publish-plan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`desktop/scripts/lib/publish-plan.mjs`:

```js
// desktop/scripts/lib/publish-plan.mjs
// 발행의 draft 판정 (Phase 6c 스펙 §6.3). 공개된 릴리스는 건드리지 않고, draft는 크기가 같은 자산을 건너뛰고 빠진 것만
// 올려 이어 간다. 크기가 다르거나 모르는 자산이 있으면 멈춘다 — 사람이 draft를 지우고 다시 한다(코덱스 R15).
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { zipNameFor } from "./update-manifest.mjs";

export function releaseAssetNames(version) {
  const dmg = `Damwha-${version}-arm64.dmg`;
  const zip = zipNameFor(version);
  return [dmg, `${dmg}.sha256`, zip, `${zip}.blockmap`, "latest-mac.yml"];
}

export function planPublish(release, local) {
  const all = local.map((a) => a.name);
  if (release === null) return { kind: "create", upload: all };
  if (release.draft !== true) return { kind: "stop", why: "이미 공개된 릴리스다 — 공개된 바이트를 바꾸지 않는다" };
  const remote = new Map(release.assets.map((a) => [a.name, a.size]));
  const unknown = [...remote.keys()].filter((n) => !all.includes(n));
  if (unknown.length > 0) return { kind: "stop", why: `draft에 모르는 자산이 있다: ${unknown.join(", ")} — draft를 지우고 다시` };
  const upload = [];
  for (const a of local) {
    if (!remote.has(a.name)) upload.push(a.name);
    else if (remote.get(a.name) !== a.size) {
      return { kind: "stop", why: `draft의 ${a.name} 크기(${remote.get(a.name)})가 로컬(${a.size})과 다르다 — draft를 지우고 다시` };
    }
  }
  return { kind: "resume", upload };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, outDir, releaseJson] = process.argv.slice(2);
  const local = releaseAssetNames(version).map((name) => ({ name, size: fs.statSync(path.join(outDir, name)).size }));
  const release = releaseJson === "null" || releaseJson === "" ? null : JSON.parse(releaseJson);
  process.stdout.write(`${JSON.stringify(planPublish(release, local))}\n`);
}
```

`desktop/scripts/verify-release-artifacts.mjs`:

```js
// desktop/scripts/verify-release-artifacts.mjs <version> <tag>
// 발행 직전 산출물 신원 재확인 (Phase 6c 스펙 §6.3). zip·DMG 안의 build-info.json과 yml의 damwhaBuildId가 태그 커밋과
// 맞는가. 빌드 때 단언했어도 publish는 나중에 따로 돈다 — 그 사이 out/에 옛 산출물이 남았을 수 있다.
import { execFileSync, spawnSync } from "node:child_process";
import * as path from "node:path";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import { artifactIdentityProblems, zipNameFor } from "./lib/update-manifest.mjs";

const [version, tag] = process.argv.slice(2);
const desktop = path.resolve(import.meta.dirname, "..");
const out = path.join(desktop, "out");
const repo = path.resolve(desktop, "..");
const { parseUpdateInfo } = createRequire(import.meta.url)("electron-updater/out/providers/Provider");
const manifest = parseUpdateInfo(fs.readFileSync(path.join(out, "latest-mac.yml"), "utf8"), "latest-mac.yml", new URL("https://example.invalid/latest-mac.yml"));
const zipBuildInfoText = execFileSync("unzip", ["-p", path.join(out, zipNameFor(version)), "Damwha.app/Contents/Resources/build-info.json"], { encoding: "utf8" });

const dmg = path.join(out, `Damwha-${version}-arm64.dmg`);
const mnt = execFileSync("hdiutil", ["attach", dmg, "-nobrowse", "-readonly"], { encoding: "utf8" })
  .split("\n").map((l) => l.split("\t").pop()?.trim()).filter((p) => p?.startsWith("/Volumes/")).pop();
if (mnt === undefined) throw new Error("DMG 마운트 지점을 찾지 못했다");
let dmgBuildInfoText;
try {
  dmgBuildInfoText = fs.readFileSync(path.join(mnt, "Damwha.app", "Contents", "Resources", "build-info.json"), "utf8");
} finally {
  spawnSync("hdiutil", ["detach", mnt, "-quiet"]);
}

const problems = artifactIdentityProblems({
  tagCommit: execFileSync("git", ["rev-parse", `${tag}^{commit}`], { cwd: repo, encoding: "utf8" }).trim(),
  version,
  manifestBuildId: manifest.damwhaBuildId,
  zipBuildInfoText,
  dmgBuildInfoText,
});
if (problems.length > 0) {
  console.error(`산출물 신원이 맞지 않는다:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`산출물 신원 OK — ${manifest.damwhaBuildId}`);
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter damwha-desktop exec vitest run tests/scripts/publish-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: publish.sh를 고친다**

`REPO=Yjason-K/Damwha` 줄을:

```bash
# 시험 저장소로 발행할 때만(계획 D2). 이 계정의 저장소만 받는다.
REPO="${DAMWHA_PUBLISH_REPO:-Yjason-K/Damwha}"
[[ "$REPO" =~ ^Yjason-K/[A-Za-z0-9._-]+$ ]] || { printf 'publish: 저장소 값이 이상하다: %s\n' "$REPO" >&2; exit 1; }
REMOTE="${DAMWHA_PUBLISH_REMOTE:-origin}"
```

"# 3. 원격 태그 → HEAD" 블록의 `origin` 두 곳(`ls-remote --tags origin`, 문구의 `원격(origin)`)을 `"$REMOTE"`·`원격(${REMOTE})`로 바꾼다.

"# 4. DMG와 해시" 블록 뒤, "# 5. 발행" 앞에 넣는다:

```bash
# 4b. 앱 안 업데이트 자산 (Phase 6c 스펙 §6.3)
for name in "Damwha-$VERSION-arm64-mac.zip" "Damwha-$VERSION-arm64-mac.zip.blockmap" "latest-mac.yml"; do
  [ -s "$OUT/$name" ] || die "자산이 없다: ${OUT}/${name} — pnpm run package:release가 먼저다"
done

# 4c. 산출물 신원 — zip·DMG 안의 build-info와 yml이 태그 커밋과 맞는가(자체 해시만 맞는 옛 산출물을 막는다)
node "$DESKTOP/scripts/verify-release-artifacts.mjs" "$VERSION" "$TAG" || die "산출물 신원이 태그와 맞지 않는다"
```

"# 5. 발행" 블록(`gh release create "$TAG" "$OUT/$DMG" … --notes-file "$NOTES"`)을 통째로 바꾼다:

```bash
# 5. draft로 올리고 → 다시 받아 대조하고 → 공개한다. draft는 비인증 /releases에 안 보인다 — 앱이 자산이 덜 올라간
#    릴리스를 고르지 않는다. 인증된 gh로는 draft가 보이니 그것으로 판정하지 않는다(스펙 §11 C9).
state="$(gh api "repos/$REPO/releases?per_page=100" --paginate \
  --jq ".[] | select(.tag_name == \"$TAG\") | {draft, assets: [.assets[] | {name, size}]}" | head -1)"
[ -n "$state" ] || state=null
plan="$(node "$DESKTOP/scripts/lib/publish-plan.mjs" "$VERSION" "$OUT" "$state")"
kind="$(node -p 'JSON.parse(process.argv[1]).kind' "$plan")"
case "$kind" in
  stop) die "$(node -p 'JSON.parse(process.argv[1]).why' "$plan")" ;;
  create)
    echo "== gh release create ${TAG} --draft"
    gh release create "$TAG" --repo "$REPO" --draft --verify-tag \
      --title "Damwha $VERSION (macOS)" --notes-file "$NOTES"
    ;;
  resume) echo "== draft ${TAG}를 이어서 올린다" ;;
  *) die "모르는 계획: ${plan}" ;;
esac
while IFS= read -r name; do
  [ -n "$name" ] || continue
  echo "== upload ${name}"
  gh release upload "$TAG" "$OUT/$name" --repo "$REPO"
done < <(node -p 'JSON.parse(process.argv[1]).upload.join("\n")' "$plan")

check_dir="$(mktemp -d)"
trap 'rm -rf "$check_dir"' EXIT
gh release download "$TAG" --repo "$REPO" --dir "$check_dir"
for name in "$DMG" "$DMG.sha256" "Damwha-$VERSION-arm64-mac.zip" "Damwha-$VERSION-arm64-mac.zip.blockmap" "latest-mac.yml"; do
  cmp -s "$OUT/$name" "$check_dir/$name" || die "올라간 ${name}이 로컬과 다르다 — 공개하지 않았다. draft를 확인할 것"
done
echo "== 자산 5개 대조 OK — 공개한다"
gh release edit "$TAG" --repo "$REPO" --draft=false --latest
```

파일 머리 주석의 "gh를 부르기 전에 넷을 본다" 목록 뒤에 한 줄: `#   5. 앱 안 업데이트 자산 셋과 산출물 신원(zip·DMG의 build-info, yml) — Phase 6c 스펙 §6.3.` 그리고 발행 방식 문단에 `draft → 다시 받아 대조 → 공개. draft가 이미 있으면 크기가 같은 자산을 건너뛰고 이어 간다.`를 더한다.

- [ ] **Step 6: 문법 확인**

```bash
bash -n desktop/scripts/publish.sh && node --check desktop/scripts/verify-release-artifacts.mjs && node --check desktop/scripts/lib/publish-plan.mjs
```

Expected: 출력 없음. 실제 발행 경로는 Task 19 C9에서 시험 저장소로 돈다(gh가 draft를 태그로 찾는지도 거기서 확인한다 — 못 찾으면 멈추고 보고).

- [ ] **Step 7: Commit**

```bash
git add desktop/scripts/lib/publish-plan.mjs desktop/scripts/verify-release-artifacts.mjs desktop/scripts/publish.sh desktop/tests/scripts/publish-plan.test.ts
git commit -m "build(release): draft로 올려 다시 받아 대조한 뒤 공개하고, draft를 이어 올린다

발행 직전 zip·DMG 안의 build-info와 yml을 태그 커밋과 다시 대조한다. 공개된 태그는 거부한다
(Phase 6c 스펙 §6.3, 계획 D2).

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 16: 배선 — `updater-port.ts`와 `main.ts` (§5.1~§5.8)

**Files:**
- Create: `desktop/src/platform/updater-port.ts`
- Modify: `desktop/src/main.ts`

**Interfaces:**
- Consumes: Task 2~15의 전부.
- Produces: `createUpdaterPort(log: (line: string) => void): UpdaterPort`. main 전역 `installFlow`, `attemptStore`, `maintenance`, `pendingInstall`, `staleAttempt`, `installNotice`.

main.ts는 electron을 값으로 쓰므로 vitest로 부를 수 없다. 이 Task의 판정은 lint·기존 테스트·dev 실행·Task 19의 packaged 실측이다. **새 판단을 여기 쓰지 않는다** — 판단이 필요하면 순수 모듈로 옮기고 그쪽에 테스트를 단다.

- [ ] **Step 1: `updater-port.ts`**

`desktop/src/platform/updater-port.ts`:

```ts
import { autoUpdater as native } from "electron";
import { autoUpdater as updater } from "electron-updater";
import type { UpdaterPort } from "../update/install-flow";

/**
 * electron-updater와 내장 autoUpdater(Squirrel.Mac)에 닿는 잎 (Phase 6c 스펙 §5.1). 판정은 update/install-flow.ts에 있다.
 * electron-updater 6.8.9에 고정 — 판을 올리면 install-flow.ts 머리 주석의 호출 계약과 Task 1 Step 6의 실측을 다시 한다.
 */
export function createUpdaterPort(log: (line: string) => void): UpdaterPort {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.logger = {
    info: (m: unknown) => log(`electron-updater: ${String(m)}`),
    warn: (m: unknown) => log(`electron-updater 경고: ${String(m)}`),
    error: (m: unknown) => log(`electron-updater 오류: ${String(m)}`),
    debug: () => undefined,
  };
  // EventEmitter의 "error"는 listener가 없으면 던진다. 같은 오류를 호출 쪽 프라미스도 받으므로 여기서는 로그만.
  updater.on("error", (e: Error) => log(`electron-updater error 이벤트 — ${e.message}`));

  let installError: ((e: unknown) => void) | null = null;
  native.on("error", (e: Error) => {
    log(`내장 autoUpdater 오류 — ${e.message}`);
    installError?.(e);
  });

  return {
    async resolve(feedUrl) {
      updater.setFeedURL({ provider: "generic", url: feedUrl, useMultipleRangeRequest: false });
      const r = await updater.checkForUpdates();
      return r === null ? { available: false, info: null } : { available: r.isUpdateAvailable, info: r.updateInfo };
    },
    async download(onProgress) {
      const listener = (p: { percent: number }) => onProgress(p.percent);
      updater.on("download-progress", listener);
      try {
        await updater.downloadUpdate();
      } finally {
        updater.removeListener("download-progress", listener);
      }
    },
    stage() {
      return new Promise<void>((resolve, reject) => {
        const ok = () => {
          off();
          resolve();
        };
        const bad = (e: Error) => {
          off();
          reject(e);
        };
        const off = () => {
          native.removeListener("update-downloaded", ok);
          native.removeListener("error", bad);
        };
        // listener를 먼저 단다 — 캐시된 판이면 update-downloaded가 곧바로 올 수 있다.
        native.on("update-downloaded", ok);
        native.on("error", bad);
        native.checkForUpdates();
      });
    },
    install() {
      native.quitAndInstall();
    },
    onInstallError(cb) {
      installError = cb;
    },
  };
}
```

- [ ] **Step 2: main.ts — import와 전역**

import에 더한다:

```ts
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { createMaintenanceLock, installBlockedByRestore } from "./app/maintenance";
import { createUpdaterPort } from "./platform/updater-port";
import { makeAttemptStore, clearsRecord, judgeAttempt, verdictLine, type AttemptStore } from "./update/install-attempt";
import { checkEligibility, deviceFromDf, volumeFromDiskutil, type Eligibility, type VolumeInfo } from "./update/install-eligibility";
import { createInstallFlow, updateMenuItemOf, type InstallFlow, type InstallState } from "./update/install-flow";
import { shortfalls, shortfallText, type VolumeRef } from "./update/disk-budget";
import { UPDATER_CACHE_NAME, shouldDropPending } from "./update/updater-cache";
import { parseInstalledVersion, releasePageUrl, repoFromEnv } from "./update/release-check";
import type { Manifest } from "./update/manifest";
import type { UpdateMenuItem } from "./windows/menu";
```

`dialogs`의 import에 `downloadedChoice, downloadedDialogOptions, installBlockedDialogOptions, installFailedChoice, installFailedDialogOptions, laterReleaseDialogOptions`를 더한다. `child_process`·`crypto`를 이미 import하고 있으면 그 줄에 합친다.

`const flows = createFlowLatch();` 근처에 전역을 둔다:

```ts
/** 되돌리기·설치 상호 배제 (Phase 6c 스펙 §5.4). 확인창 **전에** 잡는다. */
const maintenance = createMaintenanceLock();
let installFlow: InstallFlow | null = null;
let attemptStore: AttemptStore | null = null;
/** "재시작하여 업데이트"로 시작한 종료인가. before-quit의 finish가 설치로 갈지 이것으로 가른다. */
let pendingInstall = false;
/** 지난 실행의 설치 기록을 판정하지 못했다 — 되돌리기를 막고 메뉴에 "기록 지우기"를 둔다. */
let staleAttempt = false;
/** 다음 기동 판정의 한 줄(미적용·다른 빌드). 메뉴에 비활성 항목으로 보인다. */
let installNotice: string | null = null;
let lastMenuPercent = -1;
```

- [ ] **Step 3: main.ts — 잎 함수**

`restoreAllowedNow()` 위에 둔다:

```ts
/** `df` → 장치 → `diskutil info -plist` → JSON (Phase 6c 스펙 §5.2). 장치가 없으면(네트워크) null. */
function volumeOf(dir: string): VolumeInfo | null {
  const df = execFileSync("/bin/df", [dir], { encoding: "utf8", timeout: 5_000 });
  const device = deviceFromDf(df);
  if (device === null) return null;
  const plist = execFileSync("/usr/sbin/diskutil", ["info", "-plist", device], { encoding: "utf8", timeout: 10_000 });
  const json = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { input: plist, encoding: "utf8", timeout: 5_000 });
  return volumeFromDiskutil(device, JSON.parse(json));
}

function eligibilityNow(): Eligibility {
  return checkEligibility({
    packaged: app.isPackaged,
    exePath: app.getPath("exe"),
    realpath: (p) => fs.realpathSync(p),
    writable: (p) => {
      try {
        fs.accessSync(p, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    ownerUid: (p) => fs.statSync(p).uid,
    uid: process.getuid?.() ?? -1,
    volumeOf,
  });
}

/** `du -sk`의 바이트. 못 재면 던진다 — 예산을 모르면 막는 쪽으로(스펙 §7). */
function sizeOf(p: string): number {
  if (!fs.existsSync(p)) return 0;
  const kb = Number(execFileSync("/usr/bin/du", ["-sk", p], { encoding: "utf8", timeout: 120_000 }).split(/\s+/)[0]);
  if (!Number.isSafeInteger(kb)) throw new Error(`${p}의 크기를 읽지 못했어요`);
  return kb * 1024;
}

function updateBudget(stage: "download" | "commit", m: Manifest): string | null {
  const userData = app.getPath("userData");
  const layout = pgLayout(userData);
  const cacheDir = app.getPath("cache");
  const el = eligibilityNow();
  if (!el.ok) throw new Error(el.reason);
  const ref = (dir: string, vol: VolumeInfo | null): VolumeRef => {
    if (vol === null) throw new Error(`${dir}의 디스크를 판정하지 못했어요`);
    const s = fs.statfsSync(dir);
    return { device: vol.device, apfs: vol.apfs, freeBytes: s.bavail * s.bsize };
  };
  const places = {
    cache: ref(cacheDir, volumeOf(cacheDir)),
    app: ref(path.dirname(el.appPath), el.volume),
    data: ref(userData, volumeOf(userData)),
  };
  const sizes = {
    zip: m.zipSize,
    app: m.appSize,
    pgdata: sizeOf(layout.pgdata),
    data: places.data.apfs ? 0 : sizeOf(layout.dataDir),
  };
  const sf = shortfalls(stage, sizes, places);
  return sf.length === 0 ? null : shortfallText(sf);
}

function currentUpdateItem(): UpdateMenuItem | null {
  if (installFlow === null) return staleAttempt ? { kind: "clear-record" } : null;
  return updateMenuItemOf(installFlow.state(), installNotice, staleAttempt);
}
```

`restoreAllowedNow()`의 `installBlocking: false,`(Task 6의 임시값)를:

```ts
    installBlocking: maintenance.held() === "install" || staleAttempt,
```

`refreshMenu()`:

```ts
function refreshMenu(): void {
  if (menuHandlers === null) return;
  installMenu(menuHandlers, { restoreEnabled: restoreAllowedNow(), update: currentUpdateItem() });
}
```

- [ ] **Step 4: main.ts — 기동 때 판정과 캐시 정리, 흐름 생성**

`app.whenReady().then(async () => {` 블록에서 `const updateState = makeUpdateStateStore(…);` 바로 뒤에:

```ts
    const repo = repoFromEnv(process.env.DAMWHA_UPDATE_REPO);
    if (repo.ignored !== null) appendSupervisorLog(`DAMWHA_UPDATE_REPO 값을 쓰지 않아요 (${JSON.stringify(repo.ignored)})`);

    // 지난 실행의 설치 시도를 판정한다 (Phase 6c 스펙 §5.6). 판정 불가만 기록을 남긴다.
    attemptStore = makeAttemptStore(app.getPath("userData"));
    const verdict = judgeAttempt(attemptStore.read(), buildIdentity.running());
    const verdictText = verdictLine(verdict, buildIdentity.running());
    if (verdictText !== null) appendSupervisorLog(verdictText);
    if (clearsRecord(verdict)) {
      try {
        attemptStore.clear();
      } catch (e) {
        appendSupervisorLog(`업데이트 기록을 지우지 못했어요 — ${reasonOf(e)}`);
      }
    }
    staleAttempt = verdict.kind === "undecidable";
    if (verdict.kind === "not-applied" || verdict.kind === "other-build") installNotice = verdictText;

    // 받아 둔 판이 쓸모없어졌으면 pending/만 비운다 — 루트 update.zip은 다음 차분의 기준이다 (스펙 §5.7).
    const pendingDir = path.join(app.getPath("cache"), UPDATER_CACHE_NAME, "pending");
    try {
      const running = parseInstalledVersion(app.getVersion());
      const skipped = updateState.loadSkipped();
      if (running !== null && shouldDropPending(fs.readdirSync(pendingDir), running, skipped === null ? null : parseInstalledVersion(skipped))) {
        fs.rmSync(pendingDir, { recursive: true, force: true });
        appendSupervisorLog("업데이트: 쓸모없어진 받은 판을 비웠어요 (차분 기준은 남김)");
      }
    } catch {
      // pending/이 없으면 할 일이 없다.
    }

    const onInstallChange = (s: InstallState, prev: InstallState): void => {
      const target = win !== null && !win.isDestroyed() ? win : null;
      if (s.kind === "downloading") {
        target?.setProgressBar(s.percent / 100);
        if (s.percent - lastMenuPercent >= 5 || s.percent === 100) {
          lastMenuPercent = s.percent;
          refreshMenu();
        }
        return;
      }
      lastMenuPercent = -1;
      target?.setProgressBar(-1);
      refreshMenu();
      if (s.kind === "downloaded" && prev.kind === "downloading") {
        void updateFlow?.announceDownloaded(s.job.version).catch((e: unknown) => appendSupervisorLog(`받음 알림 중 예외 — ${reasonOf(e)}`));
      }
      if (s.kind === "failed") {
        void updateFlow
          ?.announceFailed({ version: s.version, detail: s.detail, url: releasePageUrl(s.tag, repo.repo) })
          .catch((e: unknown) => appendSupervisorLog(`업데이트 실패 알림 중 예외 — ${reasonOf(e)}`));
      }
    };

    installFlow = app.isPackaged
      ? createInstallFlow({
          port: createUpdaterPort(appendSupervisorLog),
          repo: repo.repo,
          eligibility: eligibilityNow,
          budget: updateBudget,
          attempts: attemptStore,
          runningBuild: () => buildIdentity.running(),
          currentMacos: () => process.getSystemVersion(),
          newJobId: () => randomUUID(),
          now: () => new Date(),
          setTimer: (fn, ms) => {
            const t = setTimeout(fn, ms);
            return () => clearTimeout(t);
          },
          log: appendSupervisorLog,
          onChange: onInstallChange,
        })
      : null;
```

`checkForUpdate(app.getVersion(), { fetch: …, now: Date.now })`에 `repo: repo.repo`를 더한다.

- [ ] **Step 5: main.ts — "재시작하여 업데이트"**

`updateFlow = createUpdateFlow(` **앞에** 둔다(같은 블록, `showUpdateBox` 뒤):

```ts
    /** 받아 둔 판을 설치한다 — 되돌리기와 배제하고, 종료 흐름을 거친다 (Phase 6c 스펙 §5.1·§5.4). */
    const requestInstallRestart = (): void => {
      if (installFlow === null || quitting) return;
      if (!maintenance.take("install")) {
        void showUpdateBox(installBlockedDialogOptions("되돌리기를 준비하는 중이에요. 끝난 뒤 다시 시도해 주세요."));
        return;
      }
      const layout = pgLayout(app.getPath("userData"));
      if (installBlockedByRestore({ journalPresent: readJournal(layout.restoreJournal).kind !== "none", pendingRestore: pendingRestore !== null })) {
        maintenance.release("install");
        void showUpdateBox(installBlockedDialogOptions("되돌리기가 예약돼 있어 지금은 업데이트할 수 없어요. 되돌리기를 마친 뒤 다시 시도해 주세요."));
        return;
      }
      const r = installFlow.commit();
      if (!r.ok) {
        maintenance.release("install");
        appendSupervisorLog(`업데이트 설치를 시작하지 못했어요 — ${r.reason}`);
        void showUpdateBox(installBlockedDialogOptions(r.reason));
        return;
      }
      pendingInstall = true;
      refreshMenu();
      app.quit();
    };
```

`createUpdateFlow({ … })`에서 Task 11 Step 6의 임시 잎을 바꾼다:

```ts
        canInstall: () => installFlow !== null && eligibilityNow().ok,
        heldVersion: () => installFlow?.heldVersion() ?? null,
        startInstall: (t) => {
          void installFlow?.start(t).catch((e: unknown) => appendSupervisorLog(`업데이트 받기 중 예외 — ${reasonOf(e)}`));
        },
        showLater: async ({ newer, held }) => {
          await showUpdateBox(laterReleaseDialogOptions(newer, held));
        },
        showDownloaded: async (version) => downloadedChoice((await showUpdateBox(downloadedDialogOptions(version))).response),
        showInstallFailed: async ({ version, detail }) =>
          installFailedChoice((await showUpdateBox(installFailedDialogOptions(version, detail))).response),
        requestRestart: () => requestInstallRestart(),
```

`menuHandlers`에서 Task 12의 빈 잎을 바꾼다:

```ts
      onInstallUpdate: () => requestInstallRestart(),
      onClearInstallAttempt: () => {
        void (async () => {
          const { response } = await modals.track(
            dialog.showMessageBox({
              type: "warning",
              message: "업데이트 기록을 지울까요?",
              detail:
                "지난 업데이트가 적용됐는지 앱이 판정하지 못했어요. 앱이 정상으로 보이면 지워도 돼요. 지우면 “업데이트 전으로 되돌리기”를 다시 쓸 수 있어요.",
              buttons: ["지우기", "취소"],
              defaultId: 1,
              cancelId: 1,
            }),
          );
          if (response !== 0) return;
          attemptStore?.clear();
          staleAttempt = false;
          installNotice = null;
          refreshMenu();
        })().catch((e: unknown) => appendSupervisorLog(`업데이트 기록 지우기 중 예외 — ${reasonOf(e)}`));
      },
```

`onRestore`를 예약·재검사로 바꾼다:

```ts
      onRestore: () => {
        void (async () => {
          const layout = pgLayout(app.getPath("userData"));
          // 메뉴 활성과 **같은** 판정을 다시 본다 — 메뉴를 그린 뒤 상태가 바뀌었을 수 있다.
          if (!restoreAllowedNow()) return;
          // 확인창 **전에** 예약한다 — 창이 열린 동안 pendingRestore는 아직 null이라 설치가 끼어들 수 있다(코덱스 R11).
          if (!maintenance.take("restore")) return;
          try {
            const snaps = restorableSnapshots(layout.snapshots, PG_MAJOR);
            const d = confirmRestoreDialog(snaps, localTime);
            const target = win !== null && !win.isDestroyed() ? win : null;
            const { response } = await modals.track(target === null ? dialog.showMessageBox(d.options) : dialog.showMessageBox(target, d.options));
            const sid = d.choices[response] ?? null;
            if (sid === null) return;
            // await 뒤 다시 본다 — 확인하는 사이 상태가 바뀌었을 수 있다.
            if (!restoreAllowedNow()) {
              appendSupervisorLog("되돌리기: 확인하는 사이 상태가 바뀌어 예약하지 않았어요");
              return;
            }
            pendingRestore = { snapshot: sid };
            app.quit();
          } finally {
            if (pendingRestore === null) maintenance.release("restore");
          }
        })().catch((e: unknown) => appendSupervisorLog(`되돌리기 시작 중 예외 — ${reasonOf(e)}`));
      },
```

- [ ] **Step 6: main.ts — before-quit**

`beginQuit: () => { … }` 안 `updateScheduler?.dispose();` 다음 줄에:

```ts
        // 설치로 가는 종료가 아니면 받는 중인 판을 버린다 — 늦게 온 이벤트가 종료 중 상태를 바꾸지 않게(Review Focus 1).
        if (!pendingInstall) installFlow?.abandon();
```

Task 3의 `finish: () => { … }`를:

```ts
      // 설치 경로는 prepared일 때만. 그 밖(정리 실패·설치 아님)은 일반 종료 (Phase 6c 스펙 §5.3).
      finish: (outcome) => {
        if (pendingInstall && outcome.kind === "prepared" && installFlow !== null) {
          return installFlow.proceed({
            destroyWindows: () => {
              for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy();
            },
            allowQuit: () => flows.quit.allow(),
            quitNow,
          });
        }
        if (restoreCommitted) app.relaunch();
        quitNow();
      },
```

`void runQuitFlow({ … })` 뒤 체인의 `.catch(` **앞**에 `.then`을 끼운다:

```ts
    })
      .then((outcome) => {
        // 종료 확인에서 "취소"하면 설치 예약을 푼다 — 받아 둔 판은 남고 메뉴 항목이 다시 보인다.
        if (outcome.kind === "cancelled" && pendingInstall) {
          pendingInstall = false;
          installFlow?.cancelled();
          maintenance.release("install");
          refreshMenu();
        }
      })
      .catch((e: unknown) => {
```

기존 `.finally(() => { flows.quit.settle(); if (!quitting) pendingRestore = null; })`의 마지막 줄을:

```ts
        if (!quitting) {
          pendingRestore = null;
          maintenance.release("restore");
        }
```

(설치 경로에서 `finish`가 돌려준 프라미스를 `runQuitFlow`가 기다리므로, `staging`·`installing` 동안 이 `settle`은 아직 불리지 않는다 — 스펙 §5.3의 불변식.)

- [ ] **Step 7: 확인**

```bash
pnpm desktop lint && pnpm desktop test
pnpm desktop:dev
```

Expected: lint·test 초록. dev 앱에서: 앱 메뉴에 업데이트 항목이 없다(dev는 `installFlow === null`), "업데이트 확인…"은 6b-1과 같이 동작(자동 설치 버튼 없음 — `canInstall()` 거짓), ⌘Q 확인·취소가 전과 같다, "업데이트 전으로 되돌리기…"의 활성 여부가 전과 같다. supervisor.log에 `DAMWHA_UPDATE_REPO`·업데이트 기록 관련 줄이 없다.

- [ ] **Step 8: Commit**

```bash
git add desktop/src/platform/updater-port.ts desktop/src/main.ts
git commit -m "feat(desktop): 앱 안 업데이트를 배선한다

electron-updater·내장 autoUpdater 잎, 기동 때 설치 기록 판정과 pending 정리, 되돌리기 배제,
재시작하여 업데이트 → 종료 흐름 → prepared일 때만 설치(Phase 6c 스펙 §5).

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 17: 문서 (§10)

**Files:**
- Modify: `desktop/CLAUDE.md` (명령 표, "서명·배포" 절, "새 버전 알림 (Phase 6b-1)" 절 뒤)
- Modify: `docs/RESTORE.md`
- Modify: `docs/electron-migration-roadmap.md` (Phase 6c 상태 문단 — Task 19 뒤에 채운다, 여기서는 "구현 중" 한 줄)

- [ ] **Step 1: `desktop/CLAUDE.md`**

"## 새 버전 알림 (Phase 6b-1)" 절 **뒤**에 새 절:

```markdown
## 앱 안 업데이트 (Phase 6c)

- **흐름.** 알림 "다운로드 후 설치" → electron-updater로 zip을 캐시에만 받는다 → "재시작하여 업데이트" → 종료 흐름
  (`runQuitFlow`)이 `prepared`를 돌려줄 때만 → 설치 시도 기록(`<userData>/install-attempt.json`) → 내장 `autoUpdater`
  준비 → 모든 창 `destroy()` → `flows.quit.allow()` → 내장 `quitAndInstall()`. "나중에"는 캐시만 남긴다 — 준비된
  Squirrel 예약은 크래시·강제 종료에도 교체를 일으킨다(스펙 §3.2 C3). 판정은 `src/update/install-flow.ts`, electron에
  닿는 잎은 `src/platform/updater-port.ts`.
- **호출 계약은 electron-updater 6.8.9에 고정이다.** `setFeedURL` 뒤 바로 `downloadUpdate()`는 `Please check update first`로
  거절된다 — `checkForUpdates()`가 먼저다. electron-updater의 `quitAndInstall()`은 부르지 않는다(자동 설치 listener를
  붙여 우리 흐름을 우회). 판을 올리면 `install-flow.ts` 머리 주석과 계획 Task 1 Step 6의 실측을 다시 한다.
- **창은 우리가 `destroy()`한다.** Electron의 `quitAndInstall`은 창이 있으면 모든 창에 `close()`를 부르고 그 뒤에
  설치하는데, 창 닫기 흐름(녹음 중 확인)에서 취소하면 대기 옵저버가 남아 나중에 창만 닫아도 설치·재실행된다.
  창이 없으면 즉시 교체한다(`electron_api_auto_updater.cc`).
- **`app.relaunch()`로 재실행하지 않는다.** 스파이크 S2에서 3/3 실패 — relaunch된 옛 바이너리가 먼저 떠 교체가 안 된다.
  되돌리기의 relaunch와 설치는 `app/maintenance.ts`로 서로 배제한다.
- **Electron 판의 조건.** Squirrel.Mac #335(설치 중단이 앱을 망가뜨리는 결함) 수정을 담아야 한다 —
  `bash desktop/scripts/check-squirrel-fix.sh <electron-tag>`가 exit 0.
- **런타임 의존성은 electron-updater 6.8.9 하나다.** `check-bundle` 1·2번이 `dependencies`와 asar `node_modules`(이름@버전
  = `pnpm list --prod` 폐포)를 단언한다. `Resources/app-update.yml`은 캐시 이름(`damwha-desktop-updater`)만 싣는다 —
  provider 옵션은 런타임 `setFeedURL` 인자가 전부다(`useMultipleRangeRequest: false` 포함).
- **캐시.** `~/Library/Caches/damwha-desktop-updater/`의 `pending/`(받은 판)과 `update.zip`(다음 차분의 기준). 버릴 때는
  `pending/`만. 첫 자동 업데이트는 전체(≈516 MB), 그다음부터 차분(실측 25%).
- **다음 기동 판정.** `install-attempt.json`을 실행 빌드와 비교해 적용됨·미적용·다른 빌드·판정 불가. 판정 불가만 남기고
  앱 메뉴 "업데이트 기록 지우기…"로 사람이 지운다. 남아 있는 동안 되돌리기 메뉴가 막힌다.
- **개발용 손잡이.** `DAMWHA_UPDATE_REPO`(값은 `Yjason-K/<이름>`만) — 조회·feed 저장소. 발행은
  `DAMWHA_PUBLISH_REPO`·`DAMWHA_PUBLISH_REMOTE`.
```

"서명·배포" 절의 `publish.sh` 문단 끝에 더한다:

```markdown
  - **Phase 6c부터 자산은 다섯이다** — DMG·`.sha256`·`Damwha-<ver>-arm64-mac.zip`·`.zip.blockmap`·`latest-mac.yml`.
    `package:release`가 스테이플한 `.app`을 `ditto`로 zip하고, 다시 풀어 서명·스테이플·링크·build-info를 확인한 뒤,
    blockmap을 **밖에** 쓰고(`buildBlockMap`의 세 번째 인자 — 빼면 zip 끝에 덧붙는다), yml을 electron-updater 파서로
    다시 읽어 태그·번들·build-info·최소 macOS와 대조한다. yml의 `damwhaBuildId`·`damwhaMinMacos`·`damwhaAppSize`는
    앱이 읽는다. electron-updater의 `minimumSystemVersion`은 쓰지 않는다(Darwin 버전과 비교한다).
  - 발행은 draft → 5개 업로드 → **다시 받아 `cmp`** → 공개. draft가 있으면 크기가 같은 자산을 건너뛰고 이어 간다. 공개된
    태그는 거부한다. 발행 직전 `verify-release-artifacts.mjs`가 zip·DMG 안의 build-info를 태그 커밋과 다시 대조한다.
    draft는 비인증 `/releases`에 안 보인다 — 인증된 `gh`로 보이는 것으로 판정하지 않는다.
```

- [ ] **Step 2: `docs/RESTORE.md`**

"앱이 메뉴까지 못 갈 때" 절(수동 절차 앞)에 문단을 더한다:

```markdown
> **앱 안 업데이트(Phase 6c) 뒤라면.** `~/Library/Application Support/Damwha/install-attempt.json`이 남아 있으면 앱은
> 지난 업데이트가 적용됐는지 판정하지 못한 것이고, 그동안 "업데이트 전으로 되돌리기…" 메뉴가 막힌다. 앱이 뜨면 앱 메뉴
> "업데이트 기록 지우기…"로 지운다. 앱이 안 뜨면 아래 수동 절차를 따르되, 먼저 Squirrel의 설치가 아직 진행 중이 아닌지
> 본다: `pgrep -fl 'kr.damwha.app.ShipIt'`에 줄이 있으면 끝날 때까지 기다린다. 줄이 없다고 예약이 없다는 증명은 아니다
> — 수동 절차로 앱을 바꾼 뒤 한 번 더 확인한다.
```

- [ ] **Step 3: 로드맵 한 줄**

`docs/electron-migration-roadmap.md` Phase 6 절의 6c 문단(2026-09-25) 끝에: `**구현 착수 (<날짜>):** Electron <ver>(Squirrel #335 포함)로 Task 1 통과.`

- [ ] **Step 4: Commit**

```bash
git add desktop/CLAUDE.md docs/RESTORE.md docs/electron-migration-roadmap.md
git commit -m "docs(phase6c): 앱 안 업데이트의 흐름·호출 계약·발행 자산·복구 절차를 적는다

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 18: 변이 검증

**Files:**
- Create: `docs/superpowers/reports/2026-09-25-electron-phase-6c-auto-update-results.md` (§1 변이 표)

각 변이를 **하나씩** 넣고 지정한 테스트를 돌려 **빨간불**인지 본 뒤 `git checkout -- <파일>`로 되돌린다. 초록으로 살아남으면 그 변이를 잡는 테스트를 더하고(같은 파일), 테스트 커밋을 따로 한다. 동치 변이로 판정하면 이유를 표에 적는다.

- [ ] **Step 1: 변이를 차례로 돌린다**

| # | 파일 (`desktop/` 기준) | 변이 | 돌릴 테스트 |
| --- | --- | --- | --- |
| M1 | `src/app/quit-flow.ts` | `if (out.stopped) outcome = { kind: "prepared" };`를 `outcome = { kind: "prepared" };`로 | `tests/app/quit-flow.test.ts` |
| M2 | 같음 | `finally`의 `await deps.finish(outcome);`에서 `await` 삭제 | 같음 |
| M3 | 같음 | 취소 경로의 `return { kind: "cancelled" };`를 `return { kind: "prepared" };`로 | 같음 |
| M4 | `src/update/install-flow.ts` | `proceed`에서 `deps.attempts.write(attempt);`를 감싼 try/catch를 통째로 삭제 (기록 없이 준비) | `tests/update/install-flow.test.ts` |
| M5 | 같음 | `q.allowQuit();`를 `q.destroyWindows();` 앞으로 옮기고 그 사이에 `await Promise.resolve();` | 같음 |
| M6 | 같음 | `if (st.kind !== "committing" \|\| stagedOnce)`에서 `\|\| stagedOnce` 삭제 | 같음 |
| M7 | 같음 | `start`의 `if (!resolved.available \|\| m.version !== t.version)`을 `if (!resolved.available)`로 | 같음 |
| M8 | 같음 | `macosSatisfies(...) !== true`를 `=== false`로 (판정 불가를 통과시킴) | 같음 |
| M9 | 같음 | `download` 콜백의 `if (!live(job) \|\| st.kind !== "downloading") return;` 삭제 | 같음 |
| M10 | 같음 | `unknown`의 `if (finished) return;` 삭제 | 같음 |
| M11 | 같음 | `commit`의 `const el = deps.eligibility(); if (!el.ok) …` 두 줄 삭제 | 같음 |
| M12 | `src/update/install-eligibility.ts` | `if (!d.writable(app) \|\| !d.writable(parent))`에서 `\|\| !d.writable(parent)` 삭제 | `tests/update/install-eligibility.test.ts` |
| M13 | 같음 | `if (volume === null) return …` 줄 삭제 (다음 줄이 null에서 던짐 → 호출자에 예외) | 같음 |
| M14 | `src/update/install-attempt.ts` | `judgeAttempt`의 `if (runningBuild === null)` 줄 삭제 | `tests/update/install-attempt.test.ts` |
| M15 | 같음 | `clearsRecord`에 `\|\| v.kind === "undecidable"` 추가 | 같음 |
| M16 | `src/app/restore-flow.ts` | `&& !s.installBlocking` 삭제 | `tests/app/restore-flow.test.ts` |
| M17 | `src/update/updater-cache.ts` | `compareVersions(running, v) >= 0`을 `> 0`으로 | `tests/update/updater-cache.test.ts` |
| M18 | `src/update/disk-budget.ts` | `if (stage === "download") add(p.cache, 2 * s.zip);` 삭제 | `tests/update/disk-budget.test.ts` |
| M19 | 같음 | `(p.data.apfs ? 0 : s.data)`를 `0`으로 | 같음 |
| M20 | `src/update/manifest.ts` | `b[1] !== version` 조건 삭제 | `tests/update/manifest.test.ts` |
| M21 | `src/update/update-flow.ts` | `presentNewer`의 `if (held !== null) { … return; }` 블록 삭제 | `tests/update/update-flow.test.ts` |
| M22 | 같음 | `announceDownloaded`의 `if (await heldBack("받음 알림", version)) return;` 삭제 | 같음 |
| M23 | 같음 | `announceDownloaded`의 `if (presenting) { … return; }` 삭제 | 같음 |
| M24 | `src/update/release-check.ts` | `hasAutoInstallAssets`의 `names.includes(MANIFEST_NAME) &&` 삭제 | `tests/update/release-check.test.ts` |
| M25 | `scripts/lib/update-manifest.mjs` | `damwhaMinMacos: '${m.minMacos}'`의 작은따옴표 삭제 | `tests/scripts/update-manifest.test.ts` |
| M26 | 같음 | `releaseIdentityProblems`의 `tagCommit.startsWith` 검사 줄 삭제 | 같음 |
| M27 | `scripts/lib/publish-plan.mjs` | `if (release.draft !== true) return { kind: "stop", … }` 삭제 | `tests/scripts/publish-plan.test.ts` |

각 줄마다:

```bash
pnpm --filter damwha-desktop exec vitest run <테스트 파일>   # Expected: FAIL (1개 이상)
git checkout -- desktop/<변이한 파일>
```

- [ ] **Step 2: 원상 확인**

Run: `git status --short desktop && pnpm desktop test`
Expected: 변경 없음(보강한 테스트는 이미 커밋), 전부 PASS.

- [ ] **Step 3: 결과 문서 §1**

`docs/superpowers/reports/2026-09-25-electron-phase-6c-auto-update-results.md`:

```markdown
# Electron Phase 6c — 앱 안에서 받아 설치하는 업데이트 (결과)

스펙: [2026-09-25-electron-phase-6c-auto-update-design.md](../specs/2026-09-25-electron-phase-6c-auto-update-design.md)
계획: [2026-09-25-electron-phase-6c-auto-update.md](../plans/2026-09-25-electron-phase-6c-auto-update.md)

## 0. 계획 결정 (스펙과 다르게 정한 것)

- D1 데이터 볼륨 몫, D2 시험 저장소 env, D3 시간 상한 초기값 — 계획 머리의 문단 그대로 옮기고, D3은 C10 실측값으로 갱신.

## 1. 변이 검증

| # | 변이 | 빨간불이 된 테스트 | 판정 |
| --- | --- | --- | --- |
| M1 | … | (실제 실패한 테스트 이름) | 잡힘 |
```

27행을 실제 결과로 채운다.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/reports/2026-09-25-electron-phase-6c-auto-update-results.md
git commit -m "test(phase6c): 변이 M1~M27을 돌려 기록한다

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

### Task 19: packaged 실측 (§11.2 C1~C10) — 사람과 함께

**Files:**
- Modify: `docs/superpowers/reports/2026-09-25-electron-phase-6c-auto-update-results.md` (§2 판정표, §3 실측 기록)
- Modify: `docs/electron-migration-roadmap.md` (6c 상태 문단)

**실데이터를 쓴다.** 6b-3·6b-2의 packaged 실측과 같은 규칙: 시작 전에 쓰는 주체 전부(Electron·postmaster·worker·embed·LLM
자식)가 없는지 `pgrep`으로 보고, `models/`·Chromium 캐시를 뺀 userData 전체를 `rsync`로 복구 세트
`~/damwha-6c-recovery-<타임스탬프>`에 뜬다. 끝나면 복구 세트로 되돌리고 공개 판(당시 최신 `v*`)을 다시 설치한다.
**공개 저장소에 시험 릴리스를 내지 않는다** — 시험 저장소(계획 D2)를 쓴다.

- [ ] **Step 1: 시험 저장소와 시험 판 셋**

```bash
gh repo create Yjason-K/Damwha-update-test --public --description "Damwha Phase 6c update test releases (disposable)"
git remote add updtest https://github.com/Yjason-K/Damwha-update-test.git
```

시험 판은 `v0.90.0`·`v0.90.1`·`v0.90.2`. 각 판마다(이 브랜치의 HEAD에서, 버전만 바꾼 커밋):

```bash
sed -i '' 's/"version": "[^"]*"/"version": "0.90.N"/' desktop/package.json   # N = 0, 1, 2
git commit -am "chore(test): 0.90.N (Phase 6c 실측용 — 병합하지 않는다)"
git tag v0.90.N && git push updtest HEAD:refs/heads/main v0.90.N
pnpm --filter damwha-desktop run package:release
DAMWHA_PUBLISH_REPO=Yjason-K/Damwha-update-test DAMWHA_PUBLISH_REMOTE=updtest \
  bash desktop/scripts/publish.sh --notes-file <(printf 'Phase 6c 실측용 시험 판. macOS 15.0 이상.\n')
```

(`v0.90.1`을 발행할 때 **C9**를 같이 본다 — Step 9.) 세 판을 다 낸 뒤 버전 커밋 셋을 이 브랜치에서 되돌린다 — 이미 시험 저장소에 푸시했으므로 reset이 아니라 revert다:
`git revert --no-edit HEAD~3..HEAD` (그 사이 다른 커밋이 없어야 한다 — `git log --oneline -4`로 먼저 본다).

- [ ] **Step 2: C1 — 0.90.0 → 0.90.1 자동 업데이트**

`v0.90.0` DMG를 `/Applications`에 설치하고 `DAMWHA_UPDATE_REPO=Yjason-K/Damwha-update-test`로 띄운다
(`launchctl setenv DAMWHA_UPDATE_REPO Yjason-K/Damwha-update-test` 후 Finder에서 열기, 끝나면 `launchctl unsetenv`).
기준선: 회의 목록(개수·제목)·설정(`processing_defaults`)·토큰 유무·마이크 권한. 앱 메뉴 "업데이트 확인…" → "다운로드 후 설치" →
메뉴 진행률 → 받음 대화상자 → "재시작하여 업데이트".

Expected: 앱이 꺼졌다 `0.90.1`로 다시 뜬다. supervisor.log에 `업데이트를 적용했어요 (0.90.0+… → 0.90.1+…)`, `스냅샷: 떴다`.
기준선이 같다. 마이크·토큰 재요청 없음. `codesign --verify --deep --strict /Applications/Damwha.app`과
`spctl --assess --type execute -vv /Applications/Damwha.app`이 통과.

- [ ] **Step 3: C2 — 실제 재기동 뒤 0.90.1 → 0.90.2의 차분**

Step 2의 `0.90.1`을 **한 번 종료하고 다시 띄운 뒤** 같은 흐름으로 `0.90.2`를 받는다.
Expected: supervisor.log의 electron-updater 줄에 차분 다운로드(`Download block maps` 또는 `differential download`)가 있고,
전체 다운로드로 떨어졌다는 줄(`falling back to full download`)이 없다. 받은 바이트(로그 또는 `nettop`)를 zip 크기와 함께 적는다.

- [ ] **Step 4: C3 — "나중에" 뒤 강제 종료·정상 종료**

`0.90.1`을 새로 깔고(`ditto`), `0.90.2`를 받은 뒤 받음 대화상자에서 "나중에". `kill -9 <Damwha main pid>` →
`/Applications/Damwha.app`의 버전이 `0.90.1` 그대로, `install-attempt.json` 없음. 다시 띄워 메뉴에 "재시작하여 업데이트(0.90.2)"가
보이고(재기동 복원, §5.7) ⌘Q → 버전 그대로.

- [ ] **Step 5: C4 — 종료 확인 취소와 정리 실패**

녹음을 시작한 채 "재시작하여 업데이트" → 종료 확인에서 "취소" → 앱이 계속 돌고 메뉴 항목이 남는다, 교체 없음. 정리 실패 주입:
worker를 `kill -STOP`으로 멈춘 채 "재시작하여 업데이트" → 유예 뒤 "강제 종료" 선택 → `cleanup-failed` → 교체 없음
(supervisor.log에 설치 줄 없음). `kill -CONT` 후 정리.

- [ ] **Step 6: C5 — 되돌리기 배제**

(a) "업데이트 전으로 되돌리기…" 확인창을 띄운 채 받음 대화상자에서 "재시작하여 업데이트" → "되돌리기를 준비하는 중이에요" 안내.
(b) "재시작하여 업데이트"를 누르고 종료 확인이 뜬 동안 앱 메뉴를 열어 되돌리기 항목이 비활성. (c) `staging` 중 크래시: 설치 경로에서
`staging` 로그가 찍힌 직후 `kill -9` → 다시 띄우면(교체됐든 아니든) 되돌리기 메뉴 비활성 또는 판정 로그가 남는다 — 판정 불가면
"업데이트 기록 지우기…"가 보인다.

- [ ] **Step 7: C6 — ShipIt 중단 주입 (출시 차단 조건)**

"재시작하여 업데이트" 직후 ShipIt을 관측한다:

```bash
while ! pgrep -f 'kr.damwha.app.ShipIt' >/dev/null; do sleep 0.1; done
# 옛 앱이 임시 위치로 옮겨졌고 새 앱이 아직 자리에 없는 순간을 파일시스템으로 본다
while [ -d /Applications/Damwha.app ]; do sleep 0.05; done; echo "moved-aside 관측 $(date +%T.%N)"
pkill -9 -f 'kr.damwha.app.ShipIt'
```

유효 회차 = `moved-aside 관측` 줄이 찍힌 회차만. 그 뒤 (i) 1분 기다려 `/Applications/Damwha.app` 상태, (ii) 앱 다시 열기, (iii) 재부팅 뒤
다시 열기. Expected: 앱 자리에 **0.90.1 또는 0.90.2**가 있고 `codesign --verify --deep --strict` 통과, `find … | wc -l`이 해당 판
번들 파일 수와 같고, 네 서비스 `준비됨`. 무효 회차(관측 못 함)는 세지 않는다. 유효 3회를 목표로 하고, 10회 시도해 유효 회차가 하나도 없으면 결과 문서에 "관측 불가"로 적고 사용자에게 보고한다(이 경우 C6은 미검증이고 출시 여부는 사용자가 정한다). **하나라도 실행 불가 상태가
남으면 이 Phase는 출시하지 않는다** — 결과 문서에 기록하고 사용자에게 보고한다.

- [ ] **Step 8: C7 — macOS 27 백그라운드 활동 차단 (#336)**

macOS 27 기기가 있으면: 시스템 설정 → 일반 → 로그인 항목 및 확장 프로그램에서 Damwha의 백그라운드 활동을 끈 채 Step 2를 반복.
기기가 없으면 결과 문서에 **미검증**으로 적고 §9의 한계로 남긴다.

- [ ] **Step 9: C8·C9·C10**

- C8: `v0.90.1` DMG를 마운트해 그 안의 앱을 바로 실행 → "업데이트 확인…"의 버튼이 "다운로드 페이지 열기"(자동 설치 없음).
  `~/Desktop/tmpapps/`(쓰기 불가로 `chmod a-w`)에 복사해 실행 → 같음. 외장 볼륨이 있으면 거기서도.
- C9 (`v0.90.1` 발행 때): (a) `publish.sh`가 draft를 만든 직후(업로드 중) 다른 셸에서 **비인증**
  `curl -s https://api.github.com/repos/Yjason-K/Damwha-update-test/releases | grep -c '"tag_name": "v0.90.1"'` → `0`.
  (b) 업로드 도중 Ctrl-C → 다시 `publish.sh` → "draft를 이어서 올린다"로 빠진 것만 올림. (c) 공개 뒤 다시 `publish.sh` → "이미
  공개된 릴리스다"로 멈춤. (d) `out/`의 zip을 `v0.90.0`의 zip으로 바꿔 두고 `publish.sh`(새 태그 `v0.90.9`로) → 산출물 신원 불일치로 멈춤.
  (e) `package:release` 중 `LSMinimumSystemVersion`만 바꾼 빌드 → 신원 단언으로 중단. gh가 draft를 태그로 못 찾으면 멈추고 보고.
- C10: supervisor.log의 `staging` → `installing` 시각 차와 `quitAndInstall` → 새 판 `started` 시각 차를 적는다(1.7 GB). 그 3배를
  `STAGING_TIMEOUT_MS`·`INSTALL_QUIT_TIMEOUT_MS`의 근거로 삼아 초기값(D3)과 다르면 값만 고치는 커밋을 한다. `df`로 각 단계의 실제
  여유 감소를 적고 §7 예산과 나란히 둔다(예산을 줄이지 않는다).

- [ ] **Step 10: 정리와 기록**

복구 세트로 userData를 되돌리고(`pgrep` 확인 뒤 `rsync --delete`), 공개 판을 다시 설치하고, `launchctl unsetenv DAMWHA_UPDATE_REPO`,
`git remote remove updtest`. 시험 저장소는 남겨 둔다(다음 판올림 시험에 재사용 — 사용자 확인).

결과 문서 §2에 판정표(C1~C10: 충족/미충족/미검증과 근거 절), §3에 단계별 실측 기록을 쓰고, 로드맵 6c 상태 문단을 채운다.

```bash
git add docs/superpowers/reports/2026-09-25-electron-phase-6c-auto-update-results.md docs/electron-migration-roadmap.md
git commit -m "docs(phase6c): packaged 실측 C1~C10을 기록한다

Claude-Session: https://claude.ai/code/session_01Xi7Npsqivj5cdfRxTukz77"
```

---

## Self-Review

1. **스펙 커버리지.** §2.1 전 항목 → Task 7·8·10·11·12(알림·받기·메뉴), 3·10·16(종료 흐름 뒤 설치), 4(설치 가능), 5·16(기록·판정),
   6·16(배제), 13·14·15(발행), 2(§13.1). §4 → Task 1. §5.1~§5.8 → Task 10·4·3·6·11·5·9·16. §6 → 13·14·15. §7 → 9·16(D1).
   §8 경계 사례 → Task 10 테스트(불일치·OS·디스크·무기록·시간 초과·설치 오류)와 Task 19. §10 → 17. §11.1 → 각 Task + 18. §11.2 → 19.
   §13.2는 범위 밖(§15.1 확정).
2. **자리표시자.** `<Step 3의 버전>`·`<tag>`·`<날짜>`는 Task 1 결과로만 정해지는 값이다. 그 밖의 TBD 없음.
3. **타입 일관성.** `QuitOutcome`/`FinishOutcome`(3) → `finish`(16). `Eligibility`(4) → `InstallFlowDeps.eligibility`(10), `eligibilityNow`(16).
   `AttemptStore`·`InstallAttempt`(5) → `install-flow`(10). `Manifest`(8) → `budget`(9·16). `UpdateMenuItem`(12) → `updateMenuItemOf`(12)·
   `currentUpdateItem`(16). `NewerChoice`에 `install`(11) → main의 `newerChoice(…, autoInstall)`(11). `feedUrlFor(tag, repo)`(7) →
   `start`(10). `releasePageUrl(tag, repo)`(7) → `onInstallChange`(16).
4. **Review Focus.** 1 → Task 10 "drops late download events after abandon" + Task 16 `beginQuit`. 2 → Task 10 "second commit is refused" +
   Task 11 "shares one presentation lock". 3 → Task 10 "ignores a second start" + Task 11 "only explains when a version is already held".
   4 → Task 10 "re-checks eligibility at commit". 5 → Task 10 "retries after a failure with a new job id".
