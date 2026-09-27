# HF 토큰 — 기동 게이트를 걷고 앱 안에서 입력한다 · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 토큰 없이도 데스크톱 앱이 뜨고, 화자 분리가 필요한 동작(업로드·실시간 녹음·재처리)만 토큰이 있어야 열리며, 토큰은 담화 화면(온보딩·설정·다이얼로그)에서 넣고 바꾸고 지운다.

**Architecture:** main은 기동 때 Keychain을 읽기만 하고(`app/token-boot.ts`), 토큰 상태를 새 흐름 모듈 `windows/token-bridge.ts`가 쥔다. 그 모듈은 담화 화면이 붙을 때마다 `window.__damwha_desktop.hfToken.show()`로 상태를 밀어 넣고 `next()`를 계속 물어 사람의 동작을 받는다 — preload·IPC 없이(§6.11). fe는 `features/hf-token`에 다리 스토어·훅·폼·다이얼로그·온보딩·설정 섹션·게이트를 두고, 새 회의·재처리 진입점을 게이트로 감싼다.

**Tech Stack:** Electron 44 main(TypeScript, vitest), React 19 + Vite 8 + Tailwind 4(vitest + Testing Library, jsdom), pnpm 10 workspace.

**Spec:** `docs/superpowers/specs/2026-09-25-hf-token-in-app-design.md`

## Global Constraints

- 렌더러 → main 채널을 만들지 않는다. preload 없음, IPC 없음. main이 `executeJavaScript`로 묻고, 반환값으로 받는다 (Phase 2 §6.11).
- 토큰 원문은 로그·화면·예외 메시지·`show()` 상태 어디에도 싣지 않는다. 화면에는 `maskToken` 값만.
- 막는 동작: 새 회의(업로드·실시간 녹음 둘 다), 재처리. 그 밖은 막지 않는다.
- "나중에 하기"는 **이번 앱 실행 동안만** — main 메모리. localStorage·sessionStorage 금지.
- safeStorage를 못 써도 기동을 막지 않는다. 토큰 상태가 `unavailable`일 뿐.
- 녹음 중 `submit`은 거부한다: `"녹음을 마친 뒤 바꿔 주세요."`
- `clear`는 서비스를 재시작하지 않는다.
- python 자식은 셸에서 물려받은 `HF_TOKEN`을 **절대** 받지 않는다 — 앱(Keychain)만이 토큰의 출처다.
- 웹(다리 없음)에서는 게이트 전부 통과, 토큰 UI 숨김. Electron 판별은 `navigator.userAgent`의 `Electron`.
- UI 문구·커밋 메시지·주석은 한국어. fe는 `import type` 필수(`verbatimModuleSyntax`).
- desktop 테스트는 `pnpm --filter damwha-desktop exec vitest run …`, fe는 `pnpm --filter damwha-fe exec vitest run …`. **`pnpm desktop exec`는 테스트 0개로 exit 0이 나는 거짓 초록불이다 — 쓰지 않는다.**
- 커밋 메시지 끝에 `Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC`.

## Review Focus

1. **⌘R(새로 고침) 뒤 다리 재부착** — 새 문서는 새 `__damwha_desktop`을 갖는다. main이 다시 `show`하고 새 고리를 열지 않으면 설정의 토큰 폼이 "확인 중"에 영원히 멈춘다. → Task 3(`attach` 두 번 → 옛 고리 종료·새 고리 시작), Task 5(`did-finish-load` 배선)에서 고정.
2. **개발 셸의 `HF_TOKEN` 누수** — `pnpm desktop:dev`를 `HF_TOKEN`이 export된 셸에서 띄우면, 앱은 `absent`라 말하는데 worker는 셸 토큰으로 화자 분리에 성공한다(게이트와 실제가 갈림). → Task 1에서 `childEnv`가 상속 `HF_TOKEN`을 버리는 테스트.
3. **확인 실패 뒤 입력 값 유지** — 오타 토큰을 넣고 401을 받으면 사람은 한 글자만 고쳐 다시 보내고 싶다. 폼이 값을 지우면 다시 붙여 넣어야 한다. → Task 7의 폼 테스트.
4. **이미 토큰이 있는 기존 설치** — 업데이트 뒤 아무것도 묻지 않아야 한다(C6). 기동 읽기가 `present`가 되고 온보딩이 뜨지 않아야 한다. → Task 2(`present`), Task 8(온보딩이 `present`에서 안 뜸).
5. **다리가 `next()`에 이상한 값을 돌려줄 때** — 모르는 모양·너무 긴 토큰. 무시하되 화면의 `busy`를 풀어야 한다(안 풀면 폼이 잠긴 채 남는다). → Task 3.

---

## File Structure

**desktop (main)**

| 파일 | 책임 |
| --- | --- |
| `desktop/src/config/config.ts` (수정) | `launchEnv`가 `hfToken: string \| null`을 받는다. `childEnv`가 상속 `HF_TOKEN`을 버린다 |
| `desktop/src/app/token-boot.ts` (새) | 기동 때 Keychain 읽기 → `BootTokenStatus` 판정. 순수 |
| `desktop/src/windows/token-bridge.ts` (새) | 다리 계약 타입·파싱·호출문·문구·상태 기계·묻는 고리. electron을 import하지 않는다 |
| `desktop/src/windows/status-view.ts` (수정) | 상태 창 토큰 줄을 표시 전용으로. `ServicesAction`에서 토큰 동작 제거. 안내 문구 |
| `desktop/shell/services.html` (수정) | 토큰 버튼 두 개 제거 |
| `desktop/src/diagnostics/causes.ts`, `desktop/src/windows/shell-hints.ts` (수정) | `safeStorageUnavailable` 문구·안내 |
| `desktop/src/main.ts` (수정) | 게이트·토큰 창·교체·삭제 배선 제거, 다리 배선 |
| 삭제 | `shell/token.html`, `src/windows/token-window.ts`, `src/app/token-gate.ts`, `tests/windows/token-window.test.ts`, `tests/app/token-gate.test.ts`, `shell-window.ts`의 `createTokenWindow` |

**fe**

| 파일 | 책임 |
| --- | --- |
| `fe/src/features/hf-token/model/types.ts` (새) | `HfTokenState`·`HfTokenAction`·`HfTokenView` |
| `fe/src/features/hf-token/lib/bridge-store.ts` (새) | 다리 객체(`show`/`next`)와 구독 스토어, 동작 큐 |
| `fe/src/features/hf-token/lib/use-hf-token.ts` (새) | `useHfToken()`·`canDiarize()`·`detectDesktop()` |
| `fe/src/features/hf-token/ui/hf-token-form.tsx` (새) | 입력 폼 하나 — 세 곳이 공유 |
| `fe/src/features/hf-token/ui/hf-token-gate.tsx` (새) | `HfTokenGateProvider`·`useDiarizationGate()`·`HfTokenDialog` |
| `fe/src/features/hf-token/ui/hf-token-onboarding.tsx` (새) | 첫 실행 온보딩 카드 |
| `fe/src/features/hf-token/ui/hf-token-settings-section.tsx` (새) | 설정 섹션 |
| `fe/src/features/hf-token/lib/failure-copy.ts` (새) | `hf_token_invalid`·`hf_gate_not_accepted` 안내 문구 |
| `fe/src/features/meeting/lib/desktop-bridge.ts` (수정) | `hfToken` 설치 |
| `fe/src/app/app-shell.tsx`, `fe/src/features/meeting/ui/left-nav.tsx`, `fe/src/features/meeting/ui/transcript-pane.tsx`, `fe/src/pages/settings.tsx`, `fe/src/pages/meeting.tsx` (수정) | 배선 |

---

### Task 1: `launchEnv`는 토큰 없이도 되고, python 자식은 셸 토큰을 받지 않는다

**Files:**
- Modify: `desktop/src/config/config.ts` (`launchEnv` ≈316행, `childEnv` ≈244행, 그 위 주석 ≈204행)
- Test: `desktop/tests/config/config.test.ts`, `desktop/tests/config/config-reload.test.ts`

**Interfaces:**
- Produces: `launchEnv(cfg: LoadedConfig, llmPort: number, hfToken: string | null): { env: ApiEnv; baseline: ApiEnv }` — `null`이면 `env`에 `HF_TOKEN` 키 자체가 없다.
- Produces: `childEnv(ctx, inherited)` — `ctx.env.HF_TOKEN`이 없으면 결과에도 `HF_TOKEN`이 없다(상속분 무시).

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `desktop/tests/config/config.test.ts`의 `"childEnv still carries the live token…"` 테스트 바로 아래에 추가:

```ts
  it("childEnv never takes HF_TOKEN from the shell — the app is the only source (spec 2026-09-25 §5.1)", () => {
    const c = ctx({ PORT: "3000" });
    expect("HF_TOKEN" in childEnv(c, { HF_TOKEN: SHELL_TOKEN })).toBe(false);
  });
```

그리고 `desktop/tests/config/config-reload.test.ts`의 `launchEnv` 테스트들 근처에 추가:

```ts
  it("launchEnv without a token leaves HF_TOKEN out of env entirely", () => {
    const cfg = loadConfig(dir);
    const live = launchEnv(cfg, 51234, null);
    expect("HF_TOKEN" in live.env).toBe(false);
    expect("HF_TOKEN" in live.baseline).toBe(false);
  });
```

(`dir`·`loadConfig`·`launchEnv`는 그 파일이 이미 import·준비한다. 없으면 그 파일 머리의 import에 `launchEnv`를 더한다.)

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/config/config.test.ts tests/config/config-reload.test.ts`
Expected: FAIL — 첫 테스트는 `true`를 받는다(셸 토큰이 샌다), 둘째는 타입 오류(`null`은 `string`이 아니다) 또는 `HF_TOKEN: null`.

- [ ] **Step 3: 구현한다** — `config.ts`:

```ts
export function launchEnv(
  cfg: LoadedConfig,
  llmPort: number,
  hfToken: string | null,
): { env: ApiEnv; baseline: ApiEnv } {
  const env: ApiEnv = { ...cfg.env, LENS_LLM_BASE_URL: llmBaseUrl(llmPort) };
  if (hfToken !== null) env.HF_TOKEN = hfToken;
  return { env, baseline: withoutDbKeys(cfg.env) };
}
```

`launchEnv` 위 주석의 마지막 문단 "토큰이 필수 인자인 이유: 게이트를 지나지 않은 감독자를 타입이 막는다."를 다음으로 바꾼다:

```ts
 * 토큰이 null이면 HF_TOKEN을 싣지 않는다 — 토큰 없이도 앱은 뜬다(2026-09-25 스펙 §5.1). 그때 worker는 화자
 * 분리 모델을 받지 못하고, fe의 게이트가 그 job을 애초에 만들지 않는다.
```

`childEnv`:

```ts
export function childEnv(
  ctx: LaunchContext,
  inherited: Record<string, string | undefined> = process.env,
): Record<string, string> {
  // 토큰의 출처는 앱 하나다. 셸에서 물려받은 HF_TOKEN을 깔면, 앱이 "토큰 없음"이라 말하는 동안 worker는
  // 셸 토큰으로 화자 분리에 성공한다 — 게이트와 실제가 갈린다(스펙 2026-09-25 §5.1).
  const { HF_TOKEN: _shellToken, ...rest } = inherited;
  return { ...sanitizeChildEnv({ ...rest, ...ctx.env }), ...appOwnedChildEnv(ctx) };
}
```

(`_shellToken`이 `noUnusedLocals`에 걸리면 `const rest = { ...inherited }; delete rest.HF_TOKEN;`으로 쓴다.)

`appOwnedChildEnv` 위 주석의 "HF_TOKEN은 여기 없다 — 기동 게이트(app/token-gate.ts)가 … 게이트를 지나지 않은 감독자는 없다 (main.ts의 createSupervisorFor)." 문단을 다음으로 바꾼다:

```ts
 * HF_TOKEN은 여기 없다 — 기동 때 Keychain에서 읽은 값(app/token-boot.ts)을 launchEnv가 ctx.env에 싣는다.
 * 없으면 싣지 않고, childEnv가 상속분(개발자 셸의 HF_TOKEN)도 버린다. 토큰 교체·삭제는 그 ctx.env를 고친다
 * (windows/token-bridge.ts). Node 자식(API·마이그레이션 러너)은 nodeChildEnv가 토큰을 뺀다 (PYTHON_ONLY_ENV_KEYS).
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/config`
Expected: PASS (기존 `"childEnv still carries the live token…"`도 통과 — `ctx.env`의 토큰은 여전히 이긴다)

`main.ts:1538`의 `launchEnv(cfg, await freePort(), token)`은 Task 5에서 고친다. 이 시점 `tsc`는 통과한다(`string`은 `string | null`에 들어간다).

- [ ] **Step 5: 커밋**

```bash
git add desktop/src/config/config.ts desktop/tests/config/config.test.ts desktop/tests/config/config-reload.test.ts
git commit -m "feat(desktop): 토큰 없이 launchEnv를 만들고 python 자식에 셸 HF_TOKEN을 넘기지 않는다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 2: 기동 토큰 읽기 — `app/token-boot.ts`

**Files:**
- Create: `desktop/src/app/token-boot.ts`
- Test: `desktop/tests/app/token-boot.test.ts`

**Interfaces:**
- Consumes: `TokenStore`(`read()`·`available()`) from `desktop/src/config/token-store.ts`.
- Produces:
  ```ts
  export type BootTokenStatus = "present" | "absent" | "unreadable" | "unavailable";
  export interface BootToken { status: BootTokenStatus; token: string | null }
  export function readBootToken(d: { store: TokenStore; fileExists(): boolean; log(line: string): void }): BootToken
  ```
  `token`은 `status === "present"`일 때만 문자열이다.

- [ ] **Step 1: 실패하는 테스트**

```ts
// desktop/tests/app/token-boot.test.ts
import { describe, expect, it } from "vitest";
import { readBootToken } from "../../src/app/token-boot";
import type { TokenStore } from "../../src/config/token-store";

const TOKEN = "hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567";

function store(over: Partial<TokenStore>): TokenStore {
  return { read: () => null, write: () => undefined, clear: () => undefined, available: () => true, ...over };
}

describe("readBootToken (스펙 2026-09-25 §5.1)", () => {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);

  it("reads a stored token as present", () => {
    expect(readBootToken({ store: store({ read: () => TOKEN }), fileExists: () => true, log })).toEqual({
      status: "present",
      token: TOKEN,
    });
  });

  it("is absent when there is no file", () => {
    expect(readBootToken({ store: store({}), fileExists: () => false, log })).toEqual({ status: "absent", token: null });
  });

  it("is unreadable when the file is there but does not decrypt — and does not delete it", () => {
    let cleared = false;
    const s = store({ clear: () => void (cleared = true) });
    expect(readBootToken({ store: s, fileExists: () => true, log })).toEqual({ status: "unreadable", token: null });
    expect(cleared).toBe(false);
  });

  it("is unavailable without safeStorage and never reads", () => {
    let read = false;
    const s = store({ available: () => false, read: () => ((read = true), TOKEN) });
    expect(readBootToken({ store: s, fileExists: () => true, log })).toEqual({ status: "unavailable", token: null });
    expect(read).toBe(false);
  });

  it("never writes the token to the log", () => {
    lines.length = 0;
    readBootToken({ store: store({ read: () => TOKEN }), fileExists: () => true, log });
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-desktop exec vitest run tests/app/token-boot.test.ts`
Expected: FAIL — `Cannot find module '../../src/app/token-boot'`

- [ ] **Step 3: 구현**

```ts
// desktop/src/app/token-boot.ts
import type { TokenStore } from "../config/token-store";

/**
 * 기동 때 HF 토큰을 **읽기만** 한다 (스펙 2026-09-25 §5.1 — Phase 4 §6.4의 첫 실행 게이트를 대체한다).
 * 창을 띄우지도, 기동을 막지도 않는다. 토큰이 없으면 서비스는 HF_TOKEN 없이 뜨고, fe의 게이트가 화자 분리가
 * 필요한 동작을 막는다. main.ts는 electron을 값으로 import해 테스트가 못 부르므로 판정은 여기 있다.
 *
 * | 상태 | 뜻 |
 * | --- | --- |
 * | `unavailable` | safeStorage를 쓸 수 없다 — 읽지 않는다. 평문 폴백은 없다 |
 * | `present` | 저장된 토큰을 읽었다 |
 * | `absent` | 파일이 없다 |
 * | `unreadable` | 파일은 있는데 못 풀었다 — **파일은 그대로 둔다**. 새 토큰을 저장하면 덮어쓴다 |
 */
export type BootTokenStatus = "present" | "absent" | "unreadable" | "unavailable";

export interface BootToken {
  status: BootTokenStatus;
  /** status가 present일 때만 값이 있다. */
  token: string | null;
}

export interface BootTokenDeps {
  store: TokenStore;
  /** `<userData>/hf-token.bin`이 있는가. read()의 null이 "없음"인지 "못 읽음"인지 가른다. */
  fileExists(): boolean;
  log(line: string): void;
}

export function readBootToken(d: BootTokenDeps): BootToken {
  if (!d.store.available()) {
    d.log("키체인 암호화(safeStorage)를 쓸 수 없어 허깅페이스 토큰 없이 서비스를 띄워요.");
    return { status: "unavailable", token: null };
  }
  const stored = d.store.read();
  if (stored !== null) return { status: "present", token: stored };
  if (d.fileExists()) {
    d.log("허깅페이스 토큰 파일을 풀지 못했어요 — 파일은 그대로 두고 토큰 없이 서비스를 띄워요.");
    return { status: "unreadable", token: null };
  }
  d.log("허깅페이스 토큰이 없어요 — 토큰 없이 서비스를 띄워요. 담화 화면에서 넣을 수 있어요.");
  return { status: "absent", token: null };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter damwha-desktop exec vitest run tests/app/token-boot.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```bash
git add desktop/src/app/token-boot.ts desktop/tests/app/token-boot.test.ts
git commit -m "feat(desktop): 기동 때 HF 토큰을 읽기만 하는 token-boot를 둔다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 3: main 쪽 다리 — `windows/token-bridge.ts`

**Files:**
- Create: `desktop/src/windows/token-bridge.ts`
- Test: `desktop/tests/windows/token-bridge.test.ts`

**Interfaces:**
- Consumes: `TokenVerdict`, `maskToken`, `HF_GATED_MODEL_PAGE_URL`, `HF_TOKENS_PAGE_URL` (`config/token-store.ts`); `CAUSES` (`diagnostics/causes.ts`); `BootTokenStatus` (Task 2); `TokenChangeResult` (`windows/apply-token-change.ts`).
- Produces (Task 5와 fe가 같은 모양을 쓴다):
  ```ts
  export type HfTokenStatus = BootTokenStatus;
  export interface HfTokenMessage { tone: "info" | "warn" | "error"; text: string }
  export interface HfTokenState {
    status: HfTokenStatus; masked: string | null; account: string | null;
    onboardingDismissed: boolean; busy: boolean; message: HfTokenMessage | null;
  }
  export type HfTokenAction =
    | { kind: "submit"; token: string } | { kind: "clear" }
    | { kind: "dismissOnboarding" } | { kind: "open"; link: "accept" | "tokens" };
  export const HF_TOKEN_ASK_SCRIPT: string;           // "window.__damwha_desktop?.hfToken ? window.__damwha_desktop.hfToken.next() : null"
  export function hfTokenShowCall(state: HfTokenState): string;
  export function parseHfTokenAction(raw: unknown): HfTokenAction | null;
  export interface TokenBridgeDeps<W> { … }            // 아래 코드
  export interface TokenBridge<W> {
    boot(status: HfTokenStatus, masked: string | null): void;
    attach(win: W): void;
    state(): HfTokenState;
  }
  export function createTokenBridge<W>(d: TokenBridgeDeps<W>): TokenBridge<W>;
  export const MAX_TOKEN_INPUT = 4096;
  ```

- [ ] **Step 1: 실패하는 테스트**

```ts
// desktop/tests/windows/token-bridge.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  createTokenBridge,
  HF_TOKEN_ASK_SCRIPT,
  MAX_TOKEN_INPUT,
  parseHfTokenAction,
  type HfTokenAction,
  type HfTokenState,
  type TokenBridgeDeps,
} from "../../src/windows/token-bridge";
import { HF_GATED_MODEL_PAGE_URL, HF_TOKENS_PAGE_URL } from "../../src/config/token-store";

const TOKEN = "hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567";

/** 가짜 창 하나 — 페이지가 next()로 돌려줄 동작을 줄 세우고, show 호출을 모은다. */
function fakePage() {
  const shown: HfTokenState[] = [];
  const pending: Array<(a: unknown) => void> = [];
  const queued: unknown[] = [];
  let alive = true;
  let bridge = true;
  const run = vi.fn(async (_w: object, script: string): Promise<unknown> => {
    if (script === HF_TOKEN_ASK_SCRIPT) {
      if (!bridge) return null;
      if (queued.length > 0) return queued.shift();
      return new Promise((r) => pending.push(r));
    }
    const m = /hfToken\?\.show\((.*)\);$/.exec(script);
    if (m) shown.push(JSON.parse(m[1]) as HfTokenState);
    return undefined;
  });
  return {
    win: {},
    shown,
    run,
    act(a: unknown) {
      const r = pending.shift();
      if (r) r(a);
      else queued.push(a);
    },
    kill() {
      alive = false;
    },
    noBridge() {
      bridge = false;
    },
    get alive() {
      return alive;
    },
  };
}

function deps(page: ReturnType<typeof fakePage>, over: Partial<TokenBridgeDeps<object>> = {}): TokenBridgeDeps<object> {
  return {
    run: page.run,
    alive: () => page.alive,
    isRecording: async () => false,
    verify: async () => ({ ok: true, name: "jason" }),
    apply: async () => ({ restarted: ["worker", "embed"], skipped: [] }),
    clear: () => undefined,
    openExternal: async () => undefined,
    labels: (ids) => ids.join(", "),
    log: () => undefined,
    ...over,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const last = (p: ReturnType<typeof fakePage>) => p.shown[p.shown.length - 1];

describe("parseHfTokenAction — 렌더러 데이터", () => {
  it("accepts the four shapes", () => {
    expect(parseHfTokenAction({ kind: "submit", token: TOKEN })).toEqual({ kind: "submit", token: TOKEN });
    expect(parseHfTokenAction({ kind: "clear" })).toEqual({ kind: "clear" });
    expect(parseHfTokenAction({ kind: "dismissOnboarding" })).toEqual({ kind: "dismissOnboarding" });
    expect(parseHfTokenAction({ kind: "open", link: "accept" })).toEqual({ kind: "open", link: "accept" });
  });

  it("drops anything else, including an over-long paste and an address instead of a key", () => {
    for (const raw of [null, "submit", [], { kind: "submit" }, { kind: "submit", token: "x".repeat(MAX_TOKEN_INPUT + 1) },
      { kind: "open", link: "https://evil.example" }, { kind: "drop" }]) {
      expect(parseHfTokenAction(raw)).toBeNull();
    }
  });
});

describe("createTokenBridge", () => {
  it("pushes the boot state on attach and never carries the raw token", async () => {
    const page = fakePage();
    const b = createTokenBridge(deps(page));
    b.boot("present", "hf_****…****4567");
    b.attach(page.win);
    await flush();
    expect(last(page)).toMatchObject({ status: "present", masked: "hf_****…****4567", busy: false });
    expect(JSON.stringify(page.shown)).not.toContain(TOKEN);
  });

  it("submit: verifies, applies, and reports present with the account", async () => {
    const page = fakePage();
    const apply = vi.fn(async () => ({ restarted: ["worker", "embed"] as const, skipped: [] }));
    const b = createTokenBridge(deps(page, { apply: apply as never }));
    b.boot("absent", null);
    b.attach(page.win);
    page.act({ kind: "submit", token: `  ${TOKEN}  ` });
    await flush();
    await flush();
    expect(apply).toHaveBeenCalledWith(TOKEN);
    expect(last(page)).toMatchObject({ status: "present", account: "jason", busy: false, message: { tone: "info" } });
    expect(last(page).masked).toBe("hf_****…****4567");
  });

  it("submit: a failed verify saves nothing and says why", async () => {
    const page = fakePage();
    const apply = vi.fn();
    const b = createTokenBridge(
      deps(page, { apply, verify: async () => ({ ok: false, kind: "invalid", detail: "HTTP 401" }) }),
    );
    b.boot("absent", null);
    b.attach(page.win);
    page.act({ kind: "submit", token: TOKEN });
    await flush();
    await flush();
    expect(apply).not.toHaveBeenCalled();
    expect(last(page)).toMatchObject({ status: "absent", busy: false, message: { tone: "error" } });
    expect(last(page).message!.text).toContain("HTTP 401");
  });

  it("submit: refused while recording — the worker restart would cut the live session (§5.3)", async () => {
    const page = fakePage();
    const verify = vi.fn();
    const b = createTokenBridge(deps(page, { verify, isRecording: async () => true }));
    b.boot("present", "hf_****…****4567");
    b.attach(page.win);
    page.act({ kind: "submit", token: TOKEN });
    await flush();
    await flush();
    expect(verify).not.toHaveBeenCalled();
    expect(last(page).message).toEqual({ tone: "warn", text: "녹음을 마친 뒤 바꿔 주세요." });
  });

  it("submit: a save failure keeps the old status and unlocks", async () => {
    const page = fakePage();
    const b = createTokenBridge(
      deps(page, {
        apply: async () => {
          throw new Error("토큰을 저장했지만 다시 읽지 못했어요.");
        },
      }),
    );
    b.boot("absent", null);
    b.attach(page.win);
    page.act({ kind: "submit", token: TOKEN });
    await flush();
    await flush();
    expect(last(page)).toMatchObject({ status: "absent", busy: false, message: { tone: "error" } });
  });

  it("submit: warns when a service could not be restarted", async () => {
    const page = fakePage();
    const b = createTokenBridge(deps(page, { apply: async () => ({ restarted: ["embed"], skipped: ["worker"] }) }));
    b.boot("absent", null);
    b.attach(page.win);
    page.act({ kind: "submit", token: TOKEN });
    await flush();
    await flush();
    expect(last(page)).toMatchObject({ status: "present", message: { tone: "warn" } });
    expect(last(page).message!.text).toContain("worker");
  });

  it("submit: refused when safeStorage is unavailable", async () => {
    const page = fakePage();
    const verify = vi.fn();
    const b = createTokenBridge(deps(page, { verify }));
    b.boot("unavailable", null);
    b.attach(page.win);
    page.act({ kind: "submit", token: TOKEN });
    await flush();
    await flush();
    expect(verify).not.toHaveBeenCalled();
    expect(last(page)).toMatchObject({ status: "unavailable", busy: false, message: { tone: "error" } });
  });

  it("clear: removes the token without restarting anything", async () => {
    const page = fakePage();
    const clear = vi.fn();
    const apply = vi.fn();
    const b = createTokenBridge(deps(page, { clear, apply }));
    b.boot("present", "hf_****…****4567");
    b.attach(page.win);
    page.act({ kind: "clear" });
    await flush();
    expect(clear).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
    expect(last(page)).toMatchObject({ status: "absent", masked: null, account: null });
  });

  it("dismissOnboarding: remembered for this run only — the bridge holds it in memory", async () => {
    const page = fakePage();
    const b = createTokenBridge(deps(page));
    b.boot("absent", null);
    b.attach(page.win);
    page.act({ kind: "dismissOnboarding" });
    await flush();
    expect(last(page).onboardingDismissed).toBe(true);
    // 새 실행 = 새 브리지. 기억은 따라오지 않는다.
    const next = createTokenBridge(deps(fakePage()));
    next.boot("absent", null);
    expect(next.state().onboardingDismissed).toBe(false);
  });

  it("open: opens only the fixed addresses", async () => {
    const page = fakePage();
    const openExternal = vi.fn(async () => undefined);
    const b = createTokenBridge(deps(page, { openExternal }));
    b.boot("absent", null);
    b.attach(page.win);
    page.act({ kind: "open", link: "accept" });
    await flush();
    page.act({ kind: "open", link: "tokens" });
    await flush();
    expect(openExternal.mock.calls).toEqual([[HF_GATED_MODEL_PAGE_URL], [HF_TOKENS_PAGE_URL]]);
  });

  it("an unknown action is dropped but unlocks the page (Review Focus 5)", async () => {
    const page = fakePage();
    const b = createTokenBridge(deps(page));
    b.boot("absent", null);
    b.attach(page.win);
    page.act({ kind: "submit", token: "x".repeat(MAX_TOKEN_INPUT + 1) });
    await flush();
    expect(last(page)).toMatchObject({ busy: false, message: { tone: "error" } });
  });

  it("re-attach (⌘R) ends the old loop and starts a new one on the new page (Review Focus 1)", async () => {
    const page = fakePage();
    const b = createTokenBridge(deps(page));
    b.boot("absent", null);
    b.attach(page.win);
    await flush();
    const asksBefore = page.run.mock.calls.filter((c) => c[1] === HF_TOKEN_ASK_SCRIPT).length;
    b.attach(page.win);
    await flush();
    const asksAfter = page.run.mock.calls.filter((c) => c[1] === HF_TOKEN_ASK_SCRIPT).length;
    expect(asksAfter).toBe(asksBefore + 1);
    // 옛 고리와 새 고리가 둘 다 기다리는 중이다. 첫 답은 옛 고리가 받고 **버린다** — 옛 세대다.
    page.act({ kind: "dismissOnboarding" });
    await flush();
    expect(b.state().onboardingDismissed).toBe(false);
    // 둘째 답은 새 고리가 받아 처리한다.
    page.act({ kind: "dismissOnboarding" });
    await flush();
    expect(b.state().onboardingDismissed).toBe(true);
  });

  it("a page without the bridge ends the loop quietly — no busy loop", async () => {
    const page = fakePage();
    page.noBridge();
    const b = createTokenBridge(deps(page));
    b.boot("absent", null);
    b.attach(page.win);
    await flush();
    await flush();
    expect(page.run.mock.calls.filter((c) => c[1] === HF_TOKEN_ASK_SCRIPT)).toHaveLength(1);
  });

  it("a rejected ask ends the loop quietly", async () => {
    const page = fakePage();
    const run = vi.fn(async (_w: object, script: string) => {
      if (script === HF_TOKEN_ASK_SCRIPT) throw new Error("Render frame was disposed");
      return undefined;
    });
    const b = createTokenBridge(deps(page, { run }));
    b.boot("absent", null);
    b.attach(page.win);
    await flush();
    await flush();
    expect(run.mock.calls.filter((c) => c[1] === HF_TOKEN_ASK_SCRIPT)).toHaveLength(1);
  });
});

// 타입만 쓰는 import가 사용되지 않았다는 lint를 피한다.
export type _A = HfTokenAction;
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows/token-bridge.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

```ts
// desktop/src/windows/token-bridge.ts
import { CAUSES } from "../diagnostics/causes";
import {
  HF_GATED_MODEL_PAGE_URL,
  HF_TOKENS_PAGE_URL,
  maskToken,
  type TokenVerdict,
} from "../config/token-store";
import type { BootTokenStatus } from "../app/token-boot";
import type { TokenChangeResult } from "./apply-token-change";
import type { ServiceId } from "../services/types";

/**
 * 담화 화면 안의 HF 토큰 — **흐름** (스펙 2026-09-25 §4). 잎(executeJavaScript·shell.openExternal·safeStorage·
 * 감독자 재시작)은 main.ts가 주입한다. 이 파일은 electron을 import하지 않는다(status-window.ts와 같은 나눔).
 *
 * 렌더러 → main 채널을 만들지 않는다 (Phase 2 스펙 §6.11). main이 `hfToken.next()`를 **묻고**, 사람이 무언가 하면
 * 그 호출이 답으로 끝난다. 상태는 `hfToken.show(state)` 한 방향으로 밀어 넣는다. 페이지가 보내는 것은 네 모양뿐이고
 * (parseHfTokenAction), 링크는 **열쇠**만 보낸다 — 어느 주소를 열지는 main이 고정 표(LINKS)로 정한다.
 *
 * 동작은 **한 번에 하나씩** 처리한다 — 고리가 handle을 기다린 뒤에 다음을 묻는다. 그래서 확인·저장·재시작 중에 온
 * 두 번째 요청은 페이지 쪽 대기열에서 기다리고, 두 교체가 겹치지 않는다(옛 tokenBusy의 자리).
 */

export type HfTokenStatus = BootTokenStatus;

export interface HfTokenMessage {
  tone: "info" | "warn" | "error";
  text: string;
}

/** 페이지가 받는 상태. **원문은 싣지 않는다** — masked만. message는 HF 응답 문구를 담을 수 있다(fe는 텍스트로만 그린다). */
export interface HfTokenState {
  status: HfTokenStatus;
  masked: string | null;
  /** 이번 실행에서 whoami로 확인했을 때만. */
  account: string | null;
  /** 이번 실행에서 "나중에 하기"를 눌렀나. main 메모리 — 앱을 다시 켜면 false다 (§3.3). */
  onboardingDismissed: boolean;
  busy: boolean;
  message: HfTokenMessage | null;
}

export type HfTokenLink = "accept" | "tokens";

export type HfTokenAction =
  | { kind: "submit"; token: string }
  | { kind: "clear" }
  | { kind: "dismissOnboarding" }
  | { kind: "open"; link: HfTokenLink };

const LINKS: Readonly<Record<HfTokenLink, string>> = Object.freeze({
  accept: HF_GATED_MODEL_PAGE_URL,
  tokens: HF_TOKENS_PAGE_URL,
});

export const MAX_TOKEN_INPUT = 4096;

/** 다음 동작을 묻는 식. 다리가 없으면 null — 고리를 조용히 끝낸다. 이름은 fe의 desktop-bridge.ts와 같아야 한다. */
export const HF_TOKEN_ASK_SCRIPT =
  "window.__damwha_desktop?.hfToken ? window.__damwha_desktop.hfToken.next() : null";

/** 상태를 그리는 호출문. 값은 JSON으로만 싣는다(status-view.ts의 renderCall과 같은 이유). */
export function hfTokenShowCall(state: HfTokenState): string {
  return `void window.__damwha_desktop?.hfToken?.show(${JSON.stringify(state)});`;
}

/** 페이지에서 온 값. 렌더러 데이터이므로 모양을 확인하고, 모르는 것은 null이다. */
export function parseHfTokenAction(raw: unknown): HfTokenAction | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { kind?: unknown; token?: unknown; link?: unknown };
  if (r.kind === "submit") {
    return typeof r.token === "string" && r.token.length <= MAX_TOKEN_INPUT ? { kind: "submit", token: r.token } : null;
  }
  if (r.kind === "clear") return { kind: "clear" };
  if (r.kind === "dismissOnboarding") return { kind: "dismissOnboarding" };
  if (r.kind === "open") {
    return typeof r.link === "string" && Object.prototype.hasOwnProperty.call(LINKS, r.link)
      ? { kind: "open", link: r.link as HfTokenLink }
      : null;
  }
  return null;
}

// 문구 — 옛 token-window.ts에서 옮겼다.
const EMPTY_MESSAGE = "토큰을 붙여 넣은 뒤 확인을 눌러 주세요.";
const UNKNOWN_REQUEST_MESSAGE =
  `토큰을 읽지 못했어요 — 붙여 넣은 값이 너무 길거나(${MAX_TOKEN_INPUT}자까지) 모양이 올바르지 않아요. ` +
  "토큰만 다시 붙여 넣은 뒤 확인을 눌러 주세요.";
const CHECKING_MESSAGE = "허깅페이스에서 토큰을 확인하고 있어요…";
const RECORDING_MESSAGE = "녹음을 마친 뒤 바꿔 주세요.";
const CLEARED_MESSAGE =
  "토큰을 지웠어요. 지금 도는 작업 처리기는 옛 토큰으로 계속 돌지만, 다시 시작하면 토큰 없이 떠요.";

function verdictMessage(v: Extract<TokenVerdict, { ok: false }>): string {
  if (v.kind === "invalid") return `${CAUSES.hfTokenInvalid.text} (${v.detail}) 토큰을 확인하고 다시 입력해 주세요.`;
  return `지금은 확인할 수 없어요 (${v.detail}). 인터넷 연결을 확인한 뒤 다시 확인을 눌러 주세요. 토큰은 저장하지 않았어요.`;
}

function nameOf(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

export interface TokenBridgeDeps<W> {
  /** main → 렌더러 (executeJavaScript). 식이 프라미스면 그 결과를 기다린다. */
  run(win: W, script: string): Promise<unknown>;
  alive(win: W): boolean;
  /** 담화 화면이 녹음 중인가 (recording-bridge.ts의 askIsRecording — 상한이 있다). */
  isRecording(): Promise<boolean>;
  verify(token: string): Promise<TokenVerdict>;
  /**
   * 확인된 토큰을 저장하고 살아 있는 실행에 닿게 한다 (apply-token-change.ts의 applyTokenChange). 저장·증명
   * 실패는 던진다 — 그때는 아무 서비스도 재시작되지 않았다.
   */
  apply(token: string): Promise<TokenChangeResult>;
  /** 파일·캐시·live env의 HF_TOKEN을 지운다. 재시작하지 않는다. */
  clear(): void;
  openExternal(url: string): Promise<void>;
  /** 서비스 id 목록을 사람이 읽는 이름표로. */
  labels(ids: readonly ServiceId[]): string;
  log(line: string): void;
  /** 상태가 바뀔 때마다 — 상태 창의 토큰 줄을 다시 그리는 데 쓴다. 없어도 된다. */
  onChange?(): void;
}

export interface TokenBridge<W> {
  /** 기동 읽기 결과(app/token-boot.ts)를 싣는다. 감독자를 세울 때마다 부른다. */
  boot(status: HfTokenStatus, masked: string | null): void;
  /** 담화 화면이 붙었다 — 첫 로드와 ⌘R 모두. 상태를 밀어 넣고 새 고리를 연다. 옛 고리는 낡는다. */
  attach(win: W): void;
  state(): HfTokenState;
}

export function createTokenBridge<W>(d: TokenBridgeDeps<W>): TokenBridge<W> {
  let current: W | null = null;
  /** 페이지 세대. attach마다 오른다 — 그 전 세대의 묻기는 낡았다(status-window.ts의 page와 같은 장치). */
  let page = 0;
  let state: HfTokenState = {
    status: "absent",
    masked: null,
    account: null,
    onboardingDismissed: false,
    busy: false,
    message: null,
  };

  const push = () => {
    const win = current;
    if (win === null || !d.alive(win)) return;
    let pending: Promise<unknown>;
    try {
      pending = d.run(win, hfTokenShowCall(state));
    } catch (e) {
      if (d.alive(win)) d.log(`담화 화면에 토큰 상태를 그리지 못했어요 (${nameOf(e)}).`);
      return;
    }
    pending.catch((e: unknown) => {
      if (d.alive(win)) d.log(`담화 화면에 토큰 상태를 그리지 못했어요 (${nameOf(e)}).`);
    });
  };

  const set = (next: Partial<HfTokenState>) => {
    state = { ...state, ...next };
    push();
    d.onChange?.();
  };

  const submit = async (raw: string) => {
    const token = raw.trim();
    if (state.status === "unavailable") {
      set({ busy: false, message: { tone: "error", text: CAUSES.safeStorageUnavailable.text } });
      return;
    }
    if (token === "") {
      set({ busy: false, message: { tone: "error", text: EMPTY_MESSAGE } });
      return;
    }
    if (await d.isRecording()) {
      set({ busy: false, message: { tone: "warn", text: RECORDING_MESSAGE } });
      return;
    }
    set({ busy: true, message: { tone: "info", text: CHECKING_MESSAGE } });
    let verdict: TokenVerdict;
    try {
      verdict = await d.verify(token);
    } catch (e) {
      verdict = { ok: false, kind: "offline", detail: `확인 중 오류 (${nameOf(e)})` };
    }
    if (!verdict.ok) {
      d.log(`허깅페이스 토큰을 확인하지 못했어요 (${verdict.kind}) — ${verdict.detail}`);
      set({ busy: false, message: { tone: "error", text: verdictMessage(verdict) } });
      return;
    }
    let result: TokenChangeResult;
    try {
      result = await d.apply(token);
    } catch (e) {
      // 원래 예외 문구는 apply-token-change.ts의 고정 문구다 — 토큰이 담기지 않는다.
      const why = e instanceof Error ? e.message : nameOf(e);
      d.log(`허깅페이스 토큰을 저장하지 못했어요 — ${why}`);
      set({ busy: false, message: { tone: "error", text: `토큰을 저장하지 못했어요 — ${why}` } });
      return;
    }
    d.log(`허깅페이스 토큰을 확인하고 저장했어요 — 계정 ${verdict.name}, 토큰 ${maskToken(token)}`);
    const skipped = result.skipped.length > 0 ? ` 다시 시작하지 못함: ${d.labels(result.skipped)}.` : "";
    set({
      status: "present",
      masked: maskToken(token),
      account: verdict.name,
      busy: false,
      message: {
        tone: result.skipped.length > 0 ? "warn" : "info",
        text: `토큰을 저장했어요 — 계정 ${verdict.name}.${skipped}`,
      },
    });
  };

  const handle = async (action: HfTokenAction) => {
    switch (action.kind) {
      case "submit":
        await submit(action.token);
        return;
      case "clear":
        try {
          d.clear();
        } catch (e) {
          d.log(`허깅페이스 토큰을 지우지 못했어요 (${nameOf(e)}).`);
          set({ message: { tone: "error", text: "토큰을 지우지 못했어요. 다시 시도해 주세요." } });
          return;
        }
        d.log("허깅페이스 토큰을 지웠어요 — 서비스는 다시 시작하지 않았어요.");
        set({ status: "absent", masked: null, account: null, message: { tone: "info", text: CLEARED_MESSAGE } });
        return;
      case "dismissOnboarding":
        set({ onboardingDismissed: true });
        return;
      case "open":
        try {
          await d.openExternal(LINKS[action.link]);
        } catch (e) {
          d.log(`브라우저에서 ${LINKS[action.link]}을(를) 열지 못했어요 (${nameOf(e)}).`);
        }
        return;
    }
  };

  const ask = async (win: W, mine: number) => {
    while (mine === page && d.alive(win)) {
      let raw: unknown;
      try {
        raw = await d.run(win, HF_TOKEN_ASK_SCRIPT);
      } catch {
        // 새로 고침·창 닫기가 진행 중인 호출을 끊는다 — 다음 attach가 다시 묻는다.
        return;
      }
      if (mine !== page) return;
      // 다리가 없는 문서(웹 화면·옛 빌드) — 빈 고리를 돌지 않는다.
      if (raw === null || raw === undefined) return;
      const action = parseHfTokenAction(raw);
      if (action === null) {
        d.log("담화 화면에서 알 수 없는 토큰 요청이 와서 무시했어요.");
        set({ busy: false, message: { tone: "error", text: UNKNOWN_REQUEST_MESSAGE } });
        continue;
      }
      await handle(action);
    }
  };

  return {
    boot(status, masked) {
      state = { ...state, status, masked: status === "present" ? masked : null, account: null, busy: false, message: null };
      push();
      d.onChange?.();
    },
    attach(win) {
      current = win;
      page += 1;
      push();
      void ask(win, page);
    },
    state: () => state,
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows/token-bridge.test.ts`
Expected: PASS

- [ ] **Step 5: 변이 확인** — 세 군데를 하나씩 깨고 실패를 본 뒤 되돌린다:
  1. `if (await d.isRecording())` 블록 삭제 → "refused while recording" 실패
  2. `ask`의 `if (mine !== page) return;` 삭제 → "re-attach" 실패
  3. `case "dismissOnboarding"`에서 `set({ onboardingDismissed: true })` → `set({})` → "dismissOnboarding" 실패

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows/token-bridge.test.ts` (매번)

- [ ] **Step 6: 커밋**

```bash
git add desktop/src/windows/token-bridge.ts desktop/tests/windows/token-bridge.test.ts
git commit -m "feat(desktop): 담화 화면과 HF 토큰을 주고받는 token-bridge를 둔다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 4: 상태 창 토큰 줄을 표시 전용으로, 안내 문구를 담화 설정으로

**Files:**
- Modify: `desktop/src/windows/status-view.ts` (`TokenView` ≈223행, `NO_TOKEN_NOTE`/`TOKEN_NOTE` ≈289행, `modelRows`의 401 안내 ≈456행, `tokenView` ≈483행, `ServicesInput.tokenBusy` ≈280행, `ServicesAction`/`parseServicesAction` ≈562–590행)
- Modify: `desktop/shell/services.html` (토큰 버튼·핸들러, 머리 주석)
- Modify: `desktop/src/diagnostics/causes.ts:91-95`, `desktop/src/windows/shell-hints.ts:66-69`
- Test: `desktop/tests/windows/status-view.test.ts`, `desktop/tests/windows/shell-html.test.ts`

**Interfaces:**
- Produces: `TokenView = { masked: string | null; note: string }`; `ServicesAction = { kind: "restart"; service: ServiceId }`; `servicesView`는 `tokenBusy`를 받지 않는다.

- [ ] **Step 1: 테스트를 새 모양으로 바꾼다** — `status-view.test.ts`:
  - `token: { masked: null, note: "", canClear: false, busy: false }`(≈52행)과 `token: { masked: text, note: text, canClear: true, busy: false }`(≈419행)를 각각 `{ masked: null, note: "" }`, `{ masked: text, note: text }`로.
  - ≈780–797행의 토큰 테스트를 다음으로 바꾼다:

```ts
  it("shows only the masked token and points to the Damwha settings — no buttons here any more", () => {
    const token = "hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567";
    const view = servicesView({ statuses: [], restartNotice: null, logPathOf, maskedToken: maskToken(token) });
    expect(view.token).toEqual({ masked: "hf_****…****4567", note: TOKEN_NOTE });
    expect(JSON.stringify(view)).not.toContain(token);
    expect(TOKEN_NOTE).toContain("담화 설정");
    expect(servicesView({ statuses: [], restartNotice: null, logPathOf }).token).toEqual({ masked: null, note: NO_TOKEN_NOTE });
    expect(NO_TOKEN_NOTE).toContain("담화 설정");
  });
```

  - `parseServicesAction` 테스트(≈806–821행)에서 토큰 두 줄은 이제 `null`을 기대한다:

```ts
    expect(parseServicesAction({ kind: "token", op: "change" })).toBeNull();
    expect(parseServicesAction({ kind: "token", op: "clear" })).toBeNull();
```

  - ≈834–846행의 `tokenBusy` 테스트는 지운다.
  - 401 안내 테스트(`hf_token_invalid`, ≈677행 근처)에서 hint 기대값에 `"담화 설정"`이 들어가는지 확인하도록 한 줄 더한다: `expect(row.hint).toContain("담화 설정");` (그 테스트가 쓰는 변수 이름에 맞춘다).

  `shell-html.test.ts`의 `services.html` 블록:
  - ≈380–393행(토큰 버튼 클릭 → next)과 ≈395–428행(버튼 잠금·없음) 세 테스트를 다음 하나로 바꾼다:

```ts
    it("shows the token masked and has no token buttons — the input lives in Damwha now (스펙 2026-09-25 §5.4)", () => {
      const { sandbox, byId, html } = loadPage("services.html");
      const token = "hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567";
      (sandbox.__damwha_render as (v: unknown) => void)(view({ maskedToken: maskToken(token) }));
      expect(byId.get("token-value")!.textContent).toBe("hf_****…****4567");
      expect(byId.get("token")!.textContent).not.toContain(token);
      expect(byId.has("token-change")).toBe(false);
      expect(byId.has("token-clear")).toBe(false);
      expect(codeOf(html)).not.toMatch(/kind:\s*"token"/);
    });
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows/status-view.test.ts tests/windows/shell-html.test.ts`
Expected: FAIL (옛 모양·옛 문구)

- [ ] **Step 3: 구현**

`status-view.ts`:

```ts
export interface TokenView {
  /** 가린 모양(`hf_****…****abcd`). 저장된 토큰이 없으면 null. */
  masked: string | null;
  note: string;
}
```

```ts
/** 토큰이 없을 때 (스펙 2026-09-25 §5.4 — 입력은 담화 화면이 맡는다). */
export const NO_TOKEN_NOTE =
  "저장된 토큰이 없어요. 화자 분리에 필요해요 — 담화 설정의 “허깅페이스 토큰”에서 넣을 수 있어요.";
/** 토큰이 있을 때. */
export const TOKEN_NOTE = "담화 설정의 “허깅페이스 토큰”에서 바꾸거나 지울 수 있어요.";
```

`modelRows`의 401 hint:

```ts
        hint: `${HINTS.hfTokenInvalid as string} 담화 설정의 “허깅페이스 토큰”에서 바꾸면 두 서비스가 다시 시작돼요.`,
```

`tokenView`:

```ts
/** 토큰 절. 원문은 이 함수에 들어오지 않는다 — 부르는 쪽이 이미 `maskToken`을 지났다. */
export function tokenView(masked: string | null | undefined): TokenView {
  const value = masked ?? null;
  return { masked: value, note: value === null ? NO_TOKEN_NOTE : TOKEN_NOTE };
}
```

`ServicesInput`에서 `tokenBusy` 필드와 주석을 지우고, `servicesView`에서 `token: tokenView(input.maskedToken)`.

`ServicesAction`·`parseServicesAction`:

```ts
/** 상태 창이 main에게 보내는 것 — **이것 하나뿐이다** (parseServicesAction이 그것을 강제한다). */
export type ServicesAction = { kind: "restart"; service: ServiceId };

export function parseServicesAction(raw: unknown): ServicesAction | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { kind?: unknown; service?: unknown };
  if (r.kind === "restart") {
    return typeof r.service === "string" &&
      Object.prototype.hasOwnProperty.call(SERVICE_LABELS, r.service)
      ? { kind: "restart", service: r.service as ServiceId }
      : null;
  }
  return null;
}
```

`TOKEN_OPS` 상수를 지운다. `parseServicesAction`·`SERVICES_ASK_SCRIPT` 주석의 "token-window.ts의 `parseAction`/`ASK_SCRIPT`와 같은" 언급은 "token-bridge.ts의 `parseHfTokenAction`/`HF_TOKEN_ASK_SCRIPT`와 같은"으로 바꾼다.

`services.html`:
- 마크업의 `<span class="act">…token-change…token-clear…</span>`를 지운다(`#token` 안은 `<div class="head"><span id="token-value">확인하는 중…</span></div><p id="token-note"></p>`만 남긴다).
- 스크립트의 `tokenChange`·`tokenClear` 변수와 두 `addEventListener`, 렌더 함수의 `tokenChange.disabled`·`tokenClear.disabled` 두 줄과 그 위 주석을 지운다. `const token = view.token || { masked: null, note: "" };`로.
- 머리 주석의 "Phase 4(Task 11)부터 … 토큰 입력은 token.html 하나가 맡는다." 문단을 다음으로 바꾼다:

```html
         버튼은 "서비스 다시 시작" 하나다(Phase 4 스펙 §6.10 2층). **그래도 렌더러 → main 채널은 만들지 않는다**:
         preload도 IPC도 없고, 버튼은 main이 거는 next() 호출의 **반환값**으로만 밖에 나간다. 토큰은 표시만
         한다 — 입력·교체·삭제는 담화 화면(fe의 features/hf-token)이 맡는다(스펙 2026-09-25 §5.4).
```

- 스크립트·스타일이 바뀌었으니 CSP 해시를 다시 계산한다(스크립트만 바뀌었으면 `script-src`만):

```bash
cd desktop && python3 - <<'EOF'
import re,hashlib,base64
p='shell/services.html'; h=open(p,encoding='utf-8').read()
sha=lambda t:"'sha256-"+base64.b64encode(hashlib.sha256(t.encode()).digest()).decode()+"'"
s=re.search(r'<script>([\s\S]*?)</script>',h).group(1); st=re.search(r'<style>([\s\S]*?)</style>',h).group(1)
h=re.sub(r"script-src '[^']+'; style-src '[^']+'",f"script-src {sha(s)}; style-src {sha(st)}",h)
open(p,'w',encoding='utf-8').write(h)
EOF
```

`causes.ts`의 `safeStorageUnavailable.text`:

```ts
    text: "macOS 키체인을 쓸 수 없어 허깅페이스 토큰을 안전하게 보관할 수 없어요. 토큰 없이 실행 중이에요 — 화자 분리가 필요한 기능은 막혀 있어요.",
```

(`match: /키체인을 쓸 수 없어 허깅페이스 토큰을/`는 그대로 맞는다.)

`shell-hints.ts`의 `safeStorageUnavailable`:

```ts
  safeStorageUnavailable:
    "키체인 접근 앱에서 로그인 키체인의 잠금을 해제한 뒤 담화를 다시 켜 주세요.",
```

`hfTokenInvalid`(≈69행)는 URL 안내라 그대로 둔다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows tests/diagnostics`
Expected: PASS. `main.ts`가 아직 `tokenBusy`·`kind: "token"`을 쓰므로 `pnpm --filter damwha-desktop run lint`는 이 시점 실패한다 — Task 5가 고친다. **이 Task는 Task 5와 같은 커밋으로 묶지 않되, 커밋 전에 Task 5까지 끝내고 lint를 본 뒤 두 커밋을 차례로 만든다.**

- [ ] **Step 5: 커밋** (Task 5 Step 5의 lint 통과 뒤)

```bash
git add desktop/src/windows/status-view.ts desktop/shell/services.html desktop/src/diagnostics/causes.ts desktop/src/windows/shell-hints.ts desktop/tests/windows/status-view.test.ts desktop/tests/windows/shell-html.test.ts
git commit -m "feat(desktop): 상태 창의 토큰 줄을 표시 전용으로 바꾸고 안내를 담화 설정으로 돌린다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 5: main 배선 — 게이트·토큰 창을 걷고 다리를 붙인다

**Files:**
- Modify: `desktop/src/main.ts`
- Modify: `desktop/src/windows/shell-window.ts` (`createTokenWindow`·`shellFileOf`의 `"token.html"` 제거)
- Delete: `desktop/shell/token.html`, `desktop/src/windows/token-window.ts`, `desktop/src/app/token-gate.ts`, `desktop/tests/windows/token-window.test.ts`, `desktop/tests/app/token-gate.test.ts`
- Modify: `desktop/tests/windows/shell-html.test.ts` (`token.html` describe 블록 삭제, 페이지 목록 두 곳)
- Modify: `desktop/CLAUDE.md`

**Interfaces:**
- Consumes: `readBootToken` (Task 2), `createTokenBridge`·`TokenBridge` (Task 3), `launchEnv(…, string | null)` (Task 1), `applyTokenChange`·`ownedByStatus`·`TOKEN_SERVICES` (기존), `isRecordingIn` (기존 main.ts:502).

- [ ] **Step 1: shell-html 테스트에서 token.html을 걷는다** — `describe("token.html (Phase 4 스펙 §6.4 — 첫 실행 게이트)", …)` 블록 전체를 지우고, 두 곳의 목록을 바꾼다:

```ts
    expect(pages).toEqual(["services.html", "status.html"]);
```

```ts
  for (const file of ["services.html", "status.html"]) {
```

(CSP 블록과 디자인 토큰 블록 둘 다.) `FakeNode`의 `/** 입력칸·버튼 (token.html). */` 주석은 `/** 입력칸·버튼. */`로.

- [ ] **Step 2: 파일을 지운다**

```bash
git rm desktop/shell/token.html desktop/src/windows/token-window.ts desktop/src/app/token-gate.ts \
  desktop/tests/windows/token-window.test.ts desktop/tests/app/token-gate.test.ts
```

`shell-window.ts`: `createTokenWindow` 함수와 그 주석 전체를 지우고 `shellFileOf`의 타입을 `name: "status.html" | "services.html"`로.

- [ ] **Step 3: main.ts를 고친다**

(a) import — `openTokenWindow, TokenWindowClosed`(21행)와 `runTokenGate`(있으면), `createTokenWindow`를 지우고 추가한다:

```ts
import { readBootToken } from "./app/token-boot";
import { createTokenBridge } from "./windows/token-bridge";
```

(b) 모듈 전역 — `tokenBusy` 선언을 지운다(`grep -n "let tokenBusy" src/main.ts`). `hfToken`(226행)은 남긴다.

(c) 다리 인스턴스 — `statusWindow` 선언(678행) **아래**에 둔다:

```ts
/**
 * 담화 화면의 HF 토큰 (스펙 2026-09-25 §4). 흐름은 windows/token-bridge.ts에 있다 — 여기는 잎이다.
 * 붙는 자리는 둘이다: 담화 화면이 처음 붙을 때(reattachWindow)와 ⌘R로 다시 로드될 때(createWindow의 did-finish-load).
 */
const tokenBridge = createTokenBridge<BrowserWindow>({
  run: (w, script) => w.webContents.executeJavaScript(script),
  alive: (w) => !w.isDestroyed(),
  isRecording: () => (updateAttached === null ? Promise.resolve(false) : isRecordingIn(updateAttached)),
  verify: (token) => verifyHfToken(token),
  apply: (token) =>
    applyTokenChange(
      {
        store: makeTokenStore(app.getPath("userData"), safeStorage),
        // 감독자가 없으면 얹을 live env가 없다. 그래도 저장·캐시는 해 두어야 다음 기동이 새 값을 쓴다.
        liveEnv: launchCtx?.ctx.env ?? {},
        restartService: (id) =>
          trackRestart(id, async () => {
            const sup = supervisor;
            if (sup === null) throw new Error(NO_SERVICES_YET);
            await sup.restartService(id);
          }),
        owned: ownedByStatus(supervisor?.statuses() ?? []),
        // live env와 **같은 순간** 모듈 전역 캐시를 갱신한다 — 하나만 바꾸면 감독자 재생성이 옛 값을 되살린다.
        cacheToken: (t) => {
          hfToken = t;
        },
      },
      token,
    ),
  clear: () => {
    makeTokenStore(app.getPath("userData"), safeStorage).clear();
    hfToken = null;
    if (launchCtx !== null) delete launchCtx.ctx.env.HF_TOKEN;
  },
  openExternal: (url) => shell.openExternal(url),
  labels: (ids) => ids.map((id) => SERVICE_LABELS[id]).join(", "),
  log: appendSupervisorLog,
  onChange: () => statusWindow.refresh(),
});
```

(`trackRestart`·`isRecordingIn`은 함수 선언이라 호이스팅된다. `updateAttached`·`launchCtx`·`supervisor`는 호출 시점에 읽는다.)

(d) `ensureHfToken`·`changeHfToken`·`clearHfToken`·`tokenChangeNotice` 함수를 통째로 지운다. `handleServicesAction`은 다음으로 줄인다:

```ts
async function handleServicesAction(action: ServicesAction): Promise<void> {
  try {
    await restartFromStatusWindow(action.service);
  } catch (e) {
    actionNotice = `요청을 처리하지 못했어요 — ${reasonOf(e)}`;
    appendSupervisorLog(actionNotice);
  }
  statusWindow.refresh();
}
```

그 위 주석의 "(스펙 §6.4 토큰 설정 · §6.10 2층 "서비스 다시 시작")"은 "(§6.10 2층 "서비스 다시 시작")"으로.

(e) `servicesViewNow`(≈946행)에서 `tokenBusy,` 줄을 지운다.

(f) `createSupervisorFor`(≈1486행) 머리:

```ts
async function createSupervisorFor(mine: number): Promise<boolean> {
  const userData = app.getPath("userData");
  // 토큰은 **읽기만** 한다 — 없어도 기동한다 (스펙 2026-09-25 §5.1, Phase 4 §6.4의 첫 실행 게이트를 대체한다).
  // 이미 이번 실행에서 읽었거나 넣었으면(hfToken) 다시 읽지 않는다 — "다시 시도"가 방금 넣은 토큰을 잃지 않게.
  const boot =
    hfToken !== null
      ? { status: "present" as const, token: hfToken }
      : readBootToken({
          store: makeTokenStore(userData, safeStorage),
          fileExists: () => fs.existsSync(tokenFilePath(userData)),
          log: appendSupervisorLog,
        });
  hfToken = boot.token;
  tokenBridge.boot(boot.status, boot.token === null ? null : maskToken(boot.token));

  const cfg = loadConfig(userData);
```

기존의 `const token = await ensureHfToken(); if (token === null) return false;`와 뒤의 중복 `const userData = app.getPath("userData");`를 지운다. `launchEnv(cfg, await freePort(), token)`을 `launchEnv(cfg, await freePort(), hfToken)`으로.

(g) 다리 붙이기 — `reattachWindow`의

```ts
  if (attachedWindow === target) {
    updateAttached = target;
    updateScheduler?.onAttached();
  }
```

를

```ts
  if (attachedWindow === target) {
    updateAttached = target;
    updateScheduler?.onAttached();
    tokenBridge.attach(target);
  }
```

로. `createWindow()`(315행)에서 `created`를 만든 직후(다른 `created.webContents.on(...)` 배선 옆)에:

```ts
  // ⌘R 뒤의 새 문서는 새 __damwha_desktop을 갖는다 — 다시 붙여야 토큰 폼이 "확인 중"에 멈추지 않는다.
  // 첫 로드는 reattachWindow가 붙인다(그때는 아직 updateAttached가 서기 전이라 여기서는 건너뛴다).
  // 셸 화면(file://)으로 돌아간 창은 showShell이 updateAttached를 null로 내리므로 붙지 않는다.
  created.webContents.on("did-finish-load", () => {
    if (updateAttached === created && !created.isDestroyed()) tokenBridge.attach(created);
  });
```

(h) import 정리 — `verifyHfToken`·`makeTokenStore`·`tokenFilePath`·`maskToken`·`applyTokenChange`·`ownedByStatus`는 계속 쓴다. `TOKEN_SERVICES`·`dialog`·`CAUSES` 등 더는 안 쓰는 것이 생기면 `tsc`가 알려 준다 — 그때 지운다.

- [ ] **Step 4: 문서** — `desktop/CLAUDE.md`의 "지키는 것" 목록 맨 끝(`main.ts`는 electron을 값으로 import… 줄 앞)에 추가:

```markdown
- **HF 토큰은 기동을 막지 않는다** (스펙 2026-09-25, Phase 4 §6.4의 첫 실행 게이트를 대체). 기동은 `app/token-boot.ts`로 읽기만 하고, 없으면 `HF_TOKEN` 없이 띄운다 — `childEnv`는 셸에서 물려받은 `HF_TOKEN`도 버린다. 입력·교체·삭제는 담화 화면이 `window.__damwha_desktop.hfToken`(main이 묻는 다리, `windows/token-bridge.ts`)으로 한다. 상태 창은 토큰을 **표시만** 한다. `token.html`은 없다.
```

- [ ] **Step 5: 검증**

Run:
```bash
pnpm --filter damwha-desktop run lint
pnpm --filter damwha-desktop exec vitest run
```
Expected: lint 통과, 테스트 전부 PASS. 이어서 Task 4의 커밋, 그 다음 이 Task의 커밋.

- [ ] **Step 6: 커밋**

```bash
git add -A desktop/src/main.ts desktop/src/windows/shell-window.ts desktop/tests/windows/shell-html.test.ts desktop/CLAUDE.md
git commit -m "feat(desktop): 첫 실행 토큰 게이트를 걷고 담화 화면의 토큰 다리를 배선한다

token.html·token-window·token-gate를 지운다. 기동은 Keychain을 읽기만 하고, 토큰은
token-bridge가 담화 화면과 주고받는다. ⌘R 뒤에도 다시 붙는다.

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

(`git rm`으로 지운 다섯 파일은 Step 2에서 이미 인덱스에 올라 있다.)

---

### Task 6: fe 다리 스토어와 `useHfToken`

**Files:**
- Create: `fe/src/features/hf-token/model/types.ts`
- Create: `fe/src/features/hf-token/lib/bridge-store.ts`
- Create: `fe/src/features/hf-token/lib/use-hf-token.ts`
- Modify: `fe/src/features/meeting/lib/desktop-bridge.ts`
- Test: `fe/src/features/hf-token/lib/bridge-store.test.ts`, `fe/src/features/hf-token/lib/use-hf-token.test.tsx`, `fe/src/features/meeting/lib/desktop-bridge.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // model/types.ts — desktop/src/windows/token-bridge.ts와 같은 모양(손으로 맞춘 사본)
  export type HfTokenStatus = "present" | "absent" | "unreadable" | "unavailable";
  export interface HfTokenMessage { tone: "info" | "warn" | "error"; text: string }
  export interface HfTokenState { status; masked; account; onboardingDismissed; busy; message }
  export type HfTokenAction = …;  // 4가지
  export type HfTokenView = { kind: "web" } | { kind: "pending" } | { kind: "ready"; state: HfTokenState };
  // lib/bridge-store.ts
  export interface HfTokenBridge { show(state: HfTokenState): void; next(): Promise<HfTokenAction> }
  export interface HfTokenStore { bridge: HfTokenBridge; send(a: HfTokenAction): void; subscribe(l: () => void): () => void; getSnapshot(): HfTokenState | null }
  export function createHfTokenStore(): HfTokenStore;
  export const hfTokenStore: HfTokenStore;
  // lib/use-hf-token.ts
  export function detectDesktop(ua?: string): boolean;
  export function useHfToken(store?: HfTokenStore, desktop?: boolean): HfTokenView;
  export function canDiarize(view: HfTokenView): boolean;
  export function sendHfTokenAction(a: HfTokenAction): void;  // hfTokenStore.send
  ```

- [ ] **Step 1: 실패하는 테스트**

```ts
// fe/src/features/hf-token/lib/bridge-store.test.ts
import { describe, expect, it, vi } from "vitest";
import { createHfTokenStore } from "./bridge-store";
import type { HfTokenState } from "../model/types";

const state: HfTokenState = {
  status: "absent",
  masked: null,
  account: null,
  onboardingDismissed: false,
  busy: false,
  message: null,
};

describe("createHfTokenStore", () => {
  it("show replaces the snapshot and notifies subscribers", () => {
    const s = createHfTokenStore();
    const l = vi.fn();
    s.subscribe(l);
    expect(s.getSnapshot()).toBeNull();
    s.bridge.show(state);
    expect(s.getSnapshot()).toEqual(state);
    expect(l).toHaveBeenCalledOnce();
  });

  it("next resolves with an action sent before or after it is asked", async () => {
    const s = createHfTokenStore();
    s.send({ kind: "clear" });
    await expect(s.bridge.next()).resolves.toEqual({ kind: "clear" });
    const asked = s.bridge.next();
    s.send({ kind: "dismissOnboarding" });
    await expect(asked).resolves.toEqual({ kind: "dismissOnboarding" });
  });

  it("keeps order when several actions queue up", async () => {
    const s = createHfTokenStore();
    s.send({ kind: "open", link: "accept" });
    s.send({ kind: "open", link: "tokens" });
    await expect(s.bridge.next()).resolves.toEqual({ kind: "open", link: "accept" });
    await expect(s.bridge.next()).resolves.toEqual({ kind: "open", link: "tokens" });
  });
});
```

```tsx
// fe/src/features/hf-token/lib/use-hf-token.test.tsx
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createHfTokenStore } from "./bridge-store";
import { canDiarize, detectDesktop, useHfToken } from "./use-hf-token";
import type { HfTokenState } from "../model/types";

const base: HfTokenState = {
  status: "absent",
  masked: null,
  account: null,
  onboardingDismissed: false,
  busy: false,
  message: null,
};

describe("useHfToken", () => {
  it("is web outside Electron — every gate passes", () => {
    const { result } = renderHook(() => useHfToken(createHfTokenStore(), false));
    expect(result.current).toEqual({ kind: "web" });
    expect(canDiarize(result.current)).toBe(true);
  });

  it("is pending in Electron until main shows a state — gates stay shut", () => {
    const { result } = renderHook(() => useHfToken(createHfTokenStore(), true));
    expect(result.current).toEqual({ kind: "pending" });
    expect(canDiarize(result.current)).toBe(false);
  });

  it("follows main's state; only present opens the gate", () => {
    const store = createHfTokenStore();
    const { result } = renderHook(() => useHfToken(store, true));
    act(() => store.bridge.show(base));
    expect(canDiarize(result.current)).toBe(false);
    act(() => store.bridge.show({ ...base, status: "present", masked: "hf_****…****4567" }));
    expect(result.current).toEqual({ kind: "ready", state: { ...base, status: "present", masked: "hf_****…****4567" } });
    expect(canDiarize(result.current)).toBe(true);
    for (const status of ["unreadable", "unavailable"] as const) {
      act(() => store.bridge.show({ ...base, status }));
      expect(canDiarize(result.current)).toBe(false);
    }
  });
});

describe("detectDesktop", () => {
  it("reads Electron from the user agent", () => {
    expect(detectDesktop("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Electron/44.0.0 Safari/537.36")).toBe(true);
    expect(detectDesktop("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Safari/537.36")).toBe(false);
  });
});
```

`desktop-bridge.test.ts`의 `Bridge` 타입에 `hfToken?: unknown;`을 더하고 테스트 하나를 추가한다:

```ts
  it("carries the HF token bridge main asks (스펙 2026-09-25 §4)", () => {
    const w = {} as Window & { __damwha_desktop?: { hfToken?: { show: unknown; next: unknown } } };
    installDesktopBridge(w);
    expect(typeof w.__damwha_desktop!.hfToken!.show).toBe("function");
    expect(typeof w.__damwha_desktop!.hfToken!.next).toBe("function");
  });
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-fe exec vitest run src/features/hf-token src/features/meeting/lib/desktop-bridge.test.ts`
Expected: FAIL — 모듈 없음 / `hfToken` undefined

- [ ] **Step 3: 구현**

```ts
// fe/src/features/hf-token/model/types.ts
/**
 * 데스크톱 main과 주고받는 HF 토큰 모양 (스펙 2026-09-25 §4.1). 원본은 desktop/src/windows/token-bridge.ts다 —
 * 두 패키지는 import를 나눌 수 없어 손으로 맞춘다. 한쪽을 바꾸면 다른 쪽도 바꾼다.
 */
export type HfTokenStatus = "present" | "absent" | "unreadable" | "unavailable";

export interface HfTokenMessage {
  tone: "info" | "warn" | "error";
  text: string;
}

export interface HfTokenState {
  status: HfTokenStatus;
  masked: string | null;
  account: string | null;
  onboardingDismissed: boolean;
  busy: boolean;
  message: HfTokenMessage | null;
}

export type HfTokenAction =
  | { kind: "submit"; token: string }
  | { kind: "clear" }
  | { kind: "dismissOnboarding" }
  | { kind: "open"; link: "accept" | "tokens" };

/** web = 데스크톱 다리 없음(게이트 통과) · pending = Electron인데 main의 첫 상태를 아직 못 받음 · ready. */
export type HfTokenView =
  | { kind: "web" }
  | { kind: "pending" }
  | { kind: "ready"; state: HfTokenState };
```

```ts
// fe/src/features/hf-token/lib/bridge-store.ts
import type { HfTokenAction, HfTokenState } from "../model/types";

/** main이 부르는 두 함수. 렌더러가 먼저 여는 채널이 아니다 — main이 묻고 이것이 답한다(스펙 §6.11). */
export interface HfTokenBridge {
  show(state: HfTokenState): void;
  next(): Promise<HfTokenAction>;
}

export interface HfTokenStore {
  bridge: HfTokenBridge;
  /** 화면의 동작을 main에게 — main이 다음에 next()를 물을 때 받는다. */
  send(action: HfTokenAction): void;
  subscribe(listener: () => void): () => void;
  /** null = main이 아직 show()를 부르지 않았다. */
  getSnapshot(): HfTokenState | null;
}

export function createHfTokenStore(): HfTokenStore {
  let state: HfTokenState | null = null;
  const listeners = new Set<() => void>();
  const queued: HfTokenAction[] = [];
  const waiting: Array<(action: HfTokenAction) => void> = [];

  return {
    bridge: {
      show(next) {
        state = next;
        for (const l of listeners) l();
      },
      next() {
        const action = queued.shift();
        if (action !== undefined) return Promise.resolve(action);
        return new Promise((resolve) => waiting.push(resolve));
      },
    },
    send(action) {
      const resolve = waiting.shift();
      if (resolve !== undefined) resolve(action);
      else queued.push(action);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
  };
}

/** 앱 하나에 하나. installDesktopBridge가 이 bridge를 window에 건다. */
export const hfTokenStore = createHfTokenStore();
```

```ts
// fe/src/features/hf-token/lib/use-hf-token.ts
import * as React from "react";
import { hfTokenStore, type HfTokenStore } from "./bridge-store";
import type { HfTokenAction, HfTokenView } from "../model/types";

/** Electron 렌더러인가. 웹(개발용 브라우저)에서는 토큰을 be/worker/.env가 맡으므로 게이트가 없다(스펙 §3.6). */
export function detectDesktop(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /\bElectron\//.test(ua);
}

const DESKTOP = detectDesktop();

export function useHfToken(store: HfTokenStore = hfTokenStore, desktop: boolean = DESKTOP): HfTokenView {
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (!desktop) return { kind: "web" };
  if (state === null) return { kind: "pending" };
  return { kind: "ready", state };
}

/** 화자 분리가 필요한 동작을 열어도 되는가 (스펙 §3.2). */
export function canDiarize(view: HfTokenView): boolean {
  if (view.kind === "web") return true;
  if (view.kind === "pending") return false;
  return view.state.status === "present";
}

export function sendHfTokenAction(action: HfTokenAction, store: HfTokenStore = hfTokenStore): void {
  store.send(action);
}
```

`desktop-bridge.ts`:

```ts
import { hasLiveCapture, stopActiveLiveCapture } from "./live-session";
import { hfTokenStore, type HfTokenBridge } from "@/features/hf-token/lib/bridge-store";

export interface DesktopBridge {
  isRecording(): boolean;
  stopLiveRecording(): Promise<{ stopped: boolean; reason?: string }>;
  /** HF 토큰 (스펙 2026-09-25 §4). main의 token-bridge.ts가 이 이름으로 부른다 — 이름을 바꾸면 조용히 끊긴다. */
  hfToken: HfTokenBridge;
}
```

`installDesktopBridge`의 객체에 `hfToken: hfTokenStore.bridge,`를 더한다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter damwha-fe exec vitest run src/features/hf-token src/features/meeting/lib/desktop-bridge.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add fe/src/features/hf-token fe/src/features/meeting/lib/desktop-bridge.ts fe/src/features/meeting/lib/desktop-bridge.test.ts
git commit -m "feat(fe): 데스크톱 main과 HF 토큰을 주고받는 다리 스토어와 useHfToken을 둔다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 7: 입력 폼·토큰 다이얼로그·게이트, 그리고 새 회의·재처리 배선

**Files:**
- Create: `fe/src/features/hf-token/ui/hf-token-form.tsx`
- Create: `fe/src/features/hf-token/ui/hf-token-gate.tsx`
- Modify: `fe/src/app/app-shell.tsx`, `fe/src/features/meeting/ui/left-nav.tsx:152`, `fe/src/features/meeting/ui/transcript-pane.tsx:554`
- Test: `fe/src/features/hf-token/ui/hf-token-form.test.tsx`, `fe/src/features/hf-token/ui/hf-token-gate.test.tsx`

**Interfaces:**
- Consumes: Task 6 전부.
- Produces:
  ```ts
  export function HfTokenForm(props: { state: HfTokenState; send?: (a: HfTokenAction) => void; submitLabel?: string }): JSX.Element;
  export function HfTokenGateProvider(props: { children: React.ReactNode; view?: HfTokenView; send?: (a: HfTokenAction) => void }): JSX.Element;
  export function useDiarizationGate(): { locked: boolean; run(open: () => void): void };
  export function useHfTokenDialog(): { open(): void };
  ```
  Provider 밖에서 `useDiarizationGate()`는 통과(`run`이 바로 부른다) — 기존 단위 테스트가 Provider 없이 LeftNav·TranscriptPane을 그린다. 제품 경로는 AppShell이 Provider를 둔다.

- [ ] **Step 1: 실패하는 테스트**

```tsx
// fe/src/features/hf-token/ui/hf-token-form.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HfTokenForm } from "./hf-token-form";
import type { HfTokenState } from "../model/types";

afterEach(cleanup);

const TOKEN = "hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567";
const base: HfTokenState = { status: "absent", masked: null, account: null, onboardingDismissed: false, busy: false, message: null };

test("submits the typed token and the two HF links as keys", () => {
  const send = vi.fn();
  render(<HfTokenForm state={base} send={send} />);
  fireEvent.change(screen.getByLabelText("허깅페이스 토큰"), { target: { value: TOKEN } });
  fireEvent.click(screen.getByRole("button", { name: "확인" }));
  expect(send).toHaveBeenCalledWith({ kind: "submit", token: TOKEN });
  fireEvent.click(screen.getByRole("button", { name: "사용 조건 페이지 열기" }));
  fireEvent.click(screen.getByRole("button", { name: "토큰 만들기 페이지 열기" }));
  expect(send).toHaveBeenCalledWith({ kind: "open", link: "accept" });
  expect(send).toHaveBeenCalledWith({ kind: "open", link: "tokens" });
});

test("keeps the typed value after an error so one character can be fixed (Review Focus 3)", () => {
  const send = vi.fn();
  const { rerender } = render(<HfTokenForm state={base} send={send} />);
  const input = screen.getByLabelText("허깅페이스 토큰") as HTMLInputElement;
  fireEvent.change(input, { target: { value: TOKEN } });
  fireEvent.click(screen.getByRole("button", { name: "확인" }));
  rerender(<HfTokenForm state={{ ...base, message: { tone: "error", text: "허깅페이스 토큰이 유효하지 않아요." } }} send={send} />);
  expect(input.value).toBe(TOKEN);
  expect(screen.getByRole("alert")).toHaveTextContent("유효하지 않아요");
});

test("locks while busy and does not submit an empty value", () => {
  const send = vi.fn();
  const { rerender } = render(<HfTokenForm state={base} send={send} />);
  expect(screen.getByRole("button", { name: "확인" })).toBeDisabled();
  rerender(<HfTokenForm state={{ ...base, busy: true }} send={send} />);
  expect(screen.getByLabelText("허깅페이스 토큰")).toBeDisabled();
  expect(send).not.toHaveBeenCalled();
});

test("renders HF's message as text, never as markup", () => {
  render(<HfTokenForm state={{ ...base, message: { tone: "error", text: "<img src=x onerror=alert(1)>" } }} send={vi.fn()} />);
  expect(screen.getByRole("alert").textContent).toBe("<img src=x onerror=alert(1)>");
  expect(document.querySelector("img")).toBeNull();
});

test("shows the keychain guidance instead of an input when unavailable", () => {
  render(<HfTokenForm state={{ ...base, status: "unavailable" }} send={vi.fn()} />);
  expect(screen.queryByLabelText("허깅페이스 토큰")).toBeNull();
  expect(screen.getByText(/키체인/)).toBeInTheDocument();
});
```

```tsx
// fe/src/features/hf-token/ui/hf-token-gate.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HfTokenGateProvider, useDiarizationGate } from "./hf-token-gate";
import type { HfTokenState, HfTokenView } from "../model/types";

afterEach(cleanup);

const base: HfTokenState = { status: "absent", masked: null, account: null, onboardingDismissed: false, busy: false, message: null };

function Probe({ onOpen }: { onOpen: () => void }) {
  const gate = useDiarizationGate();
  return (
    <button type="button" disabled={gate.locked} onClick={() => gate.run(onOpen)}>
      새 회의
    </button>
  );
}

function renderGate(view: HfTokenView, onOpen = vi.fn()) {
  const send = vi.fn();
  const utils = render(
    <HfTokenGateProvider view={view} send={send}>
      <Probe onOpen={onOpen} />
    </HfTokenGateProvider>,
  );
  return { ...utils, send, onOpen };
}

test("web: passes straight through", () => {
  const { onOpen } = renderGate({ kind: "web" });
  fireEvent.click(screen.getByRole("button", { name: "새 회의" }));
  expect(onOpen).toHaveBeenCalledOnce();
});

test("present: passes straight through", () => {
  const { onOpen } = renderGate({ kind: "ready", state: { ...base, status: "present", masked: "hf_****…****4567" } });
  fireEvent.click(screen.getByRole("button", { name: "새 회의" }));
  expect(onOpen).toHaveBeenCalledOnce();
});

test("absent: opens the token dialog instead of the action", () => {
  const { onOpen } = renderGate({ kind: "ready", state: base });
  fireEvent.click(screen.getByRole("button", { name: "새 회의" }));
  expect(onOpen).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "허깅페이스 토큰이 필요해요" })).toBeInTheDocument();
});

test("pending: locked and does nothing", () => {
  const { onOpen } = renderGate({ kind: "pending" });
  expect(screen.getByRole("button", { name: "새 회의" })).toBeDisabled();
  expect(onOpen).not.toHaveBeenCalled();
});

test("the dialog closes by itself once the token is saved — the person clicks the action again", () => {
  const onOpen = vi.fn();
  const send = vi.fn();
  const { rerender } = render(
    <HfTokenGateProvider view={{ kind: "ready", state: base }} send={send}>
      <Probe onOpen={onOpen} />
    </HfTokenGateProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "새 회의" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  rerender(
    <HfTokenGateProvider view={{ kind: "ready", state: { ...base, status: "present", masked: "hf_****…****4567" } }} send={send}>
      <Probe onOpen={onOpen} />
    </HfTokenGateProvider>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onOpen).not.toHaveBeenCalled();
});

test("outside the provider the gate passes (unit tests render nav pieces alone)", () => {
  const onOpen = vi.fn();
  render(<Probe onOpen={onOpen} />);
  fireEvent.click(screen.getByRole("button", { name: "새 회의" }));
  expect(onOpen).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-fe exec vitest run src/features/hf-token/ui`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

```tsx
// fe/src/features/hf-token/ui/hf-token-form.tsx
import * as React from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import { sendHfTokenAction } from "../lib/use-hf-token";
import type { HfTokenAction, HfTokenState } from "../model/types";

const UNAVAILABLE_TEXT =
  "macOS 키체인을 쓸 수 없어 토큰을 안전하게 보관할 수 없어요. 키체인 접근 앱에서 로그인 키체인의 잠금을 해제한 뒤 담화를 다시 켜 주세요.";

const TONE_CLASS: Record<"info" | "warn" | "error", string> = {
  info: "text-[color:var(--text-secondary)]",
  warn: "text-[color:var(--amber-text)]",
  error: "text-[color:var(--red-text)]",
};

/**
 * HF 토큰 입력 폼 — 온보딩·설정·토큰 다이얼로그가 같은 것을 쓴다 (스펙 2026-09-25 §4.3). 확인·저장·재시작은 main이
 * 하고, 폼은 입력값을 보내고 main의 상태(busy·message)를 그릴 뿐이다. 확인에 실패해도 입력값을 지우지 않는다 —
 * 한 글자만 고쳐 다시 보낼 수 있어야 한다.
 */
export function HfTokenForm({
  state,
  send = sendHfTokenAction,
  submitLabel = "확인",
}: {
  state: HfTokenState;
  send?: (action: HfTokenAction) => void;
  submitLabel?: string;
}) {
  const [value, setValue] = React.useState("");

  if (state.status === "unavailable") {
    return <p className="text-sm text-[color:var(--text-secondary)]">{UNAVAILABLE_TEXT}</p>;
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (state.busy || value.trim() === "") return;
    send({ kind: "submit", token: value });
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <ol className="flex flex-col gap-2 text-sm">
        <li className="flex items-center justify-between gap-3">
          <span>1. 화자 분리 모델의 사용 조건에 동의하기</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => send({ kind: "open", link: "accept" })}>
            사용 조건 페이지 열기
          </Button>
        </li>
        <li className="flex items-center justify-between gap-3">
          <span>2. 같은 계정에서 Read 권한 토큰 만들기</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => send({ kind: "open", link: "tokens" })}>
            토큰 만들기 페이지 열기
          </Button>
        </li>
      </ol>
      <div className="flex gap-2">
        <Input
          aria-label="허깅페이스 토큰"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="hf_…"
          value={value}
          disabled={state.busy}
          onChange={(e) => setValue(e.target.value)}
          containerClassName="flex-1"
        />
        <Button type="submit" disabled={state.busy || value.trim() === ""} loading={state.busy}>
          {submitLabel}
        </Button>
      </div>
      {state.message !== null ? (
        <p
          role={state.message.tone === "error" ? "alert" : "status"}
          className={`text-sm whitespace-pre-wrap ${TONE_CLASS[state.message.tone]}`}
        >
          {state.message.text}
        </p>
      ) : null}
      <p className="text-xs text-[color:var(--text-muted)]">
        확인을 누르면 huggingface.co에 토큰이 맞는지 물어본 뒤, 이 맥의 키체인으로 암호화해 보관해요.
      </p>
    </form>
  );
}
```

(`Button`의 `loading` prop이 없으면 빼고, `Input`의 `containerClassName`이 없으면 `className`으로. `button.tsx`·`input.tsx`를 열어 확인한다 — reprocess-dialog가 `loading`을 쓰는지 grep: `grep -rn "loading=" fe/src/shared/ui/button.tsx`.)

```tsx
// fe/src/features/hf-token/ui/hf-token-gate.tsx
import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { canDiarize, sendHfTokenAction, useHfToken } from "../lib/use-hf-token";
import type { HfTokenAction, HfTokenView } from "../model/types";
import { HfTokenForm } from "./hf-token-form";

interface GateContext {
  view: HfTokenView;
  send: (action: HfTokenAction) => void;
  openDialog(): void;
}

const Ctx = React.createContext<GateContext | null>(null);

/**
 * 화자 분리가 필요한 동작의 게이트 (스펙 2026-09-25 §3.2). AppShell이 한 번 둔다. 토큰이 없으면 동작 대신 토큰
 * 다이얼로그를 띄우고, 저장되면 다이얼로그가 스스로 닫힌다 — 원래 동작은 사람이 다시 누른다(파일 선택처럼
 * 다시 확인해야 하는 단계가 있다).
 */
export function HfTokenGateProvider({
  children,
  view: fixedView,
  send = sendHfTokenAction,
}: {
  children: React.ReactNode;
  /** 테스트용. 제품 경로는 useHfToken()을 쓴다. */
  view?: HfTokenView;
  send?: (action: HfTokenAction) => void;
}) {
  const live = useHfToken();
  const view = fixedView ?? live;
  const [open, setOpen] = React.useState(false);

  // 저장에 성공하면 닫는다.
  const allowed = canDiarize(view);
  React.useEffect(() => {
    if (allowed) setOpen(false);
  }, [allowed]);

  const value = React.useMemo<GateContext>(() => ({ view, send, openDialog: () => setOpen(true) }), [view, send]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {view.kind === "ready" ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>허깅페이스 토큰이 필요해요</DialogTitle>
              <DialogDescription>
                화자 분리 모델을 받으려면 허깅페이스 토큰이 있어야 해요. 넣은 뒤 하던 동작을 다시 눌러 주세요.
              </DialogDescription>
            </DialogHeader>
            <HfTokenForm state={view.state} send={send} />
          </DialogContent>
        </Dialog>
      ) : null}
    </Ctx.Provider>
  );
}

export function useDiarizationGate(): { locked: boolean; run(open: () => void): void } {
  const ctx = React.useContext(Ctx);
  if (ctx === null) return { locked: false, run: (open) => open() };
  return {
    locked: ctx.view.kind === "pending",
    run(open) {
      if (canDiarize(ctx.view)) open();
      else if (ctx.view.kind === "ready") ctx.openDialog();
    },
  };
}

/** 실패 안내의 "토큰 설정 열기"가 쓴다. Provider 밖(웹 단위 테스트)에서는 아무 일도 하지 않는다. */
export function useHfTokenDialog(): { available: boolean; open(): void } {
  const ctx = React.useContext(Ctx);
  if (ctx === null || ctx.view.kind !== "ready") return { available: false, open: () => undefined };
  return { available: true, open: ctx.openDialog };
}
```

배선:

`app-shell.tsx` — `AppShell`이 돌려주는 최상위 JSX를 `<HfTokenGateProvider>…</HfTokenGateProvider>`로 감싼다(import `HfTokenGateProvider` from `@/features/hf-token/ui/hf-token-gate`).

`left-nav.tsx:152`:

```tsx
        <NewMeetingItem onClick={() => gate.run(() => setNewMeetingOpen(true))} disabled={gate.locked} />
```

`LeftNav` 본문 위쪽(`const [newMeetingOpen, …]` 옆)에 `const gate = useDiarizationGate();`. `NewMeetingItem`에 `disabled` prop을 더한다:

```tsx
function NewMeetingItem({ onClick, disabled }: { onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      data-tour="new-meeting"
      onClick={onClick}
      disabled={disabled}
      className="… disabled:cursor-default disabled:opacity-60"
```

(기존 className 끝에 `disabled:cursor-default disabled:opacity-60`만 덧붙인다.)

`transcript-pane.tsx:554`:

```tsx
              onClick={() => gate.run(() => setReprocessOpen(true))}
              disabled={gate.locked}
```

`TranscriptPane` 본문에 `const gate = useDiarizationGate();`(`reprocessOpen` state 옆). `IconButton`이 `disabled`를 받는지 확인한다(`grep -n "disabled" fe/src/shared/ui/icon-button.tsx`). 안 받으면 `disabled` 줄은 빼고 `run`만 쓴다.

- [ ] **Step 4: 통과 확인**

Run:
```bash
pnpm --filter damwha-fe exec vitest run src/features/hf-token src/features/meeting src/app
pnpm --filter damwha-fe run lint
```
Expected: PASS. 기존 LeftNav·TranscriptPane 테스트도 통과(Provider 밖이라 통과 게이트).

- [ ] **Step 5: 변이 확인** — `canDiarize`의 `return view.state.status === "present";`를 `return true;`로 바꾸면 gate 테스트 "absent: opens the token dialog"가 실패하는지 보고 되돌린다.

- [ ] **Step 6: 커밋**

```bash
git add fe/src/features/hf-token/ui fe/src/app/app-shell.tsx fe/src/features/meeting/ui/left-nav.tsx fe/src/features/meeting/ui/transcript-pane.tsx
git commit -m "feat(fe): 토큰이 없으면 새 회의·재처리 대신 토큰 다이얼로그를 띄운다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 8: 첫 실행 온보딩과 설정 섹션

**Files:**
- Create: `fe/src/features/hf-token/ui/hf-token-onboarding.tsx`
- Create: `fe/src/features/hf-token/ui/hf-token-settings-section.tsx`
- Modify: `fe/src/app/app-shell.tsx` (Provider 안에 `<HfTokenOnboarding />`), `fe/src/pages/settings.tsx` (`<ProcessingSettingsForm />` 아래 `<HfTokenSettingsSection />`)
- Test: `fe/src/features/hf-token/ui/hf-token-onboarding.test.tsx`, `fe/src/features/hf-token/ui/hf-token-settings-section.test.tsx`

**Interfaces:**
- Consumes: Task 6·7.
- Produces: `HfTokenOnboarding({ view?, send? })`, `HfTokenSettingsSection({ view?, send? })`.

- [ ] **Step 1: 실패하는 테스트**

```tsx
// fe/src/features/hf-token/ui/hf-token-onboarding.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HfTokenOnboarding } from "./hf-token-onboarding";
import type { HfTokenState } from "../model/types";

afterEach(cleanup);

const base: HfTokenState = { status: "absent", masked: null, account: null, onboardingDismissed: false, busy: false, message: null };
const ready = (state: HfTokenState) => ({ kind: "ready" as const, state });

test("shows on a first run without a token", () => {
  render(<HfTokenOnboarding view={ready(base)} send={vi.fn()} />);
  expect(screen.getByRole("dialog", { name: "화자 분리를 쓰려면 토큰이 필요해요" })).toBeInTheDocument();
});

test("shows for an unreadable token with its own wording", () => {
  render(<HfTokenOnboarding view={ready({ ...base, status: "unreadable" })} send={vi.fn()} />);
  expect(screen.getByText(/토큰을 읽을 수 없어요/)).toBeInTheDocument();
});

test("does not show for present, unavailable, web or pending (Review Focus 4)", () => {
  for (const view of [
    ready({ ...base, status: "present", masked: "hf_****…****4567" }),
    ready({ ...base, status: "unavailable" }),
    { kind: "web" as const },
    { kind: "pending" as const },
  ]) {
    const { unmount } = render(<HfTokenOnboarding view={view} send={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();
  }
});

test("'나중에 하기' tells main and hides at once", () => {
  const send = vi.fn();
  render(<HfTokenOnboarding view={ready(base)} send={send} />);
  fireEvent.click(screen.getByRole("button", { name: "나중에 하기" }));
  expect(send).toHaveBeenCalledWith({ kind: "dismissOnboarding" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a new run (onboardingDismissed false again) shows it again", () => {
  const { unmount } = render(<HfTokenOnboarding view={ready({ ...base, onboardingDismissed: true })} send={vi.fn()} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  unmount();
  render(<HfTokenOnboarding view={ready(base)} send={vi.fn()} />);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});
```

```tsx
// fe/src/features/hf-token/ui/hf-token-settings-section.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HfTokenSettingsSection } from "./hf-token-settings-section";
import type { HfTokenState } from "../model/types";

afterEach(cleanup);

const base: HfTokenState = { status: "absent", masked: null, account: null, onboardingDismissed: false, busy: false, message: null };
const ready = (state: HfTokenState) => ({ kind: "ready" as const, state });

test("hidden on the web", () => {
  const { container } = render(<HfTokenSettingsSection view={{ kind: "web" }} send={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});

test("present: masked value, account, and delete only after confirmation", () => {
  const send = vi.fn();
  render(
    <HfTokenSettingsSection
      view={ready({ ...base, status: "present", masked: "hf_****…****4567", account: "jason" })}
      send={send}
    />,
  );
  expect(screen.getByText("hf_****…****4567")).toBeInTheDocument();
  expect(screen.getByText(/jason/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "토큰 지우기" }));
  expect(send).not.toHaveBeenCalledWith({ kind: "clear" });
  fireEvent.click(screen.getByRole("button", { name: "지우기" }));
  expect(send).toHaveBeenCalledWith({ kind: "clear" });
});

test("absent and unreadable show the input; unavailable shows the keychain guidance", () => {
  const { unmount } = render(<HfTokenSettingsSection view={ready(base)} send={vi.fn()} />);
  expect(screen.getByLabelText("허깅페이스 토큰")).toBeInTheDocument();
  unmount();
  const u = render(<HfTokenSettingsSection view={ready({ ...base, status: "unreadable" })} send={vi.fn()} />);
  expect(screen.getByText(/토큰을 읽을 수 없어요/)).toBeInTheDocument();
  u.unmount();
  render(<HfTokenSettingsSection view={ready({ ...base, status: "unavailable" })} send={vi.fn()} />);
  expect(screen.queryByLabelText("허깅페이스 토큰")).toBeNull();
  expect(screen.getByText(/키체인/)).toBeInTheDocument();
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-fe exec vitest run src/features/hf-token/ui`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

```tsx
// fe/src/features/hf-token/ui/hf-token-onboarding.tsx
import * as React from "react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { sendHfTokenAction, useHfToken } from "../lib/use-hf-token";
import type { HfTokenAction, HfTokenView } from "../model/types";
import { HfTokenForm } from "./hf-token-form";

/**
 * 첫 실행 온보딩 (스펙 2026-09-25 §3.3). 토큰이 없거나 못 읽었고, 이번 실행에서 넘기지 않았으면 뜬다.
 * "나중에 하기"는 main 메모리에 남는다 — 앱을 다시 켜면 다시 뜬다. 저장에 성공하면(present) 스스로 사라진다.
 */
export function HfTokenOnboarding({
  view: fixedView,
  send = sendHfTokenAction,
}: {
  view?: HfTokenView;
  send?: (action: HfTokenAction) => void;
}) {
  const live = useHfToken();
  const view = fixedView ?? live;
  // main의 답(onboardingDismissed)이 오기 전에도 바로 닫히게 한다.
  const [closed, setClosed] = React.useState(false);

  if (view.kind !== "ready") return null;
  const { state } = view;
  const wanted =
    (state.status === "absent" || state.status === "unreadable") && !state.onboardingDismissed && !closed;

  const later = () => {
    setClosed(true);
    send({ kind: "dismissOnboarding" });
  };

  return (
    <Dialog open={wanted} onOpenChange={(open) => (open ? undefined : later())}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>화자 분리를 쓰려면 토큰이 필요해요</DialogTitle>
          <DialogDescription>
            {state.status === "unreadable"
              ? "저장된 토큰을 읽을 수 없어요 — 다시 입력해 주세요."
              : "담화는 누가 말했는지 나누는 모델을 허깅페이스에서 받아요. 이 모델은 사용 조건에 동의한 계정의 토큰으로만 받을 수 있어요. 토큰 없이도 회의 보기·검색은 쓸 수 있어요."}
          </DialogDescription>
        </DialogHeader>
        <HfTokenForm state={state} send={send} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={later}>
            나중에 하기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

```tsx
// fe/src/features/hf-token/ui/hf-token-settings-section.tsx
import * as React from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { sendHfTokenAction, useHfToken } from "../lib/use-hf-token";
import type { HfTokenAction, HfTokenView } from "../model/types";
import { HfTokenForm } from "./hf-token-form";

const CLEAR_DETAIL =
  "지금 도는 작업 처리기는 옛 토큰으로 계속 돌아요. 하지만 다시 시작하면 토큰 없이 떠서 화자 분리를 하지 못해요. 새 회의와 재처리도 다시 막혀요.";

/** 설정의 "허깅페이스 토큰" 섹션 (스펙 2026-09-25 §3.4). 웹에서는 그리지 않는다. */
export function HfTokenSettingsSection({
  view: fixedView,
  send = sendHfTokenAction,
}: {
  view?: HfTokenView;
  send?: (action: HfTokenAction) => void;
}) {
  const live = useHfToken();
  const view = fixedView ?? live;
  const [confirming, setConfirming] = React.useState(false);

  if (view.kind === "web") return null;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-[color:var(--text-secondary)]">허깅페이스 토큰</span>
        <span className="text-sm text-[color:var(--text-muted)]">화자 분리 모델을 받는 데 써요.</span>
      </div>
      {view.kind === "pending" ? (
        <span role="status" className="text-sm text-[color:var(--text-muted)]">
          확인하는 중…
        </span>
      ) : (
        <>
          {view.state.status === "present" ? (
            <div className="flex items-center justify-between gap-3">
              <span className="flex flex-col">
                <span className="font-mono text-sm">{view.state.masked}</span>
                {view.state.account !== null ? (
                  <span className="text-xs text-[color:var(--text-muted)]">계정 {view.state.account}</span>
                ) : null}
              </span>
              <Button type="button" variant="secondary" size="sm" onClick={() => setConfirming(true)}>
                토큰 지우기
              </Button>
            </div>
          ) : view.state.status === "unreadable" ? (
            <p className="text-sm text-[color:var(--amber-text)]">토큰을 읽을 수 없어요 — 다시 입력해 주세요.</p>
          ) : null}
          <HfTokenForm
            state={view.state}
            send={send}
            submitLabel={view.state.status === "present" ? "바꾸기" : "확인"}
          />
          <Dialog open={confirming} onOpenChange={setConfirming}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>저장된 허깅페이스 토큰을 지울까요?</DialogTitle>
                <DialogDescription>{CLEAR_DETAIL}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="secondary">
                    취소
                  </Button>
                </DialogClose>
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => {
                    setConfirming(false);
                    send({ kind: "clear" });
                  }}
                >
                  지우기
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </Card>
  );
}
```

배선: `app-shell.tsx`에서 `HfTokenGateProvider` 안쪽 맨 끝에 `<HfTokenOnboarding />`. `settings.tsx`에서 `<ProcessingSettingsForm />` 다음 줄에 `<HfTokenSettingsSection />`.

- [ ] **Step 4: 통과 확인**

Run:
```bash
pnpm --filter damwha-fe exec vitest run src/features/hf-token src/pages src/app
pnpm --filter damwha-fe run lint
```
Expected: PASS

- [ ] **Step 5: 변이 확인** — 온보딩의 `!state.onboardingDismissed`를 지우면 "a new run…" 테스트가 실패하는지 보고 되돌린다.

- [ ] **Step 6: 커밋**

```bash
git add fe/src/features/hf-token/ui fe/src/app/app-shell.tsx fe/src/pages/settings.tsx
git commit -m "feat(fe): 첫 실행 온보딩과 설정의 허깅페이스 토큰 섹션을 둔다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 9: `hf_token_invalid`·`hf_gate_not_accepted`로 실패한 회의의 안내

**Files:**
- Create: `fe/src/features/hf-token/lib/failure-copy.ts`
- Create: `fe/src/features/hf-token/ui/hf-failure-action.tsx`
- Modify: `fe/src/pages/meeting.tsx` (`ProcessingBanner`의 failed 분기, ≈92–120행)
- Test: `fe/src/features/hf-token/lib/failure-copy.test.ts`, `fe/src/features/hf-token/ui/hf-failure-action.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface HfFailureCopy { title: string; body: string; action: "token" | "accept" }
  export function hfFailureCopy(code: string | undefined): HfFailureCopy | null;
  export function HfFailureAction(props: { action: "token" | "accept"; send?: (a: HfTokenAction) => void }): JSX.Element | null;
  ```

- [ ] **Step 1: 실패하는 테스트**

```ts
// fe/src/features/hf-token/lib/failure-copy.test.ts
import { expect, test } from "vitest";
import { hfFailureCopy } from "./failure-copy";

test("401 points to the token, 403 to the conditions page", () => {
  expect(hfFailureCopy("hf_token_invalid")).toMatchObject({ action: "token" });
  expect(hfFailureCopy("hf_token_invalid")!.body).toContain("재처리");
  expect(hfFailureCopy("hf_gate_not_accepted")).toMatchObject({ action: "accept" });
  expect(hfFailureCopy("hf_gate_not_accepted")!.body).toContain("재처리");
});

test("anything else keeps the generic banner", () => {
  for (const code of [undefined, "audio_device_failed", "model_download_failed", "DISK_FULL"]) {
    expect(hfFailureCopy(code)).toBeNull();
  }
});
```

```tsx
// fe/src/features/hf-token/ui/hf-failure-action.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HfTokenGateProvider } from "./hf-token-gate";
import { HfFailureAction } from "./hf-failure-action";
import type { HfTokenState } from "../model/types";

afterEach(cleanup);

const state: HfTokenState = {
  status: "present", masked: "hf_****…****4567", account: null, onboardingDismissed: false, busy: false, message: null,
};

test("accept: opens the conditions page by key", () => {
  const send = vi.fn();
  render(
    <HfTokenGateProvider view={{ kind: "ready", state }} send={send}>
      <HfFailureAction action="accept" send={send} />
    </HfTokenGateProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "사용 조건 페이지 열기" }));
  expect(send).toHaveBeenCalledWith({ kind: "open", link: "accept" });
});

test("token: opens the token dialog even when a (revoked) token is present", () => {
  render(
    <HfTokenGateProvider view={{ kind: "ready", state }} send={vi.fn()}>
      <HfFailureAction action="token" />
    </HfTokenGateProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "토큰 설정 열기" }));
  expect(screen.getByRole("dialog", { name: "허깅페이스 토큰이 필요해요" })).toBeInTheDocument();
});

test("no button on the web", () => {
  const { container } = render(
    <HfTokenGateProvider view={{ kind: "web" }} send={vi.fn()}>
      <HfFailureAction action="token" />
    </HfTokenGateProvider>,
  );
  expect(container.querySelector("button")).toBeNull();
});
```

주의: `HfTokenGateProvider`의 `useEffect`는 `canDiarize`가 true면 다이얼로그를 닫는다. `present`인데 "토큰 설정 열기"로 연 다이얼로그가 즉시 닫히지 않게, 닫기는 **false→true로 바뀔 때만** 하도록 Task 7의 효과를 다음으로 바꾼다:

```tsx
  const allowed = canDiarize(view);
  const wasAllowed = React.useRef(allowed);
  React.useEffect(() => {
    // 토큰이 막 저장된 순간(false → true)에만 닫는다. 이미 present인데 폐기된 토큰을 바꾸려고 연 다이얼로그는 둔다.
    if (allowed && !wasAllowed.current) setOpen(false);
    wasAllowed.current = allowed;
  }, [allowed]);
```

이 경우 저장에 성공해도 `present → present`라 닫히지 않는다 — 폼의 성공 메시지가 보이고 사람이 닫는다. Task 7의 "closes by itself" 테스트(absent → present)는 그대로 통과한다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-fe exec vitest run src/features/hf-token`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

```ts
// fe/src/features/hf-token/lib/failure-copy.ts
/**
 * 화자 분리 모델을 받지 못해 실패한 회의의 안내 (스펙 2026-09-25 §3.5). 코드는 worker의 errors.py —
 * HF_TOKEN_INVALID(401)·HF_GATE_NOT_ACCEPTED(403) — 와 같은 문자열이다.
 */
export interface HfFailureCopy {
  title: string;
  body: string;
  action: "token" | "accept";
}

export function hfFailureCopy(code: string | undefined): HfFailureCopy | null {
  if (code === "hf_token_invalid") {
    return {
      title: "화자 분리를 하지 못했어요",
      body: "허깅페이스 토큰이 없거나 맞지 않아요. 토큰을 넣은 뒤 재처리해 주세요.",
      action: "token",
    };
  }
  if (code === "hf_gate_not_accepted") {
    return {
      title: "화자 분리를 하지 못했어요",
      body: "이 토큰의 계정이 화자 분리 모델의 사용 조건에 동의하지 않았어요. 동의한 뒤 재처리해 주세요.",
      action: "accept",
    };
  }
  return null;
}
```

```tsx
// fe/src/features/hf-token/ui/hf-failure-action.tsx
import { Button } from "@/shared/ui/button";

import { sendHfTokenAction } from "../lib/use-hf-token";
import type { HfTokenAction } from "../model/types";
import { useHfTokenDialog } from "./hf-token-gate";

export function HfFailureAction({
  action,
  send = sendHfTokenAction,
}: {
  action: "token" | "accept";
  send?: (a: HfTokenAction) => void;
}) {
  const dialog = useHfTokenDialog();
  if (!dialog.available) return null;
  return action === "token" ? (
    <Button type="button" variant="secondary" size="sm" className="ml-auto shrink-0" onClick={dialog.open}>
      토큰 설정 열기
    </Button>
  ) : (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="ml-auto shrink-0"
      onClick={() => send({ kind: "open", link: "accept" })}
    >
      사용 조건 페이지 열기
    </Button>
  );
}
```

`meeting.tsx`의 `ProcessingBanner` failed 분기 — `const noMic = …` 아래에 `const hf = cancelled ? null : hfFailureCopy(meeting.error?.code);`를 더하고, 제목·본문 삼항에 `hf`를 앞세운다:

```tsx
        <span className="font-semibold text-[color:var(--red-text)]">
          {cancelled
            ? "처리를 취소했어요"
            : hf !== null
              ? hf.title
              : noMic
                ? "마이크를 열지 못했어요"
                : "처리에 실패했어요"}
        </span>
        <span className="text-[color:var(--text-secondary)]">
          {cancelled
            ? "재처리로 다시 시작할 수 있어요."
            : hf !== null
              ? hf.body
              : noMic
                ? "시스템 설정 › 개인정보 보호 및 보안 › 마이크에서 담화를 허용한 뒤 다시 녹음해 주세요."
                : "다시 업로드하거나 잠시 후 시도해 주세요."}
        </span>
        {hf !== null ? <HfFailureAction action={hf.action} /> : null}
```

(`cancelled`의 정의를 그 분기에서 확인한다 — 이름이 다르면 그 이름을 쓴다. import 두 개를 더한다.)

- [ ] **Step 4: 통과 확인**

Run:
```bash
pnpm --filter damwha-fe exec vitest run
pnpm --filter damwha-fe run lint
```
Expected: 전부 PASS

- [ ] **Step 5: 커밋**

```bash
git add fe/src/features/hf-token fe/src/pages/meeting.tsx
git commit -m "feat(fe): 토큰·사용 조건 때문에 실패한 회의에 원인별 안내와 해결 버튼을 단다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 10: 문서·전체 검증·실측

**Files:**
- Modify: `fe/CLAUDE.md` (features 설명 목록 — `src/features/lens/` 문단 다음에 한 문단)
- Modify: Notion「Electron 전환 이후 개선 사항」(실측 뒤)

- [ ] **Step 1: fe/CLAUDE.md** — `src/features/lens/` 문단 뒤에 추가:

```markdown
`src/features/hf-token/` (허깅페이스 토큰, 데스크톱 전용) — 스펙 `docs/superpowers/specs/2026-09-25-hf-token-in-app-design.md`. `lib/bridge-store.ts`가 `window.__damwha_desktop.hfToken`(`show`/`next`)을 들고, main(`desktop/src/windows/token-bridge.ts`)이 그것을 **묻는다** — 렌더러가 여는 채널은 없다. `model/types.ts`는 main 쪽 타입의 손 사본이라 한쪽을 바꾸면 다른 쪽도 바꾼다. `useHfToken()`은 `web`(다리 없음 — 게이트 통과) / `pending`(Electron인데 첫 상태 전 — 잠금) / `ready` 셋이고, `canDiarize`가 `present`에서만 연다. 게이트(`HfTokenGateProvider`·`useDiarizationGate`)는 AppShell에 한 번, 적용 지점은 새 회의(LeftNav)와 재처리(TranscriptPane)다. Provider 밖에서는 통과라 단위 테스트가 nav 조각을 따로 그릴 수 있다. 온보딩의 "나중에 하기"는 main 메모리에만 남는다 — 앱을 다시 켜면 다시 뜬다.
```

- [ ] **Step 2: 전체 검증**

```bash
pnpm --filter damwha-desktop run lint
pnpm --filter damwha-desktop exec vitest run
pnpm --filter damwha-fe run lint
pnpm --filter damwha-fe exec vitest run
pnpm --filter damwha-fe run build
```
Expected: 전부 통과. 결과(테스트 수)를 기록한다.

- [ ] **Step 3: 커밋**

```bash
git add fe/CLAUDE.md
git commit -m "docs(fe): hf-token 기능을 CLAUDE.md에 적는다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

- [ ] **Step 4: 실측 (사람과 함께)** — 스펙 §8. **먼저 토큰 파일을 옆에 둔다**:

```bash
cp "$HOME/Library/Application Support/Damwha/hf-token.bin" "$HOME/Library/Application Support/Damwha/hf-token.bin.keep"
```

| 기준 | 절차 | 기대 |
| --- | --- | --- |
| C1 | 앱 종료 → `hf-token.bin`을 `mv`로 치움 → `pnpm desktop:build` 결과 `desktop/out/mac-arm64/Damwha.app` 실행 | 토큰 창 없이 담화 화면 + 온보딩 |
| C2 | "나중에 하기" → 새 회의 기록하기 → 앱 종료·재실행 | 토큰 다이얼로그 / 재실행 뒤 온보딩 다시 |
| C3 | 온보딩에 토큰 입력(사람) → `supervisor.log`에 worker·embed 재시작 → 짧은 파일 업로드 | 재실행 없이 화자 분리까지 성공 |
| C4 | 설정 → 토큰 지우기 → 새 회의 → 앱 재실행 | 다이얼로그 / 온보딩(absent) |
| C5 | 토큰 입력 → 실시간 녹음 시작 → 설정에서 토큰 제출 | "녹음을 마친 뒤 바꿔 주세요." · 녹음 계속 |
| C6 | `hf-token.bin.keep`을 되돌리고 재실행 | 아무것도 묻지 않음, 설정에 마스킹 값 |

끝나면 `hf-token.bin.keep`이 원래 이름으로 돌아갔는지 확인한다. 결과를 Notion P2 항목에 적는다.
