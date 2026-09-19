import type { ProcessHandle } from "../process/handle";
import type { ApiEnv, DatabaseMode } from "../config/config";

export type ServiceId = "postgres" | "api" | "embed" | "worker";

/** 프로세스가 있나. */
export type ProcessState = "stopped" | "starting" | "running" | "failed";
/** 그 프로세스가 실제로 일을 하나. 둘을 나누는 이유는 스펙 §6.6에 있다 — API는 부팅 뒤 DB가
 *  끊겨도 죽지 않고 503을 주므로, 프로세스 축만 보는 감독자는 정상으로 오판한다. */
export type HealthState = "unknown" | "ok" | "degraded";

/**
 * 실패를 사람 손 없이 다시 시도해도 되는가 (Phase 3 스펙 §6.7). 없으면 auto로 읽는다 — Phase 2의 어댑터는 이 값을
 * 붙이지 않고, 그 복구 경로(Docker를 켜면 자동 재시도가 진입시키던 것 같은)를 이 추가가 조용히 끄면 안 된다.
 * manual은 마이그레이션 실패·페어링 거부처럼 같은 시도를 반복해도 결과가 같고, 반복이 해로운(백업이 쌓이는) 원인이다.
 */
export type Recovery = "auto" | "manual";

/** 서비스의 핸들은 공통 프로세스 핸들 그대로다 (process/handle.ts). */
export type ServiceHandle = ProcessHandle;

export interface ServiceStatus {
  id: ServiceId;
  process: ProcessState;
  health: HealthState;
  /** 사람에게 보여줄 원인. 여러 줄일 수 있다. */
  detail?: string;
  /** 앱이 이 서비스를 소유하는가. 외부를 채택했거나 안 띄웠으면 false. */
  owned: boolean;
  restarts: number;
  /** failed일 때만 뜻이 있다. 감독자가 실패의 부류를 여기로 옮기고, 다시 뜨거나 ready가 되면 지운다. */
  recovery?: Recovery;
  /**
   * 앱이 이 서비스에 **종료 신호를 보냈는데 아직 안 끝났다** (스펙 §6.10 2층). 프로세스가 실제로
   * 끝나면 감독자가 지운다.
   *
   * 이 표시가 있는 동안 "서비스 다시 시작"은 거부된다 — 두 번째 신호가 파괴적이기 때문이다.
   * worker의 supervisor는 **자기 수명 전체에 걸쳐** 신호를 누적해 센다
   * (`be/worker/damwha_worker/__main__.py`의 `child_holder["count"]`): 첫 신호는 `proc.terminate()`로
   * `--once` 자식이 안전한 지점에서 job을 큐로 돌려놓게 하지만, **두 번째부터는** `proc.kill()` +
   * `os._exit(1)`이라 처리 중이던 job이 graceful requeue 없이 버려진다 (P2-C5).
   */
  cleaningUp?: true;
}

export interface LaunchContext {
  /**
   * 저장소 체크아웃. **dev 전용이다** — packaged는 번들 python·API로 돌아 저장소를 모르고, 항상 null이다
   * (Phase 4 스펙 §6.3). 저장소가 필요한 소비자(dev API·dev 마이그레이션 러너·dev PYTHONPATH)는
   * `path.join`에 닿기 전에 null을 `CAUSES.repoRootMissing`으로 바꾼다.
   */
  repoRoot: string | null;
  userData: string;
  packaged: boolean;
  /**
   * 감독자를 만들 때 정한 DB 모드의 종류 (config.ts의 DatabaseMode). 실행 중에는 바뀌지 않는다.
   * 자식 env의 DAMWHA_SHARED_STATE가 이것으로 갈린다 — worker는 자기가 어느 DB에 붙었는지 알 수
   * 없고, URL 모양으로 모드를 추정하지 않는다 (스펙 §6.9). 외부 모드의 URL은 env의 DATABASE_URL에 있다.
   */
  databaseMode: DatabaseMode["kind"];
  /**
   * config.json에서 온 값 + 앱이 이 실행에 정한 값(main.ts의 launchEnv — LENS_LLM_BASE_URL, 기동 게이트의
   * HF_TOKEN) + 어댑터들의 prepare()가 기여한 값. **통째로 로그·화면에 싣지 않는다** — 토큰이 들어 있다.
   */
  env: ApiEnv;
  /**
   * 이 실행이 부르는 실행 파일. 셋 다 번들 트리 안의 절대 경로다 (process/runtime-paths.ts — python은
   * `bin/python3.12` 실체). worker·embed는 python으로 뜨고(process/python-launcher.ts), 자식 PATH는
   * python·ffmpeg의 `bin`뿐이다.
   */
  bins: { python: string; ffmpeg: string; ffprobe: string };
  /** 이 실행의 식별자(`desktop-<uuid>`). 자식 argv의 `--run-id=`에 실려, 앱이 ps로 자기 자식을 알아본다 (스펙 §6.5). */
  runId: string;
  /**
   * **앱 자신의** 도구 탐색용. 번들 python 자식의 PATH에는 가지 않는다 (스펙 §6.2) — launchPython은
   * 이 값을 읽지 않는다.
   */
  searchDirs: readonly string[];
  logFile(id: ServiceId): string;
  /**
   * 기동 중단 신호. 감독자가 붙이고 stopAll 첫머리에서 abort한다 (Phase 3 스펙 §6.4). 감독자의 준비 유예는 launch()가
   * 반환한 뒤에야 시작하고 stopAll은 진행 중인 기동을 끝까지 기다리므로, launch() 안의 도구(initdb·pg_dump·마이그레이션
   * 러너)가 멈추면 이 신호 없이는 ⌘Q도 멈춘다.
   */
  signal: AbortSignal;
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
  | { kind: "failed"; detail: string; recovery?: Recovery };

export interface StopPlan {
  graceMs: number;
  /** 유예가 지났을 때 부른다. true면 강제 단계로 올라간다. */
  onGraceExpired?: (id: ServiceId) => Promise<boolean>;
}

export interface StopOutcome {
  stopped: boolean;
  /** 정리하지 못하고 남은 pid. 비어 있지 않으면 화면과 로그에 적는다. */
  leaked: number[];
  /**
   * **왜** 깨끗하지 않은가. `stopped:false`일 때만 채운다.
   *
   * 이 필드가 없으면 종료 대화상자가 구분해 말할 수 없는 상태가 셋이다 — (a) 고아가
   * 살아 있다, (b) 자손 스냅샷을 못 찍어 남은 것이 있는지 **증명하지 못했다**, (c) 사람이
   * 강제 종료를 고르지 않아 그 프로세스가 스스로 마무리하는 중이다. 스펙 §6.9는 (b)를
   * `{stopped:false, leaked:[]}`라는 정상 상태로 두면서 "종료 대화상자와 상태 창은 이
   * 상태를 '남은 것 없음'과 구별해 표시해야 한다"고 못 박는데, `{stopped, leaked}`만으로는
   * (b)가 "아무것도 안 남았다"와 글자 그대로 같은 값이다. (c)는 사용자가 방금 고른 것이라
   * 실패로 적으면 거짓말이 된다.
   */
  detail?: string;
  /**
   * 앱 종료의 B층(app/reap-on-quit.ts)이 서비스별 정지가 놓친 프로세스를 내렸고, 그 뒤 **남은 것이 없음을
   * 확인했다.** `stopped:false`는 서비스별 정지가 깨끗하지 않았다는 사실 그대로이고, 종료 대화상자는 이 표시를
   * 보고 "확인하지 못했다" 대신 "정리했다"고 적는다(quit-flow.ts의 leftoverNotice). 서비스 어댑터는 채우지 않는다.
   */
  cleanedUp?: true;
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
  /**
   * ready 도달 뒤 이 주기로 readiness()를 다시 부른다. 없으면 계속 감시하지 않는다.
   * 나누어 둔 두 축은 관측이 있어야 뜻이 생긴다 (스펙 §6.6) — API는 부팅 뒤 DB가 끊겨도
   * 죽지 않으므로, 다시 묻지 않으면 감독자는 영원히 running/ok로 남고 모든 요청은 실패한다.
   * 재프로브는 상태만 바꾼다. 재시작은 걸지 않는다 — 의존이 돌아오지 않는 한 같은 실패를
   * 반복하며 백오프만 태우고, 스펙 §6.8이 금지한 의존 캐스케이드가 된다.
   */
  healthIntervalMs?: number;
  stop(result: LaunchResult, plan: StopPlan): Promise<StopOutcome>;
  restart: { maxAttempts: number; backoffMs: readonly number[] } | "never";
}
