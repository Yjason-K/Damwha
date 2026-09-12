import { describe, expect, it } from "vitest";
import { buildSpecs, type SpecDeps } from "../src/services/specs";
import { orderOf } from "../src/services/supervisor";

/**
 * 전부 가짜다 — 이 테스트가 보는 것은 어댑터의 동작이 아니라 **선언 배열 자체**이기
 * 때문이다. 배열이 정하는 두 성질(종료 순서, 게이트 집합)은 각 spec의 id/dependsOn/gate만
 * 있으면 판정되고, 그 셋은 deps와 무관하다.
 */
const fakes: SpecDeps = {
  docker: async () => ({ stdout: "", stderr: "", code: 0 }),
  api: {
    verifyOwnListener: async () => true,
    isPortOccupied: async () => false,
    onPendingMigrations: () => undefined,
    onMigrationCheckSkipped: () => undefined,
  },
  embed: { probe: async () => ({ kind: "absent" as const }), freePort: async () => 8100 },
  worker: { listExternal: async () => [] },
};

describe("buildSpecs", () => {
  it("declares exactly the four services the phase owns", () => {
    expect(buildSpecs(fakes).map((s) => s.id)).toEqual(["postgres", "api", "embed", "worker"]);
  });

  it("reverses to the shutdown order the spec requires — worker → embed → api → postgres", () => {
    // 스펙 §6.9. supervisor.stopAll은 orderOf(...)를 reverse해 내리므로, 선언 순서를 바꾸는
    // 것이 곧 종료 순서를 바꾸는 것이다. embed가 worker보다 먼저 죽으면 worker의 진행 중
    // job이 임베딩을 잃는다.
    expect([...orderOf(buildSpecs(fakes))].reverse().map((s) => s.id)).toEqual([
      "worker",
      "embed",
      "api",
      "postgres",
    ]);
  });

  it("gates only postgres and api — embed and worker come up behind the window", () => {
    // 스펙 §6.7. embed는 bge-m3 로딩에 31초(실측)가 걸리고 worker는 그동안에도 앱을 쓸 수
    // 있다. 여기서 gate를 하나 더 켜면 창이 그만큼 늦게 뜬다.
    const specs = buildSpecs(fakes);
    expect(specs.filter((s) => s.gate).map((s) => s.id)).toEqual(["postgres", "api"]);
    expect(specs.filter((s) => !s.gate).map((s) => s.id)).toEqual(["embed", "worker"]);
  });
});
