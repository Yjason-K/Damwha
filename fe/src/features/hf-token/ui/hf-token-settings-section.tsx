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
  "지금 도는 작업 처리기는 옛 토큰으로 계속 돌아요. 하지만 다시 시작하면 토큰 없이 떠서 화자 분리를 하지 못해요. 새 회의와 재처리도 다시 막혀요.";

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

  if (view.kind === "web") return null;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-[color:var(--text-secondary)]">
          허깅페이스 토큰
        </span>
        <span className="text-sm text-[color:var(--text-muted)]">
          화자 분리 모델을 받는 데 써요.
        </span>
      </div>
      {view.kind === "pending" ? (
        <span role="status" className="text-sm text-[color:var(--text-muted)]">
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
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setConfirming(true)}
              >
                토큰 지우기
              </Button>
            </div>
          ) : view.state.status === "unreadable" ? (
            <p className="text-sm text-[color:var(--amber-text)]">
              토큰을 읽을 수 없어요 — 다시 입력해 주세요.
            </p>
          ) : null}
          <HfTokenForm
            state={view.state}
            send={send}
            submitLabel={view.state.status === "present" ? "바꾸기" : "확인"}
          />
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
  );
}
