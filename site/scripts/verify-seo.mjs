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
