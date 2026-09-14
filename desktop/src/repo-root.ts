import * as fs from "fs";
import * as path from "path";

/**
 * packaged .app 안에는 be/worker가 없다 — Phase 4가 번들할 것이라 그때까지 저장소 체크아웃을 가리켜야 한다. 빌드 시점에
 * 굽지 않는 이유는 Phase 1의 번들 위생 기준이 "번들 안에 저장소 절대 경로 0건"을 요구하기 때문이다 (Phase 2 스펙 §6.4).
 * Phase 3부터 앱이 Docker를 부르지 않으므로 be/docker-compose.yml은 표식이 아니다.
 */
const MARKERS = ["be/worker/pyproject.toml"] as const;

export function isRepoRoot(
  dir: string,
  exists: (p: string) => boolean = fs.existsSync,
): boolean {
  if (dir.length === 0) return false;
  return MARKERS.every((m) => exists(path.join(dir, ...m.split("/"))));
}
