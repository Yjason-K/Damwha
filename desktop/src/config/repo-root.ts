import * as fs from "fs";
import * as path from "path";

/**
 * 저장소 체크아웃은 **dev만** 쓴다. Phase 4부터 packaged는 번들 python(`Resources/python`)과 번들 API로
 * 돌아 저장소를 모른다 — 예전에 packaged가 저장소를 요구하던 이유(be/worker를 uv로 돌렸다)가 사라졌다.
 * dev는 API(`nest start`)·마이그레이션 러너(pnpm)·worker의 `PYTHONPATH=<repo>/be/worker`(스펙 §6.7)가
 * 저장소를 가리킨다.
 *
 * 빌드 시점에 굽지 않는 이유는 그대로다 — 번들 위생 기준이 "번들 안에 저장소 절대 경로 0건"을 요구한다
 * (Phase 2 스펙 §6.4). Phase 3부터 앱이 Docker를 부르지 않으므로 be/docker-compose.yml은 표식이 아니다.
 */
const MARKERS = ["be/worker/pyproject.toml"] as const;

export function isRepoRoot(
  dir: string,
  exists: (p: string) => boolean = fs.existsSync,
): boolean {
  if (dir.length === 0) return false;
  return MARKERS.every((m) => exists(path.join(dir, ...m.split("/"))));
}

export interface RepoRootQuery {
  packaged: boolean;
  /** config.json의 REPO_ROOT. */
  configured: string | undefined;
  /** app.getAppPath() — dev에서는 저장소의 desktop/이다. */
  appPath: string;
}

/**
 * 이번 실행의 저장소. **packaged는 항상 null이다** — REPO_ROOT를 읽지도, 디스크를 보지도 않는다.
 * dev는 REPO_ROOT가 저장소면 그것, 아니면 `appPath/..`가 저장소면 그것, 둘 다 아니면 null이고
 * 부르는 쪽이 `CAUSES.repoRootMissing`으로 멈춘다.
 *
 * 사람에게 묻지 않는다. 예전에는 못 찾으면 폴더 선택창을 띄우고 고른 값을 config.json에 적었다 —
 * packaged 첫 실행이 그 창에서 상한 없이 멈췄고, 앱이 config.json에 쓰는 유일한 예외였다. dev는
 * `appPath/..`로 항상 찾을 수 있으므로 그 창이 할 일이 없다 (스펙 §6.3).
 */
export function resolveRepoRoot(
  q: RepoRootQuery,
  exists: (p: string) => boolean = fs.existsSync,
): string | null {
  if (q.packaged) return null;
  if (q.configured !== undefined && isRepoRoot(q.configured, exists)) return q.configured;
  const guess = path.resolve(q.appPath, "..");
  return isRepoRoot(guess, exists) ? guess : null;
}
