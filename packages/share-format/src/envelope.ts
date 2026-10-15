import { fromBase64Url, toBase64Url } from './base64url.js';
import { ShareFormatError } from './errors.js';
import { isSharePayloadV1, type SharePayloadV1 } from './payload.js';

export const SHARE_FORMAT_VERSION = 1;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;

/** 공유마다 새 키. 서버·레포·env에 두지 않는다 — 링크의 `#` 뒤와 로컬 DB에만 있다. */
export function generateShareKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64Url(keyB64);
  } catch {
    throw new ShareFormatError('bad_key', 'key is not base64url');
  }
  if (raw.length !== KEY_BYTES) throw new ShareFormatError('bad_key', `key must be ${KEY_BYTES} bytes`);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function through(bytes: Uint8Array<ArrayBuffer>, t: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(t);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 봉투 = [버전 1바이트][IV 12바이트][암호문+태그]. 평문은 gzip(JSON). */
export async function encryptShare(payload: SharePayloadV1, keyB64: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await importKey(keyB64);
  const plain = await through(new TextEncoder().encode(JSON.stringify(payload)), new CompressionStream('gzip'));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(1 + IV_BYTES + sealed.length);
  out[0] = SHARE_FORMAT_VERSION;
  out.set(iv, 1);
  out.set(sealed, 1 + IV_BYTES);
  return out;
}

export async function decryptShare(envelope: Uint8Array<ArrayBuffer>, keyB64: string): Promise<SharePayloadV1> {
  if (envelope.length < 1 + IV_BYTES + TAG_BYTES) throw new ShareFormatError('bad_envelope', 'envelope too short');
  if (envelope[0] !== SHARE_FORMAT_VERSION) {
    throw new ShareFormatError('unsupported_version', `envelope version ${envelope[0]}`);
  }
  const key = await importKey(keyB64);
  let plain: Uint8Array<ArrayBuffer>;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: envelope.slice(1, 1 + IV_BYTES) },
        key,
        envelope.slice(1 + IV_BYTES),
      ),
    );
  } catch {
    throw new ShareFormatError('bad_key', 'decryption failed — wrong key or tampered envelope');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await through(plain, new DecompressionStream('gzip'))));
  } catch {
    throw new ShareFormatError('bad_payload', 'payload is not gzip JSON');
  }
  if (!isSharePayloadV1(parsed)) throw new ShareFormatError('bad_payload', 'payload is not v1');
  return parsed;
}
