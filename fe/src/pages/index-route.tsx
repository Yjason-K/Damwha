import { Navigate } from "react-router";

import { Button } from "@/shared/ui/button";
import { useMeetings } from "@/features/meeting/api/meetings";
import { CenterState, Spinner } from "@/features/meeting/ui/center-state";
import { Icon } from "@/features/meeting/ui/icons";

/**
 * `/` — 목록의 첫 회의(BE가 created_at DESC로 반환하므로 최신)로 replace
 * 리다이렉트한다. 리다이렉트할 대상이 없는 세 경우만 중앙 칸에 상태를 그린다.
 */
export function IndexRoute() {
  const { data: meetings, isLoading, isError, refetch } = useMeetings();

  if (isLoading) {
    return (
      <CenterState busy className="col-start-2">
        <Spinner />
        <p className="text-sm text-[color:var(--text-muted)]">
          회의를 불러오는 중…
        </p>
      </CenterState>
    );
  }

  if (isError) {
    return (
      <CenterState className="col-start-2">
        <Icon
          name="inbox"
          size={22}
          className="text-[color:var(--text-faint)]"
        />
        <p className="text-sm text-[color:var(--text-muted)]">
          회의를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.
        </p>
        <Button variant="secondary" size="sm" onClick={() => refetch()}>
          다시 시도
        </Button>
      </CenterState>
    );
  }

  const first = (meetings ?? [])[0];
  if (!first) {
    return (
      <CenterState className="col-start-2">
        <Icon name="mic" size={24} className="text-[color:var(--text-faint)]" />
        <p className="text-base font-semibold text-foreground">
          아직 회의가 없어요
        </p>
        <p className="text-sm text-[color:var(--text-muted)]">
          왼쪽의 “새 회의 기록하기”로 첫 회의를 만들어 보세요.
        </p>
      </CenterState>
    );
  }

  return <Navigate to={`/meetings/${first.id}`} replace />;
}
