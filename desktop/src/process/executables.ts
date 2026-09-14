import * as fs from "fs";
import * as path from "path";

/**
 * Finder로 띄운 앱의 PATH는 /usr/bin:/bin:/usr/sbin:/sbin뿐이다(2026-09-12 실측). uv도
 * 거기 없다. 이 목록이 두 가지를 한다 — uv의 절대 경로를 찾고, 같은 목록을 자식 PATH에 붙인다.
 * 두 번째가 없으면 worker 안의 shutil.which("mlx_lm.server")와 pipeline/ffmpeg.py의 리터럴
 * 호출이 실패한다 (스펙 §6.3).
 */
const BASE_DIRS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "{HOME}/.local/bin",
  "{HOME}/.cargo/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
] as const;

export function searchDirs(home: string, extra: readonly string[] = []): string[] {
  const all = [...extra, ...BASE_DIRS.map((d) => d.replace("{HOME}", home))];
  const seen = new Set<string>();
  // 먼저 나온 자리를 남긴다 — EXTRA_PATH가 기본 목록을 이기게 하려면 이 방향이어야 한다.
  return all.filter((d) => (seen.has(d) ? false : (seen.add(d), true)));
}

function defaultIsExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function findExecutable(
  name: string,
  dirs: readonly string[],
  isExecutable: (p: string) => boolean = defaultIsExecutable,
): string | null {
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    // 주입된 probe가 던질 수 있다. 한 디렉터리의 실패가 탐색 전체를 끝내면 안 된다.
    try {
      if (isExecutable(candidate)) return candidate;
    } catch {
      // 이 디렉터리는 못 본 것으로 하고 다음으로 넘어간다.
    }
  }
  return null;
}

export function buildChildPath(dirs: readonly string[], inherited: string | undefined): string {
  const tail = (inherited ?? "").split(":").filter((d) => d.length > 0);
  const have = new Set(tail);
  return [...dirs.filter((d) => !have.has(d)), ...tail].join(":");
}
