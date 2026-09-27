import { describe, expect, it, vi } from "vitest";
import { RELEASES_PAGE, downloadHref, fetchLatestRelease, formatSize, parseRelease } from "./release";

const good = {
  tag_name: "v0.4.1",
  published_at: "2026-09-27T06:06:26Z",
  assets: [
    { name: "Damwha-0.4.1-arm64.dmg.sha256", browser_download_url: "https://x/sha", size: 90 },
    { name: "Damwha-0.4.1-arm64.dmg", browser_download_url: "https://x/dmg", size: 1_288_490_189 },
  ],
};

const okFetch = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("parseRelease", () => {
  it("태그에서 v를 떼고 .dmg 자산을 고른다(.sha256이 아니라)", () => {
    expect(parseRelease(good)).toEqual({
      kind: "asset",
      version: "0.4.1",
      dmgUrl: "https://x/dmg",
      sizeBytes: 1_288_490_189,
      publishedAt: "2026-09-27T06:06:26Z",
    });
  });

  it("DMG 자산이 없으면 null", () => {
    expect(parseRelease({ ...good, assets: [good.assets[0]] })).toBeNull();
  });

  it("모양이 다르면 null — 던지지 않는다", () => {
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease({ message: "API rate limit exceeded" })).toBeNull();
    expect(parseRelease({ ...good, tag_name: 3 })).toBeNull();
  });
});

describe("fetchLatestRelease", () => {
  it("정상 응답이면 asset", async () => {
    const r = await fetchLatestRelease({ fetchImpl: okFetch(good), warn: () => {} });
    expect(r.kind).toBe("asset");
  });

  it("HTTP 오류(403 rate limit)면 fallback + 경고, 던지지 않는다", async () => {
    const warn = vi.fn();
    const r = await fetchLatestRelease({ fetchImpl: okFetch({ message: "rate limit" }, 403), warn });
    expect(r).toEqual({ kind: "fallback", pageUrl: RELEASES_PAGE });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("403"));
  });

  it("네트워크 오류(오프라인)면 fallback", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const r = await fetchLatestRelease({ fetchImpl, warn: () => {} });
    expect(r.kind).toBe("fallback");
  });

  it("응답이 timeoutMs보다 늦으면 fallback", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        }),
    ) as unknown as typeof fetch;
    const r = await fetchLatestRelease({ fetchImpl, warn: () => {}, timeoutMs: 20 });
    expect(r.kind).toBe("fallback");
  });

  it("token이 있으면 Authorization 헤더를 싣는다 — 공유 빌더 IP의 비인증 한도(60/h)를 피한다", async () => {
    const fetchImpl = okFetch(good);
    await fetchLatestRelease({ fetchImpl, warn: () => {}, token: "ghp_x" });
    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ghp_x");
  });

  it("token이 없으면 Authorization 헤더가 없다", async () => {
    const fetchImpl = okFetch(good);
    await fetchLatestRelease({ fetchImpl, warn: () => {}, token: "" });
    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1];
    expect(init.headers as Record<string, string>).not.toHaveProperty("Authorization");
  });

  it("DMG 없는 릴리스면 fallback", async () => {
    const r = await fetchLatestRelease({ fetchImpl: okFetch({ ...good, assets: [] }), warn: () => {} });
    expect(r.kind).toBe("fallback");
  });
});

describe("formatSize / downloadHref", () => {
  it("GB는 소수 한 자리, 1 GB 미만은 MB 정수", () => {
    expect(formatSize(1_288_490_189)).toBe("1.2 GB");
    expect(formatSize(891_289_600)).toBe("850 MB");
  });

  it("fallback이면 릴리스 페이지", () => {
    expect(downloadHref({ kind: "fallback", pageUrl: RELEASES_PAGE })).toBe(RELEASES_PAGE);
    expect(downloadHref(parseRelease(good)!)).toBe("https://x/dmg");
  });
});
