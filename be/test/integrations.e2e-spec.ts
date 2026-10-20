import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { INTEGRATIONS_ENABLED } from '../src/integrations/integrations-enabled.guard';
import { INTEGRATIONS_DEPS, type IntegrationsDeps } from '../src/integrations/integrations.service';
import type { RunResult } from '../src/integrations/run-command';
import { startTestDb, StartedTestDb } from './db';

const LAUNCHER = '/Applications/Damwha.app/Contents/Resources/cli/damwha';

/** 가짜 claude/codex: 등록 상태를 메모리에 두고 get·add·remove에 답한다. */
function fakeClients() {
  const state: Record<string, { command: string; args: string } | null> = { claude: null, codex: null };
  const calls: string[][] = [];
  const run = async (file: string, args: string[]): Promise<RunResult> => {
    calls.push([file, ...args]);
    const id = path.basename(file);
    if (args[1] === 'get') {
      const s = state[id];
      return s ? { code: 0, stdout: `Command: ${s.command}\nArgs: ${s.args}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'none' };
    }
    if (args[1] === 'add') {
      if (state[id]?.command === 'FAIL-ADD') return { code: 1, stdout: '', stderr: 'cannot write' };
      const dash = args.indexOf('--');
      state[id] = { command: args[dash + 1], args: args.slice(dash + 2).join(' ') };
    }
    if (args[1] === 'remove') {
      removedOnce.push(state[id]!);
      state[id] = null;
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const removedOnce: { command: string; args: string }[] = [];
  return { state, calls, run, removedOnce };
}

describe('연동 API', () => {
  let db: StartedTestDb;
  let home: string;
  let linkPath: string;

  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db?.stop(); });
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'damwha-integ-'));
    linkPath = path.join(home, '.local/bin/damwha');
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  async function makeApp(enabled: boolean, over: Partial<IntegrationsDeps> = {}) {
    const deps: IntegrationsDeps = {
      launcher: LAUNCHER,
      home,
      shell: undefined,
      pathEnv: `/usr/bin:${home}/.local/bin`,
      fs: fsp,
      run: async () => ({ code: 1, stdout: '', stderr: '' }),
      // claude만 설치된 Mac
      isExecutable: async (p) => p === `${home}/.local/bin/claude`,
      ...over,
    };
    const app = (await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(INTEGRATIONS_ENABLED).useValue(enabled)
      .overrideProvider(INTEGRATIONS_DEPS).useValue(deps)
      .compile()).createNestApplication<NestExpressApplication>();
    await app.init();
    return app;
  }

  it('disabled: 모든 라우트가 404', async () => {
    const app = await makeApp(false);
    try {
      const h = () => request(app.getHttpServer());
      await h().get('/integrations').expect(404);
      await h().post('/integrations/cli/install').expect(404);
      await h().delete('/integrations/cli').expect(404);
      await h().post('/integrations/claude-code/install').send({}).expect(404);
      await h().delete('/integrations/claude-code').expect(404);
      expect(fs.existsSync(linkPath)).toBe(false);
    } finally { await app.close(); }
  });

  it('GET은 링크·클라이언트 상태와 수동 명령을 돌려준다', async () => {
    const c = fakeClients();
    const app = await makeApp(true, { run: c.run });
    try {
      const res = await request(app.getHttpServer()).get('/integrations').expect(200);
      expect(res.body.cli).toEqual({ link: { kind: 'absent' }, link_path: linkPath, on_path: true });
      expect(res.body.clients).toEqual({
        'claude-code': { installed: true, registration: 'none' },
        codex: { installed: false },
      });
      expect(res.body.manual.codex).toContain(linkPath);
    } finally { await app.close(); }
  });

  it('on_path는 PATH에 ~/.local/bin이 없으면 false', async () => {
    const app = await makeApp(true, { pathEnv: '/usr/bin' });
    try {
      const res = await request(app.getHttpServer()).get('/integrations').expect(200);
      expect(res.body.cli.on_path).toBe(false);
    } finally { await app.close(); }
  });

  it('cli install 설치 후 delete 로 지운다 (204)', async () => {
    const app = await makeApp(true);
    try {
      const h = () => request(app.getHttpServer());
      const res = await h().post('/integrations/cli/install').expect(200);
      expect(res.body).toEqual({ kind: 'current' });
      expect(fs.readlinkSync(linkPath)).toBe(LAUNCHER);
      await h().delete('/integrations/cli').expect(204);
      expect(fs.existsSync(linkPath)).toBe(false);
    } finally { await app.close(); }
  });

  it('cli install 충돌은 409 와 정해진 본문', async () => {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.writeFileSync(linkPath, 'mine');
    const app = await makeApp(true);
    try {
      const res = await request(app.getHttpServer()).post('/integrations/cli/install').expect(409);
      expect(res.body).toEqual({
        statusCode: 409,
        code: 'INTEGRATION_CONFLICT',
        message: expect.any(String),
        target: linkPath,
      });
      expect(fs.readFileSync(linkPath, 'utf8')).toBe('mine');
    } finally { await app.close(); }
  });

  it('client install 은 링크를 먼저 설치하고 등록한다', async () => {
    const c = fakeClients();
    const app = await makeApp(true, { run: c.run });
    try {
      const res = await request(app.getHttpServer()).post('/integrations/claude-code/install').send({}).expect(200);
      expect(fs.readlinkSync(linkPath)).toBe(LAUNCHER);
      expect(res.body).toEqual({ installed: true, registration: 'ours' });
      expect(c.state.claude).toEqual({ command: linkPath, args: 'mcp' });
    } finally { await app.close(); }
  });

  it('클라이언트가 없으면 링크도 만들지 않는다', async () => {
    const app = await makeApp(true);
    try {
      const res = await request(app.getHttpServer()).post('/integrations/codex/install').send({}).expect(200);
      expect(res.body).toEqual({ installed: false });
      expect(fs.existsSync(linkPath)).toBe(false);
    } finally { await app.close(); }
  });

  it('남의 등록은 replace 없이 409, replace:true 면 교체', async () => {
    const c = fakeClients();
    c.state.claude = { command: '/x/other', args: 'serve' };
    const app = await makeApp(true, { run: c.run });
    try {
      const h = () => request(app.getHttpServer());
      const res = await h().post('/integrations/claude-code/install').send({}).expect(409);
      expect(res.body).toMatchObject({ code: 'INTEGRATION_CONFLICT', target: '/x/other serve' });
      expect(c.state.claude).toEqual({ command: '/x/other', args: 'serve' });
      await h().post('/integrations/claude-code/install').send({ replace: true }).expect(200);
      expect(c.state.claude).toEqual({ command: linkPath, args: 'mcp' });
    } finally { await app.close(); }
  });

  it('교체 중 add 가 실패하면 오류 본문에 이전 명령이 있다', async () => {
    const c = fakeClients();
    c.state.claude = { command: '/x/other', args: 'serve' };
    const base = c.run;
    const run = async (f: string, a: string[]) =>
      a[1] === 'add' ? ({ code: 1, stdout: '', stderr: 'cannot write' } as RunResult) : base(f, a);
    const app = await makeApp(true, { run });
    try {
      const res = await request(app.getHttpServer()).post('/integrations/claude-code/install').send({ replace: true }).expect(500);
      expect(res.body).toMatchObject({ statusCode: 500, code: 'INTEGRATION_FAILED' });
      expect(res.body.message).toContain('cannot write');
      expect(res.body.previous).toBe('/x/other serve');
    } finally { await app.close(); }
  });

  it('client delete 는 우리 등록만 지우고 204', async () => {
    const c = fakeClients();
    c.state.claude = { command: linkPath, args: 'mcp' };
    const app = await makeApp(true, { run: c.run });
    try {
      await request(app.getHttpServer()).delete('/integrations/claude-code').expect(204);
      expect(c.state.claude).toBeNull();
    } finally { await app.close(); }
  });

  it('알 수 없는 client 는 404', async () => {
    const app = await makeApp(true);
    try {
      const h = () => request(app.getHttpServer());
      await h().post('/integrations/vim/install').send({}).expect(404);
      await h().delete('/integrations/vim').expect(404);
    } finally { await app.close(); }
  });
});
