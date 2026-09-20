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
 * `xcrun vtool -show-build`의 출력을 파싱해 macOS minos 값을 모두 뽑는다. 로드 커맨드
 * 블록을 추적하는 상태 기계다 — 블록을 무시하고 키워드만 보면 안 된다.
 *
 * **함정:** `LC_BUILD_VERSION` 블록 안에는 `minos`(우리가 원하는 값) 말고도 `tool`
 * 서브레코드의 `version`(링커 버전, 예: `27037.1`)이 같이 찍힌다. 옛 `/^\s*(?:minos|version)/`
 * 정규식은 이 둘을 구별하지 않아 fat-슬라이스 최대값 규칙이 `27037.1`을 minos로 골랐다 —
 * 실측(2026-09-20, `/bin/echo`): `27.0`이어야 할 값이 `27037.1`로 나왔다.
 * 진짜 `version` 필드는 **다른 로드 커맨드**(`LC_VERSION_MIN_MACOSX`, 옛 바이너리 전용)에
 * 있고, 같은 키워드 `version`을 쓰지만 뜻이 다르다 — 그래서 키워드 하나만으로는 못 가르고
 * 지금 어느 블록 안에 있는지를 따라가야 한다.
 *
 * `LC_VERSION_MIN_IPHONEOS`·`TVOS`·`WATCHOS` 같은 다른 플랫폼 블록은 이 함수가 찾는 두
 * 블록 이름 어느 것에도 걸리지 않으므로 조용히 건너뛴다 — macOS 바닥만 본다.
 */
export function parseMinos(vtoolOutput) {
  const found = [];
  let block = null;
  for (const line of vtoolOutput.split("\n")) {
    const cmd = /^\s*cmd\s+(\S+)\s*$/.exec(line);
    if (cmd !== null) {
      block = cmd[1];
      continue;
    }
    if (block === "LC_BUILD_VERSION") {
      const m = /^\s*minos\s+(\d+(?:\.\d+)*)\s*$/.exec(line);
      if (m !== null) found.push(m[1]);
    } else if (block === "LC_VERSION_MIN_MACOSX") {
      const m = /^\s*version\s+(\d+(?:\.\d+)*)\s*$/.exec(line);
      if (m !== null) found.push(m[1]);
    }
  }
  if (found.length === 0) return null;
  return found.reduce((hi, v) => (compareVersion(v, hi) > 0 ? v : hi));
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
  return parseMinos(r.stdout ?? "");
}
