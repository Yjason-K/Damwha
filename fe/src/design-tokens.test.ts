import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, ".");

/**
 * `var(--x)`가 `index.css`에 정의되지 않으면 CSS 엔진이 그 선언을 통째로
 * 버린다 — 빌드도 린트도 테스트도 통과하고, 화면에서만 조용히 다른 색이
 * 나온다. 실제로 `--red-6`이 그렇게 몇 달을 살아남았다.
 *
 * 정적으로 쓴 토큰만 본다. `var(--spk-${k}-solid)` 같은 템플릿 보간은
 * 종료 문자가 `$`라 아래 정규식이 걸러낸다.
 */
const STATIC_VAR = /var\(\s*(--[a-z0-9-]+)\s*[,)]/g;

/** Radix가 런타임에 주입하는 값이라 index.css에 없다. */
const RUNTIME_INJECTED = /^--radix-/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    // 테스트 파일은 스캔하지 않는다 — 픽스처가 실재하지 않는 토큰을 들 수 있고,
    // 이 파일 자신의 주석에 적힌 예시도 걸린다.
    if (/\.test\.(tsx?)$/.test(e.name)) return [];
    return /\.(tsx?|css)$/.test(e.name) ? [p] : [];
  });
}

describe("디자인 토큰", () => {
  it("소스가 참조하는 CSS 변수는 모두 index.css에 정의되어 있다", () => {
    const css = readFileSync(join(SRC, "index.css"), "utf8");
    const defined = new Set(
      [...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]),
    );

    const missing: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith("index.css")) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(STATIC_VAR)) {
        const token = m[1];
        if (defined.has(token) || RUNTIME_INJECTED.test(token)) continue;
        const line = text.slice(0, m.index).split("\n").length;
        missing.push(`${file.slice(SRC.length + 1)}:${line} → ${token}`);
      }
    }

    expect(missing).toEqual([]);
  });

  it(".dark 블록은 :root에 있는 변수만 덮는다 — 없는 이름을 덮으면 조용히 무시된다", () => {
    const css = readFileSync(join(SRC, "index.css"), "utf8");
    const block = (selector: RegExp) => {
      const m = selector.exec(css);
      expect(m, String(selector)).not.toBeNull();
      return new Set(
        [...m![1].matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((x) => x[1]),
      );
    };
    const root = block(/^:root\s*\{([^}]*)\}/m);
    const dark = block(/^\.dark\s*\{([^}]*)\}/m);
    expect(dark.size).toBeGreaterThan(40);
    expect([...dark].filter((t) => !root.has(t))).toEqual([]);
  });

  it("다크에서 뒤집히는 역할 토큰은 .dark가 모두 다시 정의한다", () => {
    const css = readFileSync(join(SRC, "index.css"), "utf8");
    const dark = /^\.dark\s*\{([^}]*)\}/m.exec(css)![1];
    for (const token of [
      "--gray-0",
      "--gray-12",
      "--accent-9",
      "--accent-11",
      "--text-on-accent",
      "--surface-floating",
      "--text-on-floating",
      "--text-on-floating-muted",
      "--overlay-hover",
      "--surface-scrim-soft",
      "--surface-overlay",
      "--shadow-md",
      "--spk-1-bg",
      "--spk-8-text",
    ]) {
      expect(dark, token).toMatch(new RegExp(`^\\s*${token}\\s*:`, "m"));
    }
  });
});
