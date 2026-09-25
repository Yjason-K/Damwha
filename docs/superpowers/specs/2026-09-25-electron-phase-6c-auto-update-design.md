# Electron Phase 6c — 앱 안에서 받아 설치하는 업데이트 (구현 스펙)

작성일: 2026-09-25 (2판: 같은 날 코덱스 스펙 리뷰 R1~R17 반영 — §3.3)
브랜치: `feat/electron-migration-phase-6c-auto-update`
선행: Phase 6b 완료·`v0.4.0` 발행 (PR #30·#31·#32, `main` = `a899b27`)
**착수 조건: §4. 조건이 채워지기 전에는 이 스펙으로 구현하지 않는다.**

## 1. 목표

**새 버전 알림에서 버튼 하나로 받아 두고, "재시작하여 업데이트"를 누르면 앱이 새 판으로 바뀌어 다시 뜬다.**
지금(6b-1)은 알림이 다운로드 페이지를 열고, 사람이 DMG를 받아 앱을 끌어다 덮는다.

이 Phase는 2026-09-20의 결정("알림만 한다 — 번들이 수 GB라 delta 없이는 매 판올림이 전체 재다운로드",
로드맵 Phase 6 절·6b-1 스펙 §2.2)을 뒤집는다. 뒤집는 근거는 실측이다(§3.1): 압축하면 DMG 490 MB·zip 516 MB이고 —
DMG로 받는 지금도 같은 양이다 — electron-updater의 blockmap 차분은 두 번째 업데이트부터 그중 25%만 받는다.

## 2. 범위

### 2.1 포함

- 알림 대화상자의 "다운로드 페이지 열기"를, 자동 설치 자산이 있는 릴리스에 한해 "다운로드 후 설치"로 바꾼다.
- electron-updater로 zip을 받아 **캐시에만** 둔다. 받는 동안 창 진행률과 앱 메뉴 항목으로 보인다.
- 다 받으면 "재시작하여 업데이트 / 나중에". "나중에"면 앱 메뉴에 "재시작하여 업데이트(<ver>)"가 남는다.
- "재시작하여 업데이트"는 기존 종료 흐름의 준비 단계가 **성공한 뒤에만** Squirrel.Mac에 준비시키고 설치·재실행한다.
- 설치 가능 여부 판정(경로·볼륨·권한). 불가면 지금처럼 페이지를 연다.
- 설치 시도 기록과 다음 기동의 판정.
- 되돌리기(6b-2)와 설치의 상호 배제 — 확인창과 프로세스 경계를 넘어서.
- 발행물 추가: zip·`.zip.blockmap`·`latest-mac.yml`. 발행을 draft → 검증 → 공개로 바꾼다.
- `currentBuildId()`를 기동 때 한 번 고정한다(§13.1).

### 2.2 제외 — 그리고 어디로 가나

| 제외 | 이유 | 인계 |
| --- | --- | --- |
| "다음 종료 때 자동 설치"(`autoInstallOnAppQuit`) | 준비된 설치 예약이 앱의 종료·되돌리기·크래시와 독립으로 살아 있어, 크래시·강제 종료에도 정리 절차 없이 교체된다(§3.2 C3) | 후속. 이 Phase가 안정된 뒤 다시 판단 |
| 다운로드 이어받기 | electron-updater가 부분 파일을 이어 받지 않는다(§3.2 C11). 실패하면 처음부터 | 범위 밖 |
| 한 실행에서 두 번째 준비(더 새 판으로 갈아타기) | feed 교체가 앞 준비의 상태를 섞는다(§3.2 C5) | 받음 상태에서 더 새 판이 나오면 알림만 한다(§8) |
| 관리자 인증이 필요한 설치, 외장·네트워크·읽기 전용 볼륨 | Squirrel의 privileged helper·볼륨 간 이동 분기(§3.2 C10) | 페이지 안내로 보낸다. **표준 사용자라도 앱과 부모 디렉터리를 자기 권한으로 교체할 수 있으면 허용한다**(§5.2, §15.1 확정) |
| electron-updater 자체의 주기 조회 | 조회는 6b-1이 한다 — Latest를 믿지 않고 `desktop-v*`도 읽는다 | 릴리스 선택은 그대로. electron-updater의 `checkForUpdates()`는 선택한 릴리스의 manifest를 읽는 데만 쓴다(§5.1) |
| 스냅샷 보존 정책 수정(§13.2) | 6b-2의 결함이고 6c와 독립 | 6c 범위 밖으로 확정(§15.1) |

## 3. 선행 사실

### 3.1 스파이크 (2026-09-25, 서명된 장난감 앱 + 실제 Damwha 번들)

장난감 앱: Electron 44.3.0 + electron-updater 6.8.9, generic provider, 127.0.0.1 http 서버, Developer ID 서명·hardened
runtime, 번들 ID `kr.damwha.spike6c`(실데이터와 분리). 스파이크 코드는 버렸다.

| # | 시험 | 결과 |
| --- | --- | --- |
| S1 | `before-quit` preventDefault → 비동기 정지 3초 → `app.quit()` 뒤 `autoInstallOnAppQuit` | 통과 — 3초 뒤 교체, 재실행 없음 |
| S2 | 같은 흐름 + `app.relaunch()` | **3/3 실패** — relaunch된 옛 바이너리가 먼저 떠 교체가 안 되고 재실행 루프 |
| S3 | 창(close 핸들러가 preventDefault) 있는 앱에서 우리 흐름 → 모든 창 `destroy()` → `quitAndInstall()` | 통과 3/3 — close 핸들러 미호출, 3~4초 뒤 새 판 기동 |
| S4 | 교체된 앱 서명 | `codesign --verify --deep --strict` OK, `flags=0x10000(runtime)`, Team `L5Y9SZHGRN` |
| S5 | 준비 완료 신호 | electron-updater `update-downloaded`는 Squirrel이 zip을 받기 **전**. 네이티브 `autoUpdater`의 `update-downloaded`가 준비 완료 |
| S6 | 실제 번들 두 빌드(코드 한 줄·버전 차이) zip 차분 | 새 zip 515.9 MB 중 **129.0 MB(25%)**, 752 구간. 파일 단위로는 1.0 GB가 바뀐다 — 매 빌드가 모든 Mach-O를 `--timestamp`로 재서명(python 452개·Frameworks 18개·postgres 66개) — 그러나 바뀐 곳이 파일 꼬리의 서명 영역이다. 측정은 `buildBlockMap(zip, "gzip", zip + ".blockmap")`(외부 blockmap)과 electron-updater의 `computeOperations`로 했다 |
| S7 | 미해명 | S3 1회차에서 누가 부른지 모르는 `before-quit` 1회가 `quitAndInstall` 약 0.1초 전에 옴. 종료 게이트가 막아 무해 |

S2·S3가 설계를 정했다. Electron 44.3.0의 `AutoUpdater::QuitAndInstall`은 창이 있으면 `WindowList::CloseAllWindows()` 뒤
window-all-closed 옵저버로 설치하고, **창이 없으면 즉시** `relaunchToInstallUpdate`한다
(`shell/browser/api/electron_api_auto_updater.cc` v44.3.0). 창을 닫게 두면 Damwha의 창 닫기 흐름(`main.ts` `created.on("close")`,
녹음 중 확인)이 끼어들고, 거기서 취소하면 옵저버가 남아 **나중에 창만 닫아도 설치·재실행**된다. 그래서 창은 우리가 `destroy()`한다.

차분은 electron-updater 캐시 루트의 `update.zip`(이전에 **업데이터로 받은** 판)이 있어야 계산된다. 6c가 담긴 첫 판에서 받는
첫 자동 업데이트는 전체다.

### 3.2 코덱스 설계 검토 (2026-09-25, consult)

1절 초안(다운로드 → Squirrel 준비 → "나중에"면 다음 종료 때 설치)을 저장소·Electron·electron-updater·Squirrel 소스로 검토했다.
세션 `01a0d66c-452e-7401-9960-0938ce0d7a0e`. 채택한 것과 그 근거:

| # | 발견 | 처리 |
| --- | --- | --- |
| C1 | 설치 도중 ShipIt이 죽으면 옛 앱이 임시 디렉터리에 남고, macOS 정리 뒤 빈 디렉터리가 앱 자리로 복구될 수 있다. 수정은 Squirrel PR #335(2026-09-18 병합, `5c9e2133`) | **착수 조건**(§4). 세션이 재확인(2026-09-25): v44.3.0·v44.4.5의 `squirrel.mac_version`은 `8d808803`(2026-05-04). v45.0.0-alpha.12의 `fffea30e`는 `5c9e2133`의 **2커밋 이전 조상 — #335 미포함**. 지금 나온 어떤 Electron도 조건을 채우지 않는다 |
| C2 | 준비된 설치 예약과 되돌리기(저널 → `app.relaunch()`)가 독립이라, S2의 relaunch 경쟁을 제품에 다시 넣는다 | 상호 배제(§5.4) |
| C3 | 준비 뒤 크래시·강제 종료도 ShipIt에는 "종료"라 정리 없이 교체된다 | "나중에"는 캐시만 — 준비를 설치 순간으로 미룬다(§2.2) |
| C4 | `runQuitFlow`는 취소·commit 실패·정리 실패를 모두 정상 반환으로 끝낸다 → `await` 뒤 설치를 붙이면 취소해도 설치된다 | 종료 준비와 마지막 동작을 나눈다(§5.3) |
| C5 | 준비된 A 뒤 B로 feed를 바꾸면 Squirrel 정리가 A를 지우는데 electron-updater의 `squirrelDownloadedUpdate`는 true로 남는다 | 한 실행에 준비 한 번(§2.2) |
| C6 | 준비 예약이 남은 채 사람이 DMG로 다른 판을 깔면 예약이 그것을 덮을 수 있다 | 준비가 설치 순간에만 생긴다. 남는 창(`staging` 중 크래시)은 설치 시도 기록으로 다음 기동이 다룬다(§5.6) |
| C8 | 필요 공간 2.7 GB는 Squirrel 해제본·설치 사본을 뺀 값 | 단계별 예산(§7) |
| C9 | macOS 27에서 ShipIt이 백그라운드로 종료돼 설치가 조용히 실패(Squirrel 이슈 #336, 2026-09-19, open, 868 MB 앱) | 검증 항목·알려진 한계(§11 C7, §9) |
| C10 | 쓰기 가능 판정은 앱 안쪽만으로 부족하다 — 부모 디렉터리·볼륨·소유자 | 판정 규칙(§5.2) |
| C11 | 이어받기 없음, 준비 뒤 취소 없음, 늦은 이벤트 | 상태 기계·작업 ID(§5.1) |
| C12 | generic provider는 다중 Range를 켜지만 GitHubProvider는 GitHub(S3) 때문에 끈다 | 런타임 feed 옵션(§6.1) |
| C13 | 조회는 `desktop-v*`도 고르는데 feed를 `v<ver>`로 만들면 다른 경로. 태그·yml·번들 버전 불일치를 아무도 안 본다. `minimumSystemVersion`은 Darwin 버전과 비교된다 | 실제 태그 보존·발행 단언·`allowDowngrade=false`·최소 OS 사전 확인(§5.5·§6) |
| C14 | electron-updater는 feed를 코드로 줘도 `Resources/app-update.yml`의 `updaterCacheDirName`을 읽는다. `check-bundle`은 런타임 의존성 0을 단언한다 | 패키징 계약(§6.1) |
| C15 | 공증 제출용 zip은 스테이플 전 앱이다. 발행이 공개 릴리스를 먼저 만들고 자산을 채운다. `--publish never` 없음 | 순서 고정·draft 발행(§6.2·§6.3) |
| C16 | 더 단순한 대안: 다운로드와 설치 예약을 분리 | **채택** — 이 스펙의 뼈대 |

C7(스냅샷 두 개 ≠ 정상 판 두 개)과 `currentBuildId` 재읽기는 §13.

### 3.3 코덱스 스펙 리뷰 (2026-09-25, 1판 대상 — 같은 세션)

1판을 코드·상위 소스와 대조했다. 전부 반영했다. 세션이 재확인한 것은 ✓.

| # | 1판의 문제 | 2판 |
| --- | --- | --- |
| R1 | §3.2 C1의 "2커밋 뒤"가 두 가지로 읽힌다. §4 명령이 실패를 실패로 끝내지 않는다 | "이전 조상 — 미포함"으로 고침. §4 명령을 실패 시 nonzero로 |
| R2 ✓ | `setFeedURL` 뒤 바로 `downloadUpdate()`는 `Please check update first`로 거절된다(`AppUpdater.ts:553`) | §5.1 호출 계약: `setFeedURL` → `checkForUpdates` → manifest 대조 → `downloadUpdate` |
| R3 | 준비를 무엇으로 시작하는지 없다. electron-updater `quitAndInstall()`은 자동 설치 listener를 붙인다. 1판이 인용한 분기 이름이 6.8.9에 없다(`if (this.autoInstallOnAppQuit)`) | §5.1: 준비 = Electron 내장 `autoUpdater.checkForUpdates()` 한 번, 설치 = 내장 `quitAndInstall()`. electron-updater 버전 고정 |
| R4 | `useMultipleRangeRequest`를 yml에만 쓰면 런타임 `setFeedURL`에 안 간다 | §6.1: 런타임 feed 객체에 넣는다 |
| R5 ✓ | Node `fs.statfs`에 mount flag가 없다(`MNT_LOCAL` undefined). 로컬 ≠ 내장. 표준 사용자 정책이 §2.2와 어긋난다 | §5.2: `df` → `diskutil info -plist`의 `Internal`·`WritableVolume`. 표준 사용자 정책 명시 |
| R6 ✓ | `quit()` 잎은 결과를 못 받는다. 기존 테스트가 정지 예외의 reject를 단언한다(`quit-flow.test.ts` "quits even when stopping the services throws"). §5.3과 §8의 `committed` 정의가 다르다 | §5.3: 마지막 동작을 결과를 받는 잎으로. 성공 = `stopServices` 결과 `stopped === true`. 테스트 문장 정정 |
| R7 | "allow가 올라가 있어 통과"와 "S7을 게이트가 막는다"가 모순. settle이 설치 중 래치를 내릴 수 있다 | §5.3: allow는 네이티브 `quitAndInstall` 호출 직전에만, 그 사이 await 없음 |
| R8 | `quitAndInstall` 실패는 비동기 `error` 이벤트로도 온다 | §5.3: 동기 예외·비동기 오류·종료 미발생 각각에 시간 상한 + 일반 종료 |
| R9 | 설치 기록을 `installing`에서 쓰면 `staging` 중 크래시를 판정할 수 없다 | §5.6: 준비 호출 **전에** 원자적으로 기록, 실패하면 준비하지 않음 |
| R10 | `expectedBuild`의 출처가 없다. 불일치를 무조건 실패로 부른다 | §6.2: yml에 build ID 발행. §5.6: 적용됨 / 미적용 / 다른 빌드 / 판정 불가 |
| R11 | 되돌리기 확인창이 열린 동안은 `pendingRestore`가 null이다. 다음 프로세스는 idle로 시작한다. `pgrep ShipIt`은 예약 부재를 증명하지 못한다 | §5.4: 확인창 포함 공유 예약, await 뒤 재검사, 미해결 설치 시도 동안 되돌리기 차단. `RESTORE.md` 줄 삭제 |
| R12 | 캐시를 통째로 지우면 차분 기준 `update.zip`도 사라진다. 재기동 뒤 `downloaded` 복원 경로가 없다 | §5.7: pending과 차분 기준 분리, 재기동 복원 절차. C2 시험 정정 |
| R13 | 업데이트 대화상자는 모달 카운터 밖이라 알림끼리 겹칠 수 있다. `app.dock.setProgressBar`는 없다 | §5.5: 표시 잠금 하나 공유, `BrowserWindow.setProgressBar` |
| R14 | `LSMinimumSystemVersion`은 실행 제한이지 설치 전 확인이 아니다 | §5.5·§6.2: manifest에 최소 macOS를 발행, 설치 전 클라이언트가 확인 |
| R15 | draft 업로드 실패 뒤 재실행이 영구히 막힌다. 산출물의 build-info와 태그 커밋 연결을 publish가 안 본다 | §6.3: draft 재개 규칙, 공개 직전 산출물 신원 재확인 |
| R16 ✓ | `buildBlockMap(zip, "gzip")`는 zip 끝에 blockmap을 덧붙인다(`blockmap.ts:57`). "lockfile 폐포" 비교 단위 없음 | §6.2: 세 번째 인자 필수·zip 해시 불변 단언. §6.1 비교 단위 |
| R17 | 공간 실측으로 상수를 낮추는 것은 근거가 없다. C6은 중단 지점을 증명하지 않는다. §12가 C6 한 지점으로 "모든 중단"을 주장한다 | §7: 예산은 계산, 실측은 검증 자료. §11 C6: 유효 회차 정의. §12 문장 축소 |

## 4. 착수 조건

**Electron을 Squirrel.Mac PR #335의 병합 커밋 `5c9e2133c09d6f8e2e3c5a45c5b0ffc00448c58a`를 포함하는 판으로 올릴 수 있을 때**
구현을 시작한다. 판 번호가 아니라 포함 여부로 판정한다. 아래가 0으로 끝나야 한다:

```bash
set -euo pipefail
TAG=<electron tag, 예: v45.0.0>
PIN=$(curl -fsSL "https://raw.githubusercontent.com/electron/electron/${TAG}/DEPS" \
  | grep -A1 "'squirrel.mac_version'" | tail -1 | tr -d " ',")
[[ "$PIN" =~ ^[0-9a-f]{40}$ ]] || { echo "DEPS에서 squirrel.mac_version을 못 찾음: '${PIN}'" >&2; exit 1; }
STATUS=$(gh api "repos/Squirrel/Squirrel.Mac/compare/5c9e2133c09d6f8e2e3c5a45c5b0ffc00448c58a...${PIN}" --jq .status)
case "$STATUS" in ahead|identical) echo "OK ${TAG} → ${PIN} (${STATUS})" ;; *) echo "미포함 ${TAG} → ${PIN} (${STATUS})" >&2; exit 1 ;; esac
```

`ahead` = 핀이 #335보다 뒤에 있고 그것을 포함한다. `behind`(2026-09-25의 v45.0.0-alpha.12)·`diverged`는 미포함이다.

그 판으로의 Electron 업그레이드와 Phase 0~6 회귀는 이 Phase의 **첫 Task**다(계획에서 정한다). 업그레이드만 먼저 필요해지면
(보안 판 등) 따로 낸다. 조건이 채워지기 전까지 사용자는 6b-1 흐름(알림 → DMG)으로 업데이트한다.

## 5. 구조

### 5.1 `update/install-flow.ts` — 상태 기계와 호출 계약 (순수 + 주입)

상태는 한 방향으로 간다. 모든 상태는 **작업 묶음** `{ jobId, version, tag, releaseId, buildId, minMacos }`을 든다
(`buildId`·`minMacos`는 manifest에서 — §6.2). 작업 ID가 다른 이벤트는 로그만 남기고 버린다(늦게 도착한 진행률·완료·오류).

```
idle ─[다운로드 후 설치]→ resolving ─[manifest 일치]→ downloading ─[완료]→ downloaded ─[재시작하여 업데이트]→ committing
  ↑                          │[불일치·실패]              │[실패]                │[나중에] (그대로)                 │[cancelled] → downloaded
  └──────── failed ←─────────┴───────────────────────────┘                      │                                    │[cleanup-failed] → 일반 종료
                                                                                 │                                    │[prepared]
                                                                                 │                                    ↓
                                                                                 │                               staging ─[네이티브 update-downloaded]→ installing
                                                                                 │                                    │[오류·시간 초과] → 일반 종료 (outcome-unknown)
```

**호출 계약** (electron-updater 6.8.9에 고정. 판을 올리면 이 계약을 다시 확인한다):

| 상태 | 부르는 것 | 기다리는 것 |
| --- | --- | --- |
| `resolving` | electron-updater `setFeedURL({ provider: "generic", url: <tag의 download URL>, useMultipleRangeRequest: false })` → `checkForUpdates()` | 결과의 `updateInfo.version`이 선택한 버전과 같고 `isUpdateAvailable === true`. 아니면 `failed(mismatch)` — 다운로드하지 않는다 |
| `downloading` | electron-updater `downloadUpdate()` (`autoDownload=false`, `autoInstallOnAppQuit=false`, `allowDowngrade=false`) | 프라미스 완료. 이 설정이면 electron-updater는 zip을 받고 127.0.0.1 proxy를 띄워 네이티브 feed를 거기 맞추지만 네이티브 준비는 부르지 않는다(`MacUpdater.ts`의 `if (this.autoInstallOnAppQuit)` 분기) |
| `staging` | **Electron 내장** `autoUpdater`에 `update-downloaded`·`error` listener를 먼저 달고 `autoUpdater.checkForUpdates()`를 **정확히 한 번** | 내장 `update-downloaded` |
| `installing` | 모든 창 `destroy()` → 내장 `autoUpdater.quitAndInstall()` | 프로세스 종료 |

electron-updater의 `quitAndInstall()`은 부르지 않는다 — 준비 완료 뒤 자동 설치 listener를 붙여 우리 흐름을 우회한다(R3).

- `downloaded`에서 받은 판보다 더 새 판이 조회되면 알림만 한다("<새 판>이 나왔어요 — 지금 받아 둔 <판>을 설치한 뒤 다시
  확인해 주세요"). feed를 바꾸지 않는다.
- `failed`는 버전별이다. 메뉴 "업데이트 확인…"이 다시 시도를 연다. 사유: `offline` / `disk` / `checksum` / `mismatch` /
  `os-too-old` / `unsupported-location` / `other`.
- `staging` 뒤로는 취소가 없다. 표시도 하지 않는다.
- 한 실행에 `staging`은 최대 한 번.
- proxy는 electron-updater 내부 동작이다. 이 계약이 그것에 기대므로 packaged 통합 시험(§11 C1)이 이 경로 전체를 지난다.

### 5.2 `update/install-eligibility.ts` — 설치 가능 판정 (순수 + 주입 잎)

"다운로드 후 설치"를 누를 때와 `committing` 직전 두 번 본다. 하나라도 거짓이거나 **판정할 수 없으면** 페이지를 연다(사유를
로그에 남긴다).

1. packaged다(`app.isPackaged`).
2. 실제 경로(`fs.realpathSync`로 `.app`까지 정규화)가 App Translocation 경로(`/private/var/folders/…/AppTranslocation/`)가
   아니다. quarantine 속성 유무나 `/Applications` 문자열로 판정하지 않는다(C10).
3. `.app`과 그 부모 디렉터리가 현재 사용자에게 쓰기 가능하다(`fs.accessSync(W_OK)` 둘 다).
4. 부모 디렉터리의 볼륨이 **내장·쓰기 가능**이다. 잎: `df <부모>`로 장치를 얻고 `diskutil info -plist <장치>`의
   `Internal === true`·`WritableVolume === true`. 경로 문자열로 `diskutil`을 부르면 오류가 난다(실측: `diskutil info -plist /Applications`
   → Error, `df /Applications` → `/dev/disk3s1` → `Internal`·`WritableVolume` true). 네트워크 볼륨은 장치가 없어 조회가 실패 → 판정 불가.
   Node `fs.statfs`는 mount flag를 주지 않는다(R5).
5. `.app`의 소유자가 현재 uid다.

**표준 사용자 정책:** 3~5가 참이면 관리자 여부와 무관하게 허용한다 — 그 경우 Squirrel은 privileged helper 없이 교체한다
(대상·부모 쓰기 가능 검사, C10). 거짓이면 관리자라도 페이지 안내다(관리자 인증 창을 이 Phase에서 다루지 않는다).
**확정**(§15.1).

### 5.3 `app/quit-flow.ts` — 종료 준비와 마지막 동작을 나눈다

지금 `runQuitFlow`는 준비(확인 → commit → beginQuit → 핸드셰이크 → 화면 → `stopServices` → 경고)와 마지막 동작(`finally`의
`quit()`)을 한 함수에 묶는다. 마지막 동작을 **결과를 받는 잎**으로 바꾼다:

```ts
type QuitOutcome =
  | { kind: "cancelled" }                     // 확인 취소, 또는 commit이 던짐 — 지금의 두 return
  | { kind: "prepared" }                      // stopServices 결과가 stopped === true
  | { kind: "cleanup-failed"; error?: unknown } // stopServices가 stopped === false이거나 던짐, 경고 표시가 던짐
finish(outcome: QuitOutcome): void            // 지금의 quit()
```

- `cancelled`에서는 `finish`를 부르지 않는다(지금과 같다 — 앱은 산다).
- 그 밖에는 `finally`에서 `finish`를 **반드시** 부른다(Phase 1의 규칙). `cleanup-failed`의 원래 예외는 지금처럼 밖으로 다시
  던진다 — 일반 종료의 동작과 `main.ts` `.catch`는 그대로다.
- 녹음 핸드셰이크 실패는 결과를 바꾸지 않는다(지금처럼 로그만, 종료 진행). **서비스 정지 성공의 판정은 `stopped === true`**다
  — `leaked.length === 0`이 아니다(기존 테스트가 이 차이를 잠근다).
- 일반 종료의 `finish`: 지금의 `quit` 잎(`restoreCommitted`면 relaunch → `quitNow()`)과 같다.
- 설치 경로의 `finish`: `prepared`면 `staging`으로, 그 밖에는 일반 종료의 `finish`.

**래치와 allow:**

- `committing`부터 `installing`까지 종료 진입 래치를 쥔 채로 둔다. 그 사이의 ⌘Q·⌘W는 지금처럼 `ignore`된다(로그).
- `flows.quit.allow()`는 **내장 `quitAndInstall()`을 부르기 바로 앞, 같은 동기 구간에서만** 올린다. 그 사이 await가 없다.
  S7 같은 선행 `before-quit`은 allow 전에 오므로 게이트가 막는다.
- `runQuitFlow(...).finally(settle)`이 `staging` 중에 래치를 내리지 않게 한다: 설치 경로의 `finish`가 돌려준 프라미스가
  끝날 때까지 settle을 미룬다(계획에서 배선을 정한다 — 불변식: `staging`·`installing` 동안 `flows.running() === "quit"`).

**`staging`·`installing`의 실패:**

| 실패 | 처리 |
| --- | --- |
| 준비 호출이 동기로 던짐, 내장 `error`, `STAGING_TIMEOUT_MS` 초과 | 설치 시도 기록을 `outcome-unknown`으로, 일반 종료(`quitNow()`) |
| `quitAndInstall()`이 동기로 던짐, 이후 내장 `error`, `INSTALL_QUIT_TIMEOUT_MS` 안에 종료 안 됨 | 〃 |

일반 종료는 **설치 취소가 아니다** — Squirrel이 이미 예약을 기록했으면 ShipIt이 교체를 시도할 수 있다. 그래서 `outcome-unknown`이다.
오류 listener는 `staging` 완료 뒤에도 떼지 않는다(`installing`의 비동기 오류를 받아야 한다). 창을 `destroy()`하는 대상은
`BrowserWindow.getAllWindows()` 전부다. 창 없이 프로세스만 남는 경우를 시간 상한이 끝낸다.

### 5.4 되돌리기와의 상호 배제

**하나의 작업 예약**을 둔다: `maintenance: null | { kind: "restore" | "install", jobId }`. 확인창을 **띄우기 전에** 잡고, 취소하면 놓는다.

- 되돌리기 메뉴(`main.ts` `onRestore`): `restoreAllowedNow()` → 예약 잡기(실패하면 끝) → 확인창 → await 뒤 **다시** `restoreAllowedNow()`
  → `pendingRestore` 설정. 지금은 확인창 전에만 본다(R11).
- 설치("재시작하여 업데이트"): 예약 잡기 → 되돌리기 저널(`readJournal(...).kind !== "none"`)·`pendingRestore`가 있으면 거부 —
  "되돌리기가 예약돼 있어 지금은 업데이트할 수 없어요. 되돌리기를 마친 뒤 다시 시도해 주세요."
- `restoreAllowedNow()`에 조건 둘: 예약이 `install`이면 거짓, **미해결 설치 시도 기록**(§5.6에서 `staging`·`installing`·
  `outcome-unknown`으로 남은 것)이 있으면 거짓 — 다음 프로세스에서도 막는다.
- 미해결 기록은 §5.6의 판정이 끝나야 지워진다. 판정할 수 없으면(§5.6 "판정 불가") 메뉴 "업데이트 기록 지우기…"로 사람이 지운다 —
  ShipIt 예약이 실제로 남았는지 앱이 증명할 수 없으므로 자동으로 지우지 않는다.

### 5.5 `update/update-flow.ts`·`dialogs.ts` — 알림

- `CheckResult`의 `newer`에 실제 태그·릴리스 ID·자동 설치 가능 여부(자산에 `latest-mac.yml`과 zip이 있는가)를 더한다(C13).
- 자동 설치 가능 + §5.2 통과 → "다운로드 후 설치 / 나중에 / 이 버전 건너뛰기". 아니면 지금 버튼 그대로.
- **표시 잠금 하나**: 새 버전·받음·실패·"더 새 판" 알림이 6b-1의 `presenting`을 공유한다. 업데이트 대화상자는 모달 카운터
  (`modal-tracker.ts`) 밖이라 카운터로는 서로를 막지 못한다(R13).
- 자동으로 뜨는 알림(받음 포함)은 6b-1의 보류 조건을 탄다 — 녹음 조회 **뒤에** 조건을 다시 본다(지금 `autoCheck`와 같은 순서).
  보류되면 메뉴 항목만 남는다. 메뉴에서 사람이 누른 "재시작하여 업데이트"는 수동 확인처럼 보류하지 않는다 — 녹음 중이면 종료
  흐름의 확인이 묻는다.
- 진행률: `BrowserWindow.setProgressBar()`(창이 있을 때) + 메뉴 항목 문구. 창이 없으면 메뉴만.
- **최소 macOS**: 작업 묶음의 `minMacos`(§6.2)가 현재 `process.getSystemVersion()`보다 높으면 `failed(os-too-old)` — "이 판은
  macOS <minMacos> 이상이 필요해요". 다운로드 전에 본다(R14).
- `cancelId`를 준다(6b-1 §3-11).

### 5.6 설치 시도 기록과 새 판 첫 기동

`<userData>/install-attempt.json` (6b-1의 `update-state.json`은 건너뛴 버전 전용이라 섞지 않는다):

```json
{ "jobId": "…", "fromBuild": "0.5.0+abcdef012345", "expectedBuild": "0.6.0+0123456789ab",
  "tag": "v0.6.0", "phase": "staging" | "installing" | "outcome-unknown", "at": "…" }
```

- **내장 준비 호출 전에** `phase: "staging"`으로 원자적으로 쓴다(`tmp` → `rename`). 쓰지 못하면 준비하지 않고 일반 종료 —
  캐시는 남는다(R9). `installing` 진입 때 `phase`를 올린다. 실패 경로는 `outcome-unknown`.
- `expectedBuild`는 manifest의 build ID다(§6.2, R10).
- 다음 기동이 **실행 빌드**(§13.1로 고정한 값)와 비교한다:

| 실행 빌드 | 판정 | 로그·표시 | 기록 |
| --- | --- | --- | --- |
| = `expectedBuild` | 적용됨 | "업데이트를 적용했어요 (<from> → <expected>)" | 지운다 |
| = `fromBuild` | 미적용 | 앱 메뉴 알림 "업데이트가 적용되지 않았어요" — 캐시가 있으면 다시 제안 | 지운다 |
| 둘 다 아님 | 다른 빌드 | "요청한 빌드와 달라요 (<expected> 요청, <실행> 실행)" — 사람이 다른 판을 깔았을 수 있다 | 지운다 |
| 읽을 수 없음·실행 빌드 없음(dev) | 판정 불가 | 로그 | 남긴다(§5.4 메뉴로 지움) |

이 판정은 **바이너리 교체**만 말한다. 서비스 기동 성공은 따로다 — 데이터 가드·마이그레이션 실패는 지금처럼 그 경로가 보인다.

### 5.7 캐시 — 제안용과 차분 기준을 나눈다

electron-updater 캐시(`~/Library/Caches/damwha-desktop-updater/`)에는 두 가지가 있다: `pending/`(받은 판, 설치 제안용)과 루트의
`update.zip`(다음 차분의 기준 — `MacUpdater.ts`가 다운로드 뒤 복사한다).

- 받은 판이 쓸모없어지면(실행 빌드가 그 판 이상, 또는 사람이 "이 버전 건너뛰기") **`pending/`만** 비운다. 루트 `update.zip`은
  남긴다 — 지우면 C2(차분)가 깨진다(R12).
- 재기동 뒤 `downloaded` 복원: 6b-1 조회 → `resolving`(manifest 대조) → `downloadUpdate()`. electron-updater가 `pending/`의 완성
  파일을 sha512로 검증하고 재사용하므로 다시 받지 않는다. 오프라인이면 복원하지 않는다(조회가 먼저라서) — 메뉴 항목이 뜨지 않고,
  온라인이 되면 다음 확인에서 복원된다.

### 5.8 `main.ts` 배선

electron을 값으로 import하는 잎만 둔다(6b-1과 같은 규칙): electron-updater 인스턴스, 내장 `autoUpdater` 이벤트,
`BrowserWindow.setProgressBar`, 메뉴 항목, 창 `destroy`, `df`·`diskutil` 호출. 판정은 모두 §5.1~§5.7의 순수 모듈이다.

## 6. 패키징·발행

### 6.1 번들

- **electron-updater를 유일한 런타임 의존성으로 허용하고 버전을 고정한다**(`6.8.9`, 정확한 버전). `check-bundle` 1번 단언을
  "`dependencies`가 정확히 `{ "electron-updater": "6.8.9" }`"로, 2번을 "`app.asar`의 `node_modules`에 든 패키지 집합(이름·버전)이
  `pnpm list --prod --depth Infinity --json`(desktop)의 집합과 같다"로 바꾼다. 비교 단위는 **패키지 이름·버전**이다 — lockfile에는
  파일 목록이 없다(R16). esbuild로 main에 묶는 안은 버렸다 — 2b 단언(번들 JS = 지금 소스의 `tsc` 결과, 바이트 대조)이 깨진다.
- `Resources/app-update.yml`을 **서명 전에** 쓴다: `provider: generic`, `url`(자리표시), `updaterCacheDirName: damwha-desktop-updater`.
  electron-updater는 이 파일에서 **캐시 이름만** 쓴다 — provider 옵션은 런타임 `setFeedURL` 인자가 전부다(R4). `check-bundle`이
  파일 존재와 캐시 이름을 단언한다.
- 런타임 feed: `{ provider: "generic", url: "https://github.com/Yjason-K/Damwha/releases/download/<조회가 고른 실제 태그>/",
  useMultipleRangeRequest: false }`. `desktop-v*` 태그도 그 태그 그대로 쓴다 — 다만 `desktop-v0.3.x`에는 자동 설치 자산이 없어
  §5.5에서 이미 걸러진다.
- `electron-builder` 호출 전부에 `--publish never`(C15).

### 6.2 `package.mjs --release` 순서와 manifest

지금 순서(공증 → 스테이플 → check-bundle → DMG)에 zip 단계를 **스테이플 뒤·DMG 앞**에 끼운다:

1. `.app` 공증(제출용 zip은 지금처럼 만들고 지운다 — 배포용이 아니다)
2. `.app` 스테이플 → `check-bundle`
3. **배포용 zip**: `ditto -c -k --sequesterRsrc --keepParent Damwha.app out/Damwha-<ver>-arm64-mac.zip`
4. **zip 재검증**: 임시 디렉터리에 `ditto -x -k`로 풀어 `codesign --verify --deep --strict`·`xcrun stapler validate`·
   `spctl --assess --type execute`, 심볼릭 링크 수가 원본과 같은지, 풀린 `build-info.json`이 원본과 같은지
5. **blockmap**: `buildBlockMap(zipPath, "gzip", zipPath + ".blockmap")` — **세 번째 인자 필수**. 빠지면 zip 끝에 덧붙인다
   (`app-builder-lib` 26.15.3 `blockmap.ts:57`). 전후 zip sha512가 같음을 단언(R16).
6. **`latest-mac.yml`**: `version`, `files: [{ url, sha512, size }]`, `path`, `sha512`, `releaseDate`, 그리고 Damwha 필드
   `damwhaBuildId`(= `build-info.json`의 `version+12자리커밋`)·`damwhaMinMacos`(= `electron-builder.yml`의 `LSMinimumSystemVersion`).
   electron-updater의 `minimumSystemVersion`은 **쓰지 않는다** — Darwin 버전과 비교한다(C13). 최소 macOS 확인은 클라이언트가
   `damwhaMinMacos`로 한다(§5.5).
7. 단언: 태그 = `v<package.json version>` = yml `version` = 번들 `CFBundleShortVersionString`; `damwhaBuildId`의 커밋 12자리 =
   `git rev-parse <tag>^{commit}`의 앞 12자리; `damwhaMinMacos` = 번들 `LSMinimumSystemVersion`; build-info가 `-dirty`가 아님.
8. DMG(지금 그대로)

### 6.3 `publish.sh`

- 사전 확인(지금 넷) + 자산 5개(DMG·`.sha256`·zip·`.zip.blockmap`·`latest-mac.yml`)의 존재·해시.
- **산출물 신원 재확인**(R15): zip을 임시로 풀어 `build-info.json`의 커밋 12자리가 태그 커밋과 같은지, yml의 `damwhaBuildId`와 같은지.
  DMG를 마운트해 안의 `build-info.json`도 같은지. 오래된 산출물이 자체 해시만 맞아 통과하는 것을 막는다.
- 태그의 릴리스 상태에 따라:

| 상태 | 동작 |
| --- | --- |
| 없음 | `gh release create <tag> --draft --verify-tag …` → 자산 업로드 |
| draft | **재개**: 이미 올라간 자산은 이름·크기·sha가 로컬과 같으면 건너뛰고, 다르면 멈춘다(사람이 draft를 지우고 다시). 빠진 것만 올린다 |
| 공개됨 | 멈춘다 — 공개된 바이트를 바꾸지 않는다 |

- 업로드 뒤 **draft 자산을 다시 받아** sha512를 yml과 대조 → `gh release edit <tag> --draft=false --latest`.
- draft는 비인증 `GET /releases`에 보이지 않는다(GitHub 문서, 앱의 `release-check.ts`는 인증 헤더를 보내지 않는다) — 앱이 자산이 덜
  올라간 릴리스를 고르지 않는다. C9의 확인은 **비인증** `curl`로 한다(`gh api`는 인증이라 draft가 보인다).
- 사후 단언(Latest = 방금 태그)은 지금 그대로.

## 7. 디스크

**예산은 계산하고, 실측은 예산을 검증하는 자료로만 쓴다**(R17). Z = 대상 manifest의 zip `size`, B = 대상 번들 크기(발행 때
yml에 `damwhaAppSize`로 싣는다 — `du -sk`의 바이트). 단계마다 **그 단계부터 끝까지 새로 필요한 논리 점유**를 볼륨별로 본다:

| 점검 시점 | 볼륨 | 필요량 |
| --- | --- | --- |
| "다운로드 후 설치"(`resolving` 뒤) | 캐시 볼륨(`~/Library/Caches`) | 2Z(받는 중 + `update.zip` 복사) + 이후 단계 몫 |
| `committing` 직전 | 캐시 볼륨 | Z(Squirrel 사본) + B(해제본) |
| 〃 | 앱 볼륨(부모 디렉터리) | B(설치 사본) |
| 〃 | 데이터 볼륨(`userData`) | 6b-2 데이터 가드가 새 판 첫 기동에 필요로 하는 양 — 가드의 기존 점검을 **미리** 부른다 |

세 볼륨이 같으면 합산한다(흔한 경우: 전부 내장 Data 볼륨 → 2Z + 2B + 가드 몫 ≈ 4.4 GB + 가드 몫). 여유는 필요량의 10%를
더한다(값은 계획에서 확정). APFS clone으로 실제 감소가 작아도 **예산을 줄이지 않는다** — 틀리면 막는 쪽으로 틀린다. 부족하면
P5-C6의 `diskFull` 문구를 재사용한다. `failed(disk)`.

## 8. 경계 사례

| 상황 | 동작 |
| --- | --- |
| 받는 중 앱 종료 | 종료 흐름이 이긴다. 부분 파일은 electron-updater가 다음 시도에서 지우고 처음부터 |
| 받는 중 잠자기·네트워크 끊김 | `failed(offline)`. 메뉴에서 다시 시도 |
| `downloaded`에서 더 새 판 발견 | 알림만(§5.1). feed 불변 |
| `downloaded`에서 사람이 DMG로 다른 판 설치 | 준비 예약이 없으므로 충돌 없음. 다음 기동의 실행 빌드가 받은 판 이상이면 `pending/`만 비운다(§5.7) |
| `committing`에서 종료 확인 취소 | `cancelled` → `downloaded`로 복귀, 메뉴 항목 유지, 예약 놓음 |
| `committing`에서 녹음 핸드셰이크 실패 | 지금처럼 종료는 진행(로그). `stopServices`가 `stopped === true`면 `prepared` |
| `committing`에서 서비스 정지 실패 | `cleanup-failed` → 일반 종료. 설치하지 않는다. 캐시는 남는다 |
| `staging` 중 크래시 | 설치 시도 기록이 `staging`으로 남아 있다(§5.6). ShipIt이 교체를 시도했을 수 있다. 다음 기동이 판정. 그동안 되돌리기 차단(§5.4) |
| `staging`·`installing` 시간 초과·오류 | `outcome-unknown`, 일반 종료(§5.3). 다음 기동이 판정 |
| `installing` 뒤 ShipIt 실패 | 옛 판이 남는다(C1 수정 포함 전제). 다음 기동 = `fromBuild` → "적용되지 않았어요" |
| DMG에서 바로 실행·외장 볼륨·다른 소유자 | §5.2 거짓 → 페이지 |
| 받은 zip의 sha512 불일치 | electron-updater가 거부 → `failed(checksum)` |
| manifest 버전 ≠ 선택한 버전 | `failed(mismatch)`, 다운로드하지 않음 |
| 대상 판의 최소 macOS > 현재 | `failed(os-too-old)`, 다운로드하지 않음 |
| 0.4.0 이하 릴리스(자동 설치 자산 없음) | 알림은 지금 버튼 그대로 |

## 9. 알려진 한계

- **6c가 담긴 첫 판은 손으로 받아야 한다** — 0.4.x에는 이 기능이 없다(6b-1과 같은 구조).
- 첫 자동 업데이트는 전체(516 MB)를 받는다. 차분은 그다음부터(S6).
- macOS 27에서 ShipIt이 백그라운드 종료되는 문제(Squirrel #336)는 이 Phase가 고치지 못한다. §5.6이 실패를 보이게 할 뿐이다.
- `staging` 뒤 일반 종료로 빠져도 ShipIt 예약이 이미 기록됐으면 교체가 일어날 수 있다 — 앱은 그것을 취소할 수 없다(§5.3).
- 교체 성공은 종료 뒤라 이 프로세스는 모른다(§5.6).
- 설치 중단 안전성은 Squirrel #335에 기댄다. 이 Phase의 시험은 **정의한 중단 지점**에서만 증명한다(§11 C6).
- 차분 25%는 "코드 한 줄 차이" 두 빌드의 값이다. Python·Electron이 바뀌는 판은 더 크다.

## 10. 문서

- `desktop/CLAUDE.md`: 런타임 의존성 규칙(electron-updater 예외·버전 고정), `app-update.yml`, 발행 자산 5개·draft 발행·재개,
  `latest-mac.yml`의 Damwha 필드, §5.1 호출 계약.
- `docs/RESTORE.md`: 설치 시도 기록(`install-attempt.json`)이 남아 있으면 되돌리기 메뉴가 막힌다는 것과 지우는 메뉴.
- 로드맵 §14.

## 11. 테스트·검증

### 11.1 단위 (vitest, `desktop/tests/update/`·`desktop/tests/app/`)

- install-flow: 전이 표 전 행, 작업 ID가 다른 이벤트 버림, 한 실행 한 번 `staging`, `failed` 뒤 재시도, `downloaded` 중 더 새 판,
  `resolving`의 불일치·`isUpdateAvailable=false`에서 다운로드 안 부름, 내장 `checkForUpdates`가 정확히 한 번.
- install-eligibility: 조건 다섯 각각의 거짓, **판정 불가(잎이 던짐)** → 페이지, Translocation 경로 문자열, `diskutil` plist 파싱
  (`Internal`·`WritableVolume` 누락·false).
- quit-flow: 세 결과 각각, **`cancelled`에서 `finish`가 안 불림**, `cleanup-failed`에서 설치 경로의 `finish`가 일반 종료로 감,
  `stopped:false`+`leaked:[]`가 `cleanup-failed`. **일반 종료의 사용자 동작·정리 순서 단언은 그대로 두고, `quit` 잎 이름·인자를 쓰는
  기존 테스트는 `finish(outcome)` 계약에 맞춰 고친다**(정지 예외의 reject 단언은 유지 — §5.3).
- 래치: `staging` 동안 `flows.running() === "quit"`, allow가 내장 `quitAndInstall` 직전에만.
- 설치 시도 기록: 준비 호출 전 기록, 기록 실패 시 준비 안 부름, 다음 기동 판정 표 네 행.
- 되돌리기 배제: 양방향, 확인창 await 뒤 재검사, 미해결 기록에서 차단.
- 캐시: 버릴 때 `pending/`만, 루트 `update.zip` 유지.
- release-check: 실제 태그·자동 설치 가능 여부 보존, `desktop-v*` 태그의 feed URL, 최소 macOS 비교.
- 변이: 위 판정마다 하나 이상(6b와 같은 방식).

### 11.2 packaged 실측 (실제 서명·공증 번들)

| # | 기준 |
| --- | --- |
| C1 | A(6c 포함) → B 자동 업데이트, **GitHub 실제 자산**(draft가 아닌 공개 릴리스, 또는 같은 리다이렉트를 거치는 시험 저장소): 실행 빌드 = B의 `damwhaBuildId`(§5.6 "적용됨"), 6b-2 스냅샷 생성, 회의·설정·토큰·마이크 권한 유지 |
| C2 | **A → B 설치 → 실제 재기동 → C 다운로드**가 전체보다 작게 받는다(electron-updater 로그의 차분 다운로드). 같은 프로세스에서 두 번 받는 시험은 인정하지 않는다 |
| C3 | `downloaded`에서 "나중에" → `kill -9`·정상 종료: 교체 없음, 설치 시도 기록 없음 |
| C4 | `committing`에서 종료 확인 취소 → 교체 없음·메뉴 항목 유지. 서비스 정지 실패 주입 → 교체 없음 |
| C5 | 되돌리기 확인창을 띄운 채 설치 시도 → 거부. 설치 확정 뒤 되돌리기 메뉴 비활성. `staging` 중 크래시 뒤 다음 기동에서 되돌리기 비활성 |
| C6 | **ShipIt 중단 주입.** 유효 회차 = "옛 앱이 임시 위치로 옮겨졌고 새 앱은 아직 자리에 없다"를 파일시스템으로 관측한 순간에 `kill -9`. 그 뒤 재기동·재부팅 → 앱 자리에 **옛 판 또는 새 판**이 있고, 그 build ID·`codesign --verify --deep --strict`·번들 파일 수·서비스 기동이 정상. 관측 못 한 회차는 무효로 센다. **출시 차단 조건** |
| C7 | macOS 27 백그라운드 활동 차단에서 설치(#336). 기기 없으면 **미검증**으로 명시하고 §9에 남긴다 |
| C8 | DMG에서 바로 실행·쓰기 불가 부모·외장 볼륨: 페이지 안내 |
| C9 | 발행: draft 동안 **비인증** `curl …/releases`에 안 잡힘, 공개된 같은 태그 재발행 거부, draft 재개, 산출물 신원 불일치(옛 zip)·태그·yml·번들 버전 불일치 시 중단 |
| C10 | `STAGING_TIMEOUT_MS`·`INSTALL_QUIT_TIMEOUT_MS`의 근거 실측(1.7 GB 해제 시간), §7 예산과 실제 여유 감소의 비교 기록 |

## 12. 완료 기준

- 6c가 담긴 판에서 다음 판으로, 사람이 DMG를 만지지 않고 업데이트되고 회의 기록·설정이 유지된다(C1).
- **정의한 중단 지점(C6)**에서 설치가 끊겨도 앱 자리에 실행 가능한 판이 남는다. 그 밖의 중단 지점은 Squirrel #335의 보장에 기댄다(§9).
- "나중에"·취소·정리 실패는 교체를 일으키지 않는다(C3·C4).

## 13. 관련 결함 (6b-2)

### 13.1 `currentBuildId()`가 매번 디스크를 다시 읽는다 — 이 Phase에서 고친다

`main.ts`의 `currentBuildId()`는 호출마다 `Resources/build-info.json`을 읽는다. 실행 중 `.app`이 바뀌고(수동 설치, 또는 이
Phase 뒤로는 ShipIt) 데이터 가드가 다시 돌면 **옛 JS가 새 빌드 식별자로 generation을 기록**한다. 기동 때 한 번 읽어 고정하고,
디스크 값이 달라진 것을 보면 "재시작 필요"로 로그만 남긴다. §5.6의 "실행 빌드"도 이 고정값이다.

### 13.2 스냅샷 보존 2개가 "정상 판 2개"를 보장하지 않는다 — 결정 필요

`data-guard.ts`는 postmaster·마이그레이션 성공 **전에** generation을 기록하고, `snapshot.ts`는 최신 2개(와 명시적 보호 대상)만
남긴다. 판이 바뀔 때마다 스냅샷이 하나 생기므로, 정상 A 뒤에 **서로 다른 실패 빌드가 둘 이상 이어지면**(A → 실패 B → 실패 C → D)
A 직전의 스냅샷이 밀린다. A → B → C 한 번이면 보통 아직 남는다. 자동 업데이트가 판올림을 쉽게 만들수록 가능성이 커진다.
고치려면 "기동 성공"을 정의해 그 뒤에 generation을 확정하거나, 마지막 정상 스냅샷을 따로 보호해야 한다.
**6c 범위 밖으로 확정했다**(§15.1) — 별도로 다룬다.

## 14. 로드맵 변경

Phase 6 절 "업데이트 방식은 결정됐다 (2026-09-20)" 문단 뒤에 6c를 적는다: 결정 번복과 근거(§1·§3.1), 착수 조건(§4).
(1판과 함께 반영됨.)

## 15. 리뷰 기록

### 15.1 사용자 결정

2026-09-25:

- 다운로드는 알림에서 사람이 누를 때 시작한다(백그라운드 자동 다운로드 아님).
- 1절 초안의 "나중에 = 다음 종료 때 설치"는 코덱스 검토(C3·C16) 뒤 **"나중에 = 캐시만"**으로 바꿨다.
- 착수: 스펙은 지금, 구현은 Squirrel #335를 담은 Electron 뒤(§4).
- 코덱스 스펙 리뷰(§3.3)의 "계획 전 필수" 전부를 반영해 2판을 쓴다.

**확정** (2026-09-25, 스펙 승인과 함께 추천안 채택):

| 항목 | 결정 | 버린 대안 |
| --- | --- | --- |
| 표준 사용자 설치(§5.2) | 앱·부모를 자기 권한으로 교체할 수 있으면 허용, 외장·네트워크 볼륨 제외 | 관리자 계정만 |
| §13.2 스냅샷 보존 | 6c 범위 밖(별도 결정) | 6c에 포함 — generation 확정 시점을 기동 성공 뒤로 |

### 15.2 코덱스 리뷰

- 설계 검토(1절 초안) — §3.2. 세션 재확인: C1(#335·DEPS 핀), C9(#336 open), C14(`updaterCacheDirName`).
- 스펙 리뷰(1판) — §3.3. 세션 재확인: R2(`Please check update first`), R5(`statfs` 필드·`MNT_LOCAL`), R6(reject 단언 테스트),
  R16(`buildBlockMap` 덧붙임). R5의 대안(`df` → `diskutil info -plist <장치>`)은 세션이 실측했다.
