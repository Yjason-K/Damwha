import { describe, expect, it, vi } from "vitest";
import {
  createLanguageBridge,
  UI_LANGUAGE_ASK_SCRIPT,
  uiLanguageShowCall,
  type LanguageBridgeDeps,
} from "../../src/windows/language-bridge";
import type { UiLanguage } from "../../src/i18n/locale";

/** 가짜 페이지 — next()로 돌려줄 값을 줄 세우고 show 호출을 모은다 (token-bridge.test.ts의 fakePage와 같은 모양). */
function fakePage() {
  const shown: string[] = [];
  const pending: Array<(v: unknown) => void> = [];
  let alive = true;
  let bridge = true;
  const run = vi.fn(async (_w: object, script: string): Promise<unknown> => {
    if (script === UI_LANGUAGE_ASK_SCRIPT) {
      if (!bridge) return null;
      return new Promise((r) => pending.push(r));
    }
    const m = /uiLanguage\?\.show\((.*)\);$/.exec(script);
    if (m) shown.push(JSON.parse(m[1]) as string);
    return undefined;
  });
  return {
    win: {},
    shown,
    run,
    pick(v: unknown) {
      pending.shift()?.(v);
    },
    get asking() {
      return pending.length;
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

const flush = () => new Promise((r) => setTimeout(r, 0));

function make(page: ReturnType<typeof fakePage>, over: Partial<LanguageBridgeDeps<object>> = {}) {
  const saved: UiLanguage[] = [];
  const changed: UiLanguage[] = [];
  const logs: string[] = [];
  const b = createLanguageBridge<object>({
    run: page.run,
    alive: () => page.alive,
    initial: () => "ko",
    save: (l) => saved.push(l),
    onChange: (l) => changed.push(l),
    log: (l) => logs.push(l),
    ...over,
  });
  return { b, saved, changed, logs };
}

describe("language-bridge", () => {
  it("show 호출문은 값을 JSON으로만 싣는다", () => {
    expect(uiLanguageShowCall("en")).toBe('void window.__damwha_desktop?.uiLanguage?.show("en");');
  });

  it("attach: 현재 값을 밀어 넣고 묻기 시작한다", async () => {
    const page = fakePage();
    const { b } = make(page);
    b.attach(page.win);
    await flush();
    expect(page.shown).toEqual(["ko"]);
    expect(page.asking).toBe(1);
  });

  it("사람이 고르면: 저장 → current → onChange → show → 다시 묻는다", async () => {
    const page = fakePage();
    const { b, saved, changed } = make(page);
    b.attach(page.win);
    await flush();
    page.pick("en");
    await flush();
    expect(saved).toEqual(["en"]);
    expect(b.current()).toBe("en");
    expect(changed).toEqual(["en"]);
    expect(page.shown).toEqual(["ko", "en"]);
    expect(page.asking).toBe(1);
  });

  it("같은 값이면 저장·onChange 없이 show만 한다", async () => {
    const page = fakePage();
    const { b, saved, changed } = make(page);
    b.attach(page.win);
    await flush();
    page.pick("ko");
    await flush();
    expect(saved).toEqual([]);
    expect(changed).toEqual([]);
    expect(page.shown).toEqual(["ko", "ko"]);
  });

  it("저장 실패 → current는 그대로, 이전 값을 show해 화면을 되돌린다, 로그를 남긴다", async () => {
    const page = fakePage();
    const { b, changed, logs } = make(page, {
      save: () => {
        throw new Error("EACCES");
      },
    });
    b.attach(page.win);
    await flush();
    page.pick("en");
    await flush();
    expect(b.current()).toBe("ko");
    expect(changed).toEqual([]);
    expect(page.shown).toEqual(["ko", "ko"]);
    expect(logs.join("\n")).toMatch(/EACCES|Error/);
    expect(page.asking).toBe(1); // 고리는 계속 돈다
  });

  it("모르는 값은 버리고 계속 묻는다", async () => {
    const page = fakePage();
    const { b, saved } = make(page);
    b.attach(page.win);
    await flush();
    page.pick("fr");
    await flush();
    expect(saved).toEqual([]);
    expect(b.current()).toBe("ko");
    expect(page.asking).toBe(1);
  });

  it("⌘R 재부착: 옛 세대의 답은 버린다", async () => {
    const page = fakePage();
    const { b, saved } = make(page);
    b.attach(page.win);
    await flush();
    b.attach(page.win); // 새 문서
    await flush();
    expect(page.asking).toBe(2);
    page.pick("en"); // 옛 고리의 묻기가 늦게 끝났다
    await flush();
    expect(saved).toEqual([]);
    expect(b.current()).toBe("ko");
    page.pick("en"); // 새 고리
    await flush();
    expect(saved).toEqual(["en"]);
  });

  it("다리가 없는 페이지(null)면 고리를 조용히 끝낸다", async () => {
    const page = fakePage();
    page.noBridge();
    const { b } = make(page);
    b.attach(page.win);
    await flush();
    expect(page.asking).toBe(0);
  });

  it("initial은 처음 쓸 때 한 번만 부른다", () => {
    const page = fakePage();
    const initial = vi.fn((): UiLanguage => "en");
    const { b } = make(page, { initial });
    expect(initial).not.toHaveBeenCalled();
    expect(b.current()).toBe("en");
    expect(b.current()).toBe("en");
    expect(initial).toHaveBeenCalledTimes(1);
  });
});
