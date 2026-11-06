// publish.sh를 실제 발행 없이 끝까지 돌린다 (이슈 #86).
// 임시 git 저장소 + 로컬 bare origin에 v<version> 태그를 두고, PATH 앞의 가짜 gh가 인자를 기록하고
// 가짜 hdiutil이 -mountpoint에 가짜 Damwha.app을 채운다. GH_TOKEN·GH_CONFIG_DIR도 가짜로 덮어 실제
// gh가 불려도 인증에서 멈추게 한다.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPTS = path.resolve(__dirname, "../../scripts");
const VERSION = "9.9.9";
const DMG = `Damwha-${VERSION}-arm64.dmg`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function write(file: string, body: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

type BuildInfo = { version: string; commit: string };
type Provenance = Record<string, string> | null; // null = 파일 없음, 객체 = 정상값 위에 덮어쓸 필드

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "publish-")));
  dirs.push(root);
  const work = path.join(root, "work");
  const origin = path.join(root, "origin.git");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: work, encoding: "utf8" }).trim();

  fs.mkdirSync(work);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  git("init", "-q");
  fs.cpSync(path.join(SCRIPTS, "publish.sh"), path.join(work, "desktop", "scripts", "publish.sh"));
  fs.cpSync(path.join(SCRIPTS, "lib"), path.join(work, "desktop", "scripts", "lib"), { recursive: true });
  write(path.join(work, "desktop", "package.json"), JSON.stringify({ version: VERSION }));
  write(path.join(work, ".gitignore"), "desktop/out/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "release");
  git("tag", `v${VERSION}`);
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "HEAD:refs/heads/main", `refs/tags/v${VERSION}`);
  const head = git("rev-parse", "HEAD");

  const bin = path.join(root, "bin");
  const ghLog = path.join(root, "gh.log");
  write(
    path.join(bin, "gh"),
    `#!/bin/bash\necho "$*" >> "${ghLog}"\nif [ "$1 $2" = "release view" ]; then echo v${VERSION}; fi\n`,
    0o755,
  );
  // 가짜 hdiutil: attach는 -mountpoint 디렉터리에 FAKE_DMG_ROOT를 복사하고, detach는 그것을 지운다.
  write(
    path.join(bin, "hdiutil"),
    [
      "#!/bin/bash",
      'cmd="$1"; shift',
      'if [ "$cmd" = attach ]; then',
      '  while [ $# -gt 0 ]; do if [ "$1" = -mountpoint ]; then mp="$2"; fi; shift; done',
      '  mkdir -p "$mp" && cp -R "$FAKE_DMG_ROOT"/. "$mp"/',
      '  printf "/dev/disk9s1\\tApple_HFS\\t%s\\n" "$mp"',
      'elif [ "$cmd" = detach ]; then rm -rf "$1"; fi',
      "",
    ].join("\n"),
    0o755,
  );
  const notes = path.join(root, "notes.md");
  write(notes, "macOS 15.0 이상\n");

  return { root, work, head, ghLog, bin, notes };
}

function run(
  env: ReturnType<typeof setup>,
  opts: { buildInfo: BuildInfo; provenance?: Provenance },
) {
  const out = path.join(env.work, "desktop", "out");
  const bytes = "dmg-bytes";
  write(path.join(out, DMG), bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  write(path.join(out, `${DMG}.sha256`), `${sha}  ${DMG}\n`);
  const provenance =
    opts.provenance === null
      ? null
      : { version: VERSION, tag: `v${VERSION}`, commit: env.head, dmg: DMG, sha256: sha, ...opts.provenance };
  if (provenance !== null) write(path.join(out, `${DMG}.provenance.json`), `${JSON.stringify(provenance)}\n`);

  const dmgRoot = path.join(env.root, "dmg-root");
  fs.rmSync(dmgRoot, { recursive: true, force: true });
  write(path.join(dmgRoot, "Damwha.app", "Contents", "Resources", "build-info.json"), JSON.stringify(opts.buildInfo));

  const r = spawnSync("bash", [path.join(env.work, "desktop", "scripts", "publish.sh"), "--notes-file", env.notes], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${env.bin}:${process.env.PATH}`,
      FAKE_DMG_ROOT: dmgRoot,
      GH_TOKEN: "bogus",
      GH_CONFIG_DIR: path.join(env.root, "gh-config"),
      DAMWHA_SITE_DEPLOY_HOOK: "",
    },
  });
  const gh = fs.existsSync(env.ghLog) ? fs.readFileSync(env.ghLog, "utf8") : "";
  return { status: r.status, stderr: r.stderr, created: gh.includes("release create"), gh };
}

describe("publish.sh — DMG 소스 출처 (#86)", () => {
  it("태그 커밋에서 깨끗하게 빌드된 DMG는 provenance와 함께 발행한다", () => {
    const env = setup();
    const r = run(env, { buildInfo: { version: VERSION, commit: env.head.slice(0, 12) } });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.created).toBe(true);
    expect(r.gh).toContain(`${DMG}.provenance.json`);
  });

  it("다른 커밋에서 빌드된 DMG는 체크섬이 맞아도 발행하지 않는다", () => {
    const env = setup();
    const stale = "0123456789ab";
    // 예전 커밋에서 만든 DMG·체크섬·provenance가 서로는 맞는 채로 out/에 남은 경우
    const r = run(env, {
      buildInfo: { version: VERSION, commit: stale },
      provenance: { commit: `${stale}${"0".repeat(28)}` },
    });
    expect(r.created).toBe(false);
    expect(r.status).not.toBe(0);
  });

  it("DMG 안 build-info만 다른 커밋이면 provenance가 맞아도 거절한다", () => {
    const env = setup();
    const r = run(env, { buildInfo: { version: VERSION, commit: "0123456789ab" } });
    expect(r.created).toBe(false);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/0123456789ab/);
  });

  it("dirty 빌드는 같은 커밋이어도 발행하지 않는다", () => {
    const env = setup();
    const r = run(env, {
      buildInfo: { version: VERSION, commit: `${env.head.slice(0, 12)}-dirty` },
    });
    expect(r.created).toBe(false);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/dirty/);
  });

  it("provenance 파일이 없으면 발행하지 않는다", () => {
    const env = setup();
    const r = run(env, { buildInfo: { version: VERSION, commit: env.head.slice(0, 12) }, provenance: null });
    expect(r.created).toBe(false);
    expect(r.status).not.toBe(0);
  });

  it("provenance의 커밋이 태그와 다르면 발행하지 않는다", () => {
    const env = setup();
    const r = run(env, {
      buildInfo: { version: VERSION, commit: env.head.slice(0, 12) },
      provenance: { commit: "f".repeat(40) },
    });
    expect(r.created).toBe(false);
    expect(r.status).not.toBe(0);
  });

  it("provenance의 해시가 DMG와 다르면 발행하지 않는다", () => {
    const env = setup();
    const r = run(env, {
      buildInfo: { version: VERSION, commit: env.head.slice(0, 12) },
      provenance: { sha256: "0".repeat(64) },
    });
    expect(r.created).toBe(false);
    expect(r.status).not.toBe(0);
  });
});
