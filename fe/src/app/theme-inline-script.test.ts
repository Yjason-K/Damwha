import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  THEME_STORAGE_KEY,
  parsePreference,
  resolveTheme,
} from "@/shared/lib/theme";

/**
 * index.html의 **실제** 인라인 스크립트를 뽑아 돌린다. 그 스크립트는 모듈을 import할 수 없어
 * theme.ts의 규칙을 한 벌 더 들고 있다 — 여기서 둘이 같은 답을 내는지 묶는다.
 */
const html = readFileSync(
  join(import.meta.dirname, "..", "..", "index.html"),
  "utf8",
);
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
  (m) => m[1],
);

type Case = {
  stored: string | null;
  systemDark: boolean;
  storageThrows?: boolean;
  noMatchMedia?: boolean;
};

function run(c: Case) {
  const classes = new Set<string>();
  const style: Record<string, string> = {};
  const sandbox: Record<string, unknown> = {
    localStorage: {
      getItem(key: string) {
        if (c.storageThrows) throw new Error("SecurityError");
        return key === THEME_STORAGE_KEY ? c.stored : null;
      },
    },
    document: {
      documentElement: {
        classList: { add: (n: string) => classes.add(n) },
        style,
      },
    },
  };
  if (!c.noMatchMedia) {
    sandbox.matchMedia = (q: string) => ({
      matches: q === "(prefers-color-scheme: dark)" && c.systemDark,
    });
  }
  runInNewContext(inline[0], sandbox);
  return { dark: classes.has("dark"), colorScheme: style.colorScheme };
}

function expected(c: Case) {
  const pref = c.storageThrows ? "system" : parsePreference(c.stored);
  const resolved = resolveTheme(pref, c.noMatchMedia ? false : c.systemDark);
  return { dark: resolved === "dark", colorScheme: resolved };
}

describe("index.html 첫 페인트 스크립트", () => {
  it("속성 없는 인라인 스크립트가 딱 하나이고, 모듈 스크립트보다 먼저 온다", () => {
    expect(inline).toHaveLength(1);
    expect(html.indexOf("<script>")).toBeLessThan(
      html.indexOf('<script type="module"'),
    );
  });

  const stored = [null, "system", "light", "dark", "Dark", ""];
  for (const s of stored) {
    for (const systemDark of [false, true]) {
      const c = { stored: s, systemDark };
      it(`저장값=${JSON.stringify(s)} 시스템 다크=${systemDark} → theme.ts와 같다`, () => {
        expect(run(c)).toEqual(expected(c));
      });
    }
  }

  it("저장소가 던져도 멈추지 않고 시스템 설정을 따른다", () => {
    const c = { stored: "light", systemDark: true, storageThrows: true };
    expect(run(c)).toEqual(expected(c));
    expect(run(c).dark).toBe(true);
  });

  it("matchMedia가 없으면 라이트다", () => {
    const c = { stored: null, systemDark: true, noMatchMedia: true };
    expect(run(c)).toEqual({ dark: false, colorScheme: "light" });
  });
});
