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

/** 명령을 돌려 stdout을 준다. 실패(종료 코드·시간 초과)는 null. 테스트가 갈아끼운다. */
export type Exec = (cmd: string, args: string[]) => Promise<string | null>;

const run: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });

/**
 * CLI·MCP 프로세스도 Contents/MacOS/Damwha다 — 런처가 번들의 Damwha 바이너리를 ELECTRON_RUN_AS_NODE로 다시 쓴다.
 * 그래서 이름(`pgrep -x Damwha`, comm에 "Damwha")으로는 앱과 CLI가 구별되지 않고, MCP 서버 하나만 떠 있어도
 * "앱이 뜨는 중"으로 읽힌다. argv에 damwha.cjs가 있으면 CLI다.
 */
export const isCliProcess = (args: string): boolean => args.includes('damwha.cjs');

/** 설치된 앱 본체(Damwha.app의 메인 실행 파일)인가. Helper·CLI·이름만 비슷한 앱은 아니다. */
export const isAppProcess = (args: string): boolean =>
  /\/Damwha\.app\/Contents\/MacOS\/Damwha(?: |$)/.test(args) && !isCliProcess(args);

/**
 * api.json의 app_pid가 앱인가. 여기서는 "살아 있고 CLI가 아니다"만 본다 — 신원은 뒤이은 health의 nonce가 증명한다.
 * 실행 파일 경로까지 묶지 않는 건 desktop:dev 때문이다: dev의 앱은 node_modules의 Electron.app/Contents/MacOS/Electron이다.
 * CLI 제외는 pid가 재사용돼 우리 CLI 프로세스가 됐을 때 그걸 앱으로 오인하지 않기 위해서다.
 */
export async function isDamwhaPid(pid: number, exec: Exec = run): Promise<boolean> {
  const args = (await exec('ps', ['-o', 'args=', '-p', String(pid)]))?.trim();
  return Boolean(args) && !isCliProcess(args!);
}

/**
 * api.json이 아직 없을 때 앱이 막 뜨는 중인지 본다. 설치된 앱만 알아본다 — dev 앱은 CLI를 DAMWHA_API_URL로 붙이거나
 * api.json이 생긴 뒤에 쓰면 되고, 그 사이는 not_running으로 읽혀도 된다.
 */
export async function anyDamwhaRunning(exec: Exec = run): Promise<boolean> {
  const out = await exec('ps', ['-axo', 'pid=,args=']);
  if (out === null) return false;
  return out.split('\n').some((line) => isAppProcess(line.trim().replace(/^\d+\s+/, '')));
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
