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
재실행 없이도 다음 변이 전 `git status --short desktop/src`가 항상 빈 상태였다(개별 로그는
`.superpowers/sdd/2026-09-23-electron-phase-6b-update-notice/task-9-report.md` 참고).

## 2. 원상 확인

```
$ git status --short desktop/src
(출력 없음)

$ pnpm desktop test
 Test Files  63 passed (63)
      Tests  1168 passed (1168)
```
