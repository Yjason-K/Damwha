import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { canDiarize, sendHfTokenAction, useHfToken } from "../lib/use-hf-token";
import type { HfTokenAction, HfTokenView } from "../model/types";
import { HfTokenForm } from "./hf-token-form";

interface GateContext {
  view: HfTokenView;
  send: (action: HfTokenAction) => void;
  openDialog(): void;
}

const Ctx = React.createContext<GateContext | null>(null);

/**
 * 화자 분리가 필요한 동작의 게이트 (스펙 2026-09-25 §3.2). AppShell이 한 번 둔다. 토큰이 없으면 동작 대신 토큰
 * 다이얼로그를 띄우고, 저장되면 다이얼로그가 스스로 닫힌다 — 원래 동작은 사람이 다시 누른다(파일 선택처럼
 * 다시 확인해야 하는 단계가 있다).
 */
export function HfTokenGateProvider({
  children,
  view: fixedView,
  send = sendHfTokenAction,
}: {
  children: React.ReactNode;
  /** 테스트용. 제품 경로는 useHfToken()을 쓴다. */
  view?: HfTokenView;
  send?: (action: HfTokenAction) => void;
}) {
  const live = useHfToken();
  const view = fixedView ?? live;
  const [open, setOpen] = React.useState(false);

  // 저장에 성공하면 닫는다 — effect로 setState하지 않고, 렌더 중에 닫힘 상태를 그냥 계산한다.
  const allowed = canDiarize(view);
  const dialogOpen = open && !allowed;

  const value = React.useMemo<GateContext>(
    () => ({ view, send, openDialog: () => setOpen(true) }),
    [view, send],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {view.kind === "ready" ? (
        <Dialog open={dialogOpen} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>허깅페이스 토큰이 필요해요</DialogTitle>
              <DialogDescription>
                화자 분리 모델을 받으려면 허깅페이스 토큰이 있어야 해요. 넣은 뒤
                하던 동작을 다시 눌러 주세요.
              </DialogDescription>
            </DialogHeader>
            <HfTokenForm state={view.state} send={send} />
          </DialogContent>
        </Dialog>
      ) : null}
    </Ctx.Provider>
  );
}

export function useDiarizationGate(): {
  locked: boolean;
  run(open: () => void): void;
} {
  const ctx = React.useContext(Ctx);
  if (ctx === null) return { locked: false, run: (open) => open() };
  return {
    locked: ctx.view.kind === "pending",
    run(open) {
      if (canDiarize(ctx.view)) open();
      else if (ctx.view.kind === "ready") ctx.openDialog();
    },
  };
}

/** 실패 안내의 "토큰 설정 열기"가 쓴다. Provider 밖(웹 단위 테스트)에서는 아무 일도 하지 않는다. */
export function useHfTokenDialog(): { available: boolean; open(): void } {
  const ctx = React.useContext(Ctx);
  if (ctx === null || ctx.view.kind !== "ready")
    return { available: false, open: () => undefined };
  return { available: true, open: ctx.openDialog };
}
