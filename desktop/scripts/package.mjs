// desktop/scripts/package.mjs
// 순서: be build → fe build → pnpm deploy → SPA 복사 → electron-builder.
// pnpm deploy 뒤에 SPA를 넣는 이유: nest build가 dist를 비울 수 있다 (스펙 R1-3).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { machOFiles } from "./lib/macho.mjs";

const desktop = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(desktop, "..");
const apiTree = path.join(desktop, "build", "api");

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
// 이 맥의 다른 무서명 Electron 앱과 마이크 권한을 공유한다. Developer ID 서명과
// 공증은 Phase 6이고, 여기서 필요한 것은 번들이 자기 정체성을 갖는 것뿐이다.
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
function signAll(targets, entitlements, label) {
  if (targets.length === 0) throw new Error(`서명 대상이 없다: ${label}`);
  console.log(
    `$ codesign --force --sign - --options runtime --entitlements ${path.relative(desktop, entitlements)}` +
      ` — ${label} ${targets.length}개`,
  );
  // argv 길이 한계를 넘지 않게 끊어 부른다. execFileSync는 비0에 throw하므로 한 건이라도
  // 서명에 실패하면 패키징이 여기서 멈춘다 — 서명이 실패해도 .app은 linker-signed 상태로
  // 실행되기 때문에, 실행 성공을 서명 성공으로 읽지 않으려면 종료 코드를 봐야 한다.
  for (let i = 0; i < targets.length; i += 200) {
    execFileSync(
      "codesign",
      ["--force", "--sign", "-", "--options", "runtime", "--entitlements", entitlements, ...targets.slice(i, i + 200)],
      { cwd: desktop, stdio: "inherit" },
    );
  }
}

const ffmpegBin = path.join(resources, "ffmpeg", "bin");
const ffmpegTargets = fs.existsSync(ffmpegBin) ? fs.readdirSync(ffmpegBin).map((f) => path.join(ffmpegBin, f)) : [];
signAll(machOFiles(path.join(resources, "python")), pythonEnts, "Resources/python Mach-O");
signAll(ffmpegTargets, pythonEnts, "Resources/ffmpeg/bin");

run("codesign", ["--force", "--deep", "--sign", "-", "--options", "runtime", "--entitlements", macEnts, appPath], desktop);

run("node", [path.join("scripts", "check-bundle.mjs")], desktop);
