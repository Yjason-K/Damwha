import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** desktop이 API 준비 후 <userData>/api.json에 쓰는 내용 (spec §2.5). */
export interface ApiFile {
  port: number;
  app_pid: number;
  instance: string;
  version: string;
}

export type ConnectionResult =
  | { kind: 'ok'; baseUrl: string }
  | { kind: 'not_running' }
  | { kind: 'starting' };

export interface ConnectionDeps {
  env: NodeJS.ProcessEnv;
  userDataDir: string;
  readFile(p: string): Promise<string | null>;
  isDamwhaPid(pid: number): Promise<boolean>;
  anyDamwhaRunning(): Promise<boolean>;
  fetchHealth(baseUrl: string): Promise<{ instance: string | null } | null>;
}

export function defaultUserDataDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'Damwha');
}

function parseApiFile(raw: string | null): ApiFile | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<ApiFile> | null;
    if (
      v &&
      Number.isInteger(v.port) &&
      Number.isInteger(v.app_pid) &&
      typeof v.instance === 'string'
    ) {
      return v as ApiFile;
    }
  } catch {
    // 반쯤 쓴 파일 등은 없는 것으로 본다.
  }
  return null;
}

/**
 * 연결 상태를 판정한다 (spec §2.5). DAMWHA_API_URL(dev)이 있으면 포트 파일을 보지 않고
 * health만 확인한다. 아니면 api.json + app_pid 생존 + health의 nonce 일치가 모두 맞아야 ok다.
 */
export async function resolveConnection(deps: ConnectionDeps): Promise<ConnectionResult> {
  const override = deps.env.DAMWHA_API_URL;
  if (override) {
    return (await deps.fetchHealth(override)) ? { kind: 'ok', baseUrl: override } : { kind: 'starting' };
  }

  const file = parseApiFile(await deps.readFile(join(deps.userDataDir, 'api.json')));
  if (!file) {
    // 파일은 없어도 앱이 막 떠서 아직 쓰기 전일 수 있다.
    return (await deps.anyDamwhaRunning()) ? { kind: 'starting' } : { kind: 'not_running' };
  }
  if (!(await deps.isDamwhaPid(file.app_pid))) return { kind: 'not_running' };

  const baseUrl = `http://127.0.0.1:${file.port}/api`;
  const health = await deps.fetchHealth(baseUrl);
  // 연결 거부·health 실패·nonce 불일치(다른 프로세스나 이전 인스턴스)는 모두 준비 중이다.
  if (!health || health.instance !== file.instance) return { kind: 'starting' };
  return { kind: 'ok', baseUrl };
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, maxBuffer: 64 * 1024 }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

/** 실행 파일 경로에 Damwha가 있는지까지 본다 (pid 재사용 대비). */
export async function isDamwhaPid(pid: number): Promise<boolean> {
  const out = await run('ps', ['-o', 'comm=', '-p', String(pid)]);
  return out !== null && out.includes('Damwha');
}

export async function anyDamwhaRunning(): Promise<boolean> {
  return (await run('pgrep', ['-x', 'Damwha'])) !== null;
}

export async function fetchHealth(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ instance: string | null } | null> {
  try {
    const res = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { status?: string; instance?: string | null };
    if (body.status !== 'ok') return null;
    return { instance: body.instance ?? null };
  } catch {
    return null;
  }
}

async function readFileOrNull(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/** 실제 환경에 묶은 기본 의존성. */
export function defaultConnectionDeps(env: NodeJS.ProcessEnv = process.env): ConnectionDeps {
  return {
    env,
    userDataDir: defaultUserDataDir(),
    readFile: readFileOrNull,
    isDamwhaPid,
    anyDamwhaRunning,
    fetchHealth,
  };
}
