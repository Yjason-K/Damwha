import * as React from "react";

import { isDemoBlocked } from "@/shared/api/demo-read-only";
import { isApiError } from "@/shared/api/client";
import { Input } from "@/shared/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Tag } from "@/shared/ui/tag";
import { toast } from "@/shared/ui/use-toast";

import { useSetMeetingTags, useTags } from "../api/tags";
import type { MeetingTag } from "../model/types";
import { Icon } from "./icons";

// 서버(TagsService)와 같은 상한 — 넘기면 400이므로 화면에서 먼저 막는다.
const MAX_TAGS = 20;
const MAX_NAME_LENGTH = 30;
const MAX_SUGGESTIONS = 8;

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function MeetingTags({
  meetingId,
  tags,
  suggestions: recommended = [],
}: {
  meetingId: string;
  tags: MeetingTag[];
  suggestions?: string[];
}) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const { data: allTags = [] } = useTags();
  const setTags = useSetMeetingTags();

  const save = (names: string[]) =>
    setTags.mutate(
      { id: meetingId, names },
      {
        onError: (err) => {
          if (isDemoBlocked(err)) return;
          toast({
            variant: "error",
            title: "태그를 바꾸지 못했어요.",
            description: isApiError(err) ? err.message : undefined,
          });
        },
      },
    );

  const names = tags.map((t) => t.name);
  const full = tags.length >= MAX_TAGS;

  const add = (raw: string) => {
    const name = raw.trim();
    setDraft("");
    if (!name || full || names.some((n) => sameName(n, name))) return;
    save([...names, name]);
  };

  const query = draft.trim().toLowerCase();
  const suggestions = allTags
    .filter((t) => !names.some((n) => sameName(n, t.name)))
    .filter((t) => t.name.toLowerCase().includes(query))
    .slice(0, MAX_SUGGESTIONS);

  return (
    <div
      role="group"
      aria-label="태그"
      className="flex flex-wrap items-center gap-1.5"
    >
      {tags.map((t) => (
        <Tag
          key={t.id}
          removeLabel={`태그 ${t.name} 떼기`}
          onRemove={() => save(names.filter((n) => n !== t.name))}
        >
          #{t.name}
        </Tag>
      ))}
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setDraft("");
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={full}
            className="inline-flex h-[22px] cursor-pointer items-center gap-1 rounded-xs px-1.5 text-xs font-medium text-[color:var(--text-muted)] outline-none transition-colors duration-[80ms] hover:bg-[var(--surface-hover)] hover:text-[color:var(--text-secondary)] focus-visible:[box-shadow:var(--focus-ring)] disabled:cursor-default disabled:opacity-60 [&_svg]:size-3"
          >
            <Icon name="hash" size={12} />
            {tags.length === 0 ? "태그 추가" : "추가"}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-60 p-2">
          <Input
            inputSize="sm"
            autoFocus
            aria-label="새 태그 이름"
            placeholder="태그 이름 입력 후 Enter"
            maxLength={MAX_NAME_LENGTH}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // 한글 조합 중 Enter는 음절 확정이지 제출이 아니다.
              if (e.nativeEvent.isComposing || e.key !== "Enter") return;
              e.preventDefault();
              add(draft);
            }}
          />
          {suggestions.length > 0 && (
            <ul className="mt-1.5 flex flex-col" aria-label="기존 태그">
              {suggestions.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => add(t.name)}
                    className="flex w-full cursor-pointer items-center justify-between rounded-xs px-2 py-1.5 text-left text-sm text-[color:var(--text-secondary)] outline-none hover:bg-[var(--surface-hover)] focus-visible:[box-shadow:var(--focus-ring)]"
                  >
                    <span className="truncate">#{t.name}</span>
                    <span className="shrink-0 text-xs text-[color:var(--text-faint)]">
                      {t.meetingCount}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </PopoverContent>
      </Popover>
      {!full && recommended.length > 0 && (
        <>
          <span className="ml-1 text-xs text-[color:var(--text-faint)]">
            추천
          </span>
          {recommended.map((name) => (
            <button
              key={name}
              type="button"
              aria-label={`추천 태그 ${name} 붙이기`}
              onClick={() => add(name)}
              className="inline-flex h-[22px] cursor-pointer items-center rounded-xs border border-dashed border-[color:var(--border-strong)] px-1.5 text-xs font-medium text-[color:var(--text-muted)] outline-none transition-colors duration-[80ms] hover:border-[color:var(--accent-6)] hover:bg-[var(--accent-bg)] hover:text-[color:var(--accent-text)] focus-visible:[box-shadow:var(--focus-ring)]"
            >
              +#{name}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
