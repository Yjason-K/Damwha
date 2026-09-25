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
