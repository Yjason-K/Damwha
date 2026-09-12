import type { ApiHandle } from "../api-process";
import type { ApiEnv } from "../config";

export type ServiceId = "postgres" | "api" | "embed" | "worker";

/** 프로세스가 있나. */
export type ProcessState = "stopped" | "starting" | "running" | "failed";
/** 그 프로세스가 실제로 일을 하나. 둘을 나누는 이유는 스펙 §6.6에 있다 — API는 부팅 뒤 DB가
 *  끊겨도 죽지 않고 503을 주므로, 프로세스 축만 보는 감독자는 정상으로 오판한다. */
export type HealthState = "unknown" | "ok" | "degraded";

/** Phase 1의 ApiHandle이 이미 필요한 것을 다 갖고 있다. 이름만 넓힌다. */
export type ServiceHandle = ApiHandle;

export interface ServiceStatus {
  id: ServiceId;
  process: ProcessState;
  health: HealthState;
  /** 사람에게 보여줄 원인. 여러 줄일 수 있다. */
  detail?: string;
  /** 앱이 이 서비스를 소유하는가. 외부를 채택했거나 안 띄웠으면 false. */
  owned: boolean;
  restarts: number;
}

export interface LaunchContext {
  repoRoot: string;
  userData: string;
  packaged: boolean;
  /** config.json에서 온 값 + 어댑터들의 prepare()가 기여한 값. */
  env: ApiEnv;
  bins: { uv: string | null; docker: string | null };
  searchDirs: readonly string[];
  logFile(id: ServiceId): string;
}

export interface LaunchResult {
  /** 앱이 쥔 프로세스 핸들. 컨테이너처럼 프로세스가 아닌 것은 null. */
  handle: ServiceHandle | null;
  /** 앱이 이번에 실제로 띄웠나. 외부를 채택했으면 false → 종료 시 건드리지 않는다. */
  owned: boolean;
  /** api만 채운다 — 렌더러가 붙을 주소. */
  origin?: string;
}

export type ExternalState =
  | { kind: "absent" }
  /** 외부에 있고 우리가 쓴다. 죽이지 않는다. */
  | { kind: "adopt"; detail: string }
  /** 외부에 있어 우리 것을 띄우지 않는다. 앱은 계속 쓸 수 있다. */
  | { kind: "stand-down"; detail: string };

export type ReadinessResult =
  | { kind: "ready" }
  | { kind: "not-ready" }
  | { kind: "degraded"; detail: string }
  | { kind: "failed"; detail: string };

export interface StopPlan {
  graceMs: number;
  /** 유예가 지났을 때 부른다. true면 강제 단계로 올라간다. */
  onGraceExpired?: (id: ServiceId) => Promise<boolean>;
}

export interface StopOutcome {
  stopped: boolean;
  /** 정리하지 못하고 남은 pid. 비어 있지 않으면 화면과 로그에 적는다. */
  leaked: number[];
}

export interface ServiceSpec {
  id: ServiceId;
  /** 시작 순서와 종료 역순을 이 한 값이 결정한다. */
  dependsOn: readonly ServiceId[];
  /** 창을 열기 전에 준비를 기다리는가. */
  gate: boolean;
  /** 기동 전에 env에 기여한다. 포트 결정처럼 다른 서비스가 의존하는 값. */
  prepare?(ctx: LaunchContext): Promise<Partial<ApiEnv>>;
  detectExternal(ctx: LaunchContext): Promise<ExternalState>;
  /** ← Phase 3·4가 갈아끼우는 유일한 지점. */
  launch(ctx: LaunchContext): Promise<LaunchResult>;
  readiness(result: LaunchResult, ctx: LaunchContext): Promise<ReadinessResult>;
  /**
   * 이 서비스만의 준비 유예. 없으면 감독자 기본값. embed는 bge-m3를 import 시점에 올려
   * 2026-09-12 실측으로 31초가 걸렸고(따뜻한 캐시), 모델 캐시가 비면 훨씬 길다.
   */
  readyTimeoutMs?: number;
  stop(result: LaunchResult, plan: StopPlan): Promise<StopOutcome>;
  restart: { maxAttempts: number; backoffMs: readonly number[] } | "never";
}
