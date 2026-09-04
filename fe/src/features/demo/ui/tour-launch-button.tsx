import { useQueryClient } from "@tanstack/react-query";

import { Icon } from "@/features/meeting/ui/icons";

import { tourRunner } from "../lib/tour-runner";

/** LeftNav 하단 상시 버튼(투어 설계 §2.3). 누르면 회의를 다시 숨기고 1단계부터 돈다. */
export function TourLaunchButton() {
  const queryClient = useQueryClient();
  return (
    <button
      type="button"
      data-tour="tour-launch"
      onClick={() => tourRunner.start(queryClient)}
      className="mx-2 mb-2 flex shrink-0 cursor-pointer items-center gap-2 rounded-sm border border-border px-2.5 py-2 text-left text-sm font-medium text-[color:var(--text-secondary)] outline-none transition-colors duration-[80ms] hover:bg-[var(--gray-2)] focus-visible:[box-shadow:var(--focus-ring)]"
    >
      <Icon name="sparkles" size={15} />
      <span className="flex-1">둘러보기</span>
    </button>
  );
}
