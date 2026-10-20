import { describe, expect, it } from 'vitest';
import { resolveConnection, defaultUserDataDir } from '../src/connection';

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
