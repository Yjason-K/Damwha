# Electron Phase 6b-1 — 새 버전 알림 (구현 스펙)

작성일: 2026-09-23
브랜치: `feat/electron-migration-phase-6b-update-notice`
선행: Phase 6a 완료 (PR #27), 셀프호스팅 웹 배포 퇴역 (PR #28, `dev` = `d84f009`)

## 1. 목표

**설치된 앱이 새 데스크톱 릴리스가 나왔다는 것을 스스로 알리고, 받을 곳을 연다.** 설치는 사람이 한다.

지금은 0.3.0 설치자가 0.3.1(모델 다운로드 디스크 점검의 과대 산정 수정 — 받을 수 있는 다운로드를
`PERMANENT`로 막을 수 있던 결함)이 나온 것을 알 길이 없다. 6b의 세 덩어리 중 이것만 백업·복원이나
`attempts` 분리와 독립이고, 가장 먼저 사용자에게 닿아야 할 것이라 따로 떼어 먼저 낸다.

## 2. 범위

### 2.1 포함

- GitHub Releases API로 최신 `desktop-v*` 릴리스를 찾아 설치된 버전과 비교한다.
- 자동 확인 — 담화 화면이 처음 붙은 뒤 1회, 그 뒤 24시간마다. packaged 빌드에서만.
- 수동 확인 — 앱 메뉴 "업데이트 확인…". dev·packaged 둘 다.
- 새 버전이 있으면 네이티브 대화상자: 다운로드 페이지 열기 / 나중에 / 이 버전 건너뛰기.
- "이 버전 건너뛰기"의 영속화.

### 2.2 제외 — 그리고 어디로 가나

| 제외 | 이유 | 인계 |
| --- | --- | --- |
| 자동 다운로드·설치 (electron-updater, Squirrel) | 번들이 수 GB라 delta 없이는 매 판올림이 전체 재다운로드다. 2026-09-20에 "알림만"으로 결정(로드맵 Phase 6 절) | 범위 밖 |
| 업데이트 전 백업·복원, 실패 복구 절차 | 6b의 다른 덩어리. 알림과 독립이다 | **6b-2** |
| `attempts` 컬럼 분리 | 스키마 변경 — v1→v2 업그레이드 검증의 시험체 | **6b-3** |
| 렌더러(React) 안 배너 | preload·IPC가 없다는 원칙(Phase 1 스펙 §6.5·§6.11)을 깨거나 `window.__damwha_desktop`에 새 계약을 얹어야 한다. main 전용으로 충분하다(2026-09-23 결정) | 범위 밖 |
| 녹음 종료 즉시 보류된 알림 띄우기 | main이 녹음 종료를 알 채널이 없다. 만들 수는 있으나(렌더러 훅 폴링 등) 알림 하나에 비해 과하다 — **범위 선택**이다 | 범위 밖. 다음 주기 또는 수동 메뉴 |
| 릴리스 노트 본문 표시 | 대화상자에 마크다운을 그릴 수 없다. 릴리스 페이지가 노트를 보여준다 | 범위 밖 |

## 3. 선행 사실

1. **렌더러에서 main을 부를 경로가 없다** (`desktop/src/windows/menu.ts:4`). main이 사람에게
   말하는 길은 메뉴·네이티브 대화상자·main이 연 창뿐이다. 이 기능은 메뉴와 대화상자만 쓴다.
2. **태그 네임스페이스는 6a가 갈라 뒀다** — 데스크톱은 `desktop-v<major>.<minor>.<patch>`
   (6a 스펙 §4), 옛 웹 배포는 `v0.1.1`~`v0.2.3`. 6a 스펙 §11-1이 "6b는 `/releases/latest`가
   아니라 `GET /releases`를 받아 접두사로 거른다"고 정했다.
   **전제 하나가 바뀌었다(2026-09-23)** — 웹 배포를 걷어내 저장소 Latest가 `desktop-v0.3.1`로
   넘어갔다(PR #28 기록 기준 — 이 스펙을 쓰며 라이브 값을 따로 조회하지는 않았다). 그래도 접두사
   필터를 유지한다: 옛 `v*` 릴리스가 남아 있고, Latest 지정은 사람이 손으로 바꿀 수 있는 값이라
   계약이 못 된다.
3. **버전 단일화는 6a가 끝냈다** — 태그 `desktop-v0.3.1`, `package.json`·`app.getVersion()`의
   `0.3.1`, DMG `Damwha-0.3.1-arm64.dmg`(`desktop/scripts/publish.sh:53`)는 **문자열은 다르고
   숫자 셋이 같다.** 파서는 둘로 나눈다 — 설치 버전용(`^\d+\.\d+\.\d+$`)과 태그용
   (`^desktop-v\d+\.\d+\.\d+$`).
4. **외부 HTTP 호출의 선례가 있다** — `desktop/src/config/token-store.ts`의 HF 토큰 검증이
   주입 가능한 `fetch`, 본문 읽기까지 덮는 상한, undici `cause.code` 추출을 이미 갖고 있다.
   같은 모양을 따른다.
5. **"녹음 중인가" 다리의 실제 판정** (`windows/recording-bridge.ts:38`, `main.ts:430`):
   상한 초과 → `true`(녹음 중으로 봄), 호출 거부·예외 → `false`, 창 파괴·훅 없음 → `false`.
   즉 "모르면 녹음 중"은 **시간 초과에만** 성립한다. 이 기능은 그 판정을 그대로 쓰되, 질문 뒤에
   붙음 상태를 **다시 확인한다**(§4.3) — 창이 사라져서 `false`가 나온 경우를 거르기 위해서다.
6. **`attachedWindow`는 "붙었다"의 증거가 아니다** — `reattachWindow()`가 `loadURL` **직전에**
   설정하고(`main.ts:923`), 대상·origin이 없거나 렌더러 준비가 실패해도 정상 반환한다
   (`main.ts:902`). 이 기능은 붙음 성공을 별도로 기록한다(§4.4).
7. **종료는 두 단계다** — `before-quit`은 매번 `preventDefault`하고 확인을 묻는다. 사용자가
   취소하면 앱은 계속 산다. 되돌릴 수 없는 지점은 `beginQuit`이고(`main.ts:1609`) 기존 타이머
   (`readinessTimer`)도 거기서 끈다. 확인 대화상자가 떠 있는 동안 `quitting`은 아직 `false`이고,
   도는 흐름은 `flows.running()`(`"quit" | "close" | null`, `quit-flow.ts:503`)이 안다.
8. **창을 닫아도 앱은 돈다** (`window-all-closed`에서 종료하지 않음, `main.ts:1534`). Dock
   `activate`와 재시도가 `reattachWindow`를 **여러 번** 부른다.
9. **dev와 packaged는 `userData`와 단일 인스턴스 잠금을 공유한다** (`main.ts:92`·`main.ts:1505`).
   두 번째 실행은 기존 프로세스에 포커스만 넘긴다.
10. **GitHub API** ([list releases](https://docs.github.com/en/rest/releases/releases#list-releases),
    [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)):
    public 저장소를 비인증으로 읽는다. 비인증 목록에는 draft가 없지만 발행된 prerelease는 있다.
    한도는 IP당 60회/시간이고 `X-RateLimit-Remaining`·`X-RateLimit-Reset`·`Retry-After`로 알린다.
    `User-Agent`가 없으면 거절된다. **목록 순서는 문서가 보장하지 않는다** — 순서에 기대지 않는다.
11. **Electron 대화상자의 Escape** — `cancelId`를 주지 않으면 버튼 라벨로 취소 버튼을 추정하고,
    한국어 라벨은 인식되지 않아 **0번 버튼(= 다운로드 페이지 열기)**이 선택될 수 있다
    ([dialog 문서](https://www.electronjs.org/docs/latest/api/dialog#dialogshowmessageboxwindow-options)).
    기존 대화상자는 전부 `cancelId`를 명시한다(`main.ts:320·477·496·1290`).

## 4. 구조

새 디렉터리 `desktop/src/update/`. 잎(electron 호출)은 `main.ts`에 남기고 판정은 주입으로 시험한다 —
`app/window-flow.ts`·`app/quit-flow.ts`와 같은 규칙이다.

### 4.1 `update/release-check.ts` — 조회·판정 (순수 + 주입 fetch)

```ts
type CheckResult =
  | { kind: "newer"; version: string; url: string }
  | { kind: "current"; latest: string }
  | {
      kind: "failed";
      reason: "offline" | "timeout" | "rate_limited" | "http" | "malformed" | "no_release";
      detail: string;
      retryAfterMs?: number; // rate_limited일 때
    };

function checkForUpdate(current: string, deps: { fetch: FetchLike; now(): number; timeoutMs?: number }): Promise<CheckResult>;
```

- **요청**: `GET https://api.github.com/repos/Yjason-K/Damwha/releases?per_page=100`,
  헤더 `Accept: application/vnd.github+json`, `User-Agent: Damwha/<current>`,
  `X-GitHub-Api-Version: 2022-11-28`.
- **페이지**: 응답의 `Link: rel="next"`를 따라간다. 상한 5페이지(500건). 상한에 닿았는데 다음
  페이지가 남아 있으면 `failed/malformed`("목록을 다 읽지 못했어요") — **불완전한 조회로 "최신"이라
  말하지 않는다.** 다음 페이지 URL은 `https://api.github.com/`로 시작해야 따라간다.
- **상한**: 전체 조회(모든 페이지의 요청·본문) 10초.
- **후보 조건** — 전부 통과해야 한다:
  - `draft === false`, `prerelease === false` (**엄격한 불리언** — 누락·문자열이면 후보 아님)
  - `tag_name`이 `^desktop-v(\d+)\.(\d+)\.(\d+)$`
- **URL은 응답에서 받지 않고 만든다**: `https://github.com/Yjason-K/Damwha/releases/tag/<tag_name>`.
  태그가 정규식을 통과했으므로 경로에 넣을 수 있는 문자만 있다. `openExternal`에 외부 응답의 문자열이
  닿지 않는다.
- **비교**: 세 정수를 사전식으로. `0.10.0 > 0.9.0`. semver 라이브러리는 들이지 않는다.
- **판정**:
  - 본문이 배열이 아님·JSON 아님 → `failed/malformed`.
  - 항목 하나의 모양이 틀리면 그 항목만 버린다.
  - 모든 페이지를 읽고 **유효한 후보가 하나도 없음** → `failed/no_release`. "최신"이라 말하지 않는다.
  - 최대 후보 > 설치 버전 → `newer`. 아니면 `current` (`latest`에 최대 후보 버전).
  - 설치 버전 자체가 형식 밖 → `failed/malformed`.
- **HTTP 실패**:
  - 403·429이고 `X-RateLimit-Remaining: 0` 또는 `Retry-After`가 있음 → `failed/rate_limited`,
    `retryAfterMs` = `Retry-After`초 또는 `X-RateLimit-Reset` − now (없거나 이상하면 60분).
  - 그 밖의 비200 → `failed/http` (`detail`에 상태 코드).
- 네트워크 오류 → `failed/offline`, 상한 초과 → `failed/timeout`.

### 4.2 `update/update-state.ts` — 건너뛴 버전

- 파일 `<userData>/update-state.json`, 모양 `{ "skippedVersion": "0.3.2" }`.
- **`config.json`에 넣지 않는다** — 그 파일은 자식 프로세스 env의 원천이고(`config/config.ts`),
  사람이 손으로 고치는 파일이다. 앱이 쓰는 상태를 섞으면 저장 한 번이 사람의 편집을 덮는다.
- 읽기 실패·JSON 손상·모양 불일치 → 건너뛴 버전 없음으로 읽는다. 쓰기 실패 → supervisor 로그 한 줄,
  이번 실행에서는 메모리 값으로 계속 존중한다.
- 쓰기는 임시 파일 + `rename`.
- dev와 packaged가 `userData`를 공유하므로(§3-9) 이 파일도 공유된다. 의도된 것이다 — 같은 사람의
  같은 설치다.

### 4.3 `update/update-flow.ts` — 정책 (주입으로 시험)

```ts
interface UpdateFlowDeps {
  check(): Promise<CheckResult>;
  now(): number;
  /** 알림을 띄워도 되는 화면인가 — §4.4의 붙음 기록 + 창 생존 */
  isAttached(): boolean;
  /** isRecordingIn(붙은 창) — §3-5의 판정 그대로 */
  isRecording(): Promise<boolean>;
  /** 종료가 확정됐거나(quitting) 종료·창 닫기 흐름이 도는 중(flows.running() !== null) */
  isShuttingDown(): boolean;
  /** 다른 앱 모달(토큰 창·재시작 안내·종료 확인)이 떠 있는가 — §4.4 */
  isOtherModalOpen(): boolean;
  loadSkipped(): string | null;
  saveSkipped(version: string): void;
  showNewer(info: { current: string; latest: string }): Promise<"open" | "later" | "skip">;
  showInfo(info: { kind: "current"; current: string } | { kind: "failed"; detail: string }): Promise<void>;
  openExternal(url: string): Promise<void>;
  log(line: string): void;
}

function createUpdateFlow(deps: UpdateFlowDeps, current: string): {
  autoCheck(): Promise<void>;
  manualCheck(): Promise<void>;
};
```

**공통 — 조회 공유와 한도 쿨다운**

- 조회가 진행 중이면 새로 부르지 않고 그 프라미스를 기다린다.
- `rate_limited`를 받으면 `blockedUntil = now + retryAfterMs`를 메모리에 둔다. 그 전의 확인은
  **요청 없이** `failed/rate_limited`로 끝낸다(자동·수동 공유). 수동 클릭 연타가 한도를 더 태우지 않는다.

**공통 — 표시 잠금**

- 업데이트 대화상자(새 버전·최신·실패)는 **동시에 하나만.** 잠금이 잡혀 있는 동안:
  - 자동 확인의 결과는 버린다.
  - 수동 확인은 무시한다(이미 대화상자가 떠 있다 — 그게 답이다).
- 잠금은 `finally`에서 푼다. `showNewer`·`showInfo`·`openExternal`의 거부는 잡아서 로그 한 줄로
  끝내고, 다음 확인이 정상 동작해야 한다.

**자동 확인 (`autoCheck`)**

1. `isShuttingDown()`이면 아무것도 하지 않는다.
2. 조회한다.
3. `failed` → `log` 한 줄. 화면에는 아무것도 없다.
4. `current` → 끝.
5. `newer`인데 `version === loadSkipped()` → 끝.
6. `newer`인데 이번 실행에서 **이미 이 버전을 보였다** → 끝.
7. 표시 조건 — 아래 중 하나라도 걸리면 `log`("보류: <사유>")만 남기고 끝. 다음 자동 확인이 다시
   조회해 처리한다(보류 표시를 따로 두지 않는다 — 다시 조회하면 같은 결과가 나온다).
   - `!isAttached()`, `isOtherModalOpen()`, `isShuttingDown()`
   - `await isRecording()`이 `true`
   - **질문 뒤 재확인**: `isRecording()`을 기다린 뒤 `isAttached()`·`isShuttingDown()`을 다시 본다.
8. 표시 잠금을 잡고 대화상자를 띄운다. **띄우기 직전에** "이 버전을 보였다"를 기록한다. 결과:
   - `open` → `await openExternal(url)`
   - `later` → 끝 (이번 실행에서 이 버전은 다시 묻지 않는다)
   - `skip` → `saveSkipped(version)`
   - 대화상자가 떠 있는 사이 `isShuttingDown()`이 참이 됐으면 결과를 **버린다**(열지도, 저장하지도
     않는다). 종료 확인은 그 뒤에 이어진다 — 두 대화상자가 동시에 뜨는 것은 막지 못하지만(macOS
     sheet는 창마다 하나씩 쌓인다) 업데이트 쪽이 종료를 막지는 않는다.

"이미 보였다"는 **버전 단위**다 — 실행 중에 더 새 버전이 나오면 다시 묻는다.

**수동 확인 (`manualCheck`)** — 메뉴에서 사람이 누른 것이다.

- `isShuttingDown()`이면 아무것도 하지 않는다.
- 건너뛴 버전·"이미 보였다"·녹음 중·붙음 여부를 **무시하고** 결과를 항상 말한다
  (`main.ts`의 `ask()`와 같은 원칙 — 사람이 방금 한 행동에 대한 응답):
  - `newer` → 같은 대화상자(버튼 셋, 결과 처리 동일). "이 버전을 보였다"도 기록한다.
  - `current` → "최신 버전을 쓰고 있어요"
  - `failed` → 사유별 문구(§5)
- 표시 잠금은 똑같이 적용된다.

### 4.4 `main.ts` 배선

- **소유**: 업데이트 흐름과 타이머는 **단일 인스턴스 잠금을 이긴 프로세스에 하나** — `main.ts:1505`의
  분기 안에서 만든다.
- **붙음 성공 기록**: `reattachWindow()`에서 `await target.loadURL(...)`이 **성공한 뒤**
  `updateAttached = target`을 둔다. `attachedWindow = null`이 되는 자리(`main.ts:355`)와 창이 준비
  화면으로 되돌아가는 자리에서 함께 지운다. `isAttached()` = `updateAttached !== null &&
  !updateAttached.isDestroyed() && updateAttached === attachedWindow`.
- **자동 확인 무장**: `app.isPackaged`일 때만. 붙음 성공이 **처음** 기록될 때 한 번 무장한다
  (재시도·Dock `activate`로 다시 붙어도 두 번 무장하지 않는다). 무장 = 첫 확인 예약 + `setInterval`.
  확인은 `void flow.autoCheck().catch(log)`로 띄운다 — **기동 경로가 알림을 기다리지 않고**, 알림의
  실패가 `reportFailure()`나 재시도에 닿지 않는다.
- **주기**: 기본 24시간. 개발용 env `DAMWHA_UPDATE_CHECK_INTERVAL_MS`가 **유한한 정수이고
  60,000 ≤ 값 ≤ 86,400,000**이면 그 주기를 쓰고, 그 외에는 무시하고 로그 한 줄. (Node는 `NaN`이나
  2³¹−1 초과를 1ms로 바꾼다.) env가 유효하면 **첫 확인도 붙음 직후가 아니라 한 주기 뒤**에 한다 —
  보류 시나리오를 실측할 수 있게 하기 위해서다(§8.2-4).
- **해제**: `clearInterval`은 `beginQuit` 안(`main.ts:1609`, `readinessTimer` 옆). `before-quit`이
  아니다 — 종료 확인에서 "취소"하면 앱이 계속 살기 때문이다(§3-7).
- **`isShuttingDown()`** = `quitting || flows.running() !== null`.
- **`isOtherModalOpen()`**: 토큰 창이 열려 있음, 그리고 main.ts의 앱 모달(`ask()`,
  재시작 안내 `main.ts:1062`, 종료 확인)을 감싸는 카운터가 0이 아님. 카운터는 이 Phase가 `ask()`와
  재시작 안내 두 곳에 더한다. 상태 창(`statusWindow`)은 모달이 아니라 걸지 않는다.
- **대화상자**: 부모는 `updateAttached`(자동) 또는 `win`(수동, 없으면 부모 없이 — `ask()`와 같다).
  새 버전 대화상자는 `buttons: ["다운로드 페이지 열기", "나중에", "이 버전 건너뛰기"]`,
  **`defaultId: 0`, `cancelId: 1`** — Escape·창 닫기는 "나중에"다(§3-11).
- **`openExternal`** = `shell.openExternal(url)` (`Promise<void>`). 거부는 flow가 잡는다.
- **메뉴**: `MenuHandlers`에 `onCheckForUpdates()`를 더하고 `{ role: "appMenu" }`를 명시 템플릿으로
  바꾼다. Electron 44.3.0의 `appMenu`가 내던 것을 **그대로** 재현한다
  ([menu-item-roles.ts](https://github.com/electron/electron/blob/v44.3.0/lib/browser/api/menu-item-roles.ts)):

  ```
  label: app.name
    { role: "about" }
    { label: "업데이트 확인…", click: onCheckForUpdates }   ← 신규
    { type: "separator" }
    { role: "services" }
    { type: "separator" }
    { role: "hide" } { role: "hideOthers" } { role: "unhide" }
    { type: "separator" }
    { role: "quit" }
  ```

  `quit` role은 `app.quit()`을 거쳐 `before-quit` 흐름에 닿는다(메뉴 종료·⌘Q 모두). `app.exit()`로
  바꾸지 않는다.

## 5. 문구

| 상황 | 제목 | 본문 | 버튼 |
| --- | --- | --- | --- |
| 새 버전 | 새 버전 {latest}이 나왔어요 | 지금 {current}을 쓰고 있어요. 다운로드 페이지에서 DMG를 받아 설치해 주세요. | 다운로드 페이지 열기(기본) / 나중에(Escape) / 이 버전 건너뛰기 |
| 최신 (수동만) | 최신 버전을 쓰고 있어요 | 담화 {current} | 확인 |
| 실패 (수동만) | 업데이트를 확인하지 못했어요 | 사유별 한 줄 + "잠시 뒤 다시 시도해 주세요." | 확인 |

실패 사유별 한 줄:

| reason | 문구 |
| --- | --- |
| offline | 인터넷에 연결되어 있지 않은 것 같아요. |
| timeout | GitHub이 10초 안에 답하지 않았어요. |
| rate_limited | 확인 요청이 너무 많았어요. {N}분 뒤에 다시 시도할 수 있어요. |
| http | GitHub이 오류를 돌려줬어요 (HTTP {status}). |
| malformed | GitHub의 응답을 읽지 못했어요. |
| no_release | 받을 수 있는 데스크톱 릴리스를 찾지 못했어요. |

초안에 있던 "회의 기록은 그대로 남아요"는 뺐다 — 스키마가 바뀌는 판올림에서의 보존은 6b-2·6b-3이
검증하기 전까지 약속할 수 없다.

## 6. 경계 사례

| 상황 | 동작 |
| --- | --- |
| 오프라인·DNS 실패 | `failed/offline`. 자동: 로그만. 수동: 실패 대화상자 |
| 10초 상한 초과 (본문·페이지 포함) | `failed/timeout` |
| 403·429 한도 | `failed/rate_limited` + 쿨다운. 그동안 자동·수동 모두 요청 없이 실패 |
| 그 밖의 비200 | `failed/http` |
| 본문이 배열 아님·JSON 아님, 페이지 상한 초과 | `failed/malformed` |
| 항목 하나 모양 불량 (`draft` 누락 포함) | 그 항목만 버림 |
| 유효한 `desktop-v*` 후보 없음 | `failed/no_release` — "최신"이라 말하지 않음 |
| 설치 버전 ≥ 최신 릴리스 (발행 전 로컬 빌드) | `current` |
| prerelease·`v0.2.3`·`desktop-v0.4.0-rc1` | 후보 아님 |
| 첫 페이지 밖에 있는 데스크톱 릴리스 | `Link: next`를 따라가 찾음 |
| dev 실행 | 자동 확인 없음, 수동 메뉴는 동작 |
| 녹음 중 (또는 렌더러가 상한 안에 무응답) | 자동: 보류 → 다음 주기. 수동: 띄움 |
| 담화 화면 미부착·창 닫힘 | 자동: 보류 → 다음 주기. 수동: 부모 없는 대화상자 |
| 토큰 창·앱 모달이 떠 있음 | 자동: 보류 |
| 종료 확인 대화상자가 떠 있음 (`flows.running() === "quit"`) | 자동·수동 모두 띄우지 않음 |
| 종료 확인 → 취소 | 타이머는 살아 있다. 다음 주기가 정상 동작 |
| 업데이트 대화상자가 떠 있는 동안 종료 시작 | 업데이트 결과는 버림. 종료를 막지 않음 |
| 업데이트 대화상자가 떠 있는데 수동 클릭 / 자동 발화 | 무시 / 버림 |
| 조회 진행 중 수동 클릭 | 같은 조회를 기다려 그 결과로 대화상자 |
| 재시도·Dock 재활성화로 여러 번 붙음 | 타이머는 한 번만 무장 |
| Escape·창 닫기로 대화상자 닫힘 | "나중에" |
| `openExternal` 실패 | 로그 한 줄. 잠금은 풀리고 다음 확인 정상 |
| `update-state.json` 손상 | 건너뛴 버전 없음으로 계속 |
| env 주기가 `NaN`·음수·과대 | 무시하고 24시간 |
| 맥이 잠자기에서 깨어남 | 별도 처리 없음 — 다음 `setInterval` 발화가 확인한다 |

## 7. 알려진 한계

- **이 기능이 들어간 버전부터 작동한다.** 0.3.0·0.3.1 사용자는 이 기능이 담긴 첫 릴리스를 한 번은
  손으로 받아야 한다. 릴리스 노트에 적는다.
- **자동 알림이 뜨는 시점에 상한이 없다.** 녹음 중·창 닫힘이 매 주기와 겹치면 계속 미뤄지고, 잠자기는
  타이머의 벽시계 시간을 지키지 않는다. 약속하는 것은 "다음으로 조건이 맞는 자동 확인"뿐이다.
  수동 메뉴가 언제든 대안이다.
- 공유 IP(사무실 NAT) 뒤에서 한도에 걸리면 그 주기는 조용히 넘어간다.
- 업데이트 대화상자와 종료 확인 대화상자가 동시에 뜰 수 있다(§4.3-8). 둘 다 동작은 정확하다.

## 8. 테스트·검증

### 8.1 단위 (vitest, `desktop/tests/update/`)

- `release-check`:
  - 필터 — prerelease·옛 `v*`·접미사 태그 제외, `draft`/`prerelease` 누락·문자열 값 제외
  - 정렬 — `0.10.0 > 0.9.0`, 목록 순서가 뒤섞여도 최대를 고름
  - 페이지 — 둘째 페이지의 후보를 찾음, 상한 초과는 `malformed`, `api.github.com` 밖의 `next`는 안 따라감
  - 판정 — 설치 버전이 더 높음 → `current`, 후보 없음 → `no_release`, 불량 항목만 있는 배열 → `no_release`
  - URL — 응답의 `html_url`과 무관하게 `/releases/tag/<tag>`로 만듦
  - 실패 — 네트워크·상한(본문이 멈춘 경우 포함)·403 한도(`Retry-After`, `X-RateLimit-Reset` 각각)·
    403 한도 아님·500·비배열·비JSON
  - 요청 헤더 — `User-Agent`·`Accept`
- `update-state`: 없음·손상·정상 읽기, 원자적 쓰기, 쓰기 실패 시 메모리 값 유지.
- `update-flow`:
  - 실행당 버전별 1회, 건너뛰기 존중, 더 새 버전은 다시 묻기
  - 보류 조건 각각(미부착·다른 모달·종료 중·녹음 중), 녹음 질문 뒤 재확인(질문 사이 창이 사라짐)
  - 보류 뒤 다음 확인에서 표시
  - 수동 — 건너뛰기·녹음·미부착 무시, 결과 항상 표시, 종료 중이면 아무것도 안 함
  - 자동 실패는 화면 없이 로그만
  - 조회 공유(동시 호출 → fetch 1회), 표시 잠금(자동/자동, 수동/자동, 자동/수동, 수동/수동)
  - 쿨다운 — `rate_limited` 뒤 요청 없이 실패, 만료 뒤 다시 요청
  - 대화상자가 떠 있는 동안 종료 시작 → 결과 버림
  - `showNewer`·`openExternal` 거부 → 잠금 해제, 다음 확인 정상
- 스케줄러(무장·주기 계산을 순수 함수로 떼어 시험): dev면 무장 안 함, 여러 번 붙어도 무장 1회,
  env 주기 검증(유효·`NaN`·음수·과대·소수), env가 있으면 첫 확인도 한 주기 뒤, 해제 뒤 발화 없음.
- **변이 검증** — 아래 변이를 하나씩 넣어 각각 최소 한 테스트가 빨간불이 되는지 확인한다. 살아남으면
  테스트를 보강한다. 동치 변이는 이유와 함께 기록해 제외한다.
  1. `prerelease === false` 조건 제거
  2. 태그 정규식의 `$` 제거
  3. 비교를 문자열 비교로
  4. `Link: next` 따라가기 제거
  5. `no_release`를 `current`로
  6. 보류 조건 각각 제거 (4개)
  7. 녹음 질문 뒤 재확인 제거
  8. "이미 보였다" 기록 제거
  9. 수동에서 건너뛰기 무시 제거
  10. 쿨다운 검사 제거
  11. 표시 잠금의 `finally` 해제를 성공 경로로만
  12. `cancelId: 1` 제거 (배선 — 대화상자 옵션을 만드는 함수를 순수 함수로 떼어 시험)
  13. env 주기 상한 검사 제거

### 8.2 packaged 실측

**격리 절차 (모든 시나리오 공통):** 실행 중인 담화를 전부 종료하고(dev 포함 — §3-9), 시험할 `.app`의
경로와 `app.getVersion()`을 기록하고, `<userData>/update-state.json`만 지운다. 각 시나리오 시작 시
`curl -s https://api.github.com/repos/Yjason-K/Damwha/releases | jq '[.[] | select(.tag_name|startswith("desktop-v")) | {tag_name, prerelease, draft}]'`
결과를 기록한다 — 라이브 값이 기대의 근거다.

임시 버전 빌드는 `package:desktop`(비-release)로 만든다 — `--release`는 태그 일치를 강제한다
(`package.mjs:26`).

1. `desktop/package.json`을 임시로 `0.3.0`으로 낮춘 packaged 빌드 → 실제 API로 0.3.1 대화상자가
   자동으로 뜬다. 세 버튼과 Escape 각각:
   - 열기 → 릴리스 페이지(`/releases/tag/desktop-v0.3.1`)가 브라우저에 열림
   - 나중에 → 이번 실행에서 다시 안 뜸(짧은 env 주기로 한 주기 넘겨 확인)
   - Escape → "나중에"와 같음
   - 건너뛰기 → 재실행해도 자동 대화상자 없음, 수동 메뉴는 여전히 0.3.1을 보여줌
2. 원래 버전으로 → 수동 확인이 "최신 버전을 쓰고 있어요".
3. 네트워크 차단 → 수동: 실패 대화상자(offline) / 자동: 화면 없음, `supervisor.log`에 한 줄.
4. 보류 — 0.3.0 빌드 + `DAMWHA_UPDATE_CHECK_INTERVAL_MS=60000`(첫 확인이 한 주기 뒤로 밀림).
   붙은 직후 라이브 녹음을 시작 → 첫 주기에 대화상자 없음, `supervisor.log`에 "보류: 녹음 중" →
   녹음 중지 → 다음 주기에 대화상자가 뜸.
5. 종료 취소 — 0.3.0 빌드 + 짧은 주기, 첫 알림을 "나중에"로 닫은 뒤 건너뛰기 상태를 지우지 않고
   ⌘Q → 종료 확인에서 취소 → `supervisor.log`에 다음 주기의 확인 로그가 찍힘(타이머 생존).
6. 메뉴 — 앱 메뉴에 담화에 관하여·업데이트 확인…·서비스·숨기기·기타 숨기기·모두 보기·종료가 있고,
   메뉴의 종료와 ⌘Q가 기존 종료 확인 흐름을 탄다.

## 9. 완료 기준

| ID | 기준 | 방법 |
| --- | --- | --- |
| P6b1-C1 | 낮은 버전 packaged 빌드가 실제 API로 새 버전을 자동 알림 | §8.2-1 |
| P6b1-C2 | 세 버튼과 Escape가 각각 명세대로 동작하고 건너뛰기가 재실행 뒤에도 유지 | §8.2-1 |
| P6b1-C3 | 수동 확인이 최신·실패를 대화상자로 말함 | §8.2-2·3 |
| P6b1-C4 | 자동 확인의 실패가 화면에 아무것도 띄우지 않음 | §8.2-3 |
| P6b1-C5 | 녹음 중 `newer` 결과를 받고도 보류하고, 녹음 중지 뒤 주기에 표시 | §8.2-4 (로그로 "받았다·보류했다"를 확인) |
| P6b1-C6 | 종료 취소 뒤에도 자동 확인이 계속됨 | §8.2-5 |
| P6b1-C7 | 앱 메뉴가 기존 항목을 모두 유지하고 종료가 기존 흐름을 탐 | §8.2-6 |
| P6b1-C8 | 단위 테스트 초록, §8.1의 변이 13종 전부 빨간불(동치 변이는 사유 기록) | §8.1 |
| P6b1-C9 | `pnpm desktop test`·`pnpm desktop lint` 초록 | static |

## 10. 로드맵 변경

- Phase 6b를 6b-1(알림)·6b-2(백업·복원·실패 복구)·6b-3(`attempts` 분리)으로 나눈다. 6b-1은 앞의
  둘과 독립이라 먼저 낸다. 6b-3의 마이그레이션이 v1→v2 검증의 시험체라는 원래 판단은 그대로다.
- 로드맵 Phase 6 절의 "`/releases/latest`가 아니다" 문단에 §3-2의 전제 변화를 덧붙인다.

## 11. 리뷰 기록

### 11.1 코덱스 스펙 리뷰 (2026-09-23)

20건(blocker 1, should-fix 17, nit 2). 핵심 주장은 코드로 재현해 확인했다 — `before-quit`의
`preventDefault`와 `beginQuit`의 타이머 해제(`main.ts:1575·1609`), 녹음 다리의 거부 → `false`
(`recording-bridge.ts:38`), `cancelId` 관례(`main.ts:320·477·496·1290`).

| # | 지적 | 판정 | 반영 |
| --- | --- | --- | --- |
| 1 | `before-quit`에서 타이머를 끄면 종료 취소 뒤 자동 확인이 영구히 죽는다 (blocker) | 유효 — 재현 확인 | §4.4 해제를 `beginQuit`으로. §8.2-5·C6 신설 |
| 2 | `isQuitting()`이 종료 확인·창 닫기 흐름을 못 본다 | 유효 | `isShuttingDown()` = `quitting \|\| flows.running() !== null`, await 뒤 재확인, 대화상자 중 종료 시작 시 결과 버림 |
| 3 | `attachedWindow`는 `loadURL` 전에 서므로 붙음의 증거가 아니다 | 유효 | §3-6 정정, §4.4 `updateAttached`를 `loadURL` 성공 뒤 기록 |
| 4 | "모르면 녹음 중"은 시간 초과에만 성립 | 유효 — 재현 확인 | §3-5 정정, 질문 뒤 붙음 재확인 |
| 5 | 스케줄러 소유·기동 격리 미정 | 유효 | 단일 인스턴스 분기 안 1개, 무장 1회, `void … .catch` |
| 6 | 토큰 창·재시작 안내와 겹침 | 유효 | `isOtherModalOpen()`, 부모 선택 명시 |
| 7 | 조회 공유가 대화상자 중복을 막지 못함 | 유효 | 표시 잠금과 네 조합 명세 |
| 8 | Escape가 0번(열기)을 고를 수 있음 | 유효 | `defaultId: 0`, `cancelId: 1`, §3-11 |
| 9 | `openExternal`은 `Promise`다 | 유효 | 시그니처 변경, 거부 처리, `finally` |
| 10 | `appMenu` 재현 목록이 모호 | 유효 | 역할 목록 명시, `quit` role 유지 |
| 11 | 한 페이지로 최대를 못 정하고 순서 보장 없음 | 유효 | `Link: next` 추적(상한 5), 순서 주장 삭제 |
| 12 | 한도 뒤 수동 연타가 요청을 반복 | 유효 | 공유 쿨다운, `rate_limited` 분리 |
| 13 | 불량 응답이 거짓 "최신"을 낼 수 있음, URL 접두사 느슨 | 유효 | 엄격 불리언, `no_release`, URL은 태그로 생성 |
| 14 | env 주기 하한만 있으면 1ms 타이머 가능 | 유효 | 유한 정수 60,000~86,400,000 |
| 15 | "최대 24시간 늦게"는 거짓 | 유효 | §7 문구 정정 |
| 16 | 보류 실측이 첫 알림에 오염됨 | 유효 | env가 있으면 첫 확인도 한 주기 뒤. C5에 로그 근거 |
| 17 | 실측의 프로세스·상태 격리 부재 | 유효 | §8.2 격리 절차, 비-release 빌드 |
| 18 | 스케줄러·배선이 테스트되지 않고 변이 집합이 없음 | 유효 | 스케줄러 순수 함수 시험, 변이 13종 명시 |
| 19 | 보류 표시가 아무 데도 안 쓰임, "불가능"이 아니라 범위 선택 | 유효 | 보류 표시 삭제, §2.2에 범위 선택으로 기록 |
| 20 | 버전 "같다"는 문자열 동일이 아님 | 유효 | §3-3 정정, 파서 둘 |

코덱스가 라이브 Latest 값을 조회하지 못했다고 보고했고, 이 스펙도 조회하지 않았다 — §3-2에 명시하고
§8.2의 격리 절차가 시나리오마다 라이브 응답을 기록하게 했다.
