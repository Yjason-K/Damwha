import { createHash, timingSafeEqual } from 'node:crypto';
import { isShareDurationDays } from '@damwha/contracts';
import { DELETE_TOKEN_RE, SHARE_ID_RE, SHARE_MAX_ENVELOPE_BYTES, shareIdDays } from '@damwha/share-format';
import { readLimited } from './body.js';
import type { ShareConfig } from './config.js';
import { json, withSecurityHeaders } from './http.js';
import { DailyBudget, WindowLimiter } from './limits.js';
import type { DiskStore } from './store.js';

export interface AppDeps {
  store: DiskStore;
  config: ShareConfig;
  now: () => Date;
  /** 뷰어 빌드 산출물(dist/viewer). Task 6 전까지 null. */
  viewerDir: string | null;
  /** 한 줄 로그. 메서드·경로·상태만 — 본문과 Authorization·교체 토큰은 넘기지 않는다. */
  log?: (line: string) => void;
}
export interface RequestInfo {
  ip: string;
}

const DAY_MS = 86_400_000;
const API = /^\/api\/shares(?:\/([^/]+))?\/?$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createApp(deps: AppDeps) {
  const { store, config } = deps;
  const limiters = {
    upload: new WindowLimiter(config.limits.upload),
    read: new WindowLimiter(config.limits.read),
    delete: new WindowLimiter(config.limits.delete),
  };
  const daily = new DailyBudget(config.dailyMaxUploads, config.dailyMaxBytes);
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

  /** 개발용 만료 단축은 로컬 Host에서만 — Tunnel을 거친 요청의 Host는 공개 도메인이다. production은 readConfig가 이미 null로 둔다. */
  function ttlMs(req: Request, days: number): number {
    if (config.devExpirySeconds !== null && LOCAL_HOSTS.has(new URL(req.url).hostname)) return config.devExpirySeconds * 1000;
    return days * DAY_MS;
  }

  /** 같은 기존 링크의 교체는 하나씩 — 같은 토큰으로 동시에 통과한 두 요청이 새 링크 둘을 남기지 않게 한다. */
  const replacing = new Set<string>();

  async function create(req: Request, now: Date): Promise<Response> {
    if (!config.uploadsEnabled) return json(503, { code: 'UPLOADS_DISABLED' });
    const days = Number(req.headers.get('X-Share-Days'));
    if (!isShareDurationDays(days)) return json(400, { code: 'BAD_DURATION' });
    // id·토큰은 be가 만든다(spec selfhost-v2 §2.4) — be가 업로드 전에 저장해 두므로 응답을 잃어도 철회할 수 있다.
    const id = req.headers.get('X-Share-Id') ?? '';
    const deleteToken = req.headers.get('X-Delete-Token') ?? '';
    if (!SHARE_ID_RE.test(id) || shareIdDays(id) !== days || !DELETE_TOKEN_RE.test(deleteToken)) {
      return json(400, { code: 'BAD_ID' });
    }
    const existing = await store.head(id);
    if (existing) {
      // 같은 id·토큰의 재시도(응답을 잃은 be)는 이미 된 일이다. 토큰이 다르면 남의 id다.
      if (sameHash(sha256(deleteToken), existing.token_hash)) {
        return json(200, { id, expires_at: existing.expires_at, replaced: false });
      }
      return json(409, { code: 'ID_TAKEN' });
    }

    const replaceId = req.headers.get('X-Replace-Id');
    if (replaceId === null) return save(req, now, { id, deleteToken, days, replaceId: null });
    const replaceToken = req.headers.get('X-Replace-Token') ?? '';
    if (!SHARE_ID_RE.test(replaceId) || replaceToken === '') return json(400, { code: 'BAD_REPLACE' });
    // 확인과 등록 사이에 await가 없다 — 프로세스 하나에서 원자적이다.
    if (replacing.has(replaceId)) return json(409, { code: 'REPLACE_IN_PROGRESS' });
    replacing.add(replaceId);
    try {
      // 기존 공유의 토큰이 맞는지 **먼저** 본다 — 틀리면 아무것도 만들지 않는다.
      const old = await store.head(replaceId);
      if (old && !sameHash(sha256(replaceToken), old.token_hash)) return json(403, { code: 'BAD_TOKEN' });
      return await save(req, now, { id, deleteToken, days, replaceId: old ? replaceId : null });
    } finally {
      replacing.delete(replaceId);
    }
  }

  async function save(
    req: Request,
    now: Date,
    a: { id: string; deleteToken: string; days: number; replaceId: string | null },
  ): Promise<Response> {
    const body = await readLimited(req, SHARE_MAX_ENVELOPE_BYTES);
    if (body === 'too_large') return json(413, { code: 'TOO_LARGE' });
    if (body.byteLength === 0) return json(400, { code: 'EMPTY' });

    const ticket = daily.reserve(body.byteLength, now);
    if (!ticket) return json(503, { code: 'DAILY_CAP' });

    const expiresAt = new Date(now.getTime() + ttlMs(req, a.days)).toISOString();
    try {
      await store.put(a.id, body, { expires_at: expiresAt, token_hash: sha256(a.deleteToken), size: body.byteLength, created_at: now.toISOString() });
    } catch (e) {
      daily.release(ticket);
      throw e;
    }
    if (a.replaceId !== null) {
      try {
        await store.delete(a.replaceId);
      } catch (e) {
        // 기존 공유를 못 지웠으면 새 공유도 남기지 않는다. 이때 기존 링크도 이미 막혔을 수 있다 —
        // 메타를 먼저 지우기 때문이다. 실패는 "닫히는 쪽"이다(spec selfhost-v2 §2.4).
        await store.delete(a.id).catch(() => undefined);
        daily.release(ticket);
        throw e;
      }
    }
    return json(201, { id: a.id, expires_at: expiresAt, replaced: a.replaceId !== null });
  }

  async function read(id: string, now: Date): Promise<Response> {
    if (!SHARE_ID_RE.test(id)) return json(404, { code: 'NOT_FOUND' });
    const found = await store.get(id);
    if (!found || Date.parse(found.meta.expires_at) <= now.getTime()) return json(410, { code: 'GONE' });
    return new Response(found.body, {
      headers: { 'Content-Type': 'application/octet-stream', 'X-Share-Expires-At': found.meta.expires_at },
    });
  }

  async function remove(req: Request, id: string): Promise<Response> {
    if (!SHARE_ID_RE.test(id)) return json(404, { code: 'NOT_FOUND' });
    const meta = await store.head(id);
    if (!meta) return json(404, { code: 'NOT_FOUND' });
    const auth = req.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    if (!token || !sameHash(sha256(token), meta.token_hash)) return json(403, { code: 'BAD_TOKEN' });
    await store.delete(id);
    return new Response(null, { status: 204 });
  }

  async function route(req: Request, info: RequestInfo, now: Date): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/healthz' && req.method === 'GET') return json(200, { ok: true });
    const m = url.pathname.match(API);
    if (m) {
      const id = m[1];
      const t = now.getTime();
      if (id === undefined && req.method === 'POST') {
        return limiters.upload.allow(info.ip, t) ? create(req, now) : json(429, { code: 'RATE_LIMITED' });
      }
      if (id !== undefined && req.method === 'GET') {
        return limiters.read.allow(info.ip, t) ? read(id, now) : json(429, { code: 'RATE_LIMITED' });
      }
      if (id !== undefined && req.method === 'DELETE') {
        // 삭제는 조회와 따로 센다 — 조회가 몰려도 "지금 중지"가 막히지 않는다.
        return limiters.delete.allow(info.ip, t) ? remove(req, id) : json(429, { code: 'RATE_LIMITED' });
      }
      return json(405, { code: 'METHOD_NOT_ALLOWED' });
    }
    return json(404, { code: 'NOT_FOUND' });
  }

  return {
    async fetch(req: Request, info: RequestInfo): Promise<Response> {
      const now = deps.now();
      const path = new URL(req.url).pathname;
      let res: Response;
      try {
        res = await route(req, info, now);
      } catch (e) {
        deps.log?.(`error ${req.method} ${path}: ${(e as Error).name}`);
        res = json(500, { code: 'INTERNAL' });
      }
      deps.log?.(`${req.method} ${path} ${res.status}`);
      return withSecurityHeaders(res);
    },
  };
}
