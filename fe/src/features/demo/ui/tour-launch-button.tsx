import { useQueryClient } from "@tanstack/react-query";

import { Icon } from "@/features/meeting/ui/icons";

import { tourRunner } from "../lib/tour-runner";

/**
 * LeftNav 하단 상시 버튼(투어 설계 §2.3). 누르면 회의를 다시 숨기고 1단계부터 돈다.
 * 회색 보조 버튼이던 것을 신호 토큰(`--accent-bg` 면 + `--accent-text` 글자, 처리 배너와
 * 같은 조합)으로 올렸다 — 데모에서 안내로 돌아올 유일한 입구인데 목록 아래 회색으로
 * 묻혀 있었다. 문구도 "둘러보기"에서 바꿨다: 목적어가 없어 회의 목록을 훑는 뜻으로도
 * 읽혔고, 누르면 뭐가 얼마나 걸리는지 알 수 없었다.
 */
export function TourLaunchButton() {
  const queryClient = useQueryClient();
  return (
    <button
      type="button"
      data-tour="tour-launch"
      onClick={() => tourRunner.start(queryClient)}
      className="mx-2 mb-2 flex shrink-0 cursor-pointer items-center gap-2 rounded-sm border border-[color:var(--accent-6)] bg-[var(--accent-bg)] px-2.5 py-2 text-left text-sm font-medium text-[color:var(--accent-text)] outline-none transition-colors duration-[80ms] hover:bg-[var(--accent-bg-hover)] focus-visible:[box-shadow:var(--focus-ring)]"
    >
      <Icon name="sparkles" size={15} />
      <span className="flex-1">1분 가이드 보기</span>
    </button>
  );
}
