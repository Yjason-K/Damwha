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
