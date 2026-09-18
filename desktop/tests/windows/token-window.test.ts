import { describe, expect, it, vi } from "vitest";
import { CAUSES } from "../../src/diagnostics/causes";
import { maskToken, type TokenVerdict } from "../../src/config/token-store";
import {
  ASK_SCRIPT,
  openTokenWindow,
  parseAction,
  showCall,
  TOKEN_LINKS,
  TokenWindowClosed,
  type TokenPageState,
  type TokenWindowDeps,
} from "../../src/windows/token-window";

/**
 * 창과 페이지만 가짜다. 흐름(묻고 → 검증 → 저장 → 닫기)은 진짜 코드가 정한다.
 *
 * 가짜 페이지는 shell/token.html과 같은 약속을 지킨다: ASK_SCRIPT는 사람이 무언가 할 때까지 끝나지 않는
 * 프라미스이고, showCall은 상태를 그린다. 진짜 페이지 스크립트는 tests/windows/shell-html.test.ts가 돌린다.
 */
const TOKEN = "hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 결과를 **곧바로** 붙잡는다 — 거부가 act() 도중에 나면 나중에 붙인 expect(...).rejects는 늦다. */
function outcome<T>(p: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return p.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

interface FakeWin {
  alive: boolean;
  load: Array<() => void>;
  closed: Array<() => void>;
}

function harness(over: Partial<TokenWindowDeps<FakeWin>> = {}) {
  const win: FakeWin = { alive: true, load: [], closed: [] };
  const scripts: string[] = [];
  const states: TokenPageState[] = [];
  const log: string[] = [];
  const opened: string[] = [];
  const saved: string[] = [];
  const verified: string[] = [];
  /** 끝나지 않은 ASK 호출. 페이지 세대마다 하나씩 쌓인다. */
  const asks: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  let quits = 0;
  let loadError: ((e: unknown) => void) | null = null;
  let verdict: (token: string) => Promise<TokenVerdict> = async () => ({ ok: true, name: "yeongjae" });

  const fireClosed = () => {
    if (!win.alive) return;
    win.alive = false;
    for (const l of win.closed) l();
  };

  const deps: TokenWindowDeps<FakeWin> = {
    notice: null,
    create: (onLoadError) => {
      loadError = onLoadError;
      return win;
    },
    alive: (w) => w.alive,
    onLoad: (w, l) => void w.load.push(l),
    onClosed: (w, l) => void w.closed.push(l),
    run: (w, script) => {
      if (!w.alive) return Promise.reject(new Error("Object has been destroyed"));
      scripts.push(script);
      if (script === ASK_SCRIPT) {
        return new Promise((resolve, reject) => asks.push({ resolve, reject }));
      }
      const m = /show\((.*)\);$/s.exec(script);
      if (m !== null) states.push(JSON.parse(m[1]) as TokenPageState);
      return Promise.resolve(undefined);
    },
    close: () => fireClosed(),
    openExternal: async (url) => void opened.push(url),
    quit: () => void (quits += 1),
    log: (line) => void log.push(line),
    verify: (token) => {
      verified.push(token);
      return verdict(token);
    },
    save: (token) => void saved.push(token),
    ...over,
  };

  return {
    deps,
    win,
    scripts,
    states,
    log,
    opened,
    saved,
    verified,
    asks,
    quits: () => quits,
    last: () => states[states.length - 1],
    setVerdict(fn: (token: string) => Promise<TokenVerdict>) {
      verdict = fn;
    },
    async load() {
      for (const l of win.load) l();
      await flush();
    },
    /** 가장 최근 ASK에 답한다 = 지금 페이지에서 사람이 무언가 했다. */
    async act(action: unknown, index = asks.length - 1) {
      const ask = asks[index];
      asks[index] = { resolve: () => undefined, reject: () => undefined };
      ask.resolve(action);
      await flush();
      await flush();
    },
    async userClose() {
      fireClosed();
      await flush();
    },
    failLoad(e: unknown) {
      loadError?.(e);
    },
  };
}

describe("openTokenWindow", () => {
  it("draws the first state after the page loads, then asks the page", async () => {
    const h = harness();
    void openTokenWindow(h.deps);
    expect(h.scripts).toEqual([]);
    await h.load();
    expect(h.states).toEqual([{ busy: false, tone: null, message: null }]);
    expect(h.asks).toHaveLength(1);
  });

  it("shows the notice it was opened with — the unreadable-file case", async () => {
    const h = harness({ notice: "토큰을 읽을 수 없어요 — 다시 입력해 주세요" });
    void openTokenWindow(h.deps);
    await h.load();
    expect(h.states[0]).toEqual({ busy: false, tone: "warn", message: "토큰을 읽을 수 없어요 — 다시 입력해 주세요" });
  });

  it("verifies the trimmed token, saves it, closes the window, and resolves with it — without quitting", async () => {
    const h = harness();
    let release: (v: TokenVerdict) => void = () => undefined;
    h.setVerdict(() => new Promise((resolve) => (release = resolve)));
    const result = openTokenWindow(h.deps);
    await h.load();
    await h.act({ kind: "submit", token: `  ${TOKEN}\n` });
    expect(h.verified).toEqual([TOKEN]);
    // 확인하는 동안 입력을 막는다.
    expect(h.last().busy).toBe(true);
    expect(h.saved).toEqual([]);
    release({ ok: true, name: "yeongjae" });
    await expect(result).resolves.toBe(TOKEN);
    expect(h.saved).toEqual([TOKEN]);
    expect(h.win.alive).toBe(false);
    expect(h.quits()).toBe(0);
  });

  it("refuses an invalid token with the reason, saves nothing, and asks again", async () => {
    const h = harness();
    h.setVerdict(async (t) =>
      t === TOKEN ? { ok: true, name: "y" } : { ok: false, kind: "invalid", detail: "HTTP 401 — Invalid credentials in Authorization header" },
    );
    const result = openTokenWindow(h.deps);
    await h.load();
    await h.act({ kind: "submit", token: "hf_typo" });
    expect(h.saved).toEqual([]);
    expect(h.last()).toMatchObject({ busy: false, tone: "error" });
    expect(h.last().message).toContain(CAUSES.hfTokenInvalid.text);
    expect(h.last().message).toContain("HTTP 401 — Invalid credentials in Authorization header");
    expect(h.asks).toHaveLength(2);
    expect(h.win.alive).toBe(true);

    await h.act({ kind: "submit", token: TOKEN });
    await expect(result).resolves.toBe(TOKEN);
    expect(h.saved).toEqual([TOKEN]);
  });

  it("says 'cannot check now' when HF is unreachable — distinct from invalid — and saves nothing", async () => {
    const h = harness();
    h.setVerdict(async () => ({ ok: false, kind: "offline", detail: "네트워크 오류 (ENOTFOUND)" }));
    void openTokenWindow(h.deps);
    await h.load();
    await h.act({ kind: "submit", token: TOKEN });
    expect(h.saved).toEqual([]);
    const message = h.last().message ?? "";
    expect(message).toContain("지금은 확인할 수 없어요");
    expect(message).toContain("네트워크 오류 (ENOTFOUND)");
    expect(message).not.toContain(CAUSES.hfTokenInvalid.text);
    expect(h.last().busy).toBe(false);
    expect(h.asks).toHaveLength(2);
  });

  it("treats a verifier that throws as 'cannot check now'", async () => {
    const h = harness();
    h.setVerdict(() => Promise.reject(new Error(`boom ${TOKEN}`)));
    void openTokenWindow(h.deps);
    await h.load();
    await h.act({ kind: "submit", token: TOKEN });
    expect(h.saved).toEqual([]);
    expect(h.last().message).toContain("지금은 확인할 수 없어요");
    expect(h.last().message).not.toContain(TOKEN);
    expect(h.asks).toHaveLength(2);
  });

  it("asks for a token when the field is empty, without calling HF", async () => {
    const h = harness();
    void openTokenWindow(h.deps);
    await h.load();
    await h.act({ kind: "submit", token: "   " });
    expect(h.verified).toEqual([]);
    expect(h.last()).toMatchObject({ busy: false, tone: "error" });
    expect(h.asks).toHaveLength(2);
  });

  it("opens the two HF pages in the browser — fixed addresses, chosen by main", async () => {
    const h = harness();
    void openTokenWindow(h.deps);
    await h.load();
    await h.act({ kind: "open", link: "accept" });
    await h.act({ kind: "open", link: "tokens" });
    expect(h.opened).toEqual([
      "https://huggingface.co/pyannote/speaker-diarization-community-1",
      "https://huggingface.co/settings/tokens",
    ]);
    expect(TOKEN_LINKS).toEqual({
      accept: "https://huggingface.co/pyannote/speaker-diarization-community-1",
      tokens: "https://huggingface.co/settings/tokens",
    });
    expect(h.win.alive).toBe(true);
  });

  it("ignores anything else the page sends and keeps asking", async () => {
    const h = harness();
    void openTokenWindow(h.deps);
    await h.load();
    const junk: unknown[] = [
      { kind: "open", link: "https://evil.example" },
      { kind: "open", link: "toString" },
      { kind: "submit", token: 5 },
      { kind: "submit", token: "x".repeat(10_000) },
      { kind: "navigate", url: "https://huggingface.co" },
      "submit",
      42,
      [],
    ];
    for (const j of junk) await h.act(j);
    expect(h.opened).toEqual([]);
    expect(h.verified).toEqual([]);
    expect(h.asks).toHaveLength(junk.length + 1);
  });

  it("quits the app when the person closes the window — there is no skipping", async () => {
    const h = harness();
    const result = outcome(openTokenWindow(h.deps));
    await h.load();
    await h.userClose();
    const got = await result;
    expect("error" in got && got.error).toBeInstanceOf(TokenWindowClosed);
    expect(h.quits()).toBe(1);
    expect(h.saved).toEqual([]);
  });

  it("closeQuitsApp가 false면 창을 닫아도 앱을 끝내지 않는다 — 설정에서 연 교체 창 (Task 11)", () => {
    // 첫 실행 게이트와 같은 창을 쓰되 닫힘의 뜻만 다르다. 한 값으로 두면 설정 창을 닫은 사람의 앱이 꺼진다.
    const h = harness({ closeQuitsApp: false });
    const result = outcome(openTokenWindow(h.deps));
    return (async () => {
      await h.load();
      await h.userClose();
      const got = await result;
      expect("error" in got && got.error).toBeInstanceOf(TokenWindowClosed);
      expect(h.quits()).toBe(0);
      expect(h.saved).toEqual([]);
      // 로그도 "앱을 종료합니다"라고 적지 않는다.
      expect(h.log.join("\n")).not.toContain("종료합니다");
      expect(h.log.join("\n")).toContain("바꾸지 않았습니다");
    })();
  });

  it("drops a verdict that arrives after the window was closed", async () => {
    const h = harness();
    let release: (v: TokenVerdict) => void = () => undefined;
    h.setVerdict(() => new Promise((resolve) => (release = resolve)));
    const result = outcome(openTokenWindow(h.deps));
    await h.load();
    await h.act({ kind: "submit", token: TOKEN });
    await h.userClose();
    release({ ok: true, name: "y" });
    await flush();
    const got = await result;
    expect("error" in got && got.error).toBeInstanceOf(TokenWindowClosed);
    expect(h.saved).toEqual([]);
    expect(h.quits()).toBe(1);
  });

  it("keeps the window open with a fixed message when saving fails — the exception text is not shown", async () => {
    const h = harness({
      save: () => {
        throw new Error(`Encryption is not available ${TOKEN}`);
      },
    });
    const result = openTokenWindow(h.deps);
    let settled = false;
    void result.then(
      () => (settled = true),
      () => (settled = true),
    );
    await h.load();
    await h.act({ kind: "submit", token: TOKEN });
    expect(settled).toBe(false);
    expect(h.win.alive).toBe(true);
    expect(h.last()).toMatchObject({ busy: false, tone: "error" });
    expect(h.last().message).toMatch(/저장하지 못했어요/);
    expect(h.last().message).not.toContain("Encryption is not available");
    expect(h.log.join("\n")).not.toContain(TOKEN);
    expect(h.asks).toHaveLength(2);
  });

  it("never sends the token back to the page and never logs it", async () => {
    const h = harness();
    h.setVerdict(async (t) => (t === TOKEN ? { ok: true, name: "yeongjae" } : { ok: false, kind: "invalid", detail: "HTTP 401" }));
    const result = openTokenWindow(h.deps);
    await h.load();
    await h.act({ kind: "submit", token: "hf_wrongwrongwrong" });
    await h.act({ kind: "submit", token: TOKEN });
    await result;
    for (const s of h.scripts) {
      expect(s).not.toContain(TOKEN);
      expect(s).not.toContain("hf_wrongwrongwrong");
    }
    const log = h.log.join("\n");
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain("hf_wrongwrongwrong");
    // 무엇이 저장됐는지는 가린 모양으로 남긴다.
    expect(log).toContain(maskToken(TOKEN));
    expect(log).toContain("HTTP 401");
  });

  it("after a reload, draws the current state on the new page and ignores the old page's answer", async () => {
    const h = harness({ notice: "토큰을 읽을 수 없어요 — 다시 입력해 주세요" });
    void openTokenWindow(h.deps);
    await h.load();
    expect(h.asks).toHaveLength(1);
    await h.load();
    expect(h.states).toHaveLength(2);
    expect(h.states[1]).toEqual(h.states[0]);
    expect(h.asks).toHaveLength(2);
    // 옛 페이지의 답은 버린다 — 새 페이지가 이미 묻고 있다.
    await h.act({ kind: "submit", token: TOKEN }, 0);
    expect(h.verified).toEqual([]);
    await h.act({ kind: "submit", token: TOKEN }, 1);
    expect(h.verified).toEqual([TOKEN]);
  });

  it("stops asking a page whose ask call failed, until it loads again", async () => {
    const h = harness();
    void openTokenWindow(h.deps);
    await h.load();
    h.asks[0].reject(new Error("Script failed to execute"));
    await flush();
    expect(h.asks).toHaveLength(1);
    await h.load();
    expect(h.asks).toHaveLength(2);
  });

  it("fails — without quitting — when the page has no bridge to answer with", async () => {
    // CSP 해시가 어긋나면 페이지 스크립트가 돌지 않아 ASK가 null을 돌려준다. 계속 물으면 헛돈다.
    const h = harness();
    const result = outcome(openTokenWindow(h.deps));
    await h.load();
    await h.act(null);
    const got = await result;
    expect("error" in got).toBe(true);
    const error = "error" in got ? got.error : null;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TokenWindowClosed);
    expect((error as Error).message).toMatch(/토큰 화면/);
    expect(h.win.alive).toBe(false);
    expect(h.quits()).toBe(0);
  });

  it("fails — without quitting — when the page cannot be loaded", async () => {
    const h = harness();
    const result = outcome(openTokenWindow(h.deps));
    h.failLoad(new Error("ERR_FILE_NOT_FOUND"));
    const got = await result;
    const error = "error" in got ? got.error : null;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TokenWindowClosed);
    expect((error as Error).message).toMatch(/토큰 화면/);
    expect(h.win.alive).toBe(false);
    expect(h.quits()).toBe(0);
  });

  it("logs a link that could not be opened and keeps going", async () => {
    const h = harness({ openExternal: () => Promise.reject(new Error("no browser")) });
    void openTokenWindow(h.deps);
    await h.load();
    await h.act({ kind: "open", link: "tokens" });
    expect(h.log.some((l) => l.includes("열지 못했어요"))).toBe(true);
    expect(h.asks).toHaveLength(2);
  });

  it("does not throw when drawing races with the window being destroyed", async () => {
    const h = harness();
    const run = vi.fn(h.deps.run);
    const result = outcome(openTokenWindow({ ...h.deps, run }));
    await h.load();
    await h.userClose();
    const got = await result;
    expect("error" in got && got.error).toBeInstanceOf(TokenWindowClosed);
  });
});

describe("parseAction / showCall", () => {
  it("accepts exactly the two action shapes", () => {
    expect(parseAction({ kind: "submit", token: "hf_x" })).toEqual({ kind: "submit", token: "hf_x" });
    expect(parseAction({ kind: "open", link: "accept" })).toEqual({ kind: "open", link: "accept" });
    expect(parseAction({ kind: "open", link: "tokens", extra: 1 })).toEqual({ kind: "open", link: "tokens" });
    for (const bad of [null, undefined, "x", 1, {}, { kind: "open" }, { kind: "open", link: "constructor" }, { kind: "submit" }]) {
      expect(parseAction(bad)).toBeNull();
    }
  });

  it("puts the state into the page call as JSON only — a quote or </script> in a message stays a string", () => {
    const state: TokenPageState = { busy: false, tone: "error", message: `"); window.__pwned = 1; ("</script>` };
    const script = showCall(state);
    const sandbox: Record<string, unknown> = {};
    let got: unknown;
    sandbox.window = { __damwha_token: { show: (s: unknown) => (got = s) } };
    // eslint-disable-next-line no-new-func
    new Function("window", script)(sandbox.window);
    expect(got).toEqual(state);
    expect((sandbox.window as Record<string, unknown>).__pwned).toBeUndefined();
  });
});
