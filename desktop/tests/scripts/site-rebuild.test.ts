import { describe, expect, it, vi } from "vitest";
import { triggerSiteRebuild } from "../../scripts/lib/site-rebuild.mjs";

describe("triggerSiteRebuild", () => {
  it("훅 URL이 없으면 건너뛰고 그렇다고 말한다", async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn();
    expect(await triggerSiteRebuild({ hookUrl: "", fetchImpl, log })).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("건너뜀"));
  });

  it("훅에 POST한다", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await triggerSiteRebuild({ hookUrl: "https://hook", fetchImpl, log: () => {} })).toBe("triggered");
    expect(fetchImpl).toHaveBeenCalledWith("https://hook", expect.objectContaining({ method: "POST" }));
  });

  it("HTTP 오류나 네트워크 오류는 failed — 던지지 않는다(릴리스는 이미 나갔다)", async () => {
    const bad = vi.fn(async () => new Response("no", { status: 500 }));
    expect(await triggerSiteRebuild({ hookUrl: "https://hook", fetchImpl: bad, log: () => {} })).toBe("failed");
    const boom = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await triggerSiteRebuild({ hookUrl: "https://hook", fetchImpl: boom, log: () => {} })).toBe("failed");
  });
});
