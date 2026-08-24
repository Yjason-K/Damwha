import * as React from "react";
import { useMeetings } from "@/features/meeting/api/meetings";
import { useSpeakers } from "@/features/speaker/api/speakers";
import { cn } from "@/shared/lib/utils";
import { DatePicker } from "@/shared/ui/date-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import type { LensCompletionStatus, LensFilters } from "../model/types";

/**
 * LensFilterBar — 렌즈 대시보드 필터 바. 완료 상태는 BE 단일값 제약이라
 * 열림/완료 세그먼트로, 기한은 due_at 기준 from~to DatePicker, 화자/회의는
 * Select(전체 옵션 포함)로 고른다.
 */

type Props = {
  filters: LensFilters;
  onChange: (patch: Partial<LensFilters>) => void;
};

const COMPLETION_ITEMS: [LensCompletionStatus, string][] = [
  ["open", "열림"],
  ["done", "완료"],
];

const ALL_SPEAKERS = "__all_speakers__";
const ALL_MEETINGS = "__all_meetings__";

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fromISODate(s: string | undefined): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export function LensFilterBar({ filters, onChange }: Props) {
  const speakers = useSpeakers();
  const meetings = useMeetings();
  const dueLabelId = React.useId();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        role="group"
        aria-label="완료 상태"
        className="inline-flex rounded-sm border border-border p-0.5"
      >
        {COMPLETION_ITEMS.map(([status, label]) => {
          const active = filters.completion_status === status;
          return (
            <button
              key={status}
              type="button"
              aria-pressed={active}
              onClick={() => onChange({ completion_status: status })}
              className={cn(
                "cursor-pointer rounded-xs px-2.5 py-1 text-sm font-medium outline-none transition-colors duration-[80ms] focus-visible:[box-shadow:var(--focus-ring)]",
                active
                  ? "bg-[var(--gray-2)] text-foreground"
                  : "text-[color:var(--text-muted)] hover:text-foreground",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div
        role="group"
        aria-labelledby={dueLabelId}
        className="flex items-center gap-1.5"
      >
        <span id={dueLabelId} className="sr-only">
          기한
        </span>
        <DatePicker
          placeholder="시작일"
          value={fromISODate(filters.date_from)}
          onChange={(d) =>
            onChange({ date_from: d ? toISODate(d) : undefined })
          }
        />
        <span
          aria-hidden="true"
          className="text-sm text-[color:var(--text-muted)]"
        >
          ~
        </span>
        <DatePicker
          placeholder="종료일"
          value={fromISODate(filters.date_to)}
          onChange={(d) => onChange({ date_to: d ? toISODate(d) : undefined })}
        />
      </div>

      <Select
        value={filters.speaker_id ?? ALL_SPEAKERS}
        onValueChange={(v) =>
          onChange({ speaker_id: v === ALL_SPEAKERS ? undefined : v })
        }
      >
        <SelectTrigger size="sm" className="w-[136px]" aria-label="화자">
          <SelectValue placeholder="화자" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_SPEAKERS}>모든 화자</SelectItem>
          {(speakers.data ?? []).map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.meeting_id ?? ALL_MEETINGS}
        onValueChange={(v) =>
          onChange({ meeting_id: v === ALL_MEETINGS ? undefined : v })
        }
      >
        <SelectTrigger size="sm" className="w-[160px]" aria-label="회의">
          <SelectValue placeholder="회의" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_MEETINGS}>모든 회의</SelectItem>
          {(meetings.data ?? []).map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
