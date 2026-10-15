import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { buildAccessPolicy } from '../src/access/access-policy';
import { accessControl } from '../src/access/access-control.middleware';

const DEV = 'http://localhost:5173';
const policy = buildAccessPolicy(DEV, '');

interface Fake { status: number | null; headers: Record<string, string[]>; nexted: boolean }
function run(mw: ReturnType<typeof accessControl>, method: string, path: string, headers: Record<string, string>): Fake {
  const out: Fake = { status: null, headers: {}, nexted: false };
  const add = (k: string, v: string) => { (out.headers[k.toLowerCase()] ??= []).push(v); };
  const res = {
    setHeader: (k: string, v: string) => { out.headers[k.toLowerCase()] = [v]; },
    append: add,
    status(c: number) { out.status = c; return res; },
    json() { return res; },
    end() { return res; },
  } as unknown as Response;
  mw({ method, path, headers } as unknown as Request, res, () => { out.nexted = true; });
  return out;
}

describe('accessControl 경고 로그 (F2)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); });
  afterEach(() => warn.mockRestore());

  it('처음 거부된 Origin만 한 번 남기고, 메시지에 ALLOWED_ORIGINS가 들어 있다', () => {
    const mw = accessControl(policy);
    const h = { host: '127.0.0.1:3000', origin: 'https://evil.example' };
    expect(run(mw, 'GET', '/api/meetings', h).status).toBe(403);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('ALLOWED_ORIGINS');
    expect((warn.mock.instances[0] as unknown as { context: string }).context).toBe('AccessControl');
    run(mw, 'GET', '/api/meetings', h);
    expect(warn).toHaveBeenCalledTimes(1);
    run(mw, 'GET', '/api/meetings', { ...h, origin: 'https://other.example' });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('처음 거부된 Host도 한 번만 남기고 ALLOWED_HOSTS를 말한다', () => {
    const mw = accessControl(policy);
    run(mw, 'GET', '/api/health', { host: 'attacker.example' });
    run(mw, 'GET', '/api/health', { host: 'attacker.example' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('ALLOWED_HOSTS');
    run(mw, 'GET', '/api/health', { host: 'second.example' });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('허용된 요청은 남기지 않는다', () => {
    const mw = accessControl(policy);
    run(mw, 'GET', '/api/meetings', { host: '127.0.0.1:3000', origin: DEV });
    run(mw, 'GET', '/api/meetings', { host: '127.0.0.1:3000' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('기억하는 항목은 100개로 막혀 메모리가 자라지 않는다 — 한도 밖 항목은 반복해도 남긴다', () => {
    const mw = accessControl(policy);
    for (let i = 0; i < 100; i++) run(mw, 'GET', '/api/meetings', { host: '127.0.0.1:3000', origin: `https://e${i}.example` });
    expect(warn).toHaveBeenCalledTimes(100);
    run(mw, 'GET', '/api/meetings', { host: '127.0.0.1:3000', origin: 'https://over.example' });
    run(mw, 'GET', '/api/meetings', { host: '127.0.0.1:3000', origin: 'https://over.example' });
    expect(warn).toHaveBeenCalledTimes(100);   // 한도 뒤에는 새 항목을 로그하지도 기억하지도 않는다
  });
});

describe('accessControl Vary: Origin (F3)', () => {
  it('ALLOWED_ORIGINS가 있으면 게이트 경로의 모든 응답에 Vary: Origin — 403·Origin 없는 200 포함', () => {
    const mw = accessControl(policy);
    const bad = run(mw, 'GET', '/api/meetings', { host: '127.0.0.1:3000', origin: 'https://evil.example' });
    expect(bad.status).toBe(403);
    expect(bad.headers['vary']).toContain('Origin');
    const plain = run(mw, 'GET', '/api/meetings', { host: '127.0.0.1:3000' });
    expect(plain.nexted).toBe(true);
    expect(plain.headers['vary']).toContain('Origin');
    const ok = run(mw, 'GET', '/api/meetings', { host: '127.0.0.1:3000', origin: DEV });
    expect(ok.headers['vary']).toEqual(['Origin']);   // 중복으로 붙지 않는다
  });
  it('게이트 밖 경로(SPA GET)와 ALLOWED_ORIGINS가 빈 정책에는 붙이지 않는다', () => {
    expect(run(accessControl(policy), 'GET', '/', { host: '127.0.0.1:3000' }).headers['vary']).toBeUndefined();
    const empty = accessControl(buildAccessPolicy('', ''));
    expect(run(empty, 'GET', '/api/meetings', { host: '127.0.0.1:3000' }).headers['vary']).toBeUndefined();
  });
});
