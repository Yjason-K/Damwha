# 창 닫기·앱 종료 전 메모 flush 구현 계획

**Spec:** [`2026-11-25-issue-133-note-flush-on-close-design.md`](../specs/2026-11-25-issue-133-note-flush-on-close-design.md)

**Goal:** ⌘W·⌘Q가 렌더러를 파괴하거나 API를 내리기 전에, 대기 중인 메모 입력과 진행 중인 저장을 상한 안에서 끝낸다.

## Task 1 — fe: `flushPendingNotes()`

- `fe/src/features/meeting/api/notes.ts`
  - 모듈 수준 `mountedFlushes`(마운트된 훅의 flush)와 `inFlightSaves`(진행 중인 PUT)를 둔다.
  - `useSaveMeetingNote`의 `mutationFn`이 요청을 `inFlightSaves`에 넣고, 끝나면 뺀다.
  - `useAutosaveNote`의 `flush`가 `mutateAsync`로 보내고 저장이 끝날 때 해결되는 프라미스를 돌려준다(실패도 해결).
  - 언마운트 effect가 flush 등록을 함께 관리한다.
  - `flushPendingNotes()`: 모든 flush를 부르고 그 결과와 `inFlightSaves`를 `allSettled`로 기다린다.
- 테스트(`notes.test.tsx`): 대기 입력을 바로 보내고 PUT 해결 뒤에야 해결되는지, 이미 나간 PUT을 기다리는지.

## Task 2 — fe: bridge

- `lib/desktop-bridge.ts`에 `flushNotes: flushPendingNotes`. 테스트는 위임만 확인한다.
- `fe/CLAUDE.md`의 bridge 문단에 한 줄 더한다.

## Task 3 — desktop: 흐름

- `app/quit-flow.ts`: `NOTE_FLUSH_TIMEOUT_MS = 5_000`, `flushNotesWithin`(runWithin + 거부·시간 초과 로그).
  - `runQuitFlow`: `beginQuit` 직후 try 안 맨 앞.
  - `runCloseFlow`: 녹음 아님 → `close()` 직전, 녹음 중 → 확인 승인 뒤 핸드셰이크 전.
- `main.ts`: `flushNotesIn(target)`과 두 흐름의 deps 연결.
- 테스트(`quit-flow.test.ts`): 가짜 deps에 `notes` 단계, 기존 순서 단언 갱신, 순서·취소·시간 초과·거부 테스트.

## Task 4 — 검증

- `pnpm --filter damwha-fe exec vitest run`, `pnpm --filter damwha-desktop exec vitest run`, 두 패키지 `tsc`, fe eslint.
- 변이: 각 수정을 되돌려 새 테스트가 실패하는지 확인한다.
- 실제 앱 ⌘W·⌘Q 실측(C6).
