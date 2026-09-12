import * as path from "path";
import { launchDev, launchPackaged } from "../api-process";
import { MAX_PORT_ATTEMPTS, choosePort, isAddrInUse } from "../port";
import { probeHealth } from "../readiness";
import type { ProbeResult } from "../readiness";
import { ANSI_SGR, failureBlock } from "../stderr";
import type { LaunchContext, LaunchResult, ReadinessResult, ServiceHandle, ServiceSpec } from "./types";

/**
 * be/src/database/database.service.ts:44-53이 찍는 줄. 앱이 pg 클라이언트를 갖지 않고
 * 미적용 마이그레이션을 아는 유일한 길이다 — 의존을 더하면 desktop의 dependencies가 비지 않아
 * 번들 위생 기준이 깨진다 (스펙 §6.7).
 *
 * 인자 이름을 stdout으로 둔다: NestJS 기본 ConsoleLogger는 `.error()`만 stderr로
 * 보내고 `.warn()`(이 줄이 쓰는 레벨)은 stdout에 쓴다(2026-09-12 실측,
 * @nestjs/common의 console-logger.service.js — printMessages가 writeStreamType을
 * 안 받으면 process.stdout으로 떨어진다). 처음 구현은 이걸 handle.stderrTail()에
 * 넣어 호출했는데, 실제로 API를 띄워 stdout·stderr를 분리 캡처하기 전까지는 문구·
 * 정규식이 실측과 일치한다는 이유로 이 실수를 못 잡았다 — 게이트가 있는데 한 번도
 * 발화하지 않는, 화면은 멀쩡한데 스키마가 빈 최악의 실패로 이어질 뻔했다.
 */
const PENDING = /(\d+)\s+pending migration\(s\):\s*([^\n]*?)\s*—\s*run/;
const SKIPPED = /pending migration check skipped/;

export function pendingMigrations(stdout: string): { count: number; names: string } | null {
  const m = PENDING.exec(stdout.replace(ANSI_SGR, ""));
  return m === null ? null : { count: Number(m[1]), names: m[2] };
}

export function migrationCheckSkipped(stdout: string): boolean {
  return SKIPPED.test(stdout.replace(ANSI_SGR, ""));
}

export interface ApiDeps {
  /** Phase 1의 소유 증명. main.ts가 그대로 넘긴다. */
  verifyOwnListener(port: number, pid: number | undefined): Promise<boolean>;
  isPortOccupied(port: number): Promise<boolean>;
  onPendingMigrations(info: { count: number; names: string }): void;
  onMigrationCheckSkipped(): void;
}

/**
 * probeHealth가 이미 답한 뒤의 판정만 따로 뗐다. probeHealth 자신은 실제 HTTP를
 * 쏘므로, readiness() 안에 있으면 "게이트가 stdout을 읽는지 stderr를 읽는지"를
 * 실제로 뜬 서버 없이는 검증할 수 없다 — 가짜 handle과 이미 정해진 probe 결과만으로
 * 순수하게 부를 수 있게 갈라낸 것이 이 함수다. 바로 이 분리가 없어서 스트림이
 * 틀렸다는 것을 브리프 단계에서 못 잡았다 (위 PENDING 주석 참고).
 *
 * stderr 꼬리는 매개변수로 받지 않고 handle에서 직접 읽는다. handle이 이미
 * stderrTail()을 갖고 있는데 따로 받으면, 호출자가 다른 handle의 꼬리를 잘못
 * 넘길 길이 열린다 — 실제로 이전 테스트 한 곳이 그 형태였다(값은 우연히 같았지만
 * 타입은 그 불일치를 막지 못했다).
 */
export async function judgeAfterProbe(
  handle: ServiceHandle,
  probe: ProbeResult,
  port: number,
  deps: ApiDeps,
): Promise<ReadinessResult> {
  const stderrTail = handle.stderrTail();
  if (probe === "ready") {
    // 메커니즘 (b): 200을 받아도 그 리스너가 우리 자식인지 증명한다 (Phase 1 §6.4).
    if (!(await deps.verifyOwnListener(port, handle.pid))) return { kind: "not-ready" };

    // 게이트는 health 200 뒤에만 본다. 이보다 이르면 경고가 아직 로그에 없어
    // 게이트가 매번 통과한다.
    const stdoutTail = handle.stdoutTail();
    const pending = pendingMigrations(stdoutTail);
    if (pending !== null) {
      deps.onPendingMigrations(pending);
      return {
        kind: "failed",
        detail:
          `적용되지 않은 마이그레이션이 ${pending.count}개 있어요 (${pending.names}).\n` +
          "터미널에서 `pnpm be:migrate`를 실행한 뒤 다시 시도해 주세요.",
      };
    }
    if (migrationCheckSkipped(stdoutTail)) deps.onMigrationCheckSkipped();
    return { kind: "ready" };
  }
  if (probe === "db-unreachable") {
    // 부팅 뒤 DB가 끊긴 경우다. 프로세스는 살아 있으므로 degraded이지 failed가 아니다 —
    // failed면 재시작 정책이 발화해 백오프만 태운다 (스펙 §6.6).
    return {
      kind: "degraded",
      detail: "데이터베이스에 연결할 수 없어요. DB가 뜨면 자동으로 복구됩니다.",
    };
  }
  if (!handle.alive() || /database unreachable/.test(stderrTail)) {
    return { kind: "failed", detail: failureBlock(stderrTail) };
  }
  return { kind: "not-ready" };
}

export function apiSpec(deps: ApiDeps): ServiceSpec {
  let port = 0;
  let origin: string | null = null;

  return {
    id: "api",
    dependsOn: ["postgres"],
    gate: true,
    // 부팅 뒤 DB가 끊기면 API는 죽지 않고 503을 준다. 그 전환을 관찰하는 유일한 수단이
    // 이 주기적 재확인이다 — 없으면 running/ok로 영원히 남는다 (스펙 §6.6, P2-C11).
    // /api/health 한 번이라 값싸다.
    healthIntervalMs: 10_000,
    async detectExternal() {
      // 외부 API는 채택 대상도 비기동 대상도 아니다 — launch()가 포트를 옮긴다 (Phase 1 §6.4).
      return { kind: "absent" };
    },
    async launch(ctx): Promise<LaunchResult> {
      const requested = Number(ctx.env.PORT ?? "3000");
      const base =
        Number.isInteger(requested) && requested >= 1 && requested <= 65535 ? requested : 3000;

      for (let i = 0; i < MAX_PORT_ATTEMPTS; i += 1) {
        const candidate = await choosePort(base, i);
        // 메커니즘 (a): 스폰 전 사전 점검 (Phase 1 §6.4).
        if (await deps.isPortOccupied(candidate)) continue;

        const root = ctx.packaged ? path.join(process.resourcesPath, "api") : ctx.repoRoot;
        const handle = (ctx.packaged ? launchPackaged : launchDev)({
          entry: path.join(root, "dist", "main.js"),
          cwd: root,
          env: { ...ctx.env, PORT: String(candidate) },
          logFile: ctx.logFile("api"),
        });
        port = candidate;
        origin = `http://127.0.0.1:${candidate}`;
        return { handle, owned: true, origin };
      }
      throw new Error(`${MAX_PORT_ATTEMPTS}번 시도했지만 쓸 수 있는 포트를 찾지 못했어요.`);
    },
    async readiness(result): Promise<ReadinessResult> {
      const handle = result.handle;
      if (handle === null || origin === null) return { kind: "failed", detail: "핸들이 없어요." };

      const tail = handle.stderrTail();
      if (isAddrInUse(tail)) return { kind: "failed", detail: "포트가 이미 쓰이고 있어요." };

      const probe = await probeHealth(origin);
      return judgeAfterProbe(handle, probe, port, deps);
    },
    async stop(result, plan) {
      const handle = result.handle;
      if (handle === null) return { stopped: true, leaked: [] };
      await handle.stop(plan.graceMs);
      const leaked = handle.alive() && handle.pid !== undefined ? [handle.pid] : [];
      return { stopped: leaked.length === 0, leaked };
    },
    restart: { maxAttempts: 3, backoffMs: [3_000, 8_000, 20_000] },
  };
}
