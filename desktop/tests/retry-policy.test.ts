import { describe, expect, it } from "vitest";
import { mayAutoRetry } from "../src/retry-policy";
import { ServiceFailure } from "../src/services/failure";
import type { ServiceStatus } from "../src/services/types";

const st = (over: Partial<ServiceStatus>): ServiceStatus => ({
  id: "postgres",
  process: "failed",
  health: "unknown",
  owned: true,
  restarts: 0,
  ...over,
});

describe("mayAutoRetry", () => {
  it("retries a failure that carries no class — Phase 2's recovery paths stay as they were", () => {
    expect(mayAutoRetry([st({ detail: "프로세스가 종료됐어요 (코드 1)." })])).toBe(true);
  });

  it("retries an explicit auto failure", () => {
    expect(mayAutoRetry([st({ recovery: "auto" })])).toBe(true);
  });

  it("does not retry when any failed service needs a person — a migration failure must not rerun every 20 seconds", () => {
    // Phase 2 결과 §5.2-1. 그대로 두면 마이그레이션이 20초마다 재실행되고 백업이 하나씩 쌓인다.
    expect(mayAutoRetry([st({ recovery: "manual" }), st({ id: "api", process: "stopped" })])).toBe(false);
  });

  it("ignores a manual tag left on a service that is no longer failed", () => {
    expect(mayAutoRetry([st({ process: "running", health: "ok", recovery: "manual" })])).toBe(true);
  });

  it("does not retry a manual failure thrown before the supervisor exists", () => {
    expect(mayAutoRetry(null, new ServiceFailure("번들에 PG가 없어요", "manual"))).toBe(false);
    expect(mayAutoRetry(null, new Error("저장소 폴더를 확인하지 못했어요."))).toBe(true);
  });
});
