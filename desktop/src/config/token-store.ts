import * as fs from "fs";
import * as path from "path";

/**
 * Hugging Face 토큰의 보관과 검증 (Phase 4 스펙 §6.4).
 *
 * **electron을 값으로 import하지 않는다.** main.ts가 진짜 `safeStorage`를 주입한다 — Electron의 SafeStorage는
 * 아래 SafeStorageLike를 구조적으로 만족한다. 그래서 불가·복호화 실패 경로를 가짜로 판정할 수 있다
 * (스펙 §9 비고: Keychain을 실제로 잠그기 어렵다).
 *
 * 토큰 원문은 어디에도 적지 않는다 — 로그·화면·예외 메시지 전부. 이 파일이 던지는 예외는 고정 문구뿐이고,
 * 검증 실패의 detail은 HTTP 상태와 HF의 응답 문구(토큰을 지운 뒤)뿐이다.
 */

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(blob: Buffer): string;
}

export interface TokenStore {
  read(): string | null;
  write(token: string): void;
  clear(): void;
  available(): boolean;
}

export type TokenVerdict =
  | { ok: true; name: string }
  | { ok: false; kind: "invalid" | "offline"; detail: string };

/** verifyHfToken이 fetch에 넘기는 것. 이 모양만 약속한다 — 테스트가 네트워크 없이 부른다. */
export interface FetchLikeInit {
  method: "GET";
  headers: Record<string, string>;
  /** 리다이렉트를 따라가지 않는다. 따라가면 Authorization이 다른 호스트로 갈 수 있다. */
  redirect: "error";
  signal: AbortSignal;
}
export interface FetchLikeResponse {
  status: number;
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: FetchLikeInit) => Promise<FetchLikeResponse>;

export const TOKEN_FILE_NAME = "hf-token.bin";
export const HF_WHOAMI_URL = "https://huggingface.co/api/whoami-v2";
/** 온보딩 화면의 두 링크. 여는 것은 main이다(windows/token-window.ts) — 렌더러는 주소를 고르지 않는다. */
export const HF_TOKENS_PAGE_URL = "https://huggingface.co/settings/tokens";
/** 앱이 받는 모델 중 조건 수락이 필요한 것은 화자 분리 하나다 (worker의 PyannoteDiarizer). */
export const HF_GATED_MODEL_PAGE_URL = "https://huggingface.co/pyannote/speaker-diarization-community-1";
/** 검증 요청 한 번(응답 본문 읽기 포함)의 상한. */
export const VERIFY_TIMEOUT_MS = 10_000;

/** `<userData>/hf-token.bin`. 게이트가 "파일이 없다"와 "있는데 못 읽는다"를 가르는 데도 쓴다. */
export function tokenFilePath(userData: string): string {
  return path.join(userData, TOKEN_FILE_NAME);
}

/**
 * `safeStorage`로 암호화한 토큰을 `<userData>/hf-token.bin`(0600)에 둔다.
 *
 * - **평문 폴백이 없다.** 암호화를 못 쓰면 write가 던진다 — 기동 게이트가 그 전에 막는다.
 * - **read는 못 읽으면 null이고 파일을 지우지 않는다.** 다른 맥에서 옮겨 온 파일이거나 Keychain 접근이 잠깐
 *   거부된 것일 수 있고, 앱이 지우면 복구할 길이 없다. 사람이 새 토큰을 넣으면 그때 write가 갈아 끼운다.
 * - **write는 원자적이다.** 같은 폴더의 임시 파일(0600)에 쓰고 rename한다 — 도중에 죽어도 옛 파일이 반쯤 덮이지
 *   않는다. 쓰기 전에 암호문이 원래 토큰으로 되풀리는지 확인한다: 못 되풀리는 파일을 저장하면 다음 실행이
 *   "토큰을 읽을 수 없어요"로 사람을 다시 부른다.
 */
export function makeTokenStore(userData: string, storage: SafeStorageLike): TokenStore {
  const file = tokenFilePath(userData);
  return {
    available: () => storage.isEncryptionAvailable(),

    read() {
      let blob: Buffer;
      try {
        blob = fs.readFileSync(file);
      } catch {
        return null;
      }
      try {
        const token = storage.decryptString(blob);
        return token === "" ? null : token;
      } catch {
        return null;
      }
    },

    write(token) {
      if (token === "") throw new Error("빈 토큰은 저장하지 않아요.");
      if (!storage.isEncryptionAvailable()) {
        throw new Error("키체인 암호화를 쓸 수 없어 토큰을 저장하지 않았어요.");
      }
      // 원래 예외를 옮기지 않는다 — 메시지에 무엇이 담겼는지 이 파일은 모른다.
      let blob: Buffer;
      try {
        blob = storage.encryptString(token);
      } catch {
        throw new Error("토큰을 암호화하지 못했어요.");
      }
      let roundTrip: string | null;
      try {
        roundTrip = storage.decryptString(blob);
      } catch {
        roundTrip = null;
      }
      if (roundTrip !== token) throw new Error("암호화한 토큰을 다시 풀지 못해 저장하지 않았어요.");

      fs.mkdirSync(userData, { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      try {
        // wx: 이미 있는 파일(남은 임시 파일)을 따라가지 않는다. mode는 새로 만들 때만 먹으므로 chmod로 한 번 더 못 박는다.
        fs.writeFileSync(tmp, blob, { mode: 0o600, flag: "wx" });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, file);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
    },

    clear() {
      fs.rmSync(file, { force: true });
    },
  };
}

const MASK_MIN_LENGTH = 12;

/**
 * 화면에 보이는 모양. `hf_****…****abcd` (스펙 §6.4). 앞은 `hf_` 머리표만, 뒤는 네 글자만 남긴다.
 * 짧은 토큰은 네 글자가 대부분이라 전부 가린다.
 */
export function maskToken(token: string): string {
  if (token.length < MASK_MIN_LENGTH) return "****";
  const prefix = token.startsWith("hf_") ? "hf_" : "";
  return `${prefix}****…****${token.slice(-4)}`;
}

/** 헤더에 실을 수 있는 보이는 ASCII만. 공백·줄바꿈·한글이 섞인 토큰은 HF 토큰일 수 없다. */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,512}$/;
/** 응답 문구에 섞인 HF 토큰 모양. */
const HF_TOKEN_LIKE = /hf_[A-Za-z0-9]{6,}/g;
const DETAIL_MAX = 200;
const NAME_MAX = 100;
const GENERIC_ACCOUNT = "이름을 알 수 없는 계정";

class VerifyTimeout extends Error {}

/**
 * 토큰을 저장하기 **전에** HF에 실제로 묻는다 (스펙 §6.4). 형식만 보면 오타난 토큰이 통과해 몇 분 뒤 job
 * 실패로만 드러난다.
 *
 * `GET https://huggingface.co/api/whoami-v2`, `Authorization: Bearer <token>`. 판정:
 *
 * | 응답 | 판정 | 이유 |
 * | --- | --- | --- |
 * | 200 + JSON 객체 | ok (`name` → `fullname` → 일반 이름) | |
 * | 200인데 JSON이 아니다 | offline | 사이에서 누군가 답했다(프록시·포털). 토큰이 맞는지 모른다 |
 * | 401 · 403 | invalid | HF가 토큰을 모르거나 거부했다 — 다시 넣어야 한다 |
 * | 그 밖의 상태(400·404·407·429·5xx…) | offline | 토큰 탓이라고 말할 근거가 없다. 나중에 다시 확인한다 |
 * | 네트워크 실패·리다이렉트·시간 초과 | offline | "지금은 확인할 수 없어요" |
 * | 헤더에 못 싣는 토큰(빈 값·공백·비ASCII) | invalid | 요청하지 않는다 |
 *
 * **ok가 아니면 저장하지 않는다** — 부르는 쪽(token-window.ts)의 규칙이다.
 *
 * 실패의 detail에는 HTTP 상태와 HF 응답 문구만 싣는다. **원본 예외 메시지를 옮기지 않는다** — 네트워크
 * 스택이 요청 헤더를 메시지에 담는 경우가 있고, 그러면 토큰이 화면과 로그에 샌다. 네트워크 실패는
 * `ENOTFOUND` 같은 오류 코드만 모양을 확인해 싣는다. HF 문구도 토큰 모양을 지운 뒤 한 줄로 접고 자른다.
 *
 * 시간 상한은 fetch의 협조에 기대지 않는다 — 신호로 요청을 끊고, 경주로 결과를 닫는다(본문 읽기 포함).
 */
export async function verifyHfToken(token: string, fetchFn: FetchLike = defaultFetch): Promise<TokenVerdict> {
  if (!TOKEN_SHAPE.test(token)) {
    return { ok: false, kind: "invalid", detail: "토큰이 비어 있거나 쓸 수 없는 문자(공백·한글 등)가 있어요" };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new VerifyTimeout());
    }, VERIFY_TIMEOUT_MS);
  });
  // 경주에서 진 쪽의 거부가 처리되지 않은 채 남지 않게 한다.
  deadline.catch(() => undefined);

  try {
    let res: FetchLikeResponse;
    try {
      res = await Promise.race([
        fetchFn(HF_WHOAMI_URL, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
          signal: controller.signal,
        }),
        deadline,
      ]);
    } catch (e) {
      return { ok: false, kind: "offline", detail: networkDetail(e) };
    }

    let body: string | null;
    try {
      body = await Promise.race([res.text(), deadline]);
    } catch (e) {
      if (e instanceof VerifyTimeout) return { ok: false, kind: "offline", detail: networkDetail(e) };
      body = null;
    }

    if (res.status === 200) {
      const name = accountName(body, token);
      if (name === null) return { ok: false, kind: "offline", detail: "HTTP 200 — 허깅페이스의 응답으로 보이지 않아요" };
      return { ok: true, name };
    }
    const kind = res.status === 401 || res.status === 403 ? "invalid" : "offline";
    return { ok: false, kind, detail: httpDetail(res.status, body, token) };
  } finally {
    clearTimeout(timer);
  }
}

function defaultFetch(url: string, init: FetchLikeInit): Promise<FetchLikeResponse> {
  return fetch(url, init);
}

function networkDetail(e: unknown): string {
  if (e instanceof VerifyTimeout) return `시간 초과 — ${VERIFY_TIMEOUT_MS / 1000}초 안에 허깅페이스가 답하지 않았어요`;
  const code = errorCode(e);
  return code === null ? "네트워크 오류 — huggingface.co에 연결하지 못했어요" : `네트워크 오류 (${code})`;
}

/** undici는 원인을 `cause.code`에 싣는다. 모양이 맞는 코드만 쓴다 — 그 밖의 문자열은 무엇이 담겼는지 모른다. */
function errorCode(e: unknown): string | null {
  const pick = (v: unknown): string | null => {
    if (v === null || typeof v !== "object") return null;
    const code = (v as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : null;
  };
  if (e === null || typeof e !== "object") return null;
  return pick((e as { cause?: unknown }).cause) ?? pick(e);
}

function parseObject(body: string | null): Record<string, unknown> | null {
  if (body === null) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function accountName(body: string | null, token: string): string | null {
  const json = parseObject(body);
  if (json === null) return null;
  for (const key of ["name", "fullname"]) {
    const value = json[key];
    if (typeof value !== "string") continue;
    const clean = scrub(value, token, NAME_MAX);
    if (clean !== "") return clean;
  }
  return GENERIC_ACCOUNT;
}

function httpDetail(status: number, body: string | null, token: string): string {
  const json = parseObject(body);
  let message = "";
  if (json !== null) {
    const picked = json.error ?? json.message;
    if (typeof picked === "string") message = picked;
  } else if (body !== null && !body.trimStart().startsWith("<")) {
    // HTML 오류 페이지(프록시·게이트웨이)는 싣지 않는다 — 글자로 그려도 소음이다.
    message = body;
  }
  const clean = scrub(message, token, DETAIL_MAX);
  return clean === "" ? `HTTP ${status}` : `HTTP ${status} — ${clean}`;
}

/** 토큰(과 토큰 모양)을 가리고, 제어 문자를 공백으로 바꿔 한 줄로 접고, 자른다. */
function scrub(text: string, token: string, max: number): string {
  const flat = text
    .split(token)
    .join("****")
    .replace(HF_TOKEN_LIKE, "hf_****")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
