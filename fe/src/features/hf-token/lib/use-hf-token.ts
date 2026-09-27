import * as React from "react";
import { hfTokenStore, type HfTokenStore } from "./bridge-store";
import type { HfTokenAction, HfTokenView } from "../model/types";

/** Electron 렌더러인가. 웹(개발용 브라우저)에서는 토큰을 be/worker/.env가 맡으므로 게이트가 없다(스펙 §3.6). */
export function detectDesktop(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /\bElectron\//.test(ua);
}

const DESKTOP = detectDesktop();

export function useHfToken(store: HfTokenStore = hfTokenStore, desktop: boolean = DESKTOP): HfTokenView {
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (!desktop) return { kind: "web" };
  if (state === null) return { kind: "pending" };
  return { kind: "ready", state };
}

/** 화자 분리가 필요한 동작을 열어도 되는가 (스펙 §3.2). */
export function canDiarize(view: HfTokenView): boolean {
  if (view.kind === "web") return true;
  if (view.kind === "pending") return false;
  return view.state.status === "present";
}

export function sendHfTokenAction(action: HfTokenAction, store: HfTokenStore = hfTokenStore): void {
  store.send(action);
}
