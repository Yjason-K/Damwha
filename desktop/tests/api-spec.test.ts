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

    const result = await judgeAfterProbe(handle, "ready", 3000, fakeDeps({ onPendingMigrations }));

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

    const result = await judgeAfterProbe(handle, "ready", 3000, fakeDeps({ onPendingMigrations }));

    expect(result.kind).toBe("ready");
    expect(onPendingMigrations).not.toHaveBeenCalled();
  });

  it("stdout의 검사 건너뜀 경고도 잡는다 — stderr에 있으면 못 잡는다", async () => {
    const onMigrationCheckSkipped = vi.fn();
    const skipped = "WARN pending migration check skipped: ENOENT";

    const inStdout = fakeHandle({ stdout: skipped, stderr: "" });
    const r1 = await judgeAfterProbe(inStdout, "ready", 3000, fakeDeps({ onMigrationCheckSkipped }));
    expect(r1.kind).toBe("ready");
    expect(onMigrationCheckSkipped).toHaveBeenCalledOnce();

    onMigrationCheckSkipped.mockClear();
    const inStderr = fakeHandle({ stdout: "", stderr: skipped });
    const r2 = await judgeAfterProbe(inStderr, "ready", 3000, fakeDeps({ onMigrationCheckSkipped }));
    expect(r2.kind).toBe("ready");
    expect(onMigrationCheckSkipped).not.toHaveBeenCalled();
  });
});

describe("judgeAfterProbe — 소유 증명이 게이트보다 먼저다", () => {
  // Phase 1 §6.4: health 200은 "그 포트에서 누군가 200을 줬다"는 뜻일 뿐, 우리 자식이
  // 준 200이라는 증거가 아니다 — 다른 프로세스가 같은 포트를 먼저 잡았을 수 있다.
  // verifyOwnListener가 그 증명이고, 이게 실패하면 아래의 마이그레이션 게이트는 아예
  // 평가돼서는 안 된다 — 남의 프로세스의 stdout을 우리 마이그레이션 판정에 쓰면 안 되니까.
  it("소유가 증명되지 않으면 not-ready로 돌아가고 게이트 콜백은 하나도 부르지 않는다", async () => {
    const onPendingMigrations = vi.fn();
    const onMigrationCheckSkipped = vi.fn();
    // stdout에 마이그레이션 경고를 일부러 채워 둔다 — 게이트가 소유 증명을 건너뛰고
    // 평가까지 가 버리면 이 콜백들이 불려서 드러난다.
    const handle = fakeHandle({ stdout: WARN, stderr: "" });
    const deps = fakeDeps({
      verifyOwnListener: async () => false,
      onPendingMigrations,
      onMigrationCheckSkipped,
    });

    const result = await judgeAfterProbe(handle, "ready", 3000, deps);

    expect(result).toEqual({ kind: "not-ready" });
    expect(onPendingMigrations).not.toHaveBeenCalled();
    expect(onMigrationCheckSkipped).not.toHaveBeenCalled();
  });
});

describe("judgeAfterProbe — db-unreachable은 degraded다", () => {
  // 스펙 §6.6: 부팅 뒤 DB가 끊겨도 API 프로세스는 죽지 않고 503을 준다. 여기서 failed를
  // 돌리면 감독자의 재시작 정책이 발화하는데, 재시작해도 DB가 돌아오지 않으므로 백오프
  // 예산만 태우고 끝난다 — degraded로만 표시하고 살려 둬야 DB가 돌아왔을 때 자동 회복된다.
  it("db-unreachable은 failed가 아니라 degraded로 간다", async () => {
    const handle = fakeHandle({});

    const result = await judgeAfterProbe(handle, "db-unreachable", 3000, fakeDeps());

    expect(result.kind).toBe("degraded");
  });
});

describe("judgeAfterProbe — 살아 있어도 startup failed면 실패다 (Task 14)", () => {
  // dev의 자식은 `nest start --watch`다. 안의 node가 fail-fast로 exit(1)해도 nest CLI는 파일 변경을
  // 기다리며 살아 있어서, alive()만 보면 준비 유예 60초를 다 채운 뒤 "준비 시간을 넘겼어요."로만
  // 끝났다 — zod 원인 블록은 한 줄도 화면에 오르지 않았다.
  it("fails with the whole block while the watcher is still alive", async () => {
    const handle = fakeHandle({
      stderr: 'ERROR [Bootstrap] startup failed: [\n  { "path": ["SUMMARY_LLM_MODEL"] }\n]\n',
    });
    const result = await judgeAfterProbe(handle, "no-response", 3000, fakeDeps());
    expect(result).toEqual({
      kind: "failed",
      detail: 'ERROR [Bootstrap] startup failed: [\n  { "path": ["SUMMARY_LLM_MODEL"] }\n]',
    });
  });

  it("still waits while a live process has not answered and has not failed", async () => {
    const handle = fakeHandle({ stderr: "[Nest] LOG compiling…\n" });
    expect(await judgeAfterProbe(handle, "no-response", 3000, fakeDeps())).toEqual({ kind: "not-ready" });
  });
});
