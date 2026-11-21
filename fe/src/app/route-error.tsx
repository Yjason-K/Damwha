import * as React from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";

import { useStopLive } from "@/features/meeting/api/live";
import type { LiveStopResponse } from "@/features/meeting/api/types";
import {
  awaitLiveStart,
  clearLiveCapture,
  getUnfinishedLiveCapture,
  isLiveStarting,
  liveSessionVersion,
  subscribeLiveSession,
} from "@/features/meeting/lib/live-session";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/utils";

/**
 * 라우트 렌더 예외 화면 (#98). React Router의 기본 오류 화면은 셸을 통째로 대체하고,
 * 녹음 종료 버튼(LiveBanner)은 회의 화면 안에 있어서 화면이 깨지면 녹음을 멈출 수단이
 * 사라진다. 레코더는 React 밖의 모듈 싱글턴이라 계속 캡처한다 — 그래서 이 화면이 종료를
 * 직접 맡는다. 회의 화면의 종료와 같은 절차(`recorder.stop()` → `useStopLive`)를 밟고,
 * 서버 ACK(outcome)를 받은 뒤에만 캡처를 놓는다.
 *
 * `standalone`은 셸 자체가 깨졌을 때(루트 라우트)의 전체 화면 배치다. 그 밖에는 셸
 * 그리드의 col 2를 채운다. 예외 메시지는 사용자에게 보이지 않는다.
 */
export function RouteErrorPage({
  standalone = false,
}: {
  standalone?: boolean;
}) {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const location = useLocation();
  const { pathname } = location;
  // 레코더 상태·캡처 등록이 바뀌면 다시 그린다(다른 경로의 자동 종료·봉인 포함).
  React.useSyncExternalStore(subscribeLiveSession, liveSessionVersion);
  const capture = getUnfinishedLiveCapture();
  // 준비·회의 생성 중에도 메모리에만 있는 캡처가 있다 — 새로고침하면 회의만 서버에 남는다.
  const reloadBlocked = !!capture || isLiveStarting();
  const stopLive = useStopLive();
  const [ended, setEnded] = React.useState<LiveStopResponse["outcome"] | null>(
    null,
  );
  const [stopFailed, setStopFailed] = React.useState(false);
  const stopping =
    stopLive.isPending || capture?.recorder.status.phase === "stopping";

  const handleStop = () => {
    if (!capture) return;
    const { meetingId, recorder, stopOutcome } = capture;
    setStopFailed(false);
    stopLive.mutate(
      {
        id: meetingId,
        // 정리는 이 함수 안에서 한다. mutate()의 호출별 콜백은 이 화면이 사라지면(다시
        // 시도·LeftNav 이동) 불리지 않아 캡처가 남는다.
        stop: async () => {
          // 시작이 아직 begin() ACK를 기다리는 중이면 그 뒤에 멈춘다. 먼저 멈추면 늦게 온
          // ACK가 레코더를 다시 녹음 상태로 되돌린다(데스크톱 브리지와 같은 순서).
          await awaitLiveStart();
          await recorder.stop();
          // outcome이 없으면 서버가 받았다는 증거가 없다 — 꼬리를 지키려고 캡처를 남긴다.
          if (stopOutcome.current) clearLiveCapture(meetingId);
          return stopOutcome.current;
        },
      },
      {
        onSuccess: (r) => {
          if (!r) {
            setStopFailed(true);
            return;
          }
          setEnded(r.outcome);
          // 지워진 회의의 화면에 있을 때만 떠난다. 다른 화면이 깨졌으면 그대로 둔다.
          if (
            r.outcome === "discarded" &&
            pathname === `/meetings/${meetingId}`
          )
            navigate("/", { replace: true });
        },
        onError: () => setStopFailed(true),
      },
    );
  };

  return (
    <main
      className={cn(
        "flex flex-col items-center justify-center gap-5 bg-background px-6 text-foreground",
        standalone ? "min-h-screen" : "col-start-2 h-full",
      )}
    >
      <div
        role="alert"
        className="flex max-w-md flex-col items-center gap-2 text-center"
      >
        <h1 className="text-lg font-semibold text-balance">
          {t("routeError.title")}
        </h1>
        <p className="text-sm text-[color:var(--text-muted)]">
          {t("routeError.description")}
        </p>
      </div>

      {capture ? (
        <section
          aria-labelledby="route-error-recording"
          className="flex max-w-md flex-col items-center gap-2 rounded-md border border-border bg-card px-5 py-4 text-center"
        >
          <h2 id="route-error-recording" className="text-sm font-semibold">
            {t("routeError.recording.title")}
          </h2>
          <p className="text-sm text-[color:var(--text-muted)]">
            {t("routeError.recording.description")}
          </p>
          <Button
            variant="danger"
            size="sm"
            disabled={stopping}
            onClick={handleStop}
          >
            {stopping
              ? t("routeError.recording.stopping")
              : t("routeError.recording.stop")}
          </Button>
          <p role="status" className="text-sm text-[color:var(--red-text)]">
            {stopFailed && !stopping
              ? t("routeError.recording.stopFailed")
              : null}
          </p>
        </section>
      ) : ended ? (
        <p role="status" className="max-w-md text-center text-sm">
          {ended === "discarded"
            ? t("routeError.recording.discarded")
            : t("routeError.recording.stopped")}
        </p>
      ) : null}

      <div className="flex flex-col items-center gap-2">
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            // 경계는 location이 바뀔 때 풀린다. 이 앱의 라우트엔 loader가 없어 revalidate는
            // 경계를 풀지 못한다 — 같은 경로로 replace 이동해 새 location을 만든다.
            onClick={() =>
              navigate(
                { pathname, search: location.search, hash: location.hash },
                { replace: true },
              )
            }
          >
            {t("routeError.retry")}
          </Button>
          {/* 청크 로드 실패는 다시 시도로 풀리지 않을 수 있다(React.lazy가 실패를 캐시).
              새로고침은 메모리의 레코더를 없애므로 녹음이 끝난 뒤에만 연다. */}
          <Button
            variant="ghost"
            size="sm"
            disabled={reloadBlocked}
            aria-describedby={
              reloadBlocked ? "route-error-reload-blocked" : undefined
            }
            onClick={() => window.location.reload()}
          >
            {t("routeError.reload")}
          </Button>
        </div>
        {reloadBlocked ? (
          <p
            id="route-error-reload-blocked"
            className="text-xs text-[color:var(--text-muted)]"
          >
            {t("routeError.reloadBlocked")}
          </p>
        ) : null}
      </div>
    </main>
  );
}
