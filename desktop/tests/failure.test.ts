import { describe, expect, it } from "vitest";
import { manualUnlessTagged, recoveryOf, ServiceFailure } from "../src/services/failure";

describe("ServiceFailure", () => {
  it("carries its recovery class and message", () => {
    const e = new ServiceFailure("짝이 맞지 않아요", "manual");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("짝이 맞지 않아요");
    expect(recoveryOf(e)).toBe("manual");
  });

  it("has no class for a plain error — the supervisor reads that as auto (Phase 2 adapters)", () => {
    expect(recoveryOf(new Error("x"))).toBeUndefined();
    expect(recoveryOf("x")).toBeUndefined();
  });
});

describe("manualUnlessTagged", () => {
  it("turns an unexpected error into a manual failure — new code paths must not leak into auto retry", async () => {
    // 스펙 §6.7(외부 리뷰 #2). 도구의 낯선 종료 코드나 카탈로그에 없는 initdb 문구가 20초마다 다시 돌면 안 된다.
    const r = manualUnlessTagged(async () => {
      throw new Error("알 수 없는 initdb 출력");
    });
    await expect(r).rejects.toBeInstanceOf(ServiceFailure);
    await expect(r).rejects.toMatchObject({ recovery: "manual", message: "알 수 없는 initdb 출력" });
  });

  it("keeps an explicit auto tag", async () => {
    const r = manualUnlessTagged(async () => {
      throw new ServiceFailure("잠깐 기다리면 풀려요", "auto");
    });
    await expect(r).rejects.toMatchObject({ recovery: "auto" });
  });

  it("passes the value through", async () => {
    await expect(manualUnlessTagged(async () => 7)).resolves.toBe(7);
  });
});
