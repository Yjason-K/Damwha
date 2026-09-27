import * as React from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { sendHfTokenAction, useHfToken } from "../lib/use-hf-token";
import type { HfTokenAction, HfTokenView } from "../model/types";
import { HfTokenForm } from "./hf-token-form";

const CLEAR_DETAIL =
  "지금 도는 작업 처리기는 옛 토큰으로 계속 돌아요. 하지만 다시 시작하면 토큰 없이 떠서 회의를 처리하지 못해요. 새 회의와 재처리도 다시 막혀요.";

/** 설정의 "허깅페이스 토큰" 섹션 (스펙 2026-09-25 §3.4). 웹에서는 그리지 않는다. */
export function HfTokenSettingsSection({
  view: fixedView,
  send = sendHfTokenAction,
}: {
  view?: HfTokenView;
  send?: (action: HfTokenAction) => void;
}) {
  const live = useHfToken();
  const view = fixedView ?? live;
  const [confirming, setConfirming] = React.useState(false);
  // 토큰이 있으면 입력 폼은 접어 둔다 — "토큰 바꾸기"로 펼친다. 펼친 순간의 메시지는 지난 일(예: 지난번
  // "토큰을 저장했어요")이라 폼에 넘기지 않고, 그 뒤에 온 메시지(바꾸는 중의 오류)만 보인다.
  const [replacing, setReplacing] = React.useState<{
    staleMessage: unknown;
  } | null>(null);
  const masked = view.kind === "ready" ? view.state.masked : null;
  const [prevMasked, setPrevMasked] = React.useState(masked);
  if (masked !== prevMasked) {
    // 새 토큰으로 바뀌었다 — 바꾸기가 끝났으니 다시 접는다(렌더 중 보정, effect 없이).
    setPrevMasked(masked);
    if (replacing !== null) setReplacing(null);
  }

  if (view.kind === "web") return null;

  return (
    <section aria-labelledby="settings-hf-token">
      <Card className="flex flex-col gap-3">
        <header className="flex flex-col gap-1">
          <h2
            id="settings-hf-token"
            className="text-h2 font-semibold text-foreground"
          >
            허깅페이스 토큰
          </h2>
          <p className="text-sm text-[color:var(--text-muted)]">
            회의를 기록하고 처리하는 데 필요해요.
          </p>
        </header>
        {view.kind === "pending" ? (
          <span
            role="status"
            className="text-sm text-[color:var(--text-muted)]"
          >
            확인하는 중…
          </span>
        ) : (
          <>
            {view.state.status === "present" ? (
              <div className="flex items-center justify-between gap-3">
                <span className="flex flex-col">
                  <span className="font-mono text-sm">{view.state.masked}</span>
                  {view.state.account !== null ? (
                    <span className="text-xs text-[color:var(--text-muted)]">
                      계정 {view.state.account}
                    </span>
                  ) : null}
                </span>
                <span className="flex gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setReplacing(
                        replacing === null
                          ? { staleMessage: view.state.message }
                          : null,
                      )
                    }
                  >
                    {replacing === null ? "토큰 바꾸기" : "취소"}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setConfirming(true)}
                  >
                    토큰 지우기
                  </Button>
                </span>
              </div>
            ) : view.state.status === "unreadable" ? (
              <p className="text-sm text-[color:var(--amber-text)]">
                토큰을 읽을 수 없어요 — 다시 입력해 주세요.
              </p>
            ) : null}
            {view.state.status !== "present" ? (
              <HfTokenForm state={view.state} send={send} submitLabel="확인" />
            ) : replacing !== null ? (
              <HfTokenForm
                state={
                  view.state.message === replacing.staleMessage
                    ? { ...view.state, message: null }
                    : view.state
                }
                send={send}
                submitLabel="바꾸기"
              />
            ) : null}
            <Dialog open={confirming} onOpenChange={setConfirming}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>저장된 허깅페이스 토큰을 지울까요?</DialogTitle>
                  <DialogDescription>{CLEAR_DETAIL}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button type="button" variant="secondary">
                      취소
                    </Button>
                  </DialogClose>
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => {
                      setConfirming(false);
                      send({ kind: "clear" });
                    }}
                  >
                    지우기
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}
      </Card>
    </section>
  );
}
