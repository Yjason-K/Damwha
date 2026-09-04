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

  /**
   * 모달이 떠 있는 동안 driver의 키보드 조작을 잠근다(투어 설계 §2.6). driver는 window의
   * keyup에 붙어 있어서 Radix 다이얼로그 안에서 누른 키도 그대로 받는다 — ArrowRight면
   * 모달 뒤에서 투어가 한 단계 넘어가고, Escape면 Radix가 keydown으로 닫은 모달을 driver의
   * keyup(requestExit)이 곧바로 다시 연다. driver 설정을 갈아끼우는 대신 캡처 단계에서
   * 전파를 끊어, 모달이 닫히면 원래대로 돌아오게 한다.
   */
  React.useEffect(() => {
    if (!open) return;
    const swallow = (e: KeyboardEvent) => e.stopPropagation();
    window.addEventListener("keyup", swallow, true);
    return () => window.removeEventListener("keyup", swallow, true);
  }, [open]);

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
