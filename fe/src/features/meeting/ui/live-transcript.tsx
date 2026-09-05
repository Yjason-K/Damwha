import * as React from "react";

import { cn } from "@/shared/lib/utils";

import type { LiveUtterance } from "../model/types";
import { Icon } from "./icons";

/**
 * LiveTranscript — 라이브 발화 목록. 새 행이 오면 바닥으로 따라가되, 사용자가 위로
 * 스크롤하면 멈추고 "자동 따라가기" 버튼으로 복귀한다. 화자는 전부 추정이라 흐린 톤으로
 * 그리고 유사도를 옆에 붙인다. readOnly는 실패한 회의의 보존된 미리보기(설계 §7.2).
 */

const FOLLOW_SLACK_PX = 40;

type LiveTranscriptProps = {
  items: LiveUtterance[];
  readOnly?: boolean;
  className?: string;
};

export function LiveTranscript({
  items,
  readOnly = false,
  className,
}: LiveTranscriptProps) {
  const logRef = React.useRef<HTMLDivElement>(null);
  const [follow, setFollow] = React.useState(true);

  const scrollToBottom = React.useCallback(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  React.useEffect(() => {
    if (follow) scrollToBottom();
  }, [items.length, follow, scrollToBottom]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
    setFollow(atBottom);
  };

  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--surface-card)]",
        className,
      )}
    >
      <div
        ref={logRef}
        role="log"
        aria-label={readOnly ? "녹음 미리보기" : "실시간 전사"}
        aria-live="off"
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-7 pt-4 pb-6"
      >
        {items.length === 0 ? (
          <p className="pt-10 text-center text-sm text-[color:var(--text-muted)]">
            {readOnly ? "남아 있는 발화가 없어요" : "첫 발화를 기다리고 있어요"}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((u) => (
              <li key={u.id} className="flex gap-3 text-base leading-relaxed">
                <span className="w-12 shrink-0 pt-px font-mono text-xs text-[color:var(--text-faint)]">
                  {u.t}
                </span>
                <span className="w-32 shrink-0 truncate text-sm text-[color:var(--text-muted)]">
                  {u.speakerName ?? "화자 ?"}
                  {u.similarity != null ? (
                    <span className="ml-1 text-xs text-[color:var(--text-faint)]">
                      추정 {Math.round(u.similarity * 100)}%
                    </span>
                  ) : null}
                </span>
                <span className="min-w-0 flex-1 text-foreground">{u.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {!follow && !readOnly ? (
        <button
          type="button"
          aria-label="자동 따라가기"
          onClick={() => {
            setFollow(true);
            scrollToBottom();
          }}
          className="absolute bottom-4 left-1/2 inline-flex -translate-x-1/2 cursor-pointer items-center gap-1 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-foreground shadow-none outline-none hover:bg-[var(--gray-2)] focus-visible:[box-shadow:var(--focus-ring)]"
        >
          <Icon name="chevDown" size={13} /> 자동 따라가기
        </button>
      ) : null}
    </div>
  );
}
