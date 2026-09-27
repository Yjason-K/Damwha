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
