import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 공유 서버의 HTTP 계약(share/src/app.ts)만 흉내 내는 서버. be 테스트가 실제 공유 서버 없이 업로드·교체·철회·
 * 장애를 재현한다. mode로 장애를 고른다 — drop: 소켓을 끊음(오프라인), storeThenDrop: 저장은 하고 응답 대신 소켓을 끊음
 * (응답 유실), down500, busy503, redirect, garbage(201인데 replaced만 boolean이 아님), garbageDate(201인데 expires_at만 날짜가 아님).
 * nextUpload()는 다음 POST가 **도착한 순간** 풀린다 — 경합 테스트가 "업로드 중"을 시간 대신 사건으로 기다린다.
 */
export type FakeMode = 'ok' | 'drop' | 'storeThenDrop' | 'down500' | 'busy503' | 'redirect' | 'garbage' | 'garbageDate';

export interface FakeShareServer {
  url: string;
  objects: Map<string, { body: Buffer; token: string; expires_at: string }>;
  requests: { method: string; path: string; headers: http.IncomingHttpHeaders }[];
  mode: FakeMode;
  delayMs: number;
  nextUpload(): Promise<void>;
  close(): Promise<void>;
}

export async function startFakeShareServer(): Promise<FakeShareServer> {
  let n = 0;
  let uploadWaiters: (() => void)[] = [];
  const state = {
    objects: new Map<string, { body: Buffer; token: string; expires_at: string }>(),
    requests: [] as FakeShareServer['requests'],
    mode: 'ok' as FakeMode,
    delayMs: 0,
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      state.requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers });
      if (req.method === 'POST') {
        const w = uploadWaiters;
        uploadWaiters = [];
        w.forEach((resolve) => resolve());
      }
      if (state.delayMs > 0) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.mode === 'drop') { req.socket.destroy(); return; }
      if (state.mode === 'down500') { res.writeHead(500).end(); return; }
      if (state.mode === 'busy503') { res.writeHead(503, { 'content-type': 'application/json' }).end('{"code":"DAILY_CAP"}'); return; }
      if (state.mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' }).end(); return; }
      const m = (req.url ?? '').match(/^\/api\/shares(?:\/([^/?]+))?$/);
      if (req.method === 'POST' && m && !m[1]) {
        // 본문이 틀린 항목 하나만 빼고 모두 올바르다 — 클라이언트의 각 검증이 따로 지켜지는지 변이로 확인하려고.
        if (state.mode === 'garbage' || state.mode === 'garbageDate') {
          const body = { id: String(req.headers['x-share-id']), expires_at: new Date(Date.now() + 86_400_000).toISOString(), replaced: false as unknown };
          if (state.mode === 'garbage') body.replaced = 'yes';
          else body.expires_at = 'not-a-date';
          res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(body));
          return;
        }
        // 교체 — 토큰이 틀리면 아무것도 만들지 않는다 (share/src/app.ts와 같은 규칙)
        const replaceId = req.headers['x-replace-id'] as string | undefined;
        let replaced = false;
        if (replaceId !== undefined) {
          const old = state.objects.get(replaceId);
          if (old && req.headers['x-replace-token'] !== old.token) { res.writeHead(403).end('{"code":"BAD_TOKEN"}'); return; }
          replaced = old !== undefined;
        }
        // id·토큰은 be가 보낸다 (share/src/app.ts와 같은 계약). 같은 id·토큰 재전송은 멱등 200.
        const days = String(req.headers['x-share-days']);
        const id = String(req.headers['x-share-id']);
        const token = String(req.headers['x-delete-token']);
        const existing = state.objects.get(id);
        if (existing) {
          if (existing.token !== token) { res.writeHead(409).end('{"code":"ID_TAKEN"}'); return; }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id, expires_at: existing.expires_at, replaced: false }));
          return;
        }
        n++;
        const expires_at = new Date(Date.now() + Number(days) * 86_400_000).toISOString();
        state.objects.set(id, { body: Buffer.concat(chunks), token, expires_at });
        if (replaced) state.objects.delete(replaceId!);
        if (state.mode === 'storeThenDrop') { req.socket.destroy(); return; }
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id, expires_at, replaced }));
        return;
      }
      if (req.method === 'DELETE' && m?.[1]) {
        const o = state.objects.get(m[1]);
        if (!o) { res.writeHead(404).end(); return; }
        if (req.headers.authorization !== `Bearer ${o.token}`) { res.writeHead(403).end(); return; }
        state.objects.delete(m[1]);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    nextUpload: () => new Promise<void>((resolve) => uploadWaiters.push(resolve)),
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  });
}
