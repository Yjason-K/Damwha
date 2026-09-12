import type { EmbedProbe } from "./external";
import { launchWithUv } from "./worker";
import type { LaunchContext, ReadinessResult, ServiceSpec } from "./types";

export interface EmbedDeps {
  probe(baseUrl: string): Promise<EmbedProbe>;
  freePort(): Promise<number>;
}

/**
 * 아래 prepare가 **읽거나 만들어 내는** 키. 재시도의 config.json 재적용이 이 집합을 건너뛴다
 * (config.ts의 refreshEnv, config-reload.ts).
 *
 * 파생의 입력(HOST·PORT)과 결과(URL)가 한 집합인 이유: 입력만 다시 읽고 파생을 다시 돌리지
 * 않으면 URL이 옛 포트에 남는다. 그 어긋남은 오류가 아니라 **조용한 degrade**다 — API는
 * 죽지 않고 의미 검색만 키워드 검색으로 떨어진다. 그래서 "실행 중에는 안 바꾼다, 대신
 * 말한다"가 유일하게 정직한 답이다 (재리뷰 §4-1).
 *
 * HOST를 넣어 두는 것은 지금은 무해한 중복이다(앱이 127.0.0.1을 고정 주입하므로 파일 값과
 * 살아 있는 값이 어긋날 수 없다). 그래도 함께 둔다 — 이 집합의 정의는 "prepare가 의존하는
 * 키"이지 "지금 어긋날 수 있는 키"가 아니고, 둘을 섞으면 다음 사람이 HOST의 성질이 바뀌는
 * 순간 같은 결함을 다시 만든다.
 */
export const PREPARE_DERIVED_KEYS = [
  "EMBED_SERVICE_HOST",
  "EMBED_SERVICE_PORT",
  "EMBED_SERVICE_URL",
] as const;

function baseUrl(host: string, port: string): string {
  return `http://${host}:${port}`;
}

export function embedSpec(deps: EmbedDeps): ServiceSpec {
  let adopted = false;
  let url = "";

  return {
    id: "embed",
    // DB를 쓰지 않으므로 postgres와 나란히 뜬다. 게이트도 아니다 — bge-m3 로딩 때문에
    // 앱 전체를 세우는 것은 손해이고, 그동안에도 회의 목록과 업로드는 동작한다 (스펙 §6.7).
    dependsOn: [],
    gate: false,
    // 2026-09-12 실측: 최소 PATH + 절대 경로 uv로 /health 200까지 31초(따뜻한 모델 캐시).
    // 기본 60초로는 캐시가 식은 첫 실행을 못 덮는다.
    readyTimeoutMs: 180_000,
    // 짧은 문자열 임베딩 1회라 30초 주기면 무시할 만하다. 채택한 외부 embed가 내려가는
    // 것도 이 경로로 알아챈다 (스펙 §6.6).
    healthIntervalMs: 30_000,
    async prepare(ctx: LaunchContext) {
      const host = ctx.env.EMBED_SERVICE_HOST ?? "127.0.0.1";
      const wanted = ctx.env.EMBED_SERVICE_PORT ?? "8100";
      const probe = await deps.probe(baseUrl(host, wanted));

      // /health가 아니라 /embed 계약으로 판정한다 — /health는 {"status":"ok"}만 주므로
      // 다른 모델·차원도 200을 준다 (스펙 §6.5).
      if (probe.kind === "match") {
        adopted = true;
        url = baseUrl(host, wanted);
        return { EMBED_SERVICE_PORT: wanted, EMBED_SERVICE_URL: url };
      }
      const port = probe.kind === "mismatch" ? String(await deps.freePort()) : wanted;
      adopted = false;
      url = baseUrl(host, port);
      // API는 EMBED_SERVICE_URL을, worker/embed는 HOST/PORT를 읽는다. 한 값에서 둘을
      // 파생하지 않으면 어긋나고, 어긋난 결과는 오류가 아니라 조용한 degrade다.
      return { EMBED_SERVICE_PORT: port, EMBED_SERVICE_URL: url };
    },
    async detectExternal() {
      return adopted
        ? { kind: "adopt" as const, detail: `이미 실행 중인 embed (${url})` }
        : { kind: "absent" as const };
    },
    async launch(ctx) {
      if (adopted) return { handle: null, owned: false };
      return launchWithUv({ ctx, args: ["damwha-embed"], logId: "embed" });
    },
    async readiness(result): Promise<ReadinessResult> {
      const handle = result.handle;
      if (handle !== null && !handle.alive()) {
        return { kind: "failed", detail: handle.stderrTail().split("\n").slice(-12).join("\n").trim() };
      }
      const probe = await deps.probe(url);
      if (probe.kind === "match") return { kind: "ready" };
      if (probe.kind === "mismatch") return { kind: "failed", detail: probe.detail };
      return { kind: "not-ready" };
    },
    async stop(result, plan) {
      const handle = result.handle;
      // 채택한 외부 embed는 핸들이 없다 — 죽일 대상 자체가 없다.
      if (handle === null) return { stopped: true, leaked: [] };
      await handle.stop(plan.graceMs);
      const leaked = handle.alive() && handle.pid !== undefined ? [handle.pid] : [];
      return { stopped: leaked.length === 0, leaked };
    },
    restart: { maxAttempts: 3, backoffMs: [3_000, 8_000, 20_000] },
  };
}
