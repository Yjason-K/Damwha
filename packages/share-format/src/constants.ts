import type { ShareDurationDays } from '@damwha/contracts';
import { toBase64Url } from './base64url.js';

/** 봉투(압축·암호화 뒤) 상한. be는 업로드 전에, 공유 서버는 본문을 읽으면서 강제한다. */
export const SHARE_MAX_ENVELOPE_BYTES = 5 * 1024 * 1024;

/**
 * `<기간>-<22자 base64url>`. 22자는 16바이트(128비트) 난수다. 공유 서버는 이 정규식을 통과한 id만 파일 이름으로
 * 쓴다 — 경로 탈출 문자가 들어갈 자리가 없다. 기간을 앞에 두면 로그·디렉터리에서 한눈에 보인다.
 */
export const SHARE_ID_RE = /^(1|7|30)-[A-Za-z0-9_-]{22}$/;

export function shareIdDays(id: string): ShareDurationDays {
  return Number(id.slice(0, id.indexOf('-'))) as ShareDurationDays;
}

/** 삭제 토큰 = 32바이트 난수의 base64url(43자). 공유 서버는 SHA-256 해시만 저장한다. */
export const DELETE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * 공유 id·삭제 토큰은 **be가 만든다**(spec selfhost-v2 §2.4). 업로드 전에 로컬 DB에 저장해 두면, 응답이 유실되거나
 * 확정이 실패해도 be가 그 토큰으로 서버 객체를 지울 수 있다 — 서버에 주인 없는 객체가 남지 않는다.
 */
export function newShareId(days: ShareDurationDays): string {
  return `${days}-${toBase64Url(crypto.getRandomValues(new Uint8Array(16)))}`;
}

export function newDeleteToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
