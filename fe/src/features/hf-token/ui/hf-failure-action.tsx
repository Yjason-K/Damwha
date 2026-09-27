import { Button } from "@/shared/ui/button";

import { sendHfTokenAction } from "../lib/use-hf-token";
import type { HfTokenAction } from "../model/types";
import { useHfTokenDialog } from "./hf-token-gate";

/** 실패 배너의 원인별 해결 버튼 (스펙 2026-09-25 §3.5) — 토큰 다이얼로그를 열거나 사용 조건 페이지로 보낸다. */
export function HfFailureAction({
  action,
  send = sendHfTokenAction,
}: {
  action: "token" | "accept";
  send?: (a: HfTokenAction) => void;
}) {
  const dialog = useHfTokenDialog();
  if (!dialog.available) return null;
  return action === "token" ? (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="ml-auto shrink-0"
      onClick={dialog.open}
    >
      토큰 설정 열기
    </Button>
  ) : (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="ml-auto shrink-0"
      onClick={() => send({ kind: "open", link: "accept" })}
    >
      사용 조건 페이지 열기
    </Button>
  );
}
