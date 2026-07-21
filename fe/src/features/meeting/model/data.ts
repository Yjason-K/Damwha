import type { IconName } from "../ui/icons";
import type { LensKind } from "./types";

/**
 * 렌즈 메타데이터 — 전역 렌즈 대시보드(`@/features/lens`)의 탭 라벨·아이콘 출처.
 *
 * 회의 mock 코퍼스(`MEETINGS`/`SPEAKERS`/`MEETING_ORDER`/`ME` 등)는 셸이 실
 * 백엔드(TanStack Query)에 연결되면서 참조가 사라져 제거했다. 도메인 타입은
 * `./types`(프리즈드 계약)가 단일 출처이며, 아직 이 모듈을 경유해 쓰는
 * `SpeakerLane`만 re-export로 남긴다.
 */

export type { SpeakerLane } from "./types";

export const LENS_META: Record<LensKind, { label: string; icon: IconName }> = {
  action: { label: "액션아이템", icon: "listChecks" },
  topic: { label: "주제·키워드", icon: "hash" },
  decision: { label: "결정사항", icon: "scale" },
  promise: { label: "약속·책임", icon: "handshake" },
};

export const LENS_KINDS = Object.keys(LENS_META) as LensKind[];
