import { describe, expect, it } from "vitest";
import { maySpawnServices } from "../src/spawn-guard";

const ok = { quitting: false, generation: 3, mine: 3, hasWindow: true };

describe("maySpawnServices", () => {
  it("lets the current generation proceed while a live window is up", () => {
    expect(maySpawnServices(ok)).toBe(true);
  });

  it("refuses once quitting has begun", () => {
    // stopAll()은 진입 즉시 supervisor를 스냅숏한다. 감독자가 아직 null인 동안 종료가
    // 지나가면, 그 뒤에 뜨는 docker compose up -d와 detached 자식 둘은 아무도 정리하지
    // 않는다 (P2-C4는 그런 프로세스를 0으로 판정한다).
    expect(maySpawnServices({ ...ok, quitting: true })).toBe(false);
  });

  it("refuses a stale generation — a newer start() already owns the globals", () => {
    expect(maySpawnServices({ ...ok, mine: 2 })).toBe(false);
  });

  it("refuses when there is no live window to attach to", () => {
    expect(maySpawnServices({ ...ok, hasWindow: false })).toBe(false);
  });
});
