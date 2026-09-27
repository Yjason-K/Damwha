import { describe, expect, it, vi } from "vitest";
import { createHfTokenStore } from "./bridge-store";
import type { HfTokenState } from "../model/types";

const state: HfTokenState = {
  status: "absent",
  masked: null,
  account: null,
  onboardingDismissed: false,
  busy: false,
  message: null,
};

describe("createHfTokenStore", () => {
  it("show replaces the snapshot and notifies subscribers", () => {
    const s = createHfTokenStore();
    const l = vi.fn();
    s.subscribe(l);
    expect(s.getSnapshot()).toBeNull();
    s.bridge.show(state);
    expect(s.getSnapshot()).toEqual(state);
    expect(l).toHaveBeenCalledOnce();
  });

  it("next resolves with an action sent before or after it is asked", async () => {
    const s = createHfTokenStore();
    s.send({ kind: "clear" });
    await expect(s.bridge.next()).resolves.toEqual({ kind: "clear" });
    const asked = s.bridge.next();
    s.send({ kind: "dismissOnboarding" });
    await expect(asked).resolves.toEqual({ kind: "dismissOnboarding" });
  });

  it("keeps order when several actions queue up", async () => {
    const s = createHfTokenStore();
    s.send({ kind: "open", link: "accept" });
    s.send({ kind: "open", link: "tokens" });
    await expect(s.bridge.next()).resolves.toEqual({ kind: "open", link: "accept" });
    await expect(s.bridge.next()).resolves.toEqual({ kind: "open", link: "tokens" });
  });
});
