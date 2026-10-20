import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientState, manualCommands, registerClient, unregisterClient } from '../src/integrations/clients';
import { findExecutable } from '../src/integrations/find-executable';
import { ConflictError } from '../src/integrations/errors';
import { runCommand, type RunResult } from '../src/integrations/run-command';

const LINK = '/Users/test/.local/bin/damwha';
const LAUNCHER = '/Applications/Damwha.app/Contents/Resources/cli/damwha';
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'integrations', name), 'utf8');

// 이 Mac의 실제 CLI(claude 2.1.304, codex 0.163.0)에서 격리 HOME으로 뜬 출력이다. 없음은 두 CLI 모두 종료 코드 1·stdout 빈 값.
const GET = {
  'claude-code': {
    none: { code: 1, stdout: '', stderr: fixture('claude-get-none.stderr.txt') },
    ours: { code: 0, stdout: fixture('claude-get-ours.txt'), stderr: '' },
    other: { code: 0, stdout: fixture('claude-get-other.txt'), stderr: '' },
  },
  codex: {
    none: { code: 1, stdout: '', stderr: fixture('codex-get-none.stderr.txt') },
    ours: { code: 0, stdout: fixture('codex-get-ours.txt'), stderr: '' },
    other: { code: 0, stdout: fixture('codex-get-other.txt'), stderr: '' },
  },
} as const;

/** get은 상태에 따라 답하고, add·remove는 호출을 기록하며 상태를 바꾼다. */
function fakeRun(id: 'claude-code' | 'codex', initial: 'none' | 'ours' | 'other') {
  let state = initial;
  const calls: string[][] = [];
  const run = async (file: string, args: string[]): Promise<RunResult> => {
    calls.push([file, ...args]);
    if (args[1] === 'get') return GET[id][state];
    if (args[1] === 'add') state = 'ours';
    if (args[1] === 'remove') state = 'none';
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

// 픽스처의 홈은 /Users/test라 linkPath도 같다.
describe.each(['claude-code', 'codex'] as const)('clients (%s)', (id) => {
  const BIN = '/opt/bin/cli';
  const ADD =
    id === 'claude-code'
      ? [BIN, 'mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'damwha', '--', LINK, 'mcp']
      : [BIN, 'mcp', 'add', 'damwha', '--', LINK, 'mcp'];
  const REMOVE = id === 'claude-code' ? [BIN, 'mcp', 'remove', '--scope', 'user', 'damwha'] : [BIN, 'mcp', 'remove', 'damwha'];

  it('bin missing -> installed false and runs nothing', async () => {
    const { run, calls } = fakeRun(id, 'none');
    expect(await clientState(id, null, LINK, run)).toEqual({ installed: false });
    expect(calls).toEqual([]);
  });

  it('get not found (exit 1, empty stdout) -> none', async () => {
    const { run, calls } = fakeRun(id, 'none');
    expect(await clientState(id, BIN, LINK, run)).toEqual({ installed: true, registration: 'none' });
    expect(calls[0]).toEqual([BIN, 'mcp', 'get', 'damwha']);
  });

  it('get output with our link + mcp -> ours', async () => {
    const { run } = fakeRun(id, 'ours');
    expect(await clientState(id, BIN, LINK, run)).toEqual({ installed: true, registration: 'ours' });
  });

  it('get output with another command -> other, carrying that command', async () => {
    const { run } = fakeRun(id, 'other');
    expect(await clientState(id, BIN, LINK, run)).toEqual({
      installed: true,
      registration: { other: '/usr/bin/other-tool serve --flag' },
    });
  });

  it('our link with different args is not ours', async () => {
    const run = async (): Promise<RunResult> => ({
      code: 0,
      stdout: GET[id].ours.stdout.replace(/(args?:\s*)mcp/i, '$1serve'),
      stderr: '',
    });
    const s = await clientState(id, BIN, LINK, run);
    expect(s).toEqual({ installed: true, registration: { other: `${LINK} serve` } });
  });

  it('unexpected non-zero exit throws instead of reading as none', async () => {
    const run = async (): Promise<RunResult> => ({ code: 2, stdout: '', stderr: 'boom' });
    await expect(clientState(id, BIN, LINK, run)).rejects.toThrow(/boom/);
  });

  it('register adds when none', async () => {
    const { run, calls } = fakeRun(id, 'none');
    const s = await registerClient(id, BIN, LINK, run, { replace: false });
    expect(calls.map((c) => c.slice(0, 3).join(' '))).toEqual([`${BIN} mcp get`, `${BIN} mcp add`, `${BIN} mcp get`]);
    expect(calls[1]).toEqual(ADD);
    expect(s).toEqual({ installed: true, registration: 'ours' });
  });

  it('register is a no-op when already ours', async () => {
    const { run, calls } = fakeRun(id, 'ours');
    await registerClient(id, BIN, LINK, run, { replace: false });
    expect(calls.some((c) => c[2] === 'add' || c[2] === 'remove')).toBe(false);
  });

  it('register over someone else throws ConflictError without touching anything', async () => {
    const { run, calls } = fakeRun(id, 'other');
    await expect(registerClient(id, BIN, LINK, run, { replace: false })).rejects.toBeInstanceOf(ConflictError);
    expect(calls.some((c) => c[2] === 'add' || c[2] === 'remove')).toBe(false);
  });

  it('register replaces only with replace flag: remove then add', async () => {
    const { run, calls } = fakeRun(id, 'other');
    await registerClient(id, BIN, LINK, run, { replace: true });
    const mutating = calls.filter((c) => c[2] === 'add' || c[2] === 'remove');
    expect(mutating).toEqual([REMOVE, ADD]);
  });

  it('register surfaces a failed add', async () => {
    const run = async (_f: string, args: string[]): Promise<RunResult> =>
      args[1] === 'add' ? { code: 1, stdout: '', stderr: 'cannot write config' } : GET[id].none;
    await expect(registerClient(id, BIN, LINK, run, { replace: false })).rejects.toThrow(/cannot write config/);
  });

  it('unregister removes when ours', async () => {
    const { run, calls } = fakeRun(id, 'ours');
    const s = await unregisterClient(id, BIN, LINK, run);
    expect(calls).toContainEqual(REMOVE);
    expect(s).toEqual({ installed: true, registration: 'none' });
  });

  it('unregister skips when other or none', async () => {
    for (const initial of ['other', 'none'] as const) {
      const { run, calls } = fakeRun(id, initial);
      await unregisterClient(id, BIN, LINK, run);
      expect(calls.some((c) => c[2] === 'remove')).toBe(false);
    }
  });
});

describe('findExecutable', () => {
  const ok = (...paths: string[]) => async (p: string) => paths.includes(p);
  const noRun = async (): Promise<RunResult> => {
    throw new Error('should not run');
  };

  it('prefers known dir in spec order', async () => {
    const found = await findExecutable('claude', {
      home: '/Users/test',
      shell: '/bin/zsh',
      isExecutable: ok('/opt/homebrew/bin/claude', '/Users/test/.claude/local/claude'),
      run: noRun,
    });
    expect(found).toBe('/Users/test/.claude/local/claude');
  });

  it('falls back to login shell for zsh', async () => {
    const calls: string[][] = [];
    const found = await findExecutable('codex', {
      home: '/Users/test',
      shell: '/bin/zsh',
      isExecutable: ok('/Users/test/.nvm/bin/codex'),
      run: async (f: string, a: string[]) => {
        calls.push([f, ...a]);
        return { code: 0, stdout: '/Users/test/.nvm/bin/codex\n', stderr: '' };
      },
    });
    expect(found).toBe('/Users/test/.nvm/bin/codex');
    expect(calls).toEqual([['/bin/zsh', '-lc', 'command -v codex']]);
  });

  it('ignores unknown shell /usr/bin/fish', async () => {
    const found = await findExecutable('codex', {
      home: '/Users/test',
      shell: '/usr/bin/fish',
      isExecutable: ok(),
      run: noRun,
    });
    expect(found).toBeNull();
  });

  it('rejects a shell answer that is not an absolute executable path', async () => {
    for (const out of ['codex: aliased', 'relative/codex', '/nonexistent/codex']) {
      const found = await findExecutable('codex', {
        home: '/Users/test',
        shell: '/bin/bash',
        isExecutable: ok(),
        run: async () => ({ code: 0, stdout: out, stderr: '' }),
      });
      expect(found).toBeNull();
    }
  });
});

describe('manualCommands', () => {
  it('matches what the screen shows verbatim', () => {
    expect(manualCommands(LINK, LAUNCHER)).toEqual({
      link: `mkdir -p '/Users/test/.local/bin' && ln -s '${LAUNCHER}' '${LINK}'`,
      claudeCode: `claude mcp add --transport stdio --scope user damwha -- '${LINK}' mcp`,
      codex: `codex mcp add damwha -- '${LINK}' mcp`,
      genericJson: JSON.stringify({ mcpServers: { damwha: { command: LINK, args: ['mcp'] } } }, null, 2),
    });
  });
});

describe('runCommand', () => {
  it('returns a non-zero exit instead of rejecting', async () => {
    expect(await runCommand('/usr/bin/false', [])).toMatchObject({ code: 1 });
  });
  it('captures stdout', async () => {
    expect(await runCommand('/bin/echo', ['hi'])).toEqual({ code: 0, stdout: 'hi\n', stderr: '' });
  });
  it('rejects when the executable does not exist', async () => {
    await expect(runCommand('/nonexistent/bin', [])).rejects.toThrow();
  });
});
