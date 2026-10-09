import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { request as rawRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { buildAccessPolicy } from '../src/access/access-policy';
import { configureHttp } from '../src/http/configure-http';
import { startTestDb, StartedTestDb } from './db';

/**
 * spec 2026-10-08-local-api-access-control §6 — 공격 시나리오별 e2e. 앱은 main.ts와 같은 configureHttp로 만든다.
 * "거부됐다"는 403만으로 보지 않는다: 쓰기 시나리오는 DB에 행이 생기지 않았는지까지 본다.
 */
const DEV = 'http://localhost:5173';
const EVIL = 'https://evil.example';
const DEMO_HOST = 'damwha-demo.example';
const SELF_HOST = '127.0.0.1:3000';
const SELF = `http://${SELF_HOST}`;

describe('local API access control', () => {
  let db: StartedTestDb;
  let app: NestExpressApplication;
  let publicDir: string;

  beforeAll(async () => {
    db = await startTestDb();
    publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'damwha-spa-'));
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>spa</title>');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureHttp(app, { policy: buildAccessPolicy(DEV, DEMO_HOST), publicDir });
    await app.init();
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => {
    await app?.close();
    await db?.stop();
    fs.rmSync(publicDir, { recursive: true, force: true });
  });

  const http = () => request(app.getHttpServer());
  const count = async (sql: string, args: unknown[] = []) => Number((await db.pool.query(sql, args)).rows[0].n);
  const meetingCount = () => count('SELECT count(*) AS n FROM meeting');
  const folderNamed = (name: string) => count('SELECT count(*) AS n FROM folder WHERE name = $1', [name]);
  /** 헤더 없는 요청(접근 제어를 통과하는 모양)으로 오디오가 있는 회의를 만든다. */
  const seedMeeting = async () =>
    (await http().post('/api/meetings').set('Host', SELF_HOST)
      .attach('audio', Buffer.from('0123456789'), { filename: 'a.wav', contentType: 'audio/wav' })
      .expect(201)).body.id as string;

  describe('1·읽기', () => {
    it('다른 Origin의 GET은 403이고 ACAO가 없다', async () => {
      const res = await http().get('/api/meetings').set('Host', SELF_HOST).set('Origin', EVIL).expect(403);
      expect(res.body).toMatchObject({ statusCode: 403, code: 'ORIGIN_NOT_ALLOWED' });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('2~4·CSRF simple request', () => {
    it('urlencoded form POST는 403이고 폴더가 생기지 않는다', async () => {
      await http().post('/api/folders').set('Host', SELF_HOST).set('Origin', EVIL)
        .type('form').send('name=csrf-probe').expect(403);
      expect(await folderNamed('csrf-probe')).toBe(0);
    });

    it('multipart 업로드는 403이고 회의도 파일도 생기지 않는다', async () => {
      await http().post('/api/meetings').set('Host', SELF_HOST).set('Origin', EVIL)
        .attach('audio', Buffer.from('0123456789'), { filename: 'a.wav', contentType: 'audio/wav' })
        .expect(403);
      expect(await meetingCount()).toBe(0);
      expect(fs.existsSync(path.join(db.storageRoot, 'meetings'))
        ? fs.readdirSync(path.join(db.storageRoot, 'meetings')) : []).toEqual([]);
    });

    it('다른 Origin의 공유 만들기는 403이고 meeting_share 행이 생기지 않는다', async () => {
      const mid = await seedMeeting();
      await http().post(`/api/meetings/${mid}/share`).set('Host', SELF_HOST).set('Origin', EVIL)
        .type('text/plain').send(JSON.stringify({ scope: {}, duration_days: 7, consent_version: 1, ui_language: 'ko' }))
        .expect(403);
      expect(await count('SELECT count(*) AS n FROM meeting_share')).toBe(0);
    });

    it('다른 Origin은 공유 목록(키가 든 링크)을 읽지 못한다', async () => {
      const res = await http().get('/api/shares').set('Host', SELF_HOST).set('Origin', EVIL).expect(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('text/plain으로 실시간 녹음 시작은 403이고 회의가 생기지 않는다', async () => {
      await http().post('/api/meetings/live').set('Host', SELF_HOST).set('Origin', EVIL)
        .set('Content-Type', 'text/plain').send('{}').expect(403);
      expect(await meetingCount()).toBe(0);
    });
  });

  describe('5·Origin 없는 cross-site no-cors GET', () => {
    it.each(['cross-site', 'same-site'])('Sec-Fetch-Site: %s 오디오 요청은 403', async (site) => {
      const id = await seedMeeting();
      await http().get(`/api/meetings/${id}/audio`).set('Host', SELF_HOST).set('Sec-Fetch-Site', site).expect(403);
    });
  });

  describe('6·preflight', () => {
    it('다른 Origin의 preflight는 403이고 ACAO가 없다', async () => {
      const res = await http().options('/api/meetings/mtg_1').set('Host', SELF_HOST).set('Origin', EVIL)
        .set('Access-Control-Request-Method', 'DELETE').expect(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('허용 Origin의 preflight는 204와 그 Origin을 담은 CORS 헤더', async () => {
      const res = await http().options('/api/meetings/mtg_1/live/audio').set('Host', SELF_HOST).set('Origin', DEV)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,x-audio-offset').expect(204);
      expect(res.headers['access-control-allow-origin']).toBe(DEV);
      expect(res.headers['access-control-allow-methods']).toMatch(/DELETE/);
      expect(res.headers['access-control-allow-headers']).toBe('content-type,x-audio-offset');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });
  });

  describe('7·DNS rebinding', () => {
    it.each(['/api/health', '/docs', '/'])('Host가 공격자 이름이면 %s도 403', async (p) => {
      const res = await http().get(p).set('Host', 'attacker.example:3000').expect(403);
      expect(res.body.code).toBe('HOST_NOT_ALLOWED');
    });
  });

  describe('8·정상 경로', () => {
    it('packaged 모양: 같은 origin의 POST·GET·DELETE', async () => {
      const created = await http().post('/api/folders').set('Host', SELF_HOST).set('Origin', SELF)
        .send({ name: '같은 origin' }).expect(201);
      expect(created.headers['access-control-allow-origin']).toBeUndefined();
      await http().get('/api/folders').set('Host', SELF_HOST).set('Sec-Fetch-Site', 'same-origin').expect(200);
      await http().delete(`/api/folders/${created.body.id}`).set('Host', SELF_HOST).set('Origin', SELF).expect(204);
    });

    it('dev 모양: 허용 Origin의 GET에 그 Origin의 ACAO', async () => {
      const res = await http().get('/api/meetings').set('Host', 'localhost:3000').set('Origin', DEV).expect(200);
      expect(res.headers['access-control-allow-origin']).toBe(DEV);
      expect(res.headers.vary).toMatch(/Origin/);
    });

    it('헬스 프로브 모양: 헤더 없는 요청은 통과하고 ACAO가 없다', async () => {
      const res = await http().get('/api/health').set('Host', SELF_HOST).set('Sec-Fetch-Mode', 'cors').expect(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('dev 오디오: 허용 Origin의 Range 요청은 206과 ACAO', async () => {
      const id = await seedMeeting();
      const res = await http().get(`/api/meetings/${id}/audio`).set('Host', SELF_HOST).set('Origin', DEV)
        .set('Range', 'bytes=2-5').expect(206);
      expect(res.headers['access-control-allow-origin']).toBe(DEV);
    });

    it('데모 모양: https Origin + 데모 Host', async () => {
      await http().post('/api/folders').set('Host', DEMO_HOST).set('Origin', `https://${DEMO_HOST}`)
        .send({ name: '데모' }).expect(201);
    });

    it('제품 사이트에서 데모 / 로의 cross-site 내비게이션은 SPA를 준다', async () => {
      const res = await http().get('/').set('Host', DEMO_HOST)
        .set('Sec-Fetch-Site', 'cross-site').set('Sec-Fetch-Mode', 'navigate').expect(200);
      expect(res.text).toContain('<title>spa</title>');
    });
  });

  describe('9·클릭재킹 헤더', () => {
    const framed = (res: request.Response) => {
      expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
    };
    it('200에도', async () => framed(await http().get('/api/health').set('Host', SELF_HOST).expect(200)));
    it('HOST_NOT_ALLOWED 403에도', async () => framed(await http().get('/api/health').set('Host', 'attacker.example').expect(403)));
    it('ORIGIN_NOT_ALLOWED 403에도', async () =>
      framed(await http().get('/api/meetings').set('Host', SELF_HOST).set('Origin', EVIL).expect(403)));
  });

  describe('10·접근 제어가 본문 파서보다 먼저', () => {
    const bigJson = JSON.stringify({ name: 'x'.repeat(1_500_000) });   // json 파서 상한 1mb 초과
    const bigForm = `name=${'x'.repeat(200_000)}`;                     // Nest urlencoded 기본 상한 100kb 초과

    it('대조군: 허용된 요청이면 큰 JSON은 413 — 이 크기가 파서에 걸린다는 증거', async () => {
      await http().post('/api/folders').set('Host', SELF_HOST)
        .set('Content-Type', 'application/json').send(bigJson).expect(413);
    });
    it('대조군: 허용된 요청이면 큰 urlencoded도 413', async () => {
      await http().post('/api/folders').set('Host', SELF_HOST).type('form').send(bigForm).expect(413);
    });
    /** Content-Length를 파서 상한보다 크게 선언하고 1KB만 쓴 채 요청을 끝내지 않는다. 서버가 응답할 때 우리는 쓰고 있지
     *  않으므로 ECONNRESET 경합이 없다. 파서가 먼저 도는 구성(변이 M5)은 본문을 기다리느라 아예 응답하지 않는다 → 'no-response'. */
    const statusOfOversized = async (contentType: string, declared: number): Promise<number | 'no-response'> => {
      const srv = app.getHttpServer() as Server;
      if (!srv.listening) await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      const { port } = srv.address() as AddressInfo;
      return new Promise((resolve) => {
        const req = rawRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/folders', headers: {
          Host: SELF_HOST, Origin: EVIL, 'Content-Type': contentType, 'Content-Length': String(declared) } });
        const t = setTimeout(() => { resolve('no-response'); req.destroy(); }, 2000);
        req.on('response', (res) => { clearTimeout(t); resolve(res.statusCode!); res.resume(); req.destroy(); });
        req.on('error', () => { clearTimeout(t); resolve('no-response'); });
        req.write('x'.repeat(1024));
      });
    };
    it('다른 Origin의 큰 JSON은 413이 아니라 403', async () =>
      expect(await statusOfOversized('application/json', 1_500_020)).toBe(403));
    it('다른 Origin의 큰 urlencoded는 413이 아니라 403', async () =>
      expect(await statusOfOversized('application/x-www-form-urlencoded', 200_020)).toBe(403));
  });

  describe('11·경로 대소문자', () => {
    it('대조군: /API/meetings도 라우터가 처리한다', async () => {
      await http().get('/API/meetings').set('Host', SELF_HOST).expect(200);
    });
    it('다른 Origin의 GET /API/meetings는 403', async () => {
      await http().get('/API/meetings').set('Host', SELF_HOST).set('Origin', EVIL).expect(403);
    });
    it('다른 Origin의 urlencoded POST /Api/folders는 403이고 폴더가 없다', async () => {
      await http().post('/Api/folders').set('Host', SELF_HOST).set('Origin', EVIL).type('form').send('name=case-probe').expect(403);
      expect(await folderNamed('case-probe')).toBe(0);
    });
  });

  it('어떤 응답에도 ACAO: *가 없다', async () => {
    for (const r of [
      await http().get('/api/health').set('Host', SELF_HOST),
      await http().get('/api/meetings').set('Host', SELF_HOST).set('Origin', DEV),
      await http().get('/api/meetings').set('Host', SELF_HOST).set('Origin', EVIL),
    ]) {
      expect(r.headers['access-control-allow-origin']).not.toBe('*');
    }
  });
});
