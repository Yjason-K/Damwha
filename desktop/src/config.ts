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
}

/** 앱이 기본값을 갖는 세 키. 그 밖의 키는 be/src/config/env.ts의 zod 기본값으로 떨어진다. */
export function defaultConfig(userDataDir: string): ApiEnv {
  return {
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/damwha",
    STORAGE_ROOT: path.join(userDataDir, "storage"),
    PORT: "3000",
  };
}

/**
 * HOST는 설정으로 열 수 없다 — 앱이 127.0.0.1을 고정 주입한다 (스펙 §6.6).
 * 여기서 걸러 내지 않으면 config.json 한 줄로 API가 LAN에 열린다.
 */
const APP_OWNED_KEYS = ["HOST"];

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
      return { env: defaults, created: true };
    } catch (e) {
      return {
        env: defaults,
        created: false,
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
      warning: `config.json을 읽을 수 없어 기본값으로 실행합니다: ${reason(e)}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      env: defaults,
      created: false,
      warning: "config.json이 객체가 아니라 기본값으로 실행합니다.",
    };
  }

  const env: ApiEnv = { ...defaults };
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (APP_OWNED_KEYS.includes(key)) continue;
    if (typeof value === "string") env[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") env[key] = String(value);
    // 그 밖의 타입은 무시한다. 값의 유효성은 API의 zod가 판정한다.
  }

  // 상대 경로가 남으면 packaged 앱의 cwd가 .app 안이라 번들 내부를 가리킨다 (스펙 §6.3).
  env.STORAGE_ROOT = path.resolve(userDataDir, env.STORAGE_ROOT);
  return { env, created: false };
}
