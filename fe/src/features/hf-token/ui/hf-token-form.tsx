import * as React from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import { sendHfTokenAction } from "../lib/use-hf-token";
import type { HfTokenAction, HfTokenState } from "../model/types";

const UNAVAILABLE_TEXT =
  "macOS 키체인을 쓸 수 없어 토큰을 안전하게 보관할 수 없어요. 키체인 접근 앱에서 로그인 키체인의 잠금을 해제한 뒤 담화를 다시 켜 주세요.";

const TONE_CLASS: Record<"info" | "warn" | "error", string> = {
  info: "text-[color:var(--text-secondary)]",
  warn: "text-[color:var(--amber-text)]",
  error: "text-[color:var(--red-text)]",
};

/**
 * HF 토큰 입력 폼 — 온보딩·설정·토큰 다이얼로그가 같은 것을 쓴다 (스펙 2026-09-25 §4.3). 확인·저장·재시작은 main이
 * 하고, 폼은 입력값을 보내고 main의 상태(busy·message)를 그릴 뿐이다. 확인에 실패해도 입력값을 지우지 않는다 —
 * 한 글자만 고쳐 다시 보낼 수 있어야 한다.
 */
export function HfTokenForm({
  state,
  send = sendHfTokenAction,
  submitLabel = "확인",
}: {
  state: HfTokenState;
  send?: (action: HfTokenAction) => void;
  submitLabel?: string;
}) {
  const [value, setValue] = React.useState("");

  if (state.status === "unavailable") {
    return (
      <p className="text-sm text-[color:var(--text-secondary)]">
        {UNAVAILABLE_TEXT}
      </p>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (state.busy || value.trim() === "") return;
    send({ kind: "submit", token: value });
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <ol className="flex flex-col gap-2 text-sm">
        <li className="flex items-center justify-between gap-3">
          <span>1. 화자 분리 모델의 사용 조건에 동의하기</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => send({ kind: "open", link: "accept" })}
          >
            사용 조건 페이지 열기
          </Button>
        </li>
        <li className="flex items-center justify-between gap-3">
          <span>2. 같은 계정에서 Read 권한 토큰 만들기</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => send({ kind: "open", link: "tokens" })}
          >
            토큰 만들기 페이지 열기
          </Button>
        </li>
      </ol>
      <div className="flex gap-2">
        <Input
          aria-label="허깅페이스 토큰"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="hf_…"
          value={value}
          disabled={state.busy}
          onChange={(e) => setValue(e.target.value)}
          containerClassName="flex-1"
        />
        <Button
          type="submit"
          disabled={state.busy || value.trim() === ""}
          loading={state.busy}
        >
          {submitLabel}
        </Button>
      </div>
      {state.message !== null ? (
        <p
          role={state.message.tone === "error" ? "alert" : "status"}
          className={`text-sm whitespace-pre-wrap ${TONE_CLASS[state.message.tone]}`}
        >
          {state.message.text}
        </p>
      ) : null}
      <p className="text-xs text-[color:var(--text-muted)]">
        확인을 누르면 huggingface.co에 토큰이 맞는지 물어본 뒤, 이 맥의
        키체인으로 암호화해 보관해요.
      </p>
    </form>
  );
}
