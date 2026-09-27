import { useSyncExternalStore } from "react";

import { themeStore, type ThemePreference, type ResolvedTheme } from "./theme";

export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
} {
  const snapshot = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.getSnapshot,
  );
  return { ...snapshot, setPreference: themeStore.setPreference };
}
