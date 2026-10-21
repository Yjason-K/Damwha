import { describe, expect, it } from 'vitest';
import { anyDamwhaRunning, defaultUserDataDir, isAppProcess, isCliProcess, isDamwhaPid, resolveConnection } from '../src/connection';

const API = JSON.stringify({ port: 4123, app_pid: 100, instance: 'n1', version: '0.2.3' });

function deps(over: Partial<Parameters<typeof resolveConnection>[0]> = {}) {
  return {
    env: {},
    userDataDir: '/ud',
    readFile: async () => API as string | null,
    isDamwhaPid: async () => true,
    anyDamwhaRunning: async () => false,
    fetchHealth: async () => ({ instance: 'n1' }) as { instance: string | null } | null,
    ...over,
  };
}

describe('resolveConnection', () => {
  it('env DAMWHA_API_URL wins and skips the nonce check', async () => {
    let asked = '';
    const r = await resolveConnection(
      deps({
        env: { DAMWHA_API_URL: 'http://localhost:3000/api' },
        readFile: async () => {
          throw new Error('must not read api.json');
        },
        fetchHealth: async (u) => {
          asked = u;
          return { instance: null };
        },
      }),
    );
    expect(r).toEqual({ kind: 'ok', baseUrl: 'http://localhost:3000/api' });
    expect(asked).toBe('http://localhost:3000/api');
  });

  it('env url with failing health is starting', async () => {
    const r = await resolveConnection(
      deps({ env: { DAMWHA_API_URL: 'http://x/api' }, fetchHealth: async () => null }),
    );
    expect(r).toEqual({ kind: 'starting' });
  });

  it('no api.json and no damwha process is not_running', async () => {
    expect(await resolveConnection(deps({ readFile: async () => null }))).toEqual({ kind: 'not_running' });
  });

  it('no api.json but damwha running is starting', async () => {
    const r = await resolveConnection(deps({ readFile: async () => null, anyDamwhaRunning: async () => true }));
    expect(r).toEqual({ kind: 'starting' });
  });

  it('dead app_pid is not_running', async () => {
    expect(await resolveConnection(deps({ isDamwhaPid: async () => false }))).toEqual({ kind: 'not_running' });
  });

  it('nonce mismatch is starting', async () => {
    const r = await resolveConnection(deps({ fetchHealth: async () => ({ instance: 'old' }) }));
    expect(r).toEqual({ kind: 'starting' });
  });

  it('health null is starting', async () => {
    expect(await resolveConnection(deps({ fetchHealth: async () => null }))).toEqual({ kind: 'starting' });
  });

  it('ok returns the loopback api url', async () => {
    expect(await resolveConnection(deps())).toEqual({ kind: 'ok', baseUrl: 'http://127.0.0.1:4123/api' });
  });

  it('reads api.json from userDataDir', async () => {
    let path = '';
    await resolveConnection(deps({ readFile: async (p) => ((path = p), API) }));
    expect(path).toBe('/ud/api.json');
  });

  it('malformed json is treated as absent', async () => {
    const r = await resolveConnection(deps({ readFile: async () => '{"port": 12' }));
    expect(r).toEqual({ kind: 'not_running' });
    const r2 = await resolveConnection(
      deps({ readFile: async () => '{"port":"x"}', anyDamwhaRunning: async () => true }),
    );
    expect(r2).toEqual({ kind: 'starting' });
  });
});

describe('defaultUserDataDir', () => {
  it('is the macOS Damwha app support dir', () => {
    expect(defaultUserDataDir()).toMatch(/Library\/Application Support\/Damwha$/);
  });
});

// `ps -axo pid=,args=`가 실제로 찍는 모양. 런처는 번들의 Damwha 바이너리를 ELECTRON_RUN_AS_NODE로 다시 쓴다.
const PS = {
  app: '  812 /Applications/Damwha.app/Contents/MacOS/Damwha',
  appSpaced: ' 813 /Volumes/My Disk/Damwha.app/Contents/MacOS/Damwha --some-flag',
  helper: '  900 /Applications/Damwha.app/Contents/Frameworks/Damwha Helper (Renderer).app/Contents/MacOS/Damwha Helper (Renderer) --type=renderer',
  cli: ' 1201 /Applications/Damwha.app/Contents/Resources/cli/../../MacOS/Damwha /Applications/Damwha.app/Contents/Resources/cli/damwha.cjs mcp',
  cliDirect: ' 1202 /Applications/Damwha.app/Contents/MacOS/Damwha /Applications/Damwha.app/Contents/Resources/cli/damwha.cjs status',
  devCli: ' 1300 node /Users/me/daewha/desktop/build/cli/damwha.cjs mcp',
  devApp: ' 1400 /Users/me/daewha/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .',
  unrelated: '  77 /usr/sbin/cfprefsd agent',
  lookalike: '  78 /Applications/DamwhaX.app/Contents/MacOS/DamwhaX',
};
const argsOf = (line: string) => line.trim().replace(/^\d+\s+/, '');

describe('process predicates', () => {
  it('isAppProcess: only the installed app main binary, not helpers, cli or others', () => {
    expect(isAppProcess(argsOf(PS.app))).toBe(true);
    expect(isAppProcess(argsOf(PS.appSpaced))).toBe(true);
    expect(isAppProcess(argsOf(PS.helper))).toBe(false);
    expect(isAppProcess(argsOf(PS.cli))).toBe(false);
    expect(isAppProcess(argsOf(PS.cliDirect))).toBe(false);
    expect(isAppProcess(argsOf(PS.devCli))).toBe(false);
    expect(isAppProcess(argsOf(PS.unrelated))).toBe(false);
    expect(isAppProcess(argsOf(PS.lookalike))).toBe(false);
  });

  it('isCliProcess: any process running damwha.cjs', () => {
    expect(isCliProcess(argsOf(PS.cli))).toBe(true);
    expect(isCliProcess(argsOf(PS.cliDirect))).toBe(true);
    expect(isCliProcess(argsOf(PS.devCli))).toBe(true);
    expect(isCliProcess(argsOf(PS.app))).toBe(false);
    expect(isCliProcess(argsOf(PS.devApp))).toBe(false);
  });
});

describe('process wrappers (injected exec)', () => {
  const exec = (out: string | null) => {
    const calls: string[][] = [];
    const fn = async (cmd: string, args: string[]) => (calls.push([cmd, ...args]), out);
    return { fn, calls };
  };

  it('anyDamwhaRunning lists every process and is false when only cli processes run', async () => {
    const e = exec([PS.cli, PS.cliDirect, PS.helper, PS.unrelated].join('\n') + '\n');
    expect(await anyDamwhaRunning(e.fn)).toBe(false);
    expect(e.calls).toEqual([['ps', '-axo', 'pid=,args=']]);
  });

  it('anyDamwhaRunning is true with the app main process among cli processes', async () => {
    expect(await anyDamwhaRunning(exec([PS.cli, PS.app].join('\n')).fn)).toBe(true);
  });

  it('anyDamwhaRunning is false when ps fails', async () => {
    expect(await anyDamwhaRunning(exec(null).fn)).toBe(false);
  });

  it('isDamwhaPid asks ps for that pid only', async () => {
    const e = exec(argsOf(PS.app) + '\n');
    expect(await isDamwhaPid(812, e.fn)).toBe(true);
    expect(e.calls).toEqual([['ps', '-o', 'args=', '-p', '812']]);
  });

  it('isDamwhaPid rejects a reused pid that is now a cli process', async () => {
    expect(await isDamwhaPid(1201, exec(argsOf(PS.cli)).fn)).toBe(false);
  });

  it('isDamwhaPid accepts the dev Electron app (identity is proved by the nonce)', async () => {
    expect(await isDamwhaPid(1400, exec(argsOf(PS.devApp)).fn)).toBe(true);
  });

  it('isDamwhaPid is false for a dead pid (ps fails) or empty output', async () => {
    expect(await isDamwhaPid(5, exec(null).fn)).toBe(false);
    expect(await isDamwhaPid(5, exec('\n').fn)).toBe(false);
  });
});
