import { ArgumentsHost, NotFoundException } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { DiskFullFilter } from '../src/storage/disk-full.filter';

// @nestjs/common 10.4.x의 HttpStatus enum에는 507(INSUFFICIENT_STORAGE)이 없다
// (이 패키지의 enums/http-status.enum.d.ts를 확인). 필터 쪽도 같은 이유로 숫자 리터럴을 쓴다.
const INSUFFICIENT_STORAGE = 507;

function hostWith(): { host: ArgumentsHost; sent: { status?: number; body?: unknown } } {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) { sent.status = code; return this; },
    json(body: unknown) { sent.body = body; return this; },
  };
  // BaseExceptionFilter.catch()는 switchToHttp().getResponse()가 아니라
  // getArgByIndex(1)로 응답 객체를 얻는다 (@nestjs/core 10.4.x 실제 구현 확인).
  // 델리게이션을 실제로 도는 테스트(HttpException 케이스)를 위해 둘 다 채운다.
  const host = {
    switchToHttp: () => ({ getResponse: () => res }),
    getArgByIndex: (i: number) => (i === 1 ? res : undefined),
  } as unknown as ArgumentsHost;
  return { host, sent };
}

// BaseExceptionFilter.catch()는 (di로 주입되는 실제 ExpressAdapter 대신) 생성자로 받은
// applicationRef의 isHeadersSent/reply를 부른다. `new HttpAdapterHost().httpAdapter`는
// DI 없이 생성하면 항상 undefined이므로, 위임이 실제로 끝까지 도는 것을 보려면
// 그 두 메서드만 가진 가벼운 대역이 필요하다.
const fakeHttpAdapter = {
  isHeadersSent: () => false,
  reply: (response: { status: (c: number) => { json: (b: unknown) => void } }, body: unknown, statusCode: number) => {
    response.status(statusCode).json(body);
  },
  end: () => undefined,
};

describe('DiskFullFilter', () => {
  it('ENOSPC를 507과 DISK_FULL 코드로 바꾼다', () => {
    const { host, sent } = hostWith();
    const err = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    new DiskFullFilter().catch(err, host);
    expect(sent.status).toBe(INSUFFICIENT_STORAGE);
    expect((sent.body as { code: string }).code).toBe('DISK_FULL');
  });

  it('multer가 감싼 ENOSPC도 잡는다 — code가 cause에 있다', () => {
    const { host, sent } = hostWith();
    const inner = Object.assign(new Error('no space'), { code: 'ENOSPC' });
    const err = Object.assign(new Error('upload failed'), { cause: inner });
    new DiskFullFilter().catch(err, host);
    expect(sent.status).toBe(INSUFFICIENT_STORAGE);
  });

  it('스택트레이스를 응답에 싣지 않는다', () => {
    const { host, sent } = hostWith();
    const err = Object.assign(new Error('ENOSPC: /var/folders/xyz/dw-upload-abc'), { code: 'ENOSPC' });
    new DiskFullFilter().catch(err, host);
    expect(JSON.stringify(sent.body)).not.toContain('/var/folders');
  });

  it('ENOSPC가 아닌 오류는 기본 처리로 넘긴다 — 다시 던지면 응답이 없다', () => {
    const { host } = hostWith();
    const err = Object.assign(new Error('boom'), { code: 'EACCES' });
    const filter = new DiskFullFilter(new HttpAdapterHost());
    const spy = jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(filter)), 'catch').mockImplementation(() => undefined);
    filter.catch(err, host);
    expect(spy).toHaveBeenCalledWith(err, host);
    spy.mockRestore();
  });

  it('HttpException의 상태 코드가 보존된다', () => {
    const { host, sent } = hostWith();
    const adapterHost = new HttpAdapterHost();
    adapterHost.httpAdapter = fakeHttpAdapter as never;
    const filter = new DiskFullFilter(adapterHost);
    // BaseExceptionFilter에 위임하면 404가 404로 나간다. 다시 던졌다면 응답이 아예 없다.
    expect(() => filter.catch(new NotFoundException('없어요'), host)).not.toThrow();
    expect(sent.status === undefined || sent.status === 404).toBe(true);
  });

  // 회귀 고정: Test.createTestingModule({...}).compile()은 프로바이더(이 필터 포함)를
  // 먼저 만들고, container.setHttpAdapter(...)는 그 뒤 TestingModule.createNestApplication()
  // 호출 시점에야 실행된다(@nestjs/testing의 testing-module.builder.js/testing-module.js
  // 확인) — 이 프로젝트의 모든 e2e 스펙이 그 순서를 쓴다. 그래서 필터가 생성자에서
  // `host.httpAdapter` 값을 미리 꺼내 저장하면(고친 버그) 그 값은 영원히 undefined로
  // 굳고, ENOSPC가 아닌 예외가 위임될 때마다 `applicationRef.isHeadersSent`에서
  // 죽어 응답이 안 나간다 — 처음 구현에서 이 때문에 meetings.e2e-spec.ts가 무한정
  // 멈췄다(같은 커밋에서 필터를 빼면 8.7초에 41/41 통과, 필터를 넣으면 응답이 영영
  // 안 와 jest가 멈춘 것처럼 보임). 이 테스트는 생성자 호출 **뒤에** httpAdapter를
  // 붙여도(=compile() 뒤 createNestApplication() 순서) 위임이 되는지를 고정한다.
  it('생성자 시점엔 httpAdapter가 없다가 나중에 채워져도 위임이 된다 (TestingModule.compile() 순서)', () => {
    const { host, sent } = hostWith();
    const adapterHost = new HttpAdapterHost(); // 아직 httpAdapter 없음 — compile() 직후 상태
    const filter = new DiskFullFilter(adapterHost); // 이 시점 this.httpAdapterHost.httpAdapter === undefined
    adapterHost.httpAdapter = fakeHttpAdapter as never; // createNestApplication()이 나중에 채운다
    expect(() => filter.catch(new NotFoundException('없어요'), host)).not.toThrow();
    expect(sent.status === undefined || sent.status === 404).toBe(true);
  });
});
