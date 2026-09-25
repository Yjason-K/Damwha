# Phase 6c 재개 안내 — 앱 안에서 받아 설치하는 업데이트

작성일: 2026-09-25
브랜치: `feat/electron-migration-phase-6c-auto-update` (origin에 푸시됨, PR 없음)
상태: **스펙·계획 확정, 구현 전. 착수 조건(Electron에 Squirrel.Mac #335 포함) 대기로 멈춤.**

이 문서 하나로 나중에 다시 시작할 수 있게 쓴다. 세부는 스펙과 계획에 있고, 여기에는 **지금 어디까지 왔는가, 왜 멈췄는가,
언제·어떻게 다시 시작하는가**만 둔다.

## 1. 무엇을 하려는가

지금(6b-1)은 새 버전 알림이 다운로드 페이지를 열고 사람이 DMG를 받아 덮는다. 6c는 알림에서 "다운로드 후 설치"로 zip을 캐시에
받아 두고, "재시작하여 업데이트"를 누르면 기존 종료 흐름을 끝까지 탄 뒤 Squirrel.Mac이 앱을 새 판으로 바꿔 다시 띄우게 한다.
"나중에"는 캐시만 남긴다. 2026-09-20의 "알림만" 결정을 실측(zip 516 MB, 두 번째 업데이트부터 차분 25%)으로 뒤집은 것이다.

| 문서 | 경로 |
| --- | --- |
| 스펙 (2판) | [2026-09-25-electron-phase-6c-auto-update-design.md](../specs/2026-09-25-electron-phase-6c-auto-update-design.md) |
| 구현 계획 (Task 1~19, 확정) | [2026-09-25-electron-phase-6c-auto-update.md](../plans/2026-09-25-electron-phase-6c-auto-update.md) |
| 로드맵 | [electron-migration-roadmap.md](../../electron-migration-roadmap.md) Phase 6 절의 6c 문단 |

## 2. 여기까지 한 것 (2026-09-25)

- **스파이크** (스펙 §3.1, 코드는 버림): 서명된 장난감 앱으로 종료 흐름 뒤 교체(S1·S3 통과), `app.relaunch()` 재실행 실패(S2, 3/3),
  교체 후 서명 유지(S4), 준비 완료 신호의 차이(S5), 실제 번들 차분 25%(S6). 설계의 뼈대 — "창은 우리가 `destroy()`, 재실행은
  내장 `quitAndInstall()`, relaunch 금지" — 가 여기서 나왔다.
- **코덱스 설계 검토** C1~C16 → "나중에 = 캐시만"으로 축소, 착수 조건 발견(스펙 §3.2).
- **코덱스 스펙 리뷰** R1~R17 → 스펙 2판(스펙 §3.3).
- **계획** Task 1~19. 결정 D1(데이터 볼륨 몫 — 데스크톱에 디스크 여유 점검이 없어 새로 정의), D2(시험 저장소 env), D3(시간 상한 초기값).
- **계획 검증**: Claude 서브에이전트가 Task 2~16의 코드를 복사본에 넣어 매 Task vitest·lint를 돌렸다(끝 상태 lint 통과, 테스트
  1399 통과, 변이 36종). 반영 내용은 계획 끝 "계획 검증 기록".
- 사용자 결정(스펙 §15.1): 사람이 누를 때만 받는다, 표준 사용자도 자기 권한으로 교체 가능하면 허용(외장·네트워크 제외),
  6b-2 스냅샷 보존 결함(§13.2)은 6c 범위 밖.

코드는 한 줄도 바꾸지 않았다. 브랜치의 커밋은 전부 문서다(`e0789d7`~).

## 3. 왜 멈췄나 — 착수 조건

설치 도중 ShipIt(Squirrel의 교체 프로세스)이 죽으면 앱 자리에 빈 폴더가 남을 수 있다. 수정은 Squirrel.Mac PR #335
(병합 커밋 `5c9e2133c09d6f8e2e3c5a45c5b0ffc00448c58a`, 2026-09-18). 데이터 스냅샷으로는 실행 불가능한 앱을 복구할 수 없어서
**이 수정을 담은 Electron이 나오기 전에는 구현하지 않는다**(스펙 §4).

2026-09-25 판정 (각 Electron의 `DEPS` → `squirrel.mac_version` → `5c9e2133`과 compare):

| Electron | 고정된 Squirrel | 판정 |
| --- | --- | --- |
| v44.4.5 (최신 안정판), v44.4.4 | `8d808803` (2026-05-04) | behind — 미포함 |
| v45.0.0-alpha.9~12 | `fffea30e` (2026-08-14) | behind — 미포함 |
| `main` | `eb13da30` = `fffea30e` + Electron 쪽 GN 빌드 파일 | diverged — 미포함 |
| 열린 PR electron/electron#54204 (44-x-y 백포트, 09-22) | `fffea30e`로 올림 | 병합돼도 미포함 |

Squirrel 쪽 순서: `8d808803`(05-04) → `c4a95b0c`·`fffea30e`(08월, 스트리밍·이어받기·차분) → `61e8d079`(09-11, GN 빌드로 교체)
→ **`5c9e2133`(09-18, #335)**. Electron main에 `5c9e2133` 이후로 Squirrel을 올리는 PR이 새로 들어가고, 그것이 안정판으로
백포트되거나 45가 정식 출시돼야 조건이 풀린다. 8월 변경이 main에 닿는 데 한 달 넘게 걸렸으니 몇 주~한두 달로 추정한다(불확실).

## 4. 다시 시작할 때가 됐는지 보는 법

```bash
FIX=5c9e2133c09d6f8e2e3c5a45c5b0ffc00448c58a
for t in $(gh api "repos/electron/electron/releases?per_page=40" --jq '.[] | select(.prerelease==false) | .tag_name' | head -5); do
  PIN=$(curl -fsSL "https://raw.githubusercontent.com/electron/electron/$t/DEPS" | grep -A1 "'squirrel.mac_version'" | tail -1 | tr -d " ',")
  echo "$t ${PIN:0:8} $(gh api "repos/Squirrel/Squirrel.Mac/compare/$FIX...$PIN" --jq .status)"
done
```

어느 안정판이든 `ahead` 또는 `identical`이면 조건이 풀렸다. `behind`·`diverged`는 미포함이다(`diverged`는 Electron이 Squirrel을
자기 쪽 커밋으로 고정한 경우라, 그 커밋이 #335와 같은 변경을 따로 담았는지 사람이 한 번 봐야 한다 — 계획 Task 1 Step 1은 이를
미포함으로 친다). 계획 Task 1 Step 1이 같은 판정을 `desktop/scripts/check-squirrel-fix.sh`로 만든다.

## 5. 재개 전에 다시 확인할 것

시간이 흘러 계획의 전제가 바뀌었을 수 있다. 새 세션이 Task 1 전에 본다:

1. **`dev`에 쌓인 변경.** 이 브랜치는 `dev`의 `5c748f4`에서 갈라졌다. `git fetch && git log --oneline feat/electron-migration-phase-6c-auto-update..origin/dev`
   로 보고, 있으면 브랜치를 `origin/dev` 위로 rebase한다(문서뿐이라 충돌 가능성은 로드맵 파일 정도). 계획이 인용한 줄 번호
   (`main.ts`·`quit-flow.ts`·테스트)가 밀렸으면 실행 중 서브에이전트가 문자열로 찾게 한다.
2. **electron-updater.** 계획은 6.8.9에 고정한다. 더 새 판이 나왔어도 **판을 올리지 않는다** — 호출 계약(스펙 §5.1)과
   `out/providers/Provider` 내부 경로 계약이 6.8.9 기준이다. 올려야 할 이유가 생기면 계획 Task 1 Step 6 실측과 Task 8 계약 테스트를
   새 판으로 다시 하고 스펙 §5.1을 고친다.
3. **새 Electron 판에서 `quitAndInstall`의 "창이 없으면 즉시" 경로**가 그대로인지(계획 Task 1 Step 2).
4. **Squirrel 동작 변화.** #335 이후 Squirrel이 스트리밍·이어받기·차분(`fffea30e` 계열)을 네이티브로 갖게 됐다. 계획은
   electron-updater의 zip 다운로드 + proxy로 Squirrel에 넘기는 경로를 쓴다 — 그 경로가 새 Squirrel에서도 그대로 도는지는
   Task 1 Step 6(호출 계약 실측)이 판정한다. 실패하면 멈추고 설계를 다시 본다.
5. **Squirrel 이슈 #336**(macOS 27에서 ShipIt이 백그라운드로 종료돼 설치가 조용히 실패, 2026-09-19 open)이 고쳐졌는지. 고쳐졌으면
   계획 Task 19 C7과 스펙 §9 한계를 갱신한다.
6. **서명·공증 준비.** `xcrun notarytool history --keychain-profile damwha`가 통하는지 — v0.4.0 발행 때 이 프로필이 키체인에서
   사라져 있었다.
7. 코덱스 재검증은 이번에 하지 않고 확정했다. 재개 시점에 계획을 다시 볼 여유가 있으면 한 번 돌려도 좋다(선택).

## 6. 다시 시작하는 법

worktree가 남아 있으면 그대로 쓴다. 지웠으면:

```bash
git -C /Users/jason/projects/Damwha2 fetch origin
git -C /Users/jason/projects/Damwha2 worktree add /Users/jason/projects/Damwha2-6c feat/electron-migration-phase-6c-auto-update
```

(기본 작업 트리 `/Users/jason/projects/Damwha2`가 비어 있고 다른 세션이 없으면 거기서 브랜치를 바꿔 써도 된다 — 로드맵 규칙은
"기본 저장소 하나, 두 브랜치를 동시에 열 일이 있을 때만 worktree"다.)

새 세션에 아래를 붙여 넣는다. 실행 방식은 subagent-driven으로 정해져 있다(2026-09-25 사용자 결정).

````text
Phase 6c(앱 안에서 받아 설치하는 업데이트) 구현을 시작한다. superpowers:subagent-driven-development 방식으로 실행한다.

## 위치
- 작업은 전부 worktree `/Users/jason/projects/Damwha2-6c`에서 한다(브랜치 `feat/electron-migration-phase-6c-auto-update`, origin에 푸시됨).
  기본 작업 트리 `/Users/jason/projects/Damwha2`를 다른 세션이 쓰고 있으면 거기서 브랜치를 바꾸거나 파일을 고치지 않는다.
  명령은 절대 경로나 `git -C`로 worktree를 가리킨다.
- **먼저 재개 안내를 읽는다**: `docs/superpowers/handoffs/2026-09-25-electron-phase-6c-auto-update-handoff.md` — 특히 §5 "재개 전에 다시 확인할 것".
- 계획: `docs/superpowers/plans/2026-09-25-electron-phase-6c-auto-update.md` (Task 1~19)
- 스펙: `docs/superpowers/specs/2026-09-25-electron-phase-6c-auto-update-design.md` (2판)
- 둘 다 끝까지 읽은 뒤 시작한다. `desktop/CLAUDE.md`, 루트 `CLAUDE.md`도 읽는다.

## 먼저: 착수 조건 (계획 Task 1 Step 1, 스펙 §4)
Squirrel.Mac PR #335(병합 커밋 `5c9e2133…`)를 포함하는 Electron 안정판이 있어야 한다. 최신 안정판 태그로 계획의 `check-squirrel-fix.sh`를 만들어 돌린다.
- exit 1(미포함)이면 **아무것도 구현하지 말고** 결과(태그 → 핀 → compare 상태)만 보고하고 멈춘다. prerelease는 쓰지 않는다.
- exit 0이면 재개 안내 §5를 확인하고(필요하면 origin/dev 위로 rebase) Task 1부터 순서대로 진행한다.

## 실행 규칙
- Task마다 새 구현 서브에이전트 → 새 리뷰 서브에이전트, 리뷰 clean까지 고친 뒤 다음 Task. 마지막에 whole-branch 리뷰.
- 서브에이전트 브리프에 그 Task 전문 + Global Constraints + 계획 결정 D1~D3 + "스펙과 다르면 멈추고 보고"를 넣는다. 계획에 없는 수정이 필요하면 구현하지 말고 나에게 먼저 묻는다.
- 서브에이전트의 측정·"테스트 통과"·영향 평가는 액면가로 받지 않는다. 핵심 주장은 직접 명령을 돌려 재현한다.
- 명령은 worktree 루트에서 `pnpm desktop test`, `pnpm desktop lint`. 단일 파일은 `pnpm --filter damwha-desktop exec vitest run <path>`.
  **`pnpm desktop exec …` 금지** — 테스트 0개로 exit 0이 나는 거짓 초록불이다. lint(`tsconfig.lint.json`)는 `tests/**`까지 타입 검사한다 — 매 Task 끝에 lint 초록.
- `npm install` 금지(훅이 막는다). pnpm만.
- 서브에이전트가 worktree 사본에서 일해야 하면 `rsync --exclude .git`로 복사하고 사본에서 `git init`한다. worktree의 `.git`은 원본 저장소를 가리키는 파일이라 그대로 복사하면 사본의 커밋이 실제 브랜치에 들어간다(지난 세션에서 실제로 일어났다). `git reflog expire`·`gc`·`reset --hard` 같은 저장소 전역 명령은 금지.
- 커밋은 계획의 커밋 단위·메시지 관례를 따른다. 푸시는 Task 몇 개마다 해도 된다. PR은 전부 끝난 뒤 내가 요청할 때 만든다.

## 사람이 필요한 단계 — 그 자리에서 멈추고 나를 부른다
- Task 1 Step 5 packaged 회귀(앱을 띄워 화면 확인), Step 6 호출 계약 실측(Developer ID 서명된 버리는 앱 — 결과 로그를 보여 준다).
- Task 13 Step 3에서 `production closure` 단언이 FAIL이면 고치지 말고 멈춘다.
- Task 19 전체(실데이터 복구 세트, 시험 저장소 `Yjason-K/Damwha-update-test` 생성·발행, 앱 조작, C6 중단 주입). 공개 동작(저장소 생성·태그 푸시·릴리스 발행)은 할 때마다 내 확인을 받는다.
- 공증이 필요한 빌드(`package:release`) 전에 `xcrun notarytool history --keychain-profile damwha`로 인증을 먼저 확인한다.

## 끝나면
Task 18 변이 표·Task 19 C1~C10 판정표를 결과 문서에 채우고, 로드맵 Phase 6 절 6c 상태 문단과 이 재개 안내(§2·§3을 "완료"로)를 갱신하고, whole-branch 리뷰 결과를 보고하고 PR 생성을 제안한다.
````

## 7. 알려진 위험 (재개 전에 알고 들어갈 것)

- **C6(ShipIt 중단 주입)은 출시 차단 조건이다.** 옛 앱이 옮겨지고 새 앱이 아직 자리에 없는 순간은 매우 짧아 관측이 어려울 수
  있다 — 계획은 10회 시도에 유효 회차가 없으면 "관측 불가"로 적고 출시 여부를 사용자에게 묻는다.
- **macOS 27(#336)** 은 이 Phase가 고치지 못한다. 다음 기동 판정(스펙 §5.6)이 실패를 보이게 할 뿐이다.
- **첫 자동 업데이트는 전체(≈516 MB)**를 받는다. 6c가 담긴 첫 판은 손으로 받아야 한다(0.4.x에는 이 기능이 없다).
- 스파이크의 미해명 관측 S7(누가 부른지 모르는 `before-quit` 1회, 게이트가 막아 무해)은 packaged 실측에서도 로그로 지켜본다.
