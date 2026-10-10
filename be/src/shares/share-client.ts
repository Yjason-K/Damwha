import { SHARE_MAX_ENVELOPE_BYTES } from '@damwha/share-format';
import type { ShareDurationDays } from '@damwha/contracts';
import { parseShareApiUrl } from './share-api-url';

export type UploadOptions = {
  /** be가 만든 공유 id·삭제 토큰(newShareId·newDeleteToken). 업로드 전에 로컬 DB에 저장해 둔다. */
  id: string;
  deleteToken: string;
  days: ShareDurationDays;
  replace?: { id: string; token: string };
};
export type UploadResult = { expires_at: string; replaced: boolean };

/** 공유 서비스 호출 실패. 메시지에 키·삭제 토큰을 싣지 않는다 — 로그와 응답으로 흘러간다. */
export class ShareServiceError extends Error {
  readonly kind: 'unreachable' | 'rejected';
  readonly status: number | null;
  /**
   * 서버가 4xx로 답했거나, 요청이 아예 나가지 못했다(이름 풀이 실패·연결 거절 — {@link nothingWasSent}) = 객체를
   * 만들지 않았다. 연결 끊김·타임아웃·3xx·5xx는 false — 서버에 객체가 생겼을 수 있으니 호출부는 그 id를 철회
   * 대기열에 넣는다(spec selfhost-v2 §2.7 3단계).
   */
  readonly definitelyNotCreated: boolean;
  constructor(kind: 'unreachable' | 'rejected', status: number | null, message: string, notSent = false) {
    super(message);
    this.name = 'ShareServiceError';
    this.kind = kind;
    this.status = status;
    this.definitelyNotCreated = kind === 'unreachable'
      ? notSent
      : status !== null && status >= 400 && status < 500;
  }
}

/**
 * 요청이 서버에 닿지 않았음이 확실한 연결 실패 코드. 이름을 못 풀었거나(ENOTFOUND·EAI_AGAIN — 예: Tunnel 연결 전의
 * 기본 주소) TCP 연결 자체를 거절당했다(ECONNREFUSED). 연결이 된 뒤의 실패(ECONNRESET·소켓 끊김·타임아웃)는 서버가
 * 본문을 받아 저장했을 수 있어서 여기 넣지 않는다.
 */
const NOT_SENT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);

/**
 * fetch 실패가 "아무것도 보내지 못함"인가. undici는 `TypeError('fetch failed')`의 `cause`에 시스템 오류를 담는다.
 * 주소가 여럿이면(localhost → ::1, 127.0.0.1) `cause`가 AggregateError이고, 그때는 **모든** 시도가 거절이어야 한다.
 */
export function nothingWasSent(e: unknown): boolean {
  const cause = (e as { cause?: unknown } | null)?.cause;
  if (!cause || typeof cause !== 'object') return false;
  if (cause instanceof AggregateError) {
    return cause.errors.length > 0 && cause.errors.every((x) => NOT_SENT_CODES.has((x as { code?: unknown })?.code as string));
  }
  return NOT_SENT_CODES.has((cause as { code?: unknown }).code as string);
}

export class ShareTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`share envelope is ${bytes} bytes, over the ${SHARE_MAX_ENVELOPE_BYTES}-byte limit`);
    this.name = 'ShareTooLargeError';
  }
}

/**
 * be가 밖으로 보내는 첫 HTTP 요청 (spec §2.7). 리다이렉트를 따라가지 않고(`manual` — 3xx는 그대로 실패로 본다),
 * 요청마다 타임아웃을 건다. 들어오는 요청의 접근 제어(be/src/access)와는 무관하다(선행 결과 규칙 4).
 */
export class ShareClient {
  private readonly base: URL;
  constructor(baseUrl: string, private readonly timeoutMs = 10_000) {
    this.base = parseShareApiUrl(baseUrl);
  }

  /**
   * 업로드. `replace`를 주면 공유 서버가 같은 요청 안에서 기존 공유를 지운다(spec selfhost-v2 §2.4 교체) —
   * 응답이 오면 기존 링크는 이미 막혀 있다. 교체 토큰이 틀리면 서버는 아무것도 만들지 않고 403이다.
   */
  async upload(envelope: Uint8Array, o: UploadOptions): Promise<UploadResult> {
    if (envelope.byteLength > SHARE_MAX_ENVELOPE_BYTES) throw new ShareTooLargeError(envelope.byteLength);
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'X-Share-Days': String(o.days),
      'X-Share-Id': o.id,
      'X-Delete-Token': o.deleteToken,
    };
    if (o.replace) {
      headers['X-Replace-Id'] = o.replace.id;
      headers['X-Replace-Token'] = o.replace.token;
    }
    const res = await this.send('/api/shares', { method: 'POST', headers, body: envelope });
    // 201 = 새로 만듦, 200 = 같은 id·토큰의 재시도(이미 있음)
    if (res.status !== 201 && res.status !== 200) {
      throw new ShareServiceError('rejected', res.status, `share service answered ${res.status} to upload`);
    }
    const body = (await res.json().catch(() => null)) as { id?: unknown; expires_at?: unknown; replaced?: unknown } | null;
    if (
      !body ||
      body.id !== o.id ||
      typeof body.expires_at !== 'string' ||
      Number.isNaN(Date.parse(body.expires_at)) ||
      typeof body.replaced !== 'boolean'
    ) {
      throw new ShareServiceError('rejected', res.status, 'share service returned a malformed upload response');
    }
    return { expires_at: body.expires_at, replaced: body.replaced };
  }

  /** 'deleted'·'gone'(이미 없음) 둘 다 성공이다. */
  async remove(remoteId: string, deleteToken: string): Promise<'deleted' | 'gone'> {
    const res = await this.send(`/api/shares/${encodeURIComponent(remoteId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${deleteToken}` },
    });
    if (res.status === 204 || res.status === 200) return 'deleted';
    if (res.status === 404 || res.status === 410) return 'gone';
    throw new ShareServiceError('rejected', res.status, `share service answered ${res.status} to delete`);
  }

  linkFor(remoteId: string, key: string): string {
    return `${this.base.origin}/s/${remoteId}#${key}`;
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(new URL(path, this.base), { ...init, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      // 원인 이름만 남긴다 — undici의 오류 객체는 요청 헤더(Authorization)를 cause에 담을 수 있다.
      throw new ShareServiceError('unreachable', null, `share service unreachable (${(e as Error).name})`, nothingWasSent(e));
    }
  }
}
