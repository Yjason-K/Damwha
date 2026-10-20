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
