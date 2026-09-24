# Electron Phase 6b-1 — 새 버전 알림 (결과)

스펙: [2026-09-23-electron-phase-6b-update-notice-design.md](../specs/2026-09-23-electron-phase-6b-update-notice-design.md)
계획: [2026-09-23-electron-phase-6b-update-notice.md](../plans/2026-09-23-electron-phase-6b-update-notice.md)

## 1. 변이 검증 (P6b1-C8)

17종 변이를 하나씩 `desktop/src/update/`에 넣고 지정한 테스트 파일을
`pnpm --filter damwha-desktop exec vitest run <파일>`로 돌려 빨간불을 확인한 뒤
`git checkout -- desktop/<파일>`로 되돌렸다. 브리프가 준 변이 문구가 실제 코드와 그대로
일치해 동치 변이나 문구 조정 없이 17건 모두 원문 그대로 적용했다.

| # | 변이 | 빨간불이 된 테스트 | 판정 |
| --- | --- | --- | --- |
| M1 | `pickLatest`의 `r.prerelease !== false` 조건 삭제 | `checkForUpdate — 판정 > 후보가 아닌 것을 모두 거른다` | 잡힘 |
| M2 | `TAG_SHAPE`의 끝 `$` 삭제 | `checkForUpdate — 판정 > 후보가 아닌 것을 모두 거른다` | 잡힘 |
| M3 | `compareVersions`를 문자열 비교로 교체 | `compareVersions > 자릿수가 다른 마이너를 숫자로 비교한다`, `checkForUpdate — 판정 > 목록 순서와 무관하게 최대를 고른다 (0.10.0 > 0.9.0)` | 잡힘 |
| M4 | `readAllPages`의 페이지네이션 뒷부분을 `return items;`로 교체 | `checkForUpdate — 요청과 페이지 > Link: next를 따라가 둘째 페이지의 후보를 찾는다`, `… > 페이지 상한(5)에 닿고도 다음이 있으면 malformed`, `… > api.github.com 밖의 next는 따라가지 않고 malformed` | 잡힘 |
| M5 | `latest === null` 분기를 `{ kind: "current", latest: current }`로 교체 | `checkForUpdate — 판정 > 유효한 후보가 없으면 no_release — current라고 말하지 않는다` | 잡힘 |
| M6a | `holdReason`의 `isShuttingDown` 줄 삭제 | `autoCheck — 보류 > 종료 중이면 띄우지 않고 로그를 남기며, 다음 확인에서 띄운다` | 잡힘 |
| M6b | `holdReason`의 `isAttached` 줄 삭제 | `autoCheck — 보류 > 미부착이면 띄우지 않고 로그를 남기며, 다음 확인에서 띄운다`, `… > 녹음 질문 뒤 창이 사라졌으면 띄우지 않는다` | 잡힘 |
| M6c | `holdReason`의 `isOtherModalOpen` 줄 삭제 | `autoCheck — 보류 > 다른 모달이면 띄우지 않고 로그를 남기며, 다음 확인에서 띄운다` | 잡힘 |
| M6d | `if (recording) { … return; }` 블록 삭제 | `autoCheck — 보류 > 녹음 중이면 띄우지 않고 로그를 남기며, 다음 확인에서 띄운다`, `… > 녹음 질문이 거부되면 녹음 중으로 보고 보류한다` | 잡힘 |
| M7 | `const after = holdReason(); if (after !== null) { … }` 블록 삭제 | `autoCheck — 보류 > 녹음 질문 뒤 창이 사라졌으면 띄우지 않는다` | 잡힘 |
| M8 | `presentNewer`의 `shown.add(r.version);` 삭제 | `autoCheck — 표시 > 같은 버전은 실행당 한 번만 묻는다`, `manualCheck > 수동에서 보인 버전은 자동이 다시 묻지 않는다`, `조회 공유와 표시 잠금 > 녹음 답이 엇갈려 온 두 자동 확인이 같은 버전을 두 번 띄우지 않는다`, `… > 자동이 녹음 답을 기다리는 사이 수동이 띄웠으면 자동은 다시 띄우지 않는다` | 잡힘 |
| M9 | `manualCheck`에 `if (r.kind === "newer" && r.version === deps.loadSkipped()) return;` 추가 | `manualCheck > 건너뛴 버전·녹음·미부착을 무시하고 띄운다` | 잡힘 |
| M10 | `check()`의 `if (now < blockedUntil) { … }` 블록 삭제 | `한도 쿨다운 > rate_limited 뒤에는 만료까지 요청하지 않고, 만료 뒤 다시 요청한다` | 잡힘 |
| M11 | `autoCheck`의 `finally { presenting = false; }`를 없애고 `presenting = false;`를 `await presentNewer(r);` 다음 줄로 옮김 | `자동 대화상자 실패 > 자동 대화상자가 실패해도 잠금이 풀려 다음 자동 확인이 띄운다` | 잡힘 |
| M14 | `if (presenting \|\| shown.has(r.version) \|\| r.version === deps.loadSkipped()) return;`를 `if (presenting) return;`으로 교체 | `조회 공유와 표시 잠금 > 녹음 답이 엇갈려 온 두 자동 확인이 같은 버전을 두 번 띄우지 않는다`, `… > 자동이 녹음 답을 기다리는 사이 수동이 띄웠으면 자동은 다시 띄우지 않는다` | 잡힘 |
| M12 | `newerDialogOptions`의 `cancelId: 1,` 삭제 | `newerDialogOptions > 열기가 기본이고 Escape는 나중에다 (스펙 §3-11)` | 잡힘 |
| M13 | `parseIntervalOverride`에서 `\|\| ms > DEFAULT_INTERVAL_MS` 삭제 | `parseIntervalOverride > 범위 안의 정수만 받는다` | 잡힘 |

17건 모두 지정한 테스트 파일에서 빨간불이 됐다 — 살아남은 변이는 없어 테스트를 보강하지
않았다. 매 변이 뒤 `git checkout -- desktop/<파일>`로 되돌렸고, 되돌린 파일은 vitest
재실행 없이도 다음 변이 전 `git status --short desktop/src`가 항상 빈 상태였다. 컨트롤러가
M14를 따로 재현해 같은 두 테스트가 실패하는 것을 확인했다(`2 failed | 27 passed`).

## 2. 원상 확인

```
$ git status --short desktop/src
(출력 없음)

$ pnpm desktop test
 Test Files  63 passed (63)
      Tests  1168 passed (1168)
```

최종 whole-branch 리뷰 뒤 수정(`33992bf`)이 스케줄러 테스트 1개를 더해 전체는 **63 files / 1169 tests**다.
그 테스트는 `clearInterval(every)`를 지우면 빨간불이 되는 것을 확인했다(`1 failed | 7 passed`).

## 3. packaged 실측 (P6b1-C1~C7) — 2026-09-23

GUI 조작(클릭·Escape·녹음·⌘Q·Wi-Fi)은 사용자가 했고, 세션은 빌드·실행·로그·API 조회를 맡았다.
아래 "사용자"는 사용자가 보고한 문장, "로그"는 세션이 `~/Library/Application Support/Damwha/logs/supervisor.log`에서
직접 본 줄이다.

**빌드.** `desktop/package.json`을 임시로 0.3.0으로 낮춘 `pnpm desktop package:desktop`과 원래 0.3.1 빌드를
각각 복사해 두었다(`CFBundleShortVersionString` 0.3.0 / 0.3.1). `package.json`은 원상 복구 확인.

**라이브 API (실측 시작 시).** `desktop-v0.3.1`, `desktop-v0.3.0`, `v0.2.3`, `v0.2.2`, `v0.2.1`, `v0.2.0`,
`v0.1.2`, `v0.1.1` — 전부 `prerelease: false`, `draft: false`. 한도 60/60에서 시작해 실측 끝까지 25회 사용.

| 시나리오 | 조작 | 관측 |
| --- | --- | --- |
| 1-1 열기 (0.3.0, 기본 주기) | 대화상자에서 "다운로드 페이지 열기" | 사용자: 대화상자가 뜨고 브라우저가 릴리스 페이지를 엶, "다 정상". 세션: `update-state.json` 없음 |
| 1-2 Escape (0.3.0, 60초) | 60초 뒤 뜬 대화상자에서 Escape | 사용자: 다시 뜨지 않음. 로그: `업데이트 확인: 0.3.1 (이번 실행에서 이미 알림)` 1분 간격 3회 |
| 1-3 나중에 (0.3.0, 60초) | "나중에" | 사용자: 다시 뜨지 않음. 로그: 같은 줄 2회, `update-state.json` 없음 |
| 4 종료 취소 (1-3과 같은 실행) | 녹음 → ⌘Q → 종료 확인에서 "취소" → 녹음 중지 | 사용자: 취소를 눌렀다고 보고(세션 기록 12:06:27Z). 로그: 12:07:22Z·12:08:22Z에 확인 줄이 계속 찍힘 — 타이머 생존 |
| 3 녹음 중 보류 (0.3.0, 60초) | 붙자마자 녹음 → 1분 넘게 유지 → 중지 → 대화상자에서 "이 버전 건너뛰기" | 로그: `12:12:20Z 업데이트 알림 보류: 녹음 중 (0.3.1)`. 사용자: 중지 뒤 대화상자가 떴고 건너뛰기를 누름. 세션: `update-state.json` = `{"skippedVersion":"0.3.1"}` |
| 1-4 건너뛴 뒤 재실행 (0.3.0, 60초) | 1분 넘게 대기 → 메뉴 "업데이트 확인…" | 사용자: 자동 대화상자 없음, 메뉴를 누르니 0.3.1 대화상자가 뜸. 로그: `업데이트 확인: 0.3.1 (건너뛴 버전)` 1분 간격 |
| 2-1 최신 (0.3.1, 기본 주기) | 메뉴 "업데이트 확인…" | 사용자: "최신 버전" 메시지가 정상으로 뜸. 로그: 붙자마자 자동 확인 `업데이트 확인: 최신 (0.3.1)` |
| 2-2 실패 (0.3.1) | Wi-Fi 끄고 메뉴 확인 | 사용자: 실패 문구가 정상으로 뜸 |
| 2-3 자동 실패 (0.3.0, 60초, 오프라인) | Wi-Fi 끈 채 실행, 90초 대기, ⌘Q, Wi-Fi 복구 | 사용자: 대화상자 없음. 로그: `업데이트 확인 실패 (offline) — GitHub에 연결하지 못했어요 (ENOTFOUND)` 1분 간격 6회 |
| 5 메뉴 | 앱 메뉴 확인, 메뉴의 종료 | 사용자: 메뉴 항목이 다 있었고, 메뉴로 종료함 |

관측 하나 — 업데이트 대화상자가 떠 있는 동안 세션이 `osascript -e 'quit app "Damwha"'`로 보낸 종료는
`User canceled (-128)`로 거절됐다. 대화상자를 닫은 뒤 ⌘Q는 정상 종료였다. macOS가 모달이 떠 있는 앱의
Apple Event 종료를 받지 않는 동작이고 기능 결함은 아니다.

확인하지 않은 것 — 업데이트 대화상자와 종료 확인이 **동시에** 뜨는 경우(스펙 §4.3-8, §7이 허용한 한계)는
일부러 만들지 않았다.

## 4. 판정 (스펙 §9)

| ID | 기준 | 판정 | 근거 |
| --- | --- | --- | --- |
| P6b1-C1 | 낮은 버전 packaged가 실제 API로 새 버전을 자동 알림 | **충족** | §3 1-1·1-2 |
| P6b1-C2 | 세 버튼과 Escape가 명세대로, 건너뛰기가 재실행 뒤에도 유지 | **충족** | §3 1-1~1-4, 3 |
| P6b1-C3 | 수동 확인이 최신·실패를 대화상자로 말함 | **충족** | §3 2-1·2-2 (사용자 보고) |
| P6b1-C4 | 자동 확인의 실패가 화면에 아무것도 띄우지 않음 | **충족** | §3 2-3 (로그 6회 + 사용자 보고) |
| P6b1-C5 | 녹음 중 `newer`를 받고도 보류, 중지 뒤 주기에 표시 | **충족** | §3 3 (보류 로그 + 사용자 보고) |
| P6b1-C6 | 종료 취소 뒤에도 자동 확인 계속 | **충족** | §3 4 (취소 뒤 로그 2회) |
| P6b1-C7 | 앱 메뉴가 기존 항목 유지, 종료가 기존 흐름 | **충족** | §3 5 (사용자 보고). 녹음 중 메뉴 종료의 확인 질문은 이번에 따로 보지 않았다 — ⌘Q 경로는 시나리오 4에서 확인 질문이 떴다 |
| P6b1-C8 | 단위 테스트 초록, 변이 전부 빨간불 | **충족** | §1·§2 (17/17) |
| P6b1-C9 | `pnpm desktop test`·`lint` 초록 | **충족** | 1169 tests, lint clean |
| P6b1-C10 | `--release`가 `v<version>` 태그를 요구 | **충족** | `release-tag.test.ts` 7개(실제 git 저장소로 `desktop-v*`만 있으면 null) + HEAD에서 `assertReleaseTag`가 "(없음)"으로 거절 |

**남은 것.** 이 기능은 이 기능이 들어간 첫 릴리스(`v0.4.0` 예정)부터 작동한다 — 0.3.0·0.3.1 사용자는 그
릴리스를 한 번 손으로 받아야 한다(스펙 §7). 릴리스 노트에 적는다.
