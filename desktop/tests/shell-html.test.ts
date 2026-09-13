import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { describe, expect, it } from "vitest";
import { CAUSES } from "../src/causes";
import { servicesView } from "../src/status-view";
import type { ServiceStatus } from "../src/services/types";

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
  private ownText = "";

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
}

function loadPage(file: string, search = "") {
  const html = fs.readFileSync(path.join(__dirname, "..", "shell", file), "utf8");
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
    expect(rows[0].textContent).toContain("로그: /l/supervisor.log");
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

  it("keeps line breaks in the cause and bounds its height", () => {
    const { html } = loadPage("services.html");
    const rule = /\.cause\s*\{([^}]*)\}/.exec(html)?.[1] ?? "";
    expect(rule).toMatch(/white-space:\s*pre-wrap/);
    expect(rule).toMatch(/max-height:/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });
});

describe("status.html", () => {
  it("no longer tells the user to run `pnpm db:up` — the app starts Postgres itself (Phase 2)", () => {
    const { byId, html } = loadPage("status.html", "?state=db-unreachable");
    expect(codeOf(html)).not.toMatch(/db:up/);
    expect(byId.get("headline")!.textContent).toBe("데이터베이스에 연결할 수 없어요");
    // P2-C7의 문구: Docker Desktop.
    expect(byId.get("body")!.textContent).toMatch(/Docker Desktop이 실행 중인지/);
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

describe("Content-Security-Policy — 둘째 겹 (스펙 §6.11, Task 14 fix 1-5)", () => {
  const sha = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

  for (const file of ["services.html", "status.html"]) {
    describe(file, () => {
      const html = fs.readFileSync(path.join(__dirname, "..", "shell", file), "utf8");
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
