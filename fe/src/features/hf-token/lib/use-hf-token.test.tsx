import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createHfTokenStore } from "./bridge-store";
import { canDiarize, detectDesktop, useHfToken } from "./use-hf-token";
import type { HfTokenState } from "../model/types";

const base: HfTokenState = {
  status: "absent",
  masked: null,
  account: null,
  onboardingDismissed: false,
  busy: false,
  message: null,
};

describe("useHfToken", () => {
  it("is web outside Electron — every gate passes", () => {
    const { result } = renderHook(() => useHfToken(createHfTokenStore(), false));
    expect(result.current).toEqual({ kind: "web" });
    expect(canDiarize(result.current)).toBe(true);
  });

  it("is pending in Electron until main shows a state — gates stay shut", () => {
    const { result } = renderHook(() => useHfToken(createHfTokenStore(), true));
    expect(result.current).toEqual({ kind: "pending" });
    expect(canDiarize(result.current)).toBe(false);
  });

  it("follows main's state; only present opens the gate", () => {
    const store = createHfTokenStore();
    const { result } = renderHook(() => useHfToken(store, true));
    act(() => store.bridge.show(base));
    expect(canDiarize(result.current)).toBe(false);
    act(() => store.bridge.show({ ...base, status: "present", masked: "hf_****…****4567" }));
    expect(result.current).toEqual({ kind: "ready", state: { ...base, status: "present", masked: "hf_****…****4567" } });
    expect(canDiarize(result.current)).toBe(true);
    for (const status of ["unreadable", "unavailable"] as const) {
      act(() => store.bridge.show({ ...base, status }));
      expect(canDiarize(result.current)).toBe(false);
    }
  });
});

describe("detectDesktop", () => {
  it("reads Electron from the user agent", () => {
    expect(detectDesktop("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Electron/44.0.0 Safari/537.36")).toBe(true);
    expect(detectDesktop("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Safari/537.36")).toBe(false);
  });
});
