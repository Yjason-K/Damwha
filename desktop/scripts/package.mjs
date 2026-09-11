// desktop/scripts/package.mjs
// 순서: be build → fe build → pnpm deploy → SPA 복사 → electron-builder.
// pnpm deploy 뒤에 SPA를 넣는 이유: nest build가 dist를 비울 수 있다 (스펙 R1-3).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(desktop, "..");
const apiTree = path.join(desktop, "build", "api");

function run(cmd, args, cwd = repo, extraEnv = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnv } });
}

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
run("node", [path.join("scripts", "check-bundle.mjs")], desktop);
