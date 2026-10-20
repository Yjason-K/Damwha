import { ConflictError } from './errors';
import type { RunResult } from './run-command';

export type ClientId = 'claude-code' | 'codex';
export type Run = (file: string, args: string[]) => Promise<RunResult>;
export type ClientState =
  | { installed: false }
  | { installed: true; registration: 'none' | 'ours' | { other: string } };

// 설정 파일은 직접 만지지 않고 각 클라이언트 CLI만 쓴다 (spec §2.7). 인자는 고정 배열이다.
const GET = ['mcp', 'get', 'damwha'];
const addArgs = (id: ClientId, linkPath: string): string[] =>
  id === 'claude-code'
    ? ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'damwha', '--', linkPath, 'mcp']
    : ['mcp', 'add', 'damwha', '--', linkPath, 'mcp'];
const removeArgs = (id: ClientId): string[] =>
  id === 'claude-code' ? ['mcp', 'remove', '--scope', 'user', 'damwha'] : ['mcp', 'remove', 'damwha'];

function fail(what: string, r: RunResult): Error {
  return new Error(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
}

/**
 * `mcp get damwha` 출력에서 명령과 인자를 뽑는다. 두 CLI 모두 `Command:`/`command:`·`Args:`/`args:` 줄을 쓴다(실측
 * 픽스처). 출력 전체에서 경로와 `mcp`를 찾지 않는 이유: claude는 실패 원인(`Issue:`)에 경로를 되풀이하고 끝에
 * `claude mcp remove` 안내를 붙여서 다른 명령도 "경로+mcp"로 보인다.
 */
function parseGet(stdout: string): { command: string; args: string } {
  const field = (key: string) => {
    const m = new RegExp(`^\\s*${key}:\\s*(.*?)\\s*$`, 'im').exec(stdout);
    const v = m?.[1] ?? '';
    return v === '-' ? '' : v;
  };
  return { command: field('command'), args: field('args') };
}

export async function clientState(id: ClientId, bin: string | null, linkPath: string, run: Run): Promise<ClientState> {
  if (!bin) return { installed: false };
  const r = await run(bin, GET);
  if (r.code === 0) {
    const { command, args } = parseGet(r.stdout);
    if (command === linkPath && args === 'mcp') return { installed: true, registration: 'ours' };
    return { installed: true, registration: { other: [command, args].filter(Boolean).join(' ') || 'unknown' } };
  }
  // 두 CLI 모두 항목이 없으면 종료 코드 1에 stdout이 비어 있다. 그 밖의 실패(설정 손상 등)는 "없음"으로 읽지 않는다.
  if (r.code === 1 && r.stdout.trim() === '') return { installed: true, registration: 'none' };
  throw fail(`${id} mcp get`, r);
}

export async function registerClient(
  id: ClientId,
  bin: string | null,
  linkPath: string,
  run: Run,
  opts: { replace: boolean },
): Promise<ClientState> {
  const state = await clientState(id, bin, linkPath, run);
  if (!state.installed || !bin) return state;
  if (state.registration === 'ours') return state;
  if (typeof state.registration === 'object') {
    // 남의 항목은 명시적 replace 없이는 건드리지 않는다.
    if (!opts.replace) throw new ConflictError(state.registration.other);
    const removed = await run(bin, removeArgs(id));
    if (removed.code !== 0) throw fail(`${id} mcp remove`, removed);
  }
  const added = await run(bin, addArgs(id, linkPath));
  if (added.code !== 0) throw fail(`${id} mcp add`, added);
  return clientState(id, bin, linkPath, run);
}

/** 담화 명령으로 등록된 경우에만 지운다. */
export async function unregisterClient(id: ClientId, bin: string | null, linkPath: string, run: Run): Promise<ClientState> {
  const state = await clientState(id, bin, linkPath, run);
  if (!state.installed || !bin || state.registration !== 'ours') return state;
  const r = await run(bin, removeArgs(id));
  if (r.code !== 0) throw fail(`${id} mcp remove`, r);
  return clientState(id, bin, linkPath, run);
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** 설정 화면 "수동으로 설치"에 그대로 보이는 문자열. */
export function manualCommands(linkPath: string, launcher: string) {
  const dir = linkPath.slice(0, linkPath.lastIndexOf('/'));
  return {
    link: `mkdir -p ${q(dir)} && ln -s ${q(launcher)} ${q(linkPath)}`,
    claudeCode: `claude mcp add --transport stdio --scope user damwha -- ${q(linkPath)} mcp`,
    codex: `codex mcp add damwha -- ${q(linkPath)} mcp`,
    genericJson: JSON.stringify({ mcpServers: { damwha: { command: linkPath, args: ['mcp'] } } }, null, 2),
  };
}
