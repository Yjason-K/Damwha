# Product Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `damwha.0kimjae.dev`에 영어(`/`)·한국어(`/ko/`) 한 페이지 제품 사이트를 Astro 정적 사이트로 만들고, SEO·발화 점프 영상·Cloudflare Pages 배포까지 갖춘다.

**Architecture:** 새 pnpm 워크스페이스 패키지 `site/`(`damwha-site`)가 Astro 7로 두 언어 HTML을 빌드한다. 색 토큰과 브랜드 마크는 빌드 때 `fe/`에서 뽑아 오고(커밋하는 사본 없음), 다운로드 링크는 빌드 때 GitHub 최신 릴리스를 읽는다. 문구는 언어별 TS 사전 두 개이고, 한쪽 키가 빠지면 `astro check`가 실패한다. 빌드 산출물은 `verify-seo.mjs`가 검사한다.

**Tech Stack:** Astro 7.3 (Vite 8), Tailwind 4.3 (`@tailwindcss/vite`), `@astrojs/sitemap` 3.7, sharp 0.35, `@fontsource-variable/inter`·`@fontsource/geist-mono`, vitest 4, linkedom, Playwright 1.63(스크립트 전용), ffmpeg(로컬), Cloudflare Pages.

**Spec:** `docs/superpowers/specs/2026-09-26-product-site-design.md` (이하 "스펙"). 용어·문체는 `docs/superpowers/specs/2026-09-26-i18n-ko-en-design.md` §7.

## Global Constraints

- 사이트 URL `https://damwha.0kimjae.dev`. 영어 `/`, 한국어 `/ko/`. `trailingSlash: "always"`. Accept-Language 리다이렉트 없음 (스펙 §3.3).
- 패키지 이름 `damwha-site`, 경로 `site/`. `site/.env` 없음 (스펙 §5).
- `npm install` 금지. 의존성은 `pnpm add --filter damwha-site …`로만 넣는다 (루트 CLAUDE.md).
- 패키지는 반드시 `--filter`로 실행한다. 루트에서 `astro`를 직접 돌리지 않는다.
- `fe/src/index.css`는 수정하지 않는다. 토큰은 `:root`/`.dark` 블록을 빌드 때 추출한다(스펙 §3.8). 정규식은 `fe/src/design-tokens.test.ts`와 같은 `/^:root\s*\{([^}]*)\}/m`, `/^\.dark\s*\{([^}]*)\}/m`이다. 둘 중 하나라도 없거나 변수가 40개 미만이면 실패한다.
- 클라이언트 JS는 `<head>` 다크 모드 인라인 스크립트와 영상 섹션 인라인 스크립트 두 개뿐이다. 프레임워크 아일랜드는 없다.
- 영어 문구는 sentence case, 느낌표 없음, 축약형 허용. 용어는 Utterance, Speaker, Enroll speaker, Lens/Lenses, Summary, Live recording, Preset Light/Standard/Quality(가볍게/표준/정확하게), Summary language, Display language를 쓴다. 제품명 Damwha(담화)는 번역하지 않는다.
- 한국어 문구는 해요체.
- 다운로드 폴백 URL `https://github.com/Yjason-K/Damwha/releases/latest`, API `https://api.github.com/repos/Yjason-K/Damwha/releases/latest`, DMG 자산 이름 패턴 `Damwha-<ver>-arm64.dmg`.
- 데모 링크: 영어 `https://damwha-demo.0kimjae.dev/?lang=en`, 한국어 `https://damwha-demo.0kimjae.dev/?lang=ko`.
- `theme-color`는 `#0F161E`(`fe/index.html:29`와 같은 값).
- 영상 파일 `site/public/media/utterance-jump.<lang>.{mp4,webm}`, 포스터 `utterance-jump-poster.<lang>.jpg`. 목표 크기는 파일당 2 MB 이하다. 지금은 `ko` 한 벌을 두 페이지가 같이 쓴다.
- 커밋 메시지 끝에는 `Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W`를 붙인다.

## Review Focus

1. **GitHub API가 실패·지연·이상 응답을 준다** (오프라인 빌드, rate limit, DMG가 없는 릴리스, 느린 응답). 빌드는 성공하고, 버튼은 릴리스 페이지를 가리키고, 버전 표기는 빠져야 한다. JSON-LD에는 `downloadUrl`·`softwareVersion`이 없어야 한다. → Task 2 테스트
2. **`fe/src/index.css`의 블록 구조가 바뀐다** (`.dark` 선택자 변경, 블록 삭제). 사이트 빌드는 조용히 빈 토큰으로 나가면 안 되고 실패해야 한다. → Task 1 테스트
3. **두 언어 페이지가 서로 어긋난다** (한쪽 hreflang 누락, 같은 title, canonical이 다른 언어를 가리킴, h1 둘). → Task 3의 `verifyDist` 테스트와 변이 확인
4. **다크 모드 첫 페인트 깜빡임과 `prefers-reduced-motion`**. 다크 OS에서 흰 화면이 한 번 보이면 안 된다. reduce 설정이면 영상이 자동 재생되지 않고 controls가 보여야 한다. → Task 4 빌드 산출물 검사, Task 6 브라우저 확인
5. **데모 시드나 UI가 바뀌어 녹화 스크립트가 엉뚱한 화면을 찍는다.** 도착 URL이 `/meetings/mtg_6?u=`가 아니면 녹화를 버리고 실패해야 한다. → Task 6 스크립트 단언

---

## File Structure

| 경로 | 책임 |
|---|---|
| `site/package.json` | 패키지 정의, 스크립트 |
| `site/astro.config.mjs` | site URL, i18n, sitemap, Tailwind |
| `site/tsconfig.json` | Astro strict |
| `site/vitest.config.ts` | `scripts/**/*.test.mjs`·`src/**/*.test.ts` |
| `site/.gitignore` | 생성물(`dist`, `.astro`, 토큰, 마크) |
| `site/scripts/sync-from-fe.mjs` (+ `.test.mjs`) | fe → 토큰 CSS 추출, 마크 복사 |
| `site/scripts/verify-seo.mjs` (+ `.test.mjs`) | 빌드 산출물 SEO 검사 |
| `site/scripts/record-utterance-jump.mjs` | 데모 녹화 + ffmpeg 인코딩 |
| `site/scripts/make-og.mjs` | 언어별 OG PNG 생성 |
| `site/src/lib/release.ts` (+ `.test.ts`) | 최신 릴리스 조회·파싱·폴백·크기 포맷 |
| `site/src/i18n/en.ts` | 영어 사전 + `Dictionary` 타입 |
| `site/src/i18n/ko.ts` | 한국어 사전 (`satisfies Dictionary`) |
| `site/src/i18n/index.ts` | `Lang`, `getDictionary`, `otherLang` |
| `site/src/layouts/Base.astro` | `<head>` 전부 + 다크 스크립트 + 폰트 |
| `site/src/components/*.astro` | 섹션별 컴포넌트 |
| `site/src/pages/index.astro`, `ko/index.astro`, `404.astro` | 라우트 |
| `site/src/styles/site.css` | Tailwind + 토큰 import + 사이트 테마 매핑 |
| `site/src/assets/*.png` | 스크린샷 (`docs/images/2026-09-20/`에서 복사) |
| `site/public/robots.txt`, `og-*.png`, `media/*` | 정적 파일 |
| `site/README.md` | 개발·배포·Cloudflare 설정 절차 |
| `fe/index.html` | `noindex` 한 줄 |
| `fe/src/app/index-html.test.ts` | noindex 회귀 테스트 |
| `desktop/scripts/lib/site-rebuild.mjs` (+ `desktop/tests/scripts/site-rebuild.test.ts`) | Deploy Hook 호출 |
| `desktop/scripts/publish.sh` | 발행 뒤 site-rebuild 호출 |
| `pnpm-workspace.yaml`, 루트 `package.json`, 루트 `CLAUDE.md`, `fe/DESIGN.md`, `README.md`, `README.ko.md`, `deploy/demo/README.md` | 등록·문서 |

---

### Task 1: `site/` 패키지 뼈대와 fe 동기화

**Files:**
- Create: `site/package.json`, `site/astro.config.mjs`, `site/tsconfig.json`, `site/vitest.config.ts`, `site/.gitignore`
- Create: `site/scripts/sync-from-fe.mjs`, `site/scripts/sync-from-fe.test.mjs`
- Create: `site/src/styles/site.css`, `site/src/pages/index.astro`(임시), `site/src/pages/ko/index.astro`(임시)
- Modify: `pnpm-workspace.yaml`, `package.json`(루트)

**Interfaces:**
- Produces: `extractTokenBlocks(css: string): string` — `:root{…}` + `.dark{…}` 원문을 이어 붙인 CSS, 실패 시 `Error` throw. `syncFromFe({ repoRoot, siteRoot }): void` — `site/src/styles/tokens.generated.css`를 쓰고, `site/public/`에 `favicon.svg`·`favicon.ico`·`apple-touch-icon.png`를 복사한다.
- Produces: 사이트 테마 유틸리티 `bg-app`, `bg-card`, `bg-sunken`, `text-ink`, `text-ink-2`, `text-ink-3`, `border-line`, `border-line-2`, `bg-solid`, `hover:bg-solid-hover`, `text-on-solid`, `bg-mint-bg`, `text-mint-text`, `text-link`, `font-sans`, `font-mono`. `dark:` 변형은 `.dark` 조상 기준이다.
- Produces: 스크립트 `pnpm site build`, `pnpm site:dev`, `pnpm site test`, `pnpm site check`.

- [ ] **Step 1: 워크스페이스와 패키지 파일 만들기**

`pnpm-workspace.yaml`의 `packages`에 `- site`를 `- desktop` 다음 줄에 더한다. 파일 맨 위 주석의 "Only the two Node packages are members."는 "Only the Node packages below are members."로 고친다.

루트 `package.json`의 `scripts`에서 `"desktop:build"` 줄 다음에 추가한다.

```json
    "site": "pnpm --filter damwha-site run",
    "site:dev": "pnpm --filter damwha-site run start",
    "site:build": "pnpm --filter damwha-site run build",
```

`site/package.json`:

```json
{
  "name": "damwha-site",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Damwha product site — damwha.0kimjae.dev (Astro, static).",
  "scripts": {
    "sync": "node scripts/sync-from-fe.mjs",
    "start": "node scripts/sync-from-fe.mjs && astro dev",
    "build": "node scripts/sync-from-fe.mjs && astro build",
    "preview": "astro preview",
    "check": "node scripts/sync-from-fe.mjs && astro check && astro build && node scripts/verify-seo.mjs",
    "test": "vitest run",
    "record": "node scripts/record-utterance-jump.mjs",
    "og": "node scripts/make-og.mjs"
  }
}
```

`dev` 대신 `start`를 쓰는 이유가 있다. 루트 `pnpm dev`는 `--recursive run dev`라서, `dev`라는 이름이면 API·Vite와 함께 Astro까지 뜬다. 루트 CLAUDE.md는 `pnpm dev`를 "API :3000 + Vite :5173"으로 정의한다.

- [ ] **Step 2: 의존성 설치**

```bash
pnpm add --filter damwha-site astro@^7.3.5 @astrojs/sitemap@^3.7.4 @tailwindcss/vite@^4.3.3 tailwindcss@^4.3.3 sharp@^0.35.4 @fontsource-variable/inter@^5.3.0 @fontsource/geist-mono@^5.3.0
pnpm add --filter damwha-site -D @astrojs/check@^0.9.10 typescript@^5.9.3 vitest@^4.1.9 linkedom@^0.18.13 playwright@^1.63.0
```

설치 출력에 "Ignored build scripts: esbuild…" 또는 sharp 관련 경고가 나오면, 루트 `package.json`의 `pnpm.ignoredBuiltDependencies` 배열에 그 이름(`esbuild`, `sharp`)을 알파벳 순서로 더한다. 두 패키지 모두 설치 스크립트 없이 prebuilt 바이너리로 돈다. 2026-09-27에 저장소 밖 프로브에서 esbuild 스크립트 없이 `astro build`와 sharp AVIF/WebP 생성이 통과했다. 그다음 `pnpm install`을 다시 돌려 경고가 사라졌는지 본다.

- [ ] **Step 3: 설정 파일**

`site/astro.config.mjs`:

```js
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

// 스펙 §3.3·§6.2. 도메인을 바꿀 때는 이 site 값 하나와 Cloudflare 설정만 바뀐다(스펙 §9).
export default defineConfig({
  site: "https://damwha.0kimjae.dev",
  trailingSlash: "always",
  i18n: {
    defaultLocale: "en",
    locales: ["en", "ko"],
    routing: { prefixDefaultLocale: false },
  },
  integrations: [
    sitemap({
      i18n: { defaultLocale: "en", locales: { en: "en", ko: "ko" } },
      filter: (page) => !page.endsWith("/404/"),
    }),
  ],
  vite: { plugins: [tailwindcss()] },
});
```

`site/tsconfig.json`:

```json
{
  "extends": "astro/tsconfigs/strict",
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist"]
}
```

`site/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["scripts/**/*.test.mjs", "src/**/*.test.ts"] },
});
```

`site/.gitignore`:

```
dist/
.astro/
# sync-from-fe.mjs 산출물 — 원본은 fe/ (스펙 §3.8)
src/styles/tokens.generated.css
public/favicon.svg
public/favicon.ico
public/apple-touch-icon.png
# record-utterance-jump.mjs 임시 녹화
.recordings/
```

- [ ] **Step 4: 실패하는 테스트 작성**

`site/scripts/sync-from-fe.test.mjs`:

```js
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
```

- [ ] **Step 5: 실패 확인**

Run: `pnpm --filter damwha-site exec vitest run scripts/sync-from-fe.test.mjs`
Expected: FAIL — `Failed to load url ./sync-from-fe.mjs` (파일 없음)

- [ ] **Step 6: 구현**

`site/scripts/sync-from-fe.mjs`:

```js
// fe/에서 사이트가 쓰는 두 가지를 빌드 때 가져온다(스펙 §3.8).
//   1. fe/src/index.css의 :root·.dark 블록 → src/styles/tokens.generated.css
//   2. 브랜드 마크 래스터·SVG 세 파일 → public/
// 둘 다 gitignore다. 원본은 fe/ 하나뿐이다 — 값을 복사해 커밋하지 않는다.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// fe/src/design-tokens.test.ts와 같은 정규식이다. 블록 안에 `}`가 없다는 전제를 그 테스트가 지킨다.
const ROOT_BLOCK = /^:root\s*\{([^}]*)\}/m;
const DARK_BLOCK = /^\.dark\s*\{([^}]*)\}/m;
const VAR_DECL = /^\s*--[a-z0-9-]+\s*:/gm;
const MIN_VARS = 40;
const MARKS = ["favicon.svg", "favicon.ico", "apple-touch-icon.png"];

export function extractTokenBlocks(css) {
  const blocks = [];
  for (const [name, re] of [[":root", ROOT_BLOCK], [".dark", DARK_BLOCK]]) {
    const m = re.exec(css);
    if (!m) throw new Error(`fe/src/index.css에서 ${name} 블록을 찾지 못했다 — 선택자가 바뀌었나?`);
    const count = (m[1].match(VAR_DECL) ?? []).length;
    if (count < MIN_VARS) {
      throw new Error(`${name} 블록의 변수가 ${count}개다 — ${MIN_VARS}개 미만이면 추출이 잘못된 것이다`);
    }
    blocks.push(m[0]);
  }
  return blocks.join("\n\n") + "\n";
}

export function syncFromFe({ repoRoot, siteRoot }) {
  const css = readFileSync(join(repoRoot, "fe/src/index.css"), "utf8");
  const header = "/* 생성물 — site/scripts/sync-from-fe.mjs가 fe/src/index.css에서 뽑는다. 고치지 말 것. */\n";
  writeFileSync(join(siteRoot, "src/styles/tokens.generated.css"), header + extractTokenBlocks(css));
  for (const f of MARKS) copyFileSync(join(repoRoot, "fe/public", f), join(siteRoot, "public", f));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  syncFromFe({ repoRoot: resolve(siteRoot, ".."), siteRoot });
  console.log("sync-from-fe: tokens.generated.css + 마크 3개");
}
```

`site/public/`는 이 단계에서 `mkdir -p site/public`으로 만든다. `robots.txt`가 Task 3에서 들어오기 전까지 비어 있으므로 `site/public/.gitkeep`을 둔다.

- [ ] **Step 7: 테스트 통과 확인**

Run: `pnpm --filter damwha-site exec vitest run scripts/sync-from-fe.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 8: 테마 CSS와 임시 페이지로 빌드 확인**

`site/src/styles/site.css`:

```css
@import "tailwindcss";
@import "./tokens.generated.css";

/* fe와 같은 스위치: <html class="dark"> (Base.astro 인라인 스크립트가 붙인다) */
@custom-variant dark (&:is(.dark *));

/* 사이트가 쓰는 역할만 짧은 이름으로 연다. 값은 전부 fe 토큰이다(스펙 §3.8). */
@theme inline {
  --color-app: var(--surface-app);
  --color-card: var(--surface-card);
  --color-sunken: var(--surface-sunken);
  --color-ink: var(--text-primary);
  --color-ink-2: var(--text-secondary);
  --color-ink-3: var(--text-muted);
  --color-line: var(--border-subtle);
  --color-line-2: var(--border-default);
  --color-solid: var(--accent-solid);
  --color-solid-hover: var(--accent-solid-hover);
  --color-on-solid: var(--text-on-accent);
  --color-mint-bg: var(--accent-bg);
  --color-mint-text: var(--accent-text);
  --color-link: var(--text-link);
}

@theme {
  --font-sans: "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, "SF Mono", "Menlo", monospace;
}

@layer base {
  html {
    background: var(--surface-app);
    color: var(--text-primary);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
  }
  :focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
    border-radius: 6px;
  }
}
```

임시 `site/src/pages/index.astro`:

```astro
---
import "../styles/site.css";
---
<html lang="en"><body class="bg-app text-ink p-8">scaffold</body></html>
```

임시 `site/src/pages/ko/index.astro`:

```astro
---
import "../../styles/site.css";
---
<html lang="ko"><body class="bg-app text-ink p-8">scaffold</body></html>
```

Run: `pnpm site build`
Expected: `sync-from-fe: tokens.generated.css + 마크 3개`, 이어서 Astro `Complete!`와 `sitemap-index.xml created`. 그다음 `grep -c -- "--surface-app" site/dist/_astro/*.css`가 1 이상이어야 한다.

- [ ] **Step 9: 변이 확인 (Review Focus 2)**

`fe/src/index.css`를 건드리지 않는다. 테스트 입력만 바꿔서 확인한다. `extractTokenBlocks`의 `MIN_VARS` 검사를 잠시 주석 처리하고 Step 7을 다시 돌린다. "변수가 40개 미만이면 실패한다"가 FAIL해야 한다. 확인했으면 되돌린다.

- [ ] **Step 10: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml site/
git commit -m "feat(site): Astro 패키지 뼈대 — fe 토큰·마크를 빌드 때 가져온다

Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W"
```

---

### Task 2: 최신 릴리스 조회 (`release.ts`)

**Files:**
- Create: `site/src/lib/release.ts`, `site/src/lib/release.test.ts`

**Interfaces:**
- Produces:

```ts
export const RELEASES_PAGE = "https://github.com/Yjason-K/Damwha/releases/latest";
export type ReleaseInfo =
  | { kind: "asset"; version: string; dmgUrl: string; sizeBytes: number; publishedAt: string }
  | { kind: "fallback"; pageUrl: string };
export function parseRelease(json: unknown): ReleaseInfo | null;
export function fetchLatestRelease(deps?: { fetchImpl?: typeof fetch; warn?: (msg: string) => void; timeoutMs?: number }): Promise<ReleaseInfo>;
export function getLatestRelease(): Promise<ReleaseInfo>; // 빌드당 1회(메모이즈)
export function formatSize(bytes: number): string; // "1.2 GB" / "850 MB"
export function downloadHref(r: ReleaseInfo): string;
```

- [ ] **Step 1: 실패하는 테스트 작성**

`site/src/lib/release.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { RELEASES_PAGE, downloadHref, fetchLatestRelease, formatSize, parseRelease } from "./release";

const good = {
  tag_name: "v0.4.1",
  published_at: "2026-09-27T06:06:26Z",
  assets: [
    { name: "Damwha-0.4.1-arm64.dmg.sha256", browser_download_url: "https://x/sha", size: 90 },
    { name: "Damwha-0.4.1-arm64.dmg", browser_download_url: "https://x/dmg", size: 1_288_490_189 },
  ],
};

const okFetch = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("parseRelease", () => {
  it("태그에서 v를 떼고 .dmg 자산을 고른다(.sha256이 아니라)", () => {
    expect(parseRelease(good)).toEqual({
      kind: "asset",
      version: "0.4.1",
      dmgUrl: "https://x/dmg",
      sizeBytes: 1_288_490_189,
      publishedAt: "2026-09-27T06:06:26Z",
    });
  });

  it("DMG 자산이 없으면 null", () => {
    expect(parseRelease({ ...good, assets: [good.assets[0]] })).toBeNull();
  });

  it("모양이 다르면 null — 던지지 않는다", () => {
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease({ message: "API rate limit exceeded" })).toBeNull();
    expect(parseRelease({ ...good, tag_name: 3 })).toBeNull();
  });
});

describe("fetchLatestRelease", () => {
  it("정상 응답이면 asset", async () => {
    const r = await fetchLatestRelease({ fetchImpl: okFetch(good), warn: () => {} });
    expect(r.kind).toBe("asset");
  });

  it("HTTP 오류(403 rate limit)면 fallback + 경고, 던지지 않는다", async () => {
    const warn = vi.fn();
    const r = await fetchLatestRelease({ fetchImpl: okFetch({ message: "rate limit" }, 403), warn });
    expect(r).toEqual({ kind: "fallback", pageUrl: RELEASES_PAGE });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("403"));
  });

  it("네트워크 오류(오프라인)면 fallback", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const r = await fetchLatestRelease({ fetchImpl, warn: () => {} });
    expect(r.kind).toBe("fallback");
  });

  it("응답이 timeoutMs보다 늦으면 fallback", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        }),
    ) as unknown as typeof fetch;
    const r = await fetchLatestRelease({ fetchImpl, warn: () => {}, timeoutMs: 20 });
    expect(r.kind).toBe("fallback");
  });

  it("DMG 없는 릴리스면 fallback", async () => {
    const r = await fetchLatestRelease({ fetchImpl: okFetch({ ...good, assets: [] }), warn: () => {} });
    expect(r.kind).toBe("fallback");
  });
});

describe("formatSize / downloadHref", () => {
  it("GB는 소수 한 자리, 1 GB 미만은 MB 정수", () => {
    expect(formatSize(1_288_490_189)).toBe("1.2 GB");
    expect(formatSize(891_289_600)).toBe("850 MB");
  });

  it("fallback이면 릴리스 페이지", () => {
    expect(downloadHref({ kind: "fallback", pageUrl: RELEASES_PAGE })).toBe(RELEASES_PAGE);
    expect(downloadHref(parseRelease(good)!)).toBe("https://x/dmg");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-site exec vitest run src/lib/release.test.ts`
Expected: FAIL — `./release` 모듈 없음

- [ ] **Step 3: 구현**

`site/src/lib/release.ts`:

```ts
// 빌드 때 GitHub 최신 릴리스를 한 번 읽는다(스펙 §3.7). 자산 이름에 버전이 들어 있어
// releases/latest/download/<고정이름> 링크를 쓸 수 없기 때문이다. 어떤 실패도 빌드를 멈추지 않는다 —
// 버튼이 릴리스 페이지를 가리키고 버전 표기가 빠질 뿐이다.
export const RELEASES_PAGE = "https://github.com/Yjason-K/Damwha/releases/latest";
const API = "https://api.github.com/repos/Yjason-K/Damwha/releases/latest";
const DMG = /^Damwha-.+-arm64\.dmg$/;

export type ReleaseInfo =
  | { kind: "asset"; version: string; dmgUrl: string; sizeBytes: number; publishedAt: string }
  | { kind: "fallback"; pageUrl: string };

const FALLBACK: ReleaseInfo = { kind: "fallback", pageUrl: RELEASES_PAGE };

export function parseRelease(json: unknown): ReleaseInfo | null {
  if (!json || typeof json !== "object") return null;
  const r = json as Record<string, unknown>;
  if (typeof r.tag_name !== "string" || typeof r.published_at !== "string" || !Array.isArray(r.assets)) return null;
  const asset = r.assets.find(
    (a): a is { name: string; browser_download_url: string; size: number } =>
      !!a &&
      typeof a === "object" &&
      typeof (a as Record<string, unknown>).name === "string" &&
      DMG.test((a as Record<string, string>).name) &&
      typeof (a as Record<string, unknown>).browser_download_url === "string" &&
      typeof (a as Record<string, unknown>).size === "number",
  );
  if (!asset) return null;
  return {
    kind: "asset",
    version: r.tag_name.replace(/^v/, ""),
    dmgUrl: asset.browser_download_url,
    sizeBytes: asset.size,
    publishedAt: r.published_at,
  };
}

export async function fetchLatestRelease(
  deps: { fetchImpl?: typeof fetch; warn?: (msg: string) => void; timeoutMs?: number } = {},
): Promise<ReleaseInfo> {
  const { fetchImpl = fetch, warn = (m) => console.warn(m), timeoutMs = 10_000 } = deps;
  try {
    const res = await fetchImpl(API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "damwha-site-build" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      warn(`[release] GitHub API ${res.status} — 다운로드 버튼을 릴리스 페이지로 돌린다`);
      return FALLBACK;
    }
    const parsed = parseRelease(await res.json());
    if (!parsed) warn("[release] 최신 릴리스에 arm64 DMG가 없다 — 릴리스 페이지로 돌린다");
    return parsed ?? FALLBACK;
  } catch (e) {
    warn(`[release] 조회 실패(${e instanceof Error ? e.message : String(e)}) — 릴리스 페이지로 돌린다`);
    return FALLBACK;
  }
}

let cached: Promise<ReleaseInfo> | undefined;
/** 두 언어 페이지가 같은 빌드에서 한 번만 부른다. */
export function getLatestRelease(): Promise<ReleaseInfo> {
  cached ??= fetchLatestRelease();
  return cached;
}

export function formatSize(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function downloadHref(r: ReleaseInfo): string {
  return r.kind === "asset" ? r.dmgUrl : r.pageUrl;
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter damwha-site exec vitest run src/lib/release.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: 실제 API 스모크**

Run: `pnpm --filter damwha-site exec node --experimental-strip-types -e "import('./src/lib/release.ts').then(async m => console.log(await m.fetchLatestRelease()))"`
Expected: `{ kind: 'asset', version: '0.4.1', dmgUrl: 'https://github.com/Yjason-K/Damwha/releases/download/v0.4.1/Damwha-0.4.1-arm64.dmg', ... }` (버전은 그 시점의 Latest)

- [ ] **Step 6: Commit**

```bash
git add site/src/lib/
git commit -m "feat(site): 빌드 때 최신 릴리스 DMG를 읽고, 실패하면 릴리스 페이지로 돌린다

Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W"
```

---

### Task 3: SEO 검사기, 사전, Base 레이아웃, 라우트

이 태스크가 끝나면 `pnpm site check`가 초록이다. 검사기를 먼저 만들고, 진짜 페이지를 그 검사에 통과시킨다. 섹션 본문은 Task 4에서 채운다. 이 태스크의 페이지 본문은 h1 하나뿐이다.

**Files:**
- Create: `site/scripts/verify-seo.mjs`, `site/scripts/verify-seo.test.mjs`
- Create: `site/src/i18n/en.ts`, `site/src/i18n/ko.ts`, `site/src/i18n/index.ts`
- Create: `site/src/layouts/Base.astro`, `site/src/pages/404.astro`, `site/public/robots.txt`
- Modify: `site/src/pages/index.astro`, `site/src/pages/ko/index.astro` (임시 내용 교체)
- Delete: `site/public/.gitkeep`

**Interfaces:**
- Consumes: `getLatestRelease`, `downloadHref`, `formatSize`, `ReleaseInfo` (Task 2)
- Produces: `verifyDist(distDir: string, opts: { site: string }): string[]` — 오류 메시지 배열(빈 배열 = 통과).
- Produces: `type Lang = "en" | "ko"`, `getDictionary(lang: Lang): Dictionary`, `otherLang(lang: Lang): Lang`, `type Dictionary` (en.ts의 `typeof en`).
- Produces: `<Base lang={Lang} release={ReleaseInfo}>` — `<head>` 전부를 책임지고 본문은 `<slot />`이다.

- [ ] **Step 1: 실패하는 검사기 테스트 작성**

`site/scripts/verify-seo.test.mjs`:

```js
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyDist } from "./verify-seo.mjs";

const SITE = "https://damwha.0kimjae.dev";
const hreflangs = `
  <link rel="alternate" hreflang="en" href="${SITE}/">
  <link rel="alternate" hreflang="ko" href="${SITE}/ko/">
  <link rel="alternate" hreflang="x-default" href="${SITE}/">`;
const ld = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"Damwha"}</script>`;
const page = ({ lang, url, title, desc, og, extraHead = "", body = "<h1>t</h1><img src=a alt=x>" }) => `<!doctype html>
<html lang="${lang}"><head>
<title>${title}</title><meta name="description" content="${desc}">
<link rel="canonical" href="${url}">${hreflangs}
<meta property="og:image" content="${og}">${ld}${extraHead}
</head><body>${body}</body></html>`;

const EN = { lang: "en", url: `${SITE}/`, title: "Damwha — en", desc: "en desc", og: `${SITE}/og-en.png` };
const KO = { lang: "ko", url: `${SITE}/ko/`, title: "담화 Damwha — ko", desc: "ko desc", og: `${SITE}/og-ko.png` };

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeSite({ en = page(EN), ko = page(KO), robots = `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap-index.xml\n`, sitemap = true, notFound = `<html><head><meta name="robots" content="noindex"></head><body><h1>404</h1></body></html>` } = {}) {
  const d = mkdtempSync(join(tmpdir(), "verify-seo-"));
  dirs.push(d);
  mkdirSync(join(d, "ko"));
  writeFileSync(join(d, "index.html"), en);
  writeFileSync(join(d, "ko/index.html"), ko);
  if (robots !== null) writeFileSync(join(d, "robots.txt"), robots);
  if (sitemap) writeFileSync(join(d, "sitemap-index.xml"), "<sitemapindex/>");
  if (notFound !== null) writeFileSync(join(d, "404.html"), notFound);
  return d;
}

describe("verifyDist", () => {
  it("올바른 사이트는 오류 0", () => {
    expect(verifyDist(writeSite(), { site: SITE })).toEqual([]);
  });

  it("한쪽 hreflang이 빠지면 잡는다", () => {
    const ko = page(KO).replace(/<link rel="alternate" hreflang="en"[^>]*>/, "");
    expect(verifyDist(writeSite({ ko }), { site: SITE }).join("\n")).toMatch(/ko\/index\.html.*hreflang/);
  });

  it("canonical이 다른 언어를 가리키면 잡는다", () => {
    const ko = page({ ...KO, url: `${SITE}/` });
    expect(verifyDist(writeSite({ ko }), { site: SITE }).join("\n")).toMatch(/canonical/);
  });

  it("html lang이 틀리면 잡는다", () => {
    const ko = page({ ...KO, lang: "en" });
    expect(verifyDist(writeSite({ ko }), { site: SITE }).join("\n")).toMatch(/lang/);
  });

  it("두 언어의 title이 같으면 잡는다", () => {
    const ko = page({ ...KO, title: EN.title });
    expect(verifyDist(writeSite({ ko }), { site: SITE }).join("\n")).toMatch(/title/);
  });

  it("og:image가 상대 경로면 잡는다", () => {
    const en = page({ ...EN, og: "/og-en.png" });
    expect(verifyDist(writeSite({ en }), { site: SITE }).join("\n")).toMatch(/og:image/);
  });

  it("JSON-LD가 깨졌거나 타입이 다르면 잡는다", () => {
    const en = page(EN).replace('"SoftwareApplication"', '"WebPage"');
    expect(verifyDist(writeSite({ en }), { site: SITE }).join("\n")).toMatch(/SoftwareApplication/);
    const ko = page(KO).replace('{"@context"', '{"@context" oops');
    expect(verifyDist(writeSite({ ko }), { site: SITE }).join("\n")).toMatch(/JSON-LD/);
  });

  it("h1이 0개나 2개면 잡는다", () => {
    const en = page({ ...EN, body: "<h1>a</h1><h1>b</h1>" });
    const ko = page({ ...KO, body: "<h2>a</h2>" });
    const errs = verifyDist(writeSite({ en, ko }), { site: SITE }).join("\n");
    expect(errs).toMatch(/index\.html.*h1.*2/);
    expect(errs).toMatch(/ko\/index\.html.*h1.*0/);
  });

  it("alt 없는 img를 잡는다", () => {
    const en = page({ ...EN, body: "<h1>a</h1><img src=x>" });
    expect(verifyDist(writeSite({ en }), { site: SITE }).join("\n")).toMatch(/alt/);
  });

  it("robots의 Sitemap이 절대 URL이 아니거나 sitemap-index.xml이 없으면 잡는다", () => {
    expect(verifyDist(writeSite({ robots: "User-agent: *\nSitemap: /sitemap-index.xml\n" }), { site: SITE }).join("\n")).toMatch(/robots/);
    expect(verifyDist(writeSite({ sitemap: false }), { site: SITE }).join("\n")).toMatch(/sitemap-index/);
  });

  it("404에 noindex가 없으면 잡는다", () => {
    expect(verifyDist(writeSite({ notFound: "<html><body>404</body></html>" }), { site: SITE }).join("\n")).toMatch(/404.*noindex/);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-site exec vitest run scripts/verify-seo.test.mjs`
Expected: FAIL — `./verify-seo.mjs` 없음

- [ ] **Step 3: 검사기 구현**

`site/scripts/verify-seo.mjs`:

```js
// 빌드 산출물(dist/)의 SEO 계약을 검사한다(스펙 §8.2). `pnpm site check`의 마지막 단계.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const PAGES = [
  { file: "index.html", lang: "en", path: "/" },
  { file: "ko/index.html", lang: "ko", path: "/ko/" },
];

const attr = (doc, sel, name) => doc.querySelector(sel)?.getAttribute(name) ?? "";

export function verifyDist(distDir, { site }) {
  const errors = [];
  const seen = {};
  const expectedAlt = { en: `${site}/`, ko: `${site}/ko/`, "x-default": `${site}/` };

  for (const p of PAGES) {
    const full = join(distDir, p.file);
    if (!existsSync(full)) {
      errors.push(`${p.file}: 없다`);
      continue;
    }
    const { document: doc } = parseHTML(readFileSync(full, "utf8"));
    const err = (m) => errors.push(`${p.file}: ${m}`);

    if (doc.documentElement.getAttribute("lang") !== p.lang) err(`<html lang>이 ${p.lang}이 아니다`);
    const canonical = attr(doc, 'link[rel="canonical"]', "href");
    if (canonical !== `${site}${p.path}`) err(`canonical이 ${site}${p.path}가 아니다: "${canonical}"`);

    const alts = Object.fromEntries(
      [...doc.querySelectorAll('link[rel="alternate"][hreflang]')].map((l) => [l.getAttribute("hreflang"), l.getAttribute("href")]),
    );
    for (const [hl, href] of Object.entries(expectedAlt)) {
      if (alts[hl] !== href) err(`hreflang="${hl}"가 ${href}를 가리키지 않는다: "${alts[hl] ?? "(없음)"}"`);
    }
    if (Object.keys(alts).length !== 3) err(`hreflang이 ${Object.keys(alts).length}개다(3개여야 한다)`);

    const title = doc.querySelector("title")?.textContent?.trim() ?? "";
    const desc = attr(doc, 'meta[name="description"]', "content").trim();
    const og = attr(doc, 'meta[property="og:image"]', "content");
    if (!title) err("title이 비었다");
    if (!desc) err("description이 비었다");
    if (!og.startsWith(`${site}/`)) err(`og:image가 절대 URL이 아니다: "${og}"`);
    seen[p.lang] = { title, desc, og };

    const lds = [...doc.querySelectorAll('script[type="application/ld+json"]')];
    const types = [];
    for (const s of lds) {
      try {
        types.push(JSON.parse(s.textContent)["@type"]);
      } catch {
        err("JSON-LD가 JSON으로 파싱되지 않는다");
      }
    }
    if (!types.includes("SoftwareApplication")) err("JSON-LD SoftwareApplication이 없다");

    const h1 = doc.querySelectorAll("h1").length;
    if (h1 !== 1) err(`h1이 ${h1}개다(1개여야 한다)`);
    const noAlt = [...doc.querySelectorAll("img")].filter((i) => !i.hasAttribute("alt"));
    if (noAlt.length) err(`alt 없는 img ${noAlt.length}개: ${noAlt.map((i) => i.getAttribute("src")).join(", ")}`);
  }

  if (seen.en && seen.ko) {
    for (const k of ["title", "desc", "og"]) {
      if (seen.en[k] === seen.ko[k]) errors.push(`en·ko의 ${k === "desc" ? "description" : k === "og" ? "og:image" : "title"}이 같다`);
    }
  }

  if (!existsSync(join(distDir, "sitemap-index.xml"))) errors.push("sitemap-index.xml이 없다");
  const robotsPath = join(distDir, "robots.txt");
  const robots = existsSync(robotsPath) ? readFileSync(robotsPath, "utf8") : "";
  if (!new RegExp(`^Sitemap: ${site.replace(/\./g, "\\.")}/sitemap-index\\.xml$`, "m").test(robots)) {
    errors.push("robots.txt의 Sitemap이 절대 URL sitemap-index.xml이 아니다");
  }
  const nf = join(distDir, "404.html");
  if (!existsSync(nf) || !/<meta name="robots" content="noindex"/.test(readFileSync(nf, "utf8"))) {
    errors.push("404.html에 noindex가 없다");
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
  const errors = verifyDist(dist, { site: "https://damwha.0kimjae.dev" });
  if (errors.length) {
    console.error(`verify-seo: ${errors.length}건\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("verify-seo: 통과");
}
```

- [ ] **Step 4: 검사기 테스트 통과**

Run: `pnpm --filter damwha-site exec vitest run scripts/verify-seo.test.mjs`
Expected: PASS (11 tests)

- [ ] **Step 5: 사전 작성**

`site/src/i18n/en.ts`의 모양이 곧 `Dictionary`다. Task 4의 컴포넌트가 이 키들을 쓴다. 문구는 스펙 §4.1과 Global Constraints의 용어를 따른다. 여기서 확정한다.

```ts
export const en = {
  meta: {
    title: "Damwha — Private, speaker-attributed conversation search for Mac",
    description:
      "Record conversations and search every utterance by speaker and moment, one click from the original audio. Transcription, speaker ID and summaries run entirely on your Mac.",
    ogImage: "/og-en.png",
    ogImageAlt: "Damwha — Find the moment it was said.",
    ogLocale: "en_US",
    ogLocaleAlt: "ko_KR",
  },
  nav: { home: "Damwha home", langSwitch: "한국어", langSwitchLabel: "한국어로 보기", github: "GitHub" },
  hero: {
    eyebrow: "Free and open source · macOS",
    title: "Find the moment it was said.",
    lede: "Damwha records your conversations and turns them into speaker-attributed, searchable utterances — every line one click from the original audio. Everything runs on your Mac.",
    download: "Download for Mac",
    downloadFallback: "Download from GitHub",
    demo: "Try the live demo",
    demoUrl: "https://damwha-demo.0kimjae.dev/?lang=en",
    demoNote: "Read-only demo · sample conversations are in Korean",
    requirements: "Apple Silicon · macOS 15+",
    imageAlt: "Damwha's transcript view: conversation list, speaker-colored transcript and insight panel",
  },
  problem: {
    title: "Conversations pile up. Finding what was said doesn't get easier.",
    body: "Memory fades, transcripts are long, and most transcription tools make you rename “Speaker 1” every time. Damwha treats each utterance as the unit — tied to who said it, when, the original text and audio, and the turns around it.",
  },
  jump: {
    title: "Utterance jump",
    lede: "Search every conversation, press Enter, and land on the exact second — the line highlighted, the audio cued up.",
    caption: "⌘K → search → Enter: the playhead and the timeline move to the moment it was said.",
    videoLabel: "Screen recording: searching and jumping to the moment in the original audio",
    videoLang: "ko",
  },
  features: {
    title: "What else it does",
    items: [
      {
        title: "Knows who is speaking",
        body: "Voiceprint-based speaker identification. Enroll a speaker once and they're recognized in every later conversation.",
        image: "speakers" as const,
        alt: "Speaker management with enrolled voiceprints",
      },
      {
        title: "⌘K search, everywhere",
        body: "Hybrid search — meaning and keywords — over every utterance and conversation, from any screen.",
        image: "search" as const,
        alt: "Command palette search results across two conversations",
      },
      {
        title: "Lenses: decisions, action items, promises",
        body: "A local LLM pulls them out of each conversation, each with a link back to the evidence. Edit freely — re-extraction keeps what you touched.",
        image: "lenses" as const,
        alt: "Decisions lens listing items across conversations",
      },
      {
        title: "Tuned to your Mac",
        body: "Damwha reads your chip and memory and recommends a preset. Summaries come in the transcript's language, Korean or English — a Korean meeting can be summarized in English.",
        image: "settings" as const,
        alt: "Processing settings recommending a preset for this Mac",
      },
    ],
  },
  privacy: {
    title: "Private by design",
    body: "No cloud ML. Transcription, speaker identification, search and summaries all run on your Mac, and voiceprints stay on disk. Models download once, the first time they're needed — your recordings never leave the machine.",
    pipelineLabel: "Processing pipeline",
    pipeline: ["Audio", "Normalize", "Voice activity", "Diarization", "Speaker ID", "Whisper", "Search index", "Lenses ∥ summary"],
  },
  requirements: {
    title: "Requirements",
    rows: [
      ["Mac", "Apple Silicon (M1 or later), macOS 15 or later"],
      ["Disk for models", "About 8 GB (Light) · 20 GB (Standard) · 40 GB (Quality), downloaded on first use"],
      ["Hugging Face token", "Needed only for speaker diarization, with the model terms accepted on Hugging Face. Add it inside the app — Damwha opens without one."],
      ["Display language", "Korean and English. English UI is rolling out — some screens are still in Korean."],
      ["Conversation language", "Transcription: auto, Korean, English, Japanese, Chinese. Summaries: the transcript's language, Korean or English."],
    ],
  },
  consent: {
    title: "Before you record",
    body: "Damwha shows no recording notice. It stores a voiceprint for everyone in the conversation, not just you. Getting consent — and following the law where you are — is on whoever runs it.",
  },
  faq: {
    title: "Questions",
    items: [
      { q: "Is it free?", a: "Yes. Damwha is open source under the MIT license." },
      { q: "Do I need an internet connection?", a: "Only to download models the first time they're used and to check for updates. Recording, transcription and search work offline." },
      { q: "Does it run on Intel Macs or Windows?", a: "No. The ML pipeline runs on Apple's MLX, which needs Apple Silicon." },
      { q: "Is the app in English?", a: "English UI is rolling out. Settings and the app menu are translated, and the remaining screens follow in upcoming releases. Conversations in Korean, English, Japanese and Chinese can be transcribed, and summaries can be written in Korean or English." },
      { q: "Can it record live?", a: "Yes. Live recording shows a running transcript preview, and the full pipeline runs when you stop." },
      { q: "How do updates work?", a: "The app checks GitHub Releases and tells you when a new version is out. Download the new DMG and replace the app — your data stays." },
      { q: "Can I undo an update?", a: "Yes. Before a new version upgrades the database, Damwha keeps a snapshot, and the app menu can restore it." },
      { q: "Are the demo voices real people?", a: "No. The sample conversations are AI-generated (Google NotebookLM Audio Overviews), processed by the real pipeline." },
    ],
  },
  footer: {
    tagline: "Personal conversation memory for Mac.",
    source: "Source on GitHub",
    releases: "Release notes",
    demo: "Live demo",
    license: "MIT License",
  },
  notFound: { title: "Page not found", body: "This page doesn't exist.", home: "Go to the home page" },
};

export type Dictionary = typeof en;
```

`features.items[].image`는 `as const`라서 `Dictionary`에서 `"speakers" | "search" | "lenses" | "settings"`가 된다. `ko.ts`가 다른 문자열을 쓰면 `satisfies`가 실패하고, Task 4의 `IMAGES[f.image]`도 타입이 맞는다.

`site/src/i18n/ko.ts`:

```ts
import type { Dictionary } from "./en";

export const ko = {
  meta: {
    title: "담화 Damwha — 내 Mac에서 도는 화자별 대화 기록·검색",
    description:
      "대화를 녹음하면 누가·언제·무슨 말을 했는지 발화 단위로 정리하고, 어떤 줄이든 한 번에 원본 음성으로 이어 줘요. 전사·화자 식별·요약이 모두 내 Mac 안에서 돌아요.",
    ogImage: "/og-ko.png",
    ogImageAlt: "담화 — 그 말, 그 순간으로.",
    ogLocale: "ko_KR",
    ogLocaleAlt: "en_US",
  },
  nav: { home: "담화 홈", langSwitch: "English", langSwitchLabel: "View in English", github: "GitHub" },
  hero: {
    eyebrow: "무료 · 오픈소스 · macOS",
    title: "그 말, 그 순간으로.",
    lede: "담화는 대화를 녹음해 누가·언제·무슨 말을 했는지 발화 단위로 정리해요. 어떤 줄이든 한 번에 원본 음성으로 이어지고, 모든 처리는 내 Mac 안에서 끝나요.",
    download: "Mac용 다운로드",
    downloadFallback: "GitHub에서 받기",
    demo: "데모 써보기",
    demoUrl: "https://damwha-demo.0kimjae.dev/?lang=ko",
    demoNote: "읽기 전용 데모 · 가입 없이 바로",
    requirements: "Apple Silicon · macOS 15 이상",
    imageAlt: "담화의 전사 화면: 회의 목록, 화자별 색으로 나뉜 발화, 인사이트 패널",
  },
  problem: {
    title: "대화는 쌓이는데, 그때 한 말을 찾기는 여전히 어려워요.",
    body: "기억은 흐려지고 녹취록은 길어요. 대부분의 전사 도구는 매번 “화자 1”의 이름을 손으로 바꾸게 하죠. 담화는 발화 하나를 기본 단위로 삼아요 — 누가 말했는지, 언제인지, 원문과 음성, 앞뒤 맥락이 함께 묶여 있어요.",
  },
  jump: {
    title: "발화 점프",
    lede: "모든 대화를 검색하고 Enter를 누르면 그 초로 바로 가요. 발화는 강조되고 음성은 그 자리에서 재생을 기다려요.",
    caption: "⌘K → 검색 → Enter: 재생 헤드와 타임라인이 그 말을 한 순간으로 이동해요.",
    videoLabel: "화면 녹화: 검색해서 원본 음성의 그 순간으로 이동하는 모습",
    videoLang: "ko",
  },
  features: {
    title: "그 밖에 하는 일",
    items: [
      {
        title: "누가 말했는지 알아요",
        body: "목소리 기반 화자 식별. 한 번 등록한 화자는 이후 모든 대화에서 알아봐요.",
        image: "speakers",
        alt: "성문이 등록된 화자 관리 화면",
      },
      {
        title: "어디서든 ⌘K 검색",
        body: "뜻과 키워드를 함께 보는 하이브리드 검색으로, 어느 화면에서든 모든 발화와 대화를 찾아요.",
        image: "search",
        alt: "두 대화에 걸친 명령 팔레트 검색 결과",
      },
      {
        title: "렌즈: 결정·할 일·약속",
        body: "로컬 LLM이 대화마다 뽑아 주고, 항목마다 근거 발화로 가는 링크가 있어요. 마음껏 고쳐도 다시 뽑을 때 손댄 것은 그대로 남아요.",
        image: "lenses",
        alt: "여러 대화의 결정 사항을 모은 렌즈 화면",
      },
      {
        title: "내 Mac에 맞춰서",
        body: "칩과 메모리를 읽어 프리셋을 추천해요. 요약은 녹취 언어·한국어·영어 중에서 골라요 — 한국어 회의를 영어로 요약받을 수도 있어요.",
        image: "settings",
        alt: "이 Mac에 맞는 프리셋을 추천하는 처리 설정 화면",
      },
    ],
  },
  privacy: {
    title: "처음부터 내 Mac 안에서",
    body: "클라우드 ML이 없어요. 전사·화자 식별·검색·요약이 모두 내 Mac에서 돌고, 성문은 디스크에만 남아요. 모델은 처음 쓸 때 한 번 받고, 녹음은 이 Mac을 떠나지 않아요.",
    pipelineLabel: "처리 과정",
    pipeline: ["오디오", "정규화", "음성 구간", "화자 분리", "화자 식별", "Whisper 전사", "검색 색인", "렌즈 ∥ 요약"],
  },
  requirements: {
    title: "필요한 것",
    rows: [
      ["Mac", "Apple Silicon(M1 이상), macOS 15 이상"],
      ["모델 용량", "가볍게 약 8 GB · 표준 약 20 GB · 정확하게 약 40 GB, 처음 쓸 때 받아요"],
      ["Hugging Face 토큰", "화자 분리에만 필요해요. Hugging Face에서 모델 약관에 동의한 토큰을 앱 안에서 넣으면 되고, 없어도 앱은 열려요."],
      ["화면 언어", "한국어·영어. 영어 화면은 차례로 번역 중이에요."],
      ["대화 언어", "전사: 자동·한국어·영어·일본어·중국어. 요약: 녹취 언어·한국어·영어."],
    ],
  },
  consent: {
    title: "녹음하기 전에",
    body: "담화는 녹음 고지를 화면에 띄우지 않아요. 나뿐 아니라 대화에 참여한 모든 사람의 성문이 저장돼요. 동의를 받고 적용되는 법을 지키는 책임은 쓰는 사람에게 있어요.",
  },
  faq: {
    title: "자주 묻는 질문",
    items: [
      { q: "무료인가요?", a: "네. MIT 라이선스의 오픈소스예요." },
      { q: "인터넷이 필요한가요?", a: "모델을 처음 받을 때와 업데이트를 확인할 때만요. 녹음·전사·검색은 오프라인에서도 돼요." },
      { q: "Intel Mac이나 Windows에서도 되나요?", a: "아니요. 처리 파이프라인이 Apple Silicon 전용인 MLX 위에서 돌아요." },
      { q: "영어로도 쓸 수 있나요?", a: "화면은 영어로 차례로 번역 중이에요. 지금은 설정과 앱 메뉴가 번역돼 있고 나머지 화면은 다음 판부터 옮겨요. 한국어·영어·일본어·중국어 대화를 전사하고, 요약은 한국어나 영어로 받을 수 있어요." },
      { q: "실시간으로 녹음할 수 있나요?", a: "네. 녹음하는 동안 전사 미리보기가 흐르고, 멈추면 전체 처리가 돌아요." },
      { q: "업데이트는 어떻게 하나요?", a: "앱이 GitHub Releases를 확인해 새 버전을 알려 줘요. 새 DMG를 받아 앱을 바꾸면 되고, 데이터는 그대로예요." },
      { q: "업데이트를 되돌릴 수 있나요?", a: "네. 새 버전이 데이터베이스를 올리기 전에 스냅샷을 떠 두고, 앱 메뉴에서 되돌릴 수 있어요." },
      { q: "데모의 목소리는 실제 사람인가요?", a: "아니요. Google NotebookLM Audio Overview로 만든 AI 음성이고, 진짜 파이프라인으로 처리한 결과예요." },
    ],
  },
  footer: {
    tagline: "Mac을 위한 개인 대화 기억 장치.",
    source: "GitHub 소스",
    releases: "릴리스 노트",
    demo: "라이브 데모",
    license: "MIT 라이선스",
  },
  notFound: { title: "페이지를 찾을 수 없어요", body: "없는 페이지예요.", home: "처음으로" },
} satisfies Dictionary;
```

`site/src/i18n/index.ts`:

```ts
import { en, type Dictionary } from "./en";
import { ko } from "./ko";

export type Lang = "en" | "ko";
export type { Dictionary };

const DICTS: Record<Lang, Dictionary> = { en, ko };

export function getDictionary(lang: Lang): Dictionary {
  return DICTS[lang];
}

export function otherLang(lang: Lang): Lang {
  return lang === "en" ? "ko" : "en";
}
```

- [ ] **Step 6: 번역 누락이 잡히는지 확인**

`ko.ts`에서 `consent` 항목을 통째로 잠시 지운다.
Run: `pnpm --filter damwha-site exec astro check`
Expected: `ko.ts`에 `Property 'consent' is missing` 오류 1건. 확인했으면 되돌리고, 다시 돌려 0 errors를 본다.

- [ ] **Step 7: Base 레이아웃**

`site/src/layouts/Base.astro`:

```astro
---
// <head>의 모든 SEO 요소(스펙 §6.1)와 다크 모드·폰트. 페이지는 lang과 release만 넘긴다.
import "@fontsource-variable/inter";
import "@fontsource/geist-mono/400.css";
import interLatin from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import "../styles/site.css";
import { getAbsoluteLocaleUrl } from "astro:i18n";
import { getDictionary, type Lang } from "../i18n";
import type { ReleaseInfo } from "../lib/release";

interface Props {
  lang: Lang;
  release: ReleaseInfo;
  noindex?: boolean;
}
const { lang, release, noindex = false } = Astro.props;
const t = getDictionary(lang);
const site = Astro.site!.origin;
const selfUrl = getAbsoluteLocaleUrl(lang);
const ogImage = new URL(t.meta.ogImage, site).href;

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Damwha",
  alternateName: "담화",
  description: t.meta.description,
  url: selfUrl,
  image: ogImage,
  operatingSystem: "macOS 15+",
  applicationCategory: "ProductivityApplication",
  inLanguage: lang,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  license: "https://github.com/Yjason-K/Damwha/blob/main/LICENSE",
  sameAs: ["https://github.com/Yjason-K/Damwha"],
  ...(release.kind === "asset" ? { downloadUrl: release.dmgUrl, softwareVersion: release.version } : {}),
};
---
<!doctype html>
<html lang={lang}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!-- 첫 페인트 전 다크 판정. 토글이 없으므로 localStorage는 읽지 않는다(스펙 §3.8). -->
    <script is:inline>
      (function () {
        var dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
        var root = document.documentElement;
        if (dark) root.classList.add("dark");
        root.style.colorScheme = dark ? "dark" : "light";
      })();
    </script>
    <title>{t.meta.title}</title>
    <meta name="description" content={t.meta.description} />
    {noindex ? (
      <meta name="robots" content="noindex" />
    ) : (
      <>
        <link rel="canonical" href={selfUrl} />
        <link rel="alternate" hreflang="en" href={getAbsoluteLocaleUrl("en")} />
        <link rel="alternate" hreflang="ko" href={getAbsoluteLocaleUrl("ko")} />
        <link rel="alternate" hreflang="x-default" href={getAbsoluteLocaleUrl("en")} />
      </>
    )}
    <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="preload" href={interLatin} as="font" type="font/woff2" crossorigin />
    <meta name="theme-color" content="#0F161E" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Damwha" />
    <meta property="og:title" content={t.meta.title} />
    <meta property="og:description" content={t.meta.description} />
    <meta property="og:url" content={selfUrl} />
    <meta property="og:image" content={ogImage} />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content={t.meta.ogImageAlt} />
    <meta property="og:locale" content={t.meta.ogLocale} />
    <meta property="og:locale:alternate" content={t.meta.ogLocaleAlt} />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content={t.meta.title} />
    <meta name="twitter:description" content={t.meta.description} />
    <meta name="twitter:image" content={ogImage} />
    <script type="application/ld+json" set:html={JSON.stringify(jsonLd)} />
  </head>
  <body class="bg-app text-ink min-h-screen">
    <slot />
  </body>
</html>
```

404 페이지(`noindex`)는 canonical·hreflang을 내지 않는다. 색인하지 않을 페이지가 홈을 canonical로 가리키면 신호가 섞인다.

- [ ] **Step 8: 라우트와 robots**

`site/src/pages/index.astro`:

```astro
---
import Base from "../layouts/Base.astro";
import { getLatestRelease } from "../lib/release";
import { getDictionary } from "../i18n";
const release = await getLatestRelease();
const t = getDictionary("en");
---
<Base lang="en" release={release}><h1>{t.hero.title}</h1></Base>
```

`site/src/pages/ko/index.astro`는 `../../` 경로와 `"ko"`만 다르고 나머지는 같다.

```astro
---
import Base from "../../layouts/Base.astro";
import { getLatestRelease } from "../../lib/release";
import { getDictionary } from "../../i18n";
const release = await getLatestRelease();
const t = getDictionary("ko");
---
<Base lang="ko" release={release}><h1>{t.hero.title}</h1></Base>
```

`site/src/pages/404.astro` (두 언어를 한 장에):

```astro
---
import Base from "../layouts/Base.astro";
import { getLatestRelease } from "../lib/release";
import { getDictionary } from "../i18n";
const release = await getLatestRelease();
const en = getDictionary("en");
const ko = getDictionary("ko");
---
<Base lang="en" release={release} noindex>
  <main class="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-4">
    <h1 class="text-3xl font-semibold tracking-tight">{en.notFound.title}</h1>
    <p class="text-ink-2">{en.notFound.body} <a class="text-link underline" href="/">{en.notFound.home}</a></p>
    <p class="text-ink-2" lang="ko">{ko.notFound.body} <a class="text-link underline" href="/ko/">{ko.notFound.home}</a></p>
  </main>
</Base>
```

`site/public/robots.txt`:

```
User-agent: *
Allow: /

Sitemap: https://damwha.0kimjae.dev/sitemap-index.xml
```

`site/public/.gitkeep`을 지운다.

OG PNG는 Task 7에서 만든다. 그때까지 `og:image`는 없는 파일을 가리키지만, 검사기는 URL 모양만 본다.

- [ ] **Step 9: 전체 검사 통과**

Run: `pnpm site check`
Expected: `astro check` 0 errors → `astro build` Complete → `verify-seo: 통과`

- [ ] **Step 10: 실제 산출물로 변이 확인 (Review Focus 3)**

아래 셋을 하나씩 해 보고, 매번 `pnpm site check`가 해당 오류로 실패하는지 본 다음 되돌린다.

1. `Base.astro`에서 `hreflang="ko"` 줄 삭제 → `hreflang="ko"가 … 가리키지 않는다`
2. `ko.ts`의 `meta.title`을 `en.ts`와 같은 문자열로 → `en·ko의 title이 같다`
3. `index.astro`의 `<h1>`을 `<h2>`로 → `index.html: h1이 0개다`

- [ ] **Step 11: Commit**

```bash
git add site/
git commit -m "feat(site): 두 언어 사전·Base 레이아웃·SEO 검사기 — 번역 누락과 hreflang 어긋남을 빌드에서 잡는다

Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W"
```

---

### Task 4: 랜딩 섹션

**Files:**
- Create: `site/src/assets/` — `docs/images/2026-09-20/`에서 `00-hero.png`, `app-02-search.png`, `app-04-lenses.png`, `app-05-speakers.png`, `app-06-settings.png`를 같은 이름으로 복사
- Create: `site/src/components/Landing.astro`, `Header.astro`, `Hero.astro`, `DownloadButton.astro`, `Problem.astro`, `UtteranceJump.astro`, `Features.astro`, `Privacy.astro`, `Requirements.astro`, `Consent.astro`, `Faq.astro`, `Footer.astro`
- Modify: `site/src/pages/index.astro`, `site/src/pages/ko/index.astro`

**Interfaces:**
- Consumes: `getDictionary`, `otherLang`, `Lang` (Task 3), `ReleaseInfo`·`downloadHref`·`formatSize` (Task 2)
- Produces: `<Landing lang={Lang} release={ReleaseInfo} />`. `UtteranceJump`는 `/media/utterance-jump.<videoLang>.{mp4,webm}`과 `/media/utterance-jump-poster.<videoLang>.jpg`를 참조한다(파일은 Task 6).

- [ ] **Step 1: 스크린샷 복사**

```bash
mkdir -p site/src/assets
for f in 00-hero app-02-search app-04-lenses app-05-speakers app-06-settings; do
  cp docs/images/2026-09-20/$f.png site/src/assets/
done
```

- [ ] **Step 2: 컴포넌트 작성**

공통 규칙: 섹션은 `<section id=… class="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">`로 감싸고, 섹션 사이에 `border-t border-line`을 둔다. 제목은 `h2`이고 h1은 Hero에만 있다. 그라디언트·그림자 카드는 쓰지 않는다(스펙 §3.8).

`site/src/components/DownloadButton.astro`:

```astro
---
import type { Dictionary } from "../i18n";
import { downloadHref, formatSize, type ReleaseInfo } from "../lib/release";
interface Props { t: Dictionary; release: ReleaseInfo }
const { t, release } = Astro.props;
const label = release.kind === "asset" ? t.hero.download : t.hero.downloadFallback;
---
<div class="flex flex-col items-start gap-1.5">
  <a
    href={downloadHref(release)}
    class="bg-solid text-on-solid hover:bg-solid-hover inline-flex h-11 items-center gap-2 rounded-lg px-5 text-[15px] font-medium transition-colors"
  >
    <svg aria-hidden="true" viewBox="0 0 16 16" class="size-4" fill="currentColor"><path d="M8 1.5a.75.75 0 0 1 .75.75v7.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 0 1 1.06-1.06l2.22 2.22V2.25A.75.75 0 0 1 8 1.5ZM2.75 13a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H2.75Z"/></svg>
    {label}
  </a>
  <span class="text-ink-3 font-mono text-xs">
    {release.kind === "asset" && <>v{release.version} · {formatSize(release.sizeBytes)} · </>}{t.hero.requirements}
  </span>
</div>
```

`site/src/components/Header.astro`:

```astro
---
import { getRelativeLocaleUrl } from "astro:i18n";
import { getDictionary, otherLang, type Lang } from "../i18n";
interface Props { lang: Lang }
const { lang } = Astro.props;
const t = getDictionary(lang);
const other = otherLang(lang);
---
<header class="border-line border-b">
  <div class="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
    <a href={getRelativeLocaleUrl(lang)} class="flex items-center gap-2 font-semibold tracking-tight" aria-label={t.nav.home}>
      <img src="/favicon.svg" alt="" width="24" height="24" class="size-6" />
      Damwha
    </a>
    <nav class="flex items-center gap-5 text-sm">
      <a class="text-ink-2 hover:text-ink" href="https://github.com/Yjason-K/Damwha">{t.nav.github}</a>
      <a class="text-ink-2 hover:text-ink" href={getRelativeLocaleUrl(other)} hreflang={other} lang={other} aria-label={t.nav.langSwitchLabel}>{t.nav.langSwitch}</a>
    </nav>
  </div>
</header>
```

`site/src/components/Hero.astro`:

```astro
---
import { Picture } from "astro:assets";
import hero from "../assets/00-hero.png";
import DownloadButton from "./DownloadButton.astro";
import type { Dictionary } from "../i18n";
import type { ReleaseInfo } from "../lib/release";
interface Props { t: Dictionary; release: ReleaseInfo }
const { t, release } = Astro.props;
---
<section class="mx-auto max-w-6xl px-4 pt-16 pb-12 sm:px-6 sm:pt-24">
  <p class="text-mint-text font-mono text-xs tracking-wide uppercase">{t.hero.eyebrow}</p>
  <h1 class="mt-4 max-w-3xl text-4xl font-semibold tracking-[-0.02em] text-balance sm:text-6xl">{t.hero.title}</h1>
  <p class="text-ink-2 mt-6 max-w-2xl text-lg leading-relaxed text-pretty">{t.hero.lede}</p>
  <div class="mt-8 flex flex-wrap items-start gap-4">
    <DownloadButton t={t} release={release} />
    <div class="flex flex-col items-start gap-1.5">
      <a href={t.hero.demoUrl} class="border-line-2 hover:bg-sunken inline-flex h-11 items-center rounded-lg border px-5 text-[15px] font-medium transition-colors">{t.hero.demo}</a>
      <span class="text-ink-3 text-xs">{t.hero.demoNote}</span>
    </div>
  </div>
  <Picture
    src={hero}
    alt={t.hero.imageAlt}
    formats={["avif", "webp"]}
    widths={[696, 1392]}
    sizes="(min-width: 1152px) 1104px, 100vw"
    loading="eager"
    fetchpriority="high"
    class="mt-14 h-auto w-full"
  />
</section>
```

`site/src/components/Problem.astro`:

```astro
---
import type { Dictionary } from "../i18n";
interface Props { t: Dictionary }
const { t } = Astro.props;
---
<section id="problem" class="border-line border-t">
  <div class="mx-auto max-w-3xl px-4 py-20 sm:px-6 sm:py-28">
    <h2 class="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{t.problem.title}</h2>
    <p class="text-ink-2 mt-5 text-lg leading-relaxed">{t.problem.body}</p>
  </div>
</section>
```

`site/src/components/UtteranceJump.astro`:

```astro
---
import type { Dictionary } from "../i18n";
interface Props { t: Dictionary }
const { t } = Astro.props;
const v = t.jump.videoLang;
---
<section id="utterance-jump" class="border-line border-t">
  <div class="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
    <h2 class="text-2xl font-semibold tracking-tight sm:text-3xl">{t.jump.title}</h2>
    <p class="text-ink-2 mt-4 max-w-2xl text-lg leading-relaxed">{t.jump.lede}</p>
    <figure class="mt-10">
      <video
        data-autoplay-in-view
        class="border-line bg-sunken aspect-[1440/900] h-auto w-full rounded-lg border"
        muted
        loop
        playsinline
        preload="none"
        width="1440"
        height="900"
        poster={`/media/utterance-jump-poster.${v}.jpg`}
        aria-label={t.jump.videoLabel}
      >
        <source src={`/media/utterance-jump.${v}.webm`} type="video/webm" />
        <source src={`/media/utterance-jump.${v}.mp4`} type="video/mp4" />
      </video>
      <figcaption class="text-ink-3 mt-3 text-sm">{t.jump.caption}</figcaption>
    </figure>
  </div>
</section>
<script is:inline>
  // 화면에 들어오면 재생, 나가면 멈춤. reduce면 자동 재생하지 않고 controls를 준다(스펙 §7).
  (function () {
    var v = document.querySelector("video[data-autoplay-in-view]");
    if (!v) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
      v.controls = true;
      v.preload = "metadata";
      return;
    }
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          v.play().catch(function () { v.controls = true; });
        } else {
          v.pause();
        }
      });
    }, { threshold: 0.4 }).observe(v);
  })();
</script>
```

`site/src/components/Features.astro`:

```astro
---
import { Picture } from "astro:assets";
import speakers from "../assets/app-05-speakers.png";
import search from "../assets/app-02-search.png";
import lenses from "../assets/app-04-lenses.png";
import settings from "../assets/app-06-settings.png";
import type { Dictionary } from "../i18n";
interface Props { t: Dictionary }
const { t } = Astro.props;
const IMAGES = { speakers, search, lenses, settings };
const items = t.features.items;
---
<section id="features" class="border-line border-t">
  <div class="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
    <h2 class="text-2xl font-semibold tracking-tight sm:text-3xl">{t.features.title}</h2>
    <div class="mt-12 grid gap-x-10 gap-y-16 md:grid-cols-2">
      {items.map((f) => (
        <article>
          <Picture
            src={IMAGES[f.image]}
            alt={f.alt}
            formats={["avif", "webp"]}
            widths={[560, 1120]}
            sizes="(min-width: 768px) 540px, 100vw"
            class="border-line h-auto w-full rounded-lg border"
          />
          <h3 class="mt-6 text-lg font-semibold">{f.title}</h3>
          <p class="text-ink-2 mt-2 leading-relaxed">{f.body}</p>
        </article>
      ))}
    </div>
  </div>
</section>
```

`IMAGES[f.image]`는 Task 3에서 `image`를 `as const`로 둔 덕에 타입이 맞는다. 사전에 없는 키를 쓰면 `astro check`가 실패한다.

`site/src/components/Privacy.astro`:

```astro
---
import type { Dictionary } from "../i18n";
interface Props { t: Dictionary }
const { t } = Astro.props;
---
<section id="privacy" class="border-line border-t">
  <div class="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
    <h2 class="text-2xl font-semibold tracking-tight sm:text-3xl">{t.privacy.title}</h2>
    <p class="text-ink-2 mt-4 max-w-2xl text-lg leading-relaxed">{t.privacy.body}</p>
    <ol aria-label={t.privacy.pipelineLabel} class="mt-10 flex flex-wrap items-center gap-2 font-mono text-[13px]">
      {t.privacy.pipeline.map((step, i) => (
        <li class="flex items-center gap-2">
          <span class="border-line-2 bg-card rounded-md border px-2.5 py-1">{step}</span>
          {i < t.privacy.pipeline.length - 1 && <span aria-hidden="true" class="text-ink-3">→</span>}
        </li>
      ))}
    </ol>
  </div>
</section>
```

`site/src/components/Requirements.astro`:

```astro
---
import DownloadButton from "./DownloadButton.astro";
import type { Dictionary } from "../i18n";
import type { ReleaseInfo } from "../lib/release";
interface Props { t: Dictionary; release: ReleaseInfo }
const { t, release } = Astro.props;
---
<section id="download" class="border-line border-t">
  <div class="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
    <h2 class="text-2xl font-semibold tracking-tight sm:text-3xl">{t.requirements.title}</h2>
    <dl class="border-line mt-10 divide-y divide-line border-y">
      {t.requirements.rows.map(([k, v]) => (
        <div class="grid gap-1 py-4 sm:grid-cols-[14rem_1fr] sm:gap-6">
          <dt class="font-medium">{k}</dt>
          <dd class="text-ink-2">{v}</dd>
        </div>
      ))}
    </dl>
    <div class="mt-10"><DownloadButton t={t} release={release} /></div>
  </div>
</section>
```

`site/src/components/Consent.astro`:

```astro
---
import type { Dictionary } from "../i18n";
interface Props { t: Dictionary }
const { t } = Astro.props;
---
<section id="consent" class="border-line border-t">
  <div class="mx-auto max-w-3xl px-4 py-16 sm:px-6">
    <h2 class="text-xl font-semibold tracking-tight">{t.consent.title}</h2>
    <p class="text-ink-2 mt-3 leading-relaxed">{t.consent.body}</p>
  </div>
</section>
```

`site/src/components/Faq.astro`:

```astro
---
import type { Dictionary } from "../i18n";
interface Props { t: Dictionary }
const { t } = Astro.props;
---
<section id="faq" class="border-line border-t">
  <div class="mx-auto max-w-3xl px-4 py-20 sm:px-6 sm:py-28">
    <h2 class="text-2xl font-semibold tracking-tight sm:text-3xl">{t.faq.title}</h2>
    <div class="border-line mt-8 divide-y divide-line border-y">
      {t.faq.items.map((item) => (
        <details class="group py-4">
          <summary class="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
            {item.q}
            <span aria-hidden="true" class="text-ink-3 transition-transform group-open:rotate-45">+</span>
          </summary>
          <p class="text-ink-2 mt-3 leading-relaxed">{item.a}</p>
        </details>
      ))}
    </div>
  </div>
</section>
```

`site/src/components/Footer.astro`:

```astro
---
import type { Dictionary } from "../i18n";
interface Props { t: Dictionary }
const { t } = Astro.props;
const links = [
  [t.footer.source, "https://github.com/Yjason-K/Damwha"],
  [t.footer.releases, "https://github.com/Yjason-K/Damwha/releases"],
  [t.footer.demo, t.hero.demoUrl],
  [t.footer.license, "https://github.com/Yjason-K/Damwha/blob/main/LICENSE"],
] as const;
---
<footer class="border-line border-t">
  <div class="text-ink-3 mx-auto flex max-w-6xl flex-col gap-4 px-4 py-10 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6">
    <p>Damwha · {t.footer.tagline}</p>
    <ul class="flex flex-wrap gap-x-5 gap-y-2">
      {links.map(([label, href]) => <li><a class="hover:text-ink" href={href}>{label}</a></li>)}
    </ul>
  </div>
</footer>
```

`site/src/components/Landing.astro`:

```astro
---
import Header from "./Header.astro";
import Hero from "./Hero.astro";
import Problem from "./Problem.astro";
import UtteranceJump from "./UtteranceJump.astro";
import Features from "./Features.astro";
import Privacy from "./Privacy.astro";
import Requirements from "./Requirements.astro";
import Consent from "./Consent.astro";
import Faq from "./Faq.astro";
import Footer from "./Footer.astro";
import { getDictionary, type Lang } from "../i18n";
import type { ReleaseInfo } from "../lib/release";
interface Props { lang: Lang; release: ReleaseInfo }
const { lang, release } = Astro.props;
const t = getDictionary(lang);
---
<Header lang={lang} />
<main>
  <Hero t={t} release={release} />
  <Problem t={t} />
  <UtteranceJump t={t} />
  <Features t={t} />
  <Privacy t={t} />
  <Requirements t={t} release={release} />
  <Consent t={t} />
  <Faq t={t} />
</main>
<Footer t={t} />
```

- [ ] **Step 3: 라우트 교체**

`site/src/pages/index.astro`:

```astro
---
import Base from "../layouts/Base.astro";
import Landing from "../components/Landing.astro";
import { getLatestRelease } from "../lib/release";
const release = await getLatestRelease();
---
<Base lang="en" release={release}><Landing lang="en" release={release} /></Base>
```

`site/src/pages/ko/index.astro`:

```astro
---
import Base from "../../layouts/Base.astro";
import Landing from "../../components/Landing.astro";
import { getLatestRelease } from "../../lib/release";
const release = await getLatestRelease();
---
<Base lang="ko" release={release}><Landing lang="ko" release={release} /></Base>
```

- [ ] **Step 4: 검사와 산출물 확인**

Run: `pnpm site check`
Expected: 0 errors, `verify-seo: 통과`

Run:

```bash
grep -c '<script' site/dist/index.html
grep -o 'matchMedia("(prefers-color-scheme: dark)")' site/dist/index.html
grep -o 'damwha-demo.0kimjae.dev/?lang=[a-z]*' site/dist/index.html site/dist/ko/index.html | sort -u
grep -o 'releases/download/v[^"]*arm64.dmg' site/dist/index.html | head -1
```

Expected:
- `<script`는 3개다(다크 모드 인라인, JSON-LD, 영상 인라인). 4개 이상이면 번들 JS가 끼어든 것이므로 원인을 찾는다.
- 다크 모드 스크립트가 `<head>`에 있다.
- 데모 링크는 `index.html`이 `?lang=en`, `ko/index.html`이 `?lang=ko`다.
- DMG 직링크가 있다.

- [ ] **Step 5: 폴백 경로 확인 (Review Focus 1)**

`release.ts`의 `API` 상수를 잠시 `https://api.github.com/repos/Yjason-K/Damwha-does-not-exist/releases/latest`로 바꾸고 `pnpm site build`를 돌린다.
Expected: 빌드 성공, 로그에 `[release] GitHub API 404`. `site/dist/index.html`의 버튼이 `…/releases/latest`를 가리키고 "Download from GitHub" 문구와 `v0.` 표기가 없다. JSON-LD에 `downloadUrl`이 없다(`grep -c downloadUrl site/dist/index.html` → 0). 확인했으면 되돌린다.

- [ ] **Step 6: 눈으로 확인**

Run: `pnpm site preview` (먼저 `pnpm site build`)
브라우저로 `http://localhost:4321/`와 `/ko/`를 연다. 폭 390px과 1440px, 라이트와 다크에서 본다. macOS 설정에서 모드를 바꾸고 새로고침한다.

- 가로 스크롤이 없다.
- 다크에서 새로고침할 때 흰 화면이 번쩍이지 않는다.
- 헤더의 언어 링크가 서로를 가리킨다.
- 영상 자리는 이 시점에 포스터가 없어 빈 박스여도 된다(Task 6).

- [ ] **Step 7: Commit**

```bash
git add site/
git commit -m "feat(site): 랜딩 섹션 — Hero·발화 점프·기능·프라이버시·요구사항·동의·FAQ

Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W"
```

---

### Task 5: 데모 noindex와 문서 등록

**Files:**
- Modify: `fe/index.html` (description 메타 다음 줄)
- Create: `fe/src/app/index-html.test.ts`
- Modify: `fe/DESIGN.md` §0, 루트 `CLAUDE.md`(Monorepo map 표), `README.md`, `README.ko.md`, `deploy/demo/README.md`

**Interfaces:** 없음(문서·정적 HTML)

- [ ] **Step 1: 실패하는 테스트**

`fe/src/app/index-html.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 데모 SPA가 제품 사이트와 "Damwha" 검색을 다투지 않게 한다(제품 사이트 스펙 §3.6).
// 같은 index.html을 데스크톱 앱도 쓰지만 앱 화면은 어디서도 색인 대상이 아니다.
describe("index.html", () => {
  it("검색 색인에서 빠진다", () => {
    const html = readFileSync(join(__dirname, "../../index.html"), "utf8");
    expect(html).toMatch(/<meta\s+name="robots"\s+content="noindex"\s*\/?>/);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-fe exec vitest run src/app/index-html.test.ts`
Expected: FAIL (매치 없음)

- [ ] **Step 3: 구현**

`fe/index.html`에서 `<meta name="description" … />` 블록이 끝나는 줄 바로 다음에 넣는다.

```html
    <!-- 데모·앱 화면은 색인하지 않는다. 검색 도착지는 제품 사이트 damwha.0kimjae.dev다. -->
    <meta name="robots" content="noindex" />
```

- [ ] **Step 4: 통과와 fe 전체 테스트**

Run: `pnpm --filter damwha-fe exec vitest run src/app/index-html.test.ts && pnpm fe test`
Expected: 모두 PASS. `theme-inline-script.test.ts`도 계속 통과한다.

- [ ] **Step 5: 문서**

`fe/DESIGN.md` §0 표 바로 아래 줄에 추가한다.

```markdown
**제품 사이트(`site/`)도 이 값을 쓴다.** `site/scripts/sync-from-fe.mjs`가 빌드 때 `src/index.css`의
`:root`·`.dark` 블록과 `public/`의 마크 세 파일(`favicon.svg`·`favicon.ico`·`apple-touch-icon.png`)을
가져간다. 사본은 커밋되지 않으므로 마크의 "여섯 군데"는 늘지 않는다. 두 블록의 선택자를 바꾸거나 블록 안에
`}`를 넣으면 사이트 빌드가 멈춘다 — 의도된 실패다.
```

루트 `CLAUDE.md`의 Monorepo map 표에서 `fe/` 행 다음에 추가한다.

```markdown
| `site/` | `damwha-site` | Astro 7 정적 제품 사이트 — `damwha.0kimjae.dev`, `/`(en)·`/ko/`, Cloudflare Pages. Read [`site/README.md`](site/README.md). |
```

Commands 블록의 `pnpm dev` 줄 아래에 추가한다.

```bash
pnpm site:dev                 # 제품 사이트 :4321 (pnpm dev에는 끼지 않는다)
```

`README.md`에서 `### [▶ Try the live demo](https://damwha-demo.0kimjae.dev)` 줄을 아래로 바꾼다.

```markdown
### [Website](https://damwha.0kimjae.dev) · [▶ Try the live demo](https://damwha-demo.0kimjae.dev)
```

`README.ko.md`의 `### [▶ 공개 데모 열기](https://damwha-demo.0kimjae.dev)` 줄도 같은 방식으로 바꾼다.

```markdown
### [제품 사이트](https://damwha.0kimjae.dev/ko/) · [▶ 공개 데모 열기](https://damwha-demo.0kimjae.dev)
```

`deploy/demo/README.md`의 "시드를 새로 구울 때 체크리스트" 문장 끝에 추가한다.

```markdown
투어 회의나 검색어(`인지적 부채`)가 바뀌면 제품 사이트의 발화 점프 영상도 다시 녹화한다
(`pnpm site record`, `site/README.md`).
```

- [ ] **Step 6: Commit**

```bash
git add fe/index.html fe/src/app/index-html.test.ts fe/DESIGN.md CLAUDE.md README.md README.ko.md deploy/demo/README.md
git commit -m "chore: 데모 SPA를 색인에서 빼고 제품 사이트를 문서에 등록한다

Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W"
```

데모 서버에 noindex가 실제로 실리려면 데모 이미지를 다시 릴리스해야 한다(`deploy/demo/release.sh`). 공개 동작이라 이 계획에서는 하지 않는다. Task 9의 사람 체크리스트에 넣는다.

---

### Task 6: 발화 점프 영상 녹화

**Files:**
- Create: `site/scripts/record-utterance-jump.mjs`
- Create(산출물, 커밋): `site/public/media/utterance-jump.ko.mp4`, `utterance-jump.ko.webm`, `utterance-jump-poster.ko.jpg`

**Interfaces:**
- Consumes: 라이브 데모 `https://damwha-demo.0kimjae.dev`, 로컬 `ffmpeg`(libx264·libvpx-vp9)
- Produces: `pnpm site record --lang ko [--width 1440]` → `site/public/media/`의 세 파일

- [ ] **Step 1: Playwright 브라우저 준비**

Run: `pnpm --filter damwha-site exec playwright install chromium`
Expected: 이미 있으면 바로 끝난다.

- [ ] **Step 2: 스크립트 작성**

`site/scripts/record-utterance-jump.mjs`:

```js
// 라이브 데모에서 발화 점프를 녹화하고 mp4·webm·포스터로 인코딩한다(스펙 §7).
//   pnpm site record --lang ko [--width 1440]
// 2026-09-27 확인: networkidle은 오지 않는다(폴링·오디오). load 뒤 고정 대기를 쓴다.
// Playwright headless 페이지는 visibilityState가 visible이라 TanStack 폴링이 멈추지 않는다.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const DEMO = "https://damwha-demo.0kimjae.dev";
const QUERY = "인지적 부채"; // docs/images/2026-09-20/README.md app-02와 같은 질의
const LANDING = /\/meetings\/mtg_6\?u=/; // 같은 README의 web-03 도착지
const MAX_BYTES = 2 * 1024 * 1024;

// pnpm이 `--`를 그대로 넘기는 경우가 있어 걸러 낸다(worker:test 인자 전달 사고와 같은 종류).
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { lang: { type: "string", default: "ko" }, width: { type: "string", default: "1440" } },
});
const lang = values.lang;
if (lang !== "ko" && lang !== "en") throw new Error(`--lang은 ko|en: ${lang}`);
const width = Number(values.width);

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rawDir = join(siteRoot, ".recordings");
const outDir = join(siteRoot, "public/media");
rmSync(rawDir, { recursive: true, force: true });
mkdirSync(rawDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
  locale: lang === "ko" ? "ko-KR" : "en-US",
  recordVideo: { dir: rawDir, size: { width: 1440, height: 900 } },
});
// 첫 방문 모달을 건너뛰고, 투어 회의(mtg_7)가 목록에 드러난 상태로 시작한다(fe/src/features/demo/model/tour-state.ts).
await context.addInitScript(() =>
  localStorage.setItem("damwha.demo-tour.v1", JSON.stringify({ uploaded: true, noticeSeen: true })),
);
const page = await context.newPage();
const t0 = Date.now();

await page.goto(`${DEMO}/meetings/mtg_7?lang=${lang}`, { waitUntil: "load" });
await page.waitForTimeout(2500);
if ((await page.getByRole("dialog").count()) > 0) throw new Error("첫 방문 모달이 떠 있다 — tour-state 키가 바뀌었나?");

const clipStart = (Date.now() - t0) / 1000 - 0.8;
await page.waitForTimeout(800);
await page.keyboard.press("ControlOrMeta+k");
const input = page.getByRole("combobox");
await input.waitFor();
await page.waitForTimeout(500);
await input.pressSequentially(QUERY, { delay: 110 });
await page.getByRole("option").first().waitFor();
await page.waitForTimeout(1000);
await page.keyboard.press("Enter");
await page.waitForURL(LANDING, { timeout: 10_000 }).catch(() => {
  throw new Error(`도착지가 ${LANDING}이 아니다: ${page.url()} — 데모 시드가 바뀌었다. 녹화를 버린다.`);
});
await page.waitForTimeout(2800);
const clipEnd = (Date.now() - t0) / 1000;

await context.close(); // 여기서 webm이 닫힌다
await browser.close();

const raw = join(rawDir, readdirSync(rawDir).find((f) => f.endsWith(".webm")));
const dur = (clipEnd - clipStart).toFixed(2);
const ss = Math.max(0, clipStart).toFixed(2);
const base = join(outDir, `utterance-jump.${lang}`);
const vf = `scale=${width}:-2,fps=30`;
const ff = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });

ff("-ss", ss, "-t", dur, "-i", raw, "-an", "-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-preset", "slow", "-movflags", "+faststart", `${base}.mp4`);
ff("-ss", ss, "-t", dur, "-i", raw, "-an", "-vf", vf, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "38", "-row-mt", "1", `${base}.webm`);
ff("-ss", ss, "-i", raw, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "3", join(outDir, `utterance-jump-poster.${lang}.jpg`));

rmSync(rawDir, { recursive: true, force: true });
for (const ext of ["mp4", "webm"]) {
  const size = statSync(`${base}.${ext}`).size;
  console.log(`${base}.${ext}: ${(size / 1024 / 1024).toFixed(2)} MB`);
  if (size > MAX_BYTES) console.warn(`  2 MB 초과 — --width 1280으로 다시 돌린다(스펙 §7)`);
}
console.log(`구간 ${ss}s + ${dur}s, 도착 ${LANDING}`);
```

- [ ] **Step 3: 녹화**

Run: `pnpm site record --lang ko`
Expected: mp4·webm 크기 출력(각 2 MB 이하), `도착 /\/meetings\/mtg_6\?u=/`. 2 MB를 넘으면 `pnpm site record --lang ko --width 1280`으로 다시 돌린다.

- [ ] **Step 4: 영상 품질 확인**

`open site/public/media/utterance-jump.ko.mp4`로 재생해 본다.

- 첫 프레임이 mtg_7 화면이다.
- 팔레트가 열리고, 검색어가 한 글자씩 입력되고, 결과가 뜨고, mtg_6의 발화 강조가 보이는 순서로 흐른다.
- 글자가 뭉개져 읽기 어렵다면 Playwright 녹화의 비트레이트 한계다. 이때는 사람이 macOS 화면 기록(⌘⇧5)으로 같은 흐름을 찍고, 이 스크립트의 ffmpeg 세 줄을 그 파일에 돌린다(`-ss 0`, 길이는 전체). 그 결과를 커밋한다.

- [ ] **Step 5: 사이트에서 재생 확인 (Review Focus 4)**

Run: `pnpm site build && pnpm site preview`

- `http://localhost:4321/`에서 영상 섹션까지 스크롤하면 재생되고, 벗어나면 멈춘다.
- macOS 손쉬운 사용 › 디스플레이 › "동작 줄이기"를 켜고 새로고침하면 자동 재생되지 않고 컨트롤이 보인다.
- Safari에서도 재생된다(mp4 경로).

- [ ] **Step 6: Commit**

```bash
git add site/scripts/record-utterance-jump.mjs site/public/media/
git commit -m "feat(site): 데모에서 발화 점프를 녹화하는 스크립트와 ko 영상

Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W"
```

---

### Task 7: 언어별 OG 이미지

**Files:**
- Create: `site/scripts/make-og.mjs`
- Create(산출물, 커밋): `site/public/og-en.png`, `site/public/og-ko.png`

**Interfaces:**
- Consumes: `site/src/assets/00-hero.png`, `fe/public/favicon.svg`, `site/src/i18n/{en,ko}.ts`의 `hero.title`
- Produces: 1200×630 PNG 두 장

- [ ] **Step 1: 스크립트 작성**

`site/scripts/make-og.mjs`:

```js
// 언어별 OG 이미지(1200×630)를 Playwright로 한 번 렌더해 커밋한다(스펙 §6.1). 빌드에는 끼지 않는다.
//   pnpm site og
// 색은 fe 토큰이 아니라 브랜드 마크와 같은 고정값을 쓴다 — 미리보기는 라이트·다크와 무관하게 같게 보여야 한다.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hero = pathToFileURL(join(siteRoot, "src/assets/00-hero.png")).href;
const mark = readFileSync(join(siteRoot, "../fe/public/favicon.svg"), "utf8");
const TITLES = {
  en: { title: "Find the moment it was said.", sub: "Private, speaker-attributed conversation search for Mac" },
  ko: { title: "그 말, 그 순간으로.", sub: "내 Mac에서 도는 화자별 대화 기록·검색" },
};

const html = ({ title, sub }) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;width:1200px;height:630px;background:#0F161E;color:#F3F5F7;font-family:-apple-system,"Inter","Apple SD Gothic Neo",sans-serif;overflow:hidden;position:relative}
  .text{position:absolute;left:72px;top:72px;width:560px}
  .brand{display:flex;align-items:center;gap:14px;font-size:28px;font-weight:600}
  .brand svg{width:44px;height:44px}
  h1{font-size:60px;line-height:1.08;letter-spacing:-0.02em;margin:56px 0 0;font-weight:650}
  p{font-size:24px;line-height:1.35;color:#9AA4AF;margin:24px 0 0}
  img{position:absolute;left:640px;top:96px;width:720px}
</style></head><body>
  <div class="text"><div class="brand">${mark}Damwha</div><h1>${title}</h1><p>${sub}</p></div>
  <img src="${hero}" alt="">
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
for (const [lang, copy] of Object.entries(TITLES)) {
  await page.setContent(html(copy), { waitUntil: "load" });
  await page.screenshot({ path: join(siteRoot, `public/og-${lang}.png`) });
  console.log(`public/og-${lang}.png`);
}
await browser.close();
```

`TITLES`의 문구는 `en.ts`/`ko.ts`의 `hero.title`과 같다. 사전을 import하지 않는 이유가 있다. 이 스크립트는 Node가 TS 없이 돌리는 `.mjs`이고, 파일 두 개를 위해 빌드 도구를 끼우지 않는다. `hero.title`을 바꾸면 여기도 바꾸고 다시 돌린다. 이 규칙은 `site/README.md`(Task 9)에 적는다.

- [ ] **Step 2: 생성과 확인**

Run: `pnpm site og && sips -g pixelWidth -g pixelHeight site/public/og-en.png site/public/og-ko.png`
Expected: 두 파일 모두 1200×630. `open site/public/og-*.png`로 보고 한글이 □로 깨지지 않았는지, 텍스트가 스크린샷과 겹치지 않는지 확인한다.

- [ ] **Step 3: Commit**

```bash
git add site/scripts/make-og.mjs site/public/og-en.png site/public/og-ko.png
git commit -m "feat(site): 언어별 OG 이미지

Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W"
```

---

### Task 8: 릴리스 뒤 사이트 재빌드 훅

**Files:**
- Create: `desktop/scripts/lib/site-rebuild.mjs`, `desktop/tests/scripts/site-rebuild.test.ts`
- Modify: `desktop/scripts/publish.sh` (파일 끝, "Latest = …" 확인 블록 다음)

**Interfaces:**
- Produces: `triggerSiteRebuild({ hookUrl, fetchImpl?, log? }): Promise<"skipped" | "triggered" | "failed">` — 절대 throw하지 않는다. CLI `node desktop/scripts/lib/site-rebuild.mjs`는 `DAMWHA_SITE_DEPLOY_HOOK`을 읽고 항상 exit 0이다.

- [ ] **Step 1: 실패하는 테스트**

`desktop/tests/scripts/site-rebuild.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { triggerSiteRebuild } from "../../scripts/lib/site-rebuild.mjs";

describe("triggerSiteRebuild", () => {
  it("훅 URL이 없으면 건너뛰고 그렇다고 말한다", async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn();
    expect(await triggerSiteRebuild({ hookUrl: "", fetchImpl, log })).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("건너뜀"));
  });

  it("훅에 POST한다", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await triggerSiteRebuild({ hookUrl: "https://hook", fetchImpl, log: () => {} })).toBe("triggered");
    expect(fetchImpl).toHaveBeenCalledWith("https://hook", expect.objectContaining({ method: "POST" }));
  });

  it("HTTP 오류나 네트워크 오류는 failed — 던지지 않는다(릴리스는 이미 나갔다)", async () => {
    const bad = vi.fn(async () => new Response("no", { status: 500 }));
    expect(await triggerSiteRebuild({ hookUrl: "https://hook", fetchImpl: bad, log: () => {} })).toBe("failed");
    const boom = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await triggerSiteRebuild({ hookUrl: "https://hook", fetchImpl: boom, log: () => {} })).toBe("failed");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-desktop exec vitest run tests/scripts/site-rebuild.test.ts`
Expected: FAIL — 모듈 없음. `pnpm desktop exec`는 쓰지 않는다. 테스트 0개로 초록이 나오는 함정이 있다.

- [ ] **Step 3: 구현**

`desktop/scripts/lib/site-rebuild.mjs`:

```js
// 데스크톱 릴리스 뒤 제품 사이트(damwha.0kimjae.dev)를 다시 빌드시킨다(제품 사이트 스펙 §3.7).
// 사이트는 빌드 때 최신 릴리스 DMG를 읽으므로, 훅이 없으면 다운로드 버튼이 한 버전 늦는다.
// 훅 URL은 Cloudflare Pages가 준 비밀 URL이라 저장소에 두지 않는다 — 로컬 env DAMWHA_SITE_DEPLOY_HOOK.
// 어떤 실패도 발행을 실패시키지 않는다. 릴리스는 이미 나갔고, 늦은 버튼의 최악은 "한 버전 늦은 설치"다.
import { fileURLToPath } from "node:url";

export async function triggerSiteRebuild({ hookUrl, fetchImpl = fetch, log = console.log }) {
  if (!hookUrl) {
    log("사이트 재빌드 건너뜀 — DAMWHA_SITE_DEPLOY_HOOK이 없다. Cloudflare Pages에서 직접 재배포할 것.");
    return "skipped";
  }
  try {
    const res = await fetchImpl(hookUrl, { method: "POST", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      log(`사이트 재빌드 요청 실패(HTTP ${res.status}) — Cloudflare Pages에서 직접 재배포할 것.`);
      return "failed";
    }
    log("사이트 재빌드 요청함 — 몇 분 뒤 다운로드 버튼이 새 버전을 가리킨다.");
    return "triggered";
  } catch (e) {
    log(`사이트 재빌드 요청 실패(${e instanceof Error ? e.message : String(e)}) — Cloudflare Pages에서 직접 재배포할 것.`);
    return "failed";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await triggerSiteRebuild({ hookUrl: process.env.DAMWHA_SITE_DEPLOY_HOOK ?? "" });
}
```

`desktop/scripts/publish.sh`의 마지막 `fi` 다음, 파일 끝에 추가한다.

```bash

# 7. 제품 사이트 재빌드(제품 사이트 스펙 §3.7). 실패해도 exit 0 — 릴리스는 이미 나갔다.
echo "== site rebuild"
node "$DESKTOP/scripts/lib/site-rebuild.mjs" || true
```

파일 상단 주석에서 "gh를 부르기 전에 넷을 본다" 문단 다음에 한 줄을 추가한다.

```bash
# 발행과 Latest 확인이 끝나면 DAMWHA_SITE_DEPLOY_HOOK(있으면)으로 제품 사이트를 다시 빌드시킨다.
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter damwha-desktop exec vitest run tests/scripts/site-rebuild.test.ts && bash -n desktop/scripts/publish.sh`
Expected: 3 tests PASS, 문법 오류 없음

Run: `DAMWHA_SITE_DEPLOY_HOOK= node desktop/scripts/lib/site-rebuild.mjs; echo "exit=$?"`
Expected: `사이트 재빌드 건너뜀 …`, `exit=0`

- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/lib/site-rebuild.mjs desktop/tests/scripts/site-rebuild.test.ts desktop/scripts/publish.sh
git commit -m "feat(desktop): 발행 뒤 제품 사이트 재빌드 훅을 부른다(없으면 건너뜀)

Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W"
```

---

### Task 9: 사이트 README와 배포 절차

**Files:**
- Create: `site/README.md`

**Interfaces:** 없음

- [ ] **Step 1: README 작성**

`site/README.md`:

````markdown
# damwha-site

`damwha.0kimjae.dev` 제품 사이트. Astro 7 정적 빌드, 영어 `/`·한국어 `/ko/`.
설계: `docs/superpowers/specs/2026-09-26-product-site-design.md`.

## 명령 (저장소 루트에서)

```bash
pnpm site:dev              # :4321 — fe 토큰·마크를 먼저 가져온다
pnpm site:build            # site/dist
pnpm site check            # astro check + build + verify-seo (배포 전 이것 하나)
pnpm site test             # vitest
pnpm site record --lang ko   # 발화 점프 영상 재녹화 (Playwright + ffmpeg)
pnpm site og               # OG 이미지 재생성
```

## 알아 둘 것

- **문구는 `src/i18n/en.ts`·`ko.ts`에만 있다.** `ko.ts`가 `satisfies Dictionary`라 키가 빠지면 `astro check`가 실패한다. 용어는 `docs/superpowers/specs/2026-09-26-i18n-ko-en-design.md` §7을 따른다.
- **색과 마크는 `fe/`가 원본이다.** `scripts/sync-from-fe.mjs`가 빌드 때 `fe/src/index.css`의 `:root`·`.dark`와 `fe/public`의 마크 세 파일을 가져온다(gitignore). 직접 고치지 않는다.
- **다운로드 버튼은 빌드 때 GitHub 최신 릴리스를 읽는다.** 실패하면 빌드는 성공하고 버튼이 릴리스 페이지를 가리킨다. 로그에 `[release]` 경고가 남는다.
- **`hero.title`을 바꾸면** `scripts/make-og.mjs`의 `TITLES`도 바꾸고 `pnpm site og`를 다시 돌린다.
- **영어 UI 번역(다국어 설계 §9의 3·4단계)이 끝난 릴리스에서** `en.ts`의 `requirements.rows`의 Display language 줄, `faq`의 "Is the app in English?"와 `ko.ts`의 대응 문구를 고친다. 그리고 `pnpm site record --lang en` 뒤 `en.ts`의 `jump.videoLang`을 `"en"`으로 바꾼다.

## 배포 — Cloudflare Pages (처음 한 번, 사람이)

| 항목 | 값 |
|---|---|
| 프로젝트 이름 | `damwha-site` |
| 연결 | GitHub `Yjason-K/Damwha`, production branch `main` |
| Root directory | (비움) |
| Build command | `pnpm install --frozen-lockfile --filter damwha-site... && pnpm --filter damwha-site build` |
| Output directory | `site/dist` |
| 환경변수 | `SKIP_DEPENDENCY_INSTALL=1`, `NODE_VERSION=22` |
| Build watch paths (include) | `site/**`, `fe/src/index.css`, `fe/public/favicon*`, `fe/public/apple-touch-icon.png`, `pnpm-lock.yaml` |
| Custom domain | `damwha.0kimjae.dev` |

1. 대시보드 → Workers & Pages → Create → Pages → Connect to Git에서 위 값을 넣는다.
2. 첫 배포 로그에서 확인한다: pnpm 10.26.0, Node 22, `[release]` 경고 없음, `Complete!`. pnpm이 잡히지 않으면
   Build command 앞에 `corepack enable && `를 붙인다.
3. Custom domains → `damwha.0kimjae.dev`. `damwha` 서브도메인에 기존 DNS 레코드(예: 과거 Tunnel)가 있으면
   먼저 지운다. `damwha-demo`는 이름이 달라 영향이 없다.
4. Settings → Builds → Deploy hooks → 이름 `desktop-release`, 브랜치 `main`으로 만든다. URL을 셸 프로필에
   `export DAMWHA_SITE_DEPLOY_HOOK=…`로 둔다. `desktop/scripts/publish.sh`가 발행 뒤 이 훅을 부른다.
   비밀 URL이라 저장소에 넣지 않는다.

## 배포 뒤 (사람이)

- `https://damwha.0kimjae.dev/`와 `/ko/`가 뜨고, 언어 링크가 서로를 가리킨다.
- PageSpeed Insights 모바일에서 Performance·SEO·Accessibility·Best Practices가 모두 95 이상이다.
- Google Rich Results Test에서 `SoftwareApplication`이 인식된다.
- 카카오 링크 디버거와 슬랙에서 두 URL의 미리보기가 언어별로 다르게 뜬다.
- Google Search Console: `0kimjae.dev` 도메인 속성을 Cloudflare DNS TXT로 인증하고, `https://damwha.0kimjae.dev/sitemap-index.xml`을 제출한다. `/`와 `/ko/`는 URL 검사 → 색인 요청.
- 네이버 서치어드바이저: 사이트를 등록하고, 받은 인증 HTML 파일을 `site/public/`에 커밋해 배포한 뒤 인증한다. 사이트맵을 제출한다.
- GitHub 저장소 About → Website에 `https://damwha.0kimjae.dev`를 넣는다.
- 데모 이미지를 다시 릴리스해(`deploy/demo/release.sh`) `fe/index.html`의 noindex를 싣는다. 확인은
  `curl -s https://damwha-demo.0kimjae.dev/ | grep noindex`.
````

- [ ] **Step 2: 전체 확인**

Run: `pnpm site test && pnpm site check && pnpm fe test && pnpm --filter damwha-desktop exec vitest run tests/scripts/site-rebuild.test.ts`
Expected: 전부 PASS, `verify-seo: 통과`

Run: `graphify update .`
(루트 CLAUDE.md 규칙. graphify-out은 gitignore라 커밋 대상이 아니다.)

- [ ] **Step 3: Commit**

```bash
git add site/README.md
git commit -m "docs(site): 개발 명령·Cloudflare Pages 설정·배포 뒤 체크리스트

Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W"
```
