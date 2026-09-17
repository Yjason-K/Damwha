import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { describe, expect, it } from "vitest";
import { CAUSES } from "../../src/diagnostics/causes";
import { servicesView } from "../../src/windows/status-view";
import type { ServiceStatus } from "../../src/services/types";

/**
 * shell/*.html의 **실제** 인라인 스크립트를 가짜 DOM에서 돌린다. 사본을 테스트하지 않는다 —
 * 파일에서 스크립트를 뽑아 그대로 실행하므로 그 파일을 고치면 이 테스트가 본다.
 *
 * 가짜 DOM은 HTML로 해석하는 싱크(innerHTML·outerHTML·insertAdjacentHTML·document.write·
 * on* 속성)를 **던지게** 만든다. 원인 문구에는 서브프로세스 stderr가 들어오므로, 그 문구가
 * 그런 싱크에 한 번이라도 닿으면 `<img src=x onerror=…>`가 코드가 된다. 진짜 Chromium에서의
 * 확인은 task-14 보고서에 있다(headless Chrome) — 이 테스트는 그 성질이 회귀하지 않게 잠근다.
 */

class FakeNode {
  children: FakeNode[] = [];
  className = "";
  hidden = false;
  dataset: Record<string, string> = {};
  /** 입력칸·버튼 (token.html). */
  value = "";
  disabled = false;
  focusCount = 0;
  private ownText = "";
  private listeners: Record<string, Array<(event: unknown) => void>> = {};

  constructor(
    readonly tag: string,
    readonly id?: string,
  ) {}

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.children = [];
    this.ownText = String(value);
  }
  append(...nodes: Array<FakeNode | string>): void {
    for (const n of nodes) {
      // 문자열 append는 글자 노드를 만든다 — 해석하지 않으므로 안전한 싱크다.
      this.children.push(typeof n === "string" ? Object.assign(new FakeNode("#text"), { textContent: n }) : n);
    }
  }
  appendChild(node: FakeNode): FakeNode {
    this.append(node);
    return node;
  }
  replaceChildren(...nodes: Array<FakeNode | string>): void {
    this.children = [];
    this.ownText = "";
    this.append(...nodes);
  }
  set innerHTML(_: string) {
    throw new Error("HTML sink used: innerHTML");
  }
  get innerHTML(): string {
    throw new Error("HTML sink used: innerHTML");
  }
  set outerHTML(_: string) {
    throw new Error("HTML sink used: outerHTML");
  }
  insertAdjacentHTML(): void {
    throw new Error("HTML sink used: insertAdjacentHTML");
  }
  setAttribute(name: string, value: string): void {
    if (/^on/i.test(name) || /^(src|href|srcdoc)$/i.test(name)) throw new Error(`HTML sink used: ${name}`);
    (this.dataset as Record<string, string>)[`attr:${name}`] = value;
  }
  /** 이 노드 아래(자신 포함)의 모든 노드. */
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  focus(): void {
    this.focusCount += 1;
  }
  /** 사람의 동작을 흉내 낸다. 진짜 브라우저처럼 비활성 컨트롤은 click을 받지 않는다. 기본 동작을 막았는지 돌려준다. */
  fire(type: string, fields: Record<string, unknown> = {}): boolean {
    if (type === "click" && this.disabled) return false;
    let prevented = false;
    const event = { type, target: this, preventDefault: () => void (prevented = true), ...fields };
    for (const l of this.listeners[type] ?? []) l(event);
    return prevented;
  }
}

function loadPage(file: string, search = "") {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "shell", file), "utf8");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  // 인라인 스크립트 하나. 외부 src가 생기면 이 테스트가 그 코드를 못 본다.
  expect(scripts).toHaveLength(1);
  expect(scripts[0][1]).not.toMatch(/src=/);

  const body = new FakeNode("body");
  const byId = new Map<string, FakeNode>();
  for (const m of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new FakeNode(m[1], m[2]);
    // 마크업의 hidden 속성을 옮긴다 — 스크립트가 그것을 내리는지가 판정 대상이다.
    node.hidden = /\bhidden\b/.test(m[0]);
    byId.set(m[2], node);
    body.append(node);
  }
  const document = {
    body,
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => Object.assign(new FakeNode("#text"), { textContent: text }),
    write: () => {
      throw new Error("HTML sink used: document.write");
    },
    writeln: () => {
      throw new Error("HTML sink used: document.writeln");
    },
  };
  const sandbox: Record<string, unknown> = { document, location: { search }, URLSearchParams };
  sandbox.window = sandbox;
  vm.runInNewContext(scripts[0][2], sandbox);
  return { html, sandbox, byId, body };
}

/** 주석을 뺀 소스 — 주석이 금지 낱말을 **설명**하는 것은 괜찮다. */
function codeOf(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const XSS = '<img src=x onerror="window.__pwned=1">';
const ZOD = [
  "startup failed: [",
  "  {",
  '    "code": "invalid_enum_value",',
  '    "path": ["SUMMARY_LLM_MODEL"]',
  "  }",
  "]",
].join("\n");

describe("services.html", () => {
  const failed: ServiceStatus = {
    id: "api",
    process: "failed",
    health: "unknown",
    owned: true,
    restarts: 1,
    detail: `${XSS}\n${ZOD}`,
  };

  it("has no button, form, input, link, IPC, or HTML sink — the display-only contract (스펙 §6.11)", () => {
    const { html } = loadPage("services.html");
    const code = codeOf(html);
    for (const banned of [
      /<button\b/i,
      /<form\b/i,
      /<input\b/i,
      /<a\b/i,
      /ipcRenderer/,
      /require\(/,
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
      /\son\w+\s*=/i,
    ]) {
      expect(code).not.toMatch(banned);
    }
  });

  it("shows a cause containing HTML as text, character for character, and never parses it", () => {
    const { sandbox, byId } = loadPage("services.html");
    const view = servicesView({ statuses: [failed], restartNotice: XSS, logPathOf: (id) => `/l/${id}.log` });
    // 가짜 DOM의 HTML 싱크는 던진다 — 스크립트가 하나라도 쓰면 여기서 실패한다.
    (sandbox.__damwha_render as (v: unknown) => void)(view);

    const nodes = byId.get("rows")!.all();
    const cause = nodes.find((n) => n.className === "cause")!;
    expect(cause.tag).toBe("pre");
    expect(cause.textContent).toBe(`${XSS}\n${ZOD}`);
    expect(nodes.some((n) => n.tag === "img")).toBe(false);
    expect(sandbox.__pwned).toBeUndefined();
    // 서비스 한 줄에 속하지 않는 안내도 같은 규칙이다.
    expect(byId.get("notices")!.textContent).toBe(XSS);
  });

  it("renders every row with name, badge, notes, cause, hint, and log path", () => {
    const { sandbox, byId } = loadPage("services.html");
    const view = servicesView({
      statuses: [
        { id: "postgres", process: "running", health: "ok", owned: false, restarts: 0 },
        { ...failed, id: "worker", detail: "uv를 찾지 못했어요." },
      ],
      restartNotice: null,
      logPathOf: (id) => `/l/${id}.log`,
    });
    (sandbox.__damwha_render as (v: unknown) => void)(view);
    const rows = byId.get("rows")!.children;
    expect(rows).toHaveLength(2);
    expect(rows[0].dataset.tone).toBe("ok");
    expect(rows[0].textContent).toContain("데이터베이스");
    expect(rows[0].textContent).toContain("앱이 띄우지 않음");
    expect(rows[0].textContent).toContain("로그: /l/postgres.log");
    expect(rows[1].dataset.tone).toBe("fail");
    expect(rows[1].textContent).toContain("uv를 찾지 못했어요.");
    expect(rows[1].textContent).toContain("해결: ");
    expect(rows[1].textContent).toContain("config.json");
    // 안내가 없으면 notices 목록은 숨는다.
    expect(byId.get("notices")!.hidden).toBe(true);
  });

  it("shows the skipped-migration-check warning on the api row as text", () => {
    const { sandbox, byId } = loadPage("services.html");
    const view = servicesView({
      statuses: [{ id: "api", process: "running", health: "ok", owned: true, restarts: 0 }],
      restartNotice: null,
      logPathOf: (id) => id,
      migrationCheckSkipped: true,
    });
    (sandbox.__damwha_render as (v: unknown) => void)(view);
    const row = byId.get("rows")!.children[0];
    expect(row.dataset.tone).toBe("warn");
    const warning = row.all().find((n) => n.className === "warning")!;
    expect(warning.textContent).toBe(`주의: ${view.rows[0].warning}`);
  });

  it("draws what the latest render says and nothing of the one before — it is redrawn live (P2-C11)", () => {
    // 전에는 **같은** view를 두 번 넣었다. 두 번째 호출을 무시하는 페이지도 통과했다(리뷰 I-2) — 사람이
    // degraded가 ok로 돌아오기를 지켜보는 창이 첫 로드 모습에 멈춰도 초록이었다. 서로 다른 둘을 넣는다.
    const { sandbox, byId } = loadPage("services.html");
    const render = sandbox.__damwha_render as (v: unknown) => void;
    const api = { id: "api", process: "running", owned: true, restarts: 0 } as const;
    const logPathOf = (id: string) => `/l/${id}.log`;
    const rows = () => byId.get("rows")!.children;
    const byClass = (node: FakeNode, className: string) => node.all().filter((n) => n.className === className);

    render(
      servicesView({
        statuses: [{ ...api, health: "degraded", detail: CAUSES.apiDbUnreachable.text }],
        restartNotice: "다시 켜야 바뀌어요",
        logPathOf,
      }),
    );
    // 첫 그림이 실제로 degraded였다는 것을 먼저 본다 — 아니면 아래의 "사라졌다"가 아무것도 말하지 않는다.
    expect(rows()).toHaveLength(1);
    expect(rows()[0].dataset.tone).toBe("warn");
    expect(byClass(rows()[0], "state")[0].textContent).toBe("실행 중 · 동작 제한");
    expect(byClass(rows()[0], "cause")[0].textContent).toBe(CAUSES.apiDbUnreachable.text);
    expect(byId.get("notices")!.hidden).toBe(false);

    render(servicesView({ statuses: [{ ...api, health: "ok" }], restartNotice: null, logPathOf }));
    // 붙이지 않고 바꿨다.
    expect(rows()).toHaveLength(1);
    // 둘째 view가 보인다.
    expect(rows()[0].dataset.tone).toBe("ok");
    expect(byClass(rows()[0], "state")[0].textContent).toBe("실행 중");
    // 첫째 view의 것은 남지 않았다.
    expect(rows()[0].textContent).not.toContain("동작 제한");
    expect(byClass(rows()[0], "cause")).toHaveLength(0);
    expect(byClass(rows()[0], "hint")).toHaveLength(0);
    expect(byId.get("notices")!.children).toHaveLength(0);
    expect(byId.get("notices")!.hidden).toBe(true);
    expect(byId.get("updated")!.textContent).toMatch(/^마지막 갱신 /);
  });

  it("renders the debug command as text", () => {
    const { byId, sandbox } = loadPage("services.html");
    const render = (sandbox.window as { __damwha_render: (v: unknown) => void }).__damwha_render;
    render({
      notices: [],
      rows: [{ id: "postgres", name: "데이터베이스", state: "실행 중", tone: "ok", notes: [], log: "/l", command: `psql -h "<img src=x onerror=alert(1)>"` }],
    });
    const rows = byId.get("rows")!;
    expect(JSON.stringify(rows)).toContain("<img src=x onerror=alert(1)>");
    expect(JSON.stringify(rows)).toMatch(/디버깅 접속/);
  });

  it("keeps line breaks in the cause and bounds its height", () => {
    const { html } = loadPage("services.html");
    const rule = /\.cause\s*\{([^}]*)\}/.exec(html)?.[1] ?? "";
    expect(rule).toMatch(/white-space:\s*pre-wrap/);
    expect(rule).toMatch(/max-height:/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });
});

describe("status.html", () => {
  it("has no Docker screen — the app runs its own database (Phase 3)", () => {
    const { html } = loadPage("status.html");
    expect(codeOf(html)).not.toMatch(/db-unreachable|Docker/);
  });

  it("shows a multi-line cause whole and as text, not truncated at `startup failed: [`", () => {
    const detail = `${XSS}\n${ZOD}\n해결: 터미널에서 \`pnpm be:migrate\`를 실행한 뒤 다시 시도해 주세요.`;
    const { byId, sandbox } = loadPage("status.html", `?${new URLSearchParams({ state: "failed", detail })}`);
    const pre = byId.get("detail")!;
    expect(pre.tag).toBe("pre");
    expect(pre.hidden).toBe(false);
    expect(pre.textContent).toBe(detail);
    expect(sandbox.__pwned).toBeUndefined();
  });

  it("wraps the cause block instead of a single scrolling line, and bounds its height", () => {
    const { html } = loadPage("status.html");
    const rule = /\bpre\s*\{([^}]*)\}/.exec(html)?.[1] ?? "";
    expect(rule).toMatch(/white-space:\s*pre-wrap/);
    expect(rule).toMatch(/max-height:/);
  });

  it("has no HTML sink either — its detail also comes from subprocess stderr", () => {
    const { html } = loadPage("status.html");
    expect(codeOf(html)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|<button\b|<form\b/);
  });
});

describe("token.html (Phase 4 스펙 §6.4 — 첫 실행 게이트)", () => {
  type Bridge = { next(): Promise<unknown>; show(state: unknown): void };
  const bridgeOf = (sandbox: Record<string, unknown>) => sandbox.__damwha_token as Bridge;
  const TOKEN = "hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567";

  it("has no skip, no link element, no form, no IPC, no HTML sink, no inline handler", () => {
    const { html } = loadPage("token.html");
    const code = codeOf(html);
    for (const banned of [
      /건너뛰기|나중에|skip/i,
      /<a\b/i,
      /<form\b/i,
      /\b(href|src|action)\s*=/i,
      /ipcRenderer/,
      /require\(/,
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
      /\son\w+\s*=/i,
      /window\.open|location\s*=|location\.(assign|replace|href)/,
      /console\./,
    ]) {
      expect(code).not.toMatch(banned);
    }
  });

  it("has the three things the spec lists: the acceptance page, the token page, and one input with a confirm button", () => {
    const { html, byId } = loadPage("token.html");
    const code = codeOf(html);
    expect([...code.matchAll(/<button\b/gi)]).toHaveLength(3);
    expect([...code.matchAll(/<input\b/gi)]).toHaveLength(1);
    expect(code).toMatch(/<input\b[^>]*\btype="password"/);
    expect(byId.get("token")?.tag).toBe("input");
    expect(byId.get("confirm")?.tag).toBe("button");
    expect(byId.get("open-accept")?.tag).toBe("button");
    expect(byId.get("open-tokens")?.tag).toBe("button");
    // 어디로 가는지는 글자로 보인다. 여는 것은 main이 고정 주소로 한다(token-window.ts의 TOKEN_LINKS).
    expect(code).toContain("huggingface.co/pyannote/speaker-diarization-community-1");
    expect(code).toContain("huggingface.co/settings/tokens");
    // 닫으면 종료된다는 사실을 화면이 말한다 — 건너뛰기가 없으니 다른 출구를 숨기지 않는다.
    expect(code).toMatch(/창을 닫으면/);
  });

  it("shows HF's error text as text, character for character, and never parses it", () => {
    const { sandbox, byId } = loadPage("token.html");
    const message = `${CAUSES.hfTokenInvalid.text} (HTTP 401 — ${XSS})`;
    bridgeOf(sandbox).show({ busy: false, tone: "error", message });
    const status = byId.get("status")!;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe(message);
    expect(status.dataset.tone).toBe("error");
    expect(status.all().some((n) => n.tag === "img")).toBe(false);
    expect(sandbox.__pwned).toBeUndefined();
  });

  it("hides the status line when there is nothing to say", () => {
    const { sandbox, byId } = loadPage("token.html");
    bridgeOf(sandbox).show({ busy: false, tone: "warn", message: "토큰을 읽을 수 없어요 — 다시 입력해 주세요" });
    expect(byId.get("status")!.hidden).toBe(false);
    bridgeOf(sandbox).show({ busy: false, tone: null, message: null });
    expect(byId.get("status")!.hidden).toBe(true);
    expect(byId.get("status")!.textContent).toBe("");
  });

  it("locks the input and the confirm button while main is checking, and gives focus back after", () => {
    const { sandbox, byId } = loadPage("token.html");
    const input = byId.get("token")!;
    const confirm = byId.get("confirm")!;
    bridgeOf(sandbox).show({ busy: true, tone: "info", message: "확인하는 중" });
    expect(input.disabled).toBe(true);
    expect(confirm.disabled).toBe(true);
    // 링크는 확인 중에도 열 수 있다.
    expect(byId.get("open-accept")!.disabled).toBe(false);
    const focusedBefore = input.focusCount;
    bridgeOf(sandbox).show({ busy: false, tone: "error", message: "x" });
    expect(input.disabled).toBe(false);
    expect(confirm.disabled).toBe(false);
    expect(input.focusCount).toBeGreaterThan(focusedBefore);
  });

  it("answers main's ask with the typed token when confirm is clicked, and locks itself at once", async () => {
    const { sandbox, byId } = loadPage("token.html");
    const asked = bridgeOf(sandbox).next();
    byId.get("token")!.value = TOKEN;
    byId.get("confirm")!.fire("click");
    await expect(asked).resolves.toEqual({ kind: "submit", token: TOKEN });
    expect(byId.get("confirm")!.disabled).toBe(true);
    // 두 번 눌러도 두 번 보내지 않는다.
    byId.get("confirm")!.disabled = false;
    byId.get("confirm")!.fire("click");
    const second = bridgeOf(sandbox).next();
    let got: unknown = "pending";
    void second.then((v) => (got = v));
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toBe("pending");
  });

  it("submits on Enter, but not while an input method is composing", async () => {
    const { sandbox, byId } = loadPage("token.html");
    const input = byId.get("token")!;
    input.value = TOKEN;
    input.fire("keydown", { key: "Enter", isComposing: true });
    const asked = bridgeOf(sandbox).next();
    let got: unknown = "pending";
    void asked.then((v) => (got = v));
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toBe("pending");
    expect(input.fire("keydown", { key: "Enter", isComposing: false })).toBe(true);
    await expect(asked).resolves.toEqual({ kind: "submit", token: TOKEN });
  });

  it("keeps an action that happens before main asks, instead of dropping it", async () => {
    const { sandbox, byId } = loadPage("token.html");
    byId.get("open-tokens")!.fire("click");
    byId.get("open-accept")!.fire("click");
    await expect(bridgeOf(sandbox).next()).resolves.toEqual({ kind: "open", link: "tokens" });
    await expect(bridgeOf(sandbox).next()).resolves.toEqual({ kind: "open", link: "accept" });
  });

  it("sends only a link key for the two pages — never an address", async () => {
    const { sandbox, byId } = loadPage("token.html");
    bridgeOf(sandbox).show({ busy: true, tone: "info", message: "확인하는 중" });
    const asked = bridgeOf(sandbox).next();
    byId.get("open-accept")!.fire("click");
    await expect(asked).resolves.toEqual({ kind: "open", link: "accept" });
  });
});

describe("Content-Security-Policy — 둘째 겹 (스펙 §6.11, Task 14 fix 1-5)", () => {
  const sha = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

  // 새 셸 페이지를 여기 더하지 않으면 그 페이지는 이 불변식을 하나도 받지 않는다. token.html은 HF의 오류
  // 문구 — 앱 밖에서 온 문자열 — 를 화면에 올리는 페이지라 가장 필요한 자리다 (Task 6).
  it("covers every page in shell/", () => {
    const pages = fs.readdirSync(path.join(__dirname, "..", "..", "shell")).filter((f) => f.endsWith(".html")).sort();
    expect(pages).toEqual(["services.html", "status.html", "token.html"]);
  });

  for (const file of ["services.html", "status.html", "token.html"]) {
    describe(file, () => {
      const html = fs.readFileSync(path.join(__dirname, "..", "..", "shell", file), "utf8");
      const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
      const directives = new Map(
        csp
          .split(";")
          .map((d) => d.trim().split(/\s+/))
          .filter((d) => d[0] !== "")
          .map(([name, ...values]) => [name, values] as const),
      );

      it("allows exactly this file's inline script and style by hash — a stale hash would blank the page", () => {
        const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
        const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
        expect(directives.get("script-src")).toEqual([sha(script)]);
        expect(directives.get("style-src")).toEqual([sha(style)]);
      });

      it("denies everything else: no inline handlers, no eval, no remote or data sources", () => {
        expect(directives.get("default-src")).toEqual(["'none'"]);
        expect(directives.get("base-uri")).toEqual(["'none'"]);
        expect(directives.get("form-action")).toEqual(["'none'"]);
        expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|https?:|data:|blob:|\*/);
      });

      it("is declared before the style and script it governs", () => {
        const at = html.indexOf("Content-Security-Policy");
        expect(at).toBeGreaterThan(-1);
        expect(at).toBeLessThan(html.indexOf("<style>"));
        expect(at).toBeLessThan(html.indexOf("<script>"));
      });
    });
  }
});
