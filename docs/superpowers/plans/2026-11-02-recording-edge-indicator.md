# 회의 녹음 중 가장자리 알약 표시 구현 계획

**목표:** 카드로 시작한 녹음이 진행되는 동안 카드 대신 화면 가장자리의 작은 알약을 보여 준다.

**구조:** 알약은 카드와 별도의 투명 패널 창 `shell/pill.html`이다. 그래서 카드 창과 페이지는 바뀌지 않는다. 판단은 `app/meeting-detection.ts`, 위치 계산은 `windows/pill-view.ts`, 창 동작은 `windows/pill-window.ts`에 두고 `main.ts`에는 잎만 준다.

**기술:** Electron 44.3, TypeScript, vitest.

**Spec:** [`docs/superpowers/specs/2026-11-02-recording-edge-indicator-design.md`](../specs/2026-11-02-recording-edge-indicator-design.md)

## 전역 제약

- `§6.11`에 새 예외를 만들지 않는다. preload·IPC 없이 페이지의 사건은 `next()` 반환값으로만 나간다.
- `focusable: false`, `type: "panel"`, `showInactive()`, `setAlwaysOnTop(true, "floating")`, `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })`, `setContentProtection(true)`를 유지한다. 알약에 `show()` 경로를 두지 않는다.
- `-webkit-app-region: drag`를 쓰지 않는다. 호버와 클릭을 삼킨다(스펙 §3).
- 드래그 판정 4px, leave 지연 200ms, 카드 복귀 10초.
- 기본 위치 여백은 오른쪽·위 각 12px.
- `shell/*.html`의 색은 `:root`와 다크 `@media` 블록에만 두고, 문구는 `textContent`로만 넣는다.
- 새 번역 키를 만들지 않는다. `detect.stop`, `detect.open`을 쓴다.
- 시작 제안 카드의 모습과 동작은 바꾸지 않는다.
- 실측은 Chrome의 Google Meet으로 한다. 커밋 메시지는 한국어다.

## 리뷰 초점

1. 드래그 도중 녹음이 끝나 알약이 닫힌다. 늦게 도착한 드래그 사건은 무시되고 저장되지 않아야 한다.
2. `detection-state.json`이 깨졌거나 위치 값이 숫자가 아니다. 기본 위치로 뜨고 `enabled`는 살아야 한다.
3. 호버 중에 외장 모니터가 빠진다. 호버 크기가 남아도 알약은 보이는 화면으로 와야 한다.
4. 오른쪽 끝을 왼쪽 가장자리 가까이 놓는다. 호버로 늘어나도 화면 밖으로 나가면 안 된다.
5. 경고 카드가 떠 있는 동안 녹음이 끝난다. 복귀 타이머가 끝 카드를 알약으로 덮으면 안 된다.

---

### Task 1: 위치 저장

**Files:**
- Modify: `desktop/src/app/detection-state.ts`
- Test: `desktop/tests/app/detection-state.test.ts`

**Interfaces:**
- Produces: `interface PillPoint { x: number; y: number }`, `DetectionStateStore.pillPosition(): PillPoint | null`, `DetectionStateStore.setPillPosition(p: PillPoint): void`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
it("위치를 저장해도 enabled가 남는다", () => {
  store.setEnabled(false);
  store.setPillPosition({ x: 10, y: 20 });
  const again = makeDetectionStateStore(dir, log);
  expect(again.enabled()).toBe(false);
  expect(again.pillPosition()).toEqual({ x: 10, y: 20 });
});
it("enabled를 바꿔도 위치가 남는다", () => {
  store.setPillPosition({ x: 10, y: 20 });
  store.setEnabled(false);
  expect(makeDetectionStateStore(dir, log).pillPosition()).toEqual({ x: 10, y: 20 });
});
it("위치가 잘못되면 null이고 enabled는 그대로다", () => {
  fs.writeFileSync(file, JSON.stringify({ enabled: false, pill: { x: "a", y: null } }));
  const s = makeDetectionStateStore(dir, log);
  expect(s.pillPosition()).toBeNull();
  expect(s.enabled()).toBe(false);
});
```

`dir`, `file`, `log`는 이 파일의 기존 준비 코드를 따른다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-desktop exec vitest run tests/app/detection-state.test.ts`
Expected: FAIL, `setPillPosition` 없음

- [ ] **Step 3: 구현**

memo를 `{ enabled: boolean; pill: PillPoint | null }`로 바꾸고 쓰기 경로를 하나로 합친다. 파일 모양은 `{"enabled":bool,"pill":{"x":n,"y":n}}`이고 `pill`이 null이면 키를 뺀다. `Number.isFinite`로 검증한다.

- [ ] **Step 4: 통과 확인**

Run: 위와 같음. Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add desktop/src/app/detection-state.ts desktop/tests/app/detection-state.test.ts
git commit -m "feat(desktop): 알약 위치를 감지 상태에 저장한다"
```

### Task 2: 상태 기계

**Files:**
- Modify: `desktop/src/app/meeting-detection.ts`, `desktop/src/windows/detect-view.ts`
- Test: `desktop/tests/app/meeting-detection.test.ts`

**Interfaces:**
- Produces: `CardView`에 `{ kind: "pill"; token: number; startedAt: number }` 추가, `DetectionDeps.now(): number` 추가. `recording` 뷰는 이제 경고 카드만 뜻한다.

`detect-view.ts`의 `cardViewModel`과 `detectRenderCall`은 카드 뷰만 받도록 `Exclude<CardView, { kind: "pill" }>`를 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성**

`setup()`의 deps에 `now: () => 1_000`을 넣고, 기존 시작 테스트의 `recording` 기대를 `pill`로 고친 뒤 추가한다.

```ts
it("녹음이 시작되면 알약을 보인다", async () => {
  expect(s.last()).toEqual({ kind: "pill", token: t, startedAt: 1_000 });
});
it("경고가 생기면 카드로 펼치고 10초 뒤 알약으로 돌아온다", async () => {
  s.h.snap = async () => ({ ...recSnap, micSwitched: true });
  await poll(s);
  expect(s.last()).toEqual({ kind: "recording", token: t, micOnly: false, micSwitched: true });
  s.advance(10_000);
  expect(s.last()).toEqual({ kind: "pill", token: t, startedAt: 1_000 });
});
it("같은 경고는 다시 펼치지 않는다", async () => { /* 복귀 뒤 같은 스냅숏을 폴링해도 show 호출이 늘지 않는다 */ });
it("펼친 동안 두 번째 경고가 오면 카드를 바꾸고 10초를 다시 잰다", async () => {
  // 6초 뒤 systemAudioLost 추가 → last는 micOnly: true, micSwitched: true
  // 다시 6초 뒤에도 recording, 4초 더 지나면 pill
});
it("경고 카드 중 녹음이 끝나면 복귀 타이머가 끝 카드를 덮지 않는다", async () => {
  // 경고 뒤 end: "acked" 폴링 → finished, 10초 뒤에도 pill이 아니다
});
it("recording의 open은 회의를 열고 알약을 유지한다", async () => {
  s.d.onCard(t, "open");
  expect(s.h.opened).toEqual(["m1"]);
  expect(s.last().kind).toBe("pill");
});
it("meetingId가 없으면 open은 로그만 남긴다", async () => { /* started에 meetingId 없음 */ });
```

`poll`, `advance`, `opened` 등 이름은 이 파일의 기존 도우미에 맞춘다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-desktop exec vitest run tests/app/meeting-detection.test.ts`
Expected: FAIL

- [ ] **Step 3: 구현**

- `const CARD_RETURN_MS = 10_000`, `let startedAt = 0`, `let returnCancel`을 추가한다.
- `r.started` 분기에서 `startedAt = deps.now()` 후 `presentPill()`을 부른다.
- `judgeRecording`의 경고 분기에서 `present(recording)` 뒤 복귀 타이머를 다시 건다.
- `returnCancel`은 `showFinished`, `abandon`, `backToIdle`, dispose 경로에서 취소한다.
- `onCard`에 `phase === "recording" && action === "open"`을 더한다. `meetingId`가 있으면 `deps.open`, 없으면 `deps.log`다. 카드는 닫지 않는다.

- [ ] **Step 4: 통과 확인**

Run: 위와 같음, 이어서 `pnpm --filter damwha-desktop lint`
Expected: 테스트 PASS. lint는 `main.ts`의 `now` 누락으로 실패할 수 있으므로, `now: Date.now`를 `createMeetingDetection` 호출에 더해 통과시킨다.

- [ ] **Step 5: 커밋**

```bash
git add desktop/src desktop/tests/app/meeting-detection.test.ts
git commit -m "feat(desktop): 녹음 중 상태를 알약과 경고 카드로 나눈다"
```

### Task 3: 알약 판정

**Files:**
- Create: `desktop/src/windows/pill-view.ts`
- Test: `desktop/tests/windows/pill-view.test.ts`

**Interfaces:**
- Consumes: `PillPoint`(Task 1), `pill` 뷰(Task 2)
- Produces:
  - `PILL_COMPACT = { width: 104, height: 32 }`, `PILL_HOVER = { width: 156, height: 32 }`. 두 값은 `1:02:34`가 잘리지 않게 스파이크의 92·144에서 넓혔다.
  - `interface Rect { x; y; width; height }`
  - `pillDefaultPosition(area: Rect): PillPoint`
  - `pillFits(p: PillPoint, areas: Rect[]): boolean`
  - `pillClamp(p: PillPoint, areas: Rect[]): PillPoint`
  - `pillBounds(p: PillPoint, hover: boolean): Rect`
  - `pillPositionOf(bounds: Rect): PillPoint`
  - `type PillAnswer = { token: number; action: "stop" | "open" } | { token: number; ui: "hover"; on: boolean } | { token: number; ui: "drag"; dx: number; dy: number } | { token: number; ui: "drop" }`
  - `parsePillAnswer(raw: unknown): PillAnswer | null`
  - `PILL_ASK_SCRIPT`, `pillRenderCall(view, labels: { stop: string; open: string }): string`

위치는 언제나 **줄어든 알약의 왼쪽 위**다.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
const main = { x: 0, y: 25, width: 1440, height: 875 };
const left = { x: -1920, y: 0, width: 1920, height: 1055 };
it("기본 위치는 오른쪽 위 12px", () => {
  expect(pillDefaultPosition(main)).toEqual({ x: 1440 - 104 - 12, y: 37 });
});
it("호버는 왼쪽으로 늘어나고 오른쪽 끝은 그대로다", () => {
  expect(pillBounds({ x: 500, y: 40 }, true)).toEqual({ x: 448, y: 40, width: 156, height: 32 });
  expect(pillPositionOf({ x: 448, y: 40, width: 156, height: 32 })).toEqual({ x: 500, y: 40 });
});
it("호버 크기가 화면 안에 들어가야 맞다", () => {
  expect(pillFits({ x: 52, y: 40 }, [main])).toBe(true);
  expect(pillFits({ x: 51, y: 40 }, [main])).toBe(false);
  expect(pillFits({ x: 10, y: 40 }, [main])).toBe(false);
});
it("놓으면 가장 가까운 화면 안으로 밀어 넣는다", () => {
  expect(pillClamp({ x: 10, y: 0 }, [main])).toEqual({ x: 52, y: 25 });
  expect(pillClamp({ x: -90, y: 300 }, [main, left])).toEqual({ x: -104, y: 300 });
});
it("숫자가 아닌 드래그는 거부한다", () => {
  expect(parsePillAnswer({ token: 1, ui: "drag", dx: Infinity, dy: 0 })).toBeNull();
  expect(parsePillAnswer({ token: 1, action: "start" })).toBeNull();
  expect(parsePillAnswer({ token: 1, ui: "hover", on: true })).toEqual({ token: 1, ui: "hover", on: true });
});
it("문구는 JSON으로만 싣는다", () => {
  const call = pillRenderCall({ kind: "pill", token: 1, startedAt: 5 }, { stop: '"); x(', open: "o" });
  expect(call).toContain(JSON.stringify('"); x('));
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows/pill-view.test.ts`
Expected: FAIL, 모듈 없음

- [ ] **Step 3: 구현**

`pill-view.ts`는 electron을 import하지 않는다. `pillClamp`는 알약 중심까지 거리가 가장 짧은 `Rect`를 고른 뒤 호버 크기 기준으로 자른다.

- [ ] **Step 4: 통과 확인 후 커밋**

Run: 위와 같음. Expected: PASS

```bash
git add desktop/src/windows/pill-view.ts desktop/tests/windows/pill-view.test.ts
git commit -m "feat(desktop): 알약의 위치와 답 판정을 더한다"
```

### Task 4: 알약 페이지

**Files:**
- Create: `desktop/shell/pill.html`
- Modify: `desktop/tests/windows/shell-html.test.ts`

**Interfaces:**
- Consumes: `PillAnswer` 모양, `pillRenderCall`의 호출 `window.__damwha_pill_render({ token, startedAt, stop, open })`
- Produces: `window.__damwha_pill.next()`

- [ ] **Step 1: 실패하는 테스트 작성**

페이지 목록 `["detect.html", "services.html", "status.html"]` 세 곳에 `pill.html`을 더한다. `loadPage` 샌드박스에 없는 `Date`, 타이머, 이벤트는 그 도우미에 주입한다. 다음 테스트를 더한다.

```ts
describe("pill.html", () => {
  it("경과 시간은 m:ss, 1시간부터 h:mm:ss", () => {
    // startedAt 기준 754초 → "12:34", 3754초 → "1:02:34"
  });
  it("중지는 호버 전에는 숨어 있다", () => { /* #pill에 hover 클래스가 없고 CSS가 #stop을 숨긴다 */ });
  it("4px 미만 움직임은 open, 4px 이상은 drag와 drop", async () => {});
  it("leave는 200ms 뒤에 나가고 그 안에 돌아오면 취소된다", () => {});
  it("드래그 중에는 leave를 보내지 않는다", () => {});
  it("중지를 누르면 다음 렌더까지 잠긴다", async () => {});
  it("-webkit-app-region을 쓰지 않는다", () => {
    expect(loadPage("pill.html").html).not.toContain("-webkit-app-region");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows/shell-html.test.ts`
Expected: FAIL, 파일 없음

- [ ] **Step 3: 구현**

`shell/detect.html`의 구조와 CSP 규칙을 따른다. `html, body` 배경은 투명, `#pill`은 `--surface-card` 배경과 `--border-default` 1px 테두리의 알약이다. 빨간 점은 `--red-9`를 fe와 같은 이름으로 옮겨 쓴다. 본문은 `role="button"`과 `aria-label`(`open` 문구), `중지`는 `<button>`이다. 스파이크의 이벤트 처리를 옮기되 `mouseenter`·`mouseleave`는 `document.documentElement`에 건다. 렌더마다 token을 바꾸고, 시간은 `setInterval` 1초로 `Date.now() - startedAt`을 그린다.

CSP 해시를 계산해 넣는다.

- [ ] **Step 4: 통과 확인 후 커밋**

Run: 위와 같음. Expected: PASS

```bash
git add desktop/shell/pill.html desktop/tests/windows/shell-html.test.ts
git commit -m "feat(desktop): 녹음 중 알약 페이지를 더한다"
```

### Task 5: 알약 창

**Files:**
- Create: `desktop/src/windows/asked-window.ts`, `desktop/src/windows/pill-window.ts`
- Modify: `desktop/src/windows/detect-window.ts`, `desktop/src/windows/shell-window.ts`, `desktop/src/main.ts`
- Test: `desktop/tests/windows/pill-window.test.ts`, 기존 `desktop/tests/windows/detect-window.test.ts`

**Interfaces:**
- Consumes: Task 1의 저장, Task 3의 판정, Task 4의 페이지
- Produces:
  - `createAskedWindow<W, V, A>(host)`: `detect-window.ts`의 생성·묻기·닫기 고리를 옮긴 것. host에 `render(view: V): string`, `askScript: string`, `parse(raw: unknown): A | null`, `what: string`(로그 이름)을 더한다.
  - `createPillWindow<W>(host: PillWindowHost<W>): { show(view): void; hide(): void; dispose(): void; refit(): void; anchor(): PillPoint | null; forget(): void }`
  - `createPillBrowserWindow(bounds: Rect, onLoadError): BrowserWindow`
  - `createDetectBrowserWindow(onLoadError, anchor: PillPoint | null)`

`PillWindowHost<W>`는 `create(bounds)`, `alive`, `close`, `onLoad`, `onClosed`, `run`, `bounds(win)`, `setBounds(win, r)`, `workAreas(): Rect[]`, `cursorArea(): Rect`, `saved(): PillPoint | null`, `save(p)`, `labels()`, `onAction(token, action)`, `log`을 가진다.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
it("저장된 위치가 맞으면 그 자리에 뜬다", () => {});
it("저장된 위치가 화면 밖이면 기본 위치에 뜬다", () => {});
it("저장값이 없으면 기본 위치를 녹음이 끝날 때까지 유지한다", () => {
  // show → hide → cursorArea 변경 → show: 처음 자리 그대로
});
it("forget 뒤에는 다시 계산한다", () => {});
it("호버는 오른쪽 끝을 고정해 크기를 바꾼다", async () => {});
it("drop은 안으로 밀어 넣고 저장한다", async () => {});
it("닫힌 뒤 도착한 drag·drop은 저장하지 않는다", async () => {});
it("refit은 호버 중에도 화면 밖 알약을 기본 위치로 옮긴다", () => {});
it("stop과 open은 token과 함께 onAction으로 간다", async () => {});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows/pill-window.test.ts`
Expected: FAIL, 모듈 없음

- [ ] **Step 3: 구현**

`asked-window.ts`로 옮겨도 `detect-window.test.ts`는 고치지 않고 통과해야 한다.

`createPillBrowserWindow`는 전역 제약의 설정에 `frame: false`, `resizable: false`, `show: false`, `skipTaskbar: true`, `transparent: true`, `hasShadow: false`, 기존 `webPreferences`, `applyNavigationBoundary`를 쓴다. `shellFileOf`의 이름 합에 `"pill.html"`을 더한다.

`main.ts`의 배선:

```ts
show: (view) => {
  if (view.kind === "prompt") pillWindow.forget();
  if (view.kind === "pill") { detectWindow.hide(); pillWindow.show(view); }
  else { pillWindow.hide(); detectWindow.show(view); }
},
hide: () => { pillWindow.hide(); detectWindow.hide(); },
```

`detectWindow`의 `create`는 `pillWindow.anchor()`를 넘긴다. 앵커가 있으면 `screen.getDisplayNearestPoint(anchor)`, 없으면 지금처럼 커서다. `pillWindow`의 `onAction`은 `detection.onCard`다. `screen`의 `display-removed`, `display-metrics-changed`에서 `pillWindow.refit()`을 부른다. 종료 흐름의 `detectWindow.dispose()` 옆에 `pillWindow.dispose()`를 더한다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter damwha-desktop test && pnpm --filter damwha-desktop lint`
Expected: 전부 PASS

- [ ] **Step 5: 커밋**

```bash
git add desktop/src desktop/tests/windows/pill-window.test.ts
git commit -m "feat(desktop): 녹음 중 카드를 가장자리 알약으로 바꾼다"
```

### Task 6: 문서와 실측

**Files:**
- Modify: `desktop/CLAUDE.md`
- Create: `docs/superpowers/reports/2026-11-02-recording-edge-indicator-results.md`

- [ ] **Step 1: 문서 갱신**

`desktop/CLAUDE.md`의 회의 감지 절에 알약 창(`shell/pill.html`, `focusable: false`, 페이지 JS 드래그를 쓰는 이유)을 더하고, 데이터 위치 표의 `detection-state.json` 설명에 `pill`을 더한다.

- [ ] **Step 2: 앱 실측**

Run: `pnpm desktop:dev`

Chrome의 Google Meet으로 스펙 §7의 기준 1~10을 하나씩 확인한다. 기준 6은 `detection-state.json`의 `pill`을 손으로 화면 밖 값으로 바꿔 확인한다. 기준 8·9는 사람이 조작해야 한다.

- [ ] **Step 3: 결과 문서 작성**

스펙과 계획 링크, 브랜치, 검증 명령과 결과, 완료 기준별 판정을 적는다.

- [ ] **Step 4: 커밋**

```bash
git add desktop/CLAUDE.md docs/superpowers/reports/2026-11-02-recording-edge-indicator-results.md
git commit -m "docs: 녹음 중 알약 표시 결과를 기록한다"
```
