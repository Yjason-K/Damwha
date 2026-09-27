// 언어별 OG 이미지(1200×630)를 Playwright로 한 번 렌더해 커밋한다(스펙 §6.1). 빌드에는 끼지 않는다.
//   pnpm site og
// 색은 fe 토큰이 아니라 브랜드 마크와 같은 고정값을 쓴다 — 미리보기는 라이트·다크와 무관하게 같게 보여야 한다.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// setContent 페이지는 about:blank 출처라 file:// 이미지를 막는다 — data URI로 넣는다.
const hero = `data:image/png;base64,${readFileSync(join(siteRoot, "src/assets/00-hero.png")).toString("base64")}`;
const mark = readFileSync(join(siteRoot, "../fe/public/favicon.svg"), "utf8");
const TITLES = {
  en: { title: "Wait, who said that?", sub: "Private, speaker-attributed conversation search for Mac" },
  ko: { title: "그때 누가 뭐라고 했더라?", sub: "내 Mac에서 도는 화자별 대화 기록·검색" },
};

const html = ({ title, sub }) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;width:1200px;height:630px;background:#0F161E;color:#F3F5F7;font-family:-apple-system,"Inter","Apple SD Gothic Neo",sans-serif;overflow:hidden;position:relative}
  .text{position:absolute;left:72px;top:72px;width:560px}
  .brand{display:flex;align-items:center;gap:14px;font-size:28px;font-weight:600}
  .brand svg{width:44px;height:44px}
  h1{word-break:keep-all;font-size:60px;line-height:1.08;letter-spacing:-0.02em;margin:56px 0 0;font-weight:650}
  p{word-break:keep-all;font-size:24px;line-height:1.35;color:#9AA4AF;margin:24px 0 0}
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
