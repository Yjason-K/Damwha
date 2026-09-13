import { causeIn, type CauseId } from "./causes";
import type { ServiceId, ServiceStatus } from "./services/types";

/**
 * 원인마다 복구 방법을 짝짓는다. 모르는 원인에는 아무 말도 하지 않는다 — 그럴듯한 안내를
 * 붙이면 사용자를 엉뚱한 곳으로 보낸다 (스펙 §6.12).
 *
 * electron을 import하지 않는 순수 모듈이다. shell-window.ts는 electron을 값으로 가져와
 * vitest가 못 불러오므로, 테스트 대상 로직은 여기 둔다 (Phase 1의 stderr.ts와 같은 이유).
 */

/**
 * 원인 하나의 안내. `null`은 "알려진 원인이지만 사람이 할 일이 없거나 모른다"이고, 서비스마다
 * 다르면 id별로 적는다(적지 않은 id에는 안내가 없다).
 */
type Hint = string | null | Partial<Record<ServiceId, string>>;

const INSTALL_OR_CONFIGURE = "설치했는지 확인하거나, config.json의 UV_BIN·DOCKER_BIN에 경로를 적어 주세요.";

/**
 * `Record<CauseId, …>`라서 causes.ts에 원인을 더하고 여기서 안내를 정하지 않으면 lint(tsc)가
 * 걸린다. 그 강제가 이 표가 "손으로 적은 목록이라 원인 하나를 조용히 빠뜨리는" 일을 막는다.
 */
export const HINTS: Record<CauseId, Hint> = {
  dockerDaemonDown: "Docker Desktop을 실행한 뒤 다시 시도해 주세요.",
  dockerMissing: INSTALL_OR_CONFIGURE,
  uvMissing: INSTALL_OR_CONFIGURE,
  // uv를 부르는 것은 worker·embed, docker를 부르는 것은 postgres다. dev의 API 런처는 pnpm을
  // 부르므로 거기에 UV_BIN·DOCKER_BIN을 말하면 틀린 안내다.
  spawnNotFound: { postgres: INSTALL_OR_CONFIGURE, worker: INSTALL_OR_CONFIGURE, embed: INSTALL_OR_CONFIGURE },
  workerEnvMissing: "be/worker/.env.example을 복사해 값을 채운 뒤 다시 시도해 주세요.",
  pendingMigrations: "터미널에서 `pnpm be:migrate`를 실행한 뒤 다시 시도해 주세요.",
  externalWorker:
    "터미널의 worker를 끄고 다시 시도하거나, 그 worker의 STORAGE_ROOT가 앱과 같은지 확인해 주세요.",
  embedMismatch: "외부 embed 서비스를 끄면 앱이 직접 띄웁니다.",
  repoRootMissing: "be/worker와 be/docker-compose.yml이 있는 폴더를 골라 주세요.",
  // degraded 문구다. recoveryHint는 degraded를 원인보다 먼저 보므로 여기에는 닿지 않는다.
  apiDbUnreachable: null,
  workerDbUnreachable: null,
  healthProbeThrew: null,
  notAnswering: null,
  // 다음 기동이 다른 포트를 고른다 — 실패 화면이 이미 재시도를 말한다.
  portInUse: null,
  noFreePort: null,
  noHandle: null,
  // 뒤따르는 stderr 블록이 원인이다. 그 블록이 아는 원인(spawnNotFound 등)이면 그쪽이 먼저 맞는다.
  processExited: null,
  // worker만 원인을 좁힐 수 있다: ready 줄은 DB에 붙은 **뒤에** 찍히므로, 프로세스가 살아서
  // 유예를 넘겼다면 DB 연결에서 멈춰 있는 것이다 (스펙 §8, 완료 기준 P2-C10). be/worker/.env가
  // 아니라 config.json을 가리킨다 — 앱이 DATABASE_URL을 환경변수로 주입하고, pydantic-settings는
  // 환경변수를 .env보다 먼저 본다(config.ts의 withAppOwned 주석).
  readyTimeout: {
    worker:
      "데이터베이스에 연결하지 못해 멈춰 있을 수 있어요. 데이터베이스가 떠 있는지, config.json의 DATABASE_URL이 맞는지 확인한 뒤 다시 시도해 주세요.",
  },
  readinessThrew: null,
  externalCheckFailed: null,
};

/** degraded의 안내. "다시 시작하세요"라고 말하지 않는다 — 재시작은 이 경우 도움이 안 된다. */
export const DEGRADED_HINT = "의존하는 서비스가 돌아오면 자동으로 복구됩니다. 앱을 다시 시작하지 않아도 됩니다.";

/**
 * 원인 문구 하나에 대한 안내. 서비스 상태가 아닌 원인(감독자를 세우기 전의 실패 — docker·저장소
 * 폴더)도 이것을 쓴다. `id`가 없으면 id별 안내는 고르지 않는다.
 */
export function hintForDetail(detail: string, id?: ServiceId): string | undefined {
  const cause = causeIn(detail);
  if (cause === undefined) return undefined;
  const hint = HINTS[cause];
  if (hint === null) return undefined;
  if (typeof hint === "string") return hint;
  return id === undefined ? undefined : hint[id];
}

/**
 * 이 상태에서 사람에게 보여줄 원인. 실패·degraded·외부 인스턴스에 밀려 서지 않은 경우뿐이다.
 *
 * `starting`/`stopped`의 detail은 **지난** 실패의 것이다 — 감독자는 상태를 덧대기만 해서
 * 재기동이 시작돼도 detail이 지워지지 않는다. 그것을 원인으로 읽으면 다시 뜨는 중인 서비스에
 * 방금 고친 실패의 안내를 붙이게 된다.
 */
export function causeOf(status: ServiceStatus): string | undefined {
  if (status.detail === undefined || status.detail === "") return undefined;
  if (status.process === "failed" || status.health === "degraded") return status.detail;
  if (status.process === "running" && !status.owned) return status.detail;
  return undefined;
}

export function recoveryHint(status: ServiceStatus): string | undefined {
  if (status.process === "running" && status.health === "ok") return undefined;
  if (status.health === "degraded") return DEGRADED_HINT;
  const detail = causeOf(status);
  return detail === undefined ? undefined : hintForDetail(detail, status.id);
}
