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

  // false→true로 바뀌는 "저장 성공" 전환에서만 닫는다 — effect로 setState하지 않고
  // 렌더 중에 state를 보정하는 React의 공식 패턴을 쓴다. present가 유지되는 동안은
  // open을 건드리지 않으므로, 토큰을 지운 뒤(allowed가 다시 false가 돼도) 다이얼로그가
  // 저절로 뜨지 않고, present 상태에서도 useHfTokenDialog().open()으로 다시 열어
  // 토큰을 교체할 수 있다.
  const allowed = canDiarize(view);
  const [prevAllowed, setPrevAllowed] = React.useState(allowed);
  if (allowed !== prevAllowed) {
    setPrevAllowed(allowed);
    if (allowed) setOpen(false);
  }

  // present인 채로 토큰을 갈아 끼우면(실패 배너에서 취소된 토큰을 바꿀 때) allowed는 이미
  // true라 위 전환이 안 잡는다 — masked가 새 값으로 바뀌는 전환을 따로 본다. null로 바뀌는
  // 쪽(clear)은 닫지 않는다 — 지운다고 열려 있던 교체 다이얼로그가 저절로 닫힐 이유는 없다.
  const masked = view.kind === "ready" ? view.state.masked : null;
  const [prevMasked, setPrevMasked] = React.useState(masked);
  if (masked !== prevMasked) {
    setPrevMasked(masked);
    if (masked !== null) setOpen(false);
  }

  const value = React.useMemo<GateContext>(
    () => ({ view, send, openDialog: () => setOpen(true) }),
    [view, send],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {view.kind === "ready" ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>허깅페이스 토큰이 필요해요</DialogTitle>
              <DialogDescription>
                회의를 기록하고 처리하려면 모델 사용 조건 동의와 허깅페이스
                토큰이 필요해요. 넣은 뒤 하던 동작을 다시 눌러 주세요.
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
