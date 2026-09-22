// desktop/scripts/package.mjs
// 순서: be build → fe build → pnpm deploy → SPA 복사 → electron-builder.
// pnpm deploy 뒤에 SPA를 넣는 이유: nest build가 dist를 비울 수 있다 (스펙 R1-3).
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { machOFiles } from "./lib/macho.mjs";
import { assertIdentityInKeychain, codesign, loadSigning } from "./lib/signing.mjs";

const desktop = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(desktop, "..");
const apiTree = path.join(desktop, "build", "api");

const RELEASE = process.argv.includes("--release");

// DMG 경로는 Step 5가 정하고 Step 6·8이 쓴다. if (RELEASE) 블록 밖에 두지 않으면 스코프가 끊긴다.
let dmgPath = null;

// 릴리스에서만 태그를 본다. 개발 중 패키징이 잦아 태그 없는 커밋에서 자주 돈다.
//
// **태그는 desktop-v<version>이다** (Phase 6a 스펙 §4): v<version>은 deploy/release.sh가
// 셀프호스팅 웹 배포에 이미 쓰고 있고(v0.1.1~v0.2.3 실재, 자산은 tarball과 wheel), 그 스크립트는
// 태그 버전이 be/worker/pyproject.toml과 다르면 거절한다. 섞으면 6b의 릴리스 조회가 웹 배포를
// 가리켜 앱이 사용자에게 tarball을 권한다.
const desktopPkg = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
const expectedTag = `desktop-v${desktopPkg.version}`;
if (RELEASE) {
  const tag = execFileSync("git", ["describe", "--tags", "--exact-match", "--match", "desktop-v*"], {
    cwd: repo, encoding: "utf8",
  }).trim();
  if (tag !== expectedTag) {
    throw new Error(`태그가 ${tag}인데 package.json은 ${desktopPkg.version}이다 — ${expectedTag}여야 한다`);
  }
}

// 서명 신원을 **빌드 전에** 확인한다. 뒤에서 알면 그때까지의 시간이 날아간다.
const signing = loadSigning(desktop);
assertIdentityInKeychain(signing.identity);

function run(cmd, args, cwd = repo, extraEnv = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnv } });
}

// 내장 PostgreSQL 트리를 desktop/build/postgres에 스테이징한다. extraResources(from: build)가 그대로 Resources/postgres로
// 싣는다 (Electron Phase 3 스펙 §6.8). 캐시가 있으면 복사만 한다. 번들 쪽 준비가 실패하면 여기서 멈춘다 — PG가 없는
// .app은 첫 실행에서야 "내장 데이터베이스 실행 파일이 없어요"로 드러난다.
run("bash", [path.join("scripts", "build-postgres.sh")], desktop);

// 내장 Python 런타임(worker 층까지)과 내장 ffmpeg도 같은 자리에 스테이징한다 —
// desktop/build/python, desktop/build/ffmpeg. 여기서 멈추는 이유도 PG와 같다: Python이나
// ffmpeg가 빠진 .app은 첫 실행에서야 드러난다 (Electron Phase 4 스펙 §6.1).
// 둘 다 캐시가 있으면 스테이징만 하고 끝난다.
run("bash", [path.join("scripts", "build-python.sh")], desktop);
run("bash", [path.join("scripts", "build-ffmpeg.sh")], desktop);

// desktop 자신을 **먼저, 깨끗하게** 컴파일한다. electron-builder는 package.json의 main(dist/main.js)과
// dist/ 전체를 그대로 싣는데, 루트 `pnpm build`에는 desktop의 컴파일이 없다(desktop에는 build 스크립트가
// 없고 compile만 있다). 이 줄이 없던 2026-09-13, 그날 새벽의 dist가 그대로 실려 그 뒤 소스 커밋
// 15개(Task 14 상태 창 전체, 최종 리뷰의 SIGTERM 수정)가 빠진 앱으로 packaged 검증을 시작했다.
// dist를 지우는 이유: 소스에서 지운 모듈의 .js가 남아 번들에 실리지 않게 한다.
fs.rmSync(path.join(desktop, "dist"), { recursive: true, force: true });
run("pnpm", ["--filter", "damwha-desktop", "run", "compile"]);

run("pnpm", ["--filter", "damwha-be", "run", "build"]);
// fe/.env 의 VITE_API_BASE_URL 은 절대 URL이다. 셸 환경변수가 .env 파일을 이기므로
// 여기서 덮어 단일 origin 빌드를 만든다 (스펙 §11).
run("pnpm", ["--filter", "damwha-fe", "run", "build"], repo, { VITE_API_BASE_URL: "/api" });

fs.rmSync(apiTree, { recursive: true, force: true });
// Task 2가 실측으로 확정한 형태다. 맨 `--prod deploy`는 pnpm 10.26.0에서
// ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE로 아예 거절당한다. 플래그는 이 명령에만
// 붙으므로 루트 .npmrc는 그대로다.
run("pnpm", [
  "--filter=damwha-be",
  "--prod",
  "--config.inject-workspace-packages=true",
  "deploy",
  path.relative(repo, apiTree),
]);

const publicDir = path.join(apiTree, "dist", "public");
fs.rmSync(publicDir, { recursive: true, force: true });
fs.cpSync(path.join(repo, "fe", "dist"), publicDir, { recursive: true });
console.log(`SPA copied into ${path.relative(repo, publicDir)}`);

// pnpm deploy가 워크스페이스 패키지(@damwha/contracts)를 절대 file:// 경로로 박아 넣는다
// — pnpm-lock.yaml과 package.json의 dependencies 필드 양쪽에. 둘 다 `node dist/main.js`가
// 읽지 않는 메타데이터라(모듈 해석은 node_modules 존재만 본다) 이 개발 머신의 경로가
// 번들에 그대로 실리는 걸 막으려면 지우거나 고쳐야 한다 (check-bundle.mjs가 이 경로를 잡아낸다).
// pnpm-lock.yaml은 통째로 지운다. package.json은 electron-builder가 npm 패키지 여부를
// 판단하는 데 여전히 쓰므로 남기고, 문제되는 값만 고친다.
fs.rmSync(path.join(apiTree, "pnpm-lock.yaml"), { force: true });
const apiPkgPath = path.join(apiTree, "package.json");
const apiPkg = JSON.parse(fs.readFileSync(apiPkgPath, "utf8"));
if (apiPkg.dependencies?.["@damwha/contracts"]?.startsWith("@damwha/contracts@file:")) {
  apiPkg.dependencies["@damwha/contracts"] = "workspace:*";
}
fs.writeFileSync(apiPkgPath, `${JSON.stringify(apiPkg, null, 2)}\n`);

// pnpm이 만드는 모든 node_modules/.bin 셸 스크립트는 자기 NODE_PATH에 이 개발 머신의
// apiTree 절대경로를 그대로 박아 넣는다. `node dist/main.js`는 require()로만 모듈을
// 찾고 .bin 스크립트를 절대 실행하지 않으므로 안전하게 지운다. node_modules/.pnpm/lock.yaml도
// 같은 이유로 지운다 — pnpm 자신의 내부 북키핑 파일일 뿐 어떤 코드도 읽지 않는다.
const apiNodeModules = path.join(apiTree, "node_modules");
run("find", [apiNodeModules, "-name", ".bin", "-type", "d", "-prune", "-exec", "rm", "-rf", "{}", "+"], desktop);
fs.rmSync(path.join(apiNodeModules, ".pnpm", "lock.yaml"), { force: true });

run("pnpm", ["exec", "electron-builder", "--dir"], desktop);

// electron-builder는 target: dir + 서명 설정 없음이면 번들을 재서명하지 않는다.
// 그러면 Electron 프리빌트의 링커 서명이 남아 Identifier가 Electron이 되고,
// Info.plist가 서명에 묶이지 않는다. 그 상태의 앱은 자기 이름의 TCC 주체가 아니라
// 이 맥의 다른 무서명 Electron 앱과 마이크 권한을 공유한다. 아래에서 Developer ID로
// 직접 재서명한다 — 공증과 DMG는 Task 6이고, 여기서 필요한 것은 번들이 자기 정체성과
// 우리 팀의 서명을 갖는 것이다.
const appPath = path.join(desktop, "out", "mac-arm64", "Damwha.app");
const resources = path.join(appPath, "Contents", "Resources");
const pythonEnts = path.join(desktop, "build-resources", "entitlements.python.plist");
const macEnts = path.join(desktop, "build-resources", "entitlements.mac.plist");

// entitlements를 실제로 주려면 --options runtime(hardened runtime)이 있어야 한다. 그리고
// **plist 둘을 갈라 쓴다.**
//   - Resources/python 안의 Mach-O들과 Resources/ffmpeg/bin/* → entitlements.python.plist.
//     제3자 wheel의 .so는 우리 신원으로 서명되지 않으므로 disable-library-validation이 있어야
//     로드되고, numba의 LLVM이 **모듈 로드 시점에** 실행 메모리를 잡으므로
//     allow-unsigned-executable-memory가 필요하다 (Task 2 실측: 전자가 없으면 dyld SIGABRT,
//     후자가 없으면 import numba가 SIGKILL).
//   - Damwha.app → entitlements.mac.plist. 위 둘에 allow-jit이 더 붙는다. .app에 python plist를
//     주면 앱이 죽는다 — --deep이 Electron Framework와 헬퍼에도 hardened runtime을 걸고, V8이
//     allow-jit 없이 CodeRange 가상 메모리 예약에 실패해 "Fatal process out of memory"로 rc=133에
//     끝난다 (2026-09-16 실측). 거꾸로 Python 트리에 allow-jit은 주지 않는다 — 안 쓰는 권한이다.
//
// **안쪽을 먼저 서명한다.** .app 서명이 Resources를 해시로 봉인하므로, 순서가 뒤집히면 봉인이
// 서명 전 내용을 가리켜 codesign --verify가 깨진다.
//
// Resources/python 아래 Mach-O는 build-python.sh가 이미 같은 plist로 개별 서명했으므로 여기서의
// 재서명은 멱등이다. Resources/ffmpeg는 다르다 — build-ffmpeg.sh에는 서명 단계가 아예 없어서,
// 이 줄이 없으면 ffmpeg/ffprobe는 링커 ad-hoc 서명만 가진 채 hardened runtime .app 안에 들어간다.
//
// Resources/postgres와 Contents/Frameworks도 같은 함수로 맡는다 — entitlements 없이, hardened
// runtime은 켠 채로. runtime은 `lib/signing.mjs`의 `codesign()`과 여기 `signAll`이 **기본으로
// 켠다**(최종 리뷰 I3 — 옛 기본값은 "entitlements가 없으면 끔"이었고 R12가 그 전제를 뒤집었다).
// 아래 두 줄의 `{ runtime: true }`는 이제 기본값과 같지만 두 트리가 왜 runtime을 지는지의 표시로
// 남긴다:
//   - Resources/postgres: runtime **있음**, entitlements 없음 (Ruling R12, Task 6 실측 뒤집음).
//     원래 제약("별개 프로세스라 자기 서명의 플래그로 돈다")은 *실행 시 동작*을 근거로 hardened
//     runtime이 없어도 무해하다고 봤을 뿐 있어야 한다는 근거는 아니었다. 그런데 Apple 공증은 번들
//     안 실행 파일에 hardened runtime을 요구한다 — 실측(2026-09-21, 제출 id
//     88197b1f-daae-41bc-aa68-e62176a321de): `Resources/postgres/bin/` 아래 32개 실행 파일 전부가
//     "The executable does not have the hardened runtime enabled."로 거절됐다(자세한 로그는
//     task-6-report.md). entitlements는 여전히 주지 않는다 — hardened runtime의 library
//     validation은 같은 Team ID로 서명된 라이브러리를 허용하는데 postgres 트리 전체가 이미
//     `signing.identity`로 서명돼 있으므로(check-bundle의 7c가 전수 단언) disable-library-validation
//     없이 성립할 것으로 본다 — 앱을 띄워 postgres 기동과 pgvector·pg_bigm 로드를 실측 확인했다
    // (task-6-report.md, R12 재검증).
//   - Contents/Frameworks: runtime 있음, entitlements 없음. "번들도, 번들의 메인 실행 파일도
//     아닌" 느슨한 Mach-O를 .app --deep이 건너뛴다 — 실측(2026-09-21): Electron Framework의
//     Libraries/libvk_swiftshader.dylib·libffmpeg.dylib, Squirrel.framework의 ShipIt 셋이
//     .app --deep 뒤에도 adhoc(TeamIdentifier=not set)으로 남았다(--deep은 중첩 번들 자체는
//     재서명해도 그 Resources 서브디렉터리에 흩어진 개별 파일까지 전수로 훑지는 않는다).
//     ShipIt은 MH_EXECUTE라 runtime 없이 나가면 Apple 공증이 거절한다(리뷰 실측: `codesign -dv`
//     flags=0x0(none)) — dylib 둘(MH_DYLIB)은 runtime을 같이 받아도 무해하다(hardened runtime
//     플래그는 프로세스의 주 실행 파일에서 읽힌다), 그래서 파일별로 가르지 않는다.
// 어느 쪽도 .app보다 먼저 둔다 — --deep이 다시 다루는 중첩 번들(Helper.app 등)은 뒤에서 올바른
// entitlements로 덮어써 최종 상태가 같다(멱등).
function signAll(targets, entitlements, label, opts = {}) {
  if (targets.length === 0) throw new Error(`서명 대상이 없다: ${label}`);
  const runtime = opts.runtime ?? true; // 기본은 켬 — `codesign()`과 같은 규칙(R12)
  console.log(
    `$ codesign --sign ${signing.identity}${runtime ? " --options runtime" : ""} --timestamp` +
      `${entitlements !== null ? ` --entitlements ${path.relative(desktop, entitlements)}` : ""} — ${label} ${targets.length}개`,
  );
  // argv 길이 한계를 넘지 않게 끊어 부른다. execFileSync는 비0에 throw하므로 한 건이라도
  // 서명에 실패하면 패키징이 여기서 멈춘다.
  for (let i = 0; i < targets.length; i += 200) {
    codesign(signing.identity, entitlements, targets.slice(i, i + 200), { runtime });
  }
}

const ffmpegBin = path.join(resources, "ffmpeg", "bin");
const ffmpegTargets = fs.existsSync(ffmpegBin) ? fs.readdirSync(ffmpegBin).map((f) => path.join(ffmpegBin, f)) : [];
signAll(machOFiles(path.join(resources, "python")), pythonEnts, "Resources/python Mach-O");
signAll(ffmpegTargets, pythonEnts, "Resources/ffmpeg/bin");
signAll(machOFiles(path.join(resources, "postgres")), null, "Resources/postgres Mach-O", { runtime: true });
signAll(machOFiles(path.join(appPath, "Contents", "Frameworks")), null, "Contents/Frameworks Mach-O", { runtime: true });

// .app은 --deep으로. plist는 mac 쪽이다 — python plist를 주면 V8이 allow-jit 없이 rc=133으로 죽는다.
codesign(signing.identity, macEnts, [appPath], { extra: ["--deep"] });

run("node", [path.join("scripts", "check-bundle.mjs")], desktop);

// notarytool은 디렉터리를 받지 않는다. ditto로 zip을 떠서 제출하고, 통과하면 **zip이 아니라
// 원본 .app에** 스테이플한다 — DMG 밖으로 꺼낸 .app이 오프라인에서도 통과하려면 필요하다.
function notarize(target, label) {
  console.log(`$ notarytool submit ${label}`);
  const r = spawnSync("xcrun", [
    "notarytool", "submit", target,
    "--keychain-profile", signing.notaryProfile,
    "--wait", "--timeout", "30m",
    "--output-format", "json",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const out = r.stdout ?? "";
  console.log(out);
  let parsed = {};
  try { parsed = JSON.parse(out); } catch { /* 출력이 JSON이 아니면 아래에서 id를 정규식으로 건진다 */ }
  if (parsed.status !== "Accepted") {
    // 끊김·타임아웃(534MB 업로드가 --wait --timeout 30m을 채우는 경우)이면 out이 빈 문자열이거나
    // JSON이 아닌 채로 남아 parsed.id가 없다. 그래도 제출 자체는 Apple에 접수됐을 수 있어 원시
    // 텍스트에 UUID가 한 번은 찍혀 있을 수 있다 — 정규식으로 마지막 기회를 준다. 이것까지 실패하면
    // notarytool log로 이어 볼 방법이 없다(브리프의 "끊긴 뒤 되찾을 수 있어야 한다"가 요구하는 지점).
    const id = parsed.id ?? /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(out)?.[0];
    // 거절 사유는 목록이라 요약하면 원인을 잃는다. 로그를 통째로 뱉고 멈춘다.
    if (id !== undefined) {
      spawnSync("xcrun", ["notarytool", "log", id, "--keychain-profile", signing.notaryProfile], { stdio: "inherit" });
      console.error(`제출 id ${id} — 나중에 notarytool log로 이어 볼 수 있다`);
    }
    // spawn 자체가 실패했거나(xcrun을 못 찾음 등) 비정상 종료했으면 그 원인도 그대로 던진다 —
    // status=unknown만 던지면 끊김·타임아웃과 "그냥 이상한 응답"을 구별할 수 없다.
    const cause = r.error !== undefined ? `spawn error: ${r.error.message}` : `exit ${r.status}`;
    throw new Error(`공증 실패 (${label}): status=${parsed.status ?? "unknown"} (${cause})`);
  }
}

if (RELEASE) {
  const appZip = path.join(desktop, "out", "Damwha.zip");
  run("ditto", ["-c", "-k", "--keepParent", appPath, appZip], desktop);
  // notarize()가 거절로 throw해도 534MB짜리 zip을 out에 남기지 않는다 — Task 7~9가 다루는
  // 디스크 부족 문제 바로 옆에 알려진 누수를 두지 않는다 (Ruling R14).
  try {
    notarize(appZip, ".app");
  } finally {
    fs.rmSync(appZip, { force: true });
  }
  run("xcrun", ["stapler", "staple", appPath], desktop);

  // 스테이플이 .app 안에 티켓 파일을 넣는다. 번들 위생과 서명이 그 뒤에도 성립하는지 다시 묻는다
  // (스펙 §7 공통 규칙). 여기서 지면 DMG를 만들지 않는다 — 깨진 앱을 담은 DMG가 더 나쁘다.
  run("node", [path.join("scripts", "check-bundle.mjs")], desktop);
}

if (RELEASE) {
  // --prepackaged: 이미 서명·스테이플된 그 바이트를 그대로 담는다. 재빌드하지 않는다.
  // 이것이 없으면 electron-builder가 서명 전 앱을 다시 만들어 담는다.
  run("pnpm", ["exec", "electron-builder", "--prepackaged", appPath, "--mac", "dmg"], desktop);
}

if (RELEASE) {
  const dmgs = fs.readdirSync(path.join(desktop, "out")).filter((f) => f.endsWith(".dmg"));
  if (dmgs.length !== 1) throw new Error(`out에 DMG가 정확히 하나여야 한다: ${dmgs.join(", ") || "(없음)"}`);
  dmgPath = path.join(desktop, "out", dmgs[0]);   // Step 1에서 선언한 것에 담는다 — Step 6·8이 쓴다

  // DMG 자신도 서명한다. entitlements는 주지 않는다 — 디스크 이미지는 실행 파일이 아니다.
  run("codesign", ["--force", "--sign", signing.identity, "--timestamp", dmgPath], desktop);
  notarize(dmgPath, "DMG");
  run("xcrun", ["stapler", "staple", dmgPath], desktop);

  // 받은 것이 우리가 낸 것인지 사용자가 확인할 수 있어야 한다.
  const sha = execFileSync("shasum", ["-a", "256", dmgs[0]], { cwd: path.join(desktop, "out"), encoding: "utf8" });
  fs.writeFileSync(`${dmgPath}.sha256`, sha);
  console.log(sha.trim());
}

if (RELEASE) {
  // 3·4번이 의도대로 이어졌는지는 마운트해서 보는 것만이 증명한다 (P6a-C13).
  // out/mac-arm64의 .app이 통과하는 것과 DMG 안의 .app이 통과하는 것은 다른 질문이다.
  const mnt = execFileSync("hdiutil", ["attach", dmgPath, "-nobrowse", "-readonly"], { encoding: "utf8" })
    .split("\n").map((l) => l.split("\t").pop()?.trim()).filter((p) => p?.startsWith("/Volumes/")).pop();
  if (mnt === undefined) throw new Error("DMG 마운트 지점을 찾지 못했다");
  try {
    const inner = path.join(mnt, "Damwha.app");
    run("spctl", ["--assess", "--type", "execute", "-vv", inner], desktop);
    run("xcrun", ["stapler", "validate", inner], desktop);
  } finally {
    spawnSync("hdiutil", ["detach", mnt, "-quiet"]);
  }
}
