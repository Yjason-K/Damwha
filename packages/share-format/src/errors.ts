export type ShareFormatErrorCode = 'bad_key' | 'bad_envelope' | 'unsupported_version' | 'bad_payload';

/** 복호화 실패의 종류. 뷰어는 code로 안내 문구를 고르고, 메시지는 개발자용이다. */
export class ShareFormatError extends Error {
  readonly code: ShareFormatErrorCode;
  constructor(code: ShareFormatErrorCode, message: string) {
    super(message);
    this.name = 'ShareFormatError';
    this.code = code;
  }
}
