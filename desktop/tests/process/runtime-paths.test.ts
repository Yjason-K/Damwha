import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  ffmpegBinaries,
  knownBundleDirs,
  PY_MINOR,
  pythonBinaries,
} from "../../src/process/runtime-paths";
import type { LaunchContext } from "../../src/services/types";

const REPO = "/Users/me/daewha";
const DEV_TREE = `${REPO}/desktop/build/python`;
const PACKAGED_TREE_IN_REPO = `${REPO}/desktop/out/mac-arm64/Damwha.app/Contents/Resources/python`;

function ctx(over: { repoRoot: string | null; packaged: boolean; python: string }): LaunchContext {
  return {
    repoRoot: over.repoRoot,
    userData: "/u",
    packaged: over.packaged,
    databaseMode: "embedded",
    env: {},
    bins: { python: over.python, ffmpeg: "/b/ffmpeg/bin/ffmpeg", ffprobe: "/b/ffmpeg/bin/ffprobe" },
    runId: "desktop-test",
    searchDirs: [],
    logFile: (id) => `/u/logs/${id}.log`,
    signal: new AbortController().signal,
  };
}

describe("pythonBinaries", () => {
  it("names the real interpreter, not the python/python3 symlinks", () => {
    // 번들 bin/의 python·python3은 python3.12를 가리키는 링크다. 그 둘로 띄우면 argv[0]이 링크
    // 이름으로 남아 스펙 §6.5 조건 1(basename python3.12)에서 빠진다.
    expect(pythonBinaries("/b/python")).toEqual({ python: "/b/python/bin/python3.12" });
    expect(path.basename(pythonBinaries("/b/python").python)).toBe(`python${PY_MINOR}`);
  });

  it("keeps PY_MINOR paired with the version build-python.sh stages", () => {
    // 어긋나면 런타임에 "파일 없음"으로만 드러난다. 스크립트가 `bin/python$PY_VERSION`을 만든다
    // (build-python.sh의 PY_VERSION·PY_FULL 두 줄).
    const script = fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "build-python.sh"), "utf8");
    const minor = /^PY_VERSION=(\S+)$/m.exec(script);
    const full = /^PY_FULL=(\S+)$/m.exec(script);
    expect(minor, "build-python.sh에 PY_VERSION= 줄이 있다").not.toBeNull();
    expect(full, "build-python.sh에 PY_FULL= 줄이 있다").not.toBeNull();
    expect(minor![1]).toBe(PY_MINOR);
    expect(full![1].startsWith(`${PY_MINOR}.`)).toBe(true);
  });
});

describe("ffmpegBinaries", () => {
  it("names both tools under bin/", () => {
    expect(ffmpegBinaries("/b/ffmpeg")).toEqual({
      ffmpeg: "/b/ffmpeg/bin/ffmpeg",
      ffprobe: "/b/ffmpeg/bin/ffprobe",
    });
  });
});

describe("knownBundleDirs", () => {
  it("in dev returns the packaged tree electron-builder writes inside the repo, then its own tree", () => {
    const c = ctx({ repoRoot: REPO, packaged: false, python: pythonBinaries(DEV_TREE).python });
    expect(knownBundleDirs(c)).toEqual([PACKAGED_TREE_IN_REPO, DEV_TREE]);
  });

  it("in a packaged app built in the repo's out/, returns its own tree, then the repo's dev tree", () => {
    const c = ctx({ repoRoot: null, packaged: true, python: pythonBinaries(PACKAGED_TREE_IN_REPO).python });
    expect(knownBundleDirs(c)).toEqual([PACKAGED_TREE_IN_REPO, DEV_TREE]);
  });

  it("in a packaged app installed elsewhere, cannot know the dev tree and returns only its own", () => {
    const installed = "/Applications/Damwha.app/Contents/Resources/python";
    const c = ctx({ repoRoot: null, packaged: true, python: pythonBinaries(installed).python });
    expect(knownBundleDirs(c)).toEqual([installed]);
  });

  it("does not take a look-alike path for the repo's out/ tree", () => {
    // 접미사가 경로 조각 단위로 맞아야 한다. 문자열 끝만 보면 `xdesktop/out/…`도 저장소로 읽는다.
    const lookalike = "/tmp/xdesktop/out/mac-arm64/Damwha.app/Contents/Resources/python";
    const c = ctx({ repoRoot: null, packaged: true, python: pythonBinaries(lookalike).python });
    expect(knownBundleDirs(c)).toEqual([lookalike]);
  });

  it("never lists the same tree twice", () => {
    // 비정상 조합이라도(dev인데 자기 트리가 저장소의 out/ 트리) 한 트리를 두 번 싣지 않는다.
    const c = ctx({ repoRoot: REPO, packaged: false, python: pythonBinaries(PACKAGED_TREE_IN_REPO).python });
    expect(knownBundleDirs(c)).toEqual([PACKAGED_TREE_IN_REPO]);
  });
});
