import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { runTokenGate, UNREADABLE_TOKEN_NOTICE, type TokenGateDeps } from "../../src/app/token-gate";
import { makeTokenStore, tokenFilePath, type SafeStorageLike, type TokenStore } from "../../src/config/token-store";
import { CAUSES } from "../../src/diagnostics/causes";
import { HINTS } from "../../src/windows/shell-hints";
import { ASK_SCRIPT, openTokenWindow, TokenWindowClosed } from "../../src/windows/token-window";

/**
 * 기동 게이트의 판정 (스펙 §6.4·§8). main.ts는 electron을 값으로 import해 테스트가 못 부르므로
 * 판정은 app/token-gate.ts에 있고 main.ts에는 배선만 있다.
 *
 * 스펙 §9 비고: safeStorage 불가와 복호화 실패는 **단위 테스트로만** 판정한다 — Keychain을 실제로
 * 잠그기 어렵다. 그래서 두 경로는 여기서 진짜 토큰 저장소와 가짜 safeStorage로 본다.
 */
const TOKEN = "hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567";

function storage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (p) => Buffer.concat([Buffer.from("v10"), Buffer.from(p).map((b) => b ^ 0x33)]),
    decryptString: (b) => {
      if (b.subarray(0, 3).toString() !== "v10") throw new Error("cannot decrypt");
      return Buffer.from(b.subarray(3).map((x) => x ^ 0x33)).toString();
    },
  };
}

let dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-gate-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** 저장소를 감싸 무엇이 불렸는지 적는다. */
function spyStore(inner: TokenStore) {
  const calls: string[] = [];
  const store: TokenStore = {
    available: () => (calls.push("available"), inner.available()),
    read: () => (calls.push("read"), inner.read()),
    write: (t) => (calls.push("write"), inner.write(t)),
    clear: () => (calls.push("clear"), inner.clear()),
  };
  return { store, calls };
}

function gate(ud: string, s: SafeStorageLike, onboard: TokenGateDeps["onboard"]) {
  const log: string[] = [];
  const onboarded: Array<string | null> = [];
  const spied = spyStore(makeTokenStore(ud, s));
  const deps: TokenGateDeps = {
    store: spied.store,
    fileExists: () => fs.existsSync(tokenFilePath(ud)),
    onboard: (notice) => {
      onboarded.push(notice);
      return onboard(notice);
    },
    log: (line) => void log.push(line),
  };
  return { deps, log, onboarded, calls: spied.calls };
}

const never = () => Promise.reject(new Error("onboarding should not open"));

describe("runTokenGate", () => {
  it("blocks startup when safeStorage is unavailable — no onboarding, no read, no plaintext fallback", async () => {
    const ud = tmp();
    const g = gate(ud, storage(false), never);
    await expect(runTokenGate(g.deps)).resolves.toEqual({ kind: "blocked", detail: CAUSES.safeStorageUnavailable.text });
    expect(g.onboarded).toEqual([]);
    expect(g.calls).toEqual(["available"]);
    expect(fs.readdirSync(ud)).toEqual([]);
  });

  it("blocks even when a token file is there — it cannot be read without the Keychain", async () => {
    const ud = tmp();
    makeTokenStore(ud, storage()).write(TOKEN);
    const g = gate(ud, storage(false), never);
    await expect(runTokenGate(g.deps)).resolves.toMatchObject({ kind: "blocked" });
    expect(g.onboarded).toEqual([]);
    expect(fs.existsSync(tokenFilePath(ud))).toBe(true);
  });

  it("passes a stored token through without opening the window", async () => {
    const ud = tmp();
    makeTokenStore(ud, storage()).write(TOKEN);
    const g = gate(ud, storage(), never);
    await expect(runTokenGate(g.deps)).resolves.toEqual({ kind: "ready", token: TOKEN });
    expect(g.onboarded).toEqual([]);
  });

  it("opens onboarding with no notice on a first run, and passes on what it returns", async () => {
    const ud = tmp();
    const g = gate(ud, storage(), async () => TOKEN);
    await expect(runTokenGate(g.deps)).resolves.toEqual({ kind: "ready", token: TOKEN });
    expect(g.onboarded).toEqual([null]);
  });

  it("opens onboarding saying the token could not be read when the file is there but does not decrypt — and keeps the file", async () => {
    const ud = tmp();
    const foreign = Buffer.from("v99-from-another-mac");
    fs.writeFileSync(tokenFilePath(ud), foreign, { mode: 0o600 });
    const g = gate(ud, storage(), async () => {
      // 창이 떠 있는 동안에도 파일은 그대로다.
      expect(fs.readFileSync(tokenFilePath(ud)).equals(foreign)).toBe(true);
      return TOKEN;
    });
    await expect(runTokenGate(g.deps)).resolves.toEqual({ kind: "ready", token: TOKEN });
    expect(g.onboarded).toEqual([UNREADABLE_TOKEN_NOTICE]);
    expect(UNREADABLE_TOKEN_NOTICE).toBe("토큰을 읽을 수 없어요 — 다시 입력해 주세요");
    expect(g.calls).not.toContain("clear");
    expect(fs.readFileSync(tokenFilePath(ud)).equals(foreign)).toBe(true);
  });

  it("reports quit when the person closes the onboarding window", async () => {
    const g = gate(tmp(), storage(), () => Promise.reject(new TokenWindowClosed()));
    await expect(runTokenGate(g.deps)).resolves.toEqual({ kind: "quit" });
  });

  it("lets any other onboarding failure through — it is a failure, not a quit", async () => {
    const g = gate(tmp(), storage(), () => Promise.reject(new Error("토큰 화면을 열지 못했어요")));
    await expect(runTokenGate(g.deps)).rejects.toThrow("토큰 화면을 열지 못했어요");
  });

  it("logs what it decided, never the token", async () => {
    const ud = tmp();
    const first = gate(ud, storage(), async () => TOKEN);
    await runTokenGate(first.deps);
    expect(first.log.length).toBeGreaterThan(0);
    expect(first.log.join("\n")).not.toContain(TOKEN);
    makeTokenStore(ud, storage()).write(TOKEN);
    const second = gate(ud, storage(), never);
    await runTokenGate(second.deps);
    expect(second.log.join("\n")).not.toContain(TOKEN);
  });
});

describe("runTokenGate with the real onboarding flow", () => {
  it("first run saves the verified token; the next run starts without the window", async () => {
    const ud = tmp();
    const s = storage();
    const store = makeTokenStore(ud, s);
    const asks: Array<(v: unknown) => void> = [];
    let loaded: () => void = () => undefined;
    let alive = true;
    const onboard = (notice: string | null) =>
      openTokenWindow<object>({
        notice,
        create: () => ({}),
        alive: () => alive,
        onLoad: (_w, l) => void (loaded = l),
        onClosed: () => undefined,
        run: (_w, script) => (script === ASK_SCRIPT ? new Promise((resolve) => asks.push(resolve)) : Promise.resolve()),
        close: () => void (alive = false),
        openExternal: async () => undefined,
        quit: () => undefined,
        log: () => undefined,
        verify: async () => ({ ok: true, name: "yeongjae" }),
        save: (t) => store.write(t),
      });
    const pending = runTokenGate({ store, fileExists: () => fs.existsSync(tokenFilePath(ud)), onboard, log: () => undefined });
    loaded();
    await new Promise((r) => setTimeout(r, 0));
    asks[0]({ kind: "submit", token: TOKEN });
    await expect(pending).resolves.toEqual({ kind: "ready", token: TOKEN });
    expect(fs.readFileSync(tokenFilePath(ud)).includes(Buffer.from(TOKEN))).toBe(false);

    const again = await runTokenGate({ store: makeTokenStore(ud, s), fileExists: () => true, onboard: never, log: () => undefined });
    expect(again).toEqual({ kind: "ready", token: TOKEN });
  });
});

describe("the causes this gate and its screens use (스펙 §8)", () => {
  it("safeStorage unavailable points at the Keychain and does not suggest a plaintext file", () => {
    expect(CAUSES.safeStorageUnavailable.selfRecovers).toBe(false);
    expect(HINTS.safeStorageUnavailable).toMatch(/키체인/);
    expect(HINTS.safeStorageUnavailable).toMatch(/다시 시도/);
  });

  it("an invalid token asks for a new one", () => {
    expect(CAUSES.hfTokenInvalid.text).toBe("허깅페이스 토큰이 유효하지 않아요.");
    expect(HINTS.hfTokenInvalid).toMatch(/https:\/\/huggingface\.co\/settings\/tokens/);
  });

  it("the gated model cause carries the community-1 acceptance page", () => {
    expect(CAUSES.hfGateNotAccepted.text).toContain("사용 조건 수락이 필요해요");
    expect(CAUSES.hfGateNotAccepted.text).toContain("https://huggingface.co/pyannote/speaker-diarization-community-1");
  });
});
