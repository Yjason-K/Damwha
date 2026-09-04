import * as React from "react";
import { useBlocker } from "react-router";

import { tourRunner } from "../lib/tour-runner";
import { TourExitDialog } from "./tour-exit-dialog";

/**
 * 투어 중 라우트 이동(네비 클릭·뒤로가기)과 driver의 종료 요청(ESC·오버레이·X)을 한 모달로
 * 받는다(투어 설계 §4.6). 투어 자신의 이동은 isNavigating()으로 통과시킨다.
 */
export function TourNavigationGuard() {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      tourRunner.isActive() &&
      !tourRunner.isNavigating() &&
      currentLocation.pathname !== nextLocation.pathname,
  );
  const [exitAsked, setExitAsked] = React.useState(false);

  React.useEffect(() => tourRunner.onExitRequest(() => setExitAsked(true)), []);

  const blocked = blocker.state === "blocked";
  const open = blocked || exitAsked;

  const onContinue = () => {
    setExitAsked(false);
    if (blocked) blocker.reset();
  };
  const onQuit = () => {
    setExitAsked(false);
    tourRunner.stop();
    if (blocked) blocker.proceed();
  };

  return <TourExitDialog open={open} onContinue={onContinue} onQuit={onQuit} />;
}
