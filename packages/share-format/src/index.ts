/**
 * 공유 봉투와 페이로드의 단일 원본 (spec 2026-10-09 §2.2·§2.3). be가 암호화하고 공유 뷰어가 복호화한다 —
 * 두 쪽이 손으로 같은 포맷을 맞추면 @damwha/contracts가 생긴 이유(양쪽 사본이 어긋남)를 되풀이한다.
 * Node 22·브라우저·workerd 모두에서 돌도록 전역 WebCrypto·CompressionStream만 쓴다.
 */
export * from './errors.js';
export * from './base64url.js';
export * from './constants.js';
export * from './payload.js';
export * from './envelope.js';
