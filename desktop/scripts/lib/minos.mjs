// desktop/scripts/lib/minos.mjs
// Mach-O의 최소 macOS 선언(LC_BUILD_VERSION의 minos, 옛 바이너리는 LC_VERSION_MIN_MACOSX)을 읽는다.
//
// **왜 있나** (Phase 6a 스펙 §5.4): 번들 전체의 minos 최대값이 배포 가능한 최소 macOS를 정한다.
// 이 단언이 없으면 다음에 누가 의존성을 올리거나 새 SDK에서 빌드할 때 바닥이 **조용히** 올라간다 —
// 2026-09-20에 실제로 그랬다(postgres·ffmpeg가 27.0, mlx가 26.0이었고 이 맥이 27.0이라 안 보였다).
import { spawnSync } from "node:child_process";

/** 번들이 허용하는 최대 minos. lib/build-target.sh·electron-builder.yml과 **같은 값**이어야 한다. */
export const MAX_MINOS = "15.0";

/** "15.10" > "15.9"가 되게 숫자로 비교한다. 문자열 비교는 그 자리에서 틀린다. */
export function compareVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 파일의 minos. Mach-O가 아니거나 빌드 버전 로드 커맨드가 없으면 null.
 *
 * fat 바이너리는 슬라이스마다 한 블록씩 나오므로 **가장 높은 값**을 쓴다 — 낮은 쪽만 보면
 * 실제로 못 뜨는 슬라이스를 통과시킨다.
 */
export function readMinos(file) {
  const r = spawnSync("xcrun", ["vtool", "-show-build", file], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const out = r.stdout ?? "";
  const found = [];
  for (const m of out.matchAll(/^\s*(?:minos|version)\s+(\d+(?:\.\d+)*)\s*$/gm)) found.push(m[1]);
  if (found.length === 0) return null;
  return found.reduce((hi, v) => (compareVersion(v, hi) > 0 ? v : hi));
}
