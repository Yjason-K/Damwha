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
