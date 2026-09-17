import * as path from "path";
import type { LaunchContext } from "../services/types";

/**
 * 번들 Python·ffmpeg 트리 안의 경로 (Phase 4 스펙 §6.1). electron을 import하지 않는 순수 모듈이다 —
 * `services/postgres/layout.ts`의 `pgBinaries`와 같은 자리, 같은 이유(electron을 값으로 import하는
 * 파일은 vitest가 못 부른다).
 *
 * 트리는 dev의 `desktop/build/<이름>`과 packaged의 `Contents/Resources/<이름>` 두 자리에 놓인다.
 * 어느 쪽인지는 부르는 쪽(main.ts)이 정하고, 여기서는 그 bundleDir 아래만 계산한다.
 */

/**
 * `build-python.sh`의 `PY_VERSION`과 짝이다. 어긋나면 런타임에 "파일 없음"으로만 드러나므로
 * 테스트가 스크립트를 읽어 둘을 맞춰 본다 (tests/process/runtime-paths.test.ts).
 */
export const PY_MINOR = "3.12";

/**
 * `python`은 `<bundleDir>/bin/python3.12` — **심볼릭 링크가 아니라 실체다.** 번들 `bin/`에는
 * `python ⇒ python3.12`·`python3 ⇒ python3.12` 링크가 함께 있고, 그 둘로 띄우면 argv[0]이 링크
 * 이름으로 남아 스펙 §6.5 조건 1(basename `python3.12`)에서 빠진다.
 *
 * site-packages 경로는 싣지 않는다. 계획의 초안 계약에는 `sitePackages`가 있었지만 그것을 읽는
 * 코드가 없다 — 유일한 소비자였던 P4-C12 수동 판정은 런타임 자기 보고(`sys.prefix`)에서 그
 * 경로를 얻는다. 안 쓰는 필드는 다음 사람이 그 의미를 추측하게 만든다 (계획 "구현 중 판정" #8).
 */
export interface PythonBinaries {
  python: string;
}

export interface FfmpegBinaries {
  ffmpeg: string;
  ffprobe: string;
}

export function pythonBinaries(bundleDir: string): PythonBinaries {
  return { python: path.join(bundleDir, "bin", `python${PY_MINOR}`) };
}

export function ffmpegBinaries(bundleDir: string): FfmpegBinaries {
  return {
    ffmpeg: path.join(bundleDir, "bin", "ffmpeg"),
    ffprobe: path.join(bundleDir, "bin", "ffprobe"),
  };
}

/** 저장소 안에서 두 빌드가 python 트리를 두는 자리. electron-builder.yml의 `directories.output: out`, mac `target: dir`(arm64). */
const PACKAGED_PYTHON_IN_REPO = ["desktop", "out", "mac-arm64", "Damwha.app", "Contents", "Resources", "python"] as const;
const DEV_PYTHON_IN_REPO = ["desktop", "build", "python"] as const;

/** `dir`이 `<X>/<parts…>` 모양이면 X, 아니면 null. 경로 조각 단위로 맞춘다 — 문자열 끝만 보면 `xdesktop/…`도 맞는다. */
function stripSuffix(dir: string, parts: readonly string[]): string | null {
  const segments = path.normalize(dir).split(path.sep);
  if (segments.length <= parts.length) return null;
  const tail = segments.slice(-parts.length);
  if (tail.some((s, i) => s !== parts[i])) return null;
  return segments.slice(0, -parts.length).join(path.sep) || path.sep;
}

/**
 * 이 앱이 **자기 것으로 알아볼 수 있는** 번들 python 트리들. 순서는 `[packaged, dev]`이고 모르는 쪽은
 * 빠진다. 두 벌인 이유: 하나의 userData를 dev와 packaged 빌드가 함께 쓰므로, dev로 띄운 고아를
 * packaged가, 또 그 반대도 만난다 — `ctx.bins`는 이번 실행의 한 벌뿐이라 거기서 둘을 만들 수 없다
 * (Task 7이 각각에 `pythonBinaries()`를 적용한다).
 *
 * 디스크를 보지 않는다. 자기 트리는 `ctx.bins.python`(`<트리>/bin/python3.12`)에서, 다른 트리는
 * 저장소 안의 고정 배치에서 파생한다:
 *  - dev(`repoRoot`가 있다): packaged 트리는 `<repo>/desktop/out/mac-arm64/Damwha.app/Contents/Resources/python`.
 *  - packaged: 자기 트리가 바로 그 모양일 때만 `<X>/desktop/build/python`을 dev 트리로 안다.
 *
 * **한계:** `out/` 밖으로 옮겨 설치한 packaged 사본(예: `/Applications/Damwha.app`)은 저장소가
 * 어디인지 알 길이 없어 dev 트리를 모른다. 그 사본은 dev가 남긴 고아를 알아보지 못한다.
 */
export function knownBundleDirs(ctx: Pick<LaunchContext, "bins" | "repoRoot">): string[] {
  const own = path.dirname(path.dirname(ctx.bins.python));
  let packaged: string | null;
  let dev: string | null;
  if (ctx.repoRoot !== null) {
    packaged = path.join(ctx.repoRoot, ...PACKAGED_PYTHON_IN_REPO);
    dev = own;
  } else {
    packaged = own;
    const repo = stripSuffix(own, PACKAGED_PYTHON_IN_REPO);
    dev = repo === null ? null : path.join(repo, ...DEV_PYTHON_IN_REPO);
  }
  const out: string[] = [];
  for (const dir of [packaged, dev]) {
    if (dir !== null && !out.includes(dir)) out.push(dir);
  }
  return out;
}
