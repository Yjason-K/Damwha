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
    EMBED_SERVICE_HOST: "127.0.0.1",
    EMBED_SERVICE_PORT: "8100",
    // 기본값 worker-1을 외부 worker와 나눠 쓰면 locked_by만 보는 소유권 가드가 둘을
    // 구별하지 못한다. 실행마다 새로 만든다 (스펙 §6.5).
    WORKER_ID: `desktop-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
  };
}

/**
 * HOST는 설정으로 열 수 없다 — 앱이 127.0.0.1을 고정 주입한다 (스펙 §6.6).
 * 여기서 걸러 내지 않으면 config.json 한 줄로 API가 LAN에 열린다.
 */
const APP_OWNED_KEYS = ["HOST"];

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
      return { env: defaults, created: true, extraPath: [] };
    } catch (e) {
      return {
        env: defaults,
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
      env: defaults,
      created: false,
      extraPath: [],
      warning: `config.json을 읽을 수 없어 기본값으로 실행합니다: ${reason(e)}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      env: defaults,
      created: false,
      extraPath: [],
      warning: "config.json이 객체가 아니라 기본값으로 실행합니다.",
    };
  }

  const env: ApiEnv = { ...defaults };
  const settings: { repoRoot?: string; uvBin?: string; dockerBin?: string; extraPath: string[] } = {
    extraPath: [],
  };
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (APP_OWNED_KEYS.includes(key)) continue;
    if (APP_SETTING_KEYS.includes(key)) {
      // 앱 설정은 env에 넣지 않고 여기서 받는다. continue가 빠지면 EXTRA_PATH 배열이
      // String(value)로 자식 env에 들어가고, 받는 쪽(pydantic)이 그것을 어떻게 읽을지
      // 우리가 정할 수 없다.
      if (key === "EXTRA_PATH") {
        // 문자열 배열만 받는다. 그 밖의 타입은 무시한다 — 반쯤 맞는 목록을 PATH 앞에
        // 붙이면 uv·docker 탐색이 조용히 엉뚱한 곳을 본다.
        if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
          settings.extraPath = value as string[];
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
  return { env, created: false, ...settings };
}
