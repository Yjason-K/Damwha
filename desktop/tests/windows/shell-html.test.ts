import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { describe, expect, it } from "vitest";
import { PILL_COMPACT, PILL_HOVER } from "../../src/windows/pill-view";
import { CAUSES } from "../../src/diagnostics/causes";
import { servicesView } from "../../src/windows/status-view";
import { RETRY_LAYERS } from "../../src/windows/shell-hints";
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
  /** className 위에 얹은 classList — 알약이 hover 클래스를 켜고 끈다. */
  readonly classList = {
    add: (name: string) => {
      if (!this.hasClass(name)) this.className = `${this.className} ${name}`.trim();
    },
    remove: (name: string) => {
      this.className = this.className.split(/\s+/).filter((c) => c && c !== name).join(" ");
    },
    contains: (name: string) => this.hasClass(name),
  };
  private hasClass(name: string): boolean {
    return this.className.split(/\s+/).includes(name);
  }
  focus(): void {
    this.focusCount += 1;
  }
  /** 사람의 동작을 흉내 낸다. 진짜 브라우저처럼 비활성 컨트롤은 click을 받지 않는다. 기본 동작을 막았는지 돌려준다. */
  fire(type: string, fields: Record<string, unknown> = {}): boolean {
    if (type === "click" && this.disabled) return false;
    let prevented = false;
    const event = {
      type,
      target: this,
      button: 0,
      preventDefault: () => void (prevented = true),
      stopPropagation: () => {},
      ...fields,
    };
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
  // 가짜 시계와 타이머 — 알약의 경과 시간·200ms 대기를 실제로 기다리지 않고 건다.
  const clock = { now: 1_800_000_000_000 };
  class FakeDate extends Date {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock.now);
      else super(...(args as [number]));
    }
    static now(): number {
      return clock.now;
    }
  }
  let timerId = 0;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  const addTimer = (fn: () => void, ms: number, every?: number) => {
    timers.set(++timerId, { at: clock.now + ms, fn, every });
    return timerId;
  };
  /** 시계를 ms만큼 흘리며 기한이 된 타이머를 순서대로 부른다. */
  const advance = (ms: number) => {
    const end = clock.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void; every?: number }] | undefined;
      for (const entry of timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      const [id, t] = next;
      clock.now = t.at;
      if (t.every) t.at += t.every;
      else timers.delete(id);
      t.fn();
    }
    clock.now = end;
  };
  const windowListeners: Record<string, Array<(event: unknown) => void>> = {};
  const windowFire = (type: string, fields: Record<string, unknown> = {}) => {
    for (const l of windowListeners[type] ?? []) l({ type, button: 0, ...fields });
  };
  const document = {
    body,
    documentElement: new FakeNode("html"),
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
  const sandbox: Record<string, unknown> = {
    document,
    location: { search },
    URLSearchParams,
    Date: FakeDate,
    innerWidth: 104,
    innerHeight: 32,
    setTimeout: (fn: () => void, ms: number) => addTimer(fn, ms),
    clearTimeout: (id: number) => void timers.delete(id),
    setInterval: (fn: () => void, ms: number) => addTimer(fn, ms, ms),
    clearInterval: (id: number) => void timers.delete(id),
    addEventListener: (type: string, l: (event: unknown) => void) => void (windowListeners[type] ??= []).push(l),
  };
  sandbox.window = sandbox;
  vm.runInNewContext(scripts[0][2], sandbox);
  return { html, sandbox, byId, body, root: document.documentElement, clock, advance, windowFire };
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
    // "서비스 다시 시작"(§6.10 2층)을 **여기** 두라고 정한다. 앱은 HF 토큰을 쓰지 않는다 —
    // 화자 분리 모델이 앱에 실려 온다(스펙 2026-09-30). 바뀌지 않은 것은 그 아래다: 입력칸도
    // 폼도 링크도 IPC도 없고, 동작은 main이 거는 next()의 반환값으로만 나간다.
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
   * Task 11 — 이 창이 사람에게 주는 두 가지: 모델 준비, 그리고 **층이 갈린** 재시도.
   * 페이지가 그 둘을 실제로 그리고, 누른 것이 main의 next()로 나가는지를 본다.
   */
  describe("Task 11 — 모델 준비·재시도 2층 버튼", () => {
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

    it("has no token section — the app does not use an HF token (스펙 2026-09-30 §5.1)", () => {
      const { byId, html } = loadPage("services.html");
      expect(byId.has("token")).toBe(false);
      expect(byId.has("token-value")).toBe(false);
      expect(html).not.toContain("허깅페이스 토큰");
      expect(codeOf(html)).not.toMatch(/\.token\b/);
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

describe("detect.html", () => {
  const view = (title: string, buttons: Array<{ label: string; action: string; primary: boolean }>, detail = "") => ({
    token: 7,
    title,
    detail,
    buttons,
  });

  it("has no form, input, link, IPC, or HTML sink", () => {
    const code = codeOf(loadPage("detect.html").html);
    for (const banned of [
      /<form\b/i,
      /<input\b/i,
      /<a\b/i,
      /ipcRenderer/,
      /require\(/,
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
      /\son\w+\s*=/i,
      /\b(href|src|action)\s*=/i,
      /window\.open|location\s*=|location\.(assign|replace|href)/,
    ]) {
      expect(code).not.toMatch(banned);
    }
  });

  it("shows strings as text and answers { token, action } through next()", async () => {
    const { sandbox, byId } = loadPage("detect.html");
    const render = sandbox.__damwha_detect_render as (v: unknown) => void;
    const next = (sandbox.__damwha_detect as { next(): Promise<unknown> }).next;
    render(view(XSS, [{ label: "녹음 시작", action: "start", primary: true }, { label: "닫기", action: "dismiss", primary: false }], XSS));
    expect(byId.get("text")!.textContent).toBe(XSS + XSS);
    expect(sandbox.__pwned).toBeUndefined();
    const act = byId.get("act")!;
    expect(act.hidden).toBe(false);
    act.children[0].fire("click");
    await expect(next()).resolves.toEqual({ token: 7, action: "start" });
  });

  it("locks every button after a press until the next render", async () => {
    const { sandbox, byId } = loadPage("detect.html");
    const render = sandbox.__damwha_detect_render as (v: unknown) => void;
    const next = (sandbox.__damwha_detect as { next(): Promise<unknown> }).next;
    render(view("t", [{ label: "a", action: "start", primary: true }, { label: "b", action: "dismiss", primary: false }]));
    const act = byId.get("act")!;
    act.children[0].fire("click");
    expect(act.children.every((b) => b.disabled)).toBe(true);
    act.children[1].fire("click");
    await next();
    // 두 번째 클릭은 큐에 들어가지 않았다 — 다음 묻기는 새 답을 기다린다.
    let settled = false;
    void next().then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    render(view("t2", [{ label: "c", action: "stop", primary: false }]));
    expect(byId.get("act")!.children[0].disabled).toBe(false);
  });

  it("hides the button row when the view has no buttons", () => {
    const { sandbox, byId } = loadPage("detect.html");
    (sandbox.__damwha_detect_render as (v: unknown) => void)(view("녹음된 내용이 없어요", []));
    expect(byId.get("act")!.hidden).toBe(true);
  });
});

describe("pill.html", () => {
  const LABELS = { stop: "중지", open: "담화 열기" };
  const setup = (startedAtAgoSec = 0) => {
    const page = loadPage("pill.html");
    const render = page.sandbox.__damwha_pill_render as (v: unknown) => void;
    const next = (page.sandbox.__damwha_pill as { next(): Promise<unknown> }).next;
    const draw = (token = 3, agoSec = startedAtAgoSec) =>
      render({ token, startedAt: page.clock.now - agoSec * 1000, ...LABELS });
    return { ...page, render, next, draw, pill: page.byId.get("pill")!, open: page.byId.get("open")!, stop: page.byId.get("stop")! };
  };
  /** 지금까지 쌓인 답 n개를 순서대로 꺼낸다. */
  const take = async (next: () => Promise<unknown>, n: number) => {
    const out: unknown[] = [];
    for (let i = 0; i < n; i += 1) out.push(await next());
    return out;
  };
  /** 더 쌓인 답이 없는가. 남는 대기자가 다음 답을 삼키므로 테스트 맨 끝에서만 쓴다. */
  const idle = async (next: () => Promise<unknown>) => {
    let settled = false;
    void next().then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 0));
    return !settled;
  };

  it("has no form, input, link, IPC, or HTML sink", () => {
    const code = codeOf(loadPage("pill.html").html);
    for (const banned of [
      /<form\b/i,
      /<input\b/i,
      /<a\b/i,
      /ipcRenderer/,
      /require\(/,
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
      /\son\w+\s*=/i,
      /\b(href|src|action)\s*=/i,
      /window\.open|location\s*=|location\.(assign|replace|href)/,
    ]) {
      expect(code).not.toMatch(banned);
    }
  });

  it("본문과 중지는 형제이고 중지가 앞이다 — role=button 안의 버튼은 ARIA에서 사라진다", () => {
    const { html } = setup();
    expect(html).toMatch(/<div id="pill"><button id="stop"><\/button><div id="open" role="button">.*<\/div><\/div>/);
  });

  it("중지는 늘어난 왼쪽 자리에만 놓이고 줄어든 자리는 본문이 그대로 차지한다", () => {
    const { html } = setup();
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1].replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string) => new RegExp(`(?:^|\\s)${selector}\\s*\\{([^}]*)\\}`, "m").exec(style)![1];
    const px = (decls: string, name: string) => Number(new RegExp(`(?:^|[\\s;])${name}:\\s*(\\d+)px`).exec(decls)![1]);
    const grown = PILL_HOVER.width - PILL_COMPACT.width;
    const BORDER = 1;

    // 오른쪽에 붙고, 창이 아직 좁으면 중지는 왼쪽 바깥으로 밀려 잘린다.
    expect(rule("#pill")).toMatch(/justify-content:\s*flex-end/);
    expect(rule("#pill")).toMatch(/overflow:\s*hidden/);
    // 본문은 호버와 상관없이 너비가 같아 점·시간이 움직이지 않는다.
    expect(rule("#open")).toMatch(/flex:\s*none/);
    expect(px(rule("#open"), "width")).toBe(PILL_COMPACT.width - 2 * BORDER);
    // 중지의 오른쪽 끝이 줄어든 자리의 왼쪽 끝을 넘지 않는다.
    const stop = rule("#stop");
    expect(stop).not.toMatch(/position:/);
    expect(px(stop, "margin-right")).toBeGreaterThanOrEqual(BORDER);
    expect(px(stop, "width") + px(stop, "margin-right")).toBeLessThanOrEqual(grown - BORDER);
  });

  it("왼쪽 버튼이 아니면 열기·드래그를 시작하지 않는다", async () => {
    const { draw, next, open, windowFire } = setup();
    draw(2);
    open.fire("mousedown", { button: 2, screenX: 100, screenY: 100 });
    windowFire("mousemove", { button: 2, screenX: 150, screenY: 100 });
    windowFire("mouseup", { button: 2, screenX: 150, screenY: 100 });
    expect(await idle(next)).toBe(true);
  });

  it("왼쪽으로 누른 뒤 다른 버튼을 떼도 클릭이 끝나지 않는다", async () => {
    const { draw, next, open, windowFire } = setup();
    draw(2);
    open.fire("mousedown", { screenX: 100, screenY: 100 });
    windowFire("mouseup", { button: 2, screenX: 100, screenY: 100 });
    expect(await idle(next)).toBe(true);
  });

  it("경과 시간은 m:ss, 1시간부터 h:mm:ss", () => {
    const { draw, byId, advance } = setup();
    draw(1, 754);
    expect(byId.get("time")!.textContent).toBe("12:34");
    draw(1, 3754);
    expect(byId.get("time")!.textContent).toBe("1:02:34");
    // 1초마다 다시 그린다.
    advance(1000);
    expect(byId.get("time")!.textContent).toBe("1:02:35");
  });

  it("문구는 글자로만 넣고 본문에 aria-label을 단다", () => {
    const { render, clock, byId, open, stop } = setup();
    render({ token: 1, startedAt: clock.now, stop: XSS, open: XSS });
    expect(stop.textContent).toBe(XSS);
    expect(open.dataset["attr:aria-label"]).toBe(XSS);
    expect(open.dataset["attr:role"]).toBeUndefined();
    expect(byId.get("pill")!.children.some((n) => n.tag === "img")).toBe(false);
  });

  it("중지는 호버 전에는 숨어 있다", () => {
    const { html, pill, draw, root } = setup();
    draw();
    expect(pill.classList.contains("hover")).toBe(false);
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1].replace(/\/\*[\s\S]*?\*\//g, "");
    expect(style).toMatch(/#stop\s*\{[^}]*display:\s*none/);
    expect(style).toMatch(/#pill\.hover\s+#stop\s*\{[^}]*display:\s*(?!none)/);
    root.fire("mouseenter");
    expect(pill.classList.contains("hover")).toBe(true);
  });

  it("4px 미만 움직임은 open, 4px 이상은 drag와 drop", async () => {
    const { draw, next, pill, open, windowFire } = setup();
    draw(5);
    // 4px 미만(약 2.2px): 클릭이다.
    open.fire("mousedown", { screenX: 100, screenY: 100 });
    windowFire("mousemove", { screenX: 102, screenY: 101 });
    windowFire("mouseup", { screenX: 102, screenY: 101 });
    // 4px 이상: 첫 움직임은 시작점 기준, 이어지는 것은 직전 지점 기준이다.
    open.fire("mousedown", { screenX: 200, screenY: 200 });
    windowFire("mousemove", { screenX: 210, screenY: 200 });
    windowFire("mousemove", { screenX: 212, screenY: 205 });
    windowFire("mouseup", { screenX: 212, screenY: 205 });
    // 끝난 뒤의 움직임·mouseup은 아무것도 보내지 않는다.
    windowFire("mousemove", { screenX: 300, screenY: 300 });
    windowFire("mouseup", { screenX: 300, screenY: 300 });
    expect(await take(next, 4)).toEqual([
      { token: 5, action: "open" },
      { token: 5, ui: "drag", dx: 10, dy: 0 },
      { token: 5, ui: "drag", dx: 2, dy: 5 },
      { token: 5, ui: "drop" },
    ]);
    expect(await idle(next)).toBe(true);
  });

  it("중지 위의 mousedown은 열기·드래그를 시작하지 않는다", async () => {
    const { draw, next, stop, windowFire } = setup();
    draw(2);
    stop.fire("mousedown", { screenX: 10, screenY: 10 });
    windowFire("mousemove", { screenX: 50, screenY: 50 });
    windowFire("mouseup", { screenX: 50, screenY: 50 });
    expect(await idle(next)).toBe(true);
  });

  it("leave는 200ms 뒤에 나가고 그 안에 돌아오면 취소된다", async () => {
    const { draw, next, root, pill, advance } = setup();
    draw(4);
    root.fire("mouseenter");
    expect(await take(next, 1)).toEqual([{ token: 4, ui: "hover", on: true }]);

    root.fire("mouseleave");
    advance(199);
    expect(pill.classList.contains("hover")).toBe(true);
    advance(1);
    expect(pill.classList.contains("hover")).toBe(false);
    expect(await take(next, 1)).toEqual([{ token: 4, ui: "hover", on: false }]);

    // 돌아오면 취소: 다시 늘어나지도, leave를 보내지도 않는다.
    root.fire("mouseenter");
    root.fire("mouseleave");
    advance(100);
    root.fire("mouseenter");
    advance(1000);
    expect(pill.classList.contains("hover")).toBe(true);
    expect(await take(next, 1)).toEqual([{ token: 4, ui: "hover", on: true }]);
    expect(await idle(next)).toBe(true);
  });

  it("드래그 중에는 leave를 보내지 않는다", async () => {
    const { draw, next, root, pill, open, advance, windowFire } = setup();
    draw(6);
    root.fire("mouseenter");
    open.fire("mousedown", { screenX: 100, screenY: 100 });
    windowFire("mousemove", { screenX: 120, screenY: 100 });
    root.fire("mouseleave");
    advance(1000);
    expect(pill.classList.contains("hover")).toBe(true);
    expect(await take(next, 2)).toEqual([
      { token: 6, ui: "hover", on: true },
      { token: 6, ui: "drag", dx: 20, dy: 0 },
    ]);
    expect(await idle(next)).toBe(true);
  });

  it("4px 전의 누름 중에도 leave가 알약을 접지 않는다", async () => {
    const { draw, next, root, pill, open, advance, windowFire } = setup();
    draw(6);
    root.fire("mouseenter");
    open.fire("mousedown", { screenX: 100, screenY: 100 });
    windowFire("mousemove", { screenX: 102, screenY: 100 });
    root.fire("mouseleave");
    advance(1000);
    expect(pill.classList.contains("hover")).toBe(true);
    expect(await take(next, 1)).toEqual([{ token: 6, ui: "hover", on: true }]);
    expect(await idle(next)).toBe(true);
  });

  it("창 밖에서 끝난 클릭도 알약을 접는다", async () => {
    const { draw, next, root, pill, open, advance, windowFire } = setup();
    draw(6);
    root.fire("mouseenter");
    open.fire("mousedown", { screenX: 100, screenY: 100 });
    root.fire("mouseleave");
    windowFire("mouseup", { screenX: 101, screenY: 100, clientX: 150, clientY: 10 });
    advance(200);
    expect(pill.classList.contains("hover")).toBe(false);
    expect(await take(next, 3)).toEqual([
      { token: 6, ui: "hover", on: true },
      { token: 6, action: "open" },
      { token: 6, ui: "hover", on: false },
    ]);
  });

  it("mouseup을 잃은 드래그는 버튼이 풀린 움직임에서 drop으로 끝난다", async () => {
    const { draw, next, open, windowFire } = setup();
    draw(6);
    open.fire("mousedown", { screenX: 100, screenY: 100 });
    windowFire("mousemove", { buttons: 1, screenX: 120, screenY: 100 });
    windowFire("mousemove", { buttons: 0, screenX: 140, screenY: 100 });
    windowFire("mousemove", { buttons: 0, screenX: 160, screenY: 100 });
    windowFire("mouseup", { screenX: 160, screenY: 100 });
    expect(await take(next, 2)).toEqual([
      { token: 6, ui: "drag", dx: 20, dy: 0 },
      { token: 6, ui: "drop" },
    ]);
    expect(await idle(next)).toBe(true);
  });

  it("mouseup을 잃은 누름은 열지 않고 끝난다", async () => {
    const { draw, next, open, windowFire } = setup();
    draw(6);
    open.fire("mousedown", { screenX: 100, screenY: 100 });
    windowFire("mousemove", { buttons: 0, screenX: 101, screenY: 100 });
    windowFire("mouseup", { screenX: 101, screenY: 100 });
    expect(await idle(next)).toBe(true);
  });

  it("커서가 창 밖에서 드래그가 끝나면 알약이 늘어난 채 남지 않는다", async () => {
    const { draw, next, root, pill, open, advance, windowFire } = setup();
    draw(6);
    root.fire("mouseenter");
    open.fire("mousedown", { screenX: 100, screenY: 100 });
    windowFire("mousemove", { screenX: 120, screenY: 100 });
    root.fire("mouseleave");
    // 창(104x32) 밖에서 놓았다 — 이제 mouseleave는 오지 않는다.
    windowFire("mouseup", { screenX: 120, screenY: 100, clientX: 150, clientY: 10 });
    advance(200);
    expect(pill.classList.contains("hover")).toBe(false);
    expect(await take(next, 4)).toEqual([
      { token: 6, ui: "hover", on: true },
      { token: 6, ui: "drag", dx: 20, dy: 0 },
      { token: 6, ui: "drop" },
      { token: 6, ui: "hover", on: false },
    ]);
  });

  it("커서가 창 안에서 드래그가 끝나면 hover를 유지한다", async () => {
    const { draw, next, root, pill, open, advance, windowFire } = setup();
    draw(6);
    root.fire("mouseenter");
    open.fire("mousedown", { screenX: 100, screenY: 100 });
    windowFire("mousemove", { screenX: 120, screenY: 100 });
    windowFire("mouseup", { screenX: 120, screenY: 100, clientX: 50, clientY: 10 });
    advance(1000);
    expect(pill.classList.contains("hover")).toBe(true);
    expect(await take(next, 3)).toHaveLength(3);
    expect(await idle(next)).toBe(true);
  });

  it("중지를 누르면 다음 렌더까지 잠긴다", async () => {
    const { draw, next, stop } = setup();
    draw(8);
    stop.fire("click");
    expect(stop.disabled).toBe(true);
    stop.fire("click");
    expect(await take(next, 1)).toEqual([{ token: 8, action: "stop" }]);
    draw(9);
    expect(stop.disabled).toBe(false);
    stop.fire("click");
    expect(await take(next, 1)).toEqual([{ token: 9, action: "stop" }]);
  });

  it("-webkit-app-region을 쓰지 않는다", () => {
    expect(loadPage("pill.html").html).not.toContain("-webkit-app-region");
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
    expect(pages).toEqual(["detect.html", "pill.html", "services.html", "status.html"]);
  });

  for (const file of ["detect.html", "pill.html", "services.html", "status.html"]) {
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

  for (const file of ["detect.html", "pill.html", "services.html", "status.html"]) {
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
