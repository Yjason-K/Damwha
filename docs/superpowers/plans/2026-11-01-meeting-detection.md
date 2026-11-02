# 회의 감지 구현 계획

**Goal:** Zoom·Teams·Chrome이 마이크를 쓰면 카드로 녹음을 제안하고, 회의가 끝나면 자동으로 멈춰 요약까지 잇는다.

**Architecture:** Swift 감시 헬퍼가 입력 중인 번들 ID를 JSON 줄로 내고, 순수 상태 기계(`app/meeting-detection.ts`)가 판단한다. main은 `executeJavaScript`로 fe 다리를 부르고, 카드 버튼은 `next()` 묻기 고리로 돌아온다. 렌더러 → main 경로는 새로 만들지 않는다.

**Tech Stack:** Swift/CoreAudio, Electron 44, TypeScript, React 19, vitest.

**Spec:** [`docs/superpowers/specs/2026-11-01-meeting-detection-design.md`](../specs/2026-11-01-meeting-detection-design.md)

## Global Constraints

- 브랜치 `feat/meeting-detection`(`origin/main` 기반). be·worker·`@damwha/contracts`·DB를 바꾸지 않는다.
- `desktop/package.json`의 `dependencies`는 비어 있다. npm 의존성을 더하지 않는다.
- preload·IPC·새 스킴 금지. 동작은 main이 건 `next()`의 반환값으로만 나온다.
- 카드 페이지는 `textContent`만 쓰고, 색은 fe 토큰을 같은 이름으로 옮긴다. CSP 해시를 맞춘다.
- `main.ts`는 vitest가 못 부른다. 판단은 테스트 가능한 모듈에, `main.ts`에는 배선만 둔다.
- 다리 메서드 이름은 main에 문자열로 적힌다. 바꾸면 조용히 끊긴다.
- 시간 값: 입력 지속 2초, 카드 응답 30초, 억제 60초, 자동 종료 10초, 완료 표시 10초, 상태 폴링 2초.
- UI 문구는 desktop `i18n/dictionary.ts`에 ko·en을 함께 둔다. 커밋 메시지는 한국어.
- macOS 최소 15.0(`build-target.sh`). 헬퍼는 hardened runtime으로 서명한다.

## Review Focus

- Mac 잠자기: 회의 중 뚜껑을 닫으면 입력이 꺼진 것처럼 보여도 자동 종료 판단을 하지 않는다. → Task 2·7 테스트
- 전체 화면 Zoom: 전체 화면 Space 위에도 카드가 보여야 한다. → Task 5 `visibleOnFullScreen`, Task 8 수동 확인
- 외장 모니터: 카드는 커서가 있는 화면의 위쪽 가운데에 뜬다. → Task 5 테스트
- 회의 중 잠깐의 입력 끊김(장치 전환 등) 10초 이내: 녹음이 계속되고 카운트다운이 처음부터 다시 잰다. → Task 2 테스트
- 카드가 떠 있는 동안 ⌘R·앱 언어 변경: 낡은 카드 응답이 새 상태를 덮지 않는다. → Task 2·5 테스트

---

### Task 0: T0 실측 (진행 관문)

제품 코드는 커밋하지 않는다. 실측은 스크래치 스파이크로 하고 결과만 Task 2의 목록과 결과 문서에 옮긴다.

**관문:** 2번이 둘 다 실패하면 **구현을 멈추고 사용자에게 묻는다**(스펙 §4.4). 1번은 앱별 결과로 목록을 조정할 뿐 멈추지 않는다.

- [ ] **Step 1: Zoom·Teams 실측.** `micwatch` 프로브(세션 스크래치. 없으면 Task 1의 헬퍼 로직으로 다시 빌드)를 켜고 사용자가 입장 → 음소거 30초 → 해제 → 종료를 수행한다. 앱별 번들 ID, 음소거 때 입력 유지 여부, 입장 전 미리보기의 입력 여부를 적는다. 음소거로 입력이 꺼지면 `autoStop: false`. Teams가 없으면 사용자와 상의해 뺀다.
- [ ] **Step 2: 백그라운드 시작 스파이크.** 빈 Electron 앱의 창을 다른 앱 뒤로 보내고, 최소화한 경우도 함께, `executeJavaScript(code, true)`로 `getUserMedia` + `new AudioContext()` + `ctx.resume()`을 호출한다. `ctx.state === "running"`이 기준이다. 실패하면 `webPreferences.autoplayPolicy: "no-user-gesture-required"`로 다시 잰다.
- [ ] **Step 3: 패널 스파이크.** `type: "panel"` + `showInactive()` 창을 키 입력 중인 TextEdit 위에 띄워 입력이 끊기지 않는지, 포커스 없이 첫 클릭이 버튼에 들어가는지, Zoom 전체 화면 위에 보이는지, `setContentProtection(true)`이 Meet 화면 공유에서 가리는지 본다.
- [ ] **Step 4: 서명 실측.** Step 2의 빈 Electron 앱을 `.app`으로 묶고, 프로브를 `Contents/Resources`에 넣어 `signing.json`의 지문과 `--options runtime`으로 안쪽부터 서명한다. 그 앱에서 프로브를 자식으로 띄워 권한 창이 없고 Meet 입력이 그대로 잡혀야 한다. 프로브의 CPU를 `top -l 2 -pid`로 잰다. 권한 창이 뜨거나 입력이 안 잡히면 관문과 같이 멈추고 묻는다.
- [ ] **Step 5: 결과를 사용자에게 보고하고 관문을 통과한 뒤 Task 1로 간다.**

### Task 1: 감시 헬퍼와 프로세스 래퍼

**Files:**
- Create: `desktop/native/mic-watch/main.swift`, `desktop/src/process/mic-watch.ts`, `desktop/tests/process/mic-watch.test.ts`
- Modify: `desktop/scripts/build-system-audio.sh`, `desktop/scripts/package.mjs:204`, `desktop/scripts/check-bundle.mjs:587-594`

**Interfaces:**
- Produces: `MIC_WATCH_HELPER = "damwha-mic-watch"`, `micWatchHelperPath(bundleDir: string): string`
- Produces: `type MicWatchEvent = { kind: "snapshot"; input: string[] } | { kind: "error"; detail: string } | { kind: "exit" }`
- Produces: `parseMicWatchLine(line: string): MicWatchEvent | null`
- Produces: `startMicWatch(bin: string, onEvent: (e: MicWatchEvent) => void, opts?: { spawnFn?: SpawnFn; stopGraceMs?: number }): { stop(): void }`

- [ ] **Step 1: 테스트 작성** (`mic-watch.test.ts`)

```ts
it("parses a snapshot", () => expect(parseMicWatchLine('{"input":["us.zoom.xos"]}')).toEqual({ kind: "snapshot", input: ["us.zoom.xos"] }));
it("an empty snapshot is a snapshot", () => expect(parseMicWatchLine('{"input":[]}')).toEqual({ kind: "snapshot", input: [] }));
it("an error line is not an empty list", () => expect(parseMicWatchLine('{"error":"list -1"}')).toEqual({ kind: "error", detail: "list -1" }));
it("garbage is ignored", () => expect(parseMicWatchLine("not json")).toBeNull());
it("joins a line split across stdout chunks", /* 가짜 spawn으로 두 청크 → 이벤트 1개 */);
it("reports exit once on close and after a spawn error", /* kind:"exit" 1회 */);
it("stop closes stdin, then escalates to SIGTERM", /* system-audio.test.ts와 같은 방식 */);
```

- [ ] **Step 2: `pnpm desktop test tests/process/mic-watch.test.ts`** Expected: FAIL (모듈 없음)
- [ ] **Step 3: `mic-watch.ts` 구현.** `process/system-audio.ts`의 spawn·env·`stop` 패턴을 따른다. 줄 단위로 잘라 파싱한다.
- [ ] **Step 4: `main.swift` 구현.** 1초 폴링. 기동 직후 전체 스냅숏을 한 줄 쓰고, 정렬한 집합이 바뀔 때만 쓴다. `AudioObjectGetPropertyData` 실패는 `{"error":"<단계> <OSStatus>"}`를 쓰고 **비정상 코드로 끝난다**. 재기동이 전체 스냅숏을 보장하므로 "오류 뒤 같은 집합으로 복구돼 새 줄이 없는" 경로가 생기지 않는다. 마이크를 열지 않는다. stdin EOF·SIGTERM에 끝난다. 번들 ID가 빈 프로세스는 뺀다.
- [ ] **Step 5: 빌드·서명·검사.** `build-system-audio.sh`가 같은 `desktop/build/system-audio/`에 `damwha-mic-watch`도 스테이징한다(번들 일곱 유지). `package.mjs`의 `signAll` 목록과 `check-bundle`의 실행 비트·arm64·hardened runtime 검사에 넣는다.
- [ ] **Step 6: 검증.** `bash desktop/scripts/build-system-audio.sh`, 실행해 첫 줄이 스냅숏인지, Meet 입장 시 줄이 나오는지 본다. `pnpm desktop test tests/process/mic-watch.test.ts` PASS.
- [ ] **Step 7: 커밋** `feat(desktop): 마이크 사용 앱 감시 헬퍼`

### Task 2: 감지 상태 기계

**Files:**
- Create: `desktop/src/app/meeting-detection.ts`, `desktop/tests/app/meeting-detection.test.ts`

**Interfaces:**
- Consumes: `MicWatchEvent` (Task 1), `RecordingSnapshot` 모양 (Task 4와 같은 필드)
- Produces:

```ts
export interface DetectionTarget { name: string; bundlePrefix: string; autoStop: boolean }
export const DETECTION_TARGETS: DetectionTarget[]; // T0 값. Chrome 항목은 { "Chrome", "com.google.Chrome", true }
export type CardAction = "start" | "dismiss" | "stop" | "open";
export type CardView =
  | { kind: "prompt"; token: number }
  | { kind: "recording"; token: number; micOnly: boolean }
  | { kind: "finished"; token: number; variant: "done" | "interrupted" | "empty" | "lost" | "startFailed"; meetingId: string | null };
export interface RecordingSnapshot {
  phase: "idle" | "starting" | "recording" | "stopping" | "ended";
  meetingId: string | null; failed: boolean; systemAudioLost: boolean;
  end: "acked" | "discarded" | "sealed" | "failed" | null;
}
export interface DetectionDeps {
  targets: DetectionTarget[];
  setTimer(fn: () => void, ms: number): () => void;
  ready(): boolean; // 담화 화면이 붙어 있고 창이 있다
  show(view: CardView): void;
  hide(): void;
  start(): Promise<{ started: boolean; meetingId?: string; reason?: string }>;
  cancelStart(): Promise<unknown>; // 시간 초과·suspend. 시작 중이면 무르고, 이미 붙었으면 멈춘다
  stop(): Promise<unknown>;
  finish(): Promise<unknown>;
  snapshot(): Promise<RecordingSnapshot | "timeout" | "gone">;
  open(meetingId: string): void;
  log(line: string): void;
}
export function createMeetingDetection(deps: DetectionDeps): {
  onWatch(e: MicWatchEvent): void;
  onCard(token: number, action: CardAction): void;
  reevaluate(): void; // 담화 화면이 붙은 뒤 마지막 스냅숏으로 다시 판단한다
  setEnabled(on: boolean): void;
  suspend(reason: "quit" | "close" | "sleep"): void;
  resume(reason: "quit" | "close" | "sleep"): void;
  dispose(): void; // beginQuit에서만 부른다
};
```

- [ ] **Step 1: 테스트 작성.** `vi.useFakeTimers` 또는 가짜 `setTimer`로 전이를 고정한다. 각 이름이 하나의 테스트다:
  - `2초 지속 뒤에만 카드가 뜬다` / `2초 전에 꺼지면 안 뜬다` / `목록 밖 번들은 무시한다` / `helper 번들도 접두사로 잡는다`
  - `첫 스냅숏 전(불명)에는 띄우지 않는다` / `snapshot이 recording이면 띄우지 않고 끝날 때 억제를 건다`(C6·모달 경로)
  - `30초 무응답은 닫기와 같다` / `닫기 뒤 입력이 60초 꺼지기 전에는 다시 안 뜬다` / `59초에 입력이 돌아오면 60초를 다시 잰다`
  - `시작 실패면 finished(startFailed)를 보이고 억제한다`(C5) / `busy면 카드를 닫고 external로 간다`(조회 뒤 모달이 먼저 시작한 경쟁)
  - `시작 60초 초과는 cancelStart를 부르고 startFailed다` / `초과 뒤 도착한 시작 응답은 상태를 바꾸지 않는다`
  - `카드 표시 중 대상은 고정, 동시 입력은 목록 앞쪽이 대상이다`
  - `모든 대상 입력이 꺼지고 10초 뒤 stop을 부른다`(C4) / `9초에 돌아오면 멈추지 않고, 다시 꺼지면 10초를 처음부터 잰다` / `다른 대상 입력이 남아 있으면 멈추지 않는다` / `autoStop false면 멈추지 않는다`
  - `exit·error면 카운트다운을 취소하고 재기동 스냅숏 뒤 재개한다`(C12) / `불명 동안 stop을 부르지 않는다`
  - `suspend는 카운트다운을 취소하고, prompting이면 카드를 닫고, starting이면 cancelStart를 부르고, recording이면 녹음 표시를 유지한다`(잠자기·종료)
  - `suspend 동안 start 동작을 받지 않는다` / `이유가 둘이면 둘 다 resume돼야 재개한다` / `resume 뒤 첫 스냅숏 전에는 판단하지 않는다`
  - `setEnabled(false)는 prompting을 닫고 새 카드를 막지만 recording은 유지하고 불명으로 간다` / `다시 켜면 첫 스냅숏 뒤 자동 종료가 재개된다` / 인스턴스는 앱 실행 동안 하나다
  - `준비 안 된 동안 지난 2초는 카드를 띄우지 않고, reevaluate가 입력이 이어지면 다시 잰다`
  - `카드 직전 snapshot 조회 중 입력이 꺼지면 띄우지 않는다`
  - `end별 카드`(판정 순서대로): discarded→empty, `failed` 플래그 또는 `end: "failed"`→interrupted(서버가 ACK해도), acked·sealed→done, `meetingId`가 null이 되거나 `gone`→lost, `timeout` 3회 연속→lost(§4.7, C11)
  - `failed && end null이면 finish()를 한 번 부르고 end가 나올 때까지 finished로 가지 않는다` / `finish 뒤 ACK·폐기·거절이 각각 interrupted·empty·interrupted다`
  - `systemAudioLost면 micOnly true로 다시 그린다`(C14) / `낡은 token의 onCard는 무시한다` / `open은 finished의 meetingId로 부른다`
- [ ] **Step 2: 실행해 실패 확인.** `pnpm desktop test tests/app/meeting-detection.test.ts`
- [ ] **Step 3: 구현.** 상태 `idle|settling|prompting|starting|recording|external|finished`. 억제는 대상 이름 → 해제 타이머 맵이다. `recording`·`external`에서 2초마다 `snapshot()`을 부른다. 시작 상한 **60초**는 이 모듈의 타이머 하나가 맡는다. 사람이 권한 창에 답할 시간이다. `ready()`가 거짓이면 카드를 띄우지 않는다.
- [ ] **Step 4: 실행해 통과 확인.**
- [ ] **Step 5: 커밋** `feat(desktop): 회의 감지 상태 기계`

### Task 3: fe 녹음 시작 공용화와 시작 예약

**Files:**
- Create: `fe/src/features/meeting/lib/start-live.ts`, `fe/src/features/meeting/lib/start-live.test.ts`
- Modify: `fe/src/features/meeting/lib/live-session.ts`, `fe/src/features/meeting/api/live.ts`, `fe/src/features/meeting/ui/new-meeting-dialog.tsx:405-470`

**Interfaces:**
- Produces: `postLiveStart(vars: LiveStartRequest): Promise<MeetingSummary>` (`useStartLive`가 이것을 쓴다)
- Produces: `startLiveRecording(args: { deviceId?: string; openSystemAudio?: OpenSystemAudio; createMeeting: () => Promise<{ id: string }>; signal?: AbortSignal }): Promise<string>`, 회의 id를 돌려준다. 취소되면 `LiveCaptureCancelled`
- Produces: `isLiveStarting(): boolean`, `awaitLiveStart(): Promise<void>` (`live-session.ts`)

- [ ] **Step 1: 테스트 작성** (`start-live.test.ts`, 가짜 레코더는 기존 `live-session` 테스트 방식)
  - `준비 실패면 createMeeting을 부르지 않는다`
  - `createMeeting 실패면 예약을 놓고 다시 던진다`
  - `시작 중 두 번째 호출은 LiveCaptureBusy다`(C13) / `시작 중 isLiveStarting은 참이고 끝나면 거짓이다`
  - `준비만 된 active가 있으면 LiveCaptureBusy다`
  - `준비 중 abort되면 준비가 끝난 뒤 캡처를 놓고 createMeeting을 부르지 않는다`
  - `POST 중 abort되면 응답 뒤 그 회의를 0바이트 stop으로 지우고 캡처를 놓는다`
- [ ] **Step 2: `pnpm fe test src/features/meeting/lib/start-live.test.ts`** Expected: FAIL
- [ ] **Step 3: 구현.** `startLive`의 prepare → POST → `beginLiveCapture` → 실패 시 `cancelLivePreparation`을 옮긴다. 다이얼로그는 `startLiveRecording`을 부르고 오류별 토스트·`resetForm`·`onCreated`만 남긴다. 기존 `new-meeting-dialog` 테스트가 그대로 통과해야 한다.
- [ ] **Step 4: 검증.** `pnpm fe test`, `pnpm fe lint`, `pnpm fe build`
- [ ] **Step 5: 커밋** `refactor(fe): 실시간 녹음 시작을 공용 함수로 꺼낸다`

### Task 4: 세션 종결 결과와 데스크톱 다리

**Files:**
- Modify: `fe/src/features/meeting/lib/live-recorder.ts`, `fe/src/features/meeting/lib/live-session.ts`, `fe/src/features/meeting/lib/desktop-bridge.ts`, `fe/src/features/meeting/lib/desktop-bridge.test.ts`, `fe/src/app/providers.tsx`, `fe/src/main.tsx`

**Interfaces:**
- Consumes: `startLiveRecording`, `postLiveStart`, `isLiveStarting`, `awaitLiveStart` (Task 3)
- Produces: `RecorderStatus.stopSettled: boolean`, `stop()`의 `finally`에서 `setPhase("stopped")` 직전에 참
- Produces: `liveSessionSnapshot(): RecordingSnapshot` (필드는 Task 2), `finishLiveCapture(): Promise<void>` (`live-session.ts`)
- Produces: `DesktopBridge`에 `startDetectedRecording()`, `cancelDetectedRecording()`, `recordingStatus()`, `finishRecording()`, `openMeeting(id: string)` 추가. `cancelDetectedRecording`은 시작 중이면 `AbortController`로 무르고, 이미 시작됐으면 `stopActiveLiveCapture()`를 부른다. 다른 경로로 시작한 녹음은 건드리지 않는다
- Produces: `connectDesktopBridge(deps: { navigate(path: string): void; invalidateMeetings(): void }): void`

- [ ] **Step 1: 테스트 작성**
  - `실패로 stopped에 수렴한 세션도 finishLiveCapture는 서버 stop을 보낸다`(Codex 1)
  - `첫 409 거절이면 end가 failed다`, `재동기화 재시도까지 거절이면 failed다`, `postLiveStop이 던져도 failed다`, `200 + outcome stopping이면 acked`, `discarded면 discarded`, `server seal이면 sealed`
  - `서버가 ACK해도 실패한 세션의 failed는 참으로 남는다`
  - `cancelDetectedRecording은 모달로 시작한 녹음을 멈추지 않는다`
  - `clearLiveCapture 뒤에도 마지막 end를 읽는다`(화면 종료 경로)
  - `새 시작이 마지막 end를 지운다`
  - `시작 중 phase는 starting이고 isRecording은 참이다`
  - `stopLiveRecording은 시작이 끝나기를 기다린 뒤 멈춘다`(C13)
  - `active가 있으면 startDetectedRecording은 busy다`
  - `startDetectedRecording은 시스템 오디오를 항상 열고 defer를 보내지 않는다`
  - `system_audio·permission 실패를 reason으로 돌려주고 던지지 않는다`
  - `openMeeting은 /meetings/:id로 이동한다`
  - `connect 전이면 startDetectedRecording은 not_ready다`
- [ ] **Step 2: 실행해 실패 확인.**
- [ ] **Step 3: 구현.** `lastEnd`를 `active`와 별도의 모듈 변수로 둔다. `end` 판정: `stopOutcome.current`의 `outcome`이 `discarded`면 `discarded` → `status.sealed`면 `sealed` → `stopOutcome.current`가 있으면 `acked` → 나머지는 `failed`. `postLiveStop`은 200일 때만 `onStopped`를 부르므로 `stopOutcome`이 서버 ACK의 유일한 증거다. Promise 완료로 추론하지 않는다. `prepareLiveRecorder`의 `onStatus`에서 `stopSettled` 또는 `sealed`를 보고 쓴다. `finishLiveCapture`는 `hasLiveCapture()`를 보지 않고 `active.recorder.stop()`을 부른다. 제목은 `defaultLiveTitle()`을 쓴다. `providers.tsx`가 `queryClient`로 `invalidateMeetings`를, `router.navigate`로 `navigate`를 넘긴다(라우터를 lib에서 import하지 않는다).
- [ ] **Step 4: 검증.** `pnpm fe test`, `pnpm fe lint`, `pnpm fe build`
- [ ] **Step 5: 커밋** `feat(fe): 데스크톱 다리에 감지 녹음과 종결 결과를 더한다`

### Task 5: 카드 페이지와 창

**Files:**
- Create: `desktop/shell/detect.html`, `desktop/src/windows/detect-view.ts`, `desktop/src/windows/detect-window.ts`, `desktop/tests/windows/detect-window.test.ts`
- Modify: `desktop/src/windows/shell-window.ts`, `desktop/src/i18n/dictionary.ts`, `desktop/tests/windows/shell-html.test.ts:469-473,536`

**Interfaces:**
- Consumes: `CardView`, `CardAction` (Task 2)
- Produces: `detectCardBounds(display: { x: number; y: number; width: number }, size: { width: number; height: number }): { x: number; y: number; width: number; height: number }`, 위쪽 여백 **12px**
- Produces: `cardViewModel(view: CardView, lang: UiLanguage): { title: string; detail: string; buttons: { label: string; action: CardAction; primary: boolean }[] }`
- Produces: `createDetectWindow<W>(host: DetectWindowHost<W>): { show(view: CardView): void; hide(): void; dispose(): void }`, 호스트 모양은 `StatusWindowHost`를 따르고 `next()` 고리·세대·`ASK_RETRY_LIMIT`을 같은 방식으로 쓴다. 답은 `{ token, action }`
- Produces: `createDetectBrowserWindow(onLoadError: (e: unknown) => void): BrowserWindow` (`shell-window.ts`)

- [ ] **Step 1: 테스트 작성**
  - `detectCardBounds는 표시 영역의 위쪽 가운데다`, `보조 모니터 원점을 더한다`(외장 모니터)
  - `prompt`: `회의를 기록할까요?` / `녹음은 이 Mac에만 저장돼요`, 버튼 `녹음 시작`(primary)·`닫기`
  - `recording`: `녹음 중` + `중지`, `micOnly`면 `마이크만 녹음 중`
  - `finished`: done `녹음을 마쳤어요`+`회의 보기`, interrupted `녹음이 중단됐어요`/`지금까지 녹음된 내용은 남아 있어요`+`회의 보기`, empty `녹음된 내용이 없어요`(버튼 없음), lost `녹음이 끊겼어요`/`담화에서 회의를 확인해 주세요`(버튼 없음), startFailed `녹음을 시작하지 못했어요`(버튼 없음)
  - `en 사전에도 같은 키가 있다`
  - `페이지가 새로 로드되면 낡은 세대의 답을 버리고 현재 view를 다시 그린다`
  - `shell-html.test.ts`: 목록에 `detect.html`을 더하고, services.html과 같은 금지 패턴·CSP 해시·토큰 값 검사를 건다. 가짜 DOM으로 `__damwha_detect.next()`가 버튼 action을 돌려주는지 본다.
- [ ] **Step 2: 실행해 실패 확인.**
- [ ] **Step 3: 구현.** `detect.html`은 `services.html`의 `queue`/`waiters`/`next()` 구조를 따른다. `window.__damwha_detect.next()`, `window.__damwha_detect_render(view)`. 시안 B2: 마크, 제목·설명, 버튼. 그림자는 떠 있는 층이라 허용한다.
  `createDetectBrowserWindow`: `frame: false`, `resizable: false`, `type: "panel"`, `alwaysOnTop`(`"floating"`), `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`, `setContentProtection(true)`, `showInactive()`, webPreferences는 상태 창과 같고 `applyNavigationBoundary(win, () => [])`. 위치는 `screen.getDisplayNearestPoint(screen.getCursorScreenPoint())`.
- [ ] **Step 4: 검증.** `pnpm desktop test`, `pnpm desktop lint`
- [ ] **Step 5: 커밋** `feat(desktop): 회의 감지 카드`

### Task 6: 켜고 끄기

**Files:**
- Create: `desktop/src/app/detection-state.ts`, `desktop/tests/app/detection-state.test.ts`
- Modify: `desktop/src/windows/menu-template.ts`, `desktop/src/i18n/dictionary.ts`, `desktop/tests/windows/` 의 메뉴 테스트

**Interfaces:**
- Produces: `makeDetectionStateStore(userData: string, log: (line: string) => void): { enabled(): boolean; setEnabled(on: boolean): void }`, 파일 `detection-state.json`
- Produces: `MenuHandlers.onToggleMeetingDetection(on: boolean)`, `buildMenuTemplate` opts에 `meetingDetection: boolean`

- [ ] **Step 1: 테스트 작성.** `파일이 없으면 켜짐`, `깨진 파일이면 켜짐`, `저장 후 새 store가 읽는다`(C8), `쓰기 실패여도 이번 실행은 메모리 값을 쓴다`, `메뉴에 체크 항목 회의 감지가 앱 메뉴에 있다`.
- [ ] **Step 2: 실행해 실패 확인.**
- [ ] **Step 3: 구현.** `update-state.ts`의 모양을 따른다. 메뉴는 앱 메뉴의 복원 항목 아래 `type: "checkbox"`.
- [ ] **Step 4: `pnpm desktop test`** PASS
- [ ] **Step 5: 커밋** `feat(desktop): 회의 감지 켜고 끄기`

### Task 7: main 배선

**Files:**
- Create: `desktop/src/app/detection-host.ts`, `desktop/tests/app/detection-host.test.ts`
- Modify: `desktop/src/main.ts`

**Interfaces:**
- Consumes: Task 1·2·5·6 전부, `runWithin`·`runHandshake`(`recording-bridge.ts`), `isRecordingIn`·`stopRecordingIn`(`main.ts`)
- Produces: `askSnapshot(call: () => Promise<unknown>, timeoutMs: number): Promise<RecordingSnapshot | "timeout" | "gone">`, 거부는 `gone`, 시간 초과는 `timeout`
- Produces: `createWatchLoop(deps: { start: (onEvent) => { stop(): void }; onEvent(e: MicWatchEvent): void; setTimer(fn: () => void, ms: number): () => void; log(line: string): void }): { start(): void; stop(): void }`, 재기동 백오프 1·2·4·…·최대 60초, 스냅숏을 받으면 초기화

- [ ] **Step 1: 테스트 작성.** `askSnapshot의 세 갈래`, `헬퍼 exit 뒤 백오프로 재기동한다`, `stop 뒤에는 재기동하지 않는다`, `스냅숏을 받으면 백오프를 되돌린다`.
- [ ] **Step 2: 실행해 실패 확인.**
- [ ] **Step 3: `detection-host.ts` 구현.**
- [ ] **Step 4: `main.ts` 배선.**
  - 대상 렌더러는 `updateAttached`. `ready()`는 그것이 살아 있는가. 담화 화면이 붙은 뒤(`updateAttached` 대입과 `did-finish-load`)에 `detection.reevaluate()`.
  - 호출 상한: `snapshot`·`cancelStart`·`finish`·`open`은 `RENDERER_ASK_TIMEOUT_MS`(3초), `stop`은 `runHandshake`의 기존 상한. `start`만 `executeJavaScript(script, true)`이고 main에서 상한을 걸지 않는다(Task 2가 맡는다).
  - T0에서 필요하면 `createWindow`의 webPreferences에 `autoplayPolicy`.
  - 메뉴 토글과 기동 시 `enabled()`로 `createWatchLoop`를 켜고 끄고 `detection.setEnabled()`를 부른다. 감시 루프가 내는 `exit`가 `불명`을 만든다.
  - 카드 `open`은 `win.show(); win.focus();` 뒤 `openMeeting`.
  - **`runQuitFlow` 호출 직전**에 `detection.suspend("quit")`, 그 Promise가 끝났는데 `quitting`이 거짓이면(확인 취소) `resume("quit")`. `beginQuit`이 아니다 — 그 앞의 녹음 조회·확인 대기 중에 카드 시작이 끼어들면 안 된다.
  - 창 닫기 흐름도 `runCloseFlow` 전후로 `suspend("close")`·`resume("close")`.
  - `powerMonitor`의 `suspend`·`resume`을 `"sleep"`으로 잇는다. 깨어나면 감시 루프를 재기동해 전체 스냅숏을 받는다.
  - `beginQuit`에서 `detection.dispose()`와 감시 루프 `stop()`(C10).
- [ ] **Step 5: 검증.** `pnpm desktop test`, `pnpm desktop lint`
- [ ] **Step 6: 커밋** `feat(desktop): 회의 감지를 앱에 잇는다`

### Task 8: 실제 앱 검증과 문서

**Files:**
- Modify: `desktop/CLAUDE.md`, `fe/CLAUDE.md`
- Create: `docs/superpowers/reports/2026-11-01-meeting-detection-results.md`

- [ ] **Step 1: dev 실측.** `pnpm desktop:dev`로 C1~C8, C10~C14를 하나씩 수행해 결과를 기록한다. 헬퍼 강제 종료는 `kill <pid>`, 마이크 끊김은 USB 마이크 분리 또는 입력 장치 제거로 재현한다. 전체 화면 Zoom 위 카드, 외장 모니터, 잠자기 후 복귀도 본다.
- [ ] **Step 2: 패키지 실측.** `pnpm desktop:build` 전에 `out/` 처리(메모리: `out/mac-arm64` 통째 삭제). `check-bundle` 통과, 서명된 앱에서 권한 창 없이 감지되는지 본다(C9).
- [ ] **Step 3: 문서.** `desktop/CLAUDE.md`에 번들 항목·회의 감지 절, `fe/CLAUDE.md`에 다리 메서드·종결 결과를 적는다. 스펙 §4.4의 `finishRecording` 등 이름이 그대로인지 맞춘다.
- [ ] **Step 4: 결과 문서** 작성: 스펙·계획 링크, 브랜치, 검증 명령과 결과, C1~C14 판정.
- [ ] **Step 5: 전체 확인.** `pnpm desktop test`, `pnpm desktop lint`, `pnpm fe test`, `pnpm fe lint`, `pnpm fe build`, `graphify update .`
- [ ] **Step 6: 커밋** `docs: 회의 감지 기록`
