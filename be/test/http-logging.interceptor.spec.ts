import { CallHandler, ExecutionContext, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { HttpLoggingInterceptor } from '../src/common/http-logging.interceptor';

function httpContext(method: string, path: string, statusCode: number): ExecutionContext {
  const req = { method, path };
  const res = { statusCode };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

describe('HttpLoggingInterceptor', () => {
  const interceptor = new HttpLoggingInterceptor();
  let log: jest.SpyInstance, warn: jest.SpyInstance, error: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs method, path (no query) and status on success', async () => {
    const ctx = httpContext('GET', '/meetings', 200);
    const handler: CallHandler = { handle: () => of({ ok: true }) };
    await lastValueFrom(interceptor.intercept(ctx, handler));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/^GET \/meetings 200 \d+ms$/);
  });

  it('logs 4xx as warn and re-throws (does not swallow the error)', async () => {
    const ctx = httpContext('POST', '/meetings', 200);
    const err = new HttpException('bad', HttpStatus.BAD_REQUEST);
    const handler: CallHandler = { handle: () => throwError(() => err) };
    await expect(lastValueFrom(interceptor.intercept(ctx, handler))).rejects.toBe(err);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^POST \/meetings 400 \d+ms — bad$/);
    expect(error).not.toHaveBeenCalled();
  });

  it('logs a non-HttpException as 500 error and re-throws', async () => {
    const ctx = httpContext('GET', '/search', 200);
    const err = new Error('boom');
    const handler: CallHandler = { handle: () => throwError(() => err) };
    await expect(lastValueFrom(interceptor.intercept(ctx, handler))).rejects.toBe(err);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatch(/^GET \/search 500 \d+ms — boom$/);
  });
});
