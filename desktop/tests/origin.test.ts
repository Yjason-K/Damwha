import { describe, expect, it } from "vitest";
import { isAllowedOrigin, originOf } from "../src/origin";

describe("originOf", () => {
  it("keeps the port because the app's port can change between runs", () => {
    expect(originOf("http://127.0.0.1:51734/meetings/mtg_5?u=utt_9")).toBe("http://127.0.0.1:51734");
  });

  it("returns null for a file URL — file has no usable origin", () => {
    expect(originOf("file:///Applications/Damwha.app/shell/status.html")).toBe(null);
  });

  it("returns null for garbage", () => {
    expect(originOf("not a url")).toBe(null);
    expect(originOf("")).toBe(null);
  });
});

describe("isAllowedOrigin", () => {
  const allowed = ["http://127.0.0.1:51734", "http://localhost:5173"];

  it("allows the API origin the window was loaded from", () => {
    expect(isAllowedOrigin("http://127.0.0.1:51734/meetings/mtg_5", allowed)).toBe(true);
  });

  it("allows the Vite dev server origin", () => {
    expect(isAllowedOrigin("http://localhost:5173/", allowed)).toBe(true);
  });

  it("rejects the same host on a different port", () => {
    expect(isAllowedOrigin("http://127.0.0.1:3000/", allowed)).toBe(false);
  });

  it("rejects a remote origin", () => {
    expect(isAllowedOrigin("https://example.com/", allowed)).toBe(false);
  });

  it("rejects a file URL", () => {
    expect(isAllowedOrigin("file:///etc/passwd", allowed)).toBe(false);
  });

  it("rejects everything when the allow list is empty", () => {
    expect(isAllowedOrigin("http://127.0.0.1:51734/", [])).toBe(false);
  });
});
