/** API가 비-2xx로 답했다. Nest 오류 본문의 message·code를 그대로 싣는다. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** 잘못된 인자. 종료 코드 1. allowed가 있으면 허용 값을 안내에 쓴다. */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly option?: string,
    readonly allowed?: readonly string[],
  ) {
    super(message);
    this.name = 'UsageError';
  }
}

/** 앱이 꺼져 있거나 준비 중이다. 종료 코드 2. */
export class NotConnectedError extends Error {
  constructor(readonly kind: 'not_running' | 'starting') {
    super(kind);
    this.name = 'NotConnectedError';
  }
}
