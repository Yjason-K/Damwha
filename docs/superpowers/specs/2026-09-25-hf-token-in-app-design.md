# HF 토큰 — 기동 게이트를 걷고 앱 안에서 입력한다 (구현 스펙)

작성일: 2026-09-25
선행: `dev` = `83fa9d0` (desktop 0.4.0 발행 뒤, P2-A 앱 아이콘·P2-B 시작 화면 반영).
출처: Notion「Electron 전환 이후 개선 사항」P2 — "앱 실행 준비화면에서 토큰 게이트가 준비되어 있음. 이부분 개선 필요".
대체: [Phase 4 스펙](2026-09-16-electron-phase-4-embedded-python-runtime-design.md) §6.4의 "첫 실행 게이트 —
건너뛰기 없음, 창을 닫으면 종료". 그 문서는 날짜가 박힌 기록이라 고치지 않는다 — 이 스펙이 이긴다.

## 1. 목표

**토큰 없이도 앱은 처음부터 쓸 수 있고, 화자 분리가 필요한 동작만 토큰이 있어야 열린다. 토큰은 담화
화면 안에서 넣고 바꾸고 지운다.**

지금은 첫 실행에 셸 창 `token.html`이 떠서 토큰을 넣기 전에는 어떤 서비스도(postgres 포함) 뜨지 않고, 창을
닫으면 앱이 끝난다. 그런데 토큰이 실제로 필요한 곳은 worker의 pyannote 화자 분리 하나다
(`be/worker/damwha_worker/models/pyannote_diar.py`). embed(bge-m3)·실시간 자막(whisper)은 토큰이 필요 없고,
모델은 처음 쓰는 순간에 받으므로 worker·embed는 토큰 없이도 정상으로 뜬다. "토큰 없는 모드가 없다"는 기술
제약이 아니라 Phase 4가 고른 정책이었다.

## 2. 범위

### 2.1 포함

- 기동 게이트 제거 — 기동은 Keychain을 **읽기만** 하고, 없으면 `HF_TOKEN` 없이 서비스를 띄운다(§5.1).
- 토큰 상태를 main이 판정해 담화 화면에 밀어 넣는 다리(`window.__damwha_desktop.hfToken`, §4).
- fe의 세 입력 지점 — 첫 실행 온보딩 카드, 설정의 "허깅페이스 토큰" 섹션, 막힌 동작의 토큰 다이얼로그.
  셋은 **같은 입력 폼 하나**를 쓴다(§3).
- 화자 분리가 필요한 동작의 게이트 — 새 회의(파일 업로드·실시간 녹음)와 재처리(§3.2).
- `hf_token_invalid`·`hf_gate_not_accepted`로 실패한 회의의 원인별 안내(§3.5).
- 녹음 중 토큰 교체 거부(§5.3) — worker 재시작이 실시간 세션을 끊는다.
- `token.html`·`windows/token-window.ts`·`app/token-gate.ts` 제거, 상태 창 토큰 줄을 표시 전용으로(§5.4).

### 2.2 제외

- 모델 사용 조건 동의 여부의 사전 확인. whoami로는 알 수 없고, 게이트 모델의 파일을 실제로 요청해 봐야 한다.
  동의하지 않았다면 처리 중 403으로 드러나고 §3.5가 받는다.
- 계정 이름 보존. whoami 이름은 확인한 그 실행 안에서만 보인다(§4.1).
- 브라우저로 연 웹 화면(개발용)의 토큰 관리. 그 환경의 토큰은 `be/worker/.env`가 맡는다.
- P2-D 모델 다운로드 관리.

## 3. 사용자 흐름

### 3.1 토큰 상태

main이 판정해 fe에 준다. fe는 스스로 판정하지 않는다.

| 상태 | 뜻 | 화면 |
| --- | --- | --- |
| `present` | 저장된 토큰을 읽었다 | 마스킹 값(`maskToken`, 예: `hf_****abcd`). 이번 실행에서 확인했다면 계정 이름도 |
| `absent` | 토큰 파일이 없다 | 입력 폼 |
| `unreadable` | 파일은 있는데 복호화하지 못했다 | "토큰을 읽을 수 없어요 — 다시 입력해 주세요" + 입력 폼. **파일은 지우지 않는다** (Phase 4 규칙 유지) |
| `unavailable` | safeStorage를 쓸 수 없다 | 입력 폼 대신 `CAUSES.safeStorageUnavailable`의 안내 |
| `unknown` | fe가 아직 main의 첫 `show`를 받지 못했다 | 게이트 동작을 "확인 중"으로 잠근다 |

`unknown`은 fe 쪽 상태다 — main은 보내지 않는다. 담화 화면이 붙은 직후의 짧은 틈이다.

### 3.2 게이트

**막는 것**: 새 회의 만들기(업로드·실시간 녹음 둘 다), 재처리. 전부 `process_meeting`을 거쳐 pyannote에
닿는다.
**막지 않는 것**: 회의 보기·검색·저장한 발화·렌즈·화자 관리·설정·내보내기.

상태가 `present`가 아닐 때 막힌 동작을 누르면 **토큰 다이얼로그**가 뜬다. 저장에 성공하면 다이얼로그가 닫히고
사용자는 그 자리에서 원래 동작을 다시 누른다(원래 동작을 자동으로 이어 실행하지 않는다 — 업로드 파일
선택처럼 사람이 다시 확인해야 하는 단계가 있다). `unavailable`이면 다이얼로그는 입력 폼 대신 안내만 보인다.

### 3.3 첫 실행 온보딩

- 상태가 `absent`이고 이번 실행에서 넘기지 않았으면(`onboardingDismissed === false`) 담화 화면 안에 온보딩
  카드를 띄운다: 화자 분리에 토큰이 필요한 이유, 허깅페이스 페이지 두 개(사용 조건 동의·토큰 만들기)를 여는
  버튼, 입력 폼, **나중에 하기**.
- **"나중에 하기"는 이번 앱 실행 동안만 유효하다.** 앱을 다시 켜면 토큰이 없는 한 카드가 다시 뜬다.
  - 기억은 main 메모리다. localStorage는 재실행 뒤에도 남아 요구와 반대가 되고, sessionStorage는 macOS에서
    창을 닫았다 Dock으로 다시 열면(앱은 살아 있다) 새 창이라 카드가 또 뜬다. main 메모리는 "이번 앱 실행"과
    수명이 정확히 같다.
- `unreadable`도 카드를 띄운다(문구만 다르다). `unavailable`에는 카드를 띄우지 않는다 — 넣을 수 없는 입력을
  권하지 않는다. 설정 섹션이 안내를 보인다.

### 3.4 설정 — "허깅페이스 토큰" 섹션

상태·마스킹 값·(있으면) 계정 이름, 입력/교체 폼, 삭제. 삭제는 fe가 확인 다이얼로그를 띄운 뒤 `clear`를
보낸다. 확인 문구는 지금 `clearHfToken`의 것을 옮긴다 — 도는 서비스는 옛 토큰으로 계속 돌고, 그 서비스가 다시
뜨면 토큰 없이 뜬다. 삭제 뒤에는 게이트가 다시 닫힌다.

### 3.5 이미 실패한 회의

`meeting.error.code`가

- `hf_token_invalid`(401) — "허깅페이스 토큰이 없거나 맞지 않아 화자 분리를 하지 못했어요" + **토큰 설정
  열기**(토큰 다이얼로그) + 재처리 안내.
- `hf_gate_not_accepted`(403) — "화자 분리 모델의 사용 조건에 동의하지 않은 계정의 토큰이에요" + **사용 조건
  페이지 열기**(`open: "accept"`) + 재처리 안내.

지금은 둘 다 일반 문구("처리에 실패했어요 / 다시 업로드하거나…")다(`fe/src/pages/meeting.tsx`의
`ProcessingBanner`). 토큰이 `present`인데 폐기된 경우도 여기서 드러난다.

### 3.6 웹(개발용)

데스크톱 다리가 없으면 `useHfToken()`은 `{ desktop: false }`다 — 게이트는 전부 통과, 토큰 UI는 숨긴다.
Electron 판별은 `navigator.userAgent`의 `Electron`이다. Electron인데 첫 `show`가 아직 없으면 `unknown`(§3.1).

## 4. 다리 — `window.__damwha_desktop.hfToken`

`fe/src/features/meeting/lib/desktop-bridge.ts`의 기존 객체(`isRecording`·`stopLiveRecording`)에 더한다.
방향 규칙은 [Phase 2 스펙](2026-09-12-electron-phase-2-service-orchestration-design.md) §6.11 그대로다 — preload도
IPC도 없다. main이 `executeJavaScript`로 **묻고**, 사람이 무언가 하면 그 호출이 답으로 끝난다. 밖으로 나오는
값은 main이 건 호출의 결과이지 렌더러가 연 채널이 아니다. `token.html`·`services.html`과 같은 방식이다.

### 4.1 계약

```ts
interface HfTokenState {
  status: "present" | "absent" | "unreadable" | "unavailable";
  masked: string | null;             // present일 때 maskToken 값
  account: string | null;            // 이번 실행에서 whoami로 확인했을 때만
  onboardingDismissed: boolean;      // 이번 실행에서 "나중에 하기"를 눌렀나
  busy: boolean;                     // 확인·저장·재시작 중
  message: { tone: "info" | "warn" | "error"; text: string } | null;
}

type HfTokenAction =
  | { kind: "submit"; token: string }
  | { kind: "clear" }
  | { kind: "dismissOnboarding" }
  | { kind: "open"; link: "accept" | "tokens" };   // 주소가 아니라 열쇠

hfToken: {
  show(state: HfTokenState): void;   // main → fe. 부를 때마다 통째로 교체
  next(): Promise<HfTokenAction>;    // 사람이 무언가 할 때까지 끝나지 않는다
}
```

- `message`는 HF 응답 문구를 담을 수 있다 — fe는 텍스트로만 그린다(React 기본 이스케이프, HTML 싱크 금지).
- `open`의 주소는 main이 고정 표로 정한다(`HF_GATED_MODEL_PAGE_URL`·`HF_TOKENS_PAGE_URL`). fe는 열쇠만 보낸다.

### 4.2 main — `desktop/src/windows/token-bridge.ts` (새 모듈)

electron을 import하지 않는 흐름 모듈이다(`status-window.ts`와 같은 나눔). 잎(`executeJavaScript`·
`shell.openExternal`·safeStorage)은 main.ts가 주입한다.

- **붙기**: 담화 화면이 실제로 붙을 때마다(`updateAttached`가 서는 자리 — 첫 로드와 ⌘R 모두) `show`로 현재
  상태를 넣고 `next()` 고리를 연다. 창이 바뀌거나 파괴되면 고리를 끝낸다. 한 창에 고리는 하나다.
- **거부**: `next()` 호출이 거부되면(문서 교체·다리 없음) 조용히 끝내고 다음 붙기에서 다시 연다. 다리가 없는
  문서(`undefined`)에 대해 빈 고리를 돌지 않는다.
- **파싱**: 받은 값은 렌더러 데이터다 — 모양을 확인하고 모르는 것은 버린다(`token-window.ts`의
  `parseAction`과 같은 규칙, `submit.token`의 길이 상한 `MAX_TOKEN_INPUT` 포함 — 둘 다 그 파일에서 이 모듈로 옮긴다).
- **동작**
  - `submit`: 녹음 중이면 거부(§5.3) → `busy` → `verifyHfToken` → 실패면 `message`로 원인, 저장 안 함 →
    성공이면 `applyTokenChange`(저장 → 다시 읽어 증명 → live env·캐시 → worker·embed 재시작) → 결과를
    `message`로. 재시작하지 못한 서비스가 있으면 `warn`.
  - `clear`: 파일 삭제, 캐시·live env의 `HF_TOKEN` 제거. **재시작하지 않는다**(지금 `clearHfToken` 규칙).
  - `dismissOnboarding`: main 메모리의 플래그를 세우고 `show`.
  - `open`: 고정 주소를 `shell.openExternal`로.
- **동시성**: 진행 중인 `submit`·`clear`가 있으면 새 요청은 무시하고 `message`로 알린다(지금 `tokenBusy`).
- **종료와 무관**: 종료 흐름은 이 고리를 기다리지 않는다. 렌더러가 멈춰도 ⌘Q가 막히지 않아야 한다
  (`recording-bridge.ts`의 원칙).
- 확인 실패 문구(형식 오류·401·오프라인·시간 초과)는 지금 `token-window.ts`가 만드는 것을 이 모듈로 옮긴다.

### 4.3 fe

- `useHfToken()` 훅 하나 — 다리의 `show`를 구독하는 스토어 위에 선다. 게이트·온보딩·설정·다이얼로그가 전부
  이것만 본다. `submit`·`clear`·`dismissOnboarding`·`open`은 다리의 `next()` 대기열에 넣는 함수로 노출한다.
- `installDesktopBridge`가 `hfToken`도 설치한다. 두 번 설치하지 않는 기존 규칙을 따른다.
- 입력 폼 컴포넌트 하나(`HfTokenForm`)를 온보딩 카드·설정 섹션·토큰 다이얼로그가 공유한다. `type="password"`,
  `autocomplete="off"`, `spellcheck=false` — `token.html`의 입력 속성을 잇는다.
- 게이트 적용 지점: 새 회의 진입(`new-meeting-dialog`를 여는 버튼)과 재처리(`reprocess-dialog` 진입, 실패 배너의
  재처리 포함).

## 5. 기동·서비스 쪽 변화

### 5.1 기동

- `ensureHfToken()`을 기동 경로에서 뺀다. 기동은 `makeTokenStore(...).read()`로 **읽기만** 하고 결과를
  §3.1의 상태로 접는다(파일 없음 → `absent`, 파일은 있는데 null → `unreadable`, `available()`이 false →
  `unavailable`).
- `present`면 지금처럼 `launchEnv`가 `HF_TOKEN`을 python 자식(worker·embed)에 싣는다
  (`PYTHON_ONLY_ENV_KEYS`). 아니면 싣지 않는다.
- **safeStorage를 못 쓰면 기동을 막지 않는다.** 지금은 `ServiceFailure(..., "manual")`로 모든 서비스를
  세우지 않는다. 앞으로는 서비스를 띄우고 토큰 상태만 `unavailable`이다 — 토큰 하나 때문에 회의 보기·검색까지
  막을 이유가 없다. Keychain을 풀고 앱을 다시 켜면 다시 읽는다.

### 5.2 토큰을 넣을 때

- `applyTokenChange` 순서를 그대로 쓴다. worker·embed가 재시작하면 그 순간 돌던 요약·렌즈 job은 끊기고
  `interruptions` 규칙대로 다시 대기열에 선다. 게이트가 새 화자 분리 job을 막으므로 토큰이 없던 동안에는 화자
  분리 job이 돌고 있을 수 없다.

### 5.3 녹음 중 교체 거부

worker 재시작은 `live_session`을 끊는다. `submit`을 받으면 main이 `askIsRecording`(`recording-bridge.ts`)으로
묻고, 녹음 중이면 거부한다 — `message: { tone: "warn", text: "녹음을 마친 뒤 바꿔 주세요." }`. 지금 상태 창의
"토큰 바꾸기"에는 이 방어가 없다. 그 버튼이 없어지므로(§5.4) 새 경로에만 둔다.

### 5.4 걷어내는 것

- `desktop/shell/token.html`, `desktop/src/windows/token-window.ts`, `desktop/src/app/token-gate.ts`와 그 테스트.
  `createTokenWindow`(`shell-window.ts`)도.
- 상태 창(`services.html`)의 "토큰 바꾸기"·"삭제" 버튼과 `ServicesAction`의 토큰 동작. 토큰 줄은 상태·마스킹
  값과 "담화 설정에서 바꿀 수 있어요" 안내만 보인다.
- `tests/windows/shell-html.test.ts`의 페이지 목록에서 `token.html`.

### 5.5 문서

- `desktop/CLAUDE.md` — 토큰 게이트 서술을 이 스펙으로 바꾼다.
- `causes.ts`·`shell-hints.ts`의 `hfTokenInvalid`·`hfGateNotAccepted` 안내가 "토큰 창"을 가리키면 "담화 설정"으로.
- Phase 4 스펙은 고치지 않는다.

## 6. 오류 처리

| 상황 | 동작 |
| --- | --- |
| 확인 실패 — 형식·401·오프라인·시간 초과 | 저장하지 않는다. `message`(`error`/`warn`)로 원인. 입력 칸의 값은 fe가 남겨 둔다 |
| 저장 뒤 다시 읽기 실패 | `applyTokenChange`가 재시작 **전에** 던진다 → "저장하지 못했어요". 서비스는 그대로 |
| 재시작 일부 실패(외부 worker·정리 중) | 토큰은 저장됨. `warn`으로 "다시 시작하지 못함: …" |
| 녹음 중 `submit` | 거부(§5.3) |
| `next()` 거부·창 파괴 | 고리를 조용히 끝내고 다음 붙기에서 다시 연다 |
| 처리 중 401·403 | §3.5 |
| 기동 시 `unreadable` | 파일은 그대로. 새 토큰을 저장하면 덮어쓴다 |

## 7. 테스트

- **desktop**
  - `token-bridge.ts`: 동작 파싱(모르는 동작·길이 상한), `submit` 성공·확인 실패·저장 실패·일부 재시작 실패,
    녹음 중 거부, 동시 요청 무시, `clear`가 재시작하지 않음, `dismissOnboarding`이 상태에 실림, 문서 교체 뒤 다시
    붙기, 다리 없는 문서에서 빈 고리를 돌지 않음.
  - 기동 토큰 상태 판정 — 네 상태, 그리고 `present`일 때만 `HF_TOKEN`이 env에 실림.
  - `unavailable`이 기동을 막지 않음.
  - 상태 창 토큰 줄이 표시 전용(버튼 없음, `ServicesAction`에 토큰 동작 없음).
- **fe**
  - `useHfToken` — 가짜 다리로 상태 수신, 다리 없는 웹은 `{ desktop: false }`, Electron인데 수신 전은 `unknown`.
  - 게이트 — 새 회의·재처리가 `present`에서만 열리고, 아니면 다이얼로그. `unknown`에서는 잠김.
  - 온보딩 — `absent`·`unreadable`에서 뜨고 `unavailable`에서 안 뜸, "나중에 하기"가 `dismissOnboarding`을
    보냄, `onboardingDismissed: false`로 다시 오면(재실행) 다시 뜸.
  - 설정 섹션 — 네 상태의 표시, 삭제 확인 뒤에만 `clear`.
  - 실패 안내 — `hf_token_invalid`·`hf_gate_not_accepted` 각각의 문구와 버튼.
- **변이 확인** — 게이트 조건, 녹음 중 거부, `onboardingDismissed` 반영, `unavailable`의 기동 비차단을 일부러
  깨 보고 테스트가 잡는지 본다.

## 8. 완료 기준 (실측)

dev와 packaged는 같은 `~/Library/Application Support/Damwha`를 쓴다. C1·C4 전에 `hf-token.bin`을 옆에 복사해
두고 끝나면 되돌린다. 토큰 원문은 실측하는 사람만 넣을 수 있다.

| 기준 | 내용 |
| --- | --- |
| C1 | 토큰 파일이 없는 상태로 packaged 앱을 켜면 토큰 창 없이 담화 화면과 온보딩 카드가 뜬다 |
| C2 | "나중에 하기" 뒤 새 회의를 누르면 토큰 다이얼로그가 뜬다. 앱을 다시 켜면 카드가 다시 뜬다 |
| C3 | 앱 안에서 토큰을 넣으면 worker·embed가 재시작되고, 재실행 없이 업로드한 회의가 화자 분리까지 성공한다 |
| C4 | 설정에서 토큰을 지우면 게이트가 다시 닫히고, 다음 실행은 `absent`로 시작한다 |
| C5 | 녹음 중에 토큰을 제출하면 거부되고 녹음은 이어진다 |
| C6 | 토큰이 저장된 기존 설치는 업데이트 뒤 아무것도 묻지 않는다 |
