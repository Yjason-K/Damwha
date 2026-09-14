// desktop/scripts/check-bundle.mjs
// P1-C11(번들 위생)과 P1-C12의 정적 항목을 판정한다. 실패하면 exit 1.
import * as asar from "@electron/asar";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const desktop = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(desktop, "..");
const appDir = path.join(desktop, "out", "mac-arm64", "Damwha.app");
const contents = path.join(appDir, "Contents");
const apiDir = path.join(contents, "Resources", "api");

const failures = [];
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

// 1. desktop 패키지에 runtime 의존성이 없다
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
const deps = Object.keys(pkg.dependencies ?? {});
check("desktop has no runtime dependencies", deps.length === 0, deps.join(", "));

// 2. app.asar 안에 node_modules가 없다
const asarPath = path.join(contents, "Resources", "app.asar");
check("app.asar exists", fs.existsSync(asarPath));
if (fs.existsSync(asarPath)) {
  const entries = asar.listPackage(asarPath, { isPack: false });
  const bundled = entries.filter((e) => e.split("/").includes("node_modules"));
  check("app.asar has no node_modules", bundled.length === 0, `${bundled.length} entries`);
}

// 2b. 번들의 desktop 코드가 **지금 소스를 컴파일한 결과와 같다**. 이름만 보면 옛 dist가 실려도 통과한다 —
// 2026-09-13 실제로 그랬다(상태 창 모듈이 통째로 없고 shutdown.js는 옛 신호를 보냈다). 그래서 임시
// 디렉터리에 새로 컴파일해 .js를 바이트 단위로 대조한다. tsc 출력은 outDir과 무관하게 같다(실측).
// .map은 outDir 기준 상대 경로를 담아 달라지므로 비교하지 않는다.
if (fs.existsSync(asarPath)) {
  const fresh = fs.mkdtempSync(path.join(desktop, ".fresh-dist-"));
  try {
    execFileSync("pnpm", ["exec", "tsc", "-p", "tsconfig.json", "--outDir", fresh], { cwd: desktop, stdio: "pipe" });
    const walk = (dir, base = "") =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? walk(path.join(dir, d.name), path.join(base, d.name)) : [path.join(base, d.name)],
      );
    const want = walk(fresh).filter((f) => f.endsWith(".js")).sort();
    const bundledJs = asar
      .listPackage(asarPath, { isPack: false })
      .filter((e) => e.startsWith("/dist/") && e.endsWith(".js"))
      .map((e) => e.slice("/dist/".length))
      .sort();
    const missing = want.filter((f) => !bundledJs.includes(f));
    const extra = bundledJs.filter((f) => !want.includes(f));
    check("app.asar has every compiled desktop module and no stale extra", missing.length === 0 && extra.length === 0,
      [missing.length ? `missing: ${missing.join(", ")}` : "", extra.length ? `extra: ${extra.join(", ")}` : ""].filter(Boolean).join("; "));
    const differ = want.filter(
      (f) => bundledJs.includes(f) && !asar.extractFile(asarPath, path.join("dist", f)).equals(fs.readFileSync(path.join(fresh, f))),
    );
    check("app.asar desktop code equals a fresh compile of the current source", differ.length === 0, differ.join(", "));
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }
}

// 3. API 트리 밖을 가리키는 심볼릭 링크가 없다
const realApi = fs.realpathSync(apiDir);
const links = execFileSync("find", [apiDir, "-type", "l"], { encoding: "utf8" })
  .split("\n")
  .filter((l) => l.length > 0);
// 문자열 접두사 비교는 /…/api 와 /…/api-escaped 를 구별하지 못한다. 경로 관계로 판정한다.
const insideApi = (target) => {
  const rel = path.relative(realApi, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};
const escaping = links.filter((link) => {
  let target;
  try {
    target = fs.realpathSync(link);
  } catch {
    return true; // 깨진 링크도 위반이다
  }
  return !insideApi(target);
});
check("no symlink escapes the api tree", escaping.length === 0, escaping.slice(0, 5).join(", "));
console.log(`      (${links.length} symlink(s) inside the tree — allowed)`);

// 4. 저장소 경로와 pnpm store 경로 문자열이 없다
// grep의 exit 1만 "매치 없음"이다. 2 이상은 권한·I/O 오류이고, 그것을 통과로 삼으면
// 검사가 조용히 무력해진다.
for (const needle of [repo, path.join(process.env.HOME ?? "", ".pnpm-store"), "/.pnpm/"]) {
  if (needle.length < 4) continue;
  const r = spawnSync("grep", ["-rlF", "--", needle, contents], { encoding: "utf8" });
  if (r.error !== undefined) {
    check(`grep ran for "${needle}"`, false, String(r.error.message));
    continue;
  }
  if (r.status !== 0 && r.status !== 1) {
    check(`grep ran for "${needle}"`, false, `exit ${r.status}: ${(r.stderr ?? "").trim()}`);
    continue;
  }
  const files = (r.stdout ?? "")
    .split("\n")
    .filter((l) => l.length > 0)
    // codesign이 만드는 서명 매니페스트(_CodeSignature/CodeResources)는 번들 자신의
    // 내부 상대경로("Resources/api/node_modules/.pnpm/...")를 해시와 함께 나열할
    // 뿐이다 — 이 서명 이후 단계에서 생기는, 유출이 아닌 정상적인 자기 참조다.
    .filter((l) => !l.includes(`${path.sep}_CodeSignature${path.sep}`));
  check(`no "${needle}" in the bundle`, files.length === 0, files.slice(0, 5).join(", "));
}

// 5. SPA가 API 트리에 들어갔다
check("SPA is inside the api tree", fs.existsSync(path.join(apiDir, "dist", "public", "index.html")));

// 6. 마이크 사용 설명이 Info.plist에 있다
let usage = "";
try {
  usage = execFileSync(
    "plutil",
    ["-extract", "NSMicrophoneUsageDescription", "raw", "-o", "-", path.join(contents, "Info.plist")],
    { encoding: "utf8" },
  ).trim();
} catch {
  usage = "";
}
check("Info.plist carries NSMicrophoneUsageDescription", usage.length > 0, usage);

// 7. 재서명 후 앱이 Electron 프리빌트가 아니라 자기 identifier를 갖는다
// codesign -dv는 정보를 stdout이 아니라 stderr에 쓴다.
const codesignInfo = spawnSync("codesign", ["-dv", "--verbose=2", appDir], { encoding: "utf8" });
if (codesignInfo.error !== undefined) {
  check("codesign -dv ran", false, String(codesignInfo.error.message));
} else {
  const identifierLine = /^Identifier=(.+)$/m.exec(codesignInfo.stderr ?? "");
  const identifier = identifierLine ? identifierLine[1].trim() : "";
  check("codesign Identifier is kr.damwha.app (not Electron)", identifier === "kr.damwha.app", identifier || "(not found)");
}

// 8. 서명된 리소스가 온전하다 — 재서명이 앱을 깨뜨리지 않았는지
const codesignVerify = spawnSync("codesign", ["--verify", "--deep", "--strict", appDir], { encoding: "utf8" });
if (codesignVerify.error !== undefined) {
  check("codesign --verify ran", false, String(codesignVerify.error.message));
} else {
  check("codesign --verify --deep --strict passes", codesignVerify.status === 0, (codesignVerify.stderr ?? "").trim());
}

// 9~14. 내장 PostgreSQL 트리 (Electron Phase 3 스펙 §6.9)
const pgDir = path.join(contents, "Resources", "postgres");
const pgBins = ["postgres", "initdb", "pg_controldata", "createdb", "psql", "pg_dump", "pg_restore"];
const missingBins = pgBins.filter((b) => {
  try {
    fs.accessSync(path.join(pgDir, "bin", b), fs.constants.X_OK);
    return false;
  } catch {
    return true;
  }
});
check("postgres tree has every binary the app calls", missingBins.length === 0, missingBins.join(", "));

const extFiles = ["lib/postgresql/vector.dylib", "lib/postgresql/pg_bigm.dylib", "share/postgresql/extension/vector.control", "share/postgresql/extension/pg_bigm.control"];
const missingExt = extFiles.filter((f) => !fs.existsSync(path.join(pgDir, f)));
check("postgres tree has pgvector and pg_bigm", missingExt.length === 0, missingExt.join(", "));

// 심볼릭 링크는 따라가지 않는다 — 같은 dylib을 두 번 센다.
const pgMachos = fs.existsSync(pgDir)
  ? execFileSync("find", [pgDir, "-type", "f"], { encoding: "utf8" })
      .split("\n")
      .filter((f) => f.length > 0)
      .filter((f) => spawnSync("file", ["-b", f], { encoding: "utf8" }).stdout.startsWith("Mach-O"))
  : [];
check("postgres tree has Mach-O files to check", pgMachos.length > 0, `${pgMachos.length}`);

const badDeps = [];
for (const f of pgMachos) {
  const out = spawnSync("otool", ["-L", f], { encoding: "utf8" }).stdout ?? "";
  for (const line of out.split("\n").slice(1)) {
    const dep = line.trim().replace(/ \(compatibility.*$/, "");
    if (dep === "") continue;
    if (!/^(@loader_path\/|@rpath\/|\/usr\/lib\/|\/System\/Library\/)/.test(dep)) badDeps.push(`${path.relative(pgDir, f)} -> ${dep}`);
  }
}
check("postgres Mach-O files depend only on the bundle and the system", badDeps.length === 0, badDeps.slice(0, 5).join("; "));

const unsigned = pgMachos.filter((f) => spawnSync("codesign", ["--verify", f], { encoding: "utf8" }).status !== 0);
check("postgres Mach-O files carry a valid signature", unsigned.length === 0, unsigned.slice(0, 5).map((f) => path.relative(pgDir, f)).join(", "));

// 서버만 보면 클라이언트가 전부 죽은 트리를 통과시킨다 (Phase 0 R-2b). env -i로 둘 다 부른다.
for (const bin of ["postgres", "psql"]) {
  const r = spawnSync("env", ["-i", path.join(pgDir, "bin", bin), "--version"], { encoding: "utf8" });
  check(`env -i ${bin} --version runs from the bundle`, r.status === 0, (r.stdout || r.stderr || "").trim());
}

if (failures.length > 0) {
  console.error(`\n${failures.length} bundle hygiene check(s) failed.`);
  process.exit(1);
}
console.log("\nBundle hygiene: all checks passed.");
