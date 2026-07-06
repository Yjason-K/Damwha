import { Badge } from "@/shared/ui/badge";
import type { SpeakerStatus } from "@/features/meeting/api/types";

/** 화자 등록 상태 → 뱃지 라벨/톤 매핑. */
const STATUS_META: Record<
  SpeakerStatus,
  { label: string; variant: "success" | "warning" | "neutral" | "danger" }
> = {
  ready: { label: "등록됨", variant: "success" },
  provisional: { label: "미확정", variant: "warning" },
  pending: { label: "처리 중", variant: "neutral" },
  failed: { label: "실패", variant: "danger" },
};

/** 화자 상태 뱃지. pending은 성문 분석 진행 중이라 aria-busy + 스피너로 표시. */
export function SpeakerStatusBadge({ status }: { status: SpeakerStatus }) {
  const meta = STATUS_META[status];
  const pending = status === "pending";
  return (
    <Badge
      variant={meta.variant}
      dot={!pending}
      aria-busy={pending ? true : undefined}
      icon={
        pending ? (
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-r-transparent"
          />
        ) : undefined
      }
    >
      {meta.label}
    </Badge>
  );
}
