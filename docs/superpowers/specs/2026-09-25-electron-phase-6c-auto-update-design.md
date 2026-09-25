# Electron Phase 6c — 앱 안에서 받아 설치하는 업데이트 (구현 스펙)

작성일: 2026-09-25
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
- electron-updater로 zip을 받아 **캐시에만** 둔다. 받는 동안 Dock 진행률과 앱 메뉴 항목으로 보인다.
- 다 받으면 "재시작하여 업데이트 / 나중에". "나중에"면 앱 메뉴에 "재시작하여 업데이트(<ver>)"가 남는다.
- "재시작하여 업데이트"는 기존 종료 흐름을 끝까지 탄 **뒤에만** Squirrel.Mac에 준비시키고 설치·재실행한다.
- 설치 가능 여부 판정(경로·볼륨·권한). 불가면 지금처럼 페이지를 연다.
- 되돌리기(6b-2)와 설치의 상호 배제.
- 발행물 추가: zip·`.zip.blockmap`·`latest-mac.yml`. 발행을 draft → 검증 → 공개로 바꾼다.
- `currentBuildId()`를 기동 때 한 번 고정한다(§13.1).

### 2.2 제외 — 그리고 어디로 가나

| 제외 | 이유 | 인계 |
| --- | --- | --- |
| "다음 종료 때 자동 설치"(`autoInstallOnAppQuit`) | 준비된 설치 예약이 앱의 종료·되돌리기·크래시와 독립으로 살아 있어, 크래시·강제 종료에도 정리 절차 없이 교체된다(§3.2 C3) | 후속. 이 Phase가 안정된 뒤 다시 판단 |
| 다운로드 이어받기 | electron-updater가 부분 파일을 이어 받지 않는다(§3.2 C11). 실패하면 처음부터 | 범위 밖 |
| 한 실행에서 두 번째 준비(더 새 판으로 갈아타기) | feed 교체가 앞 준비의 상태를 섞는다(§3.2 C5) | 받음 상태에서 더 새 판이 나오면 알림만 한다(§8) |
| 표준 사용자·다른 소유자·외장 볼륨·네트워크 볼륨 설치 | 관리자 인증 helper·볼륨 간 이동 분기(§3.2 C10) | 페이지 안내로 보낸다 |
| electron-updater 자체의 자동 조회 | 조회는 6b-1이 한다 — Latest를 믿지 않고 `desktop-v*`도 읽는다 | 조회는 그대로 |
| 스냅샷 보존 정책 수정(§13.2) | 6b-2의 결함이고 6c와 독립 | 별도 결정 |

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
| S6 | 실제 번들 두 빌드(코드 한 줄·버전 차이) zip 차분 | 새 zip 515.9 MB 중 **129.0 MB(25%)**, 752 구간. 파일 단위로는 1.0 GB가 바뀐다 — 매 빌드가 모든 Mach-O를 `--timestamp`로 재서명(python 452개·Frameworks 18개·postgres 66개) — 그러나 바뀐 곳이 파일 꼬리의 서명 영역이다 |
| S7 | 미해명 | S3 1회차에서 누가 부른지 모르는 `before-quit` 1회가 `quitAndInstall` 약 0.1초 전에 옴. 종료 게이트가 막아 무해 |

S2·S3가 설계를 정했다. Electron 44.3.0의 `AutoUpdater::QuitAndInstall`은 창이 있으면 `WindowList::CloseAllWindows()` 뒤
window-all-closed 옵저버로 설치하고, **창이 없으면 즉시** `relaunchToInstallUpdate`한다
(`shell/browser/api/electron_api_auto_updater.cc` v44.3.0). 창을 닫게 두면 Damwha의 창 닫기 흐름(`main.ts` `created.on("close")`,
녹음 중 확인)이 끼어들고, 거기서 취소하면 옵저버가 남아 **나중에 창만 닫아도 설치·재실행**된다. 그래서 창은 우리가 `destroy()`한다.

차분은 electron-updater 캐시에 **이전에 업데이터로 받은** `update.zip`이 있어야 계산된다. 6c가 담긴 첫 판에서 받는
첫 자동 업데이트는 전체다.

### 3.2 코덱스 설계 검토 (2026-09-25, consult)

1절 초안(다운로드 → Squirrel 준비 → "나중에"면 다음 종료 때 설치)을 저장소·Electron·electron-updater·Squirrel 소스로 검토했다.
세션 `01a0d66c-452e-7401-9960-0938ce0d7a0e`. 채택한 것과 그 근거:

| # | 발견 | 처리 |
| --- | --- | --- |
| C1 | 설치 도중 ShipIt이 죽으면 옛 앱이 임시 디렉터리에 남고, macOS 정리 뒤 빈 디렉터리가 앱 자리로 복구될 수 있다. 수정은 Squirrel PR #335(2026-09-18 병합, `5c9e2133`) | **착수 조건**(§4). 세션이 재확인: v44.3.0·v44.4.5 모두 `squirrel.mac_version` `8d808803`(2026-05-04), v45.0.0-alpha.12 `fffea30e`는 `5c9e2133`보다 2커밋 뒤 |
| C2 | 준비된 설치 예약과 되돌리기(저널 → `app.relaunch()`)가 독립이라, S2의 relaunch 경쟁을 제품에 다시 넣는다 | 상호 배제(§5.4). 준비는 설치 직전에만 하므로 "준비됨 + 되돌리기"가 공존하지 않는다 |
| C3 | 준비 뒤 크래시·강제 종료도 ShipIt에는 "종료"라 정리 없이 교체된다 | "나중에"는 캐시만 — 준비를 설치 순간으로 미룬다(§2.2) |
| C4 | `runQuitFlow`는 취소·commit 실패·정리 실패를 모두 정상 반환으로 끝낸다 → `await` 뒤 설치를 붙이면 취소해도 설치된다 | 결과를 `cancelled / committed / cleanup-failed`로 돌려준다(§5.3) |
| C5 | 준비된 A 뒤 B로 feed를 바꾸면 Squirrel 정리가 A를 지우는데 electron-updater의 `squirrelDownloadedUpdate`는 true로 남는다 | 한 실행에 준비 한 번(§2.2) |
| C6 | 준비 예약이 남은 채 사람이 DMG로 다른 판을 깔면 예약이 그것을 덮을 수 있다 | 준비가 설치 순간에만 생기므로 창이 닫힌다. `RESTORE.md`에 ShipIt 확인 한 줄(§10) |
| C8 | 필요 공간 2.7 GB는 Squirrel 해제본·설치 사본을 뺀 값 | 단계별 산정(§7) |
| C9 | macOS 27에서 ShipIt이 백그라운드로 종료돼 설치가 조용히 실패(Squirrel 이슈 #336, 2026-09-19, open, 868 MB 앱) | 검증 항목·알려진 한계(§11 C7, §9) |
| C10 | 쓰기 가능 판정은 앱 안쪽만으로 부족하다 — 부모 디렉터리·볼륨·소유자 | 판정 규칙(§5.2) |
| C11 | 이어받기 없음, 준비 뒤 취소 없음, 늦은 이벤트 | 상태 기계·작업 ID(§5.1) |
| C12 | generic provider는 다중 Range를 켜지만 GitHubProvider는 GitHub(S3) 때문에 끈다 | `useMultipleRangeRequest: false`(§6.1) |
| C13 | 조회는 `desktop-v*`도 고르는데 feed를 `v<ver>`로 만들면 다른 경로. 태그·yml·번들 버전 불일치를 아무도 안 본다. `minimumSystemVersion`은 Darwin 버전과 비교된다 | 실제 태그 보존·발행 단언·`allowDowngrade=false`·`minimumSystemVersion` 안 씀(§6) |
| C14 | electron-updater는 feed를 코드로 줘도 `Resources/app-update.yml`의 `updaterCacheDirName`을 읽는다. `check-bundle`은 런타임 의존성 0을 단언한다 | 패키징 계약(§6.1) |
| C15 | 공증 제출용 zip은 스테이플 전 앱이다. 발행이 공개 릴리스를 먼저 만들고 자산을 채운다. `--publish never` 없음 | 순서 고정·draft 발행(§6.2·§6.3) |
| C16 | 더 단순한 대안: 다운로드와 설치 예약을 분리 | **채택** — 이 스펙의 뼈대 |

C7(스냅샷 두 개 ≠ 정상 판 두 개)과 `currentBuildId` 재읽기는 §13.

## 4. 착수 조건

**Electron을 Squirrel.Mac PR #335의 병합 커밋 `5c9e2133c09d6f8e2e3c5a45c5b0ffc00448c58a`를 포함하는 판으로 올릴 수 있을 때**
구현을 시작한다. 판 번호가 아니라 포함 여부로 판정한다:

```bash
PIN=$(curl -s https://raw.githubusercontent.com/electron/electron/<tag>/DEPS | grep -A1 "'squirrel.mac_version'" | tail -1 | tr -d " ',")
gh api repos/Squirrel/Squirrel.Mac/compare/5c9e2133c09d6f8e2e3c5a45c5b0ffc00448c58a...$PIN --jq .status   # ahead 또는 identical이어야 한다
```

그 판으로의 Electron 업그레이드와 Phase 0~6 회귀는 이 Phase의 **첫 Task**다(계획에서 정한다). 업그레이드만 먼저 필요해지면
(보안 판 등) 따로 낸다.

조건이 채워지기 전까지 사용자는 6b-1 흐름(알림 → DMG)으로 업데이트한다.

## 5. 구조

### 5.1 `update/install-flow.ts` — 상태 기계 (순수 + 주입)

상태는 한 방향으로만 간다. 모든 상태는 **작업 묶음** `{ jobId, version, tag, releaseId }`을 든다. 작업 ID가 다른 이벤트는 로그만
남기고 버린다(늦게 도착한 진행률·완료·오류).

```
idle ─[다운로드 후 설치]→ downloading ─[완료]→ downloaded ─[재시작하여 업데이트]→ committing
  ↑                          │[실패]                │[나중에] (그대로)               │[cancelled] → downloaded
  └──────── failed ←─────────┘                      │                                 │[cleanup-failed] → 일반 종료
                                                     │                                 │[committed]
                                                     │                                 ↓
                                                     │                              staging ─[네이티브 update-downloaded]→ installing (destroy → quitAndInstall)
                                                     │                                 │[오류·시간 초과] → 일반 종료, 로그
```

- `downloading`: electron-updater `downloadUpdate()`. `autoDownload=false`, `autoInstallOnAppQuit=false` — 이 설정이면
  electron-updater는 zip을 받은 뒤 네이티브 준비를 시작하지 않는다(`MacUpdater.ts` "autoInstallEvent !== manual"
  분기). 준비는 `staging`에서 우리가 부른다.
- `downloaded`에서 받은 판보다 더 새 판이 조회되면 알림만 한다("<새 판>이 나왔어요 — 지금 받아 둔 <판>을 설치한 뒤 다시
  확인해 주세요"). feed를 바꾸지 않는다.
- `failed`는 버전별이다. 메뉴 "업데이트 확인…"이 다시 시도를 연다. 실패 사유: `offline` / `disk` / `checksum` / `unsupported-location` / `other`.
- `staging` 뒤로는 취소가 없다. 표시도 하지 않는다.
- 한 실행에 `staging`은 최대 한 번.

`installing`의 성공은 이 프로세스가 판정할 수 없다(교체는 종료 뒤다). **새 판 첫 기동이 판정한다**(§5.6).

### 5.2 `update/install-eligibility.ts` — 설치 가능 판정 (순수 + 주입 fs)

"다운로드 후 설치"를 누를 때와 `committing` 직전 두 번 본다. 하나라도 거짓이면 설치 대신 페이지를 연다(이유를 로그에 남긴다).

1. packaged다(`app.isPackaged`).
2. 실제 경로(`fs.realpathSync(app.getPath("exe"))`에서 `.app`까지)가 App Translocation 경로(`/private/var/folders/…/AppTranslocation/`)가 아니다.
   quarantine 속성 유무나 `/Applications` 문자열로 판정하지 않는다(C10).
3. `.app`과 그 부모 디렉터리가 현재 사용자에게 쓰기 가능하다(`fs.accessSync(W_OK)` 둘 다).
4. 부모 디렉터리가 로컬 볼륨이고 읽기 전용이 아니다(`statfs` — `MNT_LOCAL`·`MNT_RDONLY`).
5. `.app`의 소유자가 현재 uid다.

### 5.3 `app/quit-flow.ts` — 결과를 돌려준다

`runQuitFlow(deps): Promise<QuitOutcome>`:

| 결과 | 언제 |
| --- | --- |
| `cancelled` | 확인 대화상자에서 취소, 또는 `commit`이 던짐 (지금의 두 `return`) |
| `committed` | 핸드셰이크·서비스 정지가 오류 없이 끝남 |
| `cleanup-failed` | `stopServices`가 던졌거나 남은 것이 있어 `warn`을 띄움 |

**일반 종료의 동작은 바꾸지 않는다** — 세 결과 모두 지금처럼 `finally`에서 `quit()`이 불리거나(`committed`·`cleanup-failed`)
안 불린다(`cancelled`). 바뀌는 것은 설치 경로가 `quit` 잎 대신 무엇을 부르느냐뿐이다:

- 설치 경로의 `quit` 잎은 `committed`일 때만 `staging`으로 가고, 그 밖에는 기존 `quitNow()`다.
- `staging`이 실패하거나 `STAGING_TIMEOUT_MS`(값은 실측으로 정한다 — 1.7 GB 해제) 안에 네이티브 완료가 안 오면 `quitNow()`.
  캐시는 남아 다음 실행이 다시 제안한다.
- 창 `destroy()`는 `BrowserWindow.getAllWindows()` 전부다. 그 뒤 `quitAndInstall()`이 던지면 `quitNow()` — 창도 없는 프로세스를
  남기지 않는다(Phase 1이 값을 치른 규칙, `main.ts` before-quit 주석).
- `quitAndInstall`이 부르는 `app.quit()`은 이미 `flows.quit.allow()`가 올라가 있어 게이트가 `let-it-quit`으로 통과시킨다(S3).
  S7의 정체 모를 `before-quit`도 같은 게이트가 막는다.

### 5.4 되돌리기와의 상호 배제

- `restoreAllowedNow()`(`main.ts`)에 조건 하나: install-flow가 `committing`·`staging`·`installing`이면 거짓.
- install-flow의 "재시작하여 업데이트"는 되돌리기 저널이 있거나(`readJournal(...).kind !== "none"`) `pendingRestore !== null`이면
  거부한다: "되돌리기가 예약돼 있어 지금은 업데이트할 수 없어요. 되돌리기를 마친 뒤 다시 시도해 주세요."
- 준비가 `staging`에서만 생기고 `staging`은 되돌리기와 배타이므로, **준비된 설치 예약과 되돌리기 저널은 같은 시점에 존재하지
  않는다.** 이것이 C2·C6에 대한 이 설계의 답이다.

### 5.5 `update/update-flow.ts`·`dialogs.ts` — 알림

- `CheckResult`의 `newer`에 실제 태그·릴리스 ID·자동 설치 가능 여부(자산에 `latest-mac.yml`과 zip이 있는가)를 더한다(C13).
- 자동 설치 가능 + §5.2 통과 → 버튼 "다운로드 후 설치 / 나중에 / 이 버전 건너뛰기". 아니면 지금 버튼 그대로.
- 받음 대화상자("<ver>을 받았어요 — 재시작하여 업데이트 / 나중에")는 자동 알림과 같은 보류 조건을 탄다
  (녹음 중·다른 모달·종료 중·화면 미부착). 보류되면 메뉴 항목만 남는다.
- `cancelId`를 준다(6b-1 §3-11과 같은 이유).

### 5.6 새 판 첫 기동

- 6b-2 데이터 가드가 빌드 식별자 변화를 보고 postmaster 전에 스냅샷을 뜬다. 바꾸지 않는다.
- `<userData>/install-state.json`에 `installing` 진입 때 `{ expectedBuild, jobId, at }`를 쓴다(6b-1의 `update-state.json`은
  건너뛴 버전 전용이라 섞지 않는다). 다음 기동이 실행 빌드와 비교한다:
  같으면 "업데이트 완료" 로그 후 지운다. 다르면 "업데이트가 적용되지 않았어요" 로그와 앱 메뉴 알림(대화상자 없음) 후 지운다 —
  캐시가 남아 있으면 다시 제안된다. 이 판정이 C9(ShipIt 조용한 실패)를 사람이 볼 수 있게 하는 유일한 자리다.

### 5.7 `main.ts` 배선

electron을 값으로 import하는 잎만 둔다(6b-1과 같은 규칙): electron-updater 인스턴스, 네이티브 `autoUpdater` 이벤트,
`app.dock.setProgressBar`/`win.setProgressBar`, 메뉴 항목, 창 `destroy`. 판정은 모두 §5.1~§5.3의 순수 모듈이다.

## 6. 패키징·발행

### 6.1 번들

- **electron-updater를 유일한 런타임 의존성으로 허용한다.** `check-bundle` 1번 단언을 "`dependencies`가 정확히
  `["electron-updater"]`"로, 2번을 "`app.asar`의 `node_modules`가 lockfile의 electron-updater 폐포와 정확히 같다"로 바꾼다.
  esbuild로 main에 묶는 안은 버렸다 — 2b 단언(번들 JS = 지금 소스의 `tsc` 결과, 바이트 대조)이 깨진다.
- `Resources/app-update.yml`을 **서명 전에** 쓴다: `provider: generic`, `url`(자리표시 — 런타임에 `setFeedURL`로 덮는다),
  `updaterCacheDirName: damwha-desktop-updater`, `useMultipleRangeRequest: false`. `check-bundle`이 존재와 캐시 이름을 단언한다.
- electron-updater 옵션: `allowDowngrade = false`, `autoDownload = false`, `autoInstallOnAppQuit = false`.
  `latest-mac.yml`에 `minimumSystemVersion`을 넣지 않는다 — electron-updater는 이것을 Darwin 버전(`os.release()`)과
  비교한다(C13). 최소 macOS는 지금처럼 `LSMinimumSystemVersion`(15.0)이 지킨다.
- feed URL은 조회가 고른 **실제 태그**로 만든다: `https://github.com/Yjason-K/Damwha/releases/download/<tag>/`.
- `electron-builder` 호출 전부에 `--publish never`(C15).

### 6.2 `package.mjs --release` 순서

지금 순서(공증 → 스테이플 → check-bundle → DMG)에 zip 단계를 **스테이플 뒤·DMG 앞**에 끼운다:

1. `.app` 공증(제출용 zip은 지금처럼 만들고 지운다 — 배포용이 아니다)
2. `.app` 스테이플 → `check-bundle`
3. **배포용 zip**: `ditto -c -k --sequesterRsrc --keepParent Damwha.app out/Damwha-<ver>-arm64-mac.zip`
4. **zip 재검증**: 임시 디렉터리에 `ditto -x -k`로 풀어 `codesign --verify --deep --strict`·`xcrun stapler validate`·
   `spctl --assess --type execute`, 심볼릭 링크 수가 원본과 같은지
5. blockmap(`app-builder-lib`의 `buildBlockMap`, gzip) → `latest-mac.yml`(`version`·`files[].url/sha512/size`·`releaseDate`)
6. 단언: 태그 = `v<package.json version>` = yml `version` = 번들 `CFBundleShortVersionString`,
   `build-info.json`의 커밋 = 태그 커밋, 작업 트리 깨끗함(`-dirty` 아님)
7. DMG(지금 그대로)

### 6.3 `publish.sh`

- 사전 확인(지금 넷) + 자산 5개(DMG·`.sha256`·zip·`.zip.blockmap`·`latest-mac.yml`)의 존재·해시.
- `gh release create <tag> --draft …` → 자산 업로드 → **draft 자산을 다시 받아** sha512를 yml과 대조 → `gh release edit <tag> --draft=false --latest`.
  draft는 `/releases` 조회에 잡히지 않는다 — 앱이 자산이 덜 올라간 릴리스를 고르지 않는다.
- 같은 태그의 릴리스가 이미 있으면 멈춘다(공개된 바이트를 바꾸지 않는다).
- 사후 단언(Latest = 방금 태그)은 지금 그대로.

## 7. 디스크

Z = zip 크기(0.52 GB), B = `.app` 크기(1.7 GB). 코덱스 산정(C8)의 **논리 점유**:

| 단계 | 새로 필요 | 점검 시점 |
| --- | --- | --- |
| 다운로드 | Z(받는 중) + Z(electron-updater의 `update.zip` 캐시 사본) | "다운로드 후 설치" |
| 준비(Squirrel) | Z(Squirrel이 받은 사본) + B(해제본) | `committing` 직전 |
| 설치(ShipIt) | B(설치 사본) | 〃 (합산) |

`committing` 직전 점검값은 **2Z + 2B + 6b-2 스냅샷·마이그레이션 여유**다. APFS clone 덕에 물리량이 이보다 작을 수 있으므로
계획의 첫 실측 Task가 실제 여유 감소량을 재서 상수를 정한다. 그 전에는 논리값(≈4.4 GB + 여유)을 쓴다 — 틀리면 막는 쪽으로
틀린다. 부족하면 P5-C6의 `diskFull` 원인 문구를 재사용한다.

## 8. 경계 사례

| 상황 | 동작 |
| --- | --- |
| 받는 중 앱 종료 | 종료 흐름이 이긴다. 부분 파일은 electron-updater가 다음 시도에서 지우고 처음부터 |
| 받는 중 잠자기·네트워크 끊김 | `failed(offline)`. 메뉴에서 다시 시도 |
| `downloaded`에서 더 새 판 발견 | 알림만(§5.1). feed 불변 |
| `downloaded`에서 사람이 DMG로 다른 판 설치 | 준비 예약이 없으므로 충돌 없음. 다음 기동의 빌드가 캐시의 판과 같거나 높으면 캐시를 버린다 |
| `committing`에서 종료 확인 취소 | `downloaded`로 복귀, 메뉴 항목 유지 |
| `committing`에서 녹음 핸드셰이크 실패 | 지금처럼 종료는 진행(로그). 서비스 정지가 오류 없으면 `committed` |
| `staging` 중 크래시 | 예약이 생겼을 수 있다 — ShipIt이 교체를 시도한다. 서비스는 이미 정지됐다(`committed` 뒤). 다음 기동이 §5.6으로 판정 |
| `installing` 뒤 ShipIt 실패 | 옛 판이 남는다(C1 수정 포함 전제). 사람이 다시 열면 §5.6이 "적용되지 않았어요" |
| DMG에서 바로 실행 | §5.2가 거짓 → 페이지 |
| 받은 zip의 sha512 불일치 | electron-updater가 거부 → `failed(checksum)` |
| 0.4.0 이하 릴리스(자동 설치 자산 없음) | 알림은 지금 버튼 그대로 |

## 9. 알려진 한계

- **6c가 담긴 첫 판은 손으로 받아야 한다** — 0.4.x에는 이 기능이 없다(6b-1과 같은 구조).
- 첫 자동 업데이트는 전체(516 MB)를 받는다. 차분은 그다음부터(S6).
- macOS 27에서 ShipIt이 백그라운드 종료되는 문제(Squirrel #336)는 이 Phase가 고치지 못한다. §5.6이 실패를 보이게 할 뿐이다.
- 교체 성공은 종료 뒤라 이 프로세스는 모른다(§5.6).
- 차분 25%는 "코드 한 줄 차이" 두 빌드의 값이다. Python·Electron이 바뀌는 판은 더 크다.

## 10. 문서

- `desktop/CLAUDE.md`: 런타임 의존성 규칙(electron-updater 예외), `app-update.yml`, 발행 자산 5개와 draft 발행.
- `docs/RESTORE.md`: "앱이 이상하게 바뀌었으면 먼저 `pgrep -fl ShipIt`으로 설치가 진행 중인지 본다" 한 줄 — 수동 복구 중
  예약이 덮는 경우(C6)는 이 설계에서 생기지 않지만, `staging` 중 크래시(§8)의 흔적을 사람이 알아볼 수 있게.
- 로드맵 §12.

## 11. 테스트·검증

### 11.1 단위 (vitest, `desktop/tests/update/`·`desktop/tests/app/`)

- install-flow: 전이 표 전 행, 작업 ID가 다른 이벤트 버림, 한 실행 한 번 `staging`, `failed` 뒤 재시도, `downloaded` 중 더 새 판.
- install-eligibility: 조건 다섯 각각의 거짓, Translocation 경로 문자열.
- quit-flow: 세 결과 각각, **`cancelled`에서 설치 잎이 안 불림**, `cleanup-failed`에서 설치 잎이 안 불림, 일반 종료 동작 불변(기존 테스트 전부 초록).
- 되돌리기 배제: 양방향.
- release-check: 실제 태그·자동 설치 가능 여부 보존, `desktop-v*` 태그의 feed URL.
- 변이: 위 판정마다 하나 이상(6b와 같은 방식 — [[review-by-mutation]]).

### 11.2 packaged 실측 (실제 서명·공증 번들, GitHub 실제 자산 또는 그와 같은 리다이렉트)

| # | 기준 |
| --- | --- |
| C1 | 0.x(6c 포함) → 0.y 자동 업데이트: 기대 빌드 식별자로 재기동(§5.6 "완료" 로그), 6b-2 스냅샷 생성, 회의·설정·토큰·마이크 권한 유지 |
| C2 | 두 번째 자동 업데이트가 전체보다 작게 받는다(electron-updater 로그의 차분 다운로드, 실제 GitHub 자산) |
| C3 | `downloaded`에서 "나중에" → 강제 종료(`kill -9`)·정상 종료: 교체 없음 |
| C4 | `committing`에서 종료 확인 취소 → 교체 없음·메뉴 항목 유지. 정리 실패 주입 → 교체 없음 |
| C5 | 되돌리기 예약 중 설치 거부, 설치 확정 뒤 되돌리기 메뉴 비활성 |
| C6 | **ShipIt 중단 주입: 옛 앱을 옮긴 직후 ShipIt `kill -9` → 재기동·재부팅 → 앱이 실행 가능.** 출시 차단 조건 |
| C7 | macOS 27 백그라운드 활동 차단에서 설치(#336). 기기 없으면 **미검증**으로 명시하고 §9에 남긴다 |
| C8 | DMG에서 바로 실행·쓰기 불가 부모 디렉터리: 페이지 안내 |
| C9 | 발행 스크립트: draft 동안 앱 조회에 안 잡힘, 같은 태그 재발행 거부, 태그·yml·번들 버전 불일치 시 빌드 중단 |
| C10 | `STAGING_TIMEOUT_MS`·§7 상수의 실측값 기록 |

## 12. 완료 기준

- 6c가 담긴 판에서 다음 판으로, 사람이 DMG를 만지지 않고 업데이트되고 회의 기록·설정이 유지된다(C1).
- 업데이트가 중간에 끊겨도 앱이 실행 불가 상태로 남지 않는다(C6).
- "나중에"·취소·정리 실패는 교체를 일으키지 않는다(C3·C4).

## 13. 관련 결함 (6b-2)

### 13.1 `currentBuildId()`가 매번 디스크를 다시 읽는다 — 이 Phase에서 고친다

`main.ts`의 `currentBuildId()`는 호출마다 `Resources/build-info.json`을 읽는다. 실행 중 `.app`이 바뀌고(수동 설치, 또는 이
Phase 뒤로는 ShipIt) 데이터 가드가 다시 돌면 **옛 JS가 새 빌드 식별자로 generation을 기록**한다. 기동 때 한 번 읽어 고정하고,
디스크 값이 달라진 것을 보면 "재시작 필요"로 로그만 남긴다. 6c가 교체를 앱 안으로 들이므로 여기서 닫는다.

### 13.2 스냅샷 보존 2개가 "정상 판 2개"를 보장하지 않는다 — 결정 필요

`data-guard.ts`는 postmaster·마이그레이션 성공 **전에** generation을 기록하고, `snapshot.ts`는 최신 2개만 남긴다. 정상 A → 실패 B →
실패 C로 가면 A의 스냅샷이 밀릴 수 있다. 자동 업데이트가 판올림을 쉽게 만들수록 가능성이 커진다. 고치려면 "기동 성공"을 정의해
그 뒤에 generation을 확정하거나, 마지막 정상 스냅샷을 따로 보호해야 한다. **6c 범위에 넣을지 사용자가 정한다.**

## 14. 로드맵 변경

Phase 6 절 "업데이트 방식은 결정됐다 (2026-09-20)" 문단 뒤에 6c를 적는다: 결정 번복과 근거(§1·§3.1), 착수 조건(§4).

## 15. 리뷰 기록

### 15.1 사용자 결정 (2026-09-25)

- 다운로드는 알림에서 사람이 누를 때 시작한다(백그라운드 자동 다운로드 아님).
- 1절 초안의 "나중에 = 다음 종료 때 설치"는 코덱스 검토(C3·C16) 뒤 **"나중에 = 캐시만"**으로 바꿨다.
- 착수: 스펙은 지금, 구현은 Squirrel #335를 담은 Electron 뒤(§4).

### 15.2 코덱스 설계 검토 (2026-09-25)

§3.2. 세션이 재확인한 것: C1(#335·Electron DEPS 핀), C9(#336 open), C14(`app-update.yml`의 `updaterCacheDirName`).
