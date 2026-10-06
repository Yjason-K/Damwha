import { Navigate } from "react-router";

/**
 * `/` — 전체 회의 카드 목록(`/meetings`)으로 replace 리다이렉트한다. 앱을 켰을 때
 * 최신 회의 하나가 아니라 목록·드롭존·결정/할 일 요약을 먼저 보여 준다. 로딩·오류·빈
 * 상태는 목록 페이지가 그린다.
 */
export function IndexRoute() {
  return <Navigate to="/meetings" replace />;
}
