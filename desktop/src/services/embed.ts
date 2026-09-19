import { exitCauseBlock } from "../diagnostics/stderr";
import { knownTrees, parseDamwhaScan } from "../process/orphans";
import { launchPython } from "../process/python-launcher";
import type { SpawnFn } from "../process/tool-runner";
import type { EmbedProbe } from "./embed-probe";
import type { LaunchContext, ReadinessResult, ServiceSpec } from "./types";

export interface EmbedDeps {
  probe(baseUrl: string): Promise<EmbedProbe>;
  freePort(): Promise<number>;
  /** 그 포트에서 LISTEN 중인 pid (process/process-tree.ts의 listenerPids — lsof 실패는 빈 배열). */
  listenerPids(port: number): Promise<number[]>;
  /** `ps -axwwo pid,args` (process/process-tree.ts의 psArgs). 채택 후보가 누구인지 읽는다. */
  psArgs(): Promise<string>;
  /** 채택하지 않은 까닭 — supervisor.log. 화면에는 오르지 않는 판단이라 여기 남기지 않으면 흔적이 없다. */
  log(line: string): void;
  /** 테스트 주입용. launch()가 그대로 launchPython에 넘긴다 — 기본은 실제 child_process.spawn (WorkerDeps와 같은 이유). */
  spawnFn?: SpawnFn;
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

/**
 * 계약 프로브가 맞은 그 포트의 주인을 채택해도 되는가 (Phase 4 스펙 §6.5). 채택은 **run-id 없는 외부 embed**
 * (터미널 `pnpm embed`)의 몫이다. `--run-id`가 있고 내 것이 아닌 embed는 이전 실행의 고아다 — 한 번 채택하면
 * 그 뒤로 둘이 모델 메모리를 썼다(Phase 3 §5.2-2). 기동 전 정리(app/reap-on-start.ts)가 먼저 내리므로 보통은
 * 여기 오지 않는다. 아는 트리 밖(옮겨 설치한 앱)이라 정리가 손대지 않은 것도 채택하지 않는다 — run-id가
 * 그것이 앱의 자식이었다고 말한다.
 *
 * 이번 실행의 run-id를 단 embed는 **채택한다** (판정 R-7j). 스펙 문구("run-id 없는 외부 embed만")보다 넓은데,
 * 그 경우는 나올 수 없다: prepare는 감독자를 새로 세울 때만 돌고, 그때 앞선 감독자는 embed를 띄운 적이 없다
 * (start()가 거부할 수 있는 지점은 어떤 launch보다 앞선 prepare뿐이다). 그래도 나온다면 거부는 우리 embed 옆에
 * 두 번째 모델을 올리는 일이고, 채택하면 종료 회수가 run-id로 거둔다.
 *
 * 주인을 읽지 못하면(ps 실패, 또는 그 리스너가 아는 트리의 읽을 수 없는 줄) 채택하지 않는다 — 고아가 아니라고
 * 증명하지 못했다.
 */
async function refusal(deps: EmbedDeps, ctx: LaunchContext, port: string): Promise<string | null> {
  const pids = new Set(await deps.listenerPids(Number(port)));
  if (pids.size === 0) return null;
  let text: string;
  try {
    text = await deps.psArgs();
  } catch (e) {
    return `${port} 포트의 embed가 누구인지 확인하지 못했어요 — ${e instanceof Error ? e.message : String(e)}`;
  }
  const scan = parseDamwhaScan(text, knownTrees(ctx));
  const cut = scan.unreadable.find((row) => pids.has(row.pid));
  if (cut !== undefined) return `${port} 포트의 embed(pid ${cut.pid})의 명령줄을 읽을 수 없어요`;
  const orphan = scan.processes.find((p) => pids.has(p.pid) && p.runId !== null && p.runId !== ctx.runId);
  if (orphan === undefined) return null;
  return `${port} 포트의 embed(pid ${orphan.pid}, run-id ${orphan.runId})는 이전 실행이 남긴 것이에요`;
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
      const refused = probe.kind === "match" ? await refusal(deps, ctx, wanted) : null;
      if (probe.kind === "match" && refused === null) {
        adopted = true;
        url = baseUrl(host, wanted);
        return { EMBED_SERVICE_PORT: wanted, EMBED_SERVICE_URL: url };
      }
      // 채택하지 않은 주인은 그 포트를 아직 쥐고 있다 — 같은 자리에 띄우면 bind에서 넘어진다.
      if (refused !== null) deps.log(`${refused}. 채택하지 않고 빈 포트로 새로 띄워요.`);
      const port = probe.kind === "absent" ? wanted : String(await deps.freePort());
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
      // `damwha-embed` 콘솔 스크립트가 아니라 모듈로 들어간다 — 셔뱅을 타지 않는다 (Phase 4 스펙 §6.2).
      return launchPython({ ctx, module: "damwha_worker.embed_service", logId: "embed", spawnFn: deps.spawnFn });
    },
    async readiness(result): Promise<ReadinessResult> {
      const handle = result.handle;
      if (handle !== null && !handle.alive()) {
        // 감독자의 exitedDetail과 같은 블록이다 — 줄 수만 자르면 줄바꿈 없는 한 줄이 상한 없이 화면에 오른다.
        return { kind: "failed", detail: exitCauseBlock(handle.stderrTail()) };
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
