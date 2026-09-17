import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HF_WHOAMI_URL,
  makeTokenStore,
  maskToken,
  tokenFilePath,
  VERIFY_TIMEOUT_MS,
  verifyHfToken,
  type FetchLike,
  type FetchLikeInit,
  type SafeStorageLike,
} from "../../src/config/token-store";

/**
 * 진짜 safeStorage는 Keychain을 건드리므로 테스트가 부를 수 없다(스펙 §9 비고 — 불가·복호화 실패 경로는
 * 단위 테스트로만 판정한다). 가짜는 **평문을 그대로 담지 않는** 가역 변환이다 — 그래야 "파일에 평문이
 * 없다"는 단언이 뜻을 갖는다. 복호화는 머리표가 없으면 던진다(다른 키로 암호화된 파일의 모양).
 */
const TOKEN = "hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567";

function fakeStorage(over: Partial<SafeStorageLike> = {}): SafeStorageLike & { available: boolean } {
  const s: SafeStorageLike & { available: boolean } = {
    available: true,
    isEncryptionAvailable: () => s.available,
    encryptString: (plain: string) => {
      if (!s.available) throw new Error("Encryption is not available.");
      return Buffer.concat([Buffer.from("v10"), Buffer.from(plain, "utf8").map((b) => b ^ 0x5a)]);
    },
    decryptString: (blob: Buffer) => {
      if (blob.subarray(0, 3).toString() !== "v10") throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return Buffer.from(blob.subarray(3).map((b) => b ^ 0x5a)).toString("utf8");
    },
    ...over,
  };
  return s;
}

let dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-token-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
  vi.useRealTimers();
});

describe("makeTokenStore", () => {
  it("keeps the token at <userData>/hf-token.bin", () => {
    expect(tokenFilePath("/u")).toBe(path.join("/u", "hf-token.bin"));
  });

  it("reads back what it wrote", () => {
    const ud = tmp();
    const store = makeTokenStore(ud, fakeStorage());
    store.write(TOKEN);
    expect(store.read()).toBe(TOKEN);
  });

  it("never puts the plaintext on disk — the file holds exactly the encrypted bytes (P4-C2)", () => {
    const ud = tmp();
    const storage = fakeStorage();
    makeTokenStore(ud, storage).write(TOKEN);
    const bytes = fs.readFileSync(tokenFilePath(ud));
    expect(bytes.equals(storage.encryptString(TOKEN))).toBe(true);
    expect(bytes.includes(Buffer.from(TOKEN, "utf8"))).toBe(false);
    // 디렉터리 전체에서도 — 임시 파일이 평문으로 남으면 안 된다.
    for (const name of fs.readdirSync(ud)) {
      expect(fs.readFileSync(path.join(ud, name)).includes(Buffer.from(TOKEN, "utf8"))).toBe(false);
    }
  });

  it("writes the file as 0600 and leaves no temporary file behind", () => {
    const ud = tmp();
    makeTokenStore(ud, fakeStorage()).write(TOKEN);
    expect(fs.statSync(tokenFilePath(ud)).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(ud)).toEqual(["hf-token.bin"]);
  });

  it("replacing a looser file still ends at 0600", () => {
    const ud = tmp();
    fs.writeFileSync(tokenFilePath(ud), "old", { mode: 0o644 });
    fs.chmodSync(tokenFilePath(ud), 0o644);
    const store = makeTokenStore(ud, fakeStorage());
    store.write(TOKEN);
    expect(fs.statSync(tokenFilePath(ud)).mode & 0o777).toBe(0o600);
    expect(store.read()).toBe(TOKEN);
  });

  it("creates userData if it does not exist yet", () => {
    const ud = path.join(tmp(), "nested", "Damwha");
    const store = makeTokenStore(ud, fakeStorage());
    store.write(TOKEN);
    expect(store.read()).toBe(TOKEN);
  });

  it("returns null when there is no file", () => {
    expect(makeTokenStore(tmp(), fakeStorage()).read()).toBeNull();
  });

  it("returns null when the file cannot be decrypted — and does NOT delete it", () => {
    // 다른 맥에서 옮겨 온 파일일 수 있다. 앱이 지우면 복구할 길이 없다 (스펙 §6.4).
    const ud = tmp();
    const foreign = Buffer.from("v11-not-our-key-0123456789");
    fs.writeFileSync(tokenFilePath(ud), foreign, { mode: 0o600 });
    const store = makeTokenStore(ud, fakeStorage());
    expect(store.read()).toBeNull();
    expect(fs.existsSync(tokenFilePath(ud))).toBe(true);
    expect(fs.readFileSync(tokenFilePath(ud)).equals(foreign)).toBe(true);
  });

  it("returns null when decryption yields an empty string, and keeps the file", () => {
    const ud = tmp();
    fs.writeFileSync(tokenFilePath(ud), "v10");
    expect(makeTokenStore(ud, fakeStorage()).read()).toBeNull();
    expect(fs.existsSync(tokenFilePath(ud))).toBe(true);
  });

  it("returns null when encryption is unavailable, without touching the file", () => {
    const ud = tmp();
    const storage = fakeStorage();
    makeTokenStore(ud, storage).write(TOKEN);
    const before = fs.readFileSync(tokenFilePath(ud));
    storage.available = false;
    const store = makeTokenStore(ud, { ...storage, decryptString: () => { throw new Error("Decryption is not available."); } });
    expect(store.read()).toBeNull();
    expect(fs.readFileSync(tokenFilePath(ud)).equals(before)).toBe(true);
  });

  it("reports availability from safeStorage and refuses to write without it — no plaintext fallback", () => {
    const ud = tmp();
    const storage = fakeStorage();
    storage.available = false;
    const store = makeTokenStore(ud, storage);
    expect(store.available()).toBe(false);
    expect(() => store.write(TOKEN)).toThrow();
    expect(fs.readdirSync(ud)).toEqual([]);
    storage.available = true;
    expect(store.available()).toBe(true);
  });

  it("does not write when encryptString throws", () => {
    const ud = tmp();
    const store = makeTokenStore(ud, fakeStorage({ encryptString: () => { throw new Error("boom"); } }));
    expect(() => store.write(TOKEN)).toThrow();
    expect(fs.readdirSync(ud)).toEqual([]);
  });

  it("does not replace the file when the encrypted bytes do not decrypt back to the token", () => {
    const ud = tmp();
    const good = fakeStorage();
    makeTokenStore(ud, good).write(TOKEN);
    const before = fs.readFileSync(tokenFilePath(ud));
    const broken = fakeStorage({ decryptString: () => "something else" });
    expect(() => makeTokenStore(ud, broken).write("hf_another_token_value_0000000000")).toThrow();
    expect(fs.readFileSync(tokenFilePath(ud)).equals(before)).toBe(true);
    expect(fs.readdirSync(ud)).toEqual(["hf-token.bin"]);
  });

  it("refuses an empty token — read() never returns an empty string", () => {
    const ud = tmp();
    expect(() => makeTokenStore(ud, fakeStorage()).write("")).toThrow();
    expect(fs.readdirSync(ud)).toEqual([]);
  });

  it("never carries the token in the message of what it throws", () => {
    const ud = tmp();
    const failing = [
      fakeStorage({ encryptString: () => { throw new Error(`cannot encrypt ${TOKEN}`); } }),
      fakeStorage({ decryptString: () => `${TOKEN}x` }),
    ];
    for (const storage of failing) {
      let message = "";
      try {
        makeTokenStore(ud, storage).write(TOKEN);
      } catch (e) {
        message = e instanceof Error ? `${e.message} ${String(e.stack)}` : String(e);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(TOKEN);
    }
  });

  it("clear() removes the file, and is quiet when there is none", () => {
    const ud = tmp();
    const store = makeTokenStore(ud, fakeStorage());
    store.write(TOKEN);
    store.clear();
    expect(fs.existsSync(tokenFilePath(ud))).toBe(false);
    expect(store.read()).toBeNull();
    expect(() => store.clear()).not.toThrow();
  });
});

describe("maskToken", () => {
  it("keeps only the hf_ prefix and the last four characters (스펙 §6.4 예시)", () => {
    const token = `hf_${"x".repeat(30)}abcd`;
    expect(maskToken(token)).toBe("hf_****…****abcd");
  });

  it("does not reveal the middle of the token", () => {
    const masked = maskToken(TOKEN);
    expect(masked).toBe("hf_****…****4567");
    expect(masked).not.toContain(TOKEN.slice(3, -4));
  });

  it("masks a long token without the hf_ prefix the same way", () => {
    expect(maskToken("abcdefghijklmnopwxyz")).toBe("****…****wxyz");
  });

  it("masks a short token completely — four characters of a short token are most of it", () => {
    for (const short of ["", "hf_", "hf_abcd", "abcdefghijk"]) {
      expect(maskToken(short)).toBe("****");
    }
  });
});

type Call = { url: string; init: FetchLikeInit };

function fakeFetch(respond: (call: Call) => Promise<{ status: number; text(): Promise<string> }>) {
  const calls: Call[] = [];
  const fn: FetchLike = (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { fn, calls };
}

const reply = (status: number, body: string) => async () => ({ status, text: async () => body });

describe("verifyHfToken", () => {
  it("asks whoami-v2 with the token as a Bearer, refusing redirects, and accepts a 200 with the account name", async () => {
    const f = fakeFetch(reply(200, JSON.stringify({ type: "user", name: "yeongjae", fullname: "Kim" })));
    await expect(verifyHfToken(TOKEN, f.fn)).resolves.toEqual({ ok: true, name: "yeongjae" });
    expect(f.calls).toHaveLength(1);
    expect(HF_WHOAMI_URL).toBe("https://huggingface.co/api/whoami-v2");
    expect(f.calls[0].url).toBe(HF_WHOAMI_URL);
    expect(f.calls[0].init.method).toBe("GET");
    expect(f.calls[0].init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    // 리다이렉트를 따라가면 토큰이 다른 호스트로 갈 수 있다.
    expect(f.calls[0].init.redirect).toBe("error");
    expect(f.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to fullname, then to a generic label, when a 200 carries no name", async () => {
    await expect(verifyHfToken(TOKEN, fakeFetch(reply(200, JSON.stringify({ fullname: "Kim Y" }))).fn)).resolves.toEqual({
      ok: true,
      name: "Kim Y",
    });
    const generic = await verifyHfToken(TOKEN, fakeFetch(reply(200, JSON.stringify({ type: "user" }))).fn);
    expect(generic.ok).toBe(true);
    expect(generic.ok && generic.name.length > 0).toBe(true);
  });

  it("does not accept a 200 whose body is not HF's JSON — something in between answered", async () => {
    const v = await verifyHfToken(TOKEN, fakeFetch(reply(200, "<html>captive portal</html>")).fn);
    expect(v).toMatchObject({ ok: false, kind: "offline" });
  });

  it("calls 401 invalid, with the HTTP status and HF's message", async () => {
    const v = await verifyHfToken(TOKEN, fakeFetch(reply(401, JSON.stringify({ error: "Invalid credentials in Authorization header" }))).fn);
    expect(v).toEqual({ ok: false, kind: "invalid", detail: "HTTP 401 — Invalid credentials in Authorization header" });
  });

  it("calls 403 invalid — the token is known but refused", async () => {
    const v = await verifyHfToken(TOKEN, fakeFetch(reply(403, JSON.stringify({ error: "Forbidden" }))).fn);
    expect(v).toEqual({ ok: false, kind: "invalid", detail: "HTTP 403 — Forbidden" });
  });

  it("calls rate limits, server errors, and unexpected statuses 'cannot check now' — never invalid, never ok", async () => {
    for (const status of [400, 404, 407, 429, 500, 502, 503]) {
      const v = await verifyHfToken(TOKEN, fakeFetch(reply(status, "")).fn);
      expect(v).toEqual({ ok: false, kind: "offline", detail: `HTTP ${status}` });
    }
  });

  it("keeps only the status when the error body is an HTML page", async () => {
    const v = await verifyHfToken(TOKEN, fakeFetch(reply(502, "<html><body>Bad gateway</body></html>")).fn);
    expect(v).toEqual({ ok: false, kind: "offline", detail: "HTTP 502" });
  });

  it("keeps a plain-text error body, flattened and bounded", async () => {
    const long = `line one\n\tline\u0000two ${"y".repeat(500)}`;
    const v = await verifyHfToken(TOKEN, fakeFetch(reply(503, long)).fn);
    expect(v.ok).toBe(false);
    const detail = v.ok ? "" : v.detail;
    expect(detail.startsWith("HTTP 503 — line one line two ")).toBe(true);
    expect(detail).not.toMatch(/[\u0000-\u001f]/);
    expect(detail.length).toBeLessThanOrEqual(240);
  });

  it("scrubs the token if HF's message echoes it", async () => {
    const v = await verifyHfToken(TOKEN, fakeFetch(reply(401, JSON.stringify({ error: `bad token ${TOKEN} (also hf_ZZZZZZZZZZZZ)` }))).fn);
    expect(v.ok).toBe(false);
    const detail = v.ok ? "" : v.detail;
    expect(detail).not.toContain(TOKEN);
    expect(detail).not.toContain("hf_ZZZZZZZZZZZZ");
    expect(detail).toMatch(/^HTTP 401 — bad token /);
  });

  it("still says invalid on 401 when the body cannot be read", async () => {
    const v = await verifyHfToken(TOKEN, fakeFetch(async () => ({ status: 401, text: () => Promise.reject(new Error(`read ${TOKEN}`)) })).fn);
    expect(v).toEqual({ ok: false, kind: "invalid", detail: "HTTP 401" });
  });

  it("calls a network failure offline, distinct from invalid, without the exception's message", async () => {
    // undici는 요청 헤더를 메시지에 담는 경우가 있다고 본다 — 그러면 토큰이 화면과 로그에 샌다.
    const err = Object.assign(new TypeError(`fetch failed: Authorization: Bearer ${TOKEN}`), {
      cause: Object.assign(new Error(`getaddrinfo ENOTFOUND huggingface.co ${TOKEN}`), { code: "ENOTFOUND" }),
    });
    const v = await verifyHfToken(TOKEN, fakeFetch(() => Promise.reject(err)).fn);
    expect(v.ok).toBe(false);
    expect(v).toMatchObject({ kind: "offline" });
    const detail = v.ok ? "" : v.detail;
    expect(detail).toContain("ENOTFOUND");
    expect(detail).not.toContain(TOKEN);
    expect(detail).not.toContain("fetch failed");
    expect(detail).not.toContain("getaddrinfo");
  });

  it("ignores an error code that does not look like one", async () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: { code: `x ${TOKEN}` } });
    const v = await verifyHfToken(TOKEN, fakeFetch(() => Promise.reject(err)).fn);
    expect(v.ok).toBe(false);
    expect(v.ok ? "" : v.detail).not.toContain(TOKEN);
  });

  it("gives up after the timeout even if fetch never answers, and aborts the request", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const f = fakeFetch((call) => {
      signal = call.init.signal;
      return new Promise(() => undefined);
    });
    const pending = verifyHfToken(TOKEN, f.fn);
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS + 1);
    const v = await pending;
    expect(v).toMatchObject({ ok: false, kind: "offline" });
    expect(v.ok ? "" : v.detail).toMatch(/시간/);
    expect(signal?.aborted).toBe(true);
  });

  it("also bounds reading the body", async () => {
    vi.useFakeTimers();
    const f = fakeFetch(async () => ({ status: 200, text: () => new Promise<string>(() => undefined) }));
    const pending = verifyHfToken(TOKEN, f.fn);
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS + 1);
    await expect(pending).resolves.toMatchObject({ ok: false, kind: "offline" });
  });

  it("rejects an empty token or one with characters a header cannot carry, without any request", async () => {
    const f = fakeFetch(reply(200, JSON.stringify({ name: "x" })));
    for (const bad of ["", " ", "hf_abc def", "hf_abc\ndef", "hf_토큰", `${TOKEN} `]) {
      const v = await verifyHfToken(bad, f.fn);
      expect(v).toMatchObject({ ok: false, kind: "invalid" });
      // 무엇이 문제인지는 말하되 토큰 조각은 싣지 않는다.
      expect(v.ok ? "" : v.detail).not.toContain("hf_");
    }
    expect(f.calls).toHaveLength(0);
  });

  it("uses a timeout of ten seconds", () => {
    expect(VERIFY_TIMEOUT_MS).toBe(10_000);
  });
});
