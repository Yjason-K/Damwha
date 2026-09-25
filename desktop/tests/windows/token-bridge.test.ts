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
