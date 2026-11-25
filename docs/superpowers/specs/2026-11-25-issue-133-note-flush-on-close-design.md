# 창 닫기·앱 종료 전 메모 flush 설계

**작성일:** 2026-11-25
**선행:** `dev` @ `068eb5d3`
**작업 브랜치:** `fix/issue-133-note-flush-on-quit`
**이슈:** #133 (서비스 점검 보고서 FE-4 세 번째 항목)
**대체:** 없음. Phase 2 스펙 §6.9·§6.10의 종료·창 닫기 순서에 단계 하나를 더한다.

## 문제

메모 자동저장은 마지막 입력 후 800ms debounce를 거쳐 PUT한다(`fe/src/features/meeting/api/notes.ts`).
그 창 안의 입력을 보내는 것은 `useAutosaveNote`의 React cleanup(언마운트·회의 전환)뿐이다. ⌘W와 ⌘Q는
렌더러를 cleanup 없이 파괴하므로, 그 창 안에서 닫으면 마지막 입력이 서버에 가지 않을 수 있다.

### 코드로 확인한 사실

- fe에 `beforeunload`·`pagehide`·`visibilitychange` 처리가 없다.
- `runCloseFlow`는 녹음 중이 아니면 렌더러에 아무것도 묻지 않고 창을 닫는다.
- `runQuitFlow`는 녹음·분석이 없으면 확인 없이 "종료 중" 화면을 건다. 이 화면은 `win.loadFile`이라 렌더러를
  파괴한다. 그 다음 `stopServices`가 API를 내린다.
- debounce가 막 끝나 PUT이 가는 중이어도, 응답 전에 렌더러가 파괴되면 요청이 끊길 수 있다.
- fe `apiClient`에는 timeout이 없다.

### 재현·측정

- jsdom에서 debounce 중 언마운트하면 PUT 1회가 나간다(이슈 본문). React 경로는 정상이다.
- 실제 데스크톱 앱에서 ⌘W·⌘Q를 눌러 본 측정은 **하지 않았다**. 유실은 위 코드 사실에서 추론한 것이다.

## 목표

1. 창 닫기·앱 종료가 확정되면, 렌더러를 파괴하거나 API를 내리기 **전에** 대기 중인 메모 입력을 보내고
   이미 나간 저장까지 끝나기를 기다린다.
2. 그 기다림에는 상한(5초)이 있다. 넘기거나 실패하면 로그만 남기고 닫기·종료를 계속한다
   (`recording-bridge.ts`의 규칙).
3. 사용자가 확인 대화상자에서 취소하면 아무것도 하지 않는다.

## 설계

- **fe** `api/notes.ts`: 모듈 수준에 마운트된 자동저장의 flush 함수 집합과 진행 중인 PUT 집합을 둔다.
  `flushPendingNotes()`는 모든 flush를 부르고(debounce 무시) 그 저장과 이미 나간 저장을 `allSettled`로
  기다린다. 던지지 않는다. 훅의 `flush`는 `mutateAsync`를 써서 저장이 끝날 때 해결되는 프라미스를 돌려준다.
- **fe** `lib/desktop-bridge.ts`: `flushNotes()`로 위 함수를 노출한다.
- **desktop** `app/quit-flow.ts`: `QuitFlowDeps`·`CloseFlowDeps`에 `flushNotes`·`noteFlushTimeoutMs`를 더하고
  `runWithin`으로 상한을 건다(`NOTE_FLUSH_TIMEOUT_MS = 5_000`).
  - 종료: `beginQuit` 직후, 녹음 핸드셰이크·"종료 중" 화면·서비스 정지보다 먼저.
  - 창 닫기: 녹음 중이 아니면 `close()` 직전. 녹음 중이면 확인 승인 뒤 핸드셰이크 전.
- **desktop** `main.ts`: `flushNotesIn(win)`이 `executeJavaScript("window.__damwha_desktop?.flushNotes?.()")`를
  부른다. 훅이 없는 화면(셸)에서는 곧바로 끝난다.

## 대안

- **렌더러 `pagehide`에서 `fetch keepalive`로 보낸다.** 웹 배포에도 효과가 있지만, ⌘Q에서는 API가 곧
  내려가므로 요청이 도착했는지 main이 알 수 없다. 데스크톱 종료 순서를 아는 쪽은 main이라 bridge를 골랐다.
  웹(데모는 읽기 전용)은 범위 밖으로 둔다.

## 범위

- fe: `api/notes.ts`, `lib/desktop-bridge.ts`, 두 테스트 파일, `fe/CLAUDE.md`의 bridge 문단.
- desktop: `app/quit-flow.ts`, `main.ts`, `tests/app/quit-flow.test.ts`.

### 범위 밖

- 웹 배포의 탭 닫기 유실(`pagehide`).
- 메모 외 다른 debounce 입력.

## 완료 기준

- C1. `flushPendingNotes()`가 debounce를 기다리지 않고 PUT을 보내고, PUT이 끝난 뒤에 해결된다.
- C2. 이미 나간 PUT이 있으면 그것이 끝날 때까지 해결되지 않는다.
- C3. 종료 흐름에서 flush가 핸드셰이크·"종료 중" 화면·서비스 정지보다 먼저 끝난다.
- C4. 창 닫기 흐름에서 flush가 `close()`보다 먼저 끝나고, 취소하면 flush하지 않는다.
- C5. flush가 끝나지 않거나 실패해도 종료·닫기는 상한 안에 계속되고 로그를 남긴다.
- C6. 실제 데스크톱 앱에서 입력 직후 ⌘W·⌘Q를 눌러 메모가 저장되는지 실측한다.
