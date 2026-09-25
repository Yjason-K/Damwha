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
