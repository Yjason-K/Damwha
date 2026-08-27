import { Link } from "react-router";

import { cn } from "@/shared/lib/utils";

/** ISO 문자열 → "2026.08.21"(로컬 성분). 업로드가 로컬 시각을 UTC로 보내므로 대칭적으로 되돌린다. */
function localDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
}

type MeetingGroupHeaderProps = {
  meetingId: string;
  title: string | null;
  recordedAt: string | null;
  /**
   * 그룹에 담긴 항목 수. 무한 스크롤이라 **마지막 그룹은 아직 다 받지 않았을 수
   * 있으므로** 호출부가 그때는 넘기지 않는다 — 넘기면 스크롤할수록 숫자가 커진다.
   */
  count?: number;
  className?: string;
};

/**
 * 회의 단위로 묶인 목록(저장한 발언 / 렌즈)의 구간 머리글. 목록은 서버에서
 * 회의 우선으로 정렬되어 오므로, 직전 항목과 회의가 달라지는 지점에만 세운다.
 *
 * sticky라 스크롤 중 머리글이 목록 위를 덮는다. 키보드 포커스가 머리글 뒤로
 * 숨지 않도록 호출부는 각 항목에 `scroll-mt-14`를 준다.
 */
export function MeetingGroupHeader({
  meetingId,
  title,
  recordedAt,
  count,
  className,
}: MeetingGroupHeaderProps) {
  const meta = [
    recordedAt ? localDate(recordedAt) : null,
    count == null ? null : `저장된 발언 ${count}개`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className={cn(
        "sticky top-0 z-10 -mx-1 bg-[var(--surface-app)] px-1 pt-1 pb-2",
        className,
      )}
    >
      <Link
        to={`/meetings/${meetingId}`}
        className={cn(
          "block truncate rounded-sm text-base font-semibold tracking-[-0.01em] text-foreground no-underline",
          "outline-none transition-colors duration-[80ms]",
          "hover:text-[color:var(--accent-text)]",
          "focus-visible:[box-shadow:var(--focus-ring)]",
        )}
      >
        {title ?? "제목 없는 회의"}
      </Link>
      {meta && (
        <p className="mt-0.5 text-xs text-[color:var(--text-muted)]">{meta}</p>
      )}
    </div>
  );
}
