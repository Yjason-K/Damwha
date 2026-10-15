/**
 * 로컬 API 접근 제어의 허용 목록 (spec 2026-10-08-local-api-access-control §3.4).
 * env 원문은 loadEnv()가 이 파서로 검증하고, main.ts가 buildAccessPolicy로 집합을 만든다.
 * 형식이 틀린 항목을 조용히 버리면 "설정했는데 403"이 되므로 throw한다 — 기동 실패가 낫다.
 */
export interface AccessPolicy {
  /** 같은 origin 말고 /api를 부를 수 있는 Origin. 정확히 일치. */
  readonly allowedOrigins: ReadonlySet<string>;
  /** loopback 셋 말고 허용할 Host 이름(소문자, 포트 없음). */
  readonly allowedHosts: ReadonlySet<string>;
}

/** 항상 허용하는 Host 이름. 포트는 보지 않는다 — desktop은 3000이 막히면 무작위 포트로 물러난다. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function splitList(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

export function parseAllowedOrigins(raw: string): string[] {
  return splitList(raw).map((item) => {
    let origin: string;
    try {
      origin = new URL(item).origin;
    } catch {
      throw new Error(`ALLOWED_ORIGINS: ${JSON.stringify(item)} is not a URL (expected e.g. http://localhost:5173)`);
    }
    if (origin === 'null' || origin !== item) {
      throw new Error(`ALLOWED_ORIGINS: ${JSON.stringify(item)} must be a bare origin like ${JSON.stringify(origin)}`);
    }
    return item;
  });
}

export function parseAllowedHosts(raw: string): string[] {
  return splitList(raw).map((item) => {
    const host = item.toLowerCase();
    if (!HOSTNAME.test(host)) {
      throw new Error(`ALLOWED_HOSTS: ${JSON.stringify(item)} must be a host name without scheme or port`);
    }
    return host;
  });
}

export function buildAccessPolicy(origins: string, hosts: string): AccessPolicy {
  return {
    allowedOrigins: new Set(parseAllowedOrigins(origins)),
    allowedHosts: new Set(parseAllowedHosts(hosts)),
  };
}
