import { Badge } from "@/shared/ui/badge";

import type { MeetingStatus } from "../model/types";

/** 처리 중/실패 회의에 붙는 상태 배지. done이면 아무것도 그리지 않는다. */
export function MeetingStatusBadge({ status }: { status: MeetingStatus }) {
  if (status === "recording")
    return (
      <Badge variant="accent" dot>
        녹음 중
      </Badge>
    );
  if (status === "failed")
    return (
      <Badge variant="danger" dot>
        실패
      </Badge>
    );
  if (status === "uploaded" || status === "processing")
    return (
      <Badge variant="warning" dot>
        처리 중
      </Badge>
    );
  return null;
}
