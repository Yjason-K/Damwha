import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractTokenBlocks, syncFromFe } from "./sync-from-fe.mjs";

const vars = (prefix, n) =>
  Array.from({ length: n }, (_, i) => `  --${prefix}-${i}: #${String(i).padStart(6, "0")};`).join("\n");
const css = (rootBody, darkBody) =>
  `@import "tailwindcss";\n\n:root {\n${rootBody}\n}\n\n.dark {\n${darkBody}\n}\n\n@theme inline {\n  --color-x: var(--a-0);\n}\n`;

describe("extractTokenBlocks", () => {
  it(":root와 .dark 블록만 원문 그대로 가져온다", () => {
    const out = extractTokenBlocks(css(vars("a", 45), vars("a", 41)));
    expect(out).toContain(":root {");
    expect(out).toContain(".dark {");
    expect(out).toContain("--a-44: #000044;");
    expect(out).not.toContain("@theme");
    expect(out).not.toContain("tailwindcss");
  });

  it(".dark 블록이 없으면 실패한다", () => {
    const src = `:root {\n${vars("a", 45)}\n}\n`;
    expect(() => extractTokenBlocks(src)).toThrow(/\.dark/);
  });

  it(":root 블록이 없으면 실패한다", () => {
    const src = `.dark {\n${vars("a", 45)}\n}\n`;
    expect(() => extractTokenBlocks(src)).toThrow(/:root/);
  });

  it("변수가 40개 미만이면 실패한다 — 조용히 빈 토큰으로 배포하지 않는다", () => {
    expect(() => extractTokenBlocks(css(vars("a", 39), vars("a", 41)))).toThrow(/40/);
    expect(() => extractTokenBlocks(css(vars("a", 45), vars("a", 39)))).toThrow(/40/);
  });

  it("실제 fe/src/index.css에서 추출된다", () => {
    const real = readFileSync(new URL("../../fe/src/index.css", import.meta.url), "utf8");
    const out = extractTokenBlocks(real);
    expect(out).toMatch(/--surface-app\s*:/);
    expect(out).toMatch(/--accent-solid\s*:/);
  });
});

describe("syncFromFe", () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("토큰 CSS를 쓰고 마크 세 파일을 public에 복사한다", () => {
    const root = mkdtempSync(join(tmpdir(), "site-sync-"));
    dirs.push(root);
    mkdirSync(join(root, "fe/src"), { recursive: true });
    mkdirSync(join(root, "fe/public"), { recursive: true });
    mkdirSync(join(root, "site/src/styles"), { recursive: true });
    mkdirSync(join(root, "site/public"), { recursive: true });
    writeFileSync(join(root, "fe/src/index.css"), css(vars("a", 45), vars("a", 41)));
    for (const f of ["favicon.svg", "favicon.ico", "apple-touch-icon.png"]) {
      writeFileSync(join(root, "fe/public", f), f);
    }

    syncFromFe({ repoRoot: root, siteRoot: join(root, "site") });

    const tokens = readFileSync(join(root, "site/src/styles/tokens.generated.css"), "utf8");
    expect(tokens).toContain("--a-44");
    expect(tokens.startsWith("/* 생성물")).toBe(true);
    for (const f of ["favicon.svg", "favicon.ico", "apple-touch-icon.png"]) {
      expect(existsSync(join(root, "site/public", f))).toBe(true);
    }
  });
});
