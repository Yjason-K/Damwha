import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { maskDatabaseUrl } from "./mask-db-url";
import { embeddedDatabaseUrl, pgLayout } from "./services/pg-layout";

/** 자식 API에 넣을 환경변수. 값은 항상 문자열이다. */
export type ApiEnv = Record<string, string>;

export interface LoadedConfig {
  env: ApiEnv;
  /** config.json을 이번 실행에서 만들었으면 true */
  created: boolean;
  /** 화면에 보일 경고. 사람이 적은 값을 앱이 쓰지 않았을 때. */
  warning?: string;
  /** 로그에만 남기는 사실. 사람이 고른 적 없는 옛 기본값을 무시한 것처럼, 화면에 띄우면 할 일 없는 안내가 되는 것. */
  notes: string[];
  /** 저장소 체크아웃. 없으면 main.ts가 추측하거나 사람에게 묻는다 (Phase 2 스펙 §6.4). */
  repoRoot?: string;
  uvBin?: string;
  /** PATH 탐색에 앞세울 디렉터리. 기본 목록을 이긴다 (services/resolve.ts). */
  extraPath: string[];
  /** 감독자를 만들 때 한 번 정한다. 실행 중에는 바꾸지 않고 재적용기가 보고만 한다 (Phase 3 스펙 §6.1). */
  databaseMode: DatabaseMode;
}

/** 내장 모드가 기본이다. 외부 모드는 사람이 DEBUG_EXTERNAL_DATABASE_URL을 적었을 때만 켜지는 디버깅 탈출구다. */
export type DatabaseMode = { kind: "embedded" } | { kind: "external"; url: string };

/** Phase 1·2의 defaultConfig가 첫 실행 config.json에 적던 값. 이 값과 문자 그대로 같으면 사람이 고른 것이 아니다. */
export const LEGACY_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/damwha";

/** 모드가 정하는 키. 재적용(refreshEnv)의 대상이 아니다 — 다시 켜도 파일 값으로 바뀌지 않는 값이다 (스펙 §6.6). */
export const DB_ENV_KEYS = ["DATABASE_URL", "STORAGE_ROOT"] as const;

export function withoutDbKeys(env: ApiEnv): ApiEnv {
  const out: ApiEnv = { ...env };
  for (const key of DB_ENV_KEYS) delete out[key];
  return out;
}

/**
 * 이 **실행**의 worker 식별자. 모듈 로드 시 한 번만 민다. **실행마다 새 값, 실행 안에서는
 * 고정** — 두 성질 다 config.json과 무관해야 한다 (스펙 §6.5).
 *
 * 실행 안에서 고정인 이유(재리뷰 §4-2): 호출마다 밀면 재시도가 loadConfig를 다시 부를 때마다
 * 신분이 바뀌어, 백오프가 되살린 worker가 옛 id로 locked_by가 찍힌 job을 다시 집지 못하고
 * 재적용 진단이 "바뀐 키: WORKER_ID"를 3·8·20초마다 적는다.
 *
 * 실행마다 새 값인 이유(최종 리뷰 I-4): 기본값 worker-1을 외부 worker와 나눠 쓰면 locked_by만
 * 보는 소유권 가드가 둘을 구별하지 못하고, **이전 실행에서 살아남은 `--once` 자식**이 새
 * 실행의 supervisor와 같은 id를 쥐면 같은 구멍이 실행 사이로 넓어진다(R2-6). 그래서 이 값은
 * **config.json에 적지도, 거기서 읽지도 않는다.** 한때 첫 실행이 이것을 파일에 적어 두 번째
 * 실행부터 같은 id를 다시 썼다 — "크래시 뒤 잠긴 job을 되찾으려면 id가 안정적이어야 한다"는
 * 근거였는데, 그런 경로는 없다: claim은 queued만 집고 reaper는 locked_at의 나이만 본다
 * (be/worker/damwha_worker/db/queue.py). 그 빌드가 남긴 파일의 WORKER_ID 키는 아래
 * withAppOwned가 덮어 무효로 만든다 — 앱이 적었던 값이라 경고하지 않는다.
 */
const RUN_WORKER_ID = `desktop-${randomUUID()}`;

/**
 * 앱이 기본값을 갖는 키. 첫 실행의 config.json이 **그대로 이것**이다. DATABASE_URL·STORAGE_ROOT는 여기 없다 —
 * Phase 3부터 모드가 정하는 앱 소유 값이고(withDatabase), 파일에 적으면 사람에게 "고쳐도 되는 값"으로 광고된다.
 * WORKER_ID도 없다 — 위 RUN_WORKER_ID.
 */
export function defaultConfig(_userDataDir: string): ApiEnv {
  return {
    PORT: "3000",
    EMBED_SERVICE_PORT: "8100",
  };
}

/** 앱이 두 서비스에 고정 주입하는 바인드 주소. 설정으로 여는 값이 아니다. */
const LOOPBACK = "127.0.0.1";

/**
 * HOST와 EMBED_SERVICE_HOST는 설정으로 열 수 없다 — 앱이 127.0.0.1을 고정 주입한다 (스펙 §6.6).
 * 여기서 걸러 내지 않으면 config.json 한 줄로 API가, 또는 **인증이 없는** embed 서비스가 LAN에
 * 열린다. embed 쪽은 be/worker/damwha_worker/embed_service.py:42가 이 값을
 * uvicorn.run(host=…)에 그대로 넘긴다.
 */
const APP_OWNED_KEYS = ["HOST", "EMBED_SERVICE_HOST"];

/**
 * 앱이 **자기 손으로** 얹는 값. 파일에서 오는 값을 걸러 내는 것만으로는 부족하다 —
 * be/worker/.env는 우리가 소유하지 않는 파일이고 pydantic-settings는 환경변수를 .env보다
 * 먼저 본다(스펙 §6.4 실측). 아무것도 주입하지 않으면 그쪽의 낡은 EMBED_SERVICE_HOST가
 * 이긴다. 루프백 바인딩은 앱이 **주장하는** 성질이어야 하고, 물려받는 성질이면 안 된다.
 *
 * defaultConfig에는 두지 않는다. 거기 두면 첫 실행의 config.json에 적혀 사용자에게 "고쳐도
 * 되는 값"으로 광고되고, 그것이 정확히 이 결함의 절반이었다 (Task 12 리뷰 Important-1).
 * services/embed.ts의 `?? "127.0.0.1"` 기본값과 겹치지만, 그것은 ctx.env가 이 키를 아예
 * 갖지 않는 경로(테스트)를 위한 것이고 자식 env를 정하는 것은 여기다.
 *
 * WORKER_ID도 같은 이유로 여기서 얹는다. 파일 값보다 **뒤에** 펼치므로, 이전 빌드가 적어 둔
 * config.json의 WORKER_ID는 이 실행의 값을 이기지 못한다 (RUN_WORKER_ID 주석).
 */
function withAppOwned(env: ApiEnv): ApiEnv {
  return { ...env, EMBED_SERVICE_HOST: LOOPBACK, WORKER_ID: RUN_WORKER_ID };
}

/** 파일과 실행 중인 값이 다르지만 **바꾸지 않은** 키. 앱을 다시 켜야 반영된다. */
export interface RestartOnlyKey {
  key: string;
  /** config.json이 지금 말하는 값. */
  file: string;
  /** 살아 있는 감독자가 쓰고 있는 값. */
  live: string;
}

export interface EnvRefresh {
  /** 살아 있는 env에 실제로 얹은 키. */
  changed: string[];
  /** 파일에서 사라져 살아 있는 env에서도 지운 키. */
  removed: string[];
  /** 파일이 바꾸라고 했지만 실행 중에는 바꿀 수 없는 키. */
  needsRestart: RestartOnlyKey[];
}

/**
 * 재시도가 config.json을 다시 읽을 때 쓴다 (완료 기준 P2-C8). 실패 화면은 "값을 고치면 다시
 * 시도합니다"라고 적는데, 감독자를 실행당 하나만 만드는 구조에서는 LaunchContext.env가 생성
 * 시점에 얼어붙어 그 문장이 거짓이 된다 — Phase 1은 재시도마다 loadConfig를 다시 읽었다.
 *
 * **`restartOnly`가 이 함수의 핵심 판정이다.** 파생의 입력이 되는 값을 다시 읽으면서 파생을
 * 다시 돌리지 않는 것은, 아예 다시 읽지 않는 것보다 나쁘다. 실측(재리뷰 §4-1): 사용자가
 * `EMBED_SERVICE_PORT`를 8100→9000으로 고치면 이 함수가 그것을 살아 있는 env에 얹는데,
 * `EMBED_SERVICE_URL`은 파일에 없어 갱신되지 않고 `retry()`는 설계상 `prepare()`를 건너뛰므로
 * embedSpec의 클로저 url도 `:8100`에 얼어 있다. embed는 9000에 bind하고 준비 판정은 8100을
 * 찌른다 → 180초 뒤 failed ×3. 그리고 API에게 넘어간 URL이 `:8100`이라 **의미 검색이 오류 없이
 * 키워드 검색으로 떨어진다.** 앱을 다시 켜기 전에는 풀리지 않고, 그동안 화면은 "값을 고치면
 * 다시 시도합니다"라고 적고 있다.
 *
 * 그래서 그런 키는 **건드리지 않고 보고한다.** 반대 방향(prepare가 포트를 옮긴 뒤 사용자가
 * 파일을 고치는 경우)도 같은 한 규칙이 덮는다 — 예전에는 그쪽이 조용히 무시됐다.
 * "다시 켜야 반영됩니다"는 받아들일 수 있는 답이고, "검색이 조용히 의미 검색이 아니게 됐다"는
 * 받아들일 수 없다.
 *
 * 그 밖의 키는 prepare()가 기여한 값만 지킨다: "파일에서 읽은 값이 아직 그대로인 키만
 * 갱신한다"(current === baseline)가 그 구별의 전부다. baseline도 제자리에서 갱신한다 — 다음
 * 재시도의 기준 역시 "파일이 마지막으로 말한 값"이어야 하고, 그러지 않으면 한 번 바뀐 키는
 * 두 번째 수정을 영영 받지 못한다.
 *
 * 파일에서 **사라진** 키는 살아 있는 env에서도 지운다. "파일을 다시 읽는다"가 파일과
 * 옛 값의 합집합을 뜻하면, 키를 지운 사용자에게는 화면의 그 문장이 여전히 거짓이다
 * (재리뷰 §4-8).
 */
export function refreshEnv(
  current: ApiEnv,
  baseline: ApiEnv,
  fresh: ApiEnv,
  restartOnly: readonly string[],
): EnvRefresh {
  const changed: string[] = [];
  const removed: string[] = [];
  const needsRestart: RestartOnlyKey[] = [];

  for (const [key, value] of Object.entries(fresh)) {
    if (restartOnly.includes(key)) {
      // 두 질문을 **둘 다** 물어야 한다.
      //   "사용자가 파일을 고쳤는가" → value !== baseline[key]
      //   "지금 어긋나 있는가"       → value !== current[key]
      //
      // 둘째만 보면 prepare()가 포트를 옮긴 **정상 상태**에서 거짓 안내가 뜬다: 파일은 8100
      // 그대로인데 살아 있는 값이 54321이라(외부 embed가 8100을 쥐어 스펙 §6.5대로 옮겼다)
      // "다시 켜야 바뀌어요"가 재시도마다 뜬다. 사용자는 파일을 건드린 적이 없고, 다시 켜도
      // 외부 embed가 그대로면 또 옮긴다 — 할 수 있는 일이 없는데 하라고 시키는 안내이고,
      // 그런 안내가 실패 화면에서 진짜 실패 줄과 나란히 선다 (재재리뷰 §4-5).
      // 첫째만 보면 사용자가 파일을 살아 있는 값으로 맞춰 놓은 뒤에도 안내가 남는다.
      //
      // baseline은 여기서 움직이지 않는다. restart-only 키는 이 실행 안에서 current도
      // baseline도 얼어 있고(prepare는 감독자 생성 때 한 번만 돈다), baseline을 파일 값으로
      // 끌어올리면 어긋남이 그대로인데 다음 재시도가 침묵한다.
      const live = current[key];
      if (value !== baseline[key] && value !== live) {
        needsRestart.push({ key, file: value, live: live ?? "(없음)" });
      }
      continue;
    }
    // prepare()가 옮긴 값은 파일이 이긴다고 볼 수 없다.
    if (current[key] !== baseline[key]) continue;
    if (current[key] === value) continue;
    current[key] = value;
    baseline[key] = value;
    changed.push(key);
  }

  // Object.keys는 스냅숏이라 순회 중 삭제해도 안전하다.
  for (const key of Object.keys(baseline)) {
    if (key in fresh) continue;
    if (restartOnly.includes(key)) continue;
    // 파일의 침묵이 prepare()가 옮긴 값을 지우지는 못한다. 위 갱신 규칙과 같은 기준이다.
    if (current[key] !== baseline[key]) continue;
    delete current[key];
    delete baseline[key];
    removed.push(key);
  }

  return { changed, removed, needsRestart };
}

/** 자식 env가 아니라 앱이 쓰는 설정. 그대로 주입하면 API·worker의 zod/pydantic이 모르는
 *  키를 받거나(무해) 배열이 문자열로 새어 들어간다(유해). */
const APP_SETTING_KEYS = ["REPO_ROOT", "EXTRA_PATH", "UV_BIN", "DEBUG_EXTERNAL_DATABASE_URL"];

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 내장 모드의 DB 쌍 (스펙 §6.1). 파일 값보다 **뒤에** 얹는다 — 앱이 주장하는 값이지 물려받는 값이 아니다. */
function withEmbeddedDatabase(env: ApiEnv, userDataDir: string): ApiEnv {
  const layout = pgLayout(userDataDir);
  return { ...env, DATABASE_URL: embeddedDatabaseUrl(layout), STORAGE_ROOT: layout.storage };
}

export function loadConfig(userDataDir: string): LoadedConfig {
  const file = path.join(userDataDir, "config.json");
  const defaults = defaultConfig(userDataDir);
  // 파일을 못 쓰거나 읽지 못해도 내장 모드다. 외부 모드는 사람이 명시적으로 적어야만 켜진다.
  const embedded = (): Pick<LoadedConfig, "env" | "notes" | "extraPath" | "databaseMode"> => ({
    env: withAppOwned(withEmbeddedDatabase(defaults, userDataDir)),
    notes: [],
    extraPath: [],
    databaseMode: { kind: "embedded" },
  });

  if (!fs.existsSync(file)) {
    // 이 두 줄은 원래 try 밖이라 userData가 읽기 전용이거나 디스크가 찼을 때 그대로
    // 던졌다. 호출부인 startOnce()는 showStatus({state:"starting"}) 직후라 그 예외가
    // 실패 화면에 닿지 못하고 앱이 "준비 중"에 영원히 머문다. 파일을 남기지 못하는 것은
    // 기본값으로 계속 갈 수 없는 이유가 아니다 — 경고로 바꾼다.
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(defaults, null, 2)}\n`);
      return { ...embedded(), created: true };
    } catch (e) {
      return { ...embedded(), created: false, warning: `config.json을 만들 수 없어 기본값으로 실행합니다: ${reason(e)}` };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    // 덮어쓰지 않는다 — 사용자가 직접 고칠 수 있어야 한다 (스펙 §8).
    return { ...embedded(), created: false, warning: `config.json을 읽을 수 없어 기본값으로 실행합니다: ${reason(e)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...embedded(), created: false, warning: "config.json이 객체가 아니라 기본값으로 실행합니다." };
  }

  const env: ApiEnv = { ...defaults };
  const settings: { repoRoot?: string; uvBin?: string; externalUrl?: string; extraPath: string[] } = { extraPath: [] };
  const fileDb: Partial<Record<(typeof DB_ENV_KEYS)[number], string>> = {};
  // 값을 버렸으면 왜 버렸는지 적는다. 조용히 무시하면 사용자는 자기가 적은 경로가 왜 안 먹는지
  // 알 길이 없고, 다음에 보는 화면은 엉뚱한 원인을 말한다.
  const warnings: string[] = [];
  const notes: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (APP_OWNED_KEYS.includes(key)) {
      warnings.push(
        `config.json의 ${key}는 앱이 ${LOOPBACK}으로 고정합니다. 파일 값은 무시했습니다: ${JSON.stringify(value)}`,
      );
      continue;
    }
    if (key === "DOCKER_BIN") {
      notes.push("config.json의 DOCKER_BIN은 쓰지 않아요 — Phase 3부터 앱은 Docker를 부르지 않습니다.");
      continue;
    }
    if ((DB_ENV_KEYS as readonly string[]).includes(key)) {
      // 모드가 정한다. 여기서는 옛 키 판정을 위해 파일 값만 기억한다.
      if (typeof value === "string") fileDb[key as (typeof DB_ENV_KEYS)[number]] = value;
      continue;
    }
    if (APP_SETTING_KEYS.includes(key)) {
      if (key === "EXTRA_PATH") {
        // 문자열 **목록만** 받는다. 반쯤 맞는 목록을 PATH 앞에 붙이면 uv·docker 탐색이 조용히
        // 엉뚱한 곳을 본다. 원소 타입까지 보는 이유는 섞인 배열이 Array.isArray를 통과한다는
        // 것이다 — ["/opt/x", 3]은 searchDirs를 지나 findExecutable의 path.join(3, "uv")에서
        // 던지고(그 try는 isExecutable 호출만 감싼다, services/resolve.ts:44-50), 사용자는
        // 원인이 적히지 않은 `앱을 시작하지 못했어요: The "path" argument must be of type
        // string`을 본다.
        if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
          settings.extraPath = value as string[];
        } else {
          warnings.push(
            `config.json의 EXTRA_PATH는 문자열 목록이어야 해요. 이 값은 무시했습니다: ${JSON.stringify(value)}`,
          );
        }
      } else if (key === "DEBUG_EXTERNAL_DATABASE_URL") {
        if (typeof value === "string" && value.trim() !== "") settings.externalUrl = value;
        else warnings.push(`config.json의 DEBUG_EXTERNAL_DATABASE_URL은 비어 있지 않은 문자열이어야 해요. 내장 DB로 실행합니다: ${JSON.stringify(value)}`);
      } else if (typeof value === "string") {
        if (key === "REPO_ROOT") settings.repoRoot = value;
        else settings.uvBin = value;
      }
      continue;
    }
    if (typeof value === "string") env[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") env[key] = String(value);
    // 그 밖의 타입은 무시한다. 값의 유효성은 API의 zod가 판정한다.
  }

  let databaseMode: DatabaseMode;
  let withDb: ApiEnv;
  if (settings.externalUrl !== undefined) {
    databaseMode = { kind: "external", url: settings.externalUrl };
    // 상대 경로가 남으면 packaged 앱의 cwd가 .app 안이라 번들 내부를 가리킨다 (Phase 1 스펙 §6.3).
    withDb = { ...env, DATABASE_URL: settings.externalUrl, STORAGE_ROOT: path.resolve(userDataDir, fileDb.STORAGE_ROOT ?? "storage") };
    if (fileDb.DATABASE_URL !== undefined) notes.push("외부 DB 모드는 DEBUG_EXTERNAL_DATABASE_URL을 써요 — config.json의 DATABASE_URL은 무시했습니다.");
  } else {
    databaseMode = { kind: "embedded" };
    withDb = withEmbeddedDatabase(env, userDataDir);
    for (const key of DB_ENV_KEYS) {
      const value = fileDb[key];
      if (value === undefined) continue;
      const legacy = key === "DATABASE_URL" ? value === LEGACY_DATABASE_URL : path.resolve(userDataDir, value) === path.join(userDataDir, "storage");
      if (legacy) notes.push(`config.json의 ${key}는 Phase 1·2의 기본값이에요 — 내장 DB 모드에서는 쓰지 않습니다.`);
      else {
        // DATABASE_URL은 사람이 손으로 적은 진짜 비밀번호를 담고 있을 수 있다 — 화면에도 뜨고
        // supervisor.log에도 남는 문구라 원문을 그대로 옮기지 않는다. STORAGE_ROOT는 경로라
        // 가릴 것이 없어 그대로 둔다.
        const shown =
          key === "DATABASE_URL"
            ? (() => {
                const masked = maskDatabaseUrl(value);
                return masked === null ? "파일에 값이 있습니다(가려서 표시하지 않아요)" : `파일 값: ${JSON.stringify(masked)}`;
              })()
            : `파일 값: ${JSON.stringify(value)}`;
        warnings.push(`내장 DB 모드에서는 config.json의 ${key}를 쓰지 않아요 (${shown}). 외부 DB로 디버깅하려면 DEBUG_EXTERNAL_DATABASE_URL을 적어 주세요.`);
      }
    }
  }

  return {
    env: withAppOwned(withDb),
    created: false,
    notes,
    databaseMode,
    extraPath: settings.extraPath,
    ...(settings.repoRoot === undefined ? {} : { repoRoot: settings.repoRoot }),
    ...(settings.uvBin === undefined ? {} : { uvBin: settings.uvBin }),
    ...(warnings.length > 0 ? { warning: warnings.join(" / ") } : {}),
  };
}
