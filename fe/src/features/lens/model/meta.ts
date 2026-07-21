import type { IconName } from "@/features/meeting/ui/icons";
import type { LensKind } from "./types";

// 작업 3은 action|decision|promise만. topic(주제·키워드)은 작업 4에서 별도 탭으로 추가.
export const LENS_META: Record<LensKind, { label: string; icon: IconName }> = {
  action: { label: "액션아이템", icon: "listChecks" },
  decision: { label: "결정사항", icon: "scale" },
  promise: { label: "약속·책임", icon: "handshake" },
};

export const LENS_KINDS = Object.keys(LENS_META) as LensKind[];
