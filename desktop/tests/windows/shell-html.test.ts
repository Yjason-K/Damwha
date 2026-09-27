import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { describe, expect, it } from "vitest";
import { CAUSES } from "../../src/diagnostics/causes";
import { servicesView } from "../../src/windows/status-view";
import { RETRY_LAYERS } from "../../src/windows/shell-hints";
import { maskToken } from "../../src/config/token-store";
import { STALL_MS, type ReadinessEntry } from "../../src/services/model-readiness";
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
  /** 입력칸·버튼. */
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

  it("has no form, input, link, IPC, or HTML sink — 버튼은 생겼지만 채널은 여전히 없다 (스펙 §6.11 · §6.10)", () => {
    // Phase 2의 "버튼 0개"는 이 창에 사람이 할 일이 없던 때의 계약이다. Phase 4는
    // "서비스 다시 시작"(§6.10 2층)을 **여기** 두라고 정한다. 토큰 입력은 담화 화면으로 옮겼다
    // (스펙 2026-09-25 §5.4). 바뀌지 않은 것은 그 아래다: 입력칸도 폼도 링크도 IPC도 없고,
    // 동작은 main이 거는 next()의 반환값으로만 나간다.
    const { html } = loadPage("services.html");
    const code = codeOf(html);
    for (const banned of [
      /<form\b/i,
      /<input\b/i,
      /<a\b/i,
      /ipcRenderer/,
      /require\(/,
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
      /\son\w+\s*=/i,
      // 주소를 페이지가 고르지 않는다 — main이 고정 주소로 연다.
      /\b(href|src|action)\s*=/i,
      /window\.open|location\s*=|location\.(assign|replace|href)/,
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
        { ...failed, id: "worker", detail: CAUSES.modelDownloadStalled.text("BAAI/bge-m3") },
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
    expect(rows[1].textContent).toContain("진행이 멈췄어요");
    expect(rows[1].textContent).toContain("해결: ");
    expect(rows[1].textContent).toContain("서비스 다시 시작");
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

  /**
   * Task 11 — 이 창이 사람에게 주는 세 가지: 모델 준비, 토큰, 그리고 **층이 갈린** 재시도.
   * 페이지가 그 셋을 실제로 그리고, 누른 것이 main의 next()로 나가는지를 본다.
   */
  describe("Task 11 — 모델 준비·토큰·재시도 2층 버튼", () => {
    type Bridge = { next(): Promise<unknown> };
    const bridgeOf = (sandbox: Record<string, unknown>) => sandbox.__damwha_services as Bridge;
    const NOW = 1_800_000_000_000;
    const entry = (over: Partial<ReadinessEntry> = {}): ReadinessEntry => ({
      key: "BAAI/bge-m3",
      state: "downloading",
      bytesDone: 1024,
      bytesTotal: 4096,
      startedAt: NOW - 10_000,
      updatedAt: NOW - 1_000,
      writer: "embed",
      attempt: 1,
      error: null,
      errorKind: null,
      ...over,
    });
    const view = (over: Partial<Parameters<typeof servicesView>[0]> = {}) =>
      servicesView({
        statuses: [{ id: "embed", process: "running", health: "ok", owned: true, restarts: 0 }],
        restartNotice: null,
        logPathOf: (id) => `/l/${id}.log`,
        now: NOW,
        ...over,
      });

    it("받는 중인 모델과 진행을 보인다 (P4-C6)", () => {
      const { sandbox, byId } = loadPage("services.html");
      (sandbox.__damwha_render as (v: unknown) => void)(view({ modelReadiness: [entry()] }));
      expect(byId.get("models")!.hidden).toBe(false);
      expect(byId.get("models-title")!.hidden).toBe(false);
      const text = byId.get("models")!.textContent;
      expect(text).toContain("BAAI/bge-m3");
      expect(text).toContain("받는 중");
      expect(text).toContain("25%");
    });

    it("받는 모델이 없으면 그 절을 접는다", () => {
      const { sandbox, byId } = loadPage("services.html");
      (sandbox.__damwha_render as (v: unknown) => void)(view());
      expect(byId.get("models")!.hidden).toBe(true);
      expect(byId.get("models-title")!.hidden).toBe(true);
    });

    it("1층에는 버튼이 없고, 2층에는 있다 — 뭉치지 않는다 (스펙 §6.10)", () => {
      const buttonsIn = (v: unknown) => {
        const { sandbox, byId } = loadPage("services.html");
        (sandbox.__damwha_render as (x: unknown) => void)(v);
        return byId.get("models")!.all().filter((n) => n.tag === "button");
      };
      const transient = view({
        modelReadiness: [
          entry({ state: "failed", error: "model_download_failed: ReadTimeout", errorKind: "TRANSIENT" }),
        ],
      });
      expect(buttonsIn(transient)).toHaveLength(0);
      expect(transient.models[0].hint).toBe(RETRY_LAYERS.download);

      const stalled = view({ modelReadiness: [entry({ updatedAt: NOW - STALL_MS - 1 })] });
      const buttons = buttonsIn(stalled);
      expect(buttons).toHaveLength(1);
      expect(buttons[0].textContent).toBe("서비스 다시 시작");
    });

    it("서비스 줄의 다시 시작을 누르면 그 서비스가 next()로 나간다", async () => {
      const { sandbox, byId } = loadPage("services.html");
      (sandbox.__damwha_render as (v: unknown) => void)(view());
      const asked = bridgeOf(sandbox).next();
      const button = byId.get("rows")!.all().find((n) => n.tag === "button")!;
      button.fire("click");
      await expect(asked).resolves.toEqual({ kind: "restart", service: "embed" });
      // 두 번 눌러도 두 번 나가지 않는다 — worker에게 두 번째 종료 신호는 강제 종료다.
      expect(button.disabled).toBe(true);
    });

    it("앱이 소유하지 않은 서비스의 버튼은 눌리지 않고 까닭이 화면에 있다", async () => {
      const { sandbox, byId } = loadPage("services.html");
      const adopted = view({
        statuses: [{ id: "embed", process: "running", health: "ok", owned: false, restarts: 0 }],
      });
      (sandbox.__damwha_render as (v: unknown) => void)(adopted);
      const button = byId.get("rows")!.all().find((n) => n.tag === "button")!;
      expect(button.disabled).toBe(true);
      expect(button.fire("click")).toBe(false);
      expect(byId.get("rows")!.textContent).toContain("앱이 내릴 수 없어요");
      let got: unknown = "pending";
      void bridgeOf(sandbox).next().then((v) => (got = v));
      await new Promise((r) => setTimeout(r, 0));
      expect(got).toBe("pending");
    });

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

    it("worker의 실패 문구도 글자로만 넣는다 — 그것은 HF가 보낸 남의 문자열이다", () => {
      const { sandbox, byId } = loadPage("services.html");
      (sandbox.__damwha_render as (v: unknown) => void)(
        view({
          modelReadiness: [
            entry({ state: "failed", error: `model_download_failed: ${XSS}`, errorKind: "PERMANENT" }),
          ],
        }),
      );
      const cause = byId.get("models")!.all().find((n) => n.className === "cause")!;
      expect(cause.textContent).toContain(XSS);
      expect(sandbox.__pwned).toBeUndefined();
    });
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

  it("shows progress and no retry hint while starting or quitting (Notion P2-B)", () => {
    for (const state of ["starting", "quitting"]) {
      const { byId } = loadPage("status.html", `?state=${state}`);
      expect(byId.get("progress")!.hidden).toBe(false);
      expect(byId.get("hint")!.hidden).toBe(true);
    }
  });

  it("stops the progress and offers the retry path on failure — also for an unknown state", () => {
    for (const state of ["failed", "bogus"]) {
      const { byId } = loadPage("status.html", `?${new URLSearchParams({ state, logPath: "/logs/api.log" })}`);
      expect(byId.get("progress")!.hidden).toBe(true);
      expect(byId.get("hint")!.hidden).toBe(false);
      expect(byId.get("hint")!.textContent).toContain("/logs/api.log");
      expect(byId.get("hint")!.textContent).toContain("다시 시도");
    }
  });
});

describe("Content-Security-Policy — 둘째 겹 (스펙 §6.11, Task 14 fix 1-5)", () => {
  const sha = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

  // 새 셸 페이지를 여기 더하지 않으면 그 페이지는 이 불변식을 하나도 받지 않는다. worker의 실패
  // 문구 — 앱 밖에서 온 문자열 — 를 화면에 올리는 services.html이 특히 이 불변식이 필요한 페이지다.
  it("covers every page in shell/", () => {
    const pages = fs.readdirSync(path.join(__dirname, "..", "..", "shell")).filter((f) => f.endsWith(".html")).sort();
    expect(pages).toEqual(["services.html", "status.html"]);
  });

  for (const file of ["services.html", "status.html"]) {
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

describe("design tokens — fe/src/index.css와 같은 값 (Notion P2-B)", () => {
  // 셸 페이지는 CSP상 fe의 CSS를 불러올 수 없어 토큰을 같은 이름으로 옮겨 적는다. 옮겨 적은 값은 fe가
  // 토큰을 바꾸는 날 조용히 뒤처진다 — 이 테스트가 그날을 잡는다.
  const feCss = fs.readFileSync(path.join(__dirname, "..", "..", "..", "fe", "src", "index.css"), "utf8");
  const declsOf = (css: string) => {
    const out = new Map<string, string>();
    for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      if (!out.has(m[1])) out.set(m[1], m[2].replace(/\s+/g, " ").trim());
    }
    return out;
  };
  const fe = declsOf(feCss);
  const resolve = (value: string, depth = 0): string =>
    depth > 10
      ? value
      : value.replace(/var\(--([\w-]+)\)/g, (_, name: string) => resolve(fe.get(name) ?? `<fe에 없음: --${name}>`, depth + 1));
  // fe의 .dark 블록 — 다크에서는 거기 있는 이름이 :root 값을 덮는다.
  const feDark = declsOf(/^\.dark\s*\{([^}]*)\}/m.exec(feCss)![1]);
  const resolveDark = (value: string, depth = 0): string =>
    depth > 10
      ? value
      : value.replace(/var\(--([\w-]+)\)/g, (_, name: string) =>
          resolveDark(feDark.get(name) ?? fe.get(name) ?? `<fe에 없음: --${name}>`, depth + 1),
        );
  const DARK_MEDIA = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/;
  const isColour = (v: string) => /^#|^rgba?\(/.test(v);

  for (const file of ["services.html", "status.html"]) {
    describe(file, () => {
      const html = fs.readFileSync(path.join(__dirname, "..", "..", "shell", file), "utf8");
      const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1].replace(/\/\*[\s\S]*?\*\//g, "");
      const rootBlock = /:root\s*\{([^}]*)\}/.exec(style)![1];
      const shell = declsOf(rootBlock);
      const darkBlock = DARK_MEDIA.exec(style)?.[1] ?? "";
      const shellDark = declsOf(darkBlock);

      it("copies each token with the same name and the value fe resolves it to", () => {
        expect(shell.size).toBeGreaterThan(0);
        for (const [name, value] of shell) expect({ name, value }).toEqual({ name, value: resolve(`var(--${name})`) });
      });

      it("writes no colour outside :root and uses only tokens it declares", () => {
        const rest = style.replace(DARK_MEDIA, "").replace(/:root\s*\{[^}]*\}/, "");
        expect(rest).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
        for (const m of rest.matchAll(/var\(--([\w-]+)\)/g)) expect(shell.has(m[1]), `--${m[1]}`).toBe(true);
      });

      it("follows macOS dark with the colour tokens fe resolves under .dark", () => {
        expect(darkBlock, "@media (prefers-color-scheme: dark) { :root { … } } 블록").not.toBe("");
        expect(darkBlock).toMatch(/color-scheme:\s*dark;/);
        const colourNames = [...shell].filter(([, v]) => isColour(v)).map(([n]) => n).sort();
        expect([...shellDark.keys()].sort()).toEqual(colourNames);
        for (const [name, value] of shellDark) {
          expect({ name, value }).toEqual({ name, value: resolveDark(`var(--${name})`) });
        }
      });

      it("declares light as the base scheme — the dark block only overrides", () => {
        expect(rootBlock).toMatch(/color-scheme:\s*light;/);
      });
    });
  }
});
