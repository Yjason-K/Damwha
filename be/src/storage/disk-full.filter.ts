import { ArgumentsHost, Catch, Logger } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import * as fs from 'fs';
import * as os from 'os';

/**
 * 업로드 중 디스크가 찬 것(ENOSPC)을 507로 바꾼다 (Electron Phase 6a 스펙 §8.2).
 *
 * **왜 한 자리인가:** meetings.controller.ts와 speakers.controller.ts가 같은
 * uploadInterceptorOptions를 쓴다. multer는 컨트롤러 진입 **전에** os.tmpdir()에 쓰므로
 * 컨트롤러 안의 try/catch로는 잡히지 않고, 처리되지 않은 500(스택트레이스)이 나간다 —
 * Phase 5가 디스크가 실제로 찬 회차에서 그것을 관측했다.
 *
 * 이 시점에는 meeting·job 행이 아직 없다. 그래서 여기서 정리할 DB 상태도 없다 —
 * 지워야 할 것은 multer가 남긴 임시 파일뿐이다.
 *
 * **`BaseExceptionFilter`를 상속한다.** 이 앱에는 전역 예외 필터가 하나도 없어서(app.module.ts의
 * providers에 APP_FILTER가 없다) 이것이 유일한 필터가 된다. 필터 안에서 `throw`하면 Nest가
 * 그것을 **다시 처리하지 않는다** — ENOSPC가 아닌 모든 오류의 응답이 사라진다. 기본 동작은
 * `super.catch()`로 넘겨야 보존된다.
 *
 * **507을 숫자 리터럴로 쓴다.** 설치된 @nestjs/common(10.4.x)의 `HttpStatus` enum에
 * `INSUFFICIENT_STORAGE`가 없다 (enums/http-status.enum.d.ts 확인 — 505까지만 있다).
 *
 * **생성자가 `HttpAdapterHost` 그 자체를 받아 `this.httpAdapterHost`에 저장한다 —
 * `.httpAdapter` 값을 미리 꺼내 저장하지 않는다.** `app.module.ts`의 `useFactory`는
 * `NestFactory.create()`(운영)에서는 문제없이 동작하지만, 이 프로젝트의 모든 e2e
 * 스펙이 쓰는 `Test.createTestingModule({...}).compile()`은 다르다 — `compile()`
 * 안에서 프로바이더(이 팩토리 포함)가 먼저 만들어지고, `container.setHttpAdapter(...)`는
 * 그 뒤 `TestingModule.createNestApplication()`이 불릴 때에야 실행된다
 * (`@nestjs/testing`의 `testing-module.builder.js`/`testing-module.js` 확인). 그래서
 * 생성 시점에 `host.httpAdapter`를 한 번 읽어 저장하면 **영원히 `undefined`가 찍힌다** —
 * `meetings.e2e-spec.ts`로 실측: 이 필터를 그렇게 구현한 채 붙이면 ENOSPC가 아닌
 * 예외(예: 404 테스트)가 `super.catch()`로 위임될 때 `applicationRef`가 `undefined`라
 * `applicationRef.isHeadersSent(...)`에서 죽고, 그 예외가 응답을 내보내는 코드 경로
 * 안에서 나서 응답이 영영 안 나간다 — supertest는 응답을 무한정 기다리고, 스위트
 * 전체가 멈춘 것처럼 보인다(브리프가 준 컨트롤러 목록의 모든 e2e 스펙이 한 번쯤은
 * 404/400 같은 비-ENOSPC 예외를 던진다). `HttpAdapterHost` 인스턴스 자체를 들고 있으면
 * `catch()` 시점에 `this.httpAdapterHost.httpAdapter`를 그때그때 다시 읽으므로,
 * `createNestApplication()`이 나중에 그 값을 채워도 반영된다 — 운영·테스트 양쪽 다
 * 안전하다. `BaseExceptionFilter.httpAdapterHost`는 `.d.ts`에서 `readonly`이지만
 * 런타임에는 그냥 평범한 필드라 여기서 대입해도 안전하다(타입만 캐스트로 피한다).
 */
const INSUFFICIENT_STORAGE = 507;

@Catch()
export class DiskFullFilter extends BaseExceptionFilter {
  private readonly log = new Logger(DiskFullFilter.name);

  constructor(adapterHost?: HttpAdapterHost) {
    super();
    if (adapterHost) {
      (this as unknown as { httpAdapterHost: HttpAdapterHost }).httpAdapterHost = adapterHost;
    }
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (!isNoSpace(exception)) {
      // 우리 것이 아니면 Nest 기본 처리로. 여기서 throw하면 응답이 아예 나가지 않는다.
      super.catch(exception, host);
      return;
    }

    // multer가 반쯤 쓴 임시 파일을 지운다. 디스크가 찬 판에 남겨 두면 다음 시도도 진다.
    const file = tempFileOf(exception);
    if (file !== null) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        this.log.warn('임시 파일을 지우지 못했다');
      }
    }

    const free = freeBytes(os.tmpdir());
    this.log.error(`업로드 중 디스크가 찼다 — 남은 용량 ${free} 바이트`);

    // 원본 메시지를 싣지 않는다 — 경로와 스택이 담긴다.
    host.switchToHttp().getResponse().status(INSUFFICIENT_STORAGE).json({
      code: 'DISK_FULL',
      free,
      // 업로드 시점에는 "필요한 용량"을 모른다. 화면은 free만 말한다.
      needed: null,
    });
  }
}

/** code가 예외 자신에도, cause에도 있을 수 있다 — multer는 감싸서 던진다. */
function isNoSpace(e: unknown): boolean {
  const code = (v: unknown): string | null =>
    v !== null && typeof v === 'object' && typeof (v as { code?: unknown }).code === 'string'
      ? ((v as { code: string }).code)
      : null;
  if (e === null || typeof e !== 'object') return false;
  return code(e) === 'ENOSPC' || code((e as { cause?: unknown }).cause) === 'ENOSPC';
}

function tempFileOf(e: unknown): string | null {
  if (e === null || typeof e !== 'object') return null;
  const p = (e as { path?: unknown }).path;
  return typeof p === 'string' && p.includes('dw-upload-') ? p : null;
}

function freeBytes(dir: string): number {
  try {
    return Number(fs.statfsSync(dir).bavail) * Number(fs.statfsSync(dir).bsize);
  } catch {
    return -1;
  }
}
