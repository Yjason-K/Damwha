import { describe, expect, it, vi } from "vitest";
import { apiSpec, judgeAfterProbe, migrationCheckSkipped, pendingMigrations } from "../src/services/api";
import type { ApiDeps } from "../src/services/api";
import type { ServiceHandle } from "../src/services/types";

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

/**
 * 진짜 API 자식을 흉내 낸 가짜 handle. stdout·stderr를 각자 독립적으로 조작할 수
 * 있어야 "게이트가 둘 중 어느 쪽을 읽는가"를 고정할 수 있다.
 */
function fakeHandle(streams: { stdout?: string; stderr?: string }): ServiceHandle {
  return {
    pid: 4242,
    alive: () => true,
    stderrTail: () => streams.stderr ?? "",
    stdoutTail: () => streams.stdout ?? "",
    exitCode: () => null,
    onExit: () => undefined,
    stop: async () => undefined,
  };
}

function fakeDeps(over: Partial<ApiDeps> = {}): ApiDeps {
  return {
    verifyOwnListener: async () => true,
    isPortOccupied: async () => false,
    onPendingMigrations: () => undefined,
    onMigrationCheckSkipped: () => undefined,
    ...over,
  };
}

describe("judgeAfterProbe — 게이트가 읽는 스트림 고정", () => {
  // 2026-09-12 실측: NestJS 기본 ConsoleLogger는 .error()만 stderr로 보내고 .warn()은
  // stdout에 쓴다. database.service.ts의 미적용 마이그레이션 경고는 .warn()이라 실전에는
  // 항상 stdout에만 있다 — stderrTail()만 보던 첫 구현은 이 테스트가 없어 회귀를 못 잡았다.
  it("stdout에 있는 경고를 읽어 게이트를 발화시킨다", async () => {
    const onPendingMigrations = vi.fn();
    const handle = fakeHandle({ stdout: WARN, stderr: "" });

    const result = await judgeAfterProbe(handle, handle.stderrTail(), "ready", 3000, fakeDeps({ onPendingMigrations }));

    expect(result.kind).toBe("failed");
    expect(onPendingMigrations).toHaveBeenCalledWith({
      count: 3,
      names: "022_x.sql, 023_y.sql, 024_z.sql",
    });
  });

  it("같은 경고가 stderr에만 있으면 (stdout이 비어 있으면) 게이트는 발화하지 않는다", async () => {
    const onPendingMigrations = vi.fn();
    // stdout은 비고, 경고는(실수로) stderr 쪽에 있는 상황을 뒤집어 확인한다 — 게이트가
    // 우연히 두 스트림을 다 보거나 stderr만 보는 퇴행이 생기면 이 테스트가 깨진다.
    const handle = fakeHandle({ stdout: "", stderr: WARN });

    const result = await judgeAfterProbe(handle, handle.stderrTail(), "ready", 3000, fakeDeps({ onPendingMigrations }));

    expect(result.kind).toBe("ready");
    expect(onPendingMigrations).not.toHaveBeenCalled();
  });

  it("stdout의 검사 건너뜀 경고도 잡는다 — stderr에 있으면 못 잡는다", async () => {
    const onMigrationCheckSkipped = vi.fn();
    const skipped = "WARN pending migration check skipped: ENOENT";

    const inStdout = fakeHandle({ stdout: skipped, stderr: "" });
    const r1 = await judgeAfterProbe(inStdout, "", "ready", 3000, fakeDeps({ onMigrationCheckSkipped }));
    expect(r1.kind).toBe("ready");
    expect(onMigrationCheckSkipped).toHaveBeenCalledOnce();

    onMigrationCheckSkipped.mockClear();
    const inStderr = fakeHandle({ stdout: "", stderr: skipped });
    const r2 = await judgeAfterProbe(inStderr, skipped, "ready", 3000, fakeDeps({ onMigrationCheckSkipped }));
    expect(r2.kind).toBe("ready");
    expect(onMigrationCheckSkipped).not.toHaveBeenCalled();
  });
});
