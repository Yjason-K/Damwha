import * as React from "react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { sendHfTokenAction, useHfToken } from "../lib/use-hf-token";
import type { HfTokenAction, HfTokenView } from "../model/types";
import { HfTokenForm } from "./hf-token-form";

/**
 * 첫 실행 온보딩 (스펙 2026-09-25 §3.3). 토큰이 없거나 못 읽었고, 이번 실행에서 넘기지 않았으면 뜬다.
 * "나중에 하기"는 main 메모리에 남는다 — 앱을 다시 켜면 다시 뜬다. 저장에 성공하면(present) 스스로 사라진다.
 */
export function HfTokenOnboarding({
  view: fixedView,
  send = sendHfTokenAction,
}: {
  view?: HfTokenView;
  send?: (action: HfTokenAction) => void;
}) {
  const live = useHfToken();
  const view = fixedView ?? live;
  // main의 답(onboardingDismissed)이 오기 전에도 바로 닫히게 한다.
  const [closed, setClosed] = React.useState(false);

  if (view.kind !== "ready") return null;
  const { state } = view;
  const wanted =
    (state.status === "absent" || state.status === "unreadable") &&
    !state.onboardingDismissed &&
    !closed;

  const later = () => {
    setClosed(true);
    send({ kind: "dismissOnboarding" });
  };

  return (
    <Dialog open={wanted} onOpenChange={(open) => (open ? undefined : later())}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>담화를 쓰려면 허깅페이스 토큰이 필요해요</DialogTitle>
          <DialogDescription>
            {state.status === "unreadable"
              ? "저장된 토큰을 읽을 수 없어요 — 다시 입력해 주세요."
              : "담화를 사용하려면 허깅페이스에서 모델 사용 조건에 동의하고, 같은 계정의 토큰을 넣어 주세요. 토큰 없이도 회의 보기·검색은 쓸 수 있어요."}
          </DialogDescription>
        </DialogHeader>
        <HfTokenForm state={state} send={send} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={later}>
            나중에 하기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
