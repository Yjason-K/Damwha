import * as fs from "fs";
import * as path from "path";

/** 자식 API에 넣을 환경변수. 값은 항상 문자열이다. */
export type ApiEnv = Record<string, string>;

export interface LoadedConfig {
  env: ApiEnv;
  /** config.json을 이번 실행에서 만들었으면 true */
  created: boolean;
  /** 파일이 있었지만 쓸 수 없어 기본값으로 진행한 이유 */
  warning?: string;
  /** 저장소 체크아웃. 없으면 main.ts가 추측하거나 사람에게 묻는다 (스펙 §6.4). */
  repoRoot?: string;
  uvBin?: string;
  dockerBin?: string;
  /** PATH 탐색에 앞세울 디렉터리. 기본 목록을 이긴다 (services/resolve.ts). */
  extraPath: string[];
}

/** 앱이 기본값을 갖는 키. 그 밖의 키는 be/src/config/env.ts의 zod 기본값으로 떨어진다. */
export function defaultConfig(userDataDir: string): ApiEnv {
  return {
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/damwha",
    STORAGE_ROOT: path.join(userDataDir, "storage"),
    PORT: "3000",
    EMBED_SERVICE_PORT: "8100",
    // 기본값 worker-1을 외부 worker와 나눠 쓰면 locked_by만 보는 소유권 가드가 둘을
    // 구별하지 못한다. 실행마다 새로 만든다 (스펙 §6.5).
    WORKER_ID: `desktop-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
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
 */
function withAppOwned(env: ApiEnv): ApiEnv {
  return { ...env, EMBED_SERVICE_HOST: LOOPBACK };
}

/**
 * 재시도가 config.json을 다시 읽을 때 쓴다 (완료 기준 P2-C8). 실패 화면은 "값을 고치면 다시
 * 시도합니다"라고 적는데, 감독자를 실행당 하나만 만드는 구조에서는 LaunchContext.env가 생성
 * 시점에 얼어붙어 그 문장이 거짓이 된다 — Phase 1은 재시도마다 loadConfig를 다시 읽었다.
 *
 * prepare()가 기여한 값은 덮지 않는다. embed의 prepare는 포트가 겹칠 때 EMBED_SERVICE_PORT를
 * 살아 있는 자식에 맞춰 옮기고 EMBED_SERVICE_URL을 그 한 값에서 파생시키므로, 파일 값으로
 * 되돌리면 둘이 어긋나고 어긋난 결과는 오류가 아니라 조용한 degrade다(services/embed.ts의
 * 주석). "파일에서 읽은 값이 아직 그대로인 키만 갱신한다"가 그 구별의 전부다.
 *
 * baseline도 제자리에서 갱신한다 — 다음 재시도의 기준 역시 "파일이 마지막으로 말한 값"이어야
 * 하고, 그러지 않으면 한 번 바뀐 키는 두 번째 수정을 영영 받지 못한다.
 *
 * 돌려주는 것은 실제로 바뀐 키 목록이다. 로그에 적을 값이 없으면 재시도가 무엇을 새로 읽었는지
 * 사람이 확인할 수 없다.
 */
export function refreshEnv(current: ApiEnv, baseline: ApiEnv, fresh: ApiEnv): string[] {
  const changed: string[] = [];
  for (const [key, value] of Object.entries(fresh)) {
    // prepare()가 옮긴 값은 파일이 이긴다고 볼 수 없다.
    if (current[key] !== baseline[key]) continue;
    if (current[key] === value) continue;
    current[key] = value;
    baseline[key] = value;
    changed.push(key);
  }
  return changed;
}

/** 자식 env가 아니라 앱이 쓰는 설정. 그대로 주입하면 API·worker의 zod/pydantic이 모르는
 *  키를 받거나(무해) 배열이 문자열로 새어 들어간다(유해). */
const APP_SETTING_KEYS = ["REPO_ROOT", "EXTRA_PATH", "UV_BIN", "DOCKER_BIN"];

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function loadConfig(userDataDir: string): LoadedConfig {
  const file = path.join(userDataDir, "config.json");
  const defaults = defaultConfig(userDataDir);

  if (!fs.existsSync(file)) {
    // 이 두 줄은 원래 try 밖이라 userData가 읽기 전용이거나 디스크가 찼을 때 그대로
    // 던졌다. 호출부인 startOnce()는 showStatus({state:"starting"}) 직후라 그 예외가
    // 실패 화면에 닿지 못하고 앱이 "준비 중"에 영원히 머문다. 파일을 남기지 못하는 것은
    // 기본값으로 계속 갈 수 없는 이유가 아니다 — 경고로 바꾼다.
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(defaults, null, 2)}\n`);
      return { env: withAppOwned(defaults), created: true, extraPath: [] };
    } catch (e) {
      return {
        env: withAppOwned(defaults),
        created: false,
        extraPath: [],
        warning: `config.json을 만들 수 없어 기본값으로 실행합니다: ${reason(e)}`,
      };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    // 덮어쓰지 않는다 — 사용자가 직접 고칠 수 있어야 한다 (스펙 §8).
    return {
      env: withAppOwned(defaults),
      created: false,
      extraPath: [],
      warning: `config.json을 읽을 수 없어 기본값으로 실행합니다: ${reason(e)}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      env: withAppOwned(defaults),
      created: false,
      extraPath: [],
      warning: "config.json이 객체가 아니라 기본값으로 실행합니다.",
    };
  }

  const env: ApiEnv = { ...defaults };
  const settings: { repoRoot?: string; uvBin?: string; dockerBin?: string; extraPath: string[] } = {
    extraPath: [],
  };
  // 값을 버렸으면 왜 버렸는지 적는다. 조용히 무시하면 사용자는 자기가 적은 경로가 왜 안 먹는지
  // 알 길이 없고, 다음에 보는 화면은 엉뚱한 원인을 말한다.
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (APP_OWNED_KEYS.includes(key)) {
      // 버리는 것으로 끝내지 않는다. 사용자가 이 키를 적었다는 것은 자기 값이 먹기를 기대한다는
      // 뜻이고, 조용히 무시하면 "0.0.0.0으로 적었는데 왜 LAN에서 안 보이지"를 끝없이 파게 된다.
      warnings.push(
        `config.json의 ${key}는 앱이 ${LOOPBACK}으로 고정합니다. 파일 값은 무시했습니다: ${JSON.stringify(value)}`,
      );
      continue;
    }
    if (APP_SETTING_KEYS.includes(key)) {
      // 앱 설정은 env에 넣지 않고 여기서 받는다. continue가 빠지면 EXTRA_PATH 배열이
      // String(value)로 자식 env에 들어가고, 받는 쪽(pydantic)이 그것을 어떻게 읽을지
      // 우리가 정할 수 없다.
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
      } else if (typeof value === "string") {
        if (key === "REPO_ROOT") settings.repoRoot = value;
        else if (key === "UV_BIN") settings.uvBin = value;
        else settings.dockerBin = value;
      }
      continue;
    }
    if (typeof value === "string") env[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") env[key] = String(value);
    // 그 밖의 타입은 무시한다. 값의 유효성은 API의 zod가 판정한다.
  }

  // 상대 경로가 남으면 packaged 앱의 cwd가 .app 안이라 번들 내부를 가리킨다 (스펙 §6.3).
  env.STORAGE_ROOT = path.resolve(userDataDir, env.STORAGE_ROOT);
  return {
    env: withAppOwned(env),
    created: false,
    ...settings,
    ...(warnings.length > 0 ? { warning: warnings.join(" / ") } : {}),
  };
}
