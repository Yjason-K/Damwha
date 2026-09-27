import { describe, expect, it } from "vitest";
import { readBootToken } from "../../src/app/token-boot";
import type { TokenStore } from "../../src/config/token-store";

const TOKEN = "hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567";

function store(over: Partial<TokenStore>): TokenStore {
  return { read: () => null, write: () => undefined, clear: () => undefined, available: () => true, ...over };
}

describe("readBootToken (스펙 2026-09-25 §5.1)", () => {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);

  it("reads a stored token as present", () => {
    expect(readBootToken({ store: store({ read: () => TOKEN }), fileExists: () => true, log })).toEqual({
      status: "present",
      token: TOKEN,
    });
  });

  it("is absent when there is no file", () => {
    expect(readBootToken({ store: store({}), fileExists: () => false, log })).toEqual({ status: "absent", token: null });
  });

  it("is unreadable when the file is there but does not decrypt — and does not delete it", () => {
    let cleared = false;
    const s = store({ clear: () => void (cleared = true) });
    expect(readBootToken({ store: s, fileExists: () => true, log })).toEqual({ status: "unreadable", token: null });
    expect(cleared).toBe(false);
  });

  it("is unavailable without safeStorage and never reads", () => {
    let read = false;
    const s = store({ available: () => false, read: () => ((read = true), TOKEN) });
    expect(readBootToken({ store: s, fileExists: () => true, log })).toEqual({ status: "unavailable", token: null });
    expect(read).toBe(false);
  });

  it("never writes the token to the log", () => {
    lines.length = 0;
    readBootToken({ store: store({ read: () => TOKEN }), fileExists: () => true, log });
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});
