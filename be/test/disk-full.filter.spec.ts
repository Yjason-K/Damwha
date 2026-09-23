import { ArgumentsHost, NotFoundException } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiskFullFilter } from '../src/storage/disk-full.filter';
import { UPLOAD_TEMP_FILENAME_KEY } from '../src/storage/upload-options';

// @nestjs/common 10.4.x의 HttpStatus enum에는 507(INSUFFICIENT_STORAGE)이 없다
// (이 패키지의 enums/http-status.enum.d.ts를 확인). 필터 쪽도 같은 이유로 숫자 리터럴을 쓴다.
const INSUFFICIENT_STORAGE = 507;

// req는 정리 로직(tempFileOf)이 읽는 요청 스코프 값을 흉내낸다 — 기본은 빈 객체
// (=업로드 경로가 아닌 요청, 심어 둔 파일명이 없다).
function hostWith(req: Record<string, unknown> = {}): { host: ArgumentsHost; sent: { status?: number; body?: unknown } } {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) { sent.status = code; return this; },
    json(body: unknown) { sent.body = body; return this; },
  };
  // BaseExceptionFilter.catch()는 switchToHttp().getResponse()가 아니라
  // getArgByIndex(1)로 응답 객체를 얻는다 (@nestjs/core 10.4.x 실제 구현 확인).
  // 델리게이션을 실제로 도는 테스트(HttpException 케이스)를 위해 둘 다 채운다.
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
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
    // 리뷰 라운드 1(Important 2): code만 보면 Task 9가 기대는 needed===null 계약이
    // CI로 안 잡힌다 — 응답 바디 전체 모양을 고정한다.
    expect(sent.body).toEqual({ code: 'DISK_FULL', free: expect.any(Number), needed: null });
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

  // 리뷰 라운드 1(Important 1, Ruling R15): 브리프의 tempFileOf(exception)는 exception.path를
  // 봤는데, 2MB HFS+ 이미지로 재현한 실제 ENOSPC 에러는 {errno, code, syscall}만 들고
  // .path가 없어(open()류 에러에만 붙는다) 정리가 절대 안 도는 죽은 코드였다. multer의
  // filename 콜백이 쓰기 시작 전에 req[UPLOAD_TEMP_FILENAME_KEY]에 파일명을 심어 두는
  // 방식으로 고쳤다 — 이 테스트가 그 경로를 고정한다. 살아있는 서버 + 가득 찬 디스크
  // 장치로도 재확인했다(task-8-report.md fix report 참고).
  it('예외의 .path가 아니라 요청에 심어 둔 파일명으로 임시 파일을 지운다', () => {
    const filename = `dw-upload-${process.pid}-${Date.now()}`;
    const filepath = path.join(os.tmpdir(), filename);
    fs.writeFileSync(filepath, 'partial upload bytes');
    const { host, sent } = hostWith({ [UPLOAD_TEMP_FILENAME_KEY]: filename });
    // 실제 ENOSPC 에러 모양 그대로 — .path가 없다.
    const err = Object.assign(new Error('ENOSPC: no space left on device, write'), {
      errno: -28,
      code: 'ENOSPC',
      syscall: 'write',
    });
    expect(fs.existsSync(filepath)).toBe(true);
    new DiskFullFilter().catch(err, host);
    expect(fs.existsSync(filepath)).toBe(false);
    expect(sent.status).toBe(INSUFFICIENT_STORAGE);
  });

  it('요청에 심어 둔 파일명이 없으면 정리를 건너뛴다 (예: 실패가 업로드 경로 밖에서 났을 때)', () => {
    const { host, sent } = hostWith(); // 기본값: req에 UPLOAD_TEMP_FILENAME_KEY 없음
    const err = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    expect(() => new DiskFullFilter().catch(err, host)).not.toThrow();
    expect(sent.status).toBe(INSUFFICIENT_STORAGE);
  });

  it('요청에 심어 둔 파일만 지우고, tmpdir의 다른 파일은 건드리지 않는다', () => {
    const ownName = `dw-upload-${process.pid}-${Date.now()}-own`;
    const otherName = `dw-upload-${process.pid}-${Date.now()}-other`;
    const ownPath = path.join(os.tmpdir(), ownName);
    const otherPath = path.join(os.tmpdir(), otherName);
    fs.writeFileSync(ownPath, '이 요청의 부분 업로드');
    fs.writeFileSync(otherPath, '다른 요청의 파일 — 지워지면 안 된다');
    try {
      const { host } = hostWith({ [UPLOAD_TEMP_FILENAME_KEY]: ownName });
      const err = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      new DiskFullFilter().catch(err, host);
      expect(fs.existsSync(ownPath)).toBe(false);
      expect(fs.existsSync(otherPath)).toBe(true);
    } finally {
      fs.rmSync(otherPath, { force: true });
    }
  });
});
