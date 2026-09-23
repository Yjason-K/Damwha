# Electron Phase 6b-1 — 새 버전 알림 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설치된 데스크톱 앱이 GitHub Releases에서 새 버전을 찾아 네이티브 대화상자로 알리고, 앞으로의 릴리스 태그를 `v<version>`으로 되돌린다.

**Architecture:** `desktop/src/update/`에 electron을 import하지 않는 순수 모듈 다섯(조회·상태·정책·대화상자 옵션·스케줄러)과 모달 추적기를 두고, `main.ts`는 잎(fetch·dialog·shell·타이머 무장 시점)만 주입한다 — `app/window-flow.ts`·`app/quit-flow.ts`와 같은 나눔이다. 메뉴 템플릿은 `windows/menu-template.ts`로 떼어 시험한다. 발행 도구의 태그 규칙은 `scripts/lib/release-tag.mjs`로 떼어 시험한다.

**Tech Stack:** Electron 44.3.0 main process, TypeScript 5.9 (CommonJS), vitest 4, Node 22 전역 `fetch`.

**Spec:** `docs/superpowers/specs/2026-09-23-electron-phase-6b-update-notice-design.md` — 계획은 스펙을 근거로 한다. 실행자는 둘 다 읽는다.

## Global Constraints

- 새 릴리스 태그는 `v<major>.<minor>.<patch>`. 이미 나간 `desktop-v0.3.0`·`desktop-v0.3.1`은 이름을 바꾸지 않는다.
- 조회 태그 정규식: `^(?:desktop-)?v(\d+)\.(\d+)\.(\d+)$`. 설치 버전 정규식: `^(\d+)\.(\d+)\.(\d+)$`.
- 조회 URL: `https://api.github.com/repos/Yjason-K/Damwha/releases?per_page=100`. 헤더 `Accept: application/vnd.github+json`, `User-Agent: Damwha/<current>`, `X-GitHub-Api-Version: 2022-11-28`.
- 다운로드 URL은 응답에서 받지 않고 `https://github.com/Yjason-K/Damwha/releases/tag/<tag>`로 만든다.
- 조회 상한 10초(모든 페이지·본문 포함), 페이지 상한 5, 한도 기본 대기 60분.
- 자동 확인 주기 24시간(86,400,000ms). env `DAMWHA_UPDATE_CHECK_INTERVAL_MS`는 유한 정수 60,000 ≤ 값 ≤ 86,400,000만 받는다.
- 자동 확인은 `app.isPackaged`일 때만. 수동 메뉴는 dev·packaged 둘 다.
- 새 버전 대화상자 버튼 순서 `["다운로드 페이지 열기", "나중에", "이 버전 건너뛰기"]`, `defaultId: 0`, `cancelId: 1`.
- 건너뛴 버전 파일 `<userData>/update-state.json`, 모양 `{ "skippedVersion": "x.y.z" }`. `config.json`에 넣지 않는다.
- `src/update/*`와 `src/windows/menu-template.ts`는 electron을 **값으로** import하지 않는다(`import type`만).
- 새 의존성 없음 (semver 라이브러리 금지).
- 명령은 저장소 루트에서: `pnpm desktop test`, `pnpm desktop lint`. 단일 파일은 `pnpm --filter damwha-desktop exec vitest run <path>`. **`pnpm desktop exec …`를 쓰지 않는다** — 루트의 `desktop` 스크립트는 `run`으로 펼쳐져 `None of the selected packages has a "exec" script`를 찍고 **exit 0**으로 끝난다(테스트를 하나도 돌리지 않는 거짓 초록불, 계획 검증 #1).
- 커밋 메시지는 기존 관례: `feat(desktop): …`, `test(desktop): …`, `build(release): …`, `docs(phase6b): …`, 한국어 본문.

---

## File Structure

| 파일 | 책임 |
| --- | --- |
| `desktop/scripts/lib/release-tag.mjs` (신규) | 릴리스 태그 규칙 — `releaseTagFor`, `describeReleaseTag`, `assertReleaseTag` |
| `desktop/scripts/package.mjs` (수정) | 위 lib로 `--release` 태그 검사 |
| `desktop/scripts/publish.sh` (수정) | `TAG="v$VERSION"` |
| `desktop/src/update/release-check.ts` (신규) | 버전 파싱·비교, 후보 선택, 페이지·한도 처리, `checkForUpdate` |
| `desktop/src/update/update-state.ts` (신규) | 건너뛴 버전 영속화 |
| `desktop/src/update/dialogs.ts` (신규) | 대화상자 옵션·선택 해석·실패 문구 |
| `desktop/src/update/update-flow.ts` (신규) | 자동/수동 확인 정책, 조회 공유, 표시 잠금, 쿨다운 |
| `desktop/src/update/scheduler.ts` (신규) | 주기 env 검증, 1회 무장, 해제 |
| `desktop/src/update/modal-tracker.ts` (신규) | 다른 앱 모달이 떠 있는지 세는 카운터 |
| `desktop/src/windows/menu-template.ts` (신규) | 앱 메뉴 템플릿(순수) |
| `desktop/src/windows/menu.ts` (수정) | 템플릿으로 메뉴 설치 |
| `desktop/src/main.ts` (수정) | 배선 |
| `desktop/tests/scripts/release-tag.test.ts`, `desktop/tests/update/*.test.ts`, `desktop/tests/windows/menu-template.test.ts` (신규) | 단위 테스트 |
| `desktop/CLAUDE.md`, `deploy/demo/README.md`, `docs/electron-migration-roadmap.md` (수정) | 문서 |
| `docs/superpowers/reports/2026-09-23-electron-phase-6b-update-notice-results.md` (신규) | 실측 결과 |

---

### Task 1: 릴리스 태그를 `v<version>`으로

**Files:**
- Create: `desktop/scripts/lib/release-tag.mjs`
- Modify: `desktop/scripts/package.mjs:18-33`
- Modify: `desktop/scripts/publish.sh:4,12,18-19,54`
- Modify: `desktop/CLAUDE.md:101-102` (태그 네임스페이스 문단), `desktop/CLAUDE.md:103-110`의 `desktop-v<version>`·`desktop-v<ver>` 표기
- Modify: `deploy/demo/README.md:4`
- Test: `desktop/tests/scripts/release-tag.test.ts`

**Interfaces:**
- Produces: `releaseTagFor(version: string): string`, `describeReleaseTag(repoDir: string): string | null`, `assertReleaseTag(tag: string | null, version: string): void` (어긋나면 `Error`).

- [ ] **Step 1: Write the failing test**

`desktop/tests/scripts/release-tag.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertReleaseTag, describeReleaseTag, releaseTagFor } from "../../scripts/lib/release-tag.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function repoWithTags(tags: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-tag-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "c");
  for (const t of tags) git("tag", t);
  return dir;
}

describe("releaseTagFor", () => {
  it("v 접두사 하나만 붙인다", () => {
    expect(releaseTagFor("0.4.0")).toBe("v0.4.0");
  });
});

describe("describeReleaseTag", () => {
  it("HEAD의 v* 태그를 읽는다", () => {
    expect(describeReleaseTag(repoWithTags(["v0.4.0"]))).toBe("v0.4.0");
  });
  it("옛 desktop-v* 태그만 있으면 null이다", () => {
    expect(describeReleaseTag(repoWithTags(["desktop-v0.4.0"]))).toBeNull();
  });
  it("태그가 없으면 null이다", () => {
    expect(describeReleaseTag(repoWithTags([]))).toBeNull();
  });
});

describe("assertReleaseTag", () => {
  it("버전과 맞는 v 태그는 통과한다", () => {
    expect(() => assertReleaseTag("v0.4.0", "0.4.0")).not.toThrow();
  });
  it("태그가 없으면 기대 태그를 말하며 던진다", () => {
    expect(() => assertReleaseTag(null, "0.4.0")).toThrow(/v0\.4\.0여야 한다/);
  });
  it("버전이 다르면 던진다", () => {
    expect(() => assertReleaseTag("v0.3.9", "0.4.0")).toThrow(/v0\.3\.9/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter damwha-desktop exec vitest run tests/scripts/release-tag.test.ts`
Expected: FAIL — `Failed to resolve import "../../scripts/lib/release-tag.mjs"`

- [ ] **Step 3: Write minimal implementation**

`desktop/scripts/lib/release-tag.mjs`:

```js
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
```

`desktop/scripts/package.mjs` — import 줄에 더한다:

```js
import { assertReleaseTag, describeReleaseTag } from "./lib/release-tag.mjs";
```

`package.mjs:18-33`(주석 `// 릴리스에서만 태그를 본다.`부터 `if (RELEASE) { … }` 블록 끝까지)를 다음으로 바꾼다:

```js
// 릴리스에서만 태그를 본다. 개발 중 패키징이 잦아 태그 없는 커밋에서 자주 돈다.
// 태그 규칙(v<version>)과 그 이유는 lib/release-tag.mjs에 있다 (Phase 6b-1 스펙 §3-2).
const desktopPkg = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
if (RELEASE) {
  assertReleaseTag(describeReleaseTag(repo), desktopPkg.version);
}
```

그 아래에서 `expectedTag`를 쓰는 곳이 있는지 확인한다: `grep -n expectedTag desktop/scripts/package.mjs` — 있으면 `releaseTagFor(desktopPkg.version)`로 바꾸고 import에 `releaseTagFor`를 더한다.

`desktop/scripts/publish.sh`:
- 4행 주석: `` `desktop-v<version>` `` → `` `v<version>` ``
- 12행 주석: `` 태그 `desktop-v<version>`이 `` → `` 태그 `v<version>`이 ``
- 54행: `TAG="desktop-v$VERSION"` → `TAG="v$VERSION"`
- 18-19행 주석 `` — `v*` 릴리스는 과거 기록으로만 남는다. `` → `` — 웹 배포의 `v0.1.1`~`v0.2.3`은 과거 기록으로만 남고, 2026-09-23부터 데스크톱이 `v<version>` 태그를 쓴다(lib/release-tag.mjs). ``
- 확인: `grep -n "desktop-v" desktop/scripts/publish.sh` 결과가 비어야 한다.

`desktop/CLAUDE.md:101-102`의 문단을 바꾼다:

```markdown
- **태그는 `v<version>`이다 (2026-09-23~, Phase 6b-1 스펙 §3-2).** 6a는 웹 배포의 `v<version>`과
  구분하려고 `desktop-v<version>`을 썼고, 웹 배포를 걷어낸 뒤 관례대로 되돌렸다. 이미 나간
  `desktop-v0.3.0`·`desktop-v0.3.1`은 이름을 바꾸지 않는다(공유된 링크). 앱의 새 버전 조회
  (`src/update/release-check.ts`)는 `v*`와 옛 `desktop-v*`를 다 읽는다. 규칙은
  `scripts/lib/release-tag.mjs` 한 곳에 있다.
```

같은 파일 103-110행의 `` `desktop-v<version>` ``·`` `desktop-v<ver>` ``를 `` `v<version>` ``·`` `v<ver>` ``로 바꾼다. 112-117행의 2026-09-21 사고 기록 속 `desktop-v0.3.0`은 **역사라 그대로 둔다.**

`deploy/demo/README.md:4`: `` `desktop-v<ver>` `` → `` `v<ver>` ``.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter damwha-desktop exec vitest run tests/scripts/release-tag.test.ts`
Expected: PASS (7 tests)

Run: `node -e "import('./desktop/scripts/lib/release-tag.mjs').then(m => { m.assertReleaseTag(m.describeReleaseTag('.'), '0.3.1') })"`
Expected: 던진다 — `태그가 (없음)인데 package.json은 0.3.1이다 — v0.3.1여야 한다` (HEAD에 v 태그가 없다 — P6b1-C10의 static 판정 근거)

- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/lib/release-tag.mjs desktop/scripts/package.mjs desktop/scripts/publish.sh desktop/tests/scripts/release-tag.test.ts desktop/CLAUDE.md deploy/demo/README.md
git commit -m "build(release): 데스크톱 릴리스 태그를 v<version>으로 되돌린다"
```

---

### Task 2: 릴리스 조회 — `release-check.ts`

**Files:**
- Create: `desktop/src/update/release-check.ts`
- Test: `desktop/tests/update/release-check.test.ts`

**Interfaces:**
- Produces (later tasks rely on these exact names):
  ```ts
  export type FailReason = "offline" | "timeout" | "rate_limited" | "http" | "malformed" | "no_release";
  export type CheckResult =
    | { kind: "newer"; version: string; url: string }
    | { kind: "current"; latest: string }
    | { kind: "failed"; reason: FailReason; detail: string; retryAfterMs?: number };
  export const DEFAULT_RATE_LIMIT_WAIT_MS: number;
  export const INSTALLED_VERSION_SHAPE: RegExp;
  export interface ReleaseFetchInit { method: "GET"; headers: Record<string, string>; signal: AbortSignal }
  export interface ReleaseFetchResponse { status: number; headers: { get(name: string): string | null }; text(): Promise<string> }
  export type ReleaseFetch = (url: string, init: ReleaseFetchInit) => Promise<ReleaseFetchResponse>;
  export function checkForUpdate(current: string, deps: { fetch: ReleaseFetch; now(): number; timeoutMs?: number }): Promise<CheckResult>;
  ```

- [ ] **Step 1: Write the failing test**

`desktop/tests/update/release-check.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  checkForUpdate,
  compareVersions,
  DEFAULT_RATE_LIMIT_WAIT_MS,
  pickLatest,
  RELEASE_PAGE_BASE,
  RELEASES_URL,
  type ReleaseFetch,
  type ReleaseFetchInit,
} from "../../src/update/release-check";

type Page = { status?: number; headers?: Record<string, string>; body: unknown };

function fakeFetch(pages: Record<string, Page>) {
  const calls: { url: string; init: ReleaseFetchInit }[] = [];
  const fetch: ReleaseFetch = async (url, init) => {
    calls.push({ url, init });
    const p = pages[url];
    if (p === undefined) throw new Error(`예상하지 못한 요청: ${url}`);
    const h = new Map(Object.entries(p.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: p.status ?? 200,
      headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
      text: async () => (typeof p.body === "string" ? p.body : JSON.stringify(p.body)),
    };
  };
  return { fetch, calls };
}

const rel = (tag: string, over: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  html_url: "https://evil.example/not-github",
  ...over,
});

function run(current: string, body: unknown, now = 0) {
  const f = fakeFetch({ [RELEASES_URL]: { body } });
  return checkForUpdate(current, { fetch: f.fetch, now: () => now });
}

describe("compareVersions", () => {
  it("자릿수가 다른 마이너를 숫자로 비교한다", () => {
    expect(compareVersions([0, 10, 0], [0, 9, 0])).toBe(1);
    expect(compareVersions([0, 9, 0], [0, 10, 0])).toBe(-1);
    expect(compareVersions([1, 2, 3], [1, 2, 3])).toBe(0);
  });
});

describe("pickLatest", () => {
  it("같은 버전이 두 형식으로 있으면 v 태그를 고른다", () => {
    expect(pickLatest([rel("desktop-v0.4.0"), rel("v0.4.0")])?.tag).toBe("v0.4.0");
    expect(pickLatest([rel("v0.4.0"), rel("desktop-v0.4.0")])?.tag).toBe("v0.4.0");
  });
});

describe("checkForUpdate — 판정", () => {
  it("더 높은 v 릴리스를 찾고 URL은 태그로 만든다", async () => {
    const r = await run("0.3.1", [rel("v0.2.3"), rel("v0.4.0"), rel("desktop-v0.3.1")]);
    expect(r).toEqual({ kind: "newer", version: "0.4.0", url: `${RELEASE_PAGE_BASE}v0.4.0` });
  });

  it("옛 desktop-v 태그도 읽는다", async () => {
    const r = await run("0.3.0", [rel("desktop-v0.3.1"), rel("v0.2.3")]);
    expect(r).toEqual({ kind: "newer", version: "0.3.1", url: `${RELEASE_PAGE_BASE}desktop-v0.3.1` });
  });

  it("목록 순서와 무관하게 최대를 고른다 (0.10.0 > 0.9.0)", async () => {
    const r = await run("0.8.0", [rel("v0.9.0"), rel("v0.10.0"), rel("v0.2.0")]);
    expect(r).toMatchObject({ kind: "newer", version: "0.10.0" });
  });

  it("후보가 아닌 것을 모두 거른다", async () => {
    const r = await run("0.3.1", [
      rel("v9.0.0", { prerelease: true }),
      rel("v8.0.0", { draft: true }),
      rel("v7.0.0-rc1"),
      rel("desktop-v6.0.0-rc1"),
      rel("web-v5.0.0"),
      rel("4.0.0"),
      { tag_name: "v3.0.0", prerelease: false },
      rel("v2.5.0", { draft: "false" }),
      rel("v2.4.0", { prerelease: 0 }),
      rel("v0.3.2"),
    ]);
    expect(r).toMatchObject({ kind: "newer", version: "0.3.2" });
  });

  it("설치 버전이 더 높거나 같으면 current", async () => {
    expect(await run("0.4.0", [rel("v0.3.1")])).toEqual({ kind: "current", latest: "0.3.1" });
    expect(await run("0.3.1", [rel("v0.3.1")])).toEqual({ kind: "current", latest: "0.3.1" });
  });

  it("유효한 후보가 없으면 no_release — current라고 말하지 않는다", async () => {
    expect(await run("0.3.1", [])).toMatchObject({ kind: "failed", reason: "no_release" });
    expect(await run("0.3.1", [null, 3, "x", { tag_name: 1 }])).toMatchObject({ kind: "failed", reason: "no_release" });
  });

  it("설치 버전이 형식 밖이면 요청하지 않고 malformed", async () => {
    const f = fakeFetch({});
    const r = await checkForUpdate("0.3.1-dev", { fetch: f.fetch, now: () => 0 });
    expect(r).toMatchObject({ kind: "failed", reason: "malformed" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("checkForUpdate — 요청과 페이지", () => {
  it("GitHub이 요구하는 헤더를 싣는다", async () => {
    const f = fakeFetch({ [RELEASES_URL]: { body: [rel("v0.3.1")] } });
    await checkForUpdate("0.3.1", { fetch: f.fetch, now: () => 0 });
    expect(f.calls[0].init.headers).toMatchObject({
      Accept: "application/vnd.github+json",
      "User-Agent": "Damwha/0.3.1",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  });

  it("Link: next를 따라가 둘째 페이지의 후보를 찾는다", async () => {
    const p2 = "https://api.github.com/repositories/1/releases?per_page=100&page=2";
    const f = fakeFetch({
      [RELEASES_URL]: { headers: { Link: `<${p2}>; rel="next", <${p2}>; rel="last"` }, body: [rel("v0.2.3")] },
      [p2]: { body: [rel("v0.5.0")] },
    });
    const r = await checkForUpdate("0.3.1", { fetch: f.fetch, now: () => 0 });
    expect(r).toMatchObject({ kind: "newer", version: "0.5.0" });
    expect(f.calls).toHaveLength(2);
  });

  it("페이지 상한(5)에 닿고도 다음이 있으면 malformed", async () => {
    const url = (n: number) => (n === 1 ? RELEASES_URL : `https://api.github.com/x?page=${n}`);
    const pages: Record<string, Page> = {};
    for (let n = 1; n <= 6; n++) {
      pages[url(n)] = { headers: { Link: `<${url(n + 1)}>; rel="next"` }, body: [rel("v0.3.1")] };
    }
    const f = fakeFetch(pages);
    const r = await checkForUpdate("0.3.0", { fetch: f.fetch, now: () => 0 });
    expect(r).toMatchObject({ kind: "failed", reason: "malformed" });
    expect(f.calls).toHaveLength(5);
  });

  it("api.github.com 밖의 next는 따라가지 않고 malformed", async () => {
    const f = fakeFetch({
      [RELEASES_URL]: { headers: { Link: `<https://evil.example/p2>; rel="next"` }, body: [rel("v0.3.1")] },
    });
    const r = await checkForUpdate("0.3.0", { fetch: f.fetch, now: () => 0 });
    expect(r).toMatchObject({ kind: "failed", reason: "malformed" });
    expect(f.calls).toHaveLength(1);
  });
});

describe("checkForUpdate — 실패", () => {
  const single = (page: Page, now = 0) =>
    checkForUpdate("0.3.1", { fetch: fakeFetch({ [RELEASES_URL]: page }).fetch, now: () => now });

  it("본문이 배열이 아니거나 JSON이 아니면 malformed", async () => {
    expect(await single({ body: { message: "x" } })).toMatchObject({ kind: "failed", reason: "malformed" });
    expect(await single({ body: "<html>portal</html>" })).toMatchObject({ kind: "failed", reason: "malformed" });
  });

  it("한도 헤더 없는 403과 500은 http", async () => {
    expect(await single({ status: 403, body: "{}" })).toMatchObject({ kind: "failed", reason: "http", detail: "HTTP 403" });
    expect(await single({ status: 500, body: "{}" })).toMatchObject({ kind: "failed", reason: "http", detail: "HTTP 500" });
  });

  it("Retry-After 초를 쓴다", async () => {
    expect(await single({ status: 403, headers: { "Retry-After": "120" }, body: "{}" })).toMatchObject({
      kind: "failed",
      reason: "rate_limited",
      retryAfterMs: 120_000,
    });
  });

  it("Remaining 0이면 Reset까지 기다린다", async () => {
    const r = await single(
      { status: 403, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1000" }, body: "{}" },
      400_000,
    );
    expect(r).toMatchObject({ reason: "rate_limited", retryAfterMs: 600_000 });
  });

  it("읽을 수 없는 한도 값이면 기본 대기", async () => {
    expect(await single({ status: 429, headers: { "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" }, body: "{}" })).toMatchObject({
      reason: "rate_limited",
      retryAfterMs: DEFAULT_RATE_LIMIT_WAIT_MS,
    });
  });

  it("터무니없는 한도 값은 기본 대기로 — 영원히 막지 않는다", async () => {
    expect(await single({ status: 403, headers: { "Retry-After": "9".repeat(400) }, body: "{}" })).toMatchObject({
      reason: "rate_limited",
      retryAfterMs: DEFAULT_RATE_LIMIT_WAIT_MS,
    });
    expect(
      await single({ status: 403, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "99999999999" }, body: "{}" }),
    ).toMatchObject({ reason: "rate_limited", retryAfterMs: DEFAULT_RATE_LIMIT_WAIT_MS });
  });

  it("네트워크 오류는 offline이고 오류 코드만 싣는다", async () => {
    const fetch: ReleaseFetch = async () => {
      throw Object.assign(new TypeError("fetch failed secret-header"), { cause: { code: "ENOTFOUND" } });
    };
    const r = await checkForUpdate("0.3.1", { fetch, now: () => 0 });
    expect(r).toMatchObject({ kind: "failed", reason: "offline" });
    expect(r.kind === "failed" && r.detail).toContain("ENOTFOUND");
    expect(r.kind === "failed" && r.detail).not.toContain("secret");
  });

  it("응답이 오지 않으면 timeout", async () => {
    const fetch: ReleaseFetch = () => new Promise(() => undefined);
    expect(await checkForUpdate("0.3.1", { fetch, now: () => 0, timeoutMs: 20 })).toMatchObject({ reason: "timeout" });
  });

  it("본문 읽기가 멈춰도 timeout", async () => {
    const fetch: ReleaseFetch = async () => ({
      status: 200,
      headers: { get: () => null },
      text: () => new Promise<string>(() => undefined),
    });
    expect(await checkForUpdate("0.3.1", { fetch, now: () => 0, timeoutMs: 20 })).toMatchObject({ reason: "timeout" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/release-check.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/update/release-check"`

- [ ] **Step 3: Write minimal implementation**

`desktop/src/update/release-check.ts`:

```ts
/**
 * 새 데스크톱 릴리스 조회 (Phase 6b-1 스펙 §4.1).
 *
 * electron을 import하지 않는다 — main.ts가 전역 fetch를 주입하고, 테스트는 네트워크 없이 부른다.
 * 모양은 config/token-store.ts의 verifyHfToken을 따른다: 신호로 요청을 끊고 경주로 결과를 닫는다
 * (본문 읽기와 모든 페이지 포함).
 *
 * **불완전한 조회로 "최신"이라 말하지 않는다.** 후보가 하나도 없거나 목록을 끝까지 못 읽으면 failed다.
 * **다운로드 URL은 응답에서 받지 않는다** — 정규식을 통과한 태그로 만든다. openExternal에 외부 응답의
 * 문자열이 닿지 않는다.
 */

export const RELEASES_URL = "https://api.github.com/repos/Yjason-K/Damwha/releases?per_page=100";
export const RELEASE_PAGE_BASE = "https://github.com/Yjason-K/Damwha/releases/tag/";
const API_ORIGIN = "https://api.github.com/";
export const CHECK_TIMEOUT_MS = 10_000;
export const MAX_PAGES = 5;
export const DEFAULT_RATE_LIMIT_WAIT_MS = 60 * 60_000;

export interface ReleaseFetchInit {
  method: "GET";
  headers: Record<string, string>;
  signal: AbortSignal;
}
export interface ReleaseFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type ReleaseFetch = (url: string, init: ReleaseFetchInit) => Promise<ReleaseFetchResponse>;

export type FailReason = "offline" | "timeout" | "rate_limited" | "http" | "malformed" | "no_release";
export type CheckResult =
  | { kind: "newer"; version: string; url: string }
  | { kind: "current"; latest: string }
  | { kind: "failed"; reason: FailReason; detail: string; retryAfterMs?: number };

export type Version = readonly [number, number, number];

export const INSTALLED_VERSION_SHAPE = /^(\d+)\.(\d+)\.(\d+)$/;
/** 새 형식 v<x.y.z>와 6a의 desktop-v<x.y.z>. 스펙 §3-2. */
const TAG_SHAPE = /^(?:desktop-)?v(\d+)\.(\d+)\.(\d+)$/;

function toVersion(m: RegExpExecArray | null): Version | null {
  if (m === null) return null;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])] as const;
  return v.every(Number.isSafeInteger) ? v : null;
}

export function parseInstalledVersion(s: string): Version | null {
  return toVersion(INSTALLED_VERSION_SHAPE.exec(s));
}

export function parseReleaseTag(tag: string): Version | null {
  return toVersion(TAG_SHAPE.exec(tag));
}

export function compareVersions(a: Version, b: Version): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function formatVersion(v: Version): string {
  return v.join(".");
}

export function releasePageUrl(tag: string): string {
  return RELEASE_PAGE_BASE + tag;
}

export interface Candidate {
  version: Version;
  tag: string;
}

/** 후보 중 최대. draft·prerelease는 **엄격한 불리언 false**여야 한다 — 누락·문자열이면 후보가 아니다. */
export function pickLatest(items: readonly unknown[]): Candidate | null {
  let best: Candidate | null = null;
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (r.draft !== false || r.prerelease !== false) continue;
    if (typeof r.tag_name !== "string") continue;
    const version = parseReleaseTag(r.tag_name);
    if (version === null) continue;
    const c: Candidate = { version, tag: r.tag_name };
    if (best === null) {
      best = c;
      continue;
    }
    const cmp = compareVersions(version, best.version);
    // 같은 버전이 두 형식으로 있으면 새 형식(v*)의 페이지를 연다.
    if (cmp > 0 || (cmp === 0 && c.tag.startsWith("v") && !best.tag.startsWith("v"))) best = c;
  }
  return best;
}

type NextPage = { kind: "none" } | { kind: "next"; url: string } | { kind: "foreign" };

function nextPage(link: string | null): NextPage {
  if (link === null) return { kind: "none" };
  for (const part of link.split(",")) {
    const m = /^\s*<([^>]*)>\s*;\s*rel="next"\s*$/.exec(part);
    if (m !== null) return m[1].startsWith(API_ORIGIN) ? { kind: "next", url: m[1] } : { kind: "foreign" };
  }
  return { kind: "none" };
}

/** 대기 시간이 말이 되는가 — 양의 안전 정수이고 24시간 이하. 아니면 기본 60분 (스펙 §4.1 "없거나 이상하면"). */
const MAX_RATE_LIMIT_WAIT_MS = 24 * 60 * 60_000;
function saneWait(ms: number): number {
  return Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_RATE_LIMIT_WAIT_MS ? ms : DEFAULT_RATE_LIMIT_WAIT_MS;
}

/** 403·429 중 한도로 읽히는 것의 대기 시간. 한도가 아니면 null. */
function rateLimitWaitMs(status: number, headers: ReleaseFetchResponse["headers"], now: number): number | null {
  if (status !== 403 && status !== 429) return null;
  const retryAfter = headers.get("retry-after")?.trim() ?? null;
  if (retryAfter !== null && /^\d+$/.test(retryAfter)) return saneWait(Number(retryAfter) * 1000);
  if (headers.get("x-ratelimit-remaining")?.trim() === "0") {
    return saneWait(Math.round(Number(headers.get("x-ratelimit-reset")) * 1000 - now));
  }
  if (retryAfter !== null) return DEFAULT_RATE_LIMIT_WAIT_MS;
  return null;
}

class CheckTimeout extends Error {}
class Malformed extends Error {}
class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly waitMs: number | null,
  ) {
    super(`HTTP ${status}`);
  }
}

interface CheckDeps {
  fetch: ReleaseFetch;
  now(): number;
  timeoutMs?: number;
}

async function readAllPages(current: string, deps: CheckDeps, signal: AbortSignal): Promise<unknown[]> {
  const items: unknown[] = [];
  let url = RELEASES_URL;
  for (let page = 1; ; page++) {
    const res = await deps.fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `Damwha/${current}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal,
    });
    if (res.status !== 200) throw new HttpFailure(res.status, rateLimitWaitMs(res.status, res.headers, deps.now()));
    const body = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Malformed("GitHub 응답이 JSON이 아니에요");
    }
    if (!Array.isArray(parsed)) throw new Malformed("GitHub 응답이 목록이 아니에요");
    items.push(...parsed);
    const next = nextPage(res.headers.get("link"));
    if (next.kind === "none") return items;
    if (next.kind === "foreign") throw new Malformed("다음 페이지 주소가 GitHub API 밖이에요");
    if (page >= MAX_PAGES) throw new Malformed("목록을 다 읽지 못했어요");
    url = next.url;
  }
}

export async function checkForUpdate(current: string, deps: CheckDeps): Promise<CheckResult> {
  const installed = parseInstalledVersion(current);
  if (installed === null) return { kind: "failed", reason: "malformed", detail: `설치 버전을 읽지 못했어요: ${current}` };

  const timeoutMs = deps.timeoutMs ?? CHECK_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CheckTimeout());
    }, timeoutMs);
  });
  deadline.catch(() => undefined);

  try {
    const items = await Promise.race([readAllPages(current, deps, controller.signal), deadline]);
    const latest = pickLatest(items);
    if (latest === null) return { kind: "failed", reason: "no_release", detail: "받을 수 있는 데스크톱 릴리스가 없어요" };
    if (compareVersions(latest.version, installed) > 0) {
      return { kind: "newer", version: formatVersion(latest.version), url: releasePageUrl(latest.tag) };
    }
    return { kind: "current", latest: formatVersion(latest.version) };
  } catch (e) {
    if (e instanceof CheckTimeout) return { kind: "failed", reason: "timeout", detail: `${timeoutMs / 1000}초 안에 답이 없었어요` };
    if (e instanceof Malformed) return { kind: "failed", reason: "malformed", detail: e.message };
    if (e instanceof HttpFailure) {
      return e.waitMs !== null
        ? { kind: "failed", reason: "rate_limited", detail: e.message, retryAfterMs: e.waitMs }
        : { kind: "failed", reason: "http", detail: e.message };
    }
    return { kind: "failed", reason: "offline", detail: networkDetail(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 원본 예외 메시지를 옮기지 않는다 — 모양이 맞는 오류 코드만 싣는다 (token-store.ts와 같은 규칙). */
function networkDetail(e: unknown): string {
  const code = errorCode(e);
  return code === null ? "GitHub에 연결하지 못했어요" : `GitHub에 연결하지 못했어요 (${code})`;
}

function errorCode(e: unknown): string | null {
  const pick = (v: unknown): string | null => {
    if (v === null || typeof v !== "object") return null;
    const code = (v as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : null;
  };
  const cause = e !== null && typeof e === "object" ? (e as { cause?: unknown }).cause : undefined;
  return pick(e) ?? pick(cause ?? null);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/release-check.test.ts`
Expected: PASS (22 tests)

- [ ] **Step 5: Commit**

```bash
git add desktop/src/update/release-check.ts desktop/tests/update/release-check.test.ts
git commit -m "feat(desktop): GitHub Releases에서 새 데스크톱 버전을 찾는다"
```

---

### Task 3: 건너뛴 버전 — `update-state.ts`

**Files:**
- Create: `desktop/src/update/update-state.ts`
- Test: `desktop/tests/update/update-state.test.ts`

**Interfaces:**
- Consumes: `INSTALLED_VERSION_SHAPE` from `release-check.ts`.
- Produces:
  ```ts
  export const UPDATE_STATE_FILE = "update-state.json";
  export interface UpdateStateStore { loadSkipped(): string | null; saveSkipped(version: string): void }
  export function makeUpdateStateStore(userData: string, log: (line: string) => void): UpdateStateStore;
  ```

- [ ] **Step 1: Write the failing test**

`desktop/tests/update/update-state.test.ts`:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { makeUpdateStateStore, UPDATE_STATE_FILE } from "../../src/update/update-state";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "update-state-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.chmodSync(d, 0o700);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("makeUpdateStateStore", () => {
  it("파일이 없으면 건너뛴 버전이 없다", () => {
    expect(makeUpdateStateStore(tmp(), () => undefined).loadSkipped()).toBeNull();
  });

  it("저장한 값을 다음 실행이 읽는다", () => {
    const dir = tmp();
    makeUpdateStateStore(dir, () => undefined).saveSkipped("0.4.0");
    expect(makeUpdateStateStore(dir, () => undefined).loadSkipped()).toBe("0.4.0");
    expect(JSON.parse(fs.readFileSync(path.join(dir, UPDATE_STATE_FILE), "utf8"))).toEqual({ skippedVersion: "0.4.0" });
  });

  it("임시 파일을 남기지 않는다", () => {
    const dir = tmp();
    makeUpdateStateStore(dir, () => undefined).saveSkipped("0.4.0");
    expect(fs.readdirSync(dir)).toEqual([UPDATE_STATE_FILE]);
  });

  it("손상·모양 불일치는 없음으로 읽는다", () => {
    for (const content of ["{not json", "[]", '{"skippedVersion": 4}', '{"skippedVersion": "v0.4.0"}']) {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, UPDATE_STATE_FILE), content);
      expect(makeUpdateStateStore(dir, () => undefined).loadSkipped()).toBeNull();
    }
  });

  it("쓰기에 실패하면 로그를 남기고 이번 실행에서는 메모리 값을 존중한다", () => {
    const dir = tmp();
    fs.chmodSync(dir, 0o500);
    const log: string[] = [];
    const store = makeUpdateStateStore(dir, (l) => log.push(l));
    store.saveSkipped("0.4.0");
    expect(store.loadSkipped()).toBe("0.4.0");
    expect(log.join("\n")).toContain("건너뛴 버전을 저장하지 못했어요");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/update-state.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/update/update-state"`

- [ ] **Step 3: Write minimal implementation**

`desktop/src/update/update-state.ts`:

```ts
import * as fs from "fs";
import * as path from "path";
import { INSTALLED_VERSION_SHAPE } from "./release-check";

/**
 * "이 버전 건너뛰기"의 영속화 (Phase 6b-1 스펙 §4.2).
 *
 * **config.json에 넣지 않는다** — 그 파일은 자식 env의 원천이고 사람이 손으로 고친다. 앱이 쓰는 상태를
 * 섞으면 저장 한 번이 사람의 편집을 덮는다. 못 읽으면 "없음"이고, 못 쓰면 이번 실행 동안 메모리 값으로
 * 존중한다 — 알림 하나 때문에 앱이 멈출 이유가 없다.
 */
export const UPDATE_STATE_FILE = "update-state.json";

export interface UpdateStateStore {
  loadSkipped(): string | null;
  saveSkipped(version: string): void;
}

export function makeUpdateStateStore(userData: string, log: (line: string) => void): UpdateStateStore {
  const file = path.join(userData, UPDATE_STATE_FILE);
  let memo: string | null | undefined;

  function readFile(): string | null {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
      const v = (raw as { skippedVersion?: unknown }).skippedVersion;
      return typeof v === "string" && INSTALLED_VERSION_SHAPE.test(v) ? v : null;
    } catch {
      return null;
    }
  }

  return {
    loadSkipped() {
      if (memo === undefined) memo = readFile();
      return memo;
    },
    saveSkipped(version) {
      memo = version;
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify({ skippedVersion: version }));
        fs.renameSync(tmp, file);
      } catch (e) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // 임시 파일을 못 지워도 할 수 있는 것이 없다.
        }
        log(`건너뛴 버전을 저장하지 못했어요 — ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/update-state.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add desktop/src/update/update-state.ts desktop/tests/update/update-state.test.ts
git commit -m "feat(desktop): 건너뛴 업데이트 버전을 userData에 남긴다"
```

---

### Task 4: 대화상자 옵션과 문구 — `dialogs.ts`

**Files:**
- Create: `desktop/src/update/dialogs.ts`
- Test: `desktop/tests/update/dialogs.test.ts`

**Interfaces:**
- Consumes: `CheckResult` from `release-check.ts`.
- Produces:
  ```ts
  export type NewerChoice = "open" | "later" | "skip";
  export const NEWER_BUTTONS: readonly ["다운로드 페이지 열기", "나중에", "이 버전 건너뛰기"];
  export function newerDialogOptions(current: string, latest: string): MessageBoxOptions;
  export function newerChoice(response: number): NewerChoice;
  export function currentDialogOptions(current: string): MessageBoxOptions;
  export function failedDialogOptions(detail: string): MessageBoxOptions;
  export function failureMessage(r: Extract<CheckResult, { kind: "failed" }>): string;
  ```

- [ ] **Step 1: Write the failing test**

`desktop/tests/update/dialogs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  currentDialogOptions,
  failedDialogOptions,
  failureMessage,
  NEWER_BUTTONS,
  newerChoice,
  newerDialogOptions,
} from "../../src/update/dialogs";

describe("newerDialogOptions", () => {
  it("열기가 기본이고 Escape는 나중에다 (스펙 §3-11)", () => {
    const o = newerDialogOptions("0.3.1", "0.4.0");
    expect(o.buttons).toEqual([...NEWER_BUTTONS]);
    expect(o.defaultId).toBe(0);
    expect(o.cancelId).toBe(1);
    expect(o.message).toBe("새 버전 0.4.0이 나왔어요");
    expect(o.detail).toContain("0.3.1");
  });
});

describe("newerChoice", () => {
  it("버튼 번호를 선택으로 바꾸고 모르는 번호는 나중에다", () => {
    expect(newerChoice(0)).toBe("open");
    expect(newerChoice(1)).toBe("later");
    expect(newerChoice(2)).toBe("skip");
    expect(newerChoice(-1)).toBe("later");
    expect(newerChoice(7)).toBe("later");
  });
});

describe("정보 대화상자", () => {
  it("최신·실패는 확인 버튼 하나", () => {
    expect(currentDialogOptions("0.4.0")).toMatchObject({ message: "최신 버전을 쓰고 있어요", detail: "담화 0.4.0", buttons: ["확인"] });
    expect(failedDialogOptions("x")).toMatchObject({ message: "업데이트를 확인하지 못했어요", buttons: ["확인"] });
    expect(failedDialogOptions("x").detail).toContain("잠시 뒤 다시 시도해 주세요.");
  });
});

describe("failureMessage", () => {
  it("사유마다 문구가 있다", () => {
    expect(failureMessage({ kind: "failed", reason: "offline", detail: "" })).toContain("인터넷");
    expect(failureMessage({ kind: "failed", reason: "timeout", detail: "" })).toContain("10초");
    expect(failureMessage({ kind: "failed", reason: "http", detail: "HTTP 502" })).toContain("HTTP 502");
    expect(failureMessage({ kind: "failed", reason: "malformed", detail: "" })).toContain("읽지 못했어요");
    expect(failureMessage({ kind: "failed", reason: "no_release", detail: "" })).toContain("찾지 못했어요");
  });
  it("한도는 남은 분을 올림해 말한다", () => {
    expect(failureMessage({ kind: "failed", reason: "rate_limited", detail: "", retryAfterMs: 61_000 })).toContain("2분 뒤");
    expect(failureMessage({ kind: "failed", reason: "rate_limited", detail: "", retryAfterMs: 1 })).toContain("1분 뒤");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/dialogs.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/update/dialogs"`

- [ ] **Step 3: Write minimal implementation**

`desktop/src/update/dialogs.ts`:

```ts
import type { MessageBoxOptions } from "electron";
import { CHECK_TIMEOUT_MS, DEFAULT_RATE_LIMIT_WAIT_MS, type CheckResult } from "./release-check";

/**
 * 새 버전 알림의 대화상자 옵션과 문구 (Phase 6b-1 스펙 §5). 띄우는 것은 main.ts다.
 *
 * `cancelId`를 **반드시** 준다 — 없으면 Electron이 라벨로 취소 버튼을 추정하는데 한국어 라벨은 인식되지
 * 않아 Escape가 0번(다운로드 페이지 열기)을 고를 수 있다 (스펙 §3-11).
 */
export type NewerChoice = "open" | "later" | "skip";

export const NEWER_BUTTONS = ["다운로드 페이지 열기", "나중에", "이 버전 건너뛰기"] as const;

export function newerDialogOptions(current: string, latest: string): MessageBoxOptions {
  return {
    type: "info",
    message: `새 버전 ${latest}이 나왔어요`,
    detail: `지금 ${current}을 쓰고 있어요. 다운로드 페이지에서 DMG를 받아 설치해 주세요.`,
    buttons: [...NEWER_BUTTONS],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
}

export function newerChoice(response: number): NewerChoice {
  if (response === 0) return "open";
  if (response === 2) return "skip";
  return "later";
}

export function currentDialogOptions(current: string): MessageBoxOptions {
  return { type: "info", message: "최신 버전을 쓰고 있어요", detail: `담화 ${current}`, buttons: ["확인"] };
}

export function failedDialogOptions(detail: string): MessageBoxOptions {
  return {
    type: "warning",
    message: "업데이트를 확인하지 못했어요",
    detail: `${detail} 잠시 뒤 다시 시도해 주세요.`,
    buttons: ["확인"],
  };
}

export function failureMessage(r: Extract<CheckResult, { kind: "failed" }>): string {
  switch (r.reason) {
    case "offline":
      return "인터넷에 연결되어 있지 않은 것 같아요.";
    case "timeout":
      return `GitHub이 ${CHECK_TIMEOUT_MS / 1000}초 안에 답하지 않았어요.`;
    case "rate_limited": {
      const minutes = Math.max(1, Math.ceil((r.retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS) / 60_000));
      return `확인 요청이 너무 많았어요. ${minutes}분 뒤에 다시 시도할 수 있어요.`;
    }
    case "http":
      return `GitHub이 오류를 돌려줬어요 (${r.detail}).`;
    case "malformed":
      return "GitHub의 응답을 읽지 못했어요.";
    case "no_release":
      return "받을 수 있는 데스크톱 릴리스를 찾지 못했어요.";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/dialogs.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add desktop/src/update/dialogs.ts desktop/tests/update/dialogs.test.ts
git commit -m "feat(desktop): 업데이트 대화상자 옵션과 문구 — Escape는 나중에"
```

---

### Task 5: 정책 — `update-flow.ts`

**Files:**
- Create: `desktop/src/update/update-flow.ts`
- Test: `desktop/tests/update/update-flow.test.ts`

**Interfaces:**
- Consumes: `CheckResult`, `DEFAULT_RATE_LIMIT_WAIT_MS` (Task 2); `NewerChoice`, `failureMessage` (Task 4).
- Produces:
  ```ts
  export interface UpdateFlowDeps {
    check(): Promise<CheckResult>;
    now(): number;
    isAttached(): boolean;
    isRecording(): Promise<boolean>;
    isShuttingDown(): boolean;
    isOtherModalOpen(): boolean;
    loadSkipped(): string | null;
    saveSkipped(version: string): void;
    showNewer(info: { current: string; latest: string }): Promise<NewerChoice>;
    showInfo(info: { kind: "current"; current: string } | { kind: "failed"; detail: string }): Promise<void>;
    openExternal(url: string): Promise<void>;
    log(line: string): void;
  }
  export interface UpdateFlow { autoCheck(): Promise<void>; manualCheck(): Promise<void> }
  export function createUpdateFlow(deps: UpdateFlowDeps, current: string): UpdateFlow;
  ```

- [ ] **Step 1: Write the failing test**

`desktop/tests/update/update-flow.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { CheckResult } from "../../src/update/release-check";
import type { NewerChoice } from "../../src/update/dialogs";
import { createUpdateFlow, type UpdateFlowDeps } from "../../src/update/update-flow";

const URL_040 = "https://github.com/Yjason-K/Damwha/releases/tag/v0.4.0";
const newer = (version = "0.4.0"): CheckResult => ({
  kind: "newer",
  version,
  url: `https://github.com/Yjason-K/Damwha/releases/tag/v${version}`,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function harness(over: Partial<UpdateFlowDeps> = {}) {
  const log: string[] = [];
  const opened: string[] = [];
  const infos: unknown[] = [];
  const state = { skipped: null as string | null, answer: "later" as NewerChoice, now: 0 };
  const deps: UpdateFlowDeps = {
    check: vi.fn(async () => newer()),
    now: () => state.now,
    isAttached: () => true,
    isRecording: async () => false,
    isShuttingDown: () => false,
    isOtherModalOpen: () => false,
    loadSkipped: () => state.skipped,
    saveSkipped: (v) => {
      state.skipped = v;
    },
    showNewer: vi.fn(async () => state.answer),
    showInfo: vi.fn(async (i) => {
      infos.push(i);
    }),
    openExternal: vi.fn(async (u: string) => {
      opened.push(u);
    }),
    log: (l) => log.push(l),
    ...over,
  };
  return { deps, flow: createUpdateFlow(deps, "0.3.1"), log, opened, infos, state };
}

describe("autoCheck — 표시", () => {
  it("새 버전이면 대화상자를 띄우고 열기를 누르면 페이지를 연다", async () => {
    const h = harness();
    h.state.answer = "open";
    await h.flow.autoCheck();
    expect(h.deps.showNewer).toHaveBeenCalledWith({ current: "0.3.1", latest: "0.4.0" });
    expect(h.opened).toEqual([URL_040]);
  });

  it("같은 버전은 실행당 한 번만 묻는다", async () => {
    const h = harness();
    await h.flow.autoCheck();
    await h.flow.autoCheck();
    expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
  });

  it("더 새 버전이 나오면 다시 묻는다", async () => {
    const results = [newer("0.4.0"), newer("0.5.0")];
    const h = harness({ check: vi.fn(async () => results.shift()!) });
    await h.flow.autoCheck();
    await h.flow.autoCheck();
    expect(h.deps.showNewer).toHaveBeenCalledTimes(2);
  });

  it("건너뛰기를 저장하고 그 버전은 자동으로 다시 묻지 않는다", async () => {
    const h = harness();
    h.state.answer = "skip";
    await h.flow.autoCheck();
    expect(h.state.skipped).toBe("0.4.0");
    const h2 = harness();
    h2.state.skipped = "0.4.0";
    await h2.flow.autoCheck();
    expect(h2.deps.showNewer).not.toHaveBeenCalled();
  });

  it("current면 화면 없이 로그 한 줄", async () => {
    const h = harness({ check: async () => ({ kind: "current", latest: "0.3.1" }) });
    await h.flow.autoCheck();
    expect(h.deps.showNewer).not.toHaveBeenCalled();
    expect(h.deps.showInfo).not.toHaveBeenCalled();
    expect(h.log).toEqual(["업데이트 확인: 최신 (0.3.1)"]);
  });

  it("실패는 화면 없이 로그 한 줄", async () => {
    const h = harness({ check: async () => ({ kind: "failed", reason: "offline", detail: "x" }) });
    await h.flow.autoCheck();
    expect(h.deps.showInfo).not.toHaveBeenCalled();
    expect(h.deps.showNewer).not.toHaveBeenCalled();
    expect(h.log.join("\n")).toContain("업데이트 확인 실패 (offline)");
  });
});

describe("autoCheck — 보류", () => {
  const cases: [string, Partial<UpdateFlowDeps>][] = [
    ["미부착", { isAttached: () => false }],
    ["다른 모달", { isOtherModalOpen: () => true }],
    ["종료 중", { isShuttingDown: vi.fn().mockReturnValueOnce(false).mockReturnValue(true) }],
    ["녹음 중", { isRecording: async () => true }],
  ];
  for (const [name, over] of cases) {
    it(`${name}이면 띄우지 않고 로그를 남기며, 다음 확인에서 띄운다`, async () => {
      const h = harness(over);
      await h.flow.autoCheck();
      expect(h.deps.showNewer).not.toHaveBeenCalled();
      expect(h.log.join("\n")).toContain("업데이트 알림 보류");
      Object.assign(h.deps, {
        isAttached: () => true,
        isOtherModalOpen: () => false,
        isShuttingDown: () => false,
        isRecording: async () => false,
      });
      await h.flow.autoCheck();
      expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
    });
  }

  it("녹음 질문 뒤 창이 사라졌으면 띄우지 않는다", async () => {
    const attached = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const h = harness({ isAttached: attached });
    await h.flow.autoCheck();
    expect(h.deps.showNewer).not.toHaveBeenCalled();
  });

  it("녹음 질문이 거부되면 녹음 중으로 보고 보류한다", async () => {
    const h = harness({ isRecording: async () => Promise.reject(new Error("x")) });
    await h.flow.autoCheck();
    expect(h.deps.showNewer).not.toHaveBeenCalled();
  });

  it("종료가 확정된 뒤에는 조회도 하지 않는다", async () => {
    const h = harness({ isShuttingDown: () => true });
    await h.flow.autoCheck();
    expect(h.deps.check).not.toHaveBeenCalled();
  });
});

describe("manualCheck", () => {
  it("건너뛴 버전·녹음·미부착을 무시하고 띄운다", async () => {
    const h = harness({ isAttached: () => false, isRecording: async () => true });
    h.state.skipped = "0.4.0";
    await h.flow.manualCheck();
    expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
  });

  it("자동으로 이미 보인 버전도 다시 보인다", async () => {
    const h = harness();
    await h.flow.autoCheck();
    await h.flow.manualCheck();
    expect(h.deps.showNewer).toHaveBeenCalledTimes(2);
  });

  it("최신·실패를 말한다", async () => {
    const h1 = harness({ check: async () => ({ kind: "current", latest: "0.3.1" }) });
    await h1.flow.manualCheck();
    expect(h1.infos).toEqual([{ kind: "current", current: "0.3.1" }]);
    const h2 = harness({ check: async () => ({ kind: "failed", reason: "offline", detail: "x" }) });
    await h2.flow.manualCheck();
    expect(h2.infos).toEqual([{ kind: "failed", detail: "인터넷에 연결되어 있지 않은 것 같아요." }]);
  });

  it("종료 중이면 아무것도 하지 않는다", async () => {
    const h = harness({ isShuttingDown: () => true });
    await h.flow.manualCheck();
    expect(h.deps.check).not.toHaveBeenCalled();
    expect(h.deps.showInfo).not.toHaveBeenCalled();
  });

  it("수동에서 보인 버전은 자동이 다시 묻지 않는다", async () => {
    const h = harness();
    await h.flow.manualCheck();
    await h.flow.autoCheck();
    expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
  });
});

describe("조회 공유와 표시 잠금", () => {
  it("동시에 들어온 자동·수동은 조회를 한 번만 하고 한 번만 띄운다", async () => {
    const d = deferred<CheckResult>();
    const h = harness({ check: vi.fn(() => d.promise) });
    const a = h.flow.autoCheck();
    const m = h.flow.manualCheck();
    d.resolve(newer());
    await Promise.all([a, m]);
    expect(h.deps.check).toHaveBeenCalledTimes(1);
    expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
  });

  it("녹음 답이 엇갈려 온 두 자동 확인이 같은 버전을 두 번 띄우지 않는다", async () => {
    const answers = [deferred<boolean>(), deferred<boolean>()];
    const pending = [...answers];
    const h = harness({ isRecording: vi.fn(() => pending.shift()!.promise) });
    const a1 = h.flow.autoCheck();
    const a2 = h.flow.autoCheck();
    await vi.waitFor(() => expect(h.deps.isRecording).toHaveBeenCalledTimes(2));
    answers[0].resolve(false);
    await a1;
    answers[1].resolve(false);
    await a2;
    expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
  });

  it("자동이 녹음 답을 기다리는 사이 수동이 띄웠으면 자동은 다시 띄우지 않는다", async () => {
    const rec = deferred<boolean>();
    const h = harness({ isRecording: vi.fn(() => rec.promise) });
    const a = h.flow.autoCheck();
    await vi.waitFor(() => expect(h.deps.isRecording).toHaveBeenCalledTimes(1));
    await h.flow.manualCheck();
    rec.resolve(false);
    await a;
    expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
  });

  it("수동 연타는 두 번째를 무시한다", async () => {
    const d = deferred<CheckResult>();
    const h = harness({ check: vi.fn(() => d.promise) });
    const m1 = h.flow.manualCheck();
    const m2 = h.flow.manualCheck();
    d.resolve({ kind: "current", latest: "0.3.1" });
    await Promise.all([m1, m2]);
    expect(h.deps.check).toHaveBeenCalledTimes(1);
    expect(h.deps.showInfo).toHaveBeenCalledTimes(1);
  });

  it("자동 대화상자가 떠 있는 동안의 수동 클릭은 무시한다", async () => {
    const shown = deferred<NewerChoice>();
    const h = harness({ showNewer: vi.fn(() => shown.promise) });
    const a = h.flow.autoCheck();
    await vi.waitFor(() => expect(h.deps.showNewer).toHaveBeenCalledTimes(1));
    await h.flow.manualCheck();
    expect(h.deps.check).toHaveBeenCalledTimes(1);
    shown.resolve("later");
    await a;
    expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
  });

  it("대화상자가 떠 있는 동안의 자동 확인은 결과를 버린다", async () => {
    const results = [newer("0.4.0"), newer("0.5.0")];
    const shown = deferred<NewerChoice>();
    const h = harness({ check: vi.fn(async () => results.shift()!), showNewer: vi.fn(() => shown.promise) });
    const a1 = h.flow.autoCheck();
    await vi.waitFor(() => expect(h.deps.showNewer).toHaveBeenCalledTimes(1));
    await h.flow.autoCheck();
    shown.resolve("later");
    await a1;
    expect(h.deps.showNewer).toHaveBeenCalledTimes(1);
  });

  it("수동 정보 대화상자가 떠 있는 동안의 자동 확인은 버린다", async () => {
    const info = deferred<void>();
    const results: CheckResult[] = [{ kind: "current", latest: "0.3.1" }, newer()];
    const h = harness({ check: vi.fn(async () => results.shift()!), showInfo: vi.fn(() => info.promise) });
    const m = h.flow.manualCheck();
    await vi.waitFor(() => expect(h.deps.showInfo).toHaveBeenCalledTimes(1));
    await h.flow.autoCheck();
    info.resolve();
    await m;
    expect(h.deps.showNewer).not.toHaveBeenCalled();
  });

  it("대화상자가 떠 있는 사이 종료가 시작되면 선택을 버린다", async () => {
    let shutting = false;
    const h = harness({
      isShuttingDown: () => shutting,
      showNewer: vi.fn(async () => {
        shutting = true;
        return "skip" as const;
      }),
    });
    await h.flow.autoCheck();
    expect(h.state.skipped).toBeNull();
    expect(h.opened).toEqual([]);
  });

  it("대화상자·브라우저 열기가 실패해도 잠금이 풀린다", async () => {
    const h = harness({
      showNewer: vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("open"),
      openExternal: vi.fn().mockRejectedValueOnce(new Error("no browser")).mockResolvedValue(undefined),
    });
    await h.flow.manualCheck();
    await h.flow.manualCheck();
    await h.flow.manualCheck();
    expect(h.deps.showNewer).toHaveBeenCalledTimes(3);
    expect(h.log.join("\n")).toContain("boom");
    expect(h.log.join("\n")).toContain("no browser");
  });
});

describe("자동 대화상자 실패", () => {
  it("자동 대화상자가 실패해도 잠금이 풀려 다음 자동 확인이 띄운다", async () => {
    const results = [newer("0.4.0"), newer("0.5.0")];
    const h = harness({
      check: vi.fn(async () => results.shift()!),
      showNewer: vi.fn().mockRejectedValueOnce(new Error("sheet")).mockResolvedValue("later"),
    });
    await h.flow.autoCheck();
    await h.flow.autoCheck();
    expect(h.deps.showNewer).toHaveBeenCalledTimes(2);
    expect(h.log.join("\n")).toContain("sheet");
  });
});

describe("한도 쿨다운", () => {
  it("rate_limited 뒤에는 만료까지 요청하지 않고, 만료 뒤 다시 요청한다", async () => {
    const results: CheckResult[] = [
      { kind: "failed", reason: "rate_limited", detail: "HTTP 403", retryAfterMs: 60_000 },
      { kind: "current", latest: "0.3.1" },
    ];
    const h = harness({ check: vi.fn(async () => results.shift()!) });
    await h.flow.manualCheck();
    h.state.now = 1_000;
    await h.flow.manualCheck();
    expect(h.deps.check).toHaveBeenCalledTimes(1);
    expect(h.infos[1]).toEqual({ kind: "failed", detail: "확인 요청이 너무 많았어요. 1분 뒤에 다시 시도할 수 있어요." });
    h.state.now = 61_000;
    await h.flow.manualCheck();
    expect(h.deps.check).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/update-flow.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/update/update-flow"`

- [ ] **Step 3: Write minimal implementation**

`desktop/src/update/update-flow.ts`:

```ts
import { failureMessage, type NewerChoice } from "./dialogs";
import { DEFAULT_RATE_LIMIT_WAIT_MS, type CheckResult } from "./release-check";

/**
 * 새 버전 알림의 정책 (Phase 6b-1 스펙 §4.3). 잎은 main.ts가 주입한다.
 *
 * - **자동**은 방해하지 않는다: 실패는 로그만, 건너뛴 버전·이미 보인 버전은 조용히, 화면이 안 붙었거나
 *   녹음 중이거나 다른 모달이 떠 있거나 종료 중이면 보류한다. 보류 표시는 두지 않는다 — 다음 자동 확인이
 *   다시 조회하면 같은 결과가 나온다.
 * - **수동**은 사람이 방금 누른 메뉴에 대한 답이라 결과를 항상 말한다(main.ts의 ask()와 같은 원칙).
 * - 조회는 공유하고(동시 호출 → 한 번), 대화상자는 동시에 하나다. 수동은 조회 **전에** 잠금을 잡아
 *   연타와 자동을 앞선다.
 * - 한도(rate_limited)를 받으면 만료까지 요청 없이 실패로 답한다 — 연타가 한도를 더 태우지 않는다.
 */
export interface UpdateFlowDeps {
  check(): Promise<CheckResult>;
  now(): number;
  isAttached(): boolean;
  isRecording(): Promise<boolean>;
  isShuttingDown(): boolean;
  isOtherModalOpen(): boolean;
  loadSkipped(): string | null;
  saveSkipped(version: string): void;
  showNewer(info: { current: string; latest: string }): Promise<NewerChoice>;
  showInfo(info: { kind: "current"; current: string } | { kind: "failed"; detail: string }): Promise<void>;
  openExternal(url: string): Promise<void>;
  log(line: string): void;
}

export interface UpdateFlow {
  autoCheck(): Promise<void>;
  manualCheck(): Promise<void>;
}

type Newer = Extract<CheckResult, { kind: "newer" }>;

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createUpdateFlow(deps: UpdateFlowDeps, current: string): UpdateFlow {
  let inflight: Promise<CheckResult> | null = null;
  let blockedUntil = 0;
  let presenting = false;
  const shown = new Set<string>();

  function check(): Promise<CheckResult> {
    const now = deps.now();
    if (now < blockedUntil) {
      return Promise.resolve({ kind: "failed", reason: "rate_limited", detail: "쿨다운", retryAfterMs: blockedUntil - now });
    }
    if (inflight !== null) return inflight;
    const started = deps.check().then(
      (r) => {
        if (r.kind === "failed" && r.reason === "rate_limited") {
          blockedUntil = deps.now() + (r.retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS);
        }
        return r;
      },
      (e: unknown): CheckResult => ({ kind: "failed", reason: "offline", detail: reasonOf(e) }),
    );
    inflight = started.finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function holdReason(): string | null {
    if (deps.isShuttingDown()) return "종료 중";
    if (!deps.isAttached()) return "담화 화면이 붙지 않음";
    if (deps.isOtherModalOpen()) return "다른 대화상자가 떠 있음";
    return null;
  }

  async function presentNewer(r: Newer): Promise<void> {
    shown.add(r.version);
    const choice = await deps.showNewer({ current, latest: r.version });
    if (deps.isShuttingDown()) {
      deps.log(`업데이트 알림: 종료가 시작돼 선택(${choice})을 버렸어요`);
      return;
    }
    if (choice === "open") await deps.openExternal(r.url);
    else if (choice === "skip") deps.saveSkipped(r.version);
  }

  return {
    async autoCheck() {
      if (deps.isShuttingDown()) return;
      const r = await check();
      if (r.kind === "failed") {
        deps.log(`업데이트 확인 실패 (${r.reason}) — ${r.detail}`);
        return;
      }
      // 조용히 끝나는 갈래도 한 줄 남긴다 — 실측이 "타이머가 돌았다"를 로그로 판정한다(계획 T10).
      if (r.kind === "current") {
        deps.log(`업데이트 확인: 최신 (${r.latest})`);
        return;
      }
      if (r.version === deps.loadSkipped()) {
        deps.log(`업데이트 확인: ${r.version} (건너뛴 버전)`);
        return;
      }
      if (shown.has(r.version)) {
        deps.log(`업데이트 확인: ${r.version} (이번 실행에서 이미 알림)`);
        return;
      }

      const before = holdReason();
      if (before !== null) {
        deps.log(`업데이트 알림 보류: ${before} (${r.version})`);
        return;
      }
      let recording: boolean;
      try {
        recording = await deps.isRecording();
      } catch {
        recording = true;
      }
      if (recording) {
        deps.log(`업데이트 알림 보류: 녹음 중 (${r.version})`);
        return;
      }
      const after = holdReason();
      if (after !== null) {
        deps.log(`업데이트 알림 보류: ${after} (${r.version})`);
        return;
      }
      // 기다리는 사이 다른 확인이 이 버전을 이미 띄웠거나(수동·다른 자동) 건너뛰기가 저장됐을 수 있다.
      // presenting만 보면 먼저 띄운 대화상자가 **닫힌 뒤** 도착한 쪽이 같은 버전을 또 띄운다 (계획 검증 #3).
      if (presenting || shown.has(r.version) || r.version === deps.loadSkipped()) return;

      presenting = true;
      try {
        await presentNewer(r);
      } catch (e) {
        deps.log(`업데이트 알림을 띄우지 못했어요 — ${reasonOf(e)}`);
      } finally {
        presenting = false;
      }
    },

    async manualCheck() {
      if (deps.isShuttingDown() || presenting) return;
      presenting = true;
      try {
        const r = await check();
        if (deps.isShuttingDown()) return;
        if (r.kind === "newer") await presentNewer(r);
        else if (r.kind === "current") await deps.showInfo({ kind: "current", current });
        else await deps.showInfo({ kind: "failed", detail: failureMessage(r) });
      } catch (e) {
        deps.log(`업데이트 알림을 띄우지 못했어요 — ${reasonOf(e)}`);
      } finally {
        presenting = false;
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/update-flow.test.ts`
Expected: PASS (29 tests)

- [ ] **Step 5: Commit**

```bash
git add desktop/src/update/update-flow.ts desktop/tests/update/update-flow.test.ts
git commit -m "feat(desktop): 새 버전 알림 정책 — 자동은 보류, 수동은 항상 답한다"
```

---

### Task 6: 스케줄러와 모달 추적기

**Files:**
- Create: `desktop/src/update/scheduler.ts`
- Create: `desktop/src/update/modal-tracker.ts`
- Test: `desktop/tests/update/scheduler.test.ts`
- Test: `desktop/tests/update/modal-tracker.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // scheduler.ts
  export const DEFAULT_INTERVAL_MS = 86_400_000;
  export const MIN_INTERVAL_MS = 60_000;
  export type IntervalOverride = { kind: "unset" } | { kind: "ok"; ms: number } | { kind: "invalid"; raw: string };
  export function parseIntervalOverride(raw: string | undefined): IntervalOverride;
  export interface UpdateScheduler { onAttached(): void; dispose(): void }
  export function createUpdateScheduler(opts: { packaged: boolean; override: string | undefined; run(): void; log(line: string): void }): UpdateScheduler;
  // modal-tracker.ts
  export interface ModalTracker { track<T>(p: Promise<T>): Promise<T>; isOpen(): boolean }
  export function createModalTracker(): ModalTracker;
  ```

- [ ] **Step 1: Write the failing tests**

`desktop/tests/update/scheduler.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUpdateScheduler, DEFAULT_INTERVAL_MS, parseIntervalOverride } from "../../src/update/scheduler";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("parseIntervalOverride", () => {
  it("범위 안의 정수만 받는다", () => {
    expect(parseIntervalOverride(undefined)).toEqual({ kind: "unset" });
    expect(parseIntervalOverride("")).toEqual({ kind: "unset" });
    expect(parseIntervalOverride("60000")).toEqual({ kind: "ok", ms: 60_000 });
    expect(parseIntervalOverride("86400000")).toEqual({ kind: "ok", ms: 86_400_000 });
    for (const raw of ["59999", "86400001", "NaN", "-1", "1e5", "60000.5", "abc", "9999999999999"]) {
      expect(parseIntervalOverride(raw)).toEqual({ kind: "invalid", raw });
    }
  });
});

function make(packaged: boolean, override?: string) {
  const run = vi.fn();
  const log = vi.fn();
  return { run, log, s: createUpdateScheduler({ packaged, override, run, log }) };
}

describe("createUpdateScheduler", () => {
  it("dev에서는 무장하지 않는다", () => {
    const { run, s } = make(false);
    s.onAttached();
    vi.advanceTimersByTime(2 * DEFAULT_INTERVAL_MS);
    expect(run).not.toHaveBeenCalled();
  });

  it("packaged는 붙자마자 한 번, 그 뒤 24시간마다", () => {
    const { run, s } = make(true);
    s.onAttached();
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DEFAULT_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("여러 번 붙어도 한 번만 무장한다", () => {
    const { run, s } = make(true);
    s.onAttached();
    s.onAttached();
    s.onAttached();
    vi.advanceTimersByTime(DEFAULT_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("env 주기가 유효하면 첫 확인도 한 주기 뒤다", () => {
    const { run, s } = make(true, "60000");
    s.onAttached();
    vi.advanceTimersByTime(59_999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("env 주기가 잘못되면 로그를 남기고 기본값", () => {
    const { run, log, s } = make(true, "NaN");
    s.onAttached();
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("DAMWHA_UPDATE_CHECK_INTERVAL_MS"));
  });

  it("해제 뒤에는 발화하지 않고 다시 무장하지도 않는다", () => {
    const { run, s } = make(true);
    s.onAttached();
    s.dispose();
    s.onAttached();
    vi.advanceTimersByTime(2 * DEFAULT_INTERVAL_MS);
    expect(run).not.toHaveBeenCalled();
  });
});
```

`desktop/tests/update/modal-tracker.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createModalTracker } from "../../src/update/modal-tracker";

describe("createModalTracker", () => {
  it("추적 중인 프라미스가 끝날 때까지 열려 있다", async () => {
    const t = createModalTracker();
    let resolve!: () => void;
    const p = t.track(new Promise<void>((r) => (resolve = r)));
    expect(t.isOpen()).toBe(true);
    resolve();
    await p;
    expect(t.isOpen()).toBe(false);
  });

  it("거부돼도 닫히고 거부는 그대로 전한다", async () => {
    const t = createModalTracker();
    await expect(t.track(Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(t.isOpen()).toBe(false);
  });

  it("겹친 모달을 센다", async () => {
    const t = createModalTracker();
    let r1!: () => void;
    const p1 = t.track(new Promise<void>((r) => (r1 = r)));
    const p2 = t.track(Promise.resolve());
    await p2;
    expect(t.isOpen()).toBe(true);
    r1();
    await p1;
    expect(t.isOpen()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/scheduler.test.ts tests/update/modal-tracker.test.ts`
Expected: FAIL — 두 import 모두 해석 실패

- [ ] **Step 3: Write minimal implementation**

`desktop/src/update/scheduler.ts`:

```ts
/**
 * 자동 확인 타이머 (Phase 6b-1 스펙 §4.4).
 *
 * - packaged에서만, 담화 화면이 **처음** 붙을 때 한 번 무장한다 — 재시도·Dock 재활성화로 다시 붙어도
 *   두 번 무장하지 않는다.
 * - `run`은 기다리지 않는다(부르는 쪽이 `void flow.autoCheck().catch(…)`). 기동 경로가 알림을 기다리면
 *   안 된다.
 * - 개발용 env 주기는 유한 정수 60,000~86,400,000만 받는다. Node는 NaN·2³¹−1 초과를 1ms로 바꾼다.
 *   env가 유효하면 첫 확인도 한 주기 뒤다 — 보류 시나리오를 실측할 수 있게(스펙 §8.2-4).
 * - 해제는 main.ts의 beginQuit에서 한다. before-quit이 아니다(종료 확인에서 취소하면 앱이 산다).
 */
export const DEFAULT_INTERVAL_MS = 86_400_000;
export const MIN_INTERVAL_MS = 60_000;

export type IntervalOverride = { kind: "unset" } | { kind: "ok"; ms: number } | { kind: "invalid"; raw: string };

export function parseIntervalOverride(raw: string | undefined): IntervalOverride {
  if (raw === undefined || raw === "") return { kind: "unset" };
  if (!/^\d+$/.test(raw)) return { kind: "invalid", raw };
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms < MIN_INTERVAL_MS || ms > DEFAULT_INTERVAL_MS) return { kind: "invalid", raw };
  return { kind: "ok", ms };
}

export interface UpdateScheduler {
  onAttached(): void;
  dispose(): void;
}

export function createUpdateScheduler(opts: {
  packaged: boolean;
  override: string | undefined;
  run(): void;
  log(line: string): void;
}): UpdateScheduler {
  let armed = false;
  let disposed = false;
  let first: ReturnType<typeof setTimeout> | null = null;
  let every: ReturnType<typeof setInterval> | null = null;

  return {
    onAttached() {
      if (!opts.packaged || armed || disposed) return;
      armed = true;
      const parsed = parseIntervalOverride(opts.override);
      if (parsed.kind === "invalid") {
        opts.log(`DAMWHA_UPDATE_CHECK_INTERVAL_MS 값을 쓰지 않아요 (${JSON.stringify(parsed.raw)}) — 24시간으로 확인합니다.`);
      }
      const interval = parsed.kind === "ok" ? parsed.ms : DEFAULT_INTERVAL_MS;
      first = setTimeout(() => {
        first = null;
        opts.run();
        every = setInterval(() => opts.run(), interval);
      }, parsed.kind === "ok" ? interval : 0);
    },
    dispose() {
      disposed = true;
      if (first !== null) clearTimeout(first);
      if (every !== null) clearInterval(every);
      first = null;
      every = null;
    },
  };
}
```

`desktop/src/update/modal-tracker.ts`:

```ts
/**
 * 앱이 띄운 다른 모달(토큰 창·재시작 안내·ask() 대화상자)이 떠 있는가 (Phase 6b-1 스펙 §4.4).
 * 자동 업데이트 알림이 그 위에 겹치지 않게 한다. 업데이트 대화상자 자신은 세지 않는다 — 그것은
 * update-flow.ts의 표시 잠금이 막는다.
 */
export interface ModalTracker {
  track<T>(p: Promise<T>): Promise<T>;
  isOpen(): boolean;
}

export function createModalTracker(): ModalTracker {
  let open = 0;
  return {
    track(p) {
      open++;
      return p.finally(() => {
        open--;
      });
    },
    isOpen: () => open > 0,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter damwha-desktop exec vitest run tests/update/scheduler.test.ts tests/update/modal-tracker.test.ts`
Expected: PASS (7 + 3 tests)

- [ ] **Step 5: Commit**

```bash
git add desktop/src/update/scheduler.ts desktop/src/update/modal-tracker.ts desktop/tests/update/scheduler.test.ts desktop/tests/update/modal-tracker.test.ts
git commit -m "feat(desktop): 업데이트 확인 타이머를 한 번만 무장하고 다른 모달을 센다"
```

---

### Task 7: 앱 메뉴 템플릿

**Files:**
- Create: `desktop/src/windows/menu-template.ts`
- Test: `desktop/tests/windows/menu-template.test.ts`

`menu.ts`를 이 템플릿으로 바꾸는 것은 **Task 8**이다 — `MenuHandlers`에 필수 필드가 늘어 `main.ts`의 `installMenu` 호출이 같은 커밋에서 바뀌어야 하고, 그 핸들러가 부를 `updateFlow`는 Task 8에서 생긴다. 이 Task에서 `main.ts`를 건드리면 `updateFlow`가 한 번도 대입되지 않아 `never`로 좁혀져 lint가 깨진다(계획 검증 #2).

**Interfaces:**
- Produces:
  ```ts
  export interface MenuHandlers { onRetry(): void; onShowStatus(): void; onCheckForUpdates(): void }
  export function buildMenuTemplate(handlers: MenuHandlers, appName: string): MenuItemConstructorOptions[];
  ```
  (Task 8에서 `menu.ts`가 `MenuHandlers`를 다시 내보내고 `installMenu(handlers: MenuHandlers): void`를 유지한다.)

- [ ] **Step 1: Write the failing test**

`desktop/tests/windows/menu-template.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { buildMenuTemplate } from "../../src/windows/menu-template";

function handlers() {
  return { onRetry: vi.fn(), onShowStatus: vi.fn(), onCheckForUpdates: vi.fn() };
}

describe("buildMenuTemplate", () => {
  it("앱 메뉴가 appMenu role이 내던 항목을 그대로 두고 업데이트 확인을 더한다", () => {
    const t = buildMenuTemplate(handlers(), "Damwha");
    const app = t[0];
    expect(app.label).toBe("Damwha");
    const items = app.submenu as MenuItemConstructorOptions[];
    expect(items.map((i) => i.role ?? i.type ?? i.label)).toEqual([
      "about",
      "업데이트 확인…",
      "separator",
      "services",
      "separator",
      "hide",
      "hideOthers",
      "unhide",
      "separator",
      "quit",
    ]);
  });

  it("업데이트 확인을 누르면 핸들러를 부른다", () => {
    const h = handlers();
    const items = buildMenuTemplate(h, "Damwha")[0].submenu as MenuItemConstructorOptions[];
    const item = items.find((i) => i.label === "업데이트 확인…")!;
    (item.click as () => void)();
    expect(h.onCheckForUpdates).toHaveBeenCalledTimes(1);
  });

  it("나머지 메뉴는 그대로다", () => {
    const t = buildMenuTemplate(handlers(), "Damwha");
    expect(t.slice(1).map((m) => m.role ?? m.label)).toEqual(["서비스", "editMenu", "viewMenu", "windowMenu"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows/menu-template.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/windows/menu-template"`

- [ ] **Step 3: Write minimal implementation**

`desktop/src/windows/menu-template.ts`:

```ts
import type { MenuItemConstructorOptions } from "electron";

/**
 * 앱 메뉴 템플릿 — 순수 함수라 시험할 수 있다. 설치는 menu.ts가 한다.
 *
 * 메뉴에 두는 이유: preload가 없어 렌더러에서 main을 부를 경로가 없다 (스펙 §6.5·§6.11).
 * 메뉴는 main 프로세스 소유라 IPC가 필요 없다. 담화 화면이 붙은 뒤에는 준비 화면이 더
 * 이상 그려지지 않으므로, 서비스 상태를 볼 채널도 여기뿐이다.
 *
 * 앱 메뉴는 `{ role: "appMenu" }` 대신 명시 템플릿이다 — "업데이트 확인…"을 넣을 자리가 필요해서다.
 * Electron 44.3.0의 appMenu가 내던 항목(about·services·hide·hideOthers·unhide·quit과 구분선)을
 * 그대로 재현한다 (Phase 6b-1 스펙 §4.4). `quit` role은 app.quit()을 거쳐 before-quit 흐름에 닿는다.
 */
export interface MenuHandlers {
  onRetry(): void;
  /** 서비스 상태 창을 연다 (status-window.ts). 이미 열려 있으면 앞으로 가져온다. */
  onShowStatus(): void;
  /** 새 버전을 지금 확인한다 (update/update-flow.ts의 manualCheck). */
  onCheckForUpdates(): void;
}

export function buildMenuTemplate(handlers: MenuHandlers, appName: string): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: "about" },
        { label: "업데이트 확인…", click: () => handlers.onCheckForUpdates() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "서비스",
      submenu: [
        {
          label: "서비스 상태",
          accelerator: "CmdOrCtrl+Alt+S",
          click: () => handlers.onShowStatus(),
        },
        {
          label: "다시 시도",
          accelerator: "CmdOrCtrl+Alt+R",
          click: () => handlers.onRetry(),
        },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows/menu-template.test.ts`
Expected: PASS (3 tests)

Run: `pnpm desktop lint`
Expected: PASS (`menu-template.ts`는 아직 아무도 import하지 않는다)

- [ ] **Step 5: Commit**

```bash
git add desktop/src/windows/menu-template.ts desktop/tests/windows/menu-template.test.ts
git commit -m "feat(desktop): 업데이트 확인을 담은 앱 메뉴 템플릿 — appMenu 항목을 그대로 재현한다"
```

---

### Task 8: `main.ts` 배선

**Files:**
- Modify: `desktop/src/windows/menu.ts` (전체 — Task 7의 템플릿으로)
- Modify: `desktop/src/main.ts` — import 블록(1-72행), 전역 선언(`let quitting = false;` 144행 다음), `showShell`(353-356행), `ask`(463-469행), `announceRestartNotice`(1051-1066행), `ensureHfToken`의 `onboard`(1110행), 토큰 바꾸기의 `openTokenWindow`(1220행), `clearHfToken`의 확인 대화상자(1287행), `reattachWindow`(923-925행), `whenReady` 안(1517행 이후, `installMenu` 호출 포함), `beginQuit`(1609-1614행)
- Modify: `desktop/CLAUDE.md` — 새 절 "새 버전 알림 (Phase 6b-1)"

**Interfaces:**
- Consumes: Task 7 `buildMenuTemplate`, `MenuHandlers`; Task 2 `checkForUpdate`; Task 3 `makeUpdateStateStore`; Task 4 `newerDialogOptions`, `newerChoice`, `currentDialogOptions`, `failedDialogOptions`; Task 5 `createUpdateFlow`, `UpdateFlow`; Task 6 `createUpdateScheduler`, `UpdateScheduler`, `createModalTracker`.

이 Task는 electron 잎이라 단위 테스트가 없다 — 판정은 모두 Task 2~7의 순수 모듈에 있고, 여기는 `lint`·기존 테스트·Task 10 실측이 확인한다.

- [ ] **Step 1: import 추가**

`desktop/src/main.ts`의 `import { installMenu } from "./windows/menu";` 다음 줄에:

```ts
import { checkForUpdate } from "./update/release-check";
import { makeUpdateStateStore } from "./update/update-state";
import { currentDialogOptions, failedDialogOptions, newerChoice, newerDialogOptions } from "./update/dialogs";
import { createUpdateFlow, type UpdateFlow } from "./update/update-flow";
import { createUpdateScheduler, type UpdateScheduler } from "./update/scheduler";
import { createModalTracker } from "./update/modal-tracker";
```

`let quitting = false;`(main.ts:144) 다음 줄에 더한다:

```ts
/**
 * 새 버전 알림 (Phase 6b-1 스펙 §4.4). 셋 다 단일 인스턴스 분기 안(whenReady)에서 한 번 만든다.
 * - updateAttached: 담화 화면이 **실제로** 붙은 창. attachedWindow는 loadURL 전에 서므로 그 증거가
 *   못 된다(스펙 §3-6) — loadURL이 성공한 뒤에만 여기 둔다. showShell이 둘을 함께 지운다.
 * - modals: 다른 앱 모달(ask·재시작 안내·토큰 창). 자동 알림이 그 위에 겹치지 않게 한다.
 */
let updateFlow: UpdateFlow | null = null;
let updateScheduler: UpdateScheduler | null = null;
let updateAttached: BrowserWindow | null = null;
const modals = createModalTracker();
```

- [ ] **Step 2: 붙음 기록과 해제**

`showShell`(main.ts:353-356):

```ts
function showShell(target: BrowserWindow, status: ShellStatus): Promise<void> {
  attachedWindow = null;
  updateAttached = null;
  return showStatus(target, status);
}
```

`reattachWindow`의 `await target.loadURL(renderer.url);` 바로 다음 줄에:

```ts
  // 새 버전 알림이 "붙었다"로 읽는 것은 여기서부터다 — loadURL이 성공했고, 그 사이 showShell이
  // 이 창을 준비 화면으로 되돌리지 않았을 때만 (Phase 6b-1 스펙 §3-6).
  if (attachedWindow === target) {
    updateAttached = target;
    updateScheduler?.onAttached();
  }
```

`beginQuit`의 `clearInterval(readinessTimer);` 다음 줄에:

```ts
        // 업데이트 확인 타이머도 여기서 끈다. before-quit이 아니다 — 종료 확인에서 "취소"하면 앱은
        // 계속 살고, 그때 타이머가 죽어 있으면 자동 확인이 영영 돌지 않는다 (Phase 6b-1 스펙 §3-7).
        updateScheduler?.dispose();
```

- [ ] **Step 3: 다른 모달 세기**

`ask()`(main.ts:463-469) 본문의 **두 줄 전체**(`const target = …`와 `return target === null ? …`, 467-468행)를 다음 두 줄로 바꾼다 — 반환 줄만 바꾸면 `const target`이 두 번 선언된다:

```ts
  const target = parent !== null && !parent.isDestroyed() ? parent : null;
  return modals.track(target === null ? dialog.showMessageBox(options) : dialog.showMessageBox(target, options));
```

`announceRestartNotice`의 `const shown = dialog.showMessageBox(target, options);`:

```ts
  const shown = modals.track(dialog.showMessageBox(target, options));
```

`ensureHfToken`의 `onboard: (notice) =>` 다음 `openTokenWindow<BrowserWindow>({ … })`를 `modals.track(openTokenWindow<BrowserWindow>({ … }))`로 감싼다(닫는 괄호 하나 추가).

토큰 바꾸기의 `token = await openTokenWindow<BrowserWindow>({ … });`를 `token = await modals.track(openTokenWindow<BrowserWindow>({ … }));`로 감싼다.

`clearHfToken`(main.ts:1286-1287)의 `const answer = await dialog.showMessageBox({`를 `const answer = await modals.track(dialog.showMessageBox({`로 바꾸고 그 호출의 닫는 `})`를 `}))`로 바꾼다 — 토큰 삭제 확인 위에 자동 알림이 겹치지 않게(계획 검증 #4).

확인: `grep -n "dialog.showMessageBox" desktop/src/main.ts` — 남은 호출은 `modals.track(` 안이거나 `showUpdateBox` 안이어야 한다. 그 밖의 것이 나오면 같은 방식으로 감싸고 결과 문서에 적는다.

- [ ] **Step 4: 메뉴 설치를 템플릿으로**

`desktop/src/windows/menu.ts` 전체를 바꾼다:

```ts
import { app, Menu } from "electron";
import { buildMenuTemplate, type MenuHandlers } from "./menu-template";

export type { MenuHandlers };

/** 템플릿과 그 이유는 menu-template.ts에 있다. 여기는 electron에 닿는 잎뿐이다. */
export function installMenu(handlers: MenuHandlers): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(handlers, app.name)));
}
```

`main.ts`의 `installMenu({ … })` 안, `onShowStatus: () => statusWindow.open(),` 다음 줄에 더한다:

```ts
      onCheckForUpdates: () => {
        void updateFlow?.manualCheck().catch((e: unknown) => {
          appendSupervisorLog(`업데이트 확인 중 예외 — ${reasonOf(e)}`);
        });
      },
```

- [ ] **Step 5: 흐름과 스케줄러 생성**

`app.whenReady().then(async () => {` 안, `applyPermissionBoundary(allowedOrigins);` **앞**에:

```ts
    const updateState = makeUpdateStateStore(app.getPath("userData"), appendSupervisorLog);
    /** 알림을 붙일 창 — 붙은 창, 없으면 전역 창, 없으면 부모 없이(ask()와 같다). */
    const updateParent = (): BrowserWindow | null => {
      for (const w of [updateAttached, win]) if (w !== null && !w.isDestroyed()) return w;
      return null;
    };
    const showUpdateBox = (options: Electron.MessageBoxOptions) => {
      const parent = updateParent();
      return parent === null ? dialog.showMessageBox(options) : dialog.showMessageBox(parent, options);
    };
    updateFlow = createUpdateFlow(
      {
        check: () => checkForUpdate(app.getVersion(), { fetch: (url, init) => fetch(url, init), now: Date.now }),
        now: Date.now,
        isAttached: () => updateAttached !== null && !updateAttached.isDestroyed() && updateAttached === attachedWindow,
        isRecording: () => (updateAttached === null ? Promise.resolve(false) : isRecordingIn(updateAttached)),
        isShuttingDown: () => quitting || flows.running() !== null,
        isOtherModalOpen: () => modals.isOpen(),
        loadSkipped: () => updateState.loadSkipped(),
        saveSkipped: (v) => updateState.saveSkipped(v),
        showNewer: async ({ current, latest }) =>
          newerChoice((await showUpdateBox(newerDialogOptions(current, latest))).response),
        showInfo: async (info) => {
          await showUpdateBox(info.kind === "current" ? currentDialogOptions(info.current) : failedDialogOptions(info.detail));
        },
        openExternal: (url) => shell.openExternal(url),
        log: appendSupervisorLog,
      },
      app.getVersion(),
    );
    updateScheduler = createUpdateScheduler({
      packaged: app.isPackaged,
      override: process.env.DAMWHA_UPDATE_CHECK_INTERVAL_MS,
      run: () => {
        void updateFlow?.autoCheck().catch((e: unknown) => {
          appendSupervisorLog(`자동 업데이트 확인 중 예외 — ${reasonOf(e)}`);
        });
      },
      log: appendSupervisorLog,
    });
```

- [ ] **Step 6: lint와 전체 테스트**

Run: `pnpm desktop lint`
Expected: PASS — 실패하면 `fetch`의 타입 불일치일 가능성이 크다. `fetch: (url, init) => fetch(url, init)`에서 Node의 `Response`는 `ReleaseFetchResponse`를 구조적으로 만족한다(`status`, `headers.get`, `text()`). 불일치가 나면 오류 문구를 그대로 기록하고 어댑터(`async (u, i) => { const r = await fetch(u, i); return { status: r.status, headers: r.headers, text: () => r.text() }; }`)로 바꾼다.

Run: `pnpm desktop test`
Expected: PASS — 기존 테스트 전부 + Task 1~7의 새 테스트.

Run: `grep -n "updateScheduler?.dispose\|clearInterval(readinessTimer)" desktop/src/main.ts`
Expected: 두 줄이 `beginQuit` 블록 안에 나란히 있다. `before-quit` 핸들러 본문(`const gate = flows.quit.press();` 근처)에는 `updateScheduler`가 **없어야** 한다.

- [ ] **Step 7: desktop/CLAUDE.md에 절 추가**

`desktop/CLAUDE.md`의 릴리스 절 뒤에 추가한다:

```markdown
## 새 버전 알림 (Phase 6b-1)

- `src/update/`는 electron을 값으로 import하지 않는다. 조회(`release-check.ts`)·건너뛴 버전
  (`update-state.ts`, `<userData>/update-state.json`)·대화상자 옵션(`dialogs.ts`)·정책
  (`update-flow.ts`)·타이머(`scheduler.ts`)·모달 카운터(`modal-tracker.ts`). `main.ts`는 잎만 준다.
- 조회는 `GET /repos/Yjason-K/Damwha/releases`의 모든 페이지에서 `v*`·옛 `desktop-v*` 중 최대를
  고른다. `/releases/latest`에 기대지 않는다. 다운로드 URL은 응답이 아니라 태그로 만든다.
- 자동 확인은 packaged에서만, 담화 화면이 처음 **실제로** 붙은 뒤(`updateAttached`, loadURL 성공 뒤)
  1회 + 24시간. 타이머 해제는 `beginQuit` — `before-quit`이 아니다(종료 취소 뒤에도 살아야 한다).
- 실측용 env `DAMWHA_UPDATE_CHECK_INTERVAL_MS`(60,000~86,400,000): 주기를 줄이고 첫 확인도 한 주기
  뒤로 민다.
- 새 버전 대화상자는 `cancelId: 1` — 빼면 Escape가 "다운로드 페이지 열기"를 고를 수 있다.
```

- [ ] **Step 8: Commit**

```bash
git add desktop/src/main.ts desktop/src/windows/menu.ts desktop/CLAUDE.md
git commit -m "feat(desktop): 새 버전 알림을 main에 배선한다 — 붙음 뒤 무장, beginQuit에서 해제"
```

---

### Task 9: 변이 검증 (P6b1-C8)

**Files:**
- Create: `docs/superpowers/reports/2026-09-23-electron-phase-6b-update-notice-results.md` (§1 변이 표만 이 Task에서)

각 변이를 **하나씩** 넣고 지정한 테스트 파일을 돌려 **빨간불**인지 본 뒤 `git checkout -- <파일>`로 되돌린다. 초록으로 살아남으면 그 변이를 잡는 테스트를 더하고(같은 파일), 테스트 커밋을 따로 한다. 동치 변이로 판정하면 이유를 표에 적는다.

- [ ] **Step 1: 변이를 차례로 돌린다**

| # | 파일 | 변이 | 돌릴 테스트 |
| --- | --- | --- | --- |
| M1 | `src/update/release-check.ts` | `r.prerelease !== false` 조건을 지운다 (`if (r.draft !== false) continue;`만 남김) | `tests/update/release-check.test.ts` |
| M2 | `src/update/release-check.ts` | `TAG_SHAPE`의 끝 `$`를 지운다 | 같음 |
| M3 | `src/update/release-check.ts` | `compareVersions` 본문을 `return formatVersion(a) < formatVersion(b) ? -1 : formatVersion(a) > formatVersion(b) ? 1 : 0;`으로 | 같음 |
| M4 | `src/update/release-check.ts` | `readAllPages`에서 `const next = …` 이하를 `return items;` 한 줄로 | 같음 |
| M5 | `src/update/release-check.ts` | `if (latest === null) return { … no_release … }`를 `if (latest === null) return { kind: "current", latest: current };`로 | 같음 |
| M6a | `src/update/update-flow.ts` | `holdReason`의 `isShuttingDown` 줄 삭제 | `tests/update/update-flow.test.ts` |
| M6b | 같음 | `holdReason`의 `isAttached` 줄 삭제 | 같음 |
| M6c | 같음 | `holdReason`의 `isOtherModalOpen` 줄 삭제 | 같음 |
| M6d | 같음 | `if (recording) { … return; }` 블록 삭제 | 같음 |
| M7 | 같음 | `const after = holdReason(); if (after !== null) { … }` 블록 삭제 | 같음 |
| M8 | 같음 | `presentNewer`의 `shown.add(r.version);` 삭제 | 같음 |
| M9 | 같음 | `manualCheck`의 `if (r.kind === "newer") await presentNewer(r);` 앞에 `if (r.kind === "newer" && r.version === deps.loadSkipped()) return;` 추가 | 같음 |
| M10 | 같음 | `check()`의 `if (now < blockedUntil) { … }` 블록 삭제 | 같음 |
| M11 | 같음 | `autoCheck`의 `finally { presenting = false; }`를 없애고 `presenting = false;`를 `await presentNewer(r);` 다음 줄로 옮김 | 같음 |
| M14 | `src/update/update-flow.ts` | `if (presenting \|\| shown.has(r.version) \|\| r.version === deps.loadSkipped()) return;`를 `if (presenting) return;`으로 | `tests/update/update-flow.test.ts` |
| M12 | `src/update/dialogs.ts` | `cancelId: 1,` 삭제 | `tests/update/dialogs.test.ts` |
| M13 | `src/update/scheduler.ts` | `\|\| ms > DEFAULT_INTERVAL_MS` 삭제 | `tests/update/scheduler.test.ts` |

각 줄마다:

```bash
pnpm --filter damwha-desktop exec vitest run <테스트 파일>   # Expected: FAIL (1개 이상)
git checkout -- desktop/<변이한 파일>
```

- [ ] **Step 2: 원상 확인**

Run: `git status --short desktop/src && pnpm desktop test`
Expected: `desktop/src` 변경 없음, 전부 PASS

- [ ] **Step 3: 결과 문서 §1을 쓴다**

`docs/superpowers/reports/2026-09-23-electron-phase-6b-update-notice-results.md`:

```markdown
# Electron Phase 6b-1 — 새 버전 알림 (결과)

스펙: [2026-09-23-electron-phase-6b-update-notice-design.md](../specs/2026-09-23-electron-phase-6b-update-notice-design.md)
계획: [2026-09-23-electron-phase-6b-update-notice.md](../plans/2026-09-23-electron-phase-6b-update-notice.md)

## 1. 변이 검증 (P6b1-C8)

| # | 변이 | 빨간불이 된 테스트 | 판정 |
| --- | --- | --- | --- |
| M1 | … | (실제 실패한 테스트 이름) | 잡힘 |
```

표의 17행을 실제 결과로 채운다. 살아남아 테스트를 보강한 변이는 "보강 후 잡힘"과 추가한 테스트 이름을 적는다.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/reports/2026-09-23-electron-phase-6b-update-notice-results.md desktop/tests
git commit -m "test(desktop): 새 버전 알림의 변이 17종을 돌려 기록한다"
```

---

### Task 10: packaged 실측 (P6b1-C1~C7) — 사람과 함께

**Files:**
- Modify: `docs/superpowers/reports/2026-09-23-electron-phase-6b-update-notice-results.md` (§2 실측, §3 판정표)
- Modify: `docs/electron-migration-roadmap.md` (Phase 6b 절 상태)

GUI 조작(버튼 클릭·Escape·녹음 시작/중지·Wi-Fi·⌘Q)은 **사용자가 직접** 한다. 세션은 빌드·로그 관측·API 응답 기록을 맡고, 사용자가 보고한 것 이상을 기록하지 않는다. **모든 명령은 저장소 루트에서 돌린다** — `cd`하지 않는다(계획 검증 #11).

공통 변수(각 셸에서 다시 정의한다):

```bash
UD="$HOME/Library/Application Support/Damwha"   # main.ts:98 app.setName("Damwha") — dev·packaged 공용
LOG="$UD/logs/supervisor.log"
BUILDS=/private/tmp/claude-501/-Users-jason-projects-Damwha2/a4d35242-6d3b-40aa-9037-64a8d07f3ec4/scratchpad/builds
APP_OLD="$BUILDS/Damwha-0.3.0.app"
APP_CUR="$BUILDS/Damwha-0.3.1.app"
```

**격리 절차 (매 시나리오 시작 전):**

1. 사용자가 실행 중인 담화를 ⌘Q로 끈다(녹음 중이면 확인에서 종료).
2. 세션이 남은 프로세스가 없는지 확인한다 — 하나라도 나오면 시작하지 않는다:
   ```bash
   pgrep -fl "Damwha.app/Contents/MacOS|Electron.app/Contents/MacOS/Electron|electron/cli.js" || echo "none running"
   ```
3. `rm -f "$UD/update-state.json"`
4. 사용자가 Wi-Fi가 켜져 있다고 확인하고, 세션이 API 응답을 기록한다:
   ```bash
   curl -s https://api.github.com/repos/Yjason-K/Damwha/releases \
     | jq '[.[] | select(.tag_name|test("^(desktop-)?v[0-9]")) | {tag_name, prerelease, draft}]'
   ```
   Expected: `desktop-v0.3.1`(prerelease false, draft false)이 있다. 결과 문서 §2에 붙인다.

- [ ] **Step 1: 두 버전 빌드를 따로 보관한다**

두 빌드가 같은 `desktop/out/mac-arm64/Damwha.app`에 나오므로(`package.mjs:116`) 빌드마다 복사해 둔다.

```bash
mkdir -p "$BUILDS"
node -e "const f='desktop/package.json',p=JSON.parse(require('fs').readFileSync(f));p.version='0.3.0';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
pnpm desktop package:desktop
rm -rf "$APP_OLD" && cp -R desktop/out/mac-arm64/Damwha.app "$APP_OLD"
git checkout -- desktop/package.json
pnpm desktop package:desktop
rm -rf "$APP_CUR" && cp -R desktop/out/mac-arm64/Damwha.app "$APP_CUR"
defaults read "$APP_OLD/Contents/Info.plist" CFBundleShortVersionString   # Expected: 0.3.0
defaults read "$APP_CUR/Contents/Info.plist" CFBundleShortVersionString   # Expected: 0.3.1
git status --short desktop/package.json                                    # Expected: 비어 있음
```

- [ ] **Step 2: C1·C2 — 자동 알림과 버튼**

각 항목 앞에 격리 절차.
1. `open -n "$APP_OLD"` → 담화 화면이 붙은 뒤 "새 버전 0.3.1이 나왔어요". 사용자가 **열기** → 브라우저가 `https://github.com/Yjason-K/Damwha/releases/tag/desktop-v0.3.1`을 연다.
2. `DAMWHA_UPDATE_CHECK_INTERVAL_MS=60000 open -n "$APP_OLD"` → 60초 뒤 대화상자, 사용자가 **Escape** → 다음 60초 뒤 대화상자가 **다시 뜨지 않고** `grep "업데이트 확인: 0.3.1 (이번 실행에서 이미 알림)" "$LOG"`가 한 줄 늘어난다.
3. 같은 방식으로 **나중에** → 2와 같은 판정.
4. `open -n "$APP_OLD"` → **이 버전 건너뛰기** → `cat "$UD/update-state.json"` = `{"skippedVersion":"0.3.1"}`. 사용자가 ⌘Q 후(격리 3번은 **건너뛴다**) 다시 `open -n "$APP_OLD"` → 자동 대화상자 없음, `grep "업데이트 확인: 0.3.1 (건너뛴 버전)" "$LOG"`. 앱 메뉴 "업데이트 확인…" → 0.3.1 대화상자가 뜬다.

- [ ] **Step 3: C3·C4 — 최신·실패**

1. 격리 → `open -n "$APP_CUR"` → 메뉴 "업데이트 확인…" → "최신 버전을 쓰고 있어요 / 담화 0.3.1".
2. 사용자가 Wi-Fi를 끈다 → 메뉴 확인 → "업데이트를 확인하지 못했어요" + "인터넷에 연결되어 있지 않은 것 같아요."
3. 격리(Wi-Fi는 끈 채 — 4번 확인은 건너뛴다) → `DAMWHA_UPDATE_CHECK_INTERVAL_MS=60000 open -n "$APP_OLD"`, 70초 → 화면에 아무것도 없고 `grep "업데이트 확인 실패 (offline)" "$LOG"` 한 줄.
4. **사용자가 Wi-Fi를 다시 켠다.** 세션이 격리 4번의 `curl`로 연결을 확인한다 — 다음 Step의 전제다(계획 검증 #10).

- [ ] **Step 4: C5 — 녹음 중 보류**

격리 → `DAMWHA_UPDATE_CHECK_INTERVAL_MS=60000 open -n "$APP_OLD"` → 담화 화면이 붙자마자 사용자가 라이브 녹음 시작 → 60초 뒤 대화상자 없음, `grep "업데이트 알림 보류: 녹음 중 (0.3.1)" "$LOG"` → 사용자가 녹음 중지 → 다음 60초 안에 대화상자가 뜬다. 판정은 로그(받았고 보류했다) + 사용자 보고(중지 뒤 떴다).

- [ ] **Step 5: C6 — 종료 취소 뒤 타이머 생존**

격리 → `DAMWHA_UPDATE_CHECK_INTERVAL_MS=60000 open -n "$APP_OLD"` → 첫 알림에서 "나중에" → 사용자가 녹음을 시작하고 ⌘Q → 종료 확인에서 "취소" → 녹음 중지 → 2분 기다림. 판정: `grep "업데이트 확인: 0.3.1 (이번 실행에서 이미 알림)" "$LOG"`의 타임스탬프가 **취소 시각 뒤에도** 새로 찍힌다.

- [ ] **Step 6: C7 — 메뉴**

`open -n "$APP_CUR"` → 사용자가 앱 메뉴에서 About · 업데이트 확인… · Services ▸ · Hide · Hide Others · Show All · Quit에 해당하는 항목을 확인하고(role 항목의 라벨은 시스템 언어를 따른다), 메뉴의 종료와 ⌘Q가 각각 기존 종료 확인 흐름을 탄다(녹음 중이면 확인을 묻는다).

- [ ] **Step 7: 결과 문서 §2·§3과 로드맵**

결과 문서에 §2(시나리오별 관측 — 사용자가 보고한 문장과 세션이 본 로그를 구분해서), §3(P6b1-C1~C10 판정표)을 쓴다. `docs/electron-migration-roadmap.md`의 Phase 6b 절 `**상태 (2026-09-23): …**` 문단을 실제 상태(구현·변이·실측 결과, 결과 문서 링크)로 갱신한다.

- [ ] **Step 8: graphify와 커밋**

```bash
graphify update .
git add docs/superpowers/reports/2026-09-23-electron-phase-6b-update-notice-results.md docs/electron-migration-roadmap.md
git commit -m "docs(phase6b): 6b-1 packaged 실측 결과를 기록한다"
```

---

## Self-Review

- **스펙 커버리지:** §2.1 태그 전환 → T1. §4.1 → T2. §4.2 → T3. §5 문구 → T4. §4.3 → T5. §4.4 스케줄러·env·해제 → T6·T8, 모달 → T6·T8, 메뉴 → T7, 붙음 기록·부모 → T8. §6 경계 사례 → T2·T5·T6 테스트. §8.1 변이 13종(보류 조건 4개로 펼치고 계획 검증 #3의 재확인 M14를 더해 17행) → T9. §8.2·§9 C1~C7 → T10(Step 2~6), C8 → T9, C9 → T8 Step 6, C10 → T1 Step 4. §10 로드맵 → 계획 검증 커밋(태그 결정 문단)과 T10 Step 7(상태).
- **스펙과 다른 점 하나:** 스펙 §4.4는 대화상자 부모를 "자동 = `updateAttached`, 수동 = `win`"으로 나눴다. 계획은 흐름이 자동/수동을 잎에 알리지 않으므로 `updateAttached → win → 부모 없음` 순서 하나로 합쳤다. 자동은 `isAttached()`를 통과한 뒤에만 띄우므로 그때 `updateAttached`가 살아 있고 결과는 같다.
- **스펙보다 좁힌 것:** env 주기는 10진 숫자열만 받는다(`"1e5"`는 범위 안의 정수여도 거절 — `scheduler.test.ts`가 고정). 한도 대기는 24시간을 넘으면 이상한 값으로 보고 60분으로 대체한다(스펙의 "없거나 이상하면"을 구체화).
- **스펙에 없던 것 하나:** 자동 확인이 조용히 끝나는 갈래(최신·건너뜀·이미 알림)에도 로그 한 줄을 남긴다(T5). 화면은 그대로 조용하고, C2·C6을 로그로 판정하기 위해서다.

## 계획 검증 기록 (코덱스, 2026-09-23)

13건(blocker 2, should-fix 10, nit 1). 코덱스는 순수 테스트 본문 66개를 메모리 하네스로 돌려 전부 통과를 보고했고, 16개 변이가 모두 잡힌다고 보고했다. #1·#4·#7은 세션이 재현해 확인했다(`pnpm desktop exec` → exit 0·테스트 0개, `main.ts:1287`의 추적 안 되는 대화상자, `main.ts:98`의 `app.setName("Damwha")`).

| # | 지적 | 반영 |
| --- | --- | --- |
| 1 | `pnpm desktop exec vitest`가 아무것도 안 돌리고 exit 0 (blocker) | 전부 `pnpm --filter damwha-desktop exec vitest run`, Global Constraints에 금지 명시 |
| 2 | Task 7 커밋이 lint 실패 — `updateFlow`가 `never` (blocker) | `menu.ts`·`main.ts` 변경을 Task 8로 이동 |
| 3 | 녹음 답이 엇갈린 두 확인이 같은 버전을 두 번 띄움 | 표시 직전 `shown`·건너뛰기 재확인, 테스트 2개, 변이 M14 |
| 4 | `clearHfToken` 대화상자가 모달 카운터 밖 | Task 8 Step 3에서 감쌈 + 남은 호출 grep |
| 5 | `ask()` 반환 줄만 바꾸면 `const target` 중복 | 두 줄 교체로 명시 |
| 6 | 거대한 `Retry-After`가 `Infinity` 대기 | `saneWait`(양의 안전 정수, 24시간 이하), 테스트 1개 |
| 7 | userData 경로가 `damwha-desktop`이 아니라 `Damwha` | T10 `UD` 수정 |
| 8 | 종료 확인 패턴이 dev 실행을 놓침 | 격리 절차의 `pgrep` 패턴·⌘Q 확인 |
| 9 | 0.3.1 빌드가 0.3.0 `.app`을 덮음 | 버전별 복사본 `$APP_OLD`·`$APP_CUR` |
| 10 | Wi-Fi를 끈 채 C5로 넘어감 | Step 3-4에서 복구·확인 |
| 11 | `cd desktop`이 뒤 명령의 경로를 깸 | 루트 기준 명령만, `pnpm desktop package:desktop` |
| 12 | 로드맵·`publish.sh:19`에 옛 태그 정책이 남음 | 로드맵은 이 커밋에서 고침, `publish.sh`는 Task 1 |
| 13 | env 파싱이 스펙보다 좁음 (nit) | Self-Review에 명시 |
