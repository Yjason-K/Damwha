import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { Request, Response } from 'express';

// 요청당 한 줄: METHOD path status duration. 에러도 여기서 로깅하되 다시 throw하여
// 응답 형식은 Nest 기본 예외 처리에 맡긴다(응답 바디를 바꾸지 않음).
// 프라이버시: querystring은 검색어 등 본문을 담을 수 있으므로 req.path만 기록(쿼리 제외).
@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const { method } = req;
    const path = req.path;
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.log(`${method} ${path} ${res.statusCode} ${Date.now() - start}ms`);
        },
        error: (err: unknown) => {
          const ms = Date.now() - start;
          const status =
            typeof (err as { getStatus?: () => number })?.getStatus === 'function'
              ? (err as { getStatus: () => number }).getStatus()
              : 500;
          const msg = (err as { message?: string })?.message ?? 'error';
          const line = `${method} ${path} ${status} ${ms}ms — ${msg}`;
          if (status >= 500) this.logger.error(line);
          else this.logger.warn(line);
        },
      }),
    );
  }
}
