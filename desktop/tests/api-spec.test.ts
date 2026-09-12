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
