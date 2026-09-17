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

// 트리 안 Mach-O 목록. 파일마다 file(1)을 부르면 Resources/python의 2만 파일에서 2분이 걸린다 —
// find -print0 을 받아 file을 묶어 부르면 수 초다 (build-python.sh:151 macho_list와 같은 수법).
// 심볼릭 링크는 따라가지 않는다(-type f): bin/python·bin/python3은 python3.12를 가리키는 링크일
// 뿐이고 postgres 트리도 같은 dylib을 여러 이름으로 두므로, 따라가면 같은 파일을 여러 번 센다.
// fat 바이너리는 file이 슬라이스마다 "<경로> (for architecture …): Mach-O …" 줄을 더 찍으므로
// 그 꼬리표를 떼고 중복을 지운다. 붙일 곳을 못 찾은 Mach-O 줄은 조용히 흘리지 않고 던진다 —
// 놓친 파일은 "서명 안 된 Mach-O 0건"을 거짓으로 만든다.
function machOFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = execFileSync("find", [root, "-type", "f", "-print0"], { encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0")
    .filter((f) => f.length > 0);
  const known = new Set(files);
  const found = new Set();
  for (let i = 0; i < files.length; i += 500) {
    const out = execFileSync("file", files.slice(i, i + 500), { encoding: "utf8", maxBuffer: 1 << 28 });
    for (const line of out.split("\n")) {
      const m = /^(.*?):\s*Mach-O/.exec(line);
      if (m === null) continue;
      const p = m[1].replace(/ \(for architecture [^)]*\)$/, "");
      if (!known.has(p)) throw new Error(`file(1) 출력을 경로에 붙이지 못했다: ${line}`);
      found.add(p);
    }
  }
  return files.filter((f) => found.has(f));
}

// arm64 슬라이스 기준 서명 검증. **반드시 --arch arm64 다** (build-python.sh:378과 같은 이유).
// arm64 슬라이스만 서명된 fat 바이너리를 plain --verify는 "not signed at all"로 잡지만
// --arch arm64는 통과시키고, 그 반대도 성립한다 — 이 번들에 universal Mach-O가 13개 있다.
// x86_64 전용 thin 파일에는 --arch arm64가 "object file format unrecognized"로 rc 1을 내는데
// 그것은 **무서명이 아니라 arm64 슬라이스가 없다는 뜻**이라 따로 세어 보고한다.
//
// **--verify만으로는 계약을 못 지킨다.** linker ad-hoc 서명(flags=0x20002(adhoc,linker-signed),
// entitlement 0개, hardened runtime 없음)도 rc 0으로 통과한다 — `desktop/build/ffmpeg/bin/ffmpeg`
// 사본으로 실측했다. 그래서 "서명이 있는가"와 "**계약대로** 서명됐는가"를 가른다: 통과한 파일마다
// codesign -d로 CodeDirectory의 flags를 읽어 runtime이 붙어 있는지 본다. 스펙 §6.1이 이름 붙인
// 실패 모드 — package.mjs의 `signAll(ffmpegTargets, …)` 한 줄이 사라지면 ffmpeg는 링커 ad-hoc
// 서명만 가진 채 hardened runtime .app 안에 들어간다 — 를 이것이 잡는다. 아래 18번의 entitlement
// 표본은 파일 몇 개만 보므로 그물이 되지 못한다. 454개 전수로 3.4초다(실측).
//
// **postgres 트리에는 걸지 않는다.** 별개 프로세스라 자기 서명의 플래그로 돌고, runtime 플래그
// 없는 ad-hoc 서명인 것이 맞다 — 위 9~14번 묶음의 postgres 서명 검사가 plain --verify인 것이 그래서다.
function verifyArm64(files) {
  const unsigned = [];
  const noArm64 = [];
  const noRuntime = [];
  for (const f of files) {
    const r = spawnSync("codesign", ["--verify", "--arch", "arm64", f], { encoding: "utf8" });
    if (r.status !== 0) {
      const why = (r.stderr ?? "").trim();
      (/object file format unrecognized/.test(why) ? noArm64 : unsigned).push(`${f} (${why.split("\n")[0]})`);
      continue;
    }
    // codesign -d는 정보를 stdout이 아니라 stderr에 쓴다 (아래 7번과 같다).
    const d = spawnSync("codesign", ["-d", "--verbose=4", "--arch", "arm64", f], { encoding: "utf8" });
    const m = /^CodeDirectory\b.*\bflags=(\S+)/m.exec(d.stderr ?? "");
    if (m === null) {
      // 플래그를 못 읽은 것을 통과로 삼지 않는다 — 검사가 조용히 무력해진다.
      noRuntime.push(`${f} (flags 줄을 읽지 못했다: ${(d.stderr ?? "").trim().split("\n")[0] || `rc ${d.status}`})`);
    } else if (!/\bruntime\b/.test(m[1])) {
      noRuntime.push(`${f} (flags=${m[1]})`);
    }
  }
  return { unsigned, noArm64, noRuntime };
}

// codesign이 실제로 새긴 entitlement 키 목록. **표본은 실행 파일이어야 한다** — .so·.dylib은
// --entitlements로 서명해도 키를 0개 보인다(실측: .so 0개, bin/python3.12 2개). flags의
// 0x10002(adhoc,runtime)은 그래도 붙으므로 "hardened runtime이 걸렸는가"와 "entitlement가
// 새겨졌는가"는 다른 질문이다.
function entitlementKeys(target) {
  const r = spawnSync("codesign", ["-d", "--entitlements", "-", "--xml", target], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return [...(r.stdout ?? "").matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]).sort();
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
//
// -a(바이너리도 텍스트로 본다)를 붙이는 이유: spawnSync는 셸을 거치지 않아 PATH의 진짜
// BSD grep을 받고 그것은 -a 없이도 바이너리를 건너뛰지 않지만(실측: -rlF 456건 / -ralF 456건),
// GNU grep은 -a 없이 바이너리 매치를 "Binary file … matches"로만 알리고 -l과 섞이면 셈이
// 달라진다. 번들의 대부분이 바이너리(Resources/python 1.3 GB)이므로 의도를 명시해 둔다.
for (const needle of [repo, path.join(process.env.HOME ?? "", ".pnpm-store"), "/.pnpm/"]) {
  if (needle.length < 4) continue;
  const r = spawnSync("grep", ["-ralF", "--", needle, contents], { encoding: "utf8" });
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

const pgMachos = machOFiles(pgDir);
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

// 15~21. 내장 Python 런타임과 내장 ffmpeg (Electron Phase 4 스펙 §6.1)
const pyDir = path.join(contents, "Resources", "python");
const ffDir = path.join(contents, "Resources", "ffmpeg");

// 15. 두 트리가 있고 실행 파일을 갖고 있다. 트리가 통째로 빠진 .app은 첫 실행에서야 드러난다.
const runtimeBins = [
  path.join(pyDir, "bin", "python3.12"),
  path.join(ffDir, "bin", "ffmpeg"),
  path.join(ffDir, "bin", "ffprobe"),
];
const missingRuntimeBins = runtimeBins.filter((b) => {
  try {
    fs.accessSync(b, fs.constants.X_OK);
    return false;
  } catch {
    return true;
  }
});
check(
  "python and ffmpeg trees carry their executables",
  missingRuntimeBins.length === 0,
  missingRuntimeBins.map((b) => path.relative(contents, b)).join(", "),
);

// 16. 트리만 있고 패키지가 없는 경우를 잡는다. mlx_lm은 스펙 §2.4(mlx/mlx-lm 버전 정렬)의
// 회귀 방지다 — 정렬이 깨지면 uv가 mlx_lm 설치를 통째로 건너뛴 트리가 나온다.
const sitePackages = path.join(pyDir, "lib", "python3.12", "site-packages");
const wantPkgFiles = [
  path.join("damwha_worker", "__main__.py"),
  path.join("mlx_lm", "server.py"),
];
const missingPkgFiles = wantPkgFiles.filter((f) => !fs.existsSync(path.join(sitePackages, f)));
check("site-packages carries damwha_worker and mlx_lm", missingPkgFiles.length === 0, missingPkgFiles.join(", "));

// 17. arm64 무서명 Mach-O 0건. Python 트리는 build-python.sh가, ffmpeg는 package.mjs가
// 서명하고, .app 서명이 그 위를 리소스 해시로 봉인한다.
const runtimeMachos = [...machOFiles(pyDir), ...machOFiles(ffDir)];
check("python and ffmpeg trees have Mach-O files to check", runtimeMachos.length > 0, `${runtimeMachos.length}`);
const { unsigned: rtUnsigned, noArm64: rtNoArm64, noRuntime: rtNoRuntime } = verifyArm64(runtimeMachos);
check(
  "every arm64 Mach-O in the python and ffmpeg trees is signed",
  rtUnsigned.length === 0,
  rtUnsigned.slice(0, 5).map((f) => path.relative(contents, f)).join("; "),
);
// 17b. 그 서명이 hardened runtime인가. 실패는 **어느 파일인지** 말해야 한다 — 3만 파일 트리에서
// "FAIL"만으로는 못 고친다.
const rtVerified = runtimeMachos.length - rtUnsigned.length - rtNoArm64.length;
check(
  "every signed arm64 Mach-O in the python and ffmpeg trees carries hardened runtime",
  rtNoRuntime.length === 0,
  rtNoRuntime.length === 0
    ? `${rtVerified}/${rtVerified} flags=…(runtime)`
    : `${rtNoRuntime.length} of ${rtVerified}: ${rtNoRuntime.slice(0, 5).map((f) => path.relative(contents, f)).join("; ")}`,
);
console.log(`      (${rtNoArm64.length} x86_64-only file(s) with no arm64 slice — not run on this Mac)`);

// 18. entitlement가 **실제로** 새겨졌고 plist 둘이 갈라져 있다. 서명에 실패해도 .app은
// linker-signed 상태로 실행되므로, 실행이 아니라 이걸 봐야 한다.
const appKeys = entitlementKeys(appDir);
const pyKeys = entitlementKeys(path.join(pyDir, "bin", "python3.12"));
const MIN = ["com.apple.security.cs.allow-unsigned-executable-memory", "com.apple.security.cs.disable-library-validation"];
const JIT = "com.apple.security.cs.allow-jit";
check(
  "the .app carries the three entitlements of entitlements.mac.plist",
  appKeys !== null && appKeys.length === 3 && [...MIN, JIT].every((k) => appKeys.includes(k)),
  (appKeys ?? ["(codesign -d failed)"]).join(", "),
);
// Python 트리에는 allow-jit을 주지 않는다 — 안 쓰는 권한이다. 거꾸로 .app에 이 최소 집합만
// 주면 V8이 CodeRange 예약에 실패해 앱이 rc=133으로 죽는다 (2026-09-16 실측).
check(
  "bin/python3.12 carries exactly the two entitlements of entitlements.python.plist",
  pyKeys !== null && pyKeys.length === 2 && MIN.every((k) => pyKeys.includes(k)) && !pyKeys.includes(JIT),
  (pyKeys ?? ["(codesign -d failed)"]).join(", "),
);
// ffmpeg도 python plist다. 17b가 hardened runtime을 보증하지만 **어느 plist로** 서명됐는지는
// 보지 않는다 — package.mjs가 ffmpeg를 python 트리와 같은 plist로 서명하는 것이 계약이다
// (트랜스코딩 자식이라 allow-jit은 필요 없다).
const ffKeys = entitlementKeys(path.join(ffDir, "bin", "ffmpeg"));
check(
  "bin/ffmpeg carries exactly the two entitlements of entitlements.python.plist",
  ffKeys !== null && ffKeys.length === 2 && MIN.every((k) => ffKeys.includes(k)) && !ffKeys.includes(JIT),
  (ffKeys ?? ["(codesign -d failed)"]).join(", "),
);
// 헬퍼는 우리가 따로 서명하지 않는다 — .app의 `--deep`이 mac plist로 같이 서명한다. 렌더러
// 헬퍼가 V8을 돌리므로 allow-jit까지 셋을 물려받아야 하고, 그러지 못하면 앱이 rc=133으로
// 죽는다 (2026-09-16 실측). 지금 --deep이 옳게 도는 것이 우연이 아님을 여기서 고정한다.
const helperKeys = entitlementKeys(path.join(contents, "Frameworks", "Damwha Helper (Renderer).app"));
check(
  "Damwha Helper (Renderer).app inherits the three entitlements of entitlements.mac.plist",
  helperKeys !== null && helperKeys.length === 3 && [...MIN, JIT].every((k) => helperKeys.includes(k)),
  (helperKeys ?? ["(codesign -d failed)"]).join(", "),
);

// 19. __pycache__ 0개. 있으면 빌드 머신의 절대 경로가 co_filename으로 .pyc에 박힌 채 실려
// 나간다 (스펙 §6.1-b 4번).
const pycache = fs.existsSync(pyDir)
  ? execFileSync("find", [pyDir, "-name", "__pycache__"], { encoding: "utf8", maxBuffer: 1 << 28 })
      .split("\n")
      .filter((l) => l.length > 0)
  : [];
check("no __pycache__ under Resources/python", pycache.length === 0, `${pycache.length}`);

// 20. bin/의 콘솔 스크립트 셔뱅이 번들 안을 가리킨다.
//
// uv/pip이 만든 원래 셔뱅은 **설치 시점 인터프리터의 절대 경로**다. build-python.sh가 그것을
// 위치 독립 폴리글랏으로 다시 쓴다 — 그래서 1행은 #!/bin/sh이고 인터프리터는 **2행**에 있다.
// 2행을 안 보고 1행만 보면 "#!로 시작하니 통과"가 되어 검사가 통째로 무력해진다.
//
// 대상은 **Resources/python/bin/ 아래 파일뿐**이다. site-packages 안 제3자 wheel이 자기 데이터에
// 담은 문자열은 위 4번(금지 문자열) 검사의 소관이고 여기서 보지 않는다.
const POLYGLOT = '${0%/*}/python3.12';
const binDir = path.join(pyDir, "bin");
const binScripts = fs.existsSync(binDir)
  ? fs
      .readdirSync(binDir, { withFileTypes: true })
      .filter((d) => d.isFile()) // 심볼릭 링크(python, python3)는 제외한다
      .map((d) => path.join(binDir, d.name))
      .filter((f) => fs.readFileSync(f).subarray(0, 2).toString("latin1") === "#!") // python3.12는 Mach-O다
  : [];
const badShebang = binScripts.filter((f) => {
  const [first, second = ""] = fs.readFileSync(f).subarray(0, 512).toString("latin1").split("\n");
  return first.trim() !== "#!/bin/sh" || !second.includes(POLYGLOT);
});
check("every script in Resources/python/bin has a bundle-relative shebang", binScripts.length > 0 && badShebang.length === 0,
  binScripts.length === 0 ? "no scripts found" : badShebang.slice(0, 5).map((f) => path.basename(f)).join(", "));
console.log(`      (${binScripts.length} console script(s) checked)`);

if (failures.length > 0) {
  console.error(`\n${failures.length} bundle hygiene check(s) failed.`);
  process.exit(1);
}
console.log("\nBundle hygiene: all checks passed.");
