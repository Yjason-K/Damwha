import * as React from "react";

import { cn } from "@/shared/lib/utils";

/**
 * 중앙 칸의 상태 표시 껍데기 — 로딩·오류·빈 상태에 공통으로 쓴다.
 * 그리드 셀에 직접 놓일 때는 className으로 배치를 넘긴다.
 */
export function CenterState({
  busy,
  className,
  children,
}: {
  busy?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role={busy ? "status" : undefined}
      aria-busy={busy || undefined}
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-[var(--surface-card)] px-8 text-center",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-6 shrink-0 animate-spin rounded-full border-2 border-[color:var(--accent-solid)] border-r-transparent"
    />
  );
}
