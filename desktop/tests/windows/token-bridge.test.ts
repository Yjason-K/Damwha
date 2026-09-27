import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  createTokenBridge,
  hfTokenShowCall,
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

  it("clear: marks onboarding dismissed so it does not pop over Settings this run (Finding 1)", async () => {
    const page = fakePage();
    const b = createTokenBridge(deps(page, { clear: () => undefined }));
    b.boot("present", "hf_****…****4567");
    b.attach(page.win);
    page.act({ kind: "clear" });
    await flush();
    expect(last(page)).toMatchObject({ status: "absent", onboardingDismissed: true });
  });

  it("submit: a successful save also marks onboarding dismissed — clearing it later must not re-pop the onboarding dialog over Settings (Finding 1)", async () => {
    const page = fakePage();
    const b = createTokenBridge(deps(page));
    b.boot("absent", null);
    b.attach(page.win);
    page.act({ kind: "submit", token: TOKEN });
    await flush();
    await flush();
    expect(last(page)).toMatchObject({ status: "present", onboardingDismissed: true });
  });

  it("submit: a failed verify does not mark onboarding dismissed", async () => {
    const page = fakePage();
    const b = createTokenBridge(deps(page, { verify: async () => ({ ok: false, kind: "invalid", detail: "HTTP 401" }) }));
    b.boot("absent", null);
    b.attach(page.win);
    page.act({ kind: "submit", token: TOKEN });
    await flush();
    await flush();
    expect(last(page)).toMatchObject({ status: "absent", onboardingDismissed: false });
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

  it("submit: a concurrent submit while one is in-flight is refused with a warn message, not run (spec §4.2)", async () => {
    const page = fakePage();
    let resolveVerify!: (v: { ok: true; name: string }) => void;
    const verify = vi.fn(() => new Promise((resolve) => {
      resolveVerify = resolve;
    }));
    const apply = vi.fn(async () => ({ restarted: ["worker", "embed"], skipped: [] }));
    const b = createTokenBridge(deps(page, { verify: verify as never, apply: apply as never }));
    b.boot("absent", null);
    b.attach(page.win);
    // 첫 submit — verify가 걸린 채(hang) 멈춘다.
    page.act({ kind: "submit", token: TOKEN });
    await flush();
    expect(last(page)).toMatchObject({ busy: true });

    // ⌘R — 옛 고리가 아직 verify를 기다리는 중인데 새 고리가 함께 돈다.
    b.attach(page.win);
    await flush();
    // 새 고리에서 온 둘째 submit — 진행 중이므로 실행하지 않고 경고만 남긴다.
    page.act({ kind: "submit", token: TOKEN });
    await flush();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    expect(last(page).message).toEqual({ tone: "warn", text: "토큰 요청을 처리하는 중이에요. 끝난 뒤 다시 시도해 주세요." });
    // 진행 중이던 쪽의 busy:true를 건드리지 않는다.
    expect(last(page).busy).toBe(true);

    // 첫 verify를 풀어 준다 — 그제서야 저장까지 끝난다.
    resolveVerify({ ok: true, name: "jason" });
    await flush();
    await flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(last(page)).toMatchObject({ status: "present", account: "jason", busy: false });
  });

  it("an exception inside handle (e.g. isRecording rejecting) unlocks the page instead of killing the loop", async () => {
    const page = fakePage();
    const isRecording = vi.fn(async () => {
      throw new Error("boom");
    });
    const b = createTokenBridge(deps(page, { isRecording }));
    b.boot("absent", null);
    b.attach(page.win);
    page.act({ kind: "submit", token: TOKEN });
    await flush();
    await flush();
    expect(last(page)).toMatchObject({
      busy: false,
      message: { tone: "error", text: "토큰 요청을 처리하지 못했어요. 다시 시도해 주세요." },
    });
    // 고리가 죽지 않았다 — 다음 요청도 그대로 처리된다.
    page.act({ kind: "dismissOnboarding" });
    await flush();
    expect(b.state().onboardingDismissed).toBe(true);
  });
});

/**
 * fe/src/features/meeting/lib/desktop-bridge.ts가 이 파일과 같은 이름으로 다리를 놓는지 (Finding 6).
 * 두 패키지는 import를 나눌 수 없어(fe는 electron을, desktop은 fe를 모른다) 이름이 손으로만 맞는다 —
 * fe 쪽이 `hfToken`을 다른 이름으로 바꾸거나 `__damwha_desktop`에 안 걸면 HF_TOKEN_ASK_SCRIPT의
 * `window.__damwha_desktop?.hfToken`도, hfTokenShowCall의 `.show(...)`도 조용히 no-op이 된다.
 * shell-html.test.ts가 fe/src/index.css를 텍스트로 읽어 값이 갈리는 날을 잡는 것과 같은 방식 —
 * fe를 실행하지 않고 소스를 텍스트로만 읽는다(desktop 테스트 환경에 electron 없는 fe 모듈을 끌어오지 않는다).
 */
describe("fe/desktop-bridge.ts installs the same __damwha_desktop.hfToken name this file asks for (cross-package contract)", () => {
  it("HF_TOKEN_ASK_SCRIPT/hfTokenShowCall's global.property name is installed by fe", () => {
    const asked = /window\.(\w+)\?\.(\w+)\s*\?/.exec(HF_TOKEN_ASK_SCRIPT);
    expect(asked).not.toBeNull();
    const [, globalName, propName] = asked!;
    expect(globalName).toBe("__damwha_desktop");
    expect(propName).toBe("hfToken");

    const showCall = hfTokenShowCall({
      status: "absent",
      masked: null,
      account: null,
      onboardingDismissed: false,
      busy: false,
      message: null,
    });
    expect(showCall).toContain(`window.${globalName}?.${propName}?.show(`);

    const feSource = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "fe", "src", "features", "meeting", "lib", "desktop-bridge.ts"),
      "utf8",
    );
    expect(feSource).toMatch(new RegExp(`\\bw\\.${globalName}\\s*=`));
    expect(feSource).toMatch(new RegExp(`\\b${propName}\\s*:\\s*hfTokenStore\\.bridge\\b`));
  });
});

// 타입만 쓰는 import가 사용되지 않았다는 lint를 피한다.
export type _A = HfTokenAction;
