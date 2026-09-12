# Electron Phase 2 — 서비스 실행 통합 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 터미널을 열지 않고 담화를 쓴다 — 앱이 DB·API·worker·embed 넷의 기동·감시·종료를 관리한다.

**Architecture:** `desktop/src/services/`에 서비스 감독자 하나와 어댑터 넷을 둔다. 감독자는 의존
순서로 띄우고, 준비를 판정하고, 재시작하고, 역순으로 내린다. 어댑터는 "이 서비스를 무엇으로
띄우는가"만 안다 — Phase 3·4는 어댑터의 `launch()` 하나씩만 갈아끼운다. 상태는 프로세스 축과
건강 축으로 나뉜다.

**Tech Stack:** Electron 44 (main 프로세스, TypeScript), vitest, Node `child_process`/`net`,
`docker compose`, `uv`, Python 3.12 (worker 1파일 변경), React 19 (fe 1군데 변경).

**Spec:** [docs/superpowers/specs/2026-09-12-electron-phase-2-service-orchestration-design.md](../specs/2026-09-12-electron-phase-2-service-orchestration-design.md)

**Results doc:** [docs/superpowers/reports/2026-09-12-electron-phase-2-service-orchestration-results.md](../reports/2026-09-12-electron-phase-2-service-orchestration-results.md) — Task 15가 채운다.

## Global Constraints

이 절은 모든 Task의 요구사항에 암묵적으로 포함된다. 값은 스펙에서 그대로 옮겼다.

- **`desktop/package.json`의 `dependencies`는 비어 있어야 한다.** 런타임 의존을 추가하면 Phase 1의
  번들 위생 기준(P1-C11, 이 Phase에서는 P2-C14)이 깨진다. `pg` 클라이언트를 main에 넣지 않는 이유가
  이것이다. 새 도구가 필요하면 Node 내장 모듈이나 `devDependencies`로 해결한다.
- **`npm install`을 `be/`에서 실행하지 않는다.** 저장소 루트에서 `pnpm install`만 쓴다.
- **패키지를 저장소 루트에서 실행하지 않는다.** `pnpm --filter` 또는 `uv run --directory`로 cwd를
  맞춘다.
- **`.env` 파일은 패키지별로 둔다.** 루트 `.env`를 만들지 않는다. 구현이 `be/.env`·`be/worker/.env`·
  `fe/.env`를 자동으로 고치지 않는다.
- **앱은 마이그레이션을 실행하지 않는다.** 감지하고 안내만 한다.
- **앱은 `docker compose down`·`stop`·`rm`을 부르지 않는다.** `up -d`만 부른다.
- **앱이 만들지 않은 프로세스는 죽이지 않는다.**
- **렌더러 → main 채널을 새로 만들지 않는다.** preload 없음, `ipcMain.handle` 없음. main → 렌더러
  방향의 `webContents.executeJavaScript()`만 쓴다.
- **`HOST`는 앱이 `127.0.0.1`로 고정 주입한다.** `config.json`으로 열 수 없다.
- Node `>=22 <23`, pnpm `10.26.0`, Python `>=3.12,<3.13`.
- 주석과 커밋 메시지는 한국어로 쓴다. 기존 `desktop/src/*.ts`의 주석 밀도와 어투를 따른다 — 그
  코드는 "왜 이렇게 했는가"를 적고 "무엇을 하는가"는 적지 않는다.
- 각 Task는 커밋 하나 이상으로 끝난다. 커밋 메시지 끝에
  `Claude-Session: https://claude.ai/code/session_01CSsVbykTbEVYdxm5cLwsTV`를 붙인다.

## 파일 구조

| 파일 | 책임 | Task |
| --- | --- | --- |
| `desktop/src/services/types.ts` | 서비스 계약 타입. 값 없음 | 3 |
| `desktop/src/services/resolve.ts` | 실행 파일 탐색과 자식 `PATH` 조립 | 2 |
| `desktop/src/services/supervisor.ts` | 의존 순서 기동·준비 대기·감시/재시작·역순 종료 | 3 |
| `desktop/src/services/external.ts` | 외부 인스턴스 감지 (ps 기반 / 포트 기반) | 4 |
| `desktop/src/services/postgres.ts` | postgres 어댑터 | 5 |
| `desktop/src/services/api.ts` | api 어댑터 + 마이그레이션 게이트 | 6 |
| `desktop/src/services/worker.ts` | worker 어댑터 | 8 |
| `desktop/src/services/embed.ts` | embed 어댑터 | 8 |
| `desktop/src/logs.ts` | 로그 파일 회전과 ANSI 제거 | 9 |
| `desktop/src/shutdown.ts` | 종료 정책 — 진행 중 판정, handshake, 역순 | 11 |
| `desktop/src/repo-root.ts` | `REPO_ROOT` 해석과 검증 | 2 |
| `desktop/shell/services.html` | 서비스 상태 창 (표시 전용) | 14 |
| `be/worker/damwha_worker/__main__.py` | ready 로그 (제품 코드 변경 1) | 7 |
| `fe/src/features/meeting/lib/desktop-bridge.ts` | 종료 handshake 훅 (제품 코드 변경 2) | 10 |

---

## Task 1: 기술 위험 실측 — `docker compose ps`와 GUI 환경의 `uv`

스펙 §12의 미확정 둘을 닫는다. **코드를 남기지 않는다** — 산출물은 측정값이고, 그 값이 Task 5·8의
구현을 결정한다.

**Files:**
- Modify: `docs/superpowers/reports/2026-09-12-electron-phase-2-service-orchestration-results.md` (§2에 측정 기록)

**Interfaces:**
- Consumes: 없음
- Produces: Task 5가 쓸 `docker compose ps` 판정 식, Task 8이 쓸 `uv` 실행 형태

- [ ] **Step 1: `docker compose ps --format json`의 출력 형태를 잰다**

```bash
cd /Users/jason/projects/Damwha2
docker compose -f be/docker-compose.yml ps --format json | head -c 2000
echo
docker compose version
```

출력이 **JSON 배열 한 덩어리인지, 줄마다 JSON 객체(JSONL)인지** 적는다. compose v2.21 전후로
다르다. `Health`·`State`·`Name`·`Service` 필드의 정확한 이름과 값을 적는다.

- [ ] **Step 2: 컨테이너가 내려간 상태의 출력도 잰다**

```bash
docker compose -f be/docker-compose.yml stop postgres
docker compose -f be/docker-compose.yml ps --format json
docker compose -f be/docker-compose.yml ps -a --format json | head -c 1000
docker compose -f be/docker-compose.yml start postgres
```

`ps`가 멈춘 컨테이너를 아예 빼는지, `State: "exited"`로 보여주는지 적는다. 빼면 어댑터는 `-a`를
써야 한다.

- [ ] **Step 3: Docker 데몬이 꺼진 상태의 실패 신호를 잰다**

Docker Desktop을 종료하고:

```bash
docker compose -f be/docker-compose.yml ps --format json; echo "exit=$?"
```

stderr 문구와 종료 코드를 적는다. Task 5의 "데몬 없음" 판정이 이 값을 쓴다. 잰 뒤 Docker를 다시
켠다.

- [ ] **Step 4: GUI 실행 환경의 `PATH`를 실측한다**

```bash
cat > /tmp/path-probe.sh <<'EOF'
#!/bin/bash
{ echo "PATH=$PATH"; echo "uv=$(command -v uv || echo MISSING)"; echo "docker=$(command -v docker || echo MISSING)"; } > /tmp/path-probe.out 2>&1
EOF
chmod +x /tmp/path-probe.sh
open -a /tmp/path-probe.sh 2>/dev/null || osascript -e 'do shell script "/tmp/path-probe.sh"'
sleep 1; cat /tmp/path-probe.out
```

`osascript`의 `do shell script`는 로그인 셸을 거치지 않으므로 GUI 실행과 같은 `PATH`를 준다.
`uv`와 `docker`가 `MISSING`인지 확인한다 — 스펙 §6.3의 전제다.

- [ ] **Step 5: 최소 PATH에서 절대 경로 `uv`가 도는지 잰다**

```bash
env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /opt/homebrew/bin/uv run --directory /Users/jason/projects/Damwha2/be/worker \
  python -c "import sys; print('ok', sys.version.split()[0])"
```

성공하면 Task 8은 절대 경로 하나로 충분하다. 실패하면 **실패 메시지 전문을 적고** 어떤 환경변수가
더 필요한지(예: `XDG_CACHE_HOME`, `UV_CACHE_DIR`) 좁힌다.

- [ ] **Step 6: 같은 조건에서 embed가 뜨는지 잰다**

```bash
env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  DATABASE_URL="postgres://postgres:postgres@localhost:5432/damwha" \
  LENS_LLM_BASE_URL="http://127.0.0.1:8000/v1" \
  EMBED_SERVICE_PORT=8123 \
  /opt/homebrew/bin/uv run --directory /Users/jason/projects/Damwha2/be/worker damwha-embed &
sleep 45
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8123/health
curl -s -X POST http://127.0.0.1:8123/embed -H 'content-type: application/json' \
  -d '{"texts":["계약 프로브"]}' | head -c 300
kill %1
```

`/health`가 200이 되기까지 걸린 초와, `/embed` 응답의 `model`·`dimension` 값을 적는다. Task 8의
유예 시간과 Task 4의 계약 프로브가 이 값을 쓴다.

- [ ] **Step 7: 측정값을 결과 문서에 기록하고 커밋**

결과 문서의 `## 2. 계획 검증`을 `## 2. 계획 검증과 사전 실측`으로 바꾸고 `### 2.1 사전 실측
(Task 1)` 절을 추가해 Step 1~6의 명령과 출력을 그대로 적는다.

```bash
git add docs/superpowers/reports/2026-09-12-electron-phase-2-service-orchestration-results.md
git commit -m "docs: Phase 2 Task 1 — compose ps 형식과 GUI PATH·uv 동작을 실측한다"
```

**Verify:**
- Step 1~6의 모든 명령이 실행됐고 출력이 결과 문서에 있다.
- Docker Desktop이 Step 3 뒤에 다시 켜져 있다: `docker compose -f be/docker-compose.yml ps` 성공.
- `git status`가 깨끗하다.

**Review:**
- 측정값이 **추측 없이** 기록됐는가. "아마 JSONL일 것"이 아니라 실제 출력이 있는가.
- Step 5나 6이 실패했다면 그 실패가 기록되고 **Task 8의 구현 방향이 바뀌었는가.** 실패를 성공으로
  가정하지 않았는가.
- 코드가 남지 않았는가 (`git diff --stat`이 문서 1파일).

---

## Task 2: 실행 파일 해석과 저장소 경로

**Files:**
- Create: `desktop/src/services/resolve.ts`
- Create: `desktop/src/repo-root.ts`
- Test: `desktop/tests/resolve.test.ts`, `desktop/tests/repo-root.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `searchDirs(home: string, extra?: readonly string[]): string[]`
  - `findExecutable(name: string, dirs: readonly string[], isExecutable?: (p: string) => boolean): string | null`
  - `buildChildPath(dirs: readonly string[], inherited: string | undefined): string`
  - `isRepoRoot(dir: string, exists?: (p: string) => boolean): boolean`

- [ ] **Step 1: `resolve.ts`의 실패 테스트를 쓴다**

`desktop/tests/resolve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildChildPath, findExecutable, searchDirs } from "../src/services/resolve";

describe("searchDirs", () => {
  it("expands {HOME} and keeps the documented order", () => {
    const dirs = searchDirs("/Users/x");
    expect(dirs[0]).toBe("/opt/homebrew/bin");
    expect(dirs).toContain("/Users/x/.local/bin");
    expect(dirs).toContain("/usr/local/bin");
    expect(dirs.at(-1)).toBe("/sbin");
  });

  it("puts extra dirs first", () => {
    expect(searchDirs("/Users/x", ["/opt/mine"])[0]).toBe("/opt/mine");
  });

  it("drops duplicates, keeping the earliest position", () => {
    const dirs = searchDirs("/Users/x", ["/usr/local/bin"]);
    expect(dirs[0]).toBe("/usr/local/bin");
    expect(dirs.filter((d) => d === "/usr/local/bin")).toHaveLength(1);
  });
});

describe("findExecutable", () => {
  it("returns the first directory that holds an executable", () => {
    const found = findExecutable("uv", ["/a", "/b"], (p) => p === "/b/uv");
    expect(found).toBe("/b/uv");
  });

  it("returns null when nothing is executable", () => {
    expect(findExecutable("uv", ["/a", "/b"], () => false)).toBeNull();
  });

  it("never throws when the probe throws", () => {
    expect(
      findExecutable("uv", ["/a"], () => {
        throw new Error("EACCES");
      }),
    ).toBeNull();
  });
});

describe("buildChildPath", () => {
  it("puts the search dirs in front of the inherited PATH", () => {
    expect(buildChildPath(["/opt/homebrew/bin"], "/usr/bin:/bin")).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
  });

  it("does not repeat a dir that the inherited PATH already has", () => {
    expect(buildChildPath(["/usr/bin", "/opt/homebrew/bin"], "/usr/bin:/bin")).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
  });

  it("works when there is no inherited PATH", () => {
    expect(buildChildPath(["/opt/homebrew/bin"], undefined)).toBe("/opt/homebrew/bin");
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/resolve.test.ts`
Expected: FAIL — `Cannot find module '../src/services/resolve'`

- [ ] **Step 3: `resolve.ts`를 쓴다**

```ts
import * as fs from "fs";
import * as path from "path";

/**
 * Finder로 띄운 앱의 PATH는 /usr/bin:/bin:/usr/sbin:/sbin뿐이다(2026-09-12 실측). uv도 docker도
 * 거기 없다. 이 목록이 두 가지를 한다 — 둘의 절대 경로를 찾고, 같은 목록을 자식 PATH에 붙인다.
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
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/resolve.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: `repo-root.ts`의 실패 테스트를 쓴다**

`desktop/tests/repo-root.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isRepoRoot } from "../src/repo-root";

describe("isRepoRoot", () => {
  const present = (paths: string[]) => (p: string) => paths.includes(p);

  it("accepts a dir that holds both markers", () => {
    expect(
      isRepoRoot("/r", present(["/r/be/worker/pyproject.toml", "/r/be/docker-compose.yml"])),
    ).toBe(true);
  });

  it("rejects a dir missing the worker project", () => {
    expect(isRepoRoot("/r", present(["/r/be/docker-compose.yml"]))).toBe(false);
  });

  it("rejects a dir missing the compose file", () => {
    expect(isRepoRoot("/r", present(["/r/be/worker/pyproject.toml"]))).toBe(false);
  });

  it("rejects an empty path", () => {
    expect(isRepoRoot("", () => true)).toBe(false);
  });
});
```

- [ ] **Step 6: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/repo-root.test.ts`
Expected: FAIL — `Cannot find module '../src/repo-root'`

- [ ] **Step 7: `repo-root.ts`를 쓴다**

```ts
import * as fs from "fs";
import * as path from "path";

/**
 * packaged .app 안에는 be/worker도 docker-compose.yml도 없다 — Phase 3·4가 번들할 것들이라
 * 이 Phase는 저장소 체크아웃을 가리켜야 한다. 빌드 시점에 굽지 않는 이유는 Phase 1의 번들 위생
 * 기준이 "번들 안에 저장소 절대 경로 0건"을 요구하기 때문이다 (스펙 §6.4).
 */
const MARKERS = ["be/worker/pyproject.toml", "be/docker-compose.yml"] as const;

export function isRepoRoot(
  dir: string,
  exists: (p: string) => boolean = fs.existsSync,
): boolean {
  if (dir.length === 0) return false;
  return MARKERS.every((m) => exists(path.join(dir, ...m.split("/"))));
}
```

- [ ] **Step 8: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/repo-root.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 9: 전체 테스트와 타입 검사**

```bash
pnpm --filter damwha-desktop run test
pnpm --filter damwha-desktop run lint
```

Expected: 모두 PASS. Phase 1의 5개 테스트 파일도 그대로 통과한다.

- [ ] **Step 10: 커밋**

```bash
git add desktop/src/services/resolve.ts desktop/src/repo-root.ts desktop/tests/resolve.test.ts desktop/tests/repo-root.test.ts
git commit -m "$(cat <<'EOF'
feat(desktop): 실행 파일 탐색과 저장소 경로 검증을 더한다

Finder로 띄운 앱의 PATH에는 uv도 docker도 없다. 한 목록이 두 일을 한다 —
둘의 절대 경로를 찾고, 같은 목록을 자식 PATH 앞에 붙인다. 두 번째가 없으면
worker 안의 shutil.which("mlx_lm.server")와 pipeline/ffmpeg.py의 리터럴
호출이 실패한다.

Claude-Session: https://claude.ai/code/session_01CSsVbykTbEVYdxm5cLwsTV
EOF
)"
```

**Verify:**
- `pnpm --filter damwha-desktop run test` → 기존 5파일 + 신규 2파일 전부 PASS.
- `pnpm --filter damwha-desktop run lint` → 오류 0.
- `git show --stat HEAD` → 4파일, 모두 `desktop/` 아래.

**Review:**
- `desktop/package.json`의 `dependencies`가 여전히 비어 있는가.
- `findExecutable`이 주입된 probe의 예외를 삼키는가 — 한 디렉터리의 `EACCES`가 탐색 전체를 끝내면
  `uv`가 있어도 못 찾는다.
- `buildChildPath`가 중복을 없애는가 — 상속 `PATH`에 이미 있는 디렉터리를 앞에 또 붙이면 자식의
  `PATH`가 실행마다 길어진다.
- `searchDirs`의 중복 제거가 **먼저 나온 자리를 남기는가.** 반대면 `EXTRA_PATH`가 무력해진다.
- 주석이 "무엇을"이 아니라 "왜"를 적는가 — 기존 `desktop/src/*.ts`의 어투와 같은가.

---

## Task 3: 서비스 계약 타입과 감독자

**Files:**
- Create: `desktop/src/services/types.ts`
- Create: `desktop/src/services/supervisor.ts`
- Test: `desktop/tests/supervisor.test.ts`

**Interfaces:**
- Consumes: Task 2의 `resolve.ts` (LaunchContext가 결과를 담는다)
- Produces:
  - `types.ts`: `ServiceId`, `ProcessState`, `HealthState`, `ServiceStatus`, `ServiceHandle`,
    `LaunchContext`, `LaunchResult`, `ReadinessResult`, `ServiceSpec`, `StopPlan`, `StopOutcome`
  - `supervisor.ts`: `orderOf(specs)`, `createSupervisor(specs, ctx, hooks)` →
    `{ start(), stopAll(plan), statuses(), runtimeOf(id) }`. 감독자가 재시작 정책도 소유한다 —
    ready 이후 사망을 감시해 `backoffMs`로 다시 띄우고 `maxAttempts`에서 멈춘다. `gate: false`인
    서비스의 준비 대기는 배경으로 돌아 기동 루프를 막지 않는다.

- [ ] **Step 1: `types.ts`를 쓴다 (값이 없으므로 테스트 없음)**

```ts
import type { ApiHandle } from "../api-process";
import type { ApiEnv } from "../config";

export type ServiceId = "postgres" | "api" | "embed" | "worker";

/** 프로세스가 있나. */
export type ProcessState = "stopped" | "starting" | "running" | "failed";
/** 그 프로세스가 실제로 일을 하나. 둘을 나누는 이유는 스펙 §6.6에 있다 — API는 부팅 뒤 DB가
 *  끊겨도 죽지 않고 503을 주므로, 프로세스 축만 보는 감독자는 정상으로 오판한다. */
export type HealthState = "unknown" | "ok" | "degraded";

/** Phase 1의 ApiHandle이 이미 필요한 것을 다 갖고 있다. 이름만 넓힌다. */
export type ServiceHandle = ApiHandle;

export interface ServiceStatus {
  id: ServiceId;
  process: ProcessState;
  health: HealthState;
  /** 사람에게 보여줄 원인. 여러 줄일 수 있다. */
  detail?: string;
  /** 앱이 이 서비스를 소유하는가. 외부를 채택했거나 안 띄웠으면 false. */
  owned: boolean;
  restarts: number;
}

export interface LaunchContext {
  repoRoot: string;
  userData: string;
  packaged: boolean;
  /** config.json에서 온 값 + 어댑터들의 prepare()가 기여한 값. */
  env: ApiEnv;
  bins: { uv: string | null; docker: string | null };
  searchDirs: readonly string[];
  logFile(id: ServiceId): string;
}

export interface LaunchResult {
  /** 앱이 쥔 프로세스 핸들. 컨테이너처럼 프로세스가 아닌 것은 null. */
  handle: ServiceHandle | null;
  /** 앱이 이번에 실제로 띄웠나. 외부를 채택했으면 false → 종료 시 건드리지 않는다. */
  owned: boolean;
  /** api만 채운다 — 렌더러가 붙을 주소. */
  origin?: string;
}

export type ExternalState =
  | { kind: "absent" }
  /** 외부에 있고 우리가 쓴다. 죽이지 않는다. */
  | { kind: "adopt"; detail: string }
  /** 외부에 있어 우리 것을 띄우지 않는다. 앱은 계속 쓸 수 있다. */
  | { kind: "stand-down"; detail: string };

export type ReadinessResult =
  | { kind: "ready" }
  | { kind: "not-ready" }
  | { kind: "degraded"; detail: string }
  | { kind: "failed"; detail: string };

export interface StopPlan {
  graceMs: number;
  /** 유예가 지났을 때 부른다. true면 강제 단계로 올라간다. */
  onGraceExpired?: (id: ServiceId) => Promise<boolean>;
}

export interface StopOutcome {
  stopped: boolean;
  /** 정리하지 못하고 남은 pid. 비어 있지 않으면 화면과 로그에 적는다. */
  leaked: number[];
}

export interface ServiceSpec {
  id: ServiceId;
  /** 시작 순서와 종료 역순을 이 한 값이 결정한다. */
  dependsOn: readonly ServiceId[];
  /** 창을 열기 전에 준비를 기다리는가. */
  gate: boolean;
  /** 기동 전에 env에 기여한다. 포트 결정처럼 다른 서비스가 의존하는 값. */
  prepare?(ctx: LaunchContext): Promise<Partial<ApiEnv>>;
  detectExternal(ctx: LaunchContext): Promise<ExternalState>;
  /** ← Phase 3·4가 갈아끼우는 유일한 지점. */
  launch(ctx: LaunchContext): Promise<LaunchResult>;
  readiness(result: LaunchResult, ctx: LaunchContext): Promise<ReadinessResult>;
  /**
   * 이 서비스만의 준비 유예. 없으면 감독자 기본값. embed는 bge-m3를 import 시점에 올려
   * 2026-09-12 실측으로 31초가 걸렸고(따뜻한 캐시), 모델 캐시가 비면 훨씬 길다.
   */
  readyTimeoutMs?: number;
  stop(result: LaunchResult, plan: StopPlan): Promise<StopOutcome>;
  restart: { maxAttempts: number; backoffMs: readonly number[] } | "never";
}
```

- [ ] **Step 2: 감독자의 실패 테스트를 쓴다**

`desktop/tests/supervisor.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createSupervisor, orderOf } from "../src/services/supervisor";
import type { LaunchContext, ServiceId, ServiceSpec } from "../src/services/types";

function ctx(): LaunchContext {
  return {
    repoRoot: "/r",
    userData: "/u",
    packaged: false,
    env: {},
    bins: { uv: "/opt/homebrew/bin/uv", docker: "/usr/local/bin/docker" },
    searchDirs: ["/opt/homebrew/bin"],
    logFile: (id) => `/u/logs/${id}.log`,
  };
}

function spec(id: ServiceId, over: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    id,
    dependsOn: [],
    gate: true,
    detectExternal: async () => ({ kind: "absent" }),
    launch: async () => ({ handle: null, owned: true }),
    readiness: async () => ({ kind: "ready" }),
    stop: async () => ({ stopped: true, leaked: [] }),
    restart: "never",
    ...over,
  };
}

describe("orderOf", () => {
  it("puts a dependency before its dependant", () => {
    const order = orderOf([spec("api", { dependsOn: ["postgres"] }), spec("postgres")]);
    expect(order.map((s) => s.id)).toEqual(["postgres", "api"]);
  });

  it("keeps independent services in declaration order", () => {
    const order = orderOf([spec("embed"), spec("postgres")]);
    expect(order.map((s) => s.id)).toEqual(["embed", "postgres"]);
  });

  it("throws on a cycle instead of looping forever", () => {
    expect(() =>
      orderOf([
        spec("api", { dependsOn: ["worker"] }),
        spec("worker", { dependsOn: ["api"] }),
      ]),
    ).toThrow(/cycle/i);
  });
});

describe("supervisor.start", () => {
  it("merges prepare() output into the env before any launch", async () => {
    const seen: string[] = [];
    const s = createSupervisor(
      [
        spec("embed", { prepare: async () => ({ EMBED_SERVICE_PORT: "8123" }) }),
        spec("api", {
          dependsOn: ["embed"],
          launch: async (c) => {
            seen.push(c.env.EMBED_SERVICE_PORT ?? "missing");
            return { handle: null, owned: true };
          },
        }),
      ],
      ctx(),
      {},
    );
    await s.start();
    expect(seen).toEqual(["8123"]);
  });

  it("does not launch a service whose external policy stands down", async () => {
    const launch = vi.fn(async () => ({ handle: null, owned: true }));
    const s = createSupervisor(
      [
        spec("worker", {
          detectExternal: async () => ({ kind: "stand-down", detail: "외부 worker" }),
          launch,
        }),
      ],
      ctx(),
      {},
    );
    await s.start();
    expect(launch).not.toHaveBeenCalled();
    const st = s.statuses().find((x) => x.id === "worker")!;
    expect(st.owned).toBe(false);
    expect(st.detail).toContain("외부 worker");
  });

  it("stops a gate service that never becomes ready and reports failed", async () => {
    const stop = vi.fn(async () => ({ stopped: true, leaked: [] }));
    const s = createSupervisor(
      [spec("api", { readiness: async () => ({ kind: "not-ready" }), stop })],
      ctx(),
      { readyTimeoutMs: 30, readyIntervalMs: 5 },
    );
    await s.start();
    expect(s.statuses()[0].process).toBe("failed");
    expect(stop).toHaveBeenCalled();
  });

  it("stops launching once a gate service fails", async () => {
    const later = vi.fn(async () => ({ handle: null, owned: true }));
    const s = createSupervisor(
      [
        spec("postgres", { readiness: async () => ({ kind: "failed", detail: "데몬 없음" }) }),
        spec("api", { dependsOn: ["postgres"], launch: later }),
      ],
      ctx(),
      {},
    );
    await s.start();
    expect(later).not.toHaveBeenCalled();
    expect(s.statuses().find((x) => x.id === "api")!.process).toBe("stopped");
  });

  it("keeps going when a non-gate service is not ready", async () => {
    const s = createSupervisor(
      [
        spec("api"),
        spec("worker", { gate: false, dependsOn: ["api"], readiness: async () => ({ kind: "not-ready" }) }),
      ],
      ctx(),
      { readyTimeoutMs: 30, readyIntervalMs: 5 },
    );
    await s.start();
    expect(s.statuses().find((x) => x.id === "api")!.process).toBe("running");
    expect(s.statuses().find((x) => x.id === "worker")!.process).toBe("failed");
  });

  it("records degraded without touching the process state", async () => {
    const s = createSupervisor(
      [spec("api", { readiness: async () => ({ kind: "degraded", detail: "DB 끊김" }) })],
      ctx(),
      { readyTimeoutMs: 30, readyIntervalMs: 5 },
    );
    await s.start();
    const st = s.statuses()[0];
    expect(st.process).toBe("running");
    expect(st.health).toBe("degraded");
    expect(st.detail).toBe("DB 끊김");
  });
});

describe("supervisor restart policy", () => {
  it("does not block the start loop on a non-gate service", async () => {
    // embed는 bge-m3를 import 시점에 올려 30초 이상 걸린다. 직렬로 기다리면 창이 그만큼
    // 늦게 뜬다 — 스펙 §6.7의 "게이트는 셋뿐"이 이 비대칭을 뜻한다.
    const order: ServiceId[] = [];
    const s = createSupervisor(
      [
        spec("embed", {
          gate: false,
          readiness: async () => {
            await new Promise((r) => setTimeout(r, 200));
            return { kind: "ready" };
          },
          launch: async () => {
            order.push("embed");
            return { handle: null, owned: true };
          },
        }),
        spec("api", {
          launch: async () => {
            order.push("api");
            return { handle: null, owned: true };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 2_000, readyIntervalMs: 10 },
    );
    await s.start();
    // start()가 embed의 200ms를 기다렸다면 api는 그 뒤에 온다. 기다리지 않았으면 둘 다 즉시.
    expect(order).toEqual(["embed", "api"]);
    expect(s.statuses().find((x) => x.id === "api")!.process).toBe("running");
  });

  it("relaunches after the process dies and counts the attempt", async () => {
    let launches = 0;
    let listener: ((code: number) => void) | null = null;
    const s = createSupervisor(
      [
        spec("worker", {
          gate: true,
          restart: { maxAttempts: 2, backoffMs: [5] },
          launch: async () => {
            launches += 1;
            return {
              handle: {
                pid: 1,
                alive: () => true,
                stderrTail: () => "",
                exitCode: () => null,
                onExit: (l: (c: number) => void) => {
                  listener = l;
                },
                stop: async () => undefined,
              } as never,
              owned: true,
            };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    expect(launches).toBe(1);
    listener!(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(launches).toBe(2);
    expect(s.statuses()[0].restarts).toBe(1);
  });

  it("stops relaunching at maxAttempts instead of looping forever", async () => {
    let launches = 0;
    const listeners: Array<(code: number) => void> = [];
    const s = createSupervisor(
      [
        spec("worker", {
          restart: { maxAttempts: 2, backoffMs: [5] },
          launch: async () => {
            launches += 1;
            return {
              handle: {
                pid: 1,
                alive: () => true,
                stderrTail: () => "",
                exitCode: () => null,
                onExit: (l: (c: number) => void) => listeners.push(l),
                stop: async () => undefined,
              } as never,
              owned: true,
            };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    for (let i = 0; i < 5; i += 1) {
      listeners.at(-1)?.(1);
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(launches).toBe(3); // 최초 1 + 재시작 2
  });

  it("never restarts a service whose policy is never", async () => {
    // postgres. compose의 restart: unless-stopped가 이미 그 일을 한다.
    let launches = 0;
    let listener: ((code: number) => void) | null = null;
    const s = createSupervisor(
      [
        spec("postgres", {
          restart: "never",
          launch: async () => {
            launches += 1;
            return {
              handle: {
                pid: 1,
                alive: () => true,
                stderrTail: () => "",
                exitCode: () => null,
                onExit: (l: (c: number) => void) => {
                  listener = l;
                },
                stop: async () => undefined,
              } as never,
              owned: true,
            };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    listener!(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(launches).toBe(1);
  });

  it("does not restart once stopAll has begun", async () => {
    // 종료가 방금 치운 것을 타이머가 되살리면 앱이 창 없이 프로세스만 남긴다.
    let launches = 0;
    let listener: ((code: number) => void) | null = null;
    const s = createSupervisor(
      [
        spec("worker", {
          restart: { maxAttempts: 3, backoffMs: [10] },
          launch: async () => {
            launches += 1;
            return {
              handle: {
                pid: 1,
                alive: () => true,
                stderrTail: () => "",
                exitCode: () => null,
                onExit: (l: (c: number) => void) => {
                  listener = l;
                },
                stop: async () => undefined,
              } as never,
              owned: true,
            };
          },
        }),
      ],
      ctx(),
      { readyTimeoutMs: 100, readyIntervalMs: 5 },
    );
    await s.start();
    await s.stopAll({ graceMs: 5 });
    listener!(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(launches).toBe(1);
  });
});

describe("supervisor.stopAll", () => {
  it("stops in reverse dependency order", async () => {
    const order: ServiceId[] = [];
    const rec = (id: ServiceId) =>
      spec(id, {
        dependsOn: id === "postgres" ? [] : ["postgres"],
        stop: async () => {
          order.push(id);
          return { stopped: true, leaked: [] };
        },
      });
    const s = createSupervisor([rec("postgres"), rec("api"), rec("worker")], ctx(), {});
    await s.start();
    await s.stopAll({ graceMs: 10 });
    expect(order).toEqual(["worker", "api", "postgres"]);
  });

  it("never stops a service the app did not launch", async () => {
    const stop = vi.fn(async () => ({ stopped: true, leaked: [] }));
    const s = createSupervisor(
      [spec("embed", { detectExternal: async () => ({ kind: "adopt", detail: "외부" }), stop })],
      ctx(),
      {},
    );
    await s.start();
    await s.stopAll({ graceMs: 10 });
    expect(stop).not.toHaveBeenCalled();
  });

  it("collects leaked pids from every service", async () => {
    const s = createSupervisor(
      [
        spec("api", { stop: async () => ({ stopped: false, leaked: [111] }) }),
        spec("worker", { stop: async () => ({ stopped: false, leaked: [222, 333] }) }),
      ],
      ctx(),
      {},
    );
    await s.start();
    const out = await s.stopAll({ graceMs: 10 });
    expect(out.leaked.sort()).toEqual([111, 222, 333]);
  });

  it("keeps stopping the rest when one service's stop throws", async () => {
    const stopped: ServiceId[] = [];
    const s = createSupervisor(
      [
        spec("api", {
          stop: async () => {
            stopped.push("api");
            return { stopped: true, leaked: [] };
          },
        }),
        spec("worker", {
          dependsOn: ["api"],
          stop: async () => {
            throw new Error("boom");
          },
        }),
      ],
      ctx(),
      {},
    );
    await s.start();
    await s.stopAll({ graceMs: 10 });
    expect(stopped).toEqual(["api"]);
  });
});
```

- [ ] **Step 3: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/supervisor.test.ts`
Expected: FAIL — `Cannot find module '../src/services/supervisor'`

- [ ] **Step 4: `supervisor.ts`를 쓴다**

```ts
import type {
  LaunchContext,
  LaunchResult,
  ReadinessResult,
  ServiceId,
  ServiceSpec,
  ServiceStatus,
  StopOutcome,
  StopPlan,
} from "./types";

export interface SupervisorHooks {
  /** 상태가 바뀔 때마다 부른다. 화면 갱신이 여기에 붙는다. */
  onStatus?(statuses: ServiceStatus[]): void;
  /** 감독자 자신의 판단 기록. supervisor.log가 여기로 온다. */
  log?(line: string): void;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_READY_INTERVAL_MS = 400;

/**
 * 의존 순서 위상 정렬. 같은 층에서는 선언 순서를 유지한다 — 순서가 바뀌면 로그와 화면의 줄
 * 순서가 실행마다 달라져 사람이 비교할 수 없다.
 */
export function orderOf(specs: readonly ServiceSpec[]): ServiceSpec[] {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const out: ServiceSpec[] = [];
  const done = new Set<ServiceId>();
  const path = new Set<ServiceId>();

  const visit = (spec: ServiceSpec) => {
    if (done.has(spec.id)) return;
    if (path.has(spec.id)) throw new Error(`service dependency cycle at ${spec.id}`);
    path.add(spec.id);
    for (const dep of spec.dependsOn) {
      const target = byId.get(dep);
      // 선언되지 않은 의존은 무시한다 — 서비스 집합이 모드마다 다를 수 있고(Phase 3·4),
      // 없는 의존 때문에 기동 전체가 예외로 끝나면 안 된다.
      if (target !== undefined) visit(target);
    }
    path.delete(spec.id);
    done.add(spec.id);
    out.push(spec);
  };

  for (const spec of specs) visit(spec);
  return out;
}

interface Runtime {
  spec: ServiceSpec;
  status: ServiceStatus;
  result: LaunchResult | null;
}

export function createSupervisor(
  specs: readonly ServiceSpec[],
  ctx: LaunchContext,
  hooks: SupervisorHooks,
) {
  const ordered = orderOf(specs);
  const runtimes = new Map<ServiceId, Runtime>(
    ordered.map((spec) => [
      spec.id,
      {
        spec,
        status: { id: spec.id, process: "stopped", health: "unknown", owned: false, restarts: 0 },
        result: null,
      },
    ]),
  );

  /** 종료가 시작되면 재시작을 걸지 않는다. 종료가 방금 치운 것을 타이머가 되살리면 안 된다. */
  let stopping = false;
  const timers = new Set<NodeJS.Timeout>();

  const statuses = () => ordered.map((s) => ({ ...runtimes.get(s.id)!.status }));
  const emit = () => hooks.onStatus?.(statuses());
  const log = (line: string) => hooks.log?.(line);

  const set = (id: ServiceId, patch: Partial<ServiceStatus>) => {
    const rt = runtimes.get(id)!;
    rt.status = { ...rt.status, ...patch };
    emit();
  };

  const applyReadiness = (id: ServiceId, r: ReadinessResult): boolean => {
    if (r.kind === "ready") {
      set(id, { process: "running", health: "ok", detail: undefined });
      return true;
    }
    if (r.kind === "degraded") {
      // 재시작을 유발하지 않는다 — 재시작해도 의존이 돌아오지 않으면 같고 백오프만 태운다.
      set(id, { process: "running", health: "degraded", detail: r.detail });
      return true;
    }
    return false;
  };

  /**
   * Phase 1의 waitForReady를 쓰지 않는다. 그 함수의 결과 어휘는 API 하나를 위한 것
   * ("ready" / "db-unreachable" / "child-exited" / "timeout")이라 ReadinessResult 넷을
   * 그대로 실어 나를 수 없고, `failed`를 "db-unreachable"에 태워 조기 탈출시키는 식으로
   * 우회하면 다음 사람이 그 값을 DB 이야기로 읽는다. 폴링은 여기 여덟 줄이면 된다.
   */
  async function awaitReady(rt: Runtime): Promise<boolean> {
    const timeoutMs = rt.spec.readyTimeoutMs ?? hooks.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const intervalMs = hooks.readyIntervalMs ?? DEFAULT_READY_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    let last: ReadinessResult = { kind: "not-ready" };

    for (;;) {
      // 프로세스가 있는 서비스는 죽으면 더 기다릴 이유가 없다. 핸들이 없는 서비스
      // (postgres 컨테이너)는 이 검사를 건너뛴다.
      if (rt.result?.handle !== null && rt.result?.handle !== undefined && !rt.result.handle.alive()) {
        const code = rt.result.handle.exitCode();
        set(rt.spec.id, {
          process: "failed",
          health: "unknown",
          detail: `프로세스가 종료됐어요 (코드 ${code ?? "?"}).`,
        });
        return false;
      }
      last = await rt.spec.readiness(rt.result!, ctx);
      if (applyReadiness(rt.spec.id, last)) return true;
      if (last.kind === "failed") break;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    const detail = last.kind === "failed" ? last.detail : "준비 시간을 넘겼어요.";
    set(rt.spec.id, { process: "failed", health: "unknown", detail });
    return false;
  }

  /** 배경으로 도는 비게이트 준비 대기. stopAll이 기다릴 수 있게 모아 둔다. */
  const pending = new Set<Promise<void>>();

  /**
   * 한 서비스를 띄우고 준비까지 본다. 게이트면 호출자가 await하고, 아니면 배경으로 돈다 —
   * embed는 bge-m3를 import 시점에 올려 30초 이상 걸리는데 그것을 직렬로 기다리면 창이 그만큼
   * 늦게 뜬다. 스펙 §6.7의 "게이트는 셋뿐"은 이 비대칭을 뜻한다.
   */
  async function bring(spec: ServiceSpec): Promise<boolean> {
    const rt = runtimes.get(spec.id)!;
    const external = await spec.detectExternal(ctx);
    if (external.kind === "stand-down") {
      log(`${spec.id}: 외부 인스턴스가 있어 앱이 띄우지 않는다 — ${external.detail}`);
      set(spec.id, { process: "running", health: "unknown", owned: false, detail: external.detail });
      return true;
    }

    set(spec.id, { process: "starting", health: "unknown" });
    try {
      rt.result = await spec.launch(ctx);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      set(spec.id, { process: "failed", health: "unknown", detail });
      log(`${spec.id}: 기동 실패 — ${detail}`);
      return false;
    }
    set(spec.id, { owned: rt.result.owned });
    if (external.kind === "adopt") log(`${spec.id}: 외부 인스턴스를 채택했다 — ${external.detail}`);

    if (await awaitReady(rt)) {
      log(`${spec.id}: 준비됨`);
      watchForDeath(rt);
      return true;
    }
    // 준비 못 한 것은 우리가 띄웠으면 치운다. 남겨 두면 재시도가 그 위에 또 띄운다.
    if (rt.result !== null && rt.result.owned) {
      await spec.stop(rt.result, { graceMs: 5_000 }).catch(() => undefined);
      rt.result = null;
    }
    scheduleRestart(spec, "기동 실패");
    return false;
  }

  /**
   * ready 이후에 죽으면 백오프로 다시 띄운다. 상한을 넘으면 failed로 고정하고 메뉴의 재시도를
   * 기다린다 (스펙 §6.8). postgres는 restart가 "never"다 — compose의 restart: unless-stopped가
   * 이미 그 일을 하고, 감독자가 둘이면 같은 컨테이너를 다툰다.
   */
  function scheduleRestart(spec: ServiceSpec, why: string): void {
    if (spec.restart === "never" || stopping) return;
    const rt = runtimes.get(spec.id)!;
    const attempt = rt.status.restarts;
    if (attempt >= spec.restart.maxAttempts) {
      log(`${spec.id}: 재시작 상한 ${spec.restart.maxAttempts}회를 넘겼다 — 수동 재시도를 기다린다`);
      return;
    }
    const delay = spec.restart.backoffMs[Math.min(attempt, spec.restart.backoffMs.length - 1)];
    set(spec.id, { restarts: attempt + 1 });
    log(`${spec.id}: ${why} — ${Math.round(delay / 1000)}초 뒤 재시작 (${attempt + 1}회차)`);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopping) return;
      const p = bring(spec).then(() => undefined);
      pending.add(p);
      void p.finally(() => pending.delete(p));
    }, delay);
    timers.add(timer);
  }

  /** ready 뒤 자식이 죽는 것을 감시한다. degraded는 여기 오지 않는다 — 프로세스는 살아 있다. */
  function watchForDeath(rt: Runtime): void {
    const handle = rt.result?.handle;
    if (handle === null || handle === undefined) return;
    handle.onExit((code) => {
      if (stopping) return;
      set(rt.spec.id, {
        process: "failed",
        health: "unknown",
        detail: `프로세스가 종료됐어요 (코드 ${code}).`,
      });
      rt.result = null;
      scheduleRestart(rt.spec, `종료 (코드 ${code})`);
    });
  }

  async function start(): Promise<void> {
    // prepare()를 전부 먼저 돌린다. embed의 포트 결정처럼 다른 서비스의 env가 그것에 의존한다.
    // 선언 순서와 무관하게 launch보다 먼저 끝난다.
    for (const spec of ordered) {
      if (spec.prepare === undefined) continue;
      Object.assign(ctx.env, await spec.prepare(ctx));
    }

    for (const spec of ordered) {
      if (!spec.gate) {
        // 배경으로 돌린다. 실패해도 기동 전체를 멈추지 않는다.
        const p = bring(spec).then(() => undefined);
        pending.add(p);
        void p.finally(() => pending.delete(p));
        continue;
      }
      if (!(await bring(spec))) return;
    }
  }

  async function stopAll(plan: StopPlan): Promise<StopOutcome> {
    stopping = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    const leaked: number[] = [];
    let stopped = true;
    // 역순. dependsOn이 정한 순서를 뒤집는 것이 곧 의존 역순이다.
    for (const spec of [...ordered].reverse()) {
      const rt = runtimes.get(spec.id)!;
      // 앱이 만들지 않은 것은 건드리지 않는다 (스펙 §5).
      if (rt.result === null || !rt.result.owned) continue;
      try {
        const out = await spec.stop(rt.result, plan);
        if (!out.stopped) stopped = false;
        leaked.push(...out.leaked);
      } catch (e) {
        // 하나가 던져도 나머지는 내린다 — 여기서 멈추면 앞선 서비스가 통째로 남는다.
        stopped = false;
        log(`${spec.id}: 종료 중 예외 — ${e instanceof Error ? e.message : String(e)}`);
      }
      rt.result = null;
      set(spec.id, { process: "stopped", health: "unknown", owned: false });
    }
    return { stopped, leaked };
  }

  return { start, stopAll, statuses, runtimeOf: (id: ServiceId) => runtimes.get(id) };
}
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/supervisor.test.ts`
Expected: PASS — 18 tests

- [ ] **Step 6: 전체 테스트와 타입 검사**

```bash
pnpm --filter damwha-desktop run test
pnpm --filter damwha-desktop run lint
```

Expected: 모두 PASS.

- [ ] **Step 7: 커밋**

```bash
git add desktop/src/services/types.ts desktop/src/services/supervisor.ts desktop/tests/supervisor.test.ts
git commit -m "$(cat <<'EOF'
feat(desktop): 서비스 계약 타입과 감독자를 더한다

dependsOn 한 값이 시작 순서와 종료 역순을 함께 정한다. 상태는 프로세스 축과
건강 축으로 나뉜다 — API는 부팅 뒤 DB가 끊겨도 죽지 않고 503을 주므로,
프로세스 축만 보는 감독자는 그것을 정상으로 읽는다. degraded는 재시작을
유발하지 않는다.

앱이 만들지 않은 것은 stopAll이 건드리지 않는다. 한 서비스의 stop이 던져도
나머지는 내린다 — 거기서 멈추면 앞선 서비스가 통째로 남는다.

Claude-Session: https://claude.ai/code/session_01CSsVbykTbEVYdxm5cLwsTV
EOF
)"
```

**Verify:**
- `pnpm --filter damwha-desktop run test` → 전부 PASS (Phase 1의 5파일 포함).
- `pnpm --filter damwha-desktop run lint` → 오류 0.
- 순환 의존 테스트가 **타임아웃이 아니라 예외로** 실패하는지 확인: 해당 `it`이 5초 안에 끝난다.

**Review:**
- `stopAll`이 `owned === false`인 서비스를 정말 건드리지 않는가. 이것이 P2-C6의 코드 근거다.
- `degraded`가 `process`를 `running`으로 두는가. `failed`로 두면 재시작 정책이 발화해 백오프를
  태우고 스펙 §6.8을 위반한다.
- `orderOf`가 선언되지 않은 의존을 만나도 던지지 않는가 — 모드마다 서비스 집합이 다를 수 있다.
- 게이트 서비스가 실패했을 때 **뒤 서비스를 띄우지 않는가.** 띄우면 스키마 없는 DB 위에 worker가
  올라가는 경로가 열린다.
- 준비 못 한 자식을 `stop`으로 치우는가. 안 치우면 재시도마다 프로세스가 쌓인다.
- **비게이트 서비스가 기동 루프를 막지 않는가.** 막으면 embed의 bge-m3 로딩이 창을 30초 늦춘다.
- **재시작이 실제로 구현됐는가.** `restart` 필드를 선언만 하고 아무도 읽지 않으면 스펙 §6.8이
  글자로만 남고 P2-C11을 판정할 수 없다.
- `stopAll` 뒤에 재시작 타이머가 살아남지 않는가. 살아남으면 종료가 치운 것을 되살린다.
- `restart: "never"`인 postgres를 정말 재시작하지 않는가.

---

## Task 4: 외부 인스턴스 감지

**Files:**
- Create: `desktop/src/services/external.ts`
- Test: `desktop/tests/external.test.ts`

**Interfaces:**
- Consumes: Task 3의 `types.ts` (`ExternalState`)
- Produces:
  - `parseWorkerProcesses(psOutput: string, ourDescendants: ReadonlySet<number>): number[]`
  - `probeEmbedContract(baseUrl, want, fetchImpl?, timeoutMs?): Promise<EmbedProbe>`
  - `type EmbedProbe = { kind: "match" } | { kind: "mismatch"; detail: string } | { kind: "absent" }`

- [ ] **Step 1: 실패 테스트를 쓴다**

`desktop/tests/external.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseWorkerProcesses, probeEmbedContract } from "../src/services/external";

const PS = [
  "  PID COMMAND",
  " 4101 /opt/homebrew/bin/python3.12 -m damwha_worker",
  " 4207 /opt/homebrew/bin/python3.12 -m damwha_worker --once",
  " 4300 /usr/bin/grep damwha_worker",
  " 4400 /Applications/Damwha.app/Contents/MacOS/Damwha",
].join("\n");

describe("parseWorkerProcesses", () => {
  it("finds a supervisor", () => {
    expect(parseWorkerProcesses(PS, new Set())).toEqual([4101]);
  });

  it("ignores the one-shot child", () => {
    // __main__.py:279가 자식을 [sys.executable, "-m", "damwha_worker", "--once"]로 띄운다.
    // 거르지 않으면 job 하나를 처리 중인 자식을 상시 supervisor로 오인해 앱이 영영 안 띄운다.
    expect(parseWorkerProcesses(PS, new Set())).not.toContain(4207);
  });

  it("ignores our own descendants", () => {
    expect(parseWorkerProcesses(PS, new Set([4101]))).toEqual([]);
  });

  it("ignores a grep that merely mentions the module", () => {
    expect(parseWorkerProcesses(PS, new Set())).not.toContain(4300);
  });

  it("returns nothing for empty or header-only input", () => {
    expect(parseWorkerProcesses("", new Set())).toEqual([]);
    expect(parseWorkerProcesses("  PID COMMAND", new Set())).toEqual([]);
  });
});

describe("probeEmbedContract", () => {
  const want = { model: "BAAI/bge-m3", dimension: 1024 };

  it("matches when model and dimension agree", async () => {
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => ({
      status: 200,
      json: async () => ({ model: "BAAI/bge-m3", dimension: 1024, vectors: [[0.1]] }),
    }));
    expect(r.kind).toBe("match");
  });

  it("reports a mismatched model instead of adopting it", async () => {
    // /health는 {"status":"ok"}만 돌려주므로 다른 모델도 200을 준다 (embed_service.py:24-25).
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => ({
      status: 200,
      json: async () => ({ model: "other/model", dimension: 1024, vectors: [[0.1]] }),
    }));
    expect(r.kind).toBe("mismatch");
    expect(r.kind === "mismatch" && r.detail).toContain("other/model");
  });

  it("reports a mismatched dimension", async () => {
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => ({
      status: 200,
      json: async () => ({ model: "BAAI/bge-m3", dimension: 768, vectors: [[0.1]] }),
    }));
    expect(r.kind).toBe("mismatch");
    expect(r.kind === "mismatch" && r.detail).toContain("768");
  });

  it("treats a refused connection as absent", async () => {
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(r.kind).toBe("absent");
  });

  it("treats a non-200 as absent", async () => {
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => ({
      status: 503,
      json: async () => ({}),
    }));
    expect(r.kind).toBe("absent");
  });

  it("treats unparseable JSON as absent rather than throwing", async () => {
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => ({
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }));
    expect(r.kind).toBe("absent");
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/external.test.ts`
Expected: FAIL — `Cannot find module '../src/services/external'`

- [ ] **Step 3: `external.ts`를 쓴다**

```ts
/**
 * worker는 포트가 없어 Phase 1의 소유 판정 기구(isPortOccupied / verifyOwnListener)를 쓸 수
 * 없다. 대신 ps의 커맨드라인을 본다. 두 가지를 반드시 거른다 (스펙 §6.5).
 */

/** ps 자신이나 grep이 문자열을 갖고 있는 줄. 이것을 세면 앱이 자기 worker를 안 띄운다. */
const SELF_NOISE = /\b(grep|ps)\b/;

export function parseWorkerProcesses(
  psOutput: string,
  ourDescendants: ReadonlySet<number>,
): number[] {
  const out: number[] = [];
  for (const line of psOutput.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const space = trimmed.indexOf(" ");
    if (space <= 0) continue;
    const pid = Number(trimmed.slice(0, space));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const command = trimmed.slice(space + 1);
    if (!command.includes("damwha_worker")) continue;
    // __main__.py:279의 일회성 자식. 이것을 supervisor로 세면 앱이 자기 worker를 영영 안 띄운다.
    if (/(^|\s)--once(\s|$)/.test(command)) continue;
    if (SELF_NOISE.test(command)) continue;
    if (ourDescendants.has(pid)) continue;
    out.push(pid);
  }
  return out;
}

export type EmbedProbe =
  | { kind: "match" }
  | { kind: "mismatch"; detail: string }
  | { kind: "absent" };

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/**
 * 채택 판정을 /health로 하지 않는 이유: embed_service.py:24-25의 /health는 {"status":"ok"}만
 * 돌려주므로 다른 모델·다른 차원을 서빙하는 서비스도 200을 준다. 채택하면 API가 /embed 응답을
 * 거절해 모든 의미 검색이 오류 없이 키워드 검색으로 떨어진다 (스펙 §6.5).
 */
export async function probeEmbedContract(
  baseUrl: string,
  want: { model: string; dimension: number },
  fetchImpl: FetchLike = (url, init) => fetch(url, init) as never,
  timeoutMs = 3_000,
): Promise<EmbedProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: ["담화 계약 프로브"] }),
      signal: controller.signal,
    });
    if (res.status !== 200) return { kind: "absent" };
    const body = (await res.json()) as { model?: unknown; dimension?: unknown };
    const model = typeof body.model === "string" ? body.model : null;
    const dimension = typeof body.dimension === "number" ? body.dimension : null;
    if (model === null || dimension === null) return { kind: "absent" };
    if (model !== want.model || dimension !== want.dimension) {
      return {
        kind: "mismatch",
        detail: `모델 ${model}·차원 ${dimension}을 서빙하고 있어요 (앱은 ${want.model}·${want.dimension}이 필요해요)`,
      };
    }
    return { kind: "match" };
  } catch {
    // 연결 거부·타임아웃·JSON 파싱 실패는 전부 "거기 쓸 만한 게 없다"와 같다.
    return { kind: "absent" };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/external.test.ts`
Expected: PASS — 12 tests

- [ ] **Step 5: 실제 `ps` 출력으로 파서를 1회 확인한다**

```bash
cd /Users/jason/projects/Damwha2
pnpm worker > /tmp/w.log 2>&1 &
sleep 8
ps -axo pid,command | grep "[d]amwha_worker"
kill %1
```

출력의 supervisor 줄이 `parseWorkerProcesses`가 잡는 모양(`-m damwha_worker`, `--once` 없음)인지
눈으로 확인한다. `uv run`이 `python` 앞에 래퍼를 하나 더 끼워 커맨드라인이 다르면, 테스트의 `PS`
상수를 **실제 출력으로 바꾸고** 구현을 맞춘 뒤 Step 1~4를 다시 돈다.

- [ ] **Step 6: 전체 테스트·타입 검사 후 커밋**

```bash
pnpm --filter damwha-desktop run test && pnpm --filter damwha-desktop run lint
git add desktop/src/services/external.ts desktop/tests/external.test.ts
git commit -F - <<'MSG'
feat(desktop): 외부 worker·embed 감지를 더한다

worker는 포트가 없어 Phase 1의 소유 판정 기구를 못 쓴다. ps의 커맨드라인을
보되 --once 자식을 반드시 거른다 — __main__.py:279가 자식을 같은 모듈 명령으로
띄우므로, 거르지 않으면 job 하나를 처리 중인 자식을 상시 supervisor로 오인해
앱이 자기 worker를 영영 띄우지 않는다.

embed 채택은 /health로 판정하지 않는다. embed_service.py:24-25의 /health는
{"status":"ok"}만 돌려줘서 다른 모델·차원도 200을 준다. 채택하면 API가 /embed
응답을 거절해 의미 검색이 오류 없이 키워드 검색으로 떨어진다.

Claude-Session: https://claude.ai/code/session_01CSsVbykTbEVYdxm5cLwsTV
MSG
```

**Verify:**
- `pnpm --filter damwha-desktop run test` → 전부 PASS.
- Step 5의 실제 `ps` 출력이 테스트의 `PS` 상수와 같은 모양이다 (다르면 상수를 고쳤다).
- 터미널 worker가 종료됐다: `ps -axo pid,command | grep -c "[d]amwha_worker"` → 0.

**Review:**
- `--once` 필터가 `--once-ish` 같은 문자열에 오탐하지 않는가 (`(^|\s)--once(\s|$)`).
- `probeEmbedContract`가 어떤 예외에도 던지지 않는가. 감지는 실패 쪽으로 닫혀야 하고, 여기서
  던지면 기동 전체가 예외로 끝난다.
- `mismatch`의 `detail`이 **실제로 무엇이 다른지** 말하는가. "불일치"만 적으면 사용자가 못 고친다.
- 자손 제외 인자가 `ReadonlySet<number>`인가 — 호출부가 Phase 1의 `descendantPids()`를 그대로
  넘길 수 있어야 한다.

---

## Task 5: postgres 어댑터

**Files:**
- Create: `desktop/src/services/postgres.ts`
- Test: `desktop/tests/postgres.test.ts`

**Interfaces:**
- Consumes: Task 1의 측정값(`docker compose ps` 출력 형태), Task 3의 `types.ts`
- Produces:
  - `parseComposeStatus(stdout: string): ComposeState`
  - `postgresSpec(run: DockerRunner): ServiceSpec`
  - `type DockerRunner = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>`

- [ ] **Step 1: 실패 테스트를 쓴다**

`desktop/tests/postgres.test.ts`. 아래 세 상수는 **2026-09-12 실측값이다**(Docker Compose v5.5.0,
이 기계). 출력은 JSONL이고 `Name`·`Service`·`State`·`Health` 필드가 있으며, 멈춘 컨테이너는
`ps`에서 **빠지고** `ps -a`에만 `State: "exited"`, `Health: ""`로 나온다 — `-a`가 필수다.

```ts
import { describe, expect, it, vi } from "vitest";
import { parseComposeStatus, postgresSpec } from "../src/services/postgres";
import type { LaunchContext } from "../src/services/types";

const HEALTHY = '{"Name":"damwha-postgres","Service":"postgres","State":"running","Health":"healthy"}';
const STARTING = '{"Name":"damwha-postgres","Service":"postgres","State":"running","Health":"starting"}';
const EXITED = '{"Name":"damwha-postgres","Service":"postgres","State":"exited","Health":""}';

function ctx(): LaunchContext {
  return {
    repoRoot: "/r",
    userData: "/u",
    packaged: true,
    env: {},
    bins: { uv: "/opt/homebrew/bin/uv", docker: "/usr/local/bin/docker" },
    searchDirs: [],
    logFile: (id) => `/u/logs/${id}.log`,
  };
}

describe("parseComposeStatus", () => {
  it("reads a healthy container", () => {
    expect(parseComposeStatus(HEALTHY)).toEqual({ kind: "healthy" });
  });

  it("reads a starting container", () => {
    expect(parseComposeStatus(STARTING)).toEqual({ kind: "starting" });
  });

  it("treats an exited container as absent", () => {
    expect(parseComposeStatus(EXITED)).toEqual({ kind: "absent" });
  });

  it("treats empty output as absent", () => {
    expect(parseComposeStatus("")).toEqual({ kind: "absent" });
    expect(parseComposeStatus("\n  \n")).toEqual({ kind: "absent" });
  });

  it("accepts a JSON array as well as JSONL", () => {
    expect(parseComposeStatus(`[${HEALTHY}]`)).toEqual({ kind: "healthy" });
  });

  it("reports unreadable output instead of guessing", () => {
    expect(parseComposeStatus("not json at all").kind).toBe("unreadable");
  });
});

describe("postgresSpec", () => {
  const ok: () => Promise<{ stdout: string; stderr: string; code: number }> = async () => ({
    stdout: "",
    stderr: "",
    code: 0,
  });

  it("never restarts — compose owns that", () => {
    expect(postgresSpec(ok).restart).toBe("never");
  });

  it("keeps watching health after it is ready", () => {
    // 없으면 컨테이너가 내려가도 running/ok로 남는다 — P2-C11을 판정할 수 없다.
    expect(postgresSpec(ok).healthIntervalMs).toBeGreaterThan(0);
  });

  it("is a gate", () => {
    expect(postgresSpec(ok).gate).toBe(true);
  });

  it("reports the container as external when it is already healthy", async () => {
    const spec = postgresSpec(async () => ({ stdout: HEALTHY, stderr: "", code: 0 }));
    expect((await spec.detectExternal(ctx())).kind).toBe("adopt");
  });

  it("says absent when nothing is up yet", async () => {
    expect((await postgresSpec(ok).detectExternal(ctx())).kind).toBe("absent");
  });

  it("runs `up -d` on launch and never down/stop/rm", async () => {
    const calls: string[][] = [];
    const spec = postgresSpec(async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", code: 0 };
    });
    await spec.launch(ctx());
    expect(calls.some((a) => a.includes("up") && a.includes("-d"))).toBe(true);
    expect(calls.flat()).not.toContain("down");
    expect(calls.flat()).not.toContain("stop");
    expect(calls.flat()).not.toContain("rm");
  });

  it("points compose at the repo's own file", async () => {
    const calls: string[][] = [];
    const spec = postgresSpec(async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", code: 0 };
    });
    await spec.launch(ctx());
    expect(calls[0]).toContain("/r/be/docker-compose.yml");
  });

  it("reports the daemon being down as a failure that names the fix", async () => {
    // 2026-09-12 실측 문구(compose v5.5.0). 예전 Docker의 "Cannot connect to the Docker
    // daemon at …"도 같은 분기를 타야 한다.
    const spec = postgresSpec(async () => ({
      stdout: "",
      stderr:
        "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path " +
        "is correct and if the daemon is running: dial unix: connect: no such file or directory",
      code: 1,
    }));
    await expect(spec.launch(ctx())).rejects.toThrow(/Docker Desktop/);
  });

  it("also recognises the older Docker wording", async () => {
    const spec = postgresSpec(async () => ({
      stdout: "",
      stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
      code: 1,
    }));
    await expect(spec.launch(ctx())).rejects.toThrow(/Docker Desktop/);
  });

  it("stops nothing — the container outlives the app", async () => {
    const run = vi.fn(ok);
    const spec = postgresSpec(run);
    run.mockClear();
    expect(await spec.stop({ handle: null, owned: true }, { graceMs: 10 })).toEqual({
      stopped: true,
      leaked: [],
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("is ready only when healthy", async () => {
    const ready = postgresSpec(async () => ({ stdout: HEALTHY, stderr: "", code: 0 }));
    expect((await ready.readiness({ handle: null, owned: true }, ctx())).kind).toBe("ready");
    const starting = postgresSpec(async () => ({ stdout: STARTING, stderr: "", code: 0 }));
    expect((await starting.readiness({ handle: null, owned: true }, ctx())).kind).toBe("not-ready");
  });

  it("raises an unreadable status to failed, not not-ready", async () => {
    // not-ready로 두면 데몬이 꺼진 상태에서 유예가 다 찰 때까지 아무 설명도 안 보인다.
    const spec = postgresSpec(async () => ({ stdout: "garbage", stderr: "", code: 0 }));
    expect((await spec.readiness({ handle: null, owned: true }, ctx())).kind).toBe("failed");
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/postgres.test.ts`
Expected: FAIL — `Cannot find module '../src/services/postgres'`

- [ ] **Step 3: `postgres.ts`를 쓴다**

```ts
import * as path from "path";
import type { LaunchContext, LaunchResult, ReadinessResult, ServiceSpec } from "./types";

export type DockerRunner = (
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

export type ComposeState =
  | { kind: "healthy" }
  | { kind: "starting" }
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string };

/**
 * 데몬이 없을 때 docker CLI가 내는 문구. 2026-09-12 실측(compose v5.5.0):
 *   failed to connect to the docker API at unix://…; check if the path is correct and if the
 *   daemon is running: dial unix …: connect: no such file or directory   (exit 1, stdout 빈 문자열)
 * 예전 Docker는 "Cannot connect to the Docker daemon at …"를 냈으므로 둘 다 받는다.
 */
const DAEMON_DOWN =
  /cannot connect to the docker daemon|failed to connect to the docker api|daemon is running/i;
const DAEMON_FIX = "Docker Desktop이 실행 중이 아니에요. 실행한 뒤 다시 시도해 주세요.";

function composeFile(ctx: LaunchContext): string {
  return path.join(ctx.repoRoot, "be", "docker-compose.yml");
}

/**
 * compose는 버전에 따라 JSON 배열 하나를 주기도 하고 줄마다 객체를 주기도 한다. 둘 다 받는다 —
 * 형식 하나만 받으면 사람의 Docker Desktop 판올림이 준비 판정을 조용히 깨뜨린다.
 */
export function parseComposeStatus(stdout: string): ComposeState {
  const text = stdout.trim();
  if (text.length === 0) return { kind: "absent" };

  const rows: Array<Record<string, unknown>> = [];
  try {
    if (text.startsWith("[")) {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return { kind: "unreadable", detail: text.slice(0, 200) };
      rows.push(...(parsed as Array<Record<string, unknown>>));
    } else {
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (t.length > 0) rows.push(JSON.parse(t) as Record<string, unknown>);
      }
    }
  } catch {
    return { kind: "unreadable", detail: text.slice(0, 200) };
  }

  const row = rows.find((r) => r.Service === "postgres");
  if (row === undefined) return { kind: "absent" };
  if (String(row.State) !== "running") return { kind: "absent" };
  return String(row.Health ?? "") === "healthy" ? { kind: "healthy" } : { kind: "starting" };
}

export function postgresSpec(run: DockerRunner): ServiceSpec {
  const status = async (ctx: LaunchContext): Promise<ComposeState> => {
    const r = await run(["compose", "-f", composeFile(ctx), "ps", "-a", "--format", "json"]);
    if (r.code !== 0) {
      const detail = DAEMON_DOWN.test(r.stderr) ? DAEMON_FIX : r.stderr.trim().slice(0, 400);
      return { kind: "unreadable", detail };
    }
    return parseComposeStatus(r.stdout);
  };

  return {
    id: "postgres",
    dependsOn: [],
    gate: true,
    // 준비 뒤에도 이 주기로 다시 본다. 없으면 컨테이너가 내려가도 아무도 모르고 running/ok로
    // 남는다. docker compose ps는 서브프로세스 스폰이라 30초로 둔다 (스펙 §6.6, P2-C11).
    healthIntervalMs: 30_000,
    async detectExternal(ctx) {
      const s = await status(ctx);
      // 이미 떠 있으면 그게 정상이다. 우리가 띄웠든 사람이 띄웠든 컨테이너는 하나다.
      if (s.kind === "healthy") return { kind: "adopt", detail: "이미 실행 중인 컨테이너" };
      return { kind: "absent" };
    },
    async launch(ctx): Promise<LaunchResult> {
      // up -d만 부른다. down·stop·rm은 이 파일 어디에도 없다 — 앱은 컨테이너를 내리지 않는다.
      const r = await run(["compose", "-f", composeFile(ctx), "up", "-d"]);
      if (r.code !== 0) {
        throw new Error(DAEMON_DOWN.test(r.stderr) ? DAEMON_FIX : r.stderr.trim().slice(0, 400));
      }
      // 컨테이너는 Docker 데몬 소유다. 앱이 쥔 프로세스 핸들이 없으므로 null이고,
      // owned가 true여도 stop()이 아무것도 하지 않는다.
      return { handle: null, owned: true };
    },
    async readiness(_result, ctx): Promise<ReadinessResult> {
      const s = await status(ctx);
      if (s.kind === "healthy") return { kind: "ready" };
      // unreadable을 not-ready로 두면 데몬이 꺼진 상태에서 유예가 다 찰 때까지
      // 사용자가 아무 설명도 못 본다.
      if (s.kind === "unreadable") return { kind: "failed", detail: s.detail };
      return { kind: "not-ready" };
    },
    async stop() {
      // 의도적으로 아무것도 하지 않는다. compose의 restart: unless-stopped가 컨테이너를 소유하고,
      // 앱이 오기 전부터 떠 있던 컨테이너를 앱이 내리면 "외부 서비스를 구분해 관리"가 깨진다.
      return { stopped: true, leaked: [] };
    },
    // compose가 이미 재시작을 한다. 앱이 겹쳐 하면 두 감독자가 같은 컨테이너를 다툰다.
    restart: "never",
  };
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/postgres.test.ts`
Expected: PASS — 18 tests

- [ ] **Step 5: 실제 compose 출력으로 파서를 확인한다**

```bash
cd /Users/jason/projects/Damwha2
docker compose -f be/docker-compose.yml up -d && sleep 12
pnpm --filter damwha-desktop run compile
docker compose -f be/docker-compose.yml ps -a --format json > /tmp/compose-ps.json
node -e "
const {parseComposeStatus} = require('./desktop/dist/services/postgres.js');
console.log(parseComposeStatus(require('fs').readFileSync('/tmp/compose-ps.json','utf8')));
"
```

Expected: `{ kind: 'healthy' }`. `unreadable`이 나오면 **Task 1의 측정이 틀린 것**이므로 테스트
상수와 파서를 실제 출력으로 고치고 Step 1~4를 다시 돈다.

- [ ] **Step 6: 전체 테스트·타입 검사 후 커밋**

```bash
pnpm --filter damwha-desktop run test && pnpm --filter damwha-desktop run lint
git add desktop/src/services/postgres.ts desktop/tests/postgres.test.ts
git commit -F - <<'MSG'
feat(desktop): postgres 어댑터를 더한다 — up -d만 부르고 내리지 않는다

준비 판정은 compose가 이미 갖고 있는 pg_isready healthcheck를 읽는다. 새 검사를
만들지 않는다. 출력은 버전에 따라 JSON 배열이기도 JSONL이기도 해서 둘 다 받는다 —
하나만 받으면 Docker Desktop 판올림이 준비 판정을 조용히 깨뜨린다.

stop()은 의도적으로 비어 있다. compose의 restart: unless-stopped가 컨테이너를
소유하고, 앱이 오기 전부터 떠 있던 컨테이너를 앱이 내리면 "외부 서비스를 구분해
관리"가 깨진다. restart도 never다 — 감독자가 둘이면 같은 컨테이너를 다툰다.

Claude-Session: https://claude.ai/code/session_01CSsVbykTbEVYdxm5cLwsTV
MSG
```

**Verify:**
- `pnpm --filter damwha-desktop run test` → 전부 PASS.
- Step 5가 실제 `docker compose` 출력에서 `healthy`를 돌려줬다.
- `grep -nE '"(down|stop|rm)"' desktop/src/services/postgres.ts` → 0건.

**Review:**
- `down`·`stop`·`rm`이 파일 어디에도 없는가. 이것이 §5 데이터 안전 규칙의 코드 근거다.
- `stop()`이 비어 있는 이유가 주석에 있는가. 비어 있는 함수는 다음 사람이 "빠뜨렸다"고 읽는다.
- `ps -a`를 쓰는 것이 Task 1 Step 2의 측정과 맞는가. 측정이 "멈춘 컨테이너도 `ps`에 나온다"였다면
  `-a`는 불필요하고, 그 반대면 필수다. **측정과 구현이 일치하는가.**
- `unreadable`이 `failed`로 올라가는가.

---

## Task 6: api 어댑터와 마이그레이션 게이트

**Files:**
- Create: `desktop/src/services/api.ts`
- Modify: `desktop/src/stderr.ts` (원인 블록 추출 추가)
- Test: `desktop/tests/api-spec.test.ts`, `desktop/tests/stderr.test.ts` (확장)

**Interfaces:**
- Consumes: Phase 1의 `launchDev`/`launchPackaged`/`choosePort`/`isAddrInUse`/`probeHealth`, Task 3의 `types.ts`
- Produces:
  - `pendingMigrations(stderr: string): { count: number; names: string } | null`
  - `migrationCheckSkipped(stderr: string): boolean`
  - `apiSpec(deps: ApiDeps): ServiceSpec`
  - `failureBlock(stderr: string, maxLines?: number): string` (`stderr.ts`)

- [ ] **Step 1: 마이그레이션 판정과 원인 블록의 실패 테스트를 쓴다**

`desktop/tests/api-spec.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { apiSpec, migrationCheckSkipped, pendingMigrations } from "../src/services/api";

const WARN =
  "[Nest] 123  - 09/12/2026  WARN [DatabaseService] 3 pending migration(s): " +
  "022_x.sql, 023_y.sql, 024_z.sql — run `pnpm be:migrate`";

describe("pendingMigrations", () => {
  it("reads the count and the names from the API's own warning", () => {
    expect(pendingMigrations(WARN)).toEqual({
      count: 3,
      names: "022_x.sql, 023_y.sql, 024_z.sql",
    });
  });

  it("returns null when there is no such warning", () => {
    expect(pendingMigrations("[Nest] LOG listening on 127.0.0.1:3000")).toBeNull();
  });

  it("reads a single pending migration", () => {
    expect(
      pendingMigrations("WARN 1 pending migration(s): 024_z.sql — run `pnpm be:migrate`"),
    ).toEqual({ count: 1, names: "024_z.sql" });
  });

  it("survives ANSI colour from the Nest logger", () => {
    expect(pendingMigrations(`\x1b[33m${WARN}\x1b[39m`)?.count).toBe(3);
  });
});

describe("apiSpec shape", () => {
  it("keeps watching health after it is ready", () => {
    // 부팅 뒤 DB가 끊기면 API는 죽지 않고 503을 준다. 주기적 재확인이 없으면 그 전환을
    // 아무도 관찰하지 못해 running/ok로 영원히 남는다 — P2-C11을 판정할 수 없다.
    const spec = apiSpec({
      verifyOwnListener: async () => true,
      isPortOccupied: async () => false,
      onPendingMigrations: () => undefined,
      onMigrationCheckSkipped: () => undefined,
    });
    expect(spec.healthIntervalMs).toBeGreaterThan(0);
  });
});

describe("migrationCheckSkipped", () => {
  it("detects the advisory skip", () => {
    // 검사가 돌지 않았다는 것과 통과했다는 것은 다른 사실이다 (스펙 §6.7).
    expect(migrationCheckSkipped("WARN pending migration check skipped: ENOENT")).toBe(true);
  });

  it("is false for a normal boot", () => {
    expect(migrationCheckSkipped("LOG listening on 127.0.0.1:3000")).toBe(false);
  });
});
```

`desktop/tests/stderr.test.ts` 끝에 추가 (기존 import 줄에 `failureBlock`을 넣는다):

```ts
describe("failureBlock", () => {
  it("keeps every line of a multi-line cause", () => {
    // Phase 1의 lastMeaningfulLine은 한 줄만 골라 zod 원인이 `startup failed: [`까지만 보였다.
    const stderr = [
      "[Nest] LOG starting",
      "startup failed: [",
      '  { "path": ["SUMMARY_LLM_MODEL"], "message": "Invalid input" }',
      "]",
    ].join("\n");
    const block = failureBlock(stderr);
    expect(block).toContain("startup failed:");
    expect(block).toContain("SUMMARY_LLM_MODEL");
    expect(block.endsWith("]")).toBe(true);
  });

  it("falls back to the last meaningful line when there is no startup failure", () => {
    expect(failureBlock("[Nest] LOG a\nsomething broke")).toBe("something broke");
  });

  it("caps the block so a runaway stderr cannot fill the screen", () => {
    const stderr = [
      "startup failed: [",
      ...Array.from({ length: 200 }, (_, i) => `  line ${i}`),
    ].join("\n");
    expect(failureBlock(stderr, 10).split("\n")).toHaveLength(10);
  });

  it("strips ANSI from the whole block", () => {
    expect(failureBlock("\x1b[31mstartup failed: nope\x1b[39m")).toBe("startup failed: nope");
  });

  it("returns an empty string for empty input", () => {
    expect(failureBlock("")).toBe("");
    expect(failureBlock("   \n  ")).toBe("");
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/api-spec.test.ts tests/stderr.test.ts`
Expected: FAIL — `api` 모듈 없음, `failureBlock is not a function`

- [ ] **Step 3: `stderr.ts`에 `failureBlock`을 더한다**

기존 `lastMeaningfulLine`·`ANSI_SGR`은 **그대로 두고** 아래를 추가한다. 기존 호출부를 깨지 않는다.

```ts
/** 원인 블록의 기본 상한. 화면이 감당할 수 있는 줄 수이고, 전문은 로그 파일에 있다. */
const BLOCK_LIMIT = 24;

/**
 * `startup failed:`부터 끝까지를 블록으로 돌려준다.
 *
 * lastMeaningfulLine은 한 줄만 고르므로 zod 검증 실패처럼 여러 줄인 원인이 화면에
 * `startup failed: [`까지만 보였다(Phase 1 결과의 남은 한계). 원인 문장은 로그에만 있었다.
 * 그 줄부터 끝까지를 상한 안에서 그대로 올린다.
 */
export function failureBlock(stderr: string, maxLines: number = BLOCK_LIMIT): string {
  const lines = stderr
    .replace(ANSI_SGR, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes("startup failed:")) {
      start = i;
      break;
    }
  }
  if (start < 0) return lastMeaningfulLine(stderr);
  return lines.slice(start, start + maxLines).join("\n");
}
```

- [ ] **Step 4: `api.ts`를 쓴다**

```ts
import * as path from "path";
import { launchDev, launchPackaged } from "../api-process";
import { MAX_PORT_ATTEMPTS, choosePort, isAddrInUse } from "../port";
import { probeHealth } from "../readiness";
import { ANSI_SGR, failureBlock } from "../stderr";
import type { LaunchContext, LaunchResult, ReadinessResult, ServiceSpec } from "./types";

/**
 * be/src/database/database.service.ts:44-53이 찍는 줄. 앱이 pg 클라이언트를 갖지 않고
 * 미적용 마이그레이션을 아는 유일한 길이다 — 의존을 더하면 desktop의 dependencies가 비지 않아
 * 번들 위생 기준이 깨진다 (스펙 §6.7).
 */
const PENDING = /(\d+)\s+pending migration\(s\):\s*([^\n]*?)\s*—\s*run/;
const SKIPPED = /pending migration check skipped/;

export function pendingMigrations(stderr: string): { count: number; names: string } | null {
  const m = PENDING.exec(stderr.replace(ANSI_SGR, ""));
  return m === null ? null : { count: Number(m[1]), names: m[2] };
}

export function migrationCheckSkipped(stderr: string): boolean {
  return SKIPPED.test(stderr.replace(ANSI_SGR, ""));
}

export interface ApiDeps {
  /** Phase 1의 소유 증명. main.ts가 그대로 넘긴다. */
  verifyOwnListener(port: number, pid: number | undefined): Promise<boolean>;
  isPortOccupied(port: number): Promise<boolean>;
  onPendingMigrations(info: { count: number; names: string }): void;
  onMigrationCheckSkipped(): void;
}

export function apiSpec(deps: ApiDeps): ServiceSpec {
  let port = 0;
  let origin: string | null = null;

  return {
    id: "api",
    dependsOn: ["postgres"],
    gate: true,
    // 부팅 뒤 DB가 끊기면 API는 죽지 않고 503을 준다. 그 전환을 관찰하는 유일한 수단이
    // 이 주기적 재확인이다 — 없으면 running/ok로 영원히 남는다 (스펙 §6.6, P2-C11).
    // /api/health 한 번이라 값싸다.
    healthIntervalMs: 10_000,
    async detectExternal() {
      // 외부 API는 채택 대상도 비기동 대상도 아니다 — launch()가 포트를 옮긴다 (Phase 1 §6.4).
      return { kind: "absent" };
    },
    async launch(ctx): Promise<LaunchResult> {
      const requested = Number(ctx.env.PORT ?? "3000");
      const base =
        Number.isInteger(requested) && requested >= 1 && requested <= 65535 ? requested : 3000;

      for (let i = 0; i < MAX_PORT_ATTEMPTS; i += 1) {
        const candidate = await choosePort(base, i);
        // 메커니즘 (a): 스폰 전 사전 점검 (Phase 1 §6.4).
        if (await deps.isPortOccupied(candidate)) continue;

        const root = ctx.packaged ? path.join(process.resourcesPath, "api") : ctx.repoRoot;
        const handle = (ctx.packaged ? launchPackaged : launchDev)({
          entry: path.join(root, "dist", "main.js"),
          cwd: root,
          env: { ...ctx.env, PORT: String(candidate) },
          logFile: ctx.logFile("api"),
        });
        port = candidate;
        origin = `http://127.0.0.1:${candidate}`;
        return { handle, owned: true, origin };
      }
      throw new Error(`${MAX_PORT_ATTEMPTS}번 시도했지만 쓸 수 있는 포트를 찾지 못했어요.`);
    },
    async readiness(result): Promise<ReadinessResult> {
      const handle = result.handle;
      if (handle === null || origin === null) return { kind: "failed", detail: "핸들이 없어요." };

      const tail = handle.stderrTail();
      if (isAddrInUse(tail)) return { kind: "failed", detail: "포트가 이미 쓰이고 있어요." };

      const probe = await probeHealth(origin);
      if (probe === "ready") {
        // 메커니즘 (b): 200을 받아도 그 리스너가 우리 자식인지 증명한다 (Phase 1 §6.4).
        if (!(await deps.verifyOwnListener(port, handle.pid))) return { kind: "not-ready" };

        // 게이트는 health 200 뒤에만 본다. 이보다 이르면 경고가 아직 stderr에 없어
        // 게이트가 매번 통과한다.
        const pending = pendingMigrations(tail);
        if (pending !== null) {
          deps.onPendingMigrations(pending);
          return {
            kind: "failed",
            detail:
              `적용되지 않은 마이그레이션이 ${pending.count}개 있어요 (${pending.names}).\n` +
              "터미널에서 `pnpm be:migrate`를 실행한 뒤 다시 시도해 주세요.",
          };
        }
        if (migrationCheckSkipped(tail)) deps.onMigrationCheckSkipped();
        return { kind: "ready" };
      }
      if (probe === "db-unreachable") {
        // 부팅 뒤 DB가 끊긴 경우다. 프로세스는 살아 있으므로 degraded이지 failed가 아니다 —
        // failed면 재시작 정책이 발화해 백오프만 태운다 (스펙 §6.6).
        return {
          kind: "degraded",
          detail: "데이터베이스에 연결할 수 없어요. DB가 뜨면 자동으로 복구됩니다.",
        };
      }
      if (!handle.alive() || /database unreachable/.test(tail)) {
        return { kind: "failed", detail: failureBlock(tail) };
      }
      return { kind: "not-ready" };
    },
    async stop(result, plan) {
      const handle = result.handle;
      if (handle === null) return { stopped: true, leaked: [] };
      await handle.stop(plan.graceMs);
      const leaked = handle.alive() && handle.pid !== undefined ? [handle.pid] : [];
      return { stopped: leaked.length === 0, leaked };
    },
    restart: { maxAttempts: 3, backoffMs: [3_000, 8_000, 20_000] },
  };
}
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/api-spec.test.ts tests/stderr.test.ts`
Expected: PASS — api-spec 7 tests, stderr 기존 + 5 tests

- [ ] **Step 6: 실제 API의 경고 문구를 1회 대조한다**

```bash
cd /Users/jason/projects/Damwha2
docker compose -f be/docker-compose.yml up -d && sleep 10
docker compose -f be/docker-compose.yml exec -T postgres \
  psql -U postgres -d postgres -c "CREATE DATABASE damwha_migration_gate;"
pnpm be:build
DATABASE_URL="postgres://postgres:postgres@localhost:5432/damwha_migration_gate" \
  pnpm be:start 2>&1 | head -40 | grep -i "pending migration" || echo "경고 문구 없음"
```

찾은 줄을 `PENDING` 정규식과 대조한다. 특히 **`—`가 em dash인지 하이픈인지** 확인한다. 다르면
테스트 상수와 정규식을 실제 출력으로 고치고 Step 1~5를 다시 돈다. 확인 후 정리한다:

```bash
docker compose -f be/docker-compose.yml exec -T postgres \
  psql -U postgres -d postgres -c "DROP DATABASE damwha_migration_gate;"
docker compose -f be/docker-compose.yml exec -T postgres psql -U postgres -l | grep damwha
```

`damwha`만 남고 `damwha_migration_gate`가 없어야 한다.

- [ ] **Step 7: 전체 테스트·타입 검사 후 커밋**

```bash
pnpm --filter damwha-desktop run test && pnpm --filter damwha-desktop run lint
git add desktop/src/services/api.ts desktop/src/stderr.ts desktop/tests/api-spec.test.ts desktop/tests/stderr.test.ts
git commit -F - <<'MSG'
feat(desktop): api 어댑터와 마이그레이션 게이트를 더한다

앱이 docker compose를 띄우는 순간 "빈 볼륨" 경로가 열린다. API는 미적용
마이그레이션을 경고만 하고 뜨므로, 그대로 두면 화면은 정상인데 첫 회의 생성이
relation does not exist로 죽고 worker는 peek 오류 재접속 루프에 들어간다.

판정은 API 자신의 기동 로그로 한다. main에 pg 클라이언트를 넣으면 desktop의
dependencies가 비지 않아 번들 위생 기준이 깨진다. 검사가 건너뛰어진 경우
(pending migration check skipped)는 통과와 구분해 따로 알린다.

부팅 뒤 DB 끊김은 degraded이지 failed가 아니다. API는 죽지 않고 503을 주므로
failed로 두면 재시작 정책이 발화해 백오프만 태운다.

failureBlock을 더해 여러 줄 원인을 다 보여준다. lastMeaningfulLine은 한 줄만
골라 zod 원인이 화면에 `startup failed: [`까지만 나왔다.

Claude-Session: https://claude.ai/code/session_01CSsVbykTbEVYdxm5cLwsTV
MSG
```

**Verify:**
- `pnpm --filter damwha-desktop run test` → 전부 PASS.
- Step 6에서 실제 경고 문구가 `PENDING` 정규식에 잡혔다 (또는 정규식을 실측에 맞게 고쳤다).
- `psql -l`에 `damwha_migration_gate`가 없고 `damwha`가 있다.

**Review:**
- 마이그레이션 게이트가 **health 200 뒤에** 판정하는가. 그보다 이르면 경고가 아직 stderr에 없어
  게이트가 매번 통과한다.
- `db-unreachable`이 `degraded`로 가고 `failed`로 가지 않는가.
- 소유 증명(`verifyOwnListener`)이 health 200 **뒤에** 걸리는가. Phase 1 §6.4의 계약이다.
- `failureBlock`이 `lastMeaningfulLine`을 **대체하지 않고 더하는가.** 기존 호출부가 깨지면 안 된다.
- `api.ts`가 `desktop/package.json`에 새 의존을 요구하지 않는가.

---

## Task 7: worker의 ready 로그 — 제품 코드 변경 1

이 Task만 Python을 건드린다. 스펙 §10의 첫 변경이다.

**Files:**
- Modify: `be/worker/damwha_worker/__main__.py` (`run_supervisor`, 2군데)
- Test: `be/worker/tests/test_supervisor.py` (2건 추가)

**Interfaces:**
- Consumes: 없음
- Produces: stderr에 찍히는 문구 `supervisor <worker_id> ready (db connected)` — Task 8의
  worker 어댑터가 이것을 준비 신호로 쓴다.

- [ ] **Step 1: 왜 기존 줄을 못 쓰는지 직접 확인한다**

```bash
cd /Users/jason/projects/Damwha2
DATABASE_URL="postgres://nobody:nobody@127.0.0.1:59999/nope" \
  LENS_LLM_BASE_URL="http://127.0.0.1:8000/v1" \
  timeout 12 uv run --directory be/worker python -m damwha_worker 2>&1 | head -20
```

Expected: `supervisor worker-1 started`가 **먼저 찍히고** 그 뒤로 `reconnect failed — retry in …`이
반복된다. 이 출력이 P2-C10의 근거이자 이 Task의 이유다. 출력을 그대로 결과 문서에 남긴다.

- [ ] **Step 2: 실패 테스트 2건을 쓴다**

`be/worker/tests/test_supervisor.py` 끝에 추가한다. 파일 맨 위 import에 `import logging`을 더한다.

```python
def test_supervisor_logs_ready_after_db_connect(conn, pg_url, caplog):
    # 기존 `supervisor <id> started`는 run_supervisor 호출 **전**에 찍히므로
    # (__main__.py:296 → :298 → :107) 준비 신호로 쓸 수 없다. DB에 실제로 붙은 뒤
    # 찍히는 줄이 데스크톱 앱의 준비 계약이다.
    caplog.set_level(logging.INFO, logger="damwha_worker")
    shutdown = threading.Event()
    t = threading.Timer(0.05, shutdown.set)
    t.start()
    run_supervisor(
        _peek_settings(),
        shutdown,
        connect_fn=lambda: db.connect(pg_url),
        spawn_fn=lambda: _StubProc(0),
        child_holder={"proc": None, "count": 0},
    )
    t.cancel()
    assert any("ready (db connected)" in r.message % r.args if r.args else "ready (db connected)" in r.message
               for r in caplog.records)


def test_supervisor_logs_ready_again_after_reconnect(conn, pg_url, monkeypatch, caplog):
    # 한 번만 찍으면 ready는 판정되지만 degraded에서 ok로 돌아온 것을 관찰할 수 없다
    # (스펙 §6.6). peek 예외 → 재접속 경로에서도 같은 줄이 나와야 한다.
    caplog.set_level(logging.INFO, logger="damwha_worker")
    peek_calls = {"count": 0}
    real_peek = db.peek_queued

    def _flaky_peek(c):
        peek_calls["count"] += 1
        if peek_calls["count"] == 1:
            raise RuntimeError("simulated db blip")
        return real_peek(c)

    monkeypatch.setattr(db, "peek_queued", _flaky_peek)

    shutdown = threading.Event()
    monkeypatch.setattr(shutdown, "wait", lambda t: (shutdown.set(), True)[1])

    run_supervisor(
        _peek_settings(),
        shutdown,
        connect_fn=lambda: db.connect(pg_url),
        spawn_fn=lambda: _StubProc(0),
        child_holder={"proc": None, "count": 0},
    )

    ready_lines = [r for r in caplog.records if "ready (db connected)" in r.getMessage()]
    assert len(ready_lines) == 2  # 최초 접속 + peek 예외 후 재접속
```

- [ ] **Step 3: 테스트가 실패하는지 확인한다**

Run: `pnpm worker:test -- -k "logs_ready"`
Expected: FAIL — 두 건 모두 `assert` 실패 (그 줄이 아직 없다)

- [ ] **Step 4: `__main__.py`의 `run_supervisor`를 고친다**

`:107` 부근 (첫 접속):

```python
    conn = _reconnect(connect_fn, shutdown)
    if conn is None:
        return
    # 데스크톱 앱의 준비 계약. `supervisor <id> started`는 이 함수를 부르기 **전**에 찍히므로
    # 잘못된 DATABASE_URL이면 그 줄만 남고 여기 백오프 루프에 무기한 머문다 — 화면은
    # "준비됨"인데 큐는 영원히 안 돈다. 이 줄만이 "실제로 붙었다"를 뜻한다.
    log.info("supervisor %s ready (db connected)", settings.worker_id)
    consecutive_failures = 0
```

`:120` 부근 (peek 오류 뒤 재접속):

```python
            conn = _reconnect(connect_fn, shutdown)
            if conn is None:
                return
            # 재접속에서도 같은 줄을 찍는다. 한 번만 찍으면 degraded에서 ok로 돌아온 것을
            # 앱이 관찰할 수 없다 (스펙 §6.6).
            log.info("supervisor %s ready (db connected)", settings.worker_id)
            consecutive_failures = 0  # DB 재접속은 자식 크래시가 아니다
            continue
```

기존 `log.info("supervisor %s started", ...)`(`:296`)는 **지우지 않는다.** "프로세스가 떴다"의
신호로 여전히 쓸모가 있고, 지우면 기존 로그를 읽던 사람의 기대가 깨진다.

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `pnpm worker:test -- -k "logs_ready"`
Expected: PASS — 2 tests

- [ ] **Step 6: worker 전체 테스트와 lint**

```bash
pnpm worker:test
uv run --directory be/worker ruff check .
uv run --directory be/worker ruff format --check .
```

Expected: 전부 PASS. 기존 supervisor 테스트 8건이 그대로 통과한다.

- [ ] **Step 7: Step 1을 다시 돌려 새 줄이 안 나오는지 확인한다**

```bash
cd /Users/jason/projects/Damwha2
DATABASE_URL="postgres://nobody:nobody@127.0.0.1:59999/nope" \
  LENS_LLM_BASE_URL="http://127.0.0.1:8000/v1" \
  timeout 12 uv run --directory be/worker python -m damwha_worker 2>&1 | grep -c "ready (db connected)"
```

Expected: `0` — DB에 못 붙으면 그 줄이 안 나온다. 이것이 P2-C10의 코드 근거다.

정상 DB에서는 나와야 한다:

```bash
docker compose -f be/docker-compose.yml up -d && sleep 8
timeout 15 pnpm worker 2>&1 | grep -c "ready (db connected)"
```

Expected: `1` 이상.

- [ ] **Step 8: 커밋**

```bash
git add be/worker/damwha_worker/__main__.py be/worker/tests/test_supervisor.py
git commit -F - <<'MSG'
feat(worker): DB 연결 뒤에 ready 로그를 찍는다

기존 `supervisor <id> started`는 run_supervisor를 부르기 전에 찍힌다
(__main__.py:296 → :298 → :107). 잘못된 DATABASE_URL이면 그 줄만 남고
_reconnect 백오프 루프에 무기한 머문다 — 그것을 준비 신호로 쓰면 화면은
"준비됨"인데 큐는 영원히 안 돈다. 데스크톱 앱이 그 줄을 쓸 예정이라 실제로
붙은 시점을 뜻하는 줄을 더한다.

첫 접속만이 아니라 재접속에서도 찍는다. 한 번만 찍으면 ready는 판정되지만
degraded에서 ok로 돌아온 것을 앱이 관찰할 수 없다.

문구가 데스크톱의 계약이 되므로 테스트로 고정한다 — 리팩터링이 조용히
깨뜨리면 앱의 준비 판정이 영원히 오지 않는다.

Claude-Session: https://claude.ai/code/session_01CSsVbykTbEVYdxm5cLwsTV
MSG
```

**Verify:**
- `pnpm worker:test` → 전부 PASS (기존 + 신규 2).
- `ruff check`·`ruff format --check` → 통과.
- Step 7의 두 측정: 잘못된 DB에서 `0`, 정상 DB에서 `1` 이상.
- `git show --stat HEAD` → 2파일, 둘 다 `be/worker/` 아래. **desktop은 건드리지 않았다.**

**Review:**
- 기존 `supervisor %s started` 줄이 **그대로 남아 있는가.**
- 재접속 경로에도 줄이 들어갔는가. 첫 접속에만 넣으면 §6.6의 회복 관찰이 불가능하다.
- `consecutive_failures = 0`이 원래 자리를 지키는가 — 재접속이 자식 크래시 카운터를 리셋하는
  기존 동작을 바꾸지 않았는가.
- 테스트가 **문구 자체**를 검사하는가. 호출 횟수만 세면 문구가 바뀌어도 통과한다.
- worker의 다른 계약(job 큐, reaper, 라이브)을 건드리지 않았는가: `git diff HEAD~1 -- be/worker`가
  `run_supervisor`의 두 군데와 테스트뿐인가.

---

## Task 8: worker·embed 어댑터

**Files:**
- Create: `desktop/src/services/worker.ts`
- Create: `desktop/src/services/embed.ts`
- Test: `desktop/tests/worker-spec.test.ts`, `desktop/tests/embed-spec.test.ts`

**Interfaces:**
- Consumes: Task 2의 `resolve.ts`, Task 3의 `types.ts`, Task 4의 `external.ts`, Task 7의 ready 문구
- Produces:
  - `workerReady(stderr: string): boolean`
  - `workerDegraded(stderr: string): boolean`
  - `workerSpec(deps: WorkerDeps): ServiceSpec`
  - `embedSpec(deps: EmbedDeps): ServiceSpec`

- [ ] **Step 1: worker 어댑터의 실패 테스트를 쓴다**

`desktop/tests/worker-spec.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { workerDegraded, workerReady, workerSpec } from "../src/services/worker";
import type { LaunchContext, ServiceHandle } from "../src/services/types";

const READY = "INFO supervisor desktop-7 ready (db connected)";
const STARTED = "INFO supervisor desktop-7 started";
const RECONNECT_FAILED = "WARNING reconnect failed — retry in 2s";

function ctx(over: Partial<LaunchContext> = {}): LaunchContext {
  return {
    repoRoot: "/r",
    userData: "/u",
    packaged: true,
    env: { DATABASE_URL: "postgres://x", STORAGE_ROOT: "/u/storage" },
    bins: { uv: "/opt/homebrew/bin/uv", docker: "/usr/local/bin/docker" },
    searchDirs: ["/opt/homebrew/bin"],
    logFile: (id) => `/u/logs/${id}.log`,
    ...over,
  };
}

function handle(tail: string, alive = true): ServiceHandle {
  return {
    pid: 4242,
    alive: () => alive,
    stderrTail: () => tail,
    exitCode: () => (alive ? null : 1),
    onExit: () => undefined,
    stop: async () => undefined,
  } as unknown as ServiceHandle;
}

describe("workerReady", () => {
  it("is false for the pre-connect line", () => {
    // __main__.py:296은 DB에 붙기 전에 찍힌다. 이 줄을 준비로 읽으면 화면은
    // "준비됨"인데 큐는 영원히 안 돈다.
    expect(workerReady(STARTED)).toBe(false);
  });

  it("is true once the post-connect line appears", () => {
    expect(workerReady(`${STARTED}\n${READY}`)).toBe(true);
  });

  it("survives a worker id with dashes and digits", () => {
    expect(workerReady("INFO supervisor desktop-1757600000-99 ready (db connected)")).toBe(true);
  });
});

describe("workerDegraded", () => {
  it("is true when a reconnect failure follows the last ready line", () => {
    expect(workerDegraded(`${READY}\n${RECONNECT_FAILED}`)).toBe(true);
  });

  it("is false when a ready line follows the failure — that is recovery", () => {
    expect(workerDegraded(`${READY}\n${RECONNECT_FAILED}\n${READY}`)).toBe(false);
  });

  it("is false before the first ready line", () => {
    expect(workerDegraded(`${STARTED}\n${RECONNECT_FAILED}`)).toBe(false);
  });
});

describe("workerSpec", () => {
  const deps = (over = {}) => ({
    listExternal: async () => [] as number[],
    ...over,
  });

  it("depends on postgres and is not a gate", () => {
    const spec = workerSpec(deps() as never);
    expect(spec.dependsOn).toContain("postgres");
    expect(spec.gate).toBe(false);
  });

  it("stands down when an external supervisor is running", async () => {
    const spec = workerSpec(deps({ listExternal: async () => [4101] }) as never);
    const ext = await spec.detectExternal(ctx());
    expect(ext.kind).toBe("stand-down");
    // env를 읽을 수 없으므로(ps eww는 SIP가 막는다) 채택을 증명할 수 없다 — 경고한다.
    expect(ext.kind === "stand-down" && ext.detail).toMatch(/STORAGE_ROOT/);
  });

  it("launches when nothing external is running", async () => {
    expect((await workerSpec(deps() as never).detectExternal(ctx())).kind).toBe("absent");
  });

  it("refuses to launch without uv and names the fix", async () => {
    const spec = workerSpec(deps() as never);
    await expect(spec.launch(ctx({ bins: { uv: null, docker: null } }))).rejects.toThrow(/uv/);
  });

  it("refuses to launch when the worker .env is missing", async () => {
    // be/.gitignore:7이 be/worker/.env를 무시하므로 새 체크아웃에는 없다. 없으면
    // LENS_LLM_BASE_URL이 비어 worker가 로그 한 줄 전에 죽는다 (config.py:34-39).
    const spec = workerSpec(deps({ exists: () => false }) as never);
    await expect(spec.launch(ctx())).rejects.toThrow(/\.env/);
  });

  it("reads ready from stderr, not from the process being alive", async () => {
    const spec = workerSpec(deps() as never);
    const notYet = await spec.readiness({ handle: handle(STARTED), owned: true }, ctx());
    expect(notYet.kind).toBe("not-ready");
    const yes = await spec.readiness({ handle: handle(`${STARTED}\n${READY}`), owned: true }, ctx());
    expect(yes.kind).toBe("ready");
  });

  it("reports degraded when the DB drops after ready", async () => {
    const spec = workerSpec(deps() as never);
    const r = await spec.readiness(
      { handle: handle(`${READY}\n${RECONNECT_FAILED}`), owned: true },
      ctx(),
    );
    expect(r.kind).toBe("degraded");
  });

  it("keeps watching health after it is ready", () => {
    // worker도 ready 뒤 DB가 끊기면 _reconnect 루프에 들어가 프로세스는 살고 큐만 멈춘다.
    // stderr 꼬리를 읽을 뿐이라 주기가 짧아도 값싸다.
    expect(workerSpec(deps() as never).healthIntervalMs).toBeGreaterThan(0);
  });

  it("reports failed when the process died", async () => {
    const spec = workerSpec(deps() as never);
    const r = await spec.readiness({ handle: handle("boom", false), owned: true }, ctx());
    expect(r.kind).toBe("failed");
  });
});
```

- [ ] **Step 2: embed 어댑터의 실패 테스트를 쓴다**

`desktop/tests/embed-spec.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { embedSpec } from "../src/services/embed";
import type { LaunchContext } from "../src/services/types";

function ctx(env: Record<string, string> = {}): LaunchContext {
  return {
    repoRoot: "/r",
    userData: "/u",
    packaged: true,
    env: { EMBED_SERVICE_HOST: "127.0.0.1", EMBED_SERVICE_PORT: "8100", ...env },
    bins: { uv: "/opt/homebrew/bin/uv", docker: null },
    searchDirs: [],
    logFile: (id) => `/u/logs/${id}.log`,
  };
}

describe("embedSpec.prepare", () => {
  it("derives the API's URL and the service's bind port from one value", async () => {
    // API는 EMBED_SERVICE_URL을, worker/embed는 HOST/PORT를 읽는다. 두 값을 따로
    // 관리하면 어긋나고, 어긋난 결과는 오류가 아니라 조용한 degrade다 (스펙 §6.4).
    const spec = embedSpec({ probe: async () => ({ kind: "absent" }), freePort: async () => 8100 });
    const env = await spec.prepare!(ctx());
    expect(env.EMBED_SERVICE_PORT).toBe("8100");
    expect(env.EMBED_SERVICE_URL).toBe("http://127.0.0.1:8100");
  });

  it("moves to a free port when something incompatible holds the default", async () => {
    const spec = embedSpec({
      probe: async () => ({ kind: "mismatch", detail: "모델 other/model" }),
      freePort: async () => 51234,
    });
    const env = await spec.prepare!(ctx());
    expect(env.EMBED_SERVICE_PORT).toBe("51234");
    expect(env.EMBED_SERVICE_URL).toBe("http://127.0.0.1:51234");
  });

  it("keeps the default port when a matching service already answers", async () => {
    const spec = embedSpec({ probe: async () => ({ kind: "match" }), freePort: async () => 51234 });
    const env = await spec.prepare!(ctx());
    expect(env.EMBED_SERVICE_PORT).toBe("8100");
  });
});

describe("embedSpec.detectExternal", () => {
  it("adopts a matching service", async () => {
    const spec = embedSpec({ probe: async () => ({ kind: "match" }), freePort: async () => 51234 });
    await spec.prepare!(ctx());
    expect((await spec.detectExternal(ctx())).kind).toBe("adopt");
  });

  it("does not adopt a mismatching service", async () => {
    const spec = embedSpec({
      probe: async () => ({ kind: "mismatch", detail: "모델 other/model" }),
      freePort: async () => 51234,
    });
    await spec.prepare!(ctx());
    expect((await spec.detectExternal(ctx())).kind).toBe("absent");
  });
});

describe("embedSpec shape", () => {
  it("is not a gate and does not depend on postgres", async () => {
    const spec = embedSpec({ probe: async () => ({ kind: "absent" }), freePort: async () => 8100 });
    expect(spec.gate).toBe(false);
    expect(spec.dependsOn).toEqual([]);
  });

  it("keeps watching health after it is ready", () => {
    // 채택한 외부 embed가 내려가는 것도 이 경로로만 알아챈다.
    const spec = embedSpec({ probe: async () => ({ kind: "absent" }), freePort: async () => 8100 });
    expect(spec.healthIntervalMs).toBeGreaterThan(0);
  });

  it("allows far more than the default readiness window", () => {
    // 2026-09-12 실측 31초(따뜻한 캐시). 기본 60초는 캐시가 식으면 부족하다.
    const spec = embedSpec({ probe: async () => ({ kind: "absent" }), freePort: async () => 8100 });
    expect(spec.readyTimeoutMs).toBeGreaterThanOrEqual(120_000);
  });

  it("refuses to launch without uv", async () => {
    const spec = embedSpec({ probe: async () => ({ kind: "absent" }), freePort: async () => 8100 });
    await expect(
      spec.launch({ ...ctx(), bins: { uv: null, docker: null } }),
    ).rejects.toThrow(/uv/);
  });
});
```

- [ ] **Step 3: 두 테스트가 실패하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/worker-spec.test.ts tests/embed-spec.test.ts`
Expected: FAIL — 두 모듈 모두 없음

- [ ] **Step 4: 두 어댑터가 공유할 실행 헬퍼를 `worker.ts`에 쓴다**

```ts
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { buildChildPath } from "./resolve";
import type { LaunchContext, LaunchResult, ReadinessResult, ServiceSpec } from "./types";

/** Task 7이 __main__.py에 넣은 줄. DB에 실제로 붙은 뒤에만 나온다. */
const READY = /supervisor \S+ ready \(db connected\)/g;
/** __main__.py:173의 백오프 경고. */
const RECONNECT_FAILED = /reconnect failed/g;

function lastIndexOfMatch(text: string, re: RegExp): number {
  let last = -1;
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m.index;
  return last;
}

export function workerReady(stderr: string): boolean {
  return lastIndexOfMatch(stderr, READY) >= 0;
}

/**
 * ready 줄보다 **뒤에** reconnect 실패가 있으면 degraded다. 그 뒤에 ready가 또 나오면 회복이다 —
 * Task 7이 재접속에서도 같은 줄을 찍게 한 이유가 이것이다 (스펙 §6.6).
 */
export function workerDegraded(stderr: string): boolean {
  const ready = lastIndexOfMatch(stderr, READY);
  if (ready < 0) return false;
  return lastIndexOfMatch(stderr, RECONNECT_FAILED) > ready;
}

export interface UvLaunchOptions {
  ctx: LaunchContext;
  args: readonly string[];
  logId: "worker" | "embed";
  extraEnv?: Record<string, string>;
}

/**
 * uv를 절대 경로로 부르고, 탐색 목록을 자식 PATH 앞에 붙인다. 두 번째가 없으면 worker 안의
 * shutil.which("mlx_lm.server")와 pipeline/ffmpeg.py:24,59의 리터럴 호출이 실패한다 (스펙 §6.3).
 */
export function launchWithUv(options: UvLaunchOptions): LaunchResult {
  const { ctx, args, logId } = options;
  if (ctx.bins.uv === null) {
    throw new Error(
      "uv를 찾지 못했어요. 설치하거나 config.json의 UV_BIN에 경로를 적어 주세요.",
    );
  }
  const workerDir = path.join(ctx.repoRoot, "be", "worker");
  const logFile = ctx.logFile(logId);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.createWriteStream(logFile, { flags: "a" });
  // 로그를 못 쓰는 것은 앱이 죽을 이유가 아니다 (Phase 1의 makeSink와 같은 규칙).
  out.on("error", () => undefined);

  const child = spawn(ctx.bins.uv, ["run", "--directory", workerDir, ...args], {
    cwd: workerDir,
    stdio: ["ignore", "pipe", "pipe"],
    // detached가 없으면 자식이 부모 그룹에 들어가 process.kill(-pid)가 그룹을 못 찾는다.
    detached: true,
    env: {
      ...process.env,
      ...ctx.env,
      ...options.extraEnv,
      PATH: buildChildPath(ctx.searchDirs, process.env.PATH),
    },
  });

  let tail = "";
  let code: number | null = null;
  const listeners: Array<(c: number) => void> = [];
  const settle = (c: number) => {
    if (code !== null) return;
    code = c;
    out.end();
    for (const l of listeners) {
      try {
        l(c);
      } catch {
        // 알릴 곳이 없다. 자식은 이미 죽었다.
      }
    }
  };
  const append = (b: Buffer) => {
    const text = b.toString();
    out.write(text);
    tail = (tail + text).slice(-32_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("exit", (c) => settle(c ?? 0));
  // spawn 실패는 'exit'가 아니라 'error'로 온다. 리스너가 없으면 Electron main이 통째로 죽는다.
  child.on("error", (e: Error) => {
    tail = `${tail}spawn failed: ${e.message}\n`;
    settle(-1);
  });

  const pid = child.pid;
  const killGroup = (signal: NodeJS.Signals) => {
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // 이미 죽었다.
      }
    }
  };

  return {
    owned: true,
    handle: {
      get pid() {
        return pid;
      },
      alive: () => code === null,
      stderrTail: () => tail,
      exitCode: () => code,
      onExit(listener: (c: number) => void) {
        if (code !== null) listener(code);
        else listeners.push(listener);
      },
      async stop(graceMs: number) {
        if (code !== null) return;
        killGroup("SIGTERM");
        const until = Date.now() + graceMs;
        while (code === null && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 50));
        }
      },
    } as never,
  };
}

export interface WorkerDeps {
  /** 외부 supervisor의 pid들. Task 4의 parseWorkerProcesses가 채운다. */
  listExternal(): Promise<number[]>;
  /** worker의 .env 존재 확인. 테스트가 주입한다. */
  exists?(p: string): boolean;
  /** 종료 절차. Task 11의 stopWorker를 main.ts가 넘긴다. */
  stop?(result: LaunchResult, graceMs: number): Promise<{ stopped: boolean; leaked: number[] }>;
}

export function workerSpec(deps: WorkerDeps): ServiceSpec {
  const exists = deps.exists ?? fs.existsSync;

  return {
    id: "worker",
    dependsOn: ["postgres"],
    gate: false,
    // stderr 꼬리를 읽을 뿐이라 사실상 공짜다. ready 줄 뒤에 reconnect 실패가 나타나는
    // 순간을 잡는다 (스펙 §6.6).
    healthIntervalMs: 10_000,
    async detectExternal() {
      const pids = await deps.listExternal();
      if (pids.length === 0) return { kind: "absent" };
      // ps eww는 SIP 때문에 다른 프로세스의 env를 내주지 않는다(2026-09-12 실측).
      // 그 worker가 앱과 같은 STORAGE_ROOT를 보는지 증명할 수 없으므로 채택하지 않는다.
      return {
        kind: "stand-down",
        detail:
          `외부 worker가 실행 중이에요 (pid ${pids.join(", ")}). 앱은 자기 worker를 띄우지 않습니다. ` +
          "그 worker의 STORAGE_ROOT가 앱과 다르면 앱으로 올린 파일이 처리되지 않아요.",
      };
    },
    async launch(ctx) {
      const envFile = path.join(ctx.repoRoot, "be", "worker", ".env");
      if (!exists(envFile)) {
        throw new Error(
          "be/worker/.env가 없어요. be/worker/.env.example을 복사해 값을 채운 뒤 다시 시도해 주세요.",
        );
      }
      return launchWithUv({ ctx, args: ["python", "-m", "damwha_worker"], logId: "worker" });
    },
    async readiness(result): Promise<ReadinessResult> {
      const handle = result.handle;
      if (handle === null) return { kind: "failed", detail: "핸들이 없어요." };
      const tail = handle.stderrTail();
      if (!handle.alive()) {
        return { kind: "failed", detail: tail.split("\n").slice(-12).join("\n").trim() };
      }
      if (workerDegraded(tail)) {
        return {
          kind: "degraded",
          detail: "데이터베이스에 연결할 수 없어 작업을 집지 못하고 있어요. DB가 뜨면 자동으로 복구됩니다.",
        };
      }
      return workerReady(tail) ? { kind: "ready" } : { kind: "not-ready" };
    },
    async stop(result, plan) {
      if (deps.stop !== undefined) return deps.stop(result, plan.graceMs);
      const handle = result.handle;
      if (handle === null) return { stopped: true, leaked: [] };
      await handle.stop(plan.graceMs);
      const leaked = handle.alive() && handle.pid !== undefined ? [handle.pid] : [];
      return { stopped: leaked.length === 0, leaked };
    },
    restart: { maxAttempts: 3, backoffMs: [3_000, 8_000, 20_000] },
  };
}
```

- [ ] **Step 5: `embed.ts`를 쓴다**

```ts
import type { EmbedProbe } from "./external";
import { launchWithUv } from "./worker";
import type { LaunchContext, ReadinessResult, ServiceSpec } from "./types";

export interface EmbedDeps {
  probe(baseUrl: string): Promise<EmbedProbe>;
  freePort(): Promise<number>;
}

function baseUrl(host: string, port: string): string {
  return `http://${host}:${port}`;
}

export function embedSpec(deps: EmbedDeps): ServiceSpec {
  let adopted = false;
  let url = "";

  return {
    id: "embed",
    // DB를 쓰지 않으므로 postgres와 나란히 뜬다. 게이트도 아니다 — bge-m3 로딩 때문에
    // 앱 전체를 세우는 것은 손해이고, 그동안에도 회의 목록과 업로드는 동작한다 (스펙 §6.7).
    dependsOn: [],
    gate: false,
    // 2026-09-12 실측: 최소 PATH + 절대 경로 uv로 /health 200까지 31초(따뜻한 모델 캐시).
    // 기본 60초로는 캐시가 식은 첫 실행을 못 덮는다.
    readyTimeoutMs: 180_000,
    // 짧은 문자열 임베딩 1회라 30초 주기면 무시할 만하다. 채택한 외부 embed가 내려가는
    // 것도 이 경로로 알아챈다 (스펙 §6.6).
    healthIntervalMs: 30_000,
    async prepare(ctx: LaunchContext) {
      const host = ctx.env.EMBED_SERVICE_HOST ?? "127.0.0.1";
      const wanted = ctx.env.EMBED_SERVICE_PORT ?? "8100";
      const probe = await deps.probe(baseUrl(host, wanted));

      // /health가 아니라 /embed 계약으로 판정한다 — /health는 {"status":"ok"}만 주므로
      // 다른 모델·차원도 200을 준다 (스펙 §6.5).
      if (probe.kind === "match") {
        adopted = true;
        url = baseUrl(host, wanted);
        return { EMBED_SERVICE_PORT: wanted, EMBED_SERVICE_URL: url };
      }
      const port = probe.kind === "mismatch" ? String(await deps.freePort()) : wanted;
      adopted = false;
      url = baseUrl(host, port);
      // API는 EMBED_SERVICE_URL을, worker/embed는 HOST/PORT를 읽는다. 한 값에서 둘을
      // 파생하지 않으면 어긋나고, 어긋난 결과는 오류가 아니라 조용한 degrade다.
      return { EMBED_SERVICE_PORT: port, EMBED_SERVICE_URL: url };
    },
    async detectExternal() {
      return adopted
        ? { kind: "adopt" as const, detail: `이미 실행 중인 embed (${url})` }
        : { kind: "absent" as const };
    },
    async launch(ctx) {
      if (adopted) return { handle: null, owned: false };
      return launchWithUv({ ctx, args: ["damwha-embed"], logId: "embed" });
    },
    async readiness(result): Promise<ReadinessResult> {
      const handle = result.handle;
      if (handle !== null && !handle.alive()) {
        return { kind: "failed", detail: handle.stderrTail().split("\n").slice(-12).join("\n").trim() };
      }
      const probe = await deps.probe(url);
      if (probe.kind === "match") return { kind: "ready" };
      if (probe.kind === "mismatch") return { kind: "failed", detail: probe.detail };
      return { kind: "not-ready" };
    },
    async stop(result, plan) {
      const handle = result.handle;
      // 채택한 외부 embed는 핸들이 없다 — 죽일 대상 자체가 없다.
      if (handle === null) return { stopped: true, leaked: [] };
      await handle.stop(plan.graceMs);
      const leaked = handle.alive() && handle.pid !== undefined ? [handle.pid] : [];
      return { stopped: leaked.length === 0, leaked };
    },
    restart: { maxAttempts: 3, backoffMs: [3_000, 8_000, 20_000] },
  };
}
```

- [ ] **Step 6: 두 테스트가 통과하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/worker-spec.test.ts tests/embed-spec.test.ts`
Expected: PASS — worker 13 tests, embed 10 tests

- [ ] **Step 7: 실제 worker의 ready 문구와 대조한다**

```bash
cd /Users/jason/projects/Damwha2
docker compose -f be/docker-compose.yml up -d && sleep 8
timeout 15 pnpm worker 2>&1 | grep "ready (db connected)" | head -1
```

찍힌 줄이 `worker.ts`의 `READY` 정규식에 잡히는지 확인한다. `supervisor` 앞의 로그 접두사(레벨,
타임스탬프)가 붙어도 잡혀야 한다 — 정규식이 줄 시작에 고정돼 있지 않은지 본다.

- [ ] **Step 8: 전체 테스트·타입 검사 후 커밋**

```bash
pnpm --filter damwha-desktop run test && pnpm --filter damwha-desktop run lint
git add desktop/src/services/worker.ts desktop/src/services/embed.ts desktop/tests/worker-spec.test.ts desktop/tests/embed-spec.test.ts
git commit -F - <<'MSG'
feat(desktop): worker·embed 어댑터를 더한다

uv를 절대 경로로 부르고 탐색 목록을 자식 PATH 앞에 붙인다. 두 번째가 없으면
worker 안의 shutil.which("mlx_lm.server")와 pipeline/ffmpeg.py:24,59의 리터럴
호출이 실패한다.

worker 준비는 Task 7이 넣은 "ready (db connected)" 줄로 판정한다. 그 줄보다
뒤에 reconnect 실패가 있으면 degraded이고, 그 뒤에 다시 나오면 회복이다.

외부 worker는 채택하지 않는다. ps eww가 SIP 때문에 다른 프로세스의 env를
내주지 않아 그 worker가 앱과 같은 STORAGE_ROOT를 보는지 증명할 수 없다.
embed는 포트가 있어 /embed 계약 프로브로 증명할 수 있으므로 채택한다.

EMBED_SERVICE_URL(API가 읽는 키)과 EMBED_SERVICE_HOST/PORT(worker·embed가 읽는
키)를 한 값에서 파생한다. 따로 관리하면 어긋나고, 어긋난 결과는 오류가 아니라
검색이 조용히 키워드 전용으로 떨어지는 것이다.

Claude-Session: https://claude.ai/code/session_01CSsVbykTbEVYdxm5cLwsTV
MSG
```

**Verify:**
- `pnpm --filter damwha-desktop run test` → 전부 PASS.
- Step 7의 실제 줄이 `READY` 정규식에 잡힌다.
- `grep -n "EMBED_SERVICE_URL" desktop/src/services/embed.ts` → `prepare`에서만 나온다 (한 곳에서
  파생된다는 증거).

**Review:**
- `workerDegraded`가 **순서**를 보는가. 단순히 "reconnect failed가 있다"로 판정하면 회복 뒤에도
  영원히 degraded로 남는다.
- `launchWithUv`가 `detached: true`인가. 없으면 그룹 종료가 동작하지 않아 Task 11이 고아를 남긴다.
- `launchWithUv`가 `'error'` 리스너를 다는가. 없으면 `uv` spawn 실패가 Electron main을 통째로 죽인다.
- `embedSpec.launch`가 채택한 경우 **아무것도 띄우지 않는가**(`owned: false`). 띄우면 포트 충돌이다.
- worker의 `stand-down` 문구가 `STORAGE_ROOT`를 명시하는가. 그것이 사용자가 확인해야 하는 바로 그 값이다.
- 두 어댑터 모두 `desktop/package.json`에 새 의존을 요구하지 않는가.

---

## Task 9: 로그 파일 회전

**Files:**
- Create: `desktop/src/logs.ts`
- Test: `desktop/tests/logs.test.ts`

**Interfaces:**
- Consumes: Phase 1의 `ANSI_SGR`
- Produces:
  - `rotateIfNeeded(file: string, maxBytes?: number, generations?: number, io?: RotateIo): void`
  - `stripAnsi(text: string): string`
  - `LOG_MAX_BYTES`, `LOG_GENERATIONS`

- [ ] **Step 1: 실패 테스트를 쓴다**

`desktop/tests/logs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LOG_GENERATIONS, LOG_MAX_BYTES, rotateIfNeeded, stripAnsi } from "../src/logs";

function fakeIo(sizes: Record<string, number>) {
  const files = new Map(Object.entries(sizes));
  return {
    io: {
      size: (p: string) => files.get(p) ?? -1,
      rename: (from: string, to: string) => {
        const s = files.get(from);
        if (s === undefined) return;
        files.delete(from);
        files.set(to, s);
      },
      remove: (p: string) => files.delete(p),
    },
    files,
  };
}

describe("rotateIfNeeded", () => {
  it("does nothing below the threshold", () => {
    const { io, files } = fakeIo({ "/l/api.log": 10 });
    rotateIfNeeded("/l/api.log", 100, 3, io);
    expect([...files.keys()]).toEqual(["/l/api.log"]);
  });

  it("does nothing when the file does not exist", () => {
    const { io, files } = fakeIo({});
    rotateIfNeeded("/l/api.log", 100, 3, io);
    expect(files.size).toBe(0);
  });

  it("moves the current file to .1 when it is too big", () => {
    const { io, files } = fakeIo({ "/l/api.log": 500 });
    rotateIfNeeded("/l/api.log", 100, 3, io);
    expect(files.has("/l/api.log")).toBe(false);
    expect(files.get("/l/api.log.1")).toBe(500);
  });

  it("shifts older generations down", () => {
    const { io, files } = fakeIo({ "/l/api.log": 500, "/l/api.log.1": 400, "/l/api.log.2": 300 });
    rotateIfNeeded("/l/api.log", 100, 3, io);
    expect(files.get("/l/api.log.1")).toBe(500);
    expect(files.get("/l/api.log.2")).toBe(400);
    expect(files.get("/l/api.log.3")).toBe(300);
  });

  it("drops the oldest generation instead of growing without bound", () => {
    const { io, files } = fakeIo({
      "/l/api.log": 500,
      "/l/api.log.1": 400,
      "/l/api.log.2": 300,
      "/l/api.log.3": 200,
    });
    rotateIfNeeded("/l/api.log", 100, 3, io);
    expect(files.has("/l/api.log.4")).toBe(false);
    expect(files.get("/l/api.log.3")).toBe(300);
  });

  it("never throws when the filesystem refuses", () => {
    const io = {
      size: () => 500,
      rename: () => {
        throw new Error("EACCES");
      },
      remove: () => {
        throw new Error("EACCES");
      },
    };
    // 로그를 못 돌리는 것은 앱이 죽을 이유가 아니다 (Phase 1의 makeSink와 같은 규칙).
    expect(() => rotateIfNeeded("/l/api.log", 100, 3, io)).not.toThrow();
  });
});

describe("stripAnsi", () => {
  it("removes the worker's progress-bar colour", () => {
    // worker는 진행 바와 로그가 같은 stderr를 쓴다(console.install_logging).
    expect(stripAnsi("\x1b[32m진행 50%\x1b[0m")).toBe("진행 50%");
  });

  it("leaves plain text alone", () => {
    expect(stripAnsi("supervisor ready")).toBe("supervisor ready");
  });
});

describe("defaults", () => {
  it("are the values the spec records", () => {
    expect(LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(LOG_GENERATIONS).toBe(3);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/logs.test.ts`
Expected: FAIL — `Cannot find module '../src/logs'`

- [ ] **Step 3: `logs.ts`를 쓴다**

```ts
import * as fs from "fs";
import { ANSI_SGR } from "./stderr";

/** 10 MB × 3세대. 근거는 결과 문서에 남긴다 — worker의 진행 바가 로그를 빠르게 불린다. */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_GENERATIONS = 3;

export interface RotateIo {
  /** 없으면 음수. */
  size(p: string): number;
  rename(from: string, to: string): void;
  remove(p: string): void;
}

const realIo: RotateIo = {
  size: (p) => {
    try {
      return fs.statSync(p).size;
    } catch {
      return -1;
    }
  },
  rename: (from, to) => fs.renameSync(from, to),
  remove: (p) => fs.rmSync(p, { force: true }),
};

/**
 * 기동 시점에 한 번 부른다. 스트림이 열린 뒤 파일을 옮기면 열린 핸들이 옮겨진 파일을 계속
 * 가리키므로, 회전은 자식을 띄우기 **전에** 해야 한다.
 */
export function rotateIfNeeded(
  file: string,
  maxBytes: number = LOG_MAX_BYTES,
  generations: number = LOG_GENERATIONS,
  io: RotateIo = realIo,
): void {
  try {
    const size = io.size(file);
    if (size < 0 || size < maxBytes) return;

    // 가장 오래된 것부터 지우고 뒤에서 앞으로 밀어야 덮어쓰지 않는다.
    io.remove(`${file}.${generations}`);
    for (let i = generations - 1; i >= 1; i -= 1) {
      if (io.size(`${file}.${i}`) >= 0) io.rename(`${file}.${i}`, `${file}.${i + 1}`);
    }
    io.rename(file, `${file}.1`);
  } catch {
    // 로그를 못 돌리는 것은 앱이 죽을 이유가 아니다. 다음 기동에 다시 시도한다.
  }
}

/**
 * worker는 진행 바와 로그가 같은 stderr를 쓰고(console.install_logging), NestJS Logger도
 * TTY가 아닌 stderr에 색상을 쓴다. 파일에 그대로 넣으면 제어문자가 글자로 남는다.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR, "");
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/logs.test.ts`
Expected: PASS — 10 tests

- [ ] **Step 5: `launchWithUv`와 Phase 1의 `makeSink`가 ANSI를 벗기게 한다**

`desktop/src/services/worker.ts`의 `append`를 고친다:

```ts
  const append = (b: Buffer) => {
    const text = b.toString();
    out.write(stripAnsi(text));
    tail = (tail + text).slice(-32_000);
  };
```

`stripAnsi`를 import한다. **tail은 벗기지 않는다** — 화면에 올릴 때 `failureBlock`이 이미 벗기고,
여기서 또 벗기면 Phase 1의 `lastMeaningfulLine` 테스트가 가정하는 입력이 달라진다.

- [ ] **Step 6: 전체 테스트·타입 검사 후 커밋**

```bash
pnpm --filter damwha-desktop run test && pnpm --filter damwha-desktop run lint
git add desktop/src/logs.ts desktop/tests/logs.test.ts desktop/src/services/worker.ts
git commit -F - <<'MSG'
feat(desktop): 로그 회전과 ANSI 제거를 더한다

10 MB × 3세대. worker는 진행 바와 로그가 같은 stderr를 쓰므로 파일이 빠르게
불어난다. 회전은 자식을 띄우기 전에 한 번만 한다 — 스트림이 열린 뒤 파일을
옮기면 열린 핸들이 옮겨진 파일을 계속 가리킨다.

파일에 쓸 때만 ANSI를 벗긴다. tail은 그대로 둔다 — 화면에 올릴 때
failureBlock이 이미 벗기고, 여기서 또 벗기면 Phase 1의 lastMeaningfulLine
테스트가 가정하는 입력이 달라진다.

로그를 못 돌리는 것은 앱이 죽을 이유가 아니다.

Claude-Session: https://claude.ai/code/session_01CSsVbykTbEVYdxm5cLwsTV
MSG
```

**Verify:**
- `pnpm --filter damwha-desktop run test` → 전부 PASS (Phase 1의 stderr 테스트 포함).
- `pnpm --filter damwha-desktop run lint` → 오류 0.

**Review:**
- 회전이 **뒤에서 앞으로** 미는가. 앞에서 뒤로 밀면 `.1`이 `.2`를 덮어써 세대가 하나로 무너진다.
- 회전이 예외를 삼키는가. 디스크가 차거나 권한이 없을 때 앱이 죽으면 안 된다.
- `stripAnsi`가 **파일 쓰기 경로에만** 걸렸는가. tail에도 걸면 Phase 1 테스트의 전제가 달라진다.
- `LOG_MAX_BYTES`·`LOG_GENERATIONS`가 상수로 노출돼 결과 문서에 값을 적을 수 있는가.

---

## Task 10: fe의 종료 handshake 훅 — 제품 코드 변경 2

이 Task만 `fe/`를 건드린다. 스펙 §10의 두 번째 변경이다.

**왜 필요한가.** `fe/src`에 `beforeunload`·`pagehide` 훅이 **0건**이라, 창이 파괴되면
`LiveRecorder.stop()`이 아예 불리지 않는다 — 마지막 tail 청크가 서버에 못 들어가고 회의는
`capture_error = producer_abandoned`로 닫힌다. 게다가 그 봉인을 하는 `LiveOrphanService.sweep`은
API의 `@Cron`이라, 우리가 API도 내리는 종료 경로에서는 그 순간 아무도 봉인하지 않는다.

**Files:**
- Modify: `fe/src/features/meeting/lib/live-session.ts` (조회·중지 함수 2개 export)
- Create: `fe/src/features/meeting/lib/desktop-bridge.ts`
- Modify: `fe/src/main.tsx` (한 줄)
- Test: `fe/src/features/meeting/lib/desktop-bridge.test.ts`

**Interfaces:**
- Consumes: `live-session.ts`의 모듈 레벨 `active` 레지스트리
- Produces:
  - `hasLiveCapture(): boolean` (`live-session.ts`)
  - `stopActiveLiveCapture(): Promise<void>` (`live-session.ts`)
  - `installDesktopBridge(w?: Window): void` (`desktop-bridge.ts`)
  - 런타임 전역 `window.__damwha_desktop = { isRecording(), stopLiveRecording() }` — Task 13의
    main이 `executeJavaScript`로 부른다.

- [ ] **Step 1: 실패 테스트를 쓴다**

`fe/src/features/meeting/lib/desktop-bridge.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDesktopBridge } from "./desktop-bridge";

const live = vi.hoisted(() => ({
  hasLiveCapture: vi.fn(() => false),
  stopActiveLiveCapture: vi.fn(async () => undefined),
}));

vi.mock("./live-session", () => live);

type Bridge = {
  isRecording(): boolean;
  stopLiveRecording(): Promise<{ stopped: boolean; reason?: string }>;
};

function install(): Bridge {
  const w = {} as Window & { __damwha_desktop?: Bridge };
  installDesktopBridge(w);
  return w.__damwha_desktop!;
}

beforeEach(() => {
  live.hasLiveCapture.mockReset().mockReturnValue(false);
  live.stopActiveLiveCapture.mockReset().mockResolvedValue(undefined);
});

describe("installDesktopBridge", () => {
  it("exposes the two calls the desktop app needs", () => {
    const bridge = install();
    expect(typeof bridge.isRecording).toBe("function");
    expect(typeof bridge.stopLiveRecording).toBe("function");
  });

  it("reports recording from the live-session registry", () => {
    live.hasLiveCapture.mockReturnValue(true);
    expect(install().isRecording()).toBe(true);
  });

  it("stops through the same path the on-screen button uses", async () => {
    live.hasLiveCapture.mockReturnValue(true);
    const r = await install().stopLiveRecording();
    expect(live.stopActiveLiveCapture).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ stopped: true });
  });

  it("is a no-op when nothing is recording", async () => {
    const r = await install().stopLiveRecording();
    expect(live.stopActiveLiveCapture).not.toHaveBeenCalled();
    expect(r).toEqual({ stopped: true, reason: "no-recording" });
  });

  it("reports a stop failure instead of throwing", async () => {
    // main은 이 값을 보고 "그래도 종료할지"를 정한다. 여기서 던지면 executeJavaScript가
    // 거부로 끝나 main이 이유를 못 읽는다.
    live.hasLiveCapture.mockReturnValue(true);
    live.stopActiveLiveCapture.mockRejectedValue(new Error("업로드 실패"));
    const r = await install().stopLiveRecording();
    expect(r.stopped).toBe(false);
    expect(r.reason).toContain("업로드 실패");
  });

  it("does not replace an already-installed bridge", () => {
    const w = {} as Window & { __damwha_desktop?: Bridge };
    installDesktopBridge(w);
    const first = w.__damwha_desktop;
    installDesktopBridge(w);
    expect(w.__damwha_desktop).toBe(first);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run src/features/meeting/lib/desktop-bridge.test.ts`
Expected: FAIL — `Cannot find module './desktop-bridge'`

- [ ] **Step 3: `live-session.ts`에 두 함수를 export한다**

기존 `isLiveCapture(entry)` 술어와 모듈 레벨 `active`를 그대로 쓴다. 파일 끝에 추가한다.

```ts
/**
 * 데스크톱 앱의 종료 handshake가 쓴다. 창을 닫으면 렌더러가 파괴돼 stop()이 아예 불리지
 * 않으므로(이 코드베이스에 beforeunload 훅이 없다), main이 종료 전에 이것을 물어본다.
 */
export function hasLiveCapture(): boolean {
  return active !== null && isLiveCapture(active);
}

/**
 * 활성 녹음을 화면의 종료 버튼과 **같은 경로**로 중지한다. 별도 종료 경로를 만들면 둘이
 * 갈라져, 화면으로 끝낸 녹음과 앱 종료로 끝낸 녹음의 마감이 달라진다.
 */
export async function stopActiveLiveCapture(): Promise<void> {
  if (active === null || !isLiveCapture(active)) return;
  await active.recorder.stop();
}
```

- [ ] **Step 4: `desktop-bridge.ts`를 쓴다**

```ts
import { hasLiveCapture, stopActiveLiveCapture } from "./live-session";

export interface DesktopBridge {
  isRecording(): boolean;
  stopLiveRecording(): Promise<{ stopped: boolean; reason?: string }>;
}

declare global {
  interface Window {
    __damwha_desktop?: DesktopBridge;
  }
}

/**
 * main → 렌더러 한 방향이다. 렌더러가 먼저 부를 수 있는 채널은 생기지 않으므로 Phase 1의
 * "렌더러에서 main을 부를 경로를 새로 만들지 않는다"는 계약이 그대로 산다 (스펙 §6.11).
 * 웹 배포에서는 아무도 부르지 않아 무해하고, fe는 이 객체 없이도 그대로 동작한다.
 */
export function installDesktopBridge(w: Window = window): void {
  // 두 번 설치하지 않는다 — HMR이나 StrictMode의 이중 마운트에서 훅이 갈리면
  // main이 낡은 레지스트리를 보는 쪽을 잡을 수 있다.
  if (w.__damwha_desktop !== undefined) return;
  w.__damwha_desktop = {
    isRecording: () => hasLiveCapture(),
    async stopLiveRecording() {
      if (!hasLiveCapture()) return { stopped: true, reason: "no-recording" };
      try {
        await stopActiveLiveCapture();
        return { stopped: true };
      } catch (e) {
        // 여기서 던지면 executeJavaScript가 거부로 끝나 main이 이유를 못 읽는다.
        return { stopped: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
```

- [ ] **Step 5: `fe/src/main.tsx`에 한 줄을 더한다**

```tsx
import "@/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "@/app/providers";
import { installDesktopBridge } from "@/features/meeting/lib/desktop-bridge";

// 데스크톱 앱의 종료 handshake용 훅. 웹에서는 아무도 부르지 않는다.
installDesktopBridge();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProviders />
  </StrictMode>,
);
```

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run src/features/meeting/lib/desktop-bridge.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 7: fe 전체 테스트·lint·빌드**

```bash
pnpm --filter damwha-fe run test
pnpm --filter damwha-fe run lint
pnpm --filter damwha-fe run build
```

Expected: 전부 PASS. 특히 `live-session.test.tsx` 기존 테스트가 그대로 통과한다 — 추가한 두
함수가 기존 동작을 바꾸지 않았다는 뜻이다.

- [ ] **Step 8: 커밋**

```bash
git add fe/src/features/meeting/lib/live-session.ts fe/src/features/meeting/lib/desktop-bridge.ts fe/src/features/meeting/lib/desktop-bridge.test.ts fe/src/main.tsx
git commit -F - <<'MSG'
feat(fe): 데스크톱 종료 handshake용 훅을 노출한다

이 코드베이스에는 beforeunload·pagehide 훅이 하나도 없다. 창이 파괴되면
LiveRecorder.stop()이 아예 불리지 않아 마지막 tail 청크가 서버에 못 들어가고
회의가 producer_abandoned로 닫힌다. 그 봉인을 하는 LiveOrphanService.sweep은
API의 @Cron이라, 앱이 API도 내리는 종료 경로에서는 그 순간 아무도 봉인하지
않는다.

main이 executeJavaScript로 부를 훅 하나를 window에 둔다. 방향이 main →
렌더러라 렌더러가 먼저 여는 채널은 생기지 않고, Phase 1의 무-IPC 계약이
그대로 산다. 웹 배포에서는 아무도 부르지 않아 무해하다.

중지는 화면의 종료 버튼과 같은 경로를 부른다. 별도 경로를 만들면 둘이 갈라져
화면으로 끝낸 녹음과 앱 종료로 끝낸 녹음의 마감이 달라진다.

Claude-Session: https://claude.ai/code/session_01CSsVbykTbEVYdxm5cLwsTV
MSG
```

**Verify:**
- `pnpm --filter damwha-fe run test` → 전부 PASS (기존 `live-session.test.tsx` 포함).
- `pnpm --filter damwha-fe run build` → 성공.
- `git show --stat HEAD` → 4파일, 모두 `fe/` 아래. **desktop·be는 건드리지 않았다.**

**Review:**
- `stopActiveLiveCapture`가 **기존 `recorder.stop()`을 부르는가.** 새 HTTP 호출을 직접 만들면
  화면 경로와 갈라진다.
- `stopLiveRecording`이 어떤 경우에도 던지지 않는가. 던지면 `executeJavaScript`가 거부로 끝나
  main이 이유를 못 읽고 "그래도 종료할지"를 판단할 근거를 잃는다.
- `installDesktopBridge`가 멱등인가.
- `fe/`가 이 객체 **없이도** 동작하는가 — 다른 코드가 `window.__damwha_desktop`을 읽지 않는지
  `grep -rn "__damwha_desktop" fe/src | grep -v desktop-bridge`가 0건인가.
- `live-session.ts`의 기존 export와 `active` 수명 규칙을 바꾸지 않았는가.

---

## Task 11: 종료 정책

**Files:**
- Create: `desktop/src/shutdown.ts`
- Test: `desktop/tests/shutdown.test.ts`

**Interfaces:**
- Consumes: Task 3의 `types.ts`, Phase 1의 `descendantPids()`
- Produces:
  - `stopWorkerProcess(handle, opts): Promise<StopOutcome>` — SIGTERM 2단계 + 자손 SIGKILL
  - `decideQuit(state, ask): Promise<QuitDecision>`
  - `runHandshake(bridge, opts): Promise<HandshakeResult>`

- [ ] **Step 1: 실패 테스트를 쓴다**

`desktop/tests/shutdown.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { decideQuit, runHandshake, stopWorkerProcess } from "../src/shutdown";

describe("stopWorkerProcess", () => {
  function handle(aliveFor: number) {
    let calls = 0;
    return {
      pid: 4242,
      alive: () => ++calls <= aliveFor,
      stderrTail: () => "",
      exitCode: () => null,
      onExit: () => undefined,
      stop: async () => undefined,
    } as never;
  }

  it("sends SIGTERM exactly once when the worker stops politely", async () => {
    const signals: Array<[number, string]> = [];
    const out = await stopWorkerProcess(handle(0), {
      graceMs: 20,
      pollMs: 5,
      signal: (pid, sig) => signals.push([pid, sig]),
      descendants: async () => new Set<number>(),
      onGraceExpired: async () => true,
    });
    expect(signals).toEqual([[-4242, "SIGTERM"]]);
    expect(out).toEqual({ stopped: true, leaked: [] });
  });

  it("asks before escalating and does nothing more when the answer is no", async () => {
    const signals: Array<[number, string]> = [];
    const ask = vi.fn(async () => false);
    await stopWorkerProcess(handle(999), {
      graceMs: 20,
      pollMs: 5,
      signal: (pid, sig) => signals.push([pid, sig]),
      descendants: async () => new Set<number>(),
      onGraceExpired: ask,
      maxWaits: 2,
    });
    expect(ask).toHaveBeenCalled();
    expect(signals.filter(([, s]) => s === "SIGKILL")).toHaveLength(0);
  });

  it("escalates with a SECOND SIGTERM, not SIGKILL", async () => {
    // supervisor의 2단계 핸들러가 두 번째 SIGTERM에서 자식을 kill하고 os._exit한다.
    // 우리가 곧장 SIGKILL을 보내면 --once 자식과 mlx_lm.server가 고아로 남는다.
    const signals: string[] = [];
    await stopWorkerProcess(handle(999), {
      graceMs: 10,
      pollMs: 5,
      signal: (_pid, sig) => signals.push(sig),
      descendants: async () => new Set<number>(),
      onGraceExpired: async () => true,
      maxWaits: 2,
    });
    expect(signals[0]).toBe("SIGTERM");
    expect(signals[1]).toBe("SIGTERM");
  });

  it("finally SIGKILLs the descendant set, which crosses the new session", async () => {
    // --once 자식은 start_new_session이라 그룹 kill에 안 잡히지만 부모-자식 관계는
    // 그대로라 ps의 ppid BFS가 찾는다 (스펙 §6.9 4단계).
    const killed: number[] = [];
    await stopWorkerProcess(handle(999), {
      graceMs: 10,
      pollMs: 5,
      signal: (pid, sig) => {
        if (sig === "SIGKILL") killed.push(pid);
      },
      descendants: async () => new Set([5001, 5002]),
      onGraceExpired: async () => true,
      maxWaits: 2,
    });
    expect(killed.sort()).toEqual([4242, 5001, 5002]);
  });

  it("reports what it could not clean instead of claiming success", async () => {
    const out = await stopWorkerProcess(handle(999), {
      graceMs: 10,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => new Set([5001]),
      onGraceExpired: async () => true,
      maxWaits: 2,
      stillAlive: async () => [4242, 5001],
    });
    expect(out.stopped).toBe(false);
    expect(out.leaked.sort()).toEqual([4242, 5001]);
  });

  it("does nothing when there is no pid", async () => {
    const signals: string[] = [];
    const out = await stopWorkerProcess(
      { pid: undefined, alive: () => false } as never,
      {
        graceMs: 10,
        pollMs: 5,
        signal: (_p, s) => signals.push(s),
        descendants: async () => new Set<number>(),
        onGraceExpired: async () => true,
      },
    );
    expect(signals).toEqual([]);
    expect(out.stopped).toBe(true);
  });
});

describe("decideQuit", () => {
  it("asks when a recording is in flight", async () => {
    const ask = vi.fn(async () => true);
    const d = await decideQuit({ recording: true, analysing: false }, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatch(/녹음/);
    expect(d).toEqual({ quit: true, stopRecording: true });
  });

  it("asks when a job is running", async () => {
    const ask = vi.fn(async () => true);
    const d = await decideQuit({ recording: false, analysing: true }, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatch(/분석/);
    expect(d).toEqual({ quit: true, stopRecording: false });
  });

  it("asks once, naming both, when both are in flight", async () => {
    const ask = vi.fn(async () => true);
    await decideQuit({ recording: true, analysing: true }, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatch(/녹음/);
    expect(ask.mock.calls[0][0]).toMatch(/분석/);
  });

  it("does not ask when nothing is in flight", async () => {
    const ask = vi.fn(async () => true);
    const d = await decideQuit({ recording: false, analysing: false }, ask);
    expect(ask).not.toHaveBeenCalled();
    expect(d).toEqual({ quit: true, stopRecording: false });
  });

  it("cancels the quit when the user says no", async () => {
    const d = await decideQuit({ recording: true, analysing: false }, async () => false);
    expect(d.quit).toBe(false);
  });
});

describe("runHandshake", () => {
  it("returns stopped when the renderer finishes", async () => {
    const r = await runHandshake(async () => ({ stopped: true }), { timeoutMs: 50 });
    expect(r).toEqual({ kind: "stopped" });
  });

  it("reports the renderer's own reason for failing", async () => {
    const r = await runHandshake(async () => ({ stopped: false, reason: "업로드 실패" }), {
      timeoutMs: 50,
    });
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.detail).toContain("업로드 실패");
  });

  it("times out instead of blocking the quit forever", async () => {
    const r = await runHandshake(() => new Promise(() => undefined), { timeoutMs: 20 });
    expect(r.kind).toBe("timeout");
  });

  it("treats a destroyed renderer as failed, not as success", async () => {
    const r = await runHandshake(async () => {
      throw new Error("Object has been destroyed");
    }, { timeoutMs: 50 });
    expect(r.kind).toBe("failed");
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/shutdown.test.ts`
Expected: FAIL — `Cannot find module '../src/shutdown'`

- [ ] **Step 3: `shutdown.ts`를 쓴다**

```ts
import type { ServiceHandle, ServiceId, StopOutcome } from "./services/types";

export interface StopWorkerOptions {
  graceMs: number;
  pollMs: number;
  signal(pid: number, sig: NodeJS.Signals): void;
  descendants(rootPid: number): Promise<Set<number>>;
  /** 유예가 지났을 때 사람에게 묻는다. true면 강제 단계로 올라간다. */
  onGraceExpired(id: ServiceId): Promise<boolean>;
  /** 테스트가 폴링 횟수를 묶는다. */
  maxWaits?: number;
  /** 마지막으로 실제 생존을 확인한다. 기본은 handle.alive()만 본다. */
  stillAlive?(pids: number[]): Promise<number[]>;
}

/**
 * worker를 SIGKILL로 먼저 죽이면 안 된다. __main__.py:279가 --once 자식을
 * start_new_session=True로 띄우므로 프로세스 그룹 kill이 그 자식에 닿지 않고, supervisor를
 * 죽이면 자식과 그것이 띄운 mlx_lm.server가 고아로 남는다 (스펙 §6.9).
 *
 * 1. SIGTERM 1회 — supervisor가 자식에 전달하고 자식은 stage boundary에서 멈춰
 *    requeue_for_shutdown을 부른다. 그 경로가 attempts를 되돌린다.
 * 2. 유예 초과 → 사람에게 묻는다.
 * 3. 강제 → SIGTERM 2회차. supervisor가 자식을 kill하고 os._exit한다.
 * 4. 그래도 남으면 자손 집합에 SIGKILL. start_new_session은 세션만 바꾸고 부모-자식
 *    관계는 그대로라 ps의 ppid BFS가 여전히 찾아낸다.
 * 5. 그래도 남으면 pid를 돌려준다. 정리 실패를 조용히 넘기지 않는다.
 */
export async function stopWorkerProcess(
  handle: ServiceHandle,
  opts: StopWorkerOptions,
): Promise<StopOutcome> {
  const pid = handle.pid;
  if (pid === undefined || !handle.alive()) return { stopped: true, leaked: [] };

  const waitForExit = async (ms: number): Promise<boolean> => {
    const limit = opts.maxWaits ?? Math.ceil(ms / opts.pollMs);
    for (let i = 0; i < limit; i += 1) {
      if (!handle.alive()) return true;
      await new Promise((r) => setTimeout(r, opts.pollMs));
    }
    return !handle.alive();
  };

  // 1단계. 음수 pid = 프로세스 그룹. launchWithUv가 detached로 띄우므로 pid가 그룹 리더다.
  opts.signal(-pid, "SIGTERM");
  if (await waitForExit(opts.graceMs)) return { stopped: true, leaked: [] };

  // 2단계.
  if (!(await opts.onGraceExpired("worker"))) return { stopped: false, leaked: [] };

  // 3단계. SIGKILL이 아니라 두 번째 SIGTERM이다.
  opts.signal(-pid, "SIGTERM");
  if (await waitForExit(opts.graceMs)) return { stopped: true, leaked: [] };

  // 4단계. 세션이 다른 자손까지 ppid BFS로 찾아 직접 죽인다.
  const tree = await opts.descendants(pid).catch(() => new Set<number>());
  for (const target of [pid, ...tree]) opts.signal(target, "SIGKILL");
  await new Promise((r) => setTimeout(r, opts.pollMs));

  // 5단계.
  const candidates = [pid, ...tree];
  const leaked =
    opts.stillAlive !== undefined
      ? await opts.stillAlive(candidates)
      : handle.alive()
        ? [pid]
        : [];
  return { stopped: leaked.length === 0, leaked };
}

export interface InFlight {
  recording: boolean;
  analysing: boolean;
}

export interface QuitDecision {
  quit: boolean;
  /** 종료 전에 렌더러의 라이브 중지를 완주시켜야 하는가. */
  stopRecording: boolean;
}

/**
 * 녹음·분석 둘 다 확인을 받는다. 한 번만 묻는다 — 둘이 동시에 진행 중이라고 대화상자를
 * 두 번 띄우면 사용자는 두 번째가 무엇에 대한 질문인지 모른다.
 */
export async function decideQuit(
  state: InFlight,
  ask: (message: string) => Promise<boolean>,
): Promise<QuitDecision> {
  if (!state.recording && !state.analysing) return { quit: true, stopRecording: false };

  const parts: string[] = [];
  if (state.recording) parts.push("녹음이 진행 중이에요");
  if (state.analysing) parts.push("분석이 진행 중이에요");
  const tail = state.recording
    ? "종료하면 녹음을 먼저 안전하게 마무리합니다."
    : "종료하면 진행 중인 분석을 안전한 지점에서 멈추고 다시 큐에 넣습니다.";

  const ok = await ask(`${parts.join(", ")}. ${tail} 종료할까요?`);
  return { quit: ok, stopRecording: ok && state.recording };
}

export type HandshakeResult =
  | { kind: "stopped" }
  | { kind: "failed"; detail: string }
  | { kind: "timeout" };

/**
 * 렌더러의 라이브 중지를 부르고 서버 ACK까지 기다린다. 실패하거나 시간을 넘기면 그 사실을
 * 돌려준다 — 그때는 sweeper 경로로 떨어지고, 다음 앱 실행 때 API가 뜨면 봉인·마감된다.
 * 종료 자체를 막지는 않는다 (스펙 §6.9).
 */
export async function runHandshake(
  call: () => Promise<{ stopped: boolean; reason?: string }>,
  opts: { timeoutMs: number },
): Promise<HandshakeResult> {
  const timeout = new Promise<HandshakeResult>((resolve) => {
    const t = setTimeout(() => resolve({ kind: "timeout" }), opts.timeoutMs);
    if (typeof t === "object" && "unref" in t) t.unref();
  });
  const work = (async (): Promise<HandshakeResult> => {
    try {
      const r = await call();
      // 창이 이미 파괴됐거나 훅이 없으면 여기로 온다. 성공으로 읽으면 안 된다.
      if (!r.stopped) return { kind: "failed", detail: r.reason ?? "이유를 알 수 없어요." };
      return { kind: "stopped" };
    } catch (e) {
      return { kind: "failed", detail: e instanceof Error ? e.message : String(e) };
    }
  })();
  return Promise.race([work, timeout]);
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/shutdown.test.ts`
Expected: PASS — 15 tests

- [ ] **Step 5: 전체 테스트·타입 검사 후 커밋**

```bash
pnpm --filter damwha-desktop run test && pnpm --filter damwha-desktop run lint
git add desktop/src/shutdown.ts desktop/tests/shutdown.test.ts
git commit -F - <<'MSG'
feat(desktop): 종료 정책을 더한다 — worker는 SIGTERM 2단계가 먼저다

worker를 SIGKILL로 먼저 죽이면 안 된다. __main__.py:279가 --once 자식을
start_new_session=True로 띄워 프로세스 그룹 kill이 그 자식에 닿지 않고,
supervisor를 죽이면 자식과 그것이 띄운 mlx_lm.server가 고아로 남는다.

SIGTERM 1회 → 유예 → 사람에게 확인 → SIGTERM 2회차(supervisor가 자식을 kill)
→ 자손 SIGKILL → 그래도 남으면 pid를 돌려준다. start_new_session은 세션만
바꾸고 부모-자식 관계는 그대로라 ps의 ppid BFS가 여전히 찾아낸다.

녹음·분석 둘 다 확인을 받되 대화상자는 한 번만 띄운다. handshake가 실패하거나
시간을 넘겨도 종료 자체를 막지 않는다 — 그때는 sweeper 경로로 떨어지고 다음
실행 때 봉인된다.

Claude-Session: https://claude.ai/code/session_01CSsVbykTbEVYdxm5cLwsTV
MSG
```

**Verify:**
- `pnpm --filter damwha-desktop run test` → 전부 PASS.
- `grep -n "SIGKILL" desktop/src/shutdown.ts` → 4단계에서만 나온다. 1~3단계에는 없다.

**Review:**
- 강제 단계가 **SIGKILL이 아니라 두 번째 SIGTERM**인가. 이것이 고아를 막는 핵심이다.
- 4단계가 `pid` 자신과 자손을 **둘 다** 죽이는가. 자손만 죽이면 supervisor가 남는다.
- `stopWorkerProcess`가 정리 실패를 `stopped: true`로 뭉개지 않는가.
- `decideQuit`이 대화상자를 **한 번만** 띄우는가.
- `runHandshake`가 `stopped: false`를 성공으로 읽지 않는가. 렌더러가 파괴됐을 때 정확히 그 값이 온다.
- `shutdown.ts`가 `electron`을 import하지 않는가 — vitest가 불러올 수 있어야 한다(Phase 1이
  `stderr.ts`를 분리한 것과 같은 이유).

---

## Task 12: 기동 배선과 창 닫기

`main.ts`가 감독자를 쓰게 한다. 이 Task까지는 종료가 Phase 1 동작 그대로다 — Task 13이 바꾼다.

**Files:**
- Modify: `desktop/src/main.ts`
- Modify: `desktop/src/config.ts` (새 키의 기본값)
- Test: `desktop/tests/config.test.ts` (확장)

**Interfaces:**
- Consumes: Task 2~9의 전부
- Produces: `main.ts`의 `startServices()` — Task 13이 종료를 붙일 자리

- [ ] **Step 1: `config.ts` 확장의 실패 테스트를 쓴다**

`desktop/tests/config.test.ts`에 추가한다.

```ts
describe("defaultConfig — Phase 2 keys", () => {
  it("defaults the embed port so one value drives three processes", () => {
    expect(defaultConfig("/u").EMBED_SERVICE_PORT).toBe("8100");
    expect(defaultConfig("/u").EMBED_SERVICE_HOST).toBe("127.0.0.1");
  });

  it("mints a worker id that cannot collide with an external worker", () => {
    // 기본값 worker-1을 외부 worker와 나눠 쓰면 locked_by만 보는 소유권 가드가
    // 둘을 구별하지 못한다 (스펙 §6.5).
    const a = defaultConfig("/u").WORKER_ID;
    const b = defaultConfig("/u").WORKER_ID;
    expect(a).toMatch(/^desktop-/);
    expect(a).not.toBe("worker-1");
    expect(a).not.toBe(b);
  });
});

describe("loadConfig — app-owned keys", () => {
  it("still refuses to take HOST from the file", () => {
    // Phase 1의 규칙. config.json 한 줄로 API가 LAN에 열리면 안 된다.
    const dir = mkdtempSync(join(tmpdir(), "damwha-cfg-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ HOST: "0.0.0.0" }));
    expect(loadConfig(dir).env.HOST).toBeUndefined();
  });

  it("takes EXTRA_PATH as a list and keeps it out of the child env", () => {
    const dir = mkdtempSync(join(tmpdir(), "damwha-cfg-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ EXTRA_PATH: ["/opt/mine"] }));
    const c = loadConfig(dir);
    expect(c.extraPath).toEqual(["/opt/mine"]);
    // 배열은 자식 env에 문자열로 새어 들어가면 안 된다.
    expect(c.env.EXTRA_PATH).toBeUndefined();
  });

  it("reads REPO_ROOT, UV_BIN and DOCKER_BIN as app settings, not child env", () => {
    const dir = mkdtempSync(join(tmpdir(), "damwha-cfg-"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ REPO_ROOT: "/r", UV_BIN: "/x/uv", DOCKER_BIN: "/x/docker" }),
    );
    const c = loadConfig(dir);
    expect(c.repoRoot).toBe("/r");
    expect(c.uvBin).toBe("/x/uv");
    expect(c.dockerBin).toBe("/x/docker");
    expect(c.env.REPO_ROOT).toBeUndefined();
  });
});
```

파일 상단 import에 `mkdtempSync`, `writeFileSync`, `tmpdir`, `join`이 이미 있는지 확인하고 없으면
더한다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/config.test.ts`
Expected: FAIL — 새 키와 새 필드가 없다

- [ ] **Step 3: `config.ts`를 확장한다**

`defaultConfig`에 두 키를 더한다:

```ts
    EMBED_SERVICE_HOST: "127.0.0.1",
    EMBED_SERVICE_PORT: "8100",
    // 기본값 worker-1을 외부 worker와 나눠 쓰면 locked_by만 보는 소유권 가드가 둘을
    // 구별하지 못한다. 실행마다 새로 만든다 (스펙 §6.5).
    WORKER_ID: `desktop-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
```

`APP_OWNED_KEYS`에 앱 설정 키를 더해 **자식 env로 새지 않게** 한다:

```ts
/** 자식 env가 아니라 앱이 쓰는 설정. 그대로 주입하면 API·worker의 zod/pydantic이 모르는
 *  키를 받거나(무해) 배열이 문자열로 새어 들어간다(유해). */
const APP_SETTING_KEYS = ["REPO_ROOT", "EXTRA_PATH", "UV_BIN", "DOCKER_BIN"];
```

`LoadedConfig`에 필드를 더하고 `loadConfig`에서 채운다:

```ts
export interface LoadedConfig {
  env: ApiEnv;
  created: boolean;
  warning?: string;
  repoRoot?: string;
  uvBin?: string;
  dockerBin?: string;
  extraPath: string[];
}
```

루프에서 `APP_SETTING_KEYS`는 `env`에 넣지 않고 따로 받는다. `EXTRA_PATH`는 문자열 배열만 받고
그 밖의 타입은 무시한다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/config.test.ts`
Expected: PASS — 기존 + 5 tests

- [ ] **Step 5: `main.ts`를 감독자 기반으로 고친다**

`runStart()`의 포트 루프와 `attempt()`를 **감독자 호출로 대체**한다. Phase 1의
`isPortOccupied`·`listenerPids`·`descendantPids`·`verifyOwnListener`는 **그대로 남기고** 어댑터에
주입한다.

먼저 import를 보강한다. 현재 `main.ts`는 `electron`에서 `{ app, BrowserWindow }`만 가져오고
`fs`를 전혀 가져오지 않는다 — 아래 헬퍼 넷이 둘 다 쓴다.

```ts
import { app, BrowserWindow, dialog } from "electron";
import * as fs from "fs";
import type { LaunchContext, ServiceId, ServiceStatus } from "./services/types";
```

그리고 이 Task가 쓰는 작은 헬퍼 넷을 `main.ts`에 정의한다. 계획의 다른 자리에서 이름만
등장하지 않게, 여기서 전부 만든다.

```ts
function logPathOf(id: ServiceId | "supervisor"): string {
  return path.join(app.getPath("userData"), "logs", `${id}.log`);
}

/** 감독자 자신의 판단 기록. 자식의 stdout이 아니라 앱이 무엇을 왜 했는지가 여기 남는다. */
function appendSupervisorLog(line: string): void {
  try {
    const file = logPathOf("supervisor");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // 로그를 못 쓰는 것은 앱이 죽을 이유가 아니다 (Phase 1의 makeSink와 같은 규칙).
  }
}

/**
 * config.json에 한 키만 덧쓴다. 파일 전체를 다시 쓰지 않는 이유는 사용자가 손으로 넣은
 * 다른 키와 주석 없는 포맷을 보존하기 위해서다. 실패해도 기동을 막지 않는다 — 다음 실행에
 * 다시 물어보면 된다.
 */
function saveConfigValue(userData: string, key: string, value: string): void {
  const file = path.join(userData, "config.json");
  try {
    const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "{}";
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed[key] = value;
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch (e) {
    appendSupervisorLog(`config.json에 ${key}를 저장하지 못했어요: ${String(e)}`);
  }
}

/** 앱이 정한 API origin. 감독자의 런타임에서 읽는다 — 전역 변수를 따로 두면 갈린다. */
function currentApiOrigin(): string | null {
  return supervisor?.runtimeOf("api")?.result?.origin ?? null;
}

/**
 * 창을 다시 연 뒤 화면을 붙인다. 서비스는 이미 떠 있으므로 다시 띄우지 않는다 —
 * activate에서 startServices()를 부르면 넷을 또 띄운다.
 */
async function reattachWindow(mine: number): Promise<void> {
  const origin = currentApiOrigin();
  const target = activeWindow(mine);
  if (target === null) return;
  if (origin === null) {
    await showStatus(target, { state: "starting" });
    return;
  }
  const renderer = await rendererTarget(origin);
  if ("error" in renderer) {
    await showStatus(target, { state: "failed", detail: renderer.error, logPath: logPathOf("api") });
    return;
  }
  await target.loadURL(renderer.url);
}
```

```ts
import { createSupervisor } from "./services/supervisor";
import { apiSpec } from "./services/api";
import { postgresSpec } from "./services/postgres";
import { workerSpec } from "./services/worker";
import { embedSpec } from "./services/embed";
import { parseWorkerProcesses, probeEmbedContract } from "./services/external";
import { searchDirs, findExecutable } from "./services/resolve";
import { isRepoRoot } from "./repo-root";
import { rotateIfNeeded } from "./logs";
import { freePort } from "./port";

async function dockerRun(bin: string, args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 30_000 });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? String(e), code: err.code ?? 1 };
  }
}

/**
 * REPO_ROOT를 빌드 시점에 굽지 않는다 — 번들 안에 저장소 절대 경로가 들어가면 Phase 1의
 * 위생 기준(P1-C11)이 깨진다. 못 찾으면 사람에게 한 번 묻고 config.json에 적는다.
 * Phase 3·4가 번들을 넣으면 이 물음 자체가 사라진다 (스펙 §6.4).
 */
async function resolveRepoRoot(configured: string | undefined): Promise<string | null> {
  if (configured !== undefined && isRepoRoot(configured)) return configured;
  if (!app.isPackaged) {
    const guess = path.resolve(app.getAppPath(), "..");
    if (isRepoRoot(guess)) return guess;
  }
  const picked = await dialog.showOpenDialog({
    title: "담화 저장소 폴더를 골라 주세요",
    message: "be/worker와 be/docker-compose.yml이 있는 폴더입니다.",
    properties: ["openDirectory"],
  });
  const dir = picked.filePaths[0];
  if (dir === undefined || !isRepoRoot(dir)) return null;
  saveConfigValue(app.getPath("userData"), "REPO_ROOT", dir);
  return dir;
}
```

`startServices()`를 만든다:

```ts
let supervisor: ReturnType<typeof createSupervisor> | null = null;

async function startServices(mine: number): Promise<void> {
  const cfg = loadConfig(app.getPath("userData"));
  const repoRoot = await resolveRepoRoot(cfg.repoRoot);
  if (repoRoot === null) throw new Error("저장소 폴더를 확인하지 못했어요.");

  const dirs = searchDirs(app.getPath("home"), cfg.extraPath);
  const uv = cfg.uvBin ?? findExecutable("uv", dirs);
  const docker = cfg.dockerBin ?? findExecutable("docker", dirs);
  if (docker === null) {
    throw new Error("docker를 찾지 못했어요. Docker Desktop을 설치했는지, config.json의 DOCKER_BIN 경로가 맞는지 확인해 주세요.");
  }

  const ctx: LaunchContext = {
    repoRoot,
    userData: app.getPath("userData"),
    packaged: app.isPackaged,
    env: cfg.env,
    bins: { uv, docker },
    searchDirs: dirs,
    logFile: (id) => path.join(app.getPath("userData"), "logs", `${id}.log`),
  };
  // 스트림이 열린 뒤 옮기면 열린 핸들이 옮겨진 파일을 계속 가리킨다 — 띄우기 전에 돌린다.
  for (const id of ["supervisor", "api", "worker", "embed"] as const) {
    rotateIfNeeded(ctx.logFile(id as never));
  }

  const wantEmbed = {
    model: cfg.env.SEARCH_EMBEDDING_MODEL ?? "BAAI/bge-m3",
    dimension: Number(cfg.env.SEARCH_EMBEDDING_DIM ?? "1024"),
  };

  supervisor = createSupervisor(
    [
      // 선언 순서의 역순이 곧 종료 순서다. 스펙 §6.9가 worker → embed → api를 요구하므로
      // 여기는 postgres → api → embed → worker여야 한다. embed의 prepare()는 launch보다
      // 먼저 전부 돌므로 api가 EMBED_SERVICE_URL을 못 보는 일은 없다.
      postgresSpec((args) => dockerRun(docker, args)),
      apiSpec({
        verifyOwnListener,
        isPortOccupied,
        onPendingMigrations: () => undefined,
        onMigrationCheckSkipped: () =>
          appendSupervisorLog("마이그레이션 검사가 건너뛰어졌어요 — 통과한 것이 아닙니다."),
      }),
      embedSpec({ probe: (url) => probeEmbedContract(url, wantEmbed), freePort }),
      workerSpec({ listExternal: listExternalWorkers }),
    ],
    ctx,
    { onStatus: renderStatus, log: appendSupervisorLog },
  );

  await supervisor.start();
  const api = supervisor.statuses().find((s) => s.id === "api");
  if (api?.process !== "running") {
    await showStatus(activeWindow(mine)!, {
      state: "failed",
      detail: api?.detail,
      retryInSeconds: scheduleRetry(),
      logPath: ctx.logFile("api"),
    });
    return;
  }
  // origin은 감독자의 런타임에서 읽는다. Phase 1의 전역 apiOrigin은 이제 쓰지 않는다.
  await reattachWindow(mine);
}

async function listExternalWorkers(): Promise<number[]> {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid,command"], { timeout: 2_000 });
  const ours = new Set<number>();
  for (const id of ["worker"] as const) {
    const rt = supervisor?.runtimeOf(id);
    const pid = rt?.result?.handle?.pid;
    if (pid !== undefined) for (const d of await descendantPids(pid)) ours.add(d);
  }
  return parseWorkerProcesses(stdout, ours);
}
```

- [ ] **Step 6: 창 닫기를 종료와 분리한다**

`window-all-closed` 핸들러를 바꾸고 `activate`를 더한다.

```ts
  // macOS 관례. 창을 닫아도 앱과 서비스는 계속 돈다 — 긴 전사가 창을 닫아도 이어진다.
  // Dock에 남으므로 "껐다고 생각했는데 돌고 있다"는 상태는 아니다 (스펙 §6.10).
  app.on("window-all-closed", () => {
    // 의도적으로 app.quit()을 부르지 않는다. Phase 1은 여기서 종료했다.
  });

  app.on("activate", () => {
    if (win !== null && !win.isDestroyed()) {
      win.show();
      win.focus();
      return;
    }
    win = createWindow();
    win.on("closed", () => {
      win = null;
    });
    // 서비스는 이미 떠 있다. 화면만 다시 붙인다.
    void reattachWindow(generation);
  });
```

`reattachWindow()`는 `apiOrigin`이 있으면 그 주소를, 없으면 준비 화면을 로드한다.

- [ ] **Step 7: 개발 모드로 기동을 육안 확인한다**

```bash
cd /Users/jason/projects/Damwha2
docker compose -f be/docker-compose.yml down 2>/dev/null || true
pkill -f damwha_worker; pkill -f damwha-embed
pnpm desktop:dev
```

확인할 것:
1. Docker 컨테이너가 앱에 의해 뜬다 (`docker compose ps`).
2. 창이 담화 화면에 닿는다.
3. `~/Library/Application Support/Damwha/logs/`에 네 파일이 생긴다.
4. 창을 닫아도 **앱이 살아 있다** (Dock 아이콘 존재). Dock 클릭으로 창이 돌아온다.
5. Cmd+Q로 종료한다 (Task 13 전이라 Phase 1 동작).

- [ ] **Step 8: 전체 테스트·타입 검사 후 커밋**

```bash
pnpm --filter damwha-desktop run test && pnpm --filter damwha-desktop run lint
git add desktop/src/main.ts desktop/src/config.ts desktop/tests/config.test.ts
git commit -F - <<'MSG'
feat(desktop): main이 서비스 감독자를 쓰고 창 닫기를 종료와 분리한다

DB·API·worker·embed 넷을 의존 순서로 띄운다. Phase 1의 소유 판정 기구
(isPortOccupied, verifyOwnListener, descendantPids)는 그대로 남기고 어댑터에
주입한다.

REPO_ROOT는 빌드 시점에 굽지 않는다 — 번들 안에 저장소 절대 경로가 들어가면
Phase 1의 위생 기준이 깨진다. 못 찾으면 사람에게 한 번 묻고 config.json에
적는다. Phase 3·4가 번들을 넣으면 이 물음 자체가 사라진다.

WORKER_ID는 실행마다 새로 만든다. 기본값 worker-1을 외부 worker와 나눠 쓰면
locked_by만 보는 소유권 가드가 둘을 구별하지 못한다.

창을 닫아도 앱과 서비스가 산다. 긴 전사가 창을 닫아도 이어지고, Dock에 남으므로
켜진 것이 안 보이는 상태는 아니다.

Claude-Session: https://claude.ai/code/session_01CSsVbykTbEVYdxm5cLwsTV
MSG
```

**Verify:**
- `pnpm --filter damwha-desktop run test`·`run lint` → 전부 PASS.
- Step 7의 다섯 항목을 눈으로 확인했고, 특히 4번(창을 닫아도 앱 생존)이 성립한다.
- `docker compose -f be/docker-compose.yml ps` → 앱이 띄운 컨테이너가 있다.

**Review:**
- `window-all-closed`가 **비어 있고 그 이유가 주석에 있는가.** 비어 있는 핸들러는 다음 사람이
  "빠뜨렸다"고 읽는다.
- `EXTRA_PATH` 같은 앱 설정 키가 **자식 env로 새지 않는가.** 배열이 문자열로 들어가면 worker의
  pydantic이 그 키를 만났을 때 무엇을 할지 알 수 없다.
- `HOST`가 여전히 앱 고정 주입인가 (Phase 1의 P1-C9 회귀 방지).
- 로그 회전이 **자식을 띄우기 전에** 도는가.
- `resolveRepoRoot`가 고른 경로를 `isRepoRoot`로 검증하는가. 아무 폴더나 받으면 이후 모든 실패가
  엉뚱한 원인을 말한다.
- Phase 1의 `generation`/`activeWindow` 경쟁 방어가 살아 있는가 — 감독자 도입이 그것을 우회하지
  않았는가.

---

## Task 13: 종료 배선

Task 11이 만든 정책을 `main.ts`의 `before-quit`에 붙인다.

**Files:**
- Modify: `desktop/src/main.ts`
- Modify: `desktop/src/services/worker.ts` (`stop`을 `stopWorkerProcess`로 넘긴다)
- Modify: `desktop/src/menu.ts` ("서비스 상태" 항목 추가 — 창은 Task 14)

**Interfaces:**
- Consumes: Task 11의 `decideQuit`/`runHandshake`/`stopWorkerProcess`, Task 10의 `window.__damwha_desktop`
- Produces: `main.ts`의 `quitFlow()`

- [ ] **Step 1: 진행 중 판정을 쓴다**

```ts
/**
 * 분석 중인가 — 앱이 소유한 worker에 --once 자식이 있는가. 새 API 엔드포인트를 만들지 않는다.
 * 외부 worker가 하는 일은 우리가 소유하지 않으므로 판정 대상이 아니다 (스펙 §6.9).
 */
async function isAnalysing(): Promise<boolean> {
  const pid = supervisor?.runtimeOf("worker")?.result?.handle?.pid;
  if (pid === undefined) return false;
  try {
    const tree = await descendantPids(pid);
    if (tree.size === 0) return false;
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid,command"], { timeout: 2_000 });
    for (const line of stdout.split("\n")) {
      const t = line.trim();
      const space = t.indexOf(" ");
      if (space <= 0) continue;
      if (!tree.has(Number(t.slice(0, space)))) continue;
      if (/(^|\s)--once(\s|$)/.test(t.slice(space + 1))) return true;
    }
  } catch {
    // 판정 도구가 실패하면 "아니오"로 본다. 확인을 못 띄우는 것이 종료를 막는 것보다 낫다.
  }
  return false;
}

/**
 * 녹음 중인가 — 렌더러의 훅에 묻는다. 캡처는 브라우저가 갖고 있으므로 렌더러만이 안다.
 */
async function isRecording(): Promise<boolean> {
  const target = win;
  if (target === null || target.isDestroyed()) return false;
  try {
    return (await target.webContents.executeJavaScript(
      "Boolean(window.__damwha_desktop?.isRecording?.())",
    )) as boolean;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: `quitFlow()`를 쓴다**

```ts
const STOP_GRACE_MS = 5_000;
/** worker의 stage boundary는 31분 오디오의 STT 한가운데면 분 단위가 될 수 있다. */
const WORKER_GRACE_MS = 90_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;

async function quitFlow(): Promise<void> {
  const state = { recording: await isRecording(), analysing: await isAnalysing() };
  const decision = await decideQuit(state, async (message) => {
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: ["종료", "취소"],
      defaultId: 1,
      cancelId: 1,
      message: "담화를 종료할까요?",
      detail: message,
    });
    return response === 0;
  });
  if (!decision.quit) return;

  quitting = true;
  cancelRetry();

  if (decision.stopRecording) {
    const result = await runHandshake(
      () =>
        win!.webContents.executeJavaScript(
          "window.__damwha_desktop?.stopLiveRecording?.() ?? {stopped:false, reason:'no-bridge'}",
        ) as Promise<{ stopped: boolean; reason?: string }>,
      { timeoutMs: HANDSHAKE_TIMEOUT_MS },
    );
    if (result.kind !== "stopped") {
      // 종료 자체는 막지 않는다. 다음 실행 때 API가 뜨면 sweeper가 봉인·마감한다 (스펙 §6.9).
      appendSupervisorLog(
        `녹음을 정상 중지하지 못했어요 (${result.kind}). 다음 실행 때 서버가 마무리합니다.`,
      );
    }
  }

  const out = (await supervisor?.stopAll({
    graceMs: STOP_GRACE_MS,
    onGraceExpired: async (id) => {
      const { response } = await dialog.showMessageBox({
        type: "question",
        buttons: ["계속 기다리기", "지금 강제 종료"],
        defaultId: 0,
        cancelId: 0,
        message: `${id}를 마무리하는 중이에요.`,
        detail: "분석을 안전한 지점까지 끝내는 중입니다. 강제 종료하면 진행 중인 작업이 나중에 다시 큐에 들어갑니다.",
      });
      return response === 1;
    },
  })) ?? { stopped: true, leaked: [] };

  if (out.leaked.length > 0) {
    // 정리 실패를 조용히 넘기지 않는다 (스펙 §6.9 5단계).
    appendSupervisorLog(`정리하지 못한 프로세스: ${out.leaked.join(", ")}`);
    await dialog.showMessageBox({
      type: "warning",
      message: "일부 프로세스를 정리하지 못했어요.",
      detail: `pid ${out.leaked.join(", ")} — 터미널에서 확인해 주세요. 자세한 내용은 로그에 있습니다.`,
    });
  }
  app.quit();
}
```

`before-quit`을 바꾼다:

```ts
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    // preventDefault로 막았으므로 app.quit()이 반드시 다시 불려야 한다. 거부가 그 호출을
    // 삼키면 앱이 창도 없이 남는다 (Phase 1에서 값을 치른 자리다).
    void quitFlow().catch((e) => {
      appendSupervisorLog(`종료 중 예외 — ${e instanceof Error ? e.message : String(e)}`);
      quitting = true;
      app.quit();
    });
  });
```

- [ ] **Step 3: worker 어댑터의 `stop`을 Task 11의 절차로 넘긴다**

`startServices()`의 `workerSpec` 생성부:

```ts
      workerSpec({
        listExternal: listExternalWorkers,
        stop: (result, graceMs) =>
          stopWorkerProcess(result.handle!, {
            graceMs: Math.max(graceMs, WORKER_GRACE_MS),
            pollMs: 200,
            signal: (pid, sig) => {
              try {
                process.kill(pid, sig);
              } catch {
                // 이미 죽었으면 ESRCH.
              }
            },
            descendants: descendantPids,
            onGraceExpired: async () => currentGraceAnswer,
          }),
      }),
```

`currentGraceAnswer`는 `main.ts`의 모듈 변수다. **대화상자는 감독자 쪽에서 한 번만 띄운다** —
어댑터가 또 띄우면 사용자가 같은 질문을 두 번 받는다.

```ts
/** stopAll의 onGraceExpired가 받은 사람의 답. 어댑터는 묻지 않고 이 값을 읽기만 한다. */
let currentGraceAnswer = false;
```

`quitFlow()`의 `onGraceExpired`가 `currentGraceAnswer = response === 1`로 채운 뒤 그 값을
돌려준다.

- [ ] **Step 4: 메뉴에 "서비스 상태"를 더한다**

`menu.ts`의 시그니처를 `installMenu(handlers: { onRetry(): void; onShowStatus(): void })`로 넓히고
"서비스" 서브메뉴에 항목을 더한다. 기존 "다시 시도"는 그대로 둔다.

- [ ] **Step 5: 종료를 육안으로 확인한다 (분석 중)**

```bash
cd /Users/jason/projects/Damwha2
pnpm desktop:dev
```

앱에서 오디오를 업로드해 `process_meeting`이 `running`이 되게 한 뒤 Cmd+Q. 확인할 것:
1. 확인 대화상자가 뜨고 "분석"을 언급한다.
2. "종료"를 고르면 마무리 대화상자가 뜨거나 조용히 끝난다.
3. 종료 후 `ps -axo pid,command | grep -E "damwha_worker|damwha-embed|mlx_lm"` → 0건.
4. `psql`로 그 job이 `queued`이고 `attempts`가 늘지 않았는지 본다.
5. `docker compose ps` → 컨테이너 생존.

- [ ] **Step 6: 종료를 육안으로 확인한다 (녹음 중)**

앱에서 라이브 녹음을 시작하고 30초쯤 말한 뒤 Cmd+Q. 확인할 것:
1. 확인 대화상자가 "녹음"을 언급한다.
2. "종료" 후 DB에서 그 회의의 `capture_error`가 `producer_abandoned`가 **아니다.**
3. 앱을 다시 띄웠을 때 그 회의가 `recording`에 남아 있지 않다.

- [ ] **Step 7: 전체 테스트·타입 검사 후 커밋**

```bash
pnpm --filter damwha-desktop run test && pnpm --filter damwha-desktop run lint
git add desktop/src/main.ts desktop/src/services/worker.ts desktop/src/menu.ts
git commit -F - <<'MSG'
feat(desktop): 종료를 역순·확인·handshake 경로로 배선한다

녹음 중이거나 분석 중이면 네이티브 대화상자로 확인을 받는다. 분석 중 판정은 앱이
소유한 worker에 --once 자식이 있는가로 한다 — 새 API 엔드포인트를 만들지 않고,
외부 worker가 하는 일은 우리 소유가 아니라 판정 대상이 아니다.

녹음 중 종료는 렌더러의 라이브 중지를 완주시킨 뒤에 진행한다. 그러지 않으면
창이 파괴되면서 마지막 청크가 유실되고, 그 봉인을 하는 sweeper가 API의 @Cron이라
우리가 API도 내리는 이 경로에서는 아무도 봉인하지 않는다.

handshake가 실패해도 종료 자체는 막지 않는다. 그때는 다음 실행 때 API가 뜨면
sweeper가 봉인·마감한다.

정리하지 못한 pid는 화면과 로그에 적는다. 조용히 넘기지 않는다.

Claude-Session: https://claude.ai/code/session_01CSsVbykTbEVYdxm5cLwsTV
MSG
```

**Verify:**
- Step 5의 다섯 항목, Step 6의 세 항목을 모두 눈으로 확인했고 결과를 기록했다.
- `pnpm --filter damwha-desktop run test`·`run lint` → PASS.

**Review:**
- 유예 초과 대화상자가 **한 번만** 뜨는가. 감독자와 어댑터가 각자 띄우면 두 번 묻는다.
- `before-quit`이 `preventDefault` 뒤에 `app.quit()`을 **반드시** 다시 부르는가. 거부 경로에도
  `catch`가 걸려 있는가 (Phase 1이 값을 치른 자리다).
- handshake 실패가 종료를 **막지 않는가.** 막으면 사용자가 앱을 끌 수 없다.
- `isAnalysing`이 판정 도구 실패 시 "아니오"로 닫는가.
- 종료 순서가 worker → embed → api인가. `dependsOn`의 역순이 그것을 만드는가.

---

## Task 14: 서비스 상태 창과 복구 안내

**Files:**
- Create: `desktop/shell/services.html`
- Modify: `desktop/src/shell-window.ts` (상태 창 열기·갱신)
- Modify: `desktop/shell/status.html` (여러 줄 원인 표시)
- Modify: `desktop/src/main.ts` (`renderStatus` 배선)
- Test: `desktop/tests/recovery-hint.test.ts`

**Interfaces:**
- Consumes: Task 3의 `ServiceStatus`
- Produces: `recoveryHint(status: ServiceStatus): string | undefined`

- [ ] **Step 1: 복구 안내 매핑의 실패 테스트를 쓴다**

`desktop/tests/recovery-hint.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { recoveryHint } from "../src/shell-hints";
import type { ServiceStatus } from "../src/services/types";

const s = (over: Partial<ServiceStatus>): ServiceStatus => ({
  id: "api",
  process: "failed",
  health: "unknown",
  owned: true,
  restarts: 0,
  ...over,
});

describe("recoveryHint", () => {
  it("tells the user to start Docker", () => {
    expect(recoveryHint(s({ id: "postgres", detail: "Docker Desktop이 실행 중이 아니에요." })))
      .toMatch(/Docker Desktop/);
  });

  it("tells the user where to put the uv path", () => {
    expect(recoveryHint(s({ id: "worker", detail: "uv를 찾지 못했어요." })))
      .toMatch(/config\.json/);
  });

  it("tells the user to run the migration command", () => {
    expect(recoveryHint(s({ detail: "적용되지 않은 마이그레이션이 3개 있어요" })))
      .toMatch(/pnpm be:migrate/);
  });

  it("tells the user to copy the worker env example", () => {
    expect(recoveryHint(s({ id: "worker", detail: "be/worker/.env가 없어요." })))
      .toMatch(/\.env\.example/);
  });

  it("explains an external worker in terms of STORAGE_ROOT", () => {
    expect(
      recoveryHint(s({ id: "worker", process: "running", owned: false, detail: "외부 worker가 실행 중이에요 (pid 4101)." })),
    ).toMatch(/STORAGE_ROOT/);
  });

  it("says a degraded API recovers on its own", () => {
    expect(recoveryHint(s({ process: "running", health: "degraded", detail: "데이터베이스에 연결할 수 없어요." })))
      .toMatch(/자동으로/);
  });

  it("returns undefined for a healthy service", () => {
    expect(recoveryHint(s({ process: "running", health: "ok" }))).toBeUndefined();
  });

  it("returns undefined for an unrecognised cause rather than inventing one", () => {
    // 모르는 원인에 그럴듯한 안내를 붙이면 사용자를 엉뚱한 곳으로 보낸다.
    expect(recoveryHint(s({ detail: "알 수 없는 오류 0x99" }))).toBeUndefined();
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/recovery-hint.test.ts`
Expected: FAIL — `Cannot find module '../src/shell-hints'`

- [ ] **Step 3: `desktop/src/shell-hints.ts`를 쓴다**

```ts
import type { ServiceStatus } from "./services/types";

/**
 * 원인마다 복구 방법을 짝짓는다. 모르는 원인에는 아무 말도 하지 않는다 — 그럴듯한 안내를
 * 붙이면 사용자를 엉뚱한 곳으로 보낸다 (스펙 §6.12).
 *
 * electron을 import하지 않는 순수 모듈이다. shell-window.ts는 electron을 값으로 가져와
 * vitest가 못 불러오므로, 테스트 대상 로직은 여기 둔다 (Phase 1의 stderr.ts와 같은 이유).
 */
const HINTS: Array<[RegExp, string]> = [
  [/Docker Desktop/, "Docker Desktop을 실행한 뒤 다시 시도해 주세요."],
  [/uv를 찾지 못했어요|docker를 찾지 못했어요/, "설치했는지 확인하거나, config.json의 UV_BIN·DOCKER_BIN에 경로를 적어 주세요."],
  [/마이그레이션/, "터미널에서 `pnpm be:migrate`를 실행한 뒤 다시 시도해 주세요."],
  [/\.env가 없어요/, "be/worker/.env.example을 복사해 값을 채운 뒤 다시 시도해 주세요."],
  [/외부 worker/, "터미널의 worker를 끄고 다시 시도하거나, 그 worker의 STORAGE_ROOT가 앱과 같은지 확인해 주세요."],
  [/저장소 폴더/, "be/worker와 be/docker-compose.yml이 있는 폴더를 골라 주세요."],
  [/모델 .*차원/, "외부 embed 서비스를 끄면 앱이 직접 띄웁니다."],
];

export function recoveryHint(status: ServiceStatus): string | undefined {
  if (status.process === "running" && status.health === "ok") return undefined;
  if (status.health === "degraded") {
    return "의존하는 서비스가 돌아오면 자동으로 복구됩니다. 앱을 다시 시작하지 않아도 됩니다.";
  }
  const detail = status.detail ?? "";
  for (const [re, hint] of HINTS) if (re.test(detail)) return hint;
  return undefined;
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/recovery-hint.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: `services.html`을 쓴다**

표시 전용이다. 버튼도 폼도 없다 — 렌더러에서 main으로 가는 경로를 만들지 않는다는 계약이다.
`window.__damwha_render(statuses)`를 노출하고 main이 `executeJavaScript`로 부른다.
`fe/DESIGN.md`의 톤(여백, 중립 회색, 강조 최소)을 따르고, 서비스별로 이름 · 상태 배지 ·
원인 블록(`white-space: pre-wrap`) · 복구 안내 · 로그 경로를 한 줄씩 보여준다.

- [ ] **Step 6: `status.html`의 원인 표시를 여러 줄로 고친다**

`detail`을 `textContent`로 넣는 자리에 `white-space: pre-wrap`을 주고, 줄 수 상한을 CSS로 둔다.
Phase 1은 한 줄을 가정했다.

- [ ] **Step 7: `main.ts`에 상태 창을 배선한다**

```ts
let statusWin: BrowserWindow | null = null;

function showServicesWindow(): void {
  if (statusWin !== null && !statusWin.isDestroyed()) {
    statusWin.focus();
    return;
  }
  statusWin = new BrowserWindow({
    width: 640,
    height: 520,
    title: "서비스 상태",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  statusWin.on("closed", () => {
    statusWin = null;
  });
  void statusWin.loadFile(path.join(app.getAppPath(), "shell", "services.html"));
}

/**
 * main → 렌더러 한 방향. 재로드 대신 함수를 부르는 이유는 상태가 바뀔 때마다 창이 깜빡이지
 * 않게 하기 위해서다. 렌더러가 main을 부를 경로는 여전히 없다 (스펙 §6.11).
 */
function renderStatus(statuses: ServiceStatus[]): void {
  const payload = statuses.map((s) => ({ ...s, hint: recoveryHint(s), log: logPathOf(s.id) }));
  if (statusWin === null || statusWin.isDestroyed()) return;
  void statusWin.webContents
    .executeJavaScript(`window.__damwha_render?.(${JSON.stringify(payload)})`)
    .catch(() => undefined);
}
```

실패한 게이트 서비스가 생기면 상태 창을 **자동으로 연다.**

- [ ] **Step 8: 육안 확인**

```bash
cd /Users/jason/projects/Damwha2
pnpm desktop:dev
```

1. 메뉴 → 서비스 → 서비스 상태로 창이 열리고 넷이 보인다.
2. 터미널에서 `docker compose -f be/docker-compose.yml stop postgres` → api가 **degraded**로
   바뀌고 "자동으로 복구됩니다" 안내가 뜬다. **재시작 로그가 남지 않는다.**
3. `docker compose ... start postgres` → api가 `ok`로 돌아온다.
4. `config.json`의 `SUMMARY_LLM_MODEL`을 카탈로그 밖 값으로 바꾸고 재시도 → 실패 화면에
   **여러 줄 원인**이 보인다(`startup failed: [`에서 끊기지 않는다). 확인 후 원복한다.

- [ ] **Step 9: 전체 테스트·타입 검사 후 커밋**

```bash
pnpm --filter damwha-desktop run test && pnpm --filter damwha-desktop run lint
git add desktop/src/shell-hints.ts desktop/tests/recovery-hint.test.ts desktop/shell/services.html desktop/shell/status.html desktop/src/shell-window.ts desktop/src/main.ts
git commit -F - <<'MSG'
feat(desktop): 서비스 상태 창과 원인별 복구 안내를 더한다

표시 전용 창이다. 버튼도 폼도 없다 — 렌더러에서 main으로 가는 경로를 만들지
않는다는 Phase 1의 계약을 유지한다. 갱신은 main이 executeJavaScript로 하고,
재로드가 아니라 함수 호출이라 상태가 바뀔 때마다 창이 깜빡이지 않는다.

원인마다 복구 방법을 짝짓되 모르는 원인에는 아무 말도 하지 않는다. 그럴듯한
안내를 붙이면 사용자를 엉뚱한 곳으로 보낸다.

status.html의 원인 표시를 여러 줄로 고친다. Phase 1은 한 줄을 가정해 zod 같은
여러 줄 원인이 `startup failed: [`까지만 보였다.

Claude-Session: https://claude.ai/code/session_01CSsVbykTbEVYdxm5cLwsTV
MSG
```

**Verify:**
- Step 8의 네 항목을 눈으로 확인했다. 특히 2번에서 **재시작이 일어나지 않았다**(로그로 확인).
- `pnpm --filter damwha-desktop run test`·`run lint` → PASS.

**Review:**
- `services.html`에 `<button>`·`<form>`·`ipcRenderer`가 **0건**인가. 있으면 무-IPC 계약이 깨진다.
- `recoveryHint`가 모르는 원인에 `undefined`를 돌려주는가.
- `renderStatus`가 `executeJavaScript` 거부를 삼키는가. 창이 파괴되는 순간과 겹치면 거부가 온다.
- `shell-hints.ts`가 `electron`을 import하지 않는가 (vitest가 불러올 수 있어야 한다).
- degraded 안내가 "다시 시작하세요"라고 말하지 **않는가.** 재시작은 이 경우 도움이 안 된다.

---

## Task 15: 통합 검증과 결과 기록

구현을 더하지 않는다. 완료 기준 15건을 실제로 판정하고 증거를 남긴다.

**Files:**
- Modify: `docs/superpowers/reports/2026-09-12-electron-phase-2-service-orchestration-results.md`
- Modify: `docs/electron-migration-roadmap.md` (Phase 2 상태, Phase 4 인계)
- Modify: `be/CLAUDE.md`, `fe/CLAUDE.md` (운영 문서)

**Interfaces:**
- Consumes: Task 1~14 전부
- Produces: 판정된 완료 기준과 증거

- [ ] **Step 1: 검증 전 기준선을 뜬다 (P2-C15용)**

```bash
cd /Users/jason/projects/Damwha2
mkdir -p ~/.cache/damwha-p2-evidence
find be/storage -type f -exec shasum {} \; | sort > ~/.cache/damwha-p2-evidence/storage-before.txt
docker compose -f be/docker-compose.yml exec -T postgres psql -U postgres -d damwha -t -c \
  "select (select count(*) from meeting), (select count(*) from utterance), (select count(*) from _migrations);" \
  > ~/.cache/damwha-p2-evidence/counts-before.txt
docker compose -f be/docker-compose.yml config | grep -E "^name:|pgdata" > ~/.cache/damwha-p2-evidence/compose-before.txt
cp be/worker/.env ~/.cache/damwha-p2-evidence/worker.env.before
cat ~/.cache/damwha-p2-evidence/counts-before.txt
```

**`be/worker/.env`를 고치지 않는다.** P2-C2가 그 파일이 불변인 채로 처리가 완주하는지를 본다.

- [ ] **Step 2: packaged 앱을 만든다**

```bash
pnpm install
pnpm build
pnpm desktop:build
ls -la desktop/out/mac-arm64/Damwha.app
```

- [ ] **Step 3: P2-C1 — 터미널 없이 전체 서비스 준비**

```bash
docker compose -f be/docker-compose.yml down
pkill -f damwha_worker; pkill -f damwha-embed
ps -axo pid,command | grep -cE "[d]amwha_worker|[d]amwha-embed"   # 0이어야 한다
```

Finder에서 `Damwha.app`을 더블클릭한다. **터미널 명령을 하나도 실행하지 않는다.** 메뉴 →
서비스 → 서비스 상태를 열어 넷이 `running`/`ok`인지 본다. 스크린샷을 증거로 남긴다.

- [ ] **Step 4: P2-C2·P2-C3 — 업로드 처리와 의미 검색**

앱에서 오디오 파일로 회의를 만들고 처리 완주까지 둔다. 그 뒤 검색어를 넣는다.

```bash
shasum be/worker/.env; shasum ~/.cache/damwha-p2-evidence/worker.env.before
```

두 해시가 같아야 한다 — Phase 1의 수동 합의가 사라졌다는 증거다.

- [ ] **Step 5: P2-C4·P2-C5 — 트리 정리와 정중한 종료**

분석 job을 하나 돌리는 중에 Cmd+Q, 대화상자에서 "종료".

```bash
ps -axo pid,command | grep -E "[d]amwha_worker|[d]amwha-embed|[m]lx_lm" || echo "남은 프로세스 0건"
docker compose -f be/docker-compose.yml ps
docker compose -f be/docker-compose.yml exec -T postgres psql -U postgres -d damwha -c \
  "select id, status, attempts from job order by created_at desc limit 3;"
```

`mlx_lm.server` 조건을 만들 수 없으면 **그 사실을 결과 문서에 적고** `--once` 자식이 있는 상태의
강제 종료로 자손 SIGKILL을 대신 판정한다 (스펙 P2-C4 비고).

- [ ] **Step 6: P2-C6 — 외부 서비스 보존**

```bash
pnpm worker > /tmp/ext-worker.log 2>&1 &
pnpm embed > /tmp/ext-embed.log 2>&1 &
sleep 40
```

앱을 실행한다. 상태 창에서 worker가 외부라고 경고하고 embed가 채택됐는지 본다. 앱을 종료한 뒤:

```bash
ps -axo pid,command | grep -cE "[d]amwha_worker|[d]amwha-embed"   # 2 이상이어야 한다
kill %1 %2
```

- [ ] **Step 7: P2-C7·P2-C8 — 실패 표시**

Docker Desktop을 종료하고 앱 실행 → 원인·복구 안내 확인 → Docker를 켜고 재시도.
`config.json`의 `UV_BIN`을 없는 경로로 바꾸고 앱 실행 → 원인 확인 → 원복.

- [ ] **Step 8: P2-C9 — 마이그레이션 게이트**

```bash
docker compose -f be/docker-compose.yml exec -T postgres \
  psql -U postgres -d postgres -c "CREATE DATABASE damwha_migration_gate;"
```

`config.json`의 `DATABASE_URL`을 그 DB로 바꾸고 앱 실행. 담화 화면에 닿지 않고 `pnpm be:migrate`
안내가 뜨는지, worker가 뜨지 않는지 본다. 확인 후:

```bash
docker compose -f be/docker-compose.yml exec -T postgres \
  psql -U postgres -d postgres -c "DROP DATABASE damwha_migration_gate;"
```

`config.json`을 원복한다.

- [ ] **Step 9: P2-C10·P2-C11 — 준비 오판 방지와 degraded**

앱이 넷을 다 띄운 상태에서:

```bash
docker compose -f be/docker-compose.yml stop postgres
# 상태 창: api가 running/degraded, 재시작 로그 없음
pkill -f "damwha_worker"   # 앱이 소유한 worker를 죽여 재시작을 발화시킨다
# 상태 창: 재시작된 worker가 ok로 가지 않고 failed가 된다
grep -c "ready (db connected)" ~/Library/Application\ Support/Damwha/logs/worker.log
docker compose -f be/docker-compose.yml start postgres
# 상태 창: api가 ok로 복귀
```

- [ ] **Step 10: P2-C12·P2-C13 — 수명주기**

분석 중 창을 닫아 앱·서비스 생존과 분석 계속을 확인하고 Dock으로 창을 되살린다.
라이브 녹음 중 Cmd+Q → 대화상자 → 종료 후 DB 확인:

```bash
docker compose -f be/docker-compose.yml exec -T postgres psql -U postgres -d damwha -c \
  "select id, status, capture_error from meeting order by created_at desc limit 2;"
```

`capture_error`가 `producer_abandoned`가 **아니어야** 한다. 앱 재실행 후 그 회의가 `recording`에
없어야 한다.

- [ ] **Step 11: P2-C14 — 회귀와 번들 위생**

```bash
pnpm install && pnpm build && pnpm test && pnpm lint
pnpm worker:test
docker build -f deploy/api.Dockerfile . -t damwha-api-regression
node desktop/scripts/check-bundle.mjs
pnpm dev   # Electron 창이 뜨지 않는지 확인하고 Ctrl+C
```

- [ ] **Step 12: P2-C15 — 데이터 보존**

```bash
find be/storage -type f -exec shasum {} \; | sort > ~/.cache/damwha-p2-evidence/storage-after.txt
diff ~/.cache/damwha-p2-evidence/storage-before.txt ~/.cache/damwha-p2-evidence/storage-after.txt && echo "be/storage 불변"
docker compose -f be/docker-compose.yml exec -T postgres psql -U postgres -d damwha -t -c \
  "select (select count(*) from meeting), (select count(*) from utterance), (select count(*) from _migrations);"
docker compose -f be/docker-compose.yml config | grep -E "^name:|pgdata"
```

`_migrations` 행 수가 Step 1과 같아야 한다 — 앱이 마이그레이션을 실행하지 않았다는 증거다.

- [ ] **Step 13: 결과 문서를 채운다**

`## 3. 단계별 실행과 리뷰`에 Task 1~14의 커밋 해시·검증 명령·리뷰 지적과 조치를 적는다.
`## 4. 최종 검증`에 P2-C1~C15의 판정과 증거를 적는다. **실행하지 않은 검증을 성공으로 적지
않는다** — 못 한 것은 못 했다고 적고 이유를 남긴다.
`## 5. 남은 제약과 후속 Phase 인계`에 남은 한계, 구현 값(유예 시간, 로그 회전, 준비 유예)과
그 근거를 적는다. Phase 1에서 넘어온 확인 항목(`unverified-owner` 종단간, R1-6 TCC 재요청)의
결과도 적는다.

- [ ] **Step 14: 로드맵과 운영 문서를 갱신한다**

로드맵의 Phase 2 절에 상태와 판정 표를 더한다(Phase 1 절과 같은 형식). Phase 4 범위에
`FFMPEG_BIN`/`FFPROBE_BIN` 항목을 명시한다 — 번들 ffmpeg만으로는 부족하다는 사실이다.

`be/CLAUDE.md`에 worker의 ready 로그 계약을, `fe/CLAUDE.md`에 `window.__damwha_desktop` 훅을
한 줄씩 더한다.

- [ ] **Step 15: 커밋**

```bash
git add docs/ be/CLAUDE.md fe/CLAUDE.md
git commit -F - <<'MSG'
docs: Phase 2 통합 검증 결과와 운영 문서를 갱신한다

완료 기준 15건의 판정과 증거를 결과 문서에 기록한다. 구현 값(종료 유예, 로그
회전, 준비 유예)과 그 근거도 함께 남긴다.

로드맵의 Phase 4 범위에 FFMPEG_BIN/FFPROBE_BIN을 명시한다 — worker의
pipeline/ffmpeg.py가 두 실행 파일을 리터럴로 부르므로 번들 ffmpeg를 넣는
것만으로는 개발 도구 없는 맥에서 동작하지 않는다.

Claude-Session: https://claude.ai/code/session_01CSsVbykTbEVYdxm5cLwsTV
MSG
```

**Verify:**
- 결과 문서의 P2-C1~C15 판정 칸이 **전부 채워져 있고** 각 칸에 실제 명령·출력·스크린샷 경로가 있다.
- 미판정 항목이 있으면 "미판정"으로 적혀 있고 이유가 있다. 빈칸이 없다.
- `git status`가 깨끗하다.

**Review:**
- 판정이 **실행 결과에서 왔는가.** 돌리지 않은 검증을 통과로 적지 않았는가.
- P2-C15의 `be/storage` diff가 실제로 0줄인가.
- P2-C2의 `be/worker/.env` 해시가 검증 전후로 같은가. 이 Phase의 존재 이유가 그 한 줄이다.
- 완료 기준을 충족하지 못한 것이 있으면 Phase를 **미완료로 유지**했는가. 범위 변경으로 해결하려면
  변경 내용을 명시하고 스펙 리뷰를 다시 거쳐야 한다.
- 로드맵과 `be/CLAUDE.md`·`fe/CLAUDE.md`가 실제 구현과 맞는가.

---

## 자기 검토 (계획 작성자)

**1. 스펙 커버리지.** 스펙의 각 절이 어느 Task로 가는가.

| 스펙 | Task |
| --- | --- |
| §6.1 패키지 구조 | 2·3·4·5·6·8·9·11 (파일 생성) |
| §6.2 서비스 실행 계약 | 3 |
| §6.3 실행 파일 해석과 PATH | 2·8 |
| §6.4 경로·설정 계약 (`REPO_ROOT`, env 주입) | 2·8·12 |
| §6.5 소유권 계약 | 4·5·8 |
| §6.6 준비 상태 계약 | 3·6·7·8 |
| §6.7 시작 순서와 게이트, 마이그레이션 | 3·6·12 |
| §6.8 재시작 정책 | 3·5·6·8 |
| §6.9 종료 계약과 handshake | 10·11·13 |
| §6.10 창 닫기와 앱 종료 | 12·13 |
| §6.11 보안 경계 | 10·13·14 |
| §6.12 로그와 실패 표시 | 6·9·14 |
| §9 완료 기준 P2-C1~C15 | 15 |
| §10 제품 코드 변경 2건 | 7 (worker), 10 (fe) |
| §12 미확정 사항 | 1 (실측), 나머지는 해당 Task에서 값 확정 |
| §15 후속 Phase 인계 | 15 |

빠진 절 없음.

**2. 플레이스홀더.** "TBD"·"적절히 처리"·"비슷하게" 0건. 코드 단계는 전부 실제 코드를 담는다.
Task 5·6·8의 상수는 Task 1·6·8의 실측으로 **교체하라고 명시**했다 — 이것은 플레이스홀더가 아니라
측정 의존성이고, 그 Task의 Verify가 교체 여부를 확인한다.

**3. 타입 일관성.** `ServiceSpec`·`LaunchResult`·`ReadinessResult`·`StopOutcome`은 Task 3에서
정의하고 4·5·6·8·11이 같은 이름으로 쓴다. `ServiceHandle`은 Phase 1의 `ApiHandle` 별칭이라
`stop(graceMs)`를 갖는다 — Task 8의 `launchWithUv`가 그 모양을 만들고 Task 11의
`stopWorkerProcess`가 `alive()`·`pid`만 쓴다. `workerReady`/`workerDegraded`는 Task 8에서
정의하고 Task 8 안에서만 쓴다. `recoveryHint`는 Task 14에서 정의하고 Task 14 안에서만 쓴다.
`hasLiveCapture`/`stopActiveLiveCapture`는 Task 10에서 정의하고 Task 10의 브리지만 쓴다.

**4. 데이터 안전.** 파괴적 명령이 나오는 곳은 Task 6 Step 6과 Task 15 Step 8의
`CREATE/DROP DATABASE`뿐이고 둘 다 **새로 만든 빈 DB**를 대상으로 하며 정리 단계가 붙어 있다.
`docker compose down`은 Task 15 Step 3에서 한 번 쓰는데, 그것은 P2-C1이 요구하는 "전부 꺼진
상태"를 만들기 위한 검증자의 행위이지 앱의 행위가 아니다 — 볼륨은 `down`으로 지워지지 않는다
(`-v`를 붙이지 않는다).
