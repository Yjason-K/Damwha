// desktop/scripts/lib/release-provenance.mjs
// 발행할 DMG가 릴리스 태그의 커밋에서 깨끗하게 빌드됐는지 대조한다 (이슈 #86).
//
// 고리가 셋이다. 태그 → 커밋은 publish.sh가 git으로 본다. 커밋 → DMG는 DMG를 마운트해 안의
// Resources/build-info.json(package.mjs가 쓴다)을 읽어 본다. DMG 해시 → 커밋은 package.mjs --release가
// DMG 옆에 남기는 `<dmg>.provenance.json`(40자 커밋 + sha256)이 잇고, publish.sh가 그것을 릴리스
// 자산으로 함께 올린다.
//
// 개발용 빌드(package:desktop)와 check-bundle은 -dirty를 그대로 허용한다 — 거절은 릴리스 경로에서만.
//
//   node desktop/scripts/lib/release-provenance.mjs verify <dmg> <version> <40자 커밋>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { releaseTagFor } from "./release-tag.mjs";

/** 릴리스로 낼 빌드 식별자인가. build-info의 commit은 12자 약칭이라 전체 커밋의 접두사로 대조한다. */
export function assertReleaseBuildInfo(info, { version, commit }) {
  const got = String(info?.commit ?? "");
  if (info?.version !== version) {
    throw new Error(`빌드 버전이 ${info?.version ?? "(없음)"}인데 릴리스는 ${version}이다`);
  }
  if (got.endsWith("-dirty")) {
    throw new Error(`더러운 작업 트리에서 빌드됐다(${got}) — 릴리스는 dirty 빌드를 내지 않는다`);
  }
  if (!/^[0-9a-f]{12}$/.test(got) || !commit.startsWith(got)) {
    throw new Error(`빌드 커밋 ${got || "(없음)"}이 릴리스 커밋 ${commit}이 아니다`);
  }
}

export function provenanceFor({ version, commit, dmg, sha256 }) {
  return { version, tag: releaseTagFor(version), commit, dmg, sha256 };
}

export function sha256File(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** DMG를 읽기 전용으로 마운트해 Damwha.app의 build-info.json을 읽는다. 마운트 지점은 우리가 정한다. */
export function readDmgBuildInfo(dmgPath) {
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-dmg-"));
  execFileSync("hdiutil", ["attach", dmgPath, "-nobrowse", "-readonly", "-mountpoint", mnt], { stdio: "ignore" });
  try {
    return JSON.parse(fs.readFileSync(path.join(mnt, "Damwha.app", "Contents", "Resources", "build-info.json"), "utf8"));
  } finally {
    execFileSync("hdiutil", ["detach", mnt, "-quiet"], { stdio: "ignore" });
    // 빈 디렉터리만 지운다 — 마운트가 남았을 수 있는 자리를 재귀로 지우지 않는다.
    try {
      fs.rmdirSync(mnt);
    } catch {
      /* 이미 없거나 비지 않았다 */
    }
  }
}

/** 발행 직전 검사. 하나라도 어긋나면 던진다. */
export function verifyRelease({ dmgPath, version, commit, readBuildInfo = readDmgBuildInfo }) {
  const provPath = `${dmgPath}.provenance.json`;
  if (!fs.existsSync(provPath)) throw new Error(`provenance 파일이 없다: ${provPath} — pnpm run package:release가 먼저다`);
  const prov = JSON.parse(fs.readFileSync(provPath, "utf8"));
  const expected = provenanceFor({ version, commit, dmg: path.basename(dmgPath), sha256: sha256File(dmgPath) });
  for (const [key, want] of Object.entries(expected)) {
    if (prov[key] !== want) throw new Error(`provenance의 ${key}가 ${JSON.stringify(prov[key])}인데 ${want}여야 한다`);
  }
  assertReleaseBuildInfo(readBuildInfo(dmgPath), { version, commit });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [cmd, dmgPath, version, commit] = process.argv.slice(2);
  if (cmd !== "verify" || !dmgPath || !version || !/^[0-9a-f]{40}$/.test(commit ?? "")) {
    console.error("사용: release-provenance.mjs verify <dmg> <version> <40자 커밋>");
    process.exit(2);
  }
  try {
    verifyRelease({ dmgPath, version, commit });
    console.log(`provenance OK — ${path.basename(dmgPath)} = ${commit}`);
  } catch (e) {
    console.error(`provenance: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
