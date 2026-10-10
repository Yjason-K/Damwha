import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { DiskStore } from './store.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = readConfig(process.env);
const store = new DiskStore(config.dataDir);
await store.init();

// tsx(src/main.ts)로 돌면 share/dist/viewer, Docker는 VIEWER_DIR로 넘긴다.
const viewerDir = process.env.VIEWER_DIR ?? fileURLToPath(new URL('../dist/viewer', import.meta.url));
const app = createApp({
  store,
  config,
  now: () => new Date(),
  viewerDir: existsSync(viewerDir) ? viewerDir : null,
  log: (line) => console.log(line),
});

const sweep = () =>
  store
    .sweep(new Date())
    .then((n) => { if (n > 0) console.log(`sweep removed ${n}`); })
    .catch((e: Error) => console.error(`sweep failed: ${e.name}`));
await sweep();
setInterval(sweep, 10 * 60_000).unref();

/**
 * 클라이언트 IP는 Tunnel이 붙이는 CF-Connecting-IP. 이 헤더를 믿을 수 있는 건 포트가 Tunnel에만 열려 있어서다
 * (spec selfhost-v2 §2.4) — 포트를 바깥에 열면 누구나 위조할 수 있다. 로컬 실행은 소켓 주소로 센다.
 */
serve({
  port: config.port,
  hostname: config.host,
  // env 타입은 추론에 맡긴다 — 콜백은 HttpBindings | Http2Bindings를 받는다(둘 다 incoming이 있다).
  fetch: (req, env) =>
    app.fetch(req, { ip: req.headers.get('CF-Connecting-IP') ?? env.incoming.socket.remoteAddress ?? 'unknown' }),
});
console.log(`damwha-share listening on ${config.host}:${config.port} (data ${config.dataDir})`);
