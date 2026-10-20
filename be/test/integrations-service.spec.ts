import * as fsp from 'node:fs/promises';
import { IntegrationsService } from '../src/integrations/integrations.service';

describe('IntegrationsService.get', () => {
  it('클라이언트별로 실패를 registration.error 로 바꾸고 나머지는 유지한다', async () => {
    const svc = new IntegrationsService({
      launcher: '/L/damwha', home: '/nonexistent-home', shell: undefined, pathEnv: '', fs: fsp,
      isExecutable: async () => true,
      run: async (file) => (file.endsWith('/codex') ? { code: 1, stdout: '', stderr: '' } : { code: 3, stdout: '', stderr: 'boom' }),
    });
    const r = await svc.get();
    expect(r.clients['claude-code']).toEqual({ installed: true, registration: { error: expect.stringContaining('boom') } });
    expect(r.clients.codex).toEqual({ installed: true, registration: 'none' });
  });
});

describe('IntegrationsService.get on_path', () => {
  const svc = (shell: string | undefined, probe: string | null, pathEnv = '/usr/bin:/bin') =>
    new IntegrationsService({
      launcher: '/L/damwha', home: '/Users/test', shell, pathEnv, fs: fsp,
      isExecutable: async () => false,
      run: async (_f, a) =>
        a[1]?.startsWith('printf') && probe !== null ? { code: 0, stdout: probe, stderr: '' } : { code: 1, stdout: '', stderr: '' },
    });

  it('uses the login-shell PATH — a Finder-launched API has only /usr/bin:/bin:/usr/sbin:/sbin', async () => {
    expect((await svc('/bin/zsh', '/Users/test/.local/bin:/usr/bin').get()).cli.on_path).toBe(true);
    expect((await svc('/bin/zsh', '/opt/homebrew/bin:/usr/bin', '/Users/test/.local/bin').get()).cli.on_path).toBe(false);
  });

  it('falls back to the process PATH when the probe is unavailable', async () => {
    expect((await svc(undefined, null, '/Users/test/.local/bin').get()).cli.on_path).toBe(true);
    expect((await svc('/bin/zsh', null, '/Users/test/.local/bin').get()).cli.on_path).toBe(true);
    expect((await svc('/bin/zsh', null).get()).cli.on_path).toBe(false);
  });
});
