// desktop/scripts/lib/release-tag.mjs
// 데스크톱 릴리스 태그 규칙 (Phase 6b-1 스펙 §3-2·§10a).
//
// **태그는 v<version>이다.** 6a는 셀프호스팅 웹 배포의 v<version>과 겹치지 않게 desktop-v<version>을
// 썼다. 웹 배포를 걷어낸 뒤(PR #28) 그 구분의 이유가 사라져 관례대로 되돌렸다. 이미 나간
// desktop-v0.3.0·desktop-v0.3.1은 이름을 바꾸지 않는다 — 앱의 새 버전 조회는 두 형식을 다 읽는다.
import { execFileSync } from "node:child_process";

export function releaseTagFor(version) {
  return `v${version}`;
}

/** HEAD를 정확히 가리키는 v* 태그. 없으면 null — `--match 'v*'`는 glob이라 desktop-v*와 맞지 않는다. */
export function describeReleaseTag(repoDir) {
  try {
    return execFileSync("git", ["describe", "--tags", "--exact-match", "--match", "v*"], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function assertReleaseTag(tag, version) {
  const expected = releaseTagFor(version);
  if (tag !== expected) {
    throw new Error(`태그가 ${tag ?? "(없음)"}인데 package.json은 ${version}이다 — ${expected}여야 한다`);
  }
}
