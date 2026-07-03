import * as React from "react";

import { Badge } from "@/shared/ui/badge";
import { LensItem } from "@/shared/ui/lens-item";
import { SearchField } from "@/shared/ui/search-field";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";

import {
  LENS_KINDS,
  LENS_META,
  MEETING_ORDER,
  MEETINGS,
  SPEAKERS,
  shortDate,
  type LensKind,
} from "../model/data";
import { Icon } from "./icons";

/**
 * LensView — the global (전역) lens: one item type aggregated across every
 * meeting, grouped by meeting. Ported from `timbre_app/LensView.jsx`; the
 * kit's hardcoded cross-meeting extras live on their owning meetings in the
 * mock corpus, so this view aggregates for real.
 */

type GlobalLensEntry = {
  id: string;
  text: string;
  source: "ai" | "user" | "edited" | "hint";
  who?: number;
  ev: string;
  mid: string;
  mtg: string;
  date: string;
};

function collect(lens: LensKind): GlobalLensEntry[] {
  return MEETING_ORDER.flatMap((mid) => {
    const m = MEETINGS[mid];
    return (m.lenses[lens] ?? []).map((it) => ({
      id: it.id,
      text: it.text,
      source: it.source,
      who: it.who,
      ev: it.ev,
      mid,
      mtg: m.subOverride ?? m.title,
      date: shortDate(m.date),
    }));
  });
}

function groupByMeeting(items: GlobalLensEntry[]) {
  const map = new Map<
    string,
    { mid: string; mtg: string; date: string; items: GlobalLensEntry[] }
  >();
  for (const it of items) {
    if (!map.has(it.mid))
      map.set(it.mid, { mid: it.mid, mtg: it.mtg, date: it.date, items: [] });
    map.get(it.mid)!.items.push(it);
  }
  return [...map.values()];
}

type LensViewProps = {
  lens: LensKind;
  onLens: (lens: LensKind) => void;
  done: Record<string, boolean>;
  onToggle: (id: string) => void;
  onJump: (mid: string) => void;
};

export function LensView({
  lens,
  onLens,
  done,
  onToggle,
  onJump,
}: LensViewProps) {
  const [query, setQuery] = React.useState("");
  const meta = LENS_META[lens];

  const q = query.trim();
  const all = collect(lens).filter(
    (it) => !q || it.text.includes(q) || it.mtg.includes(q),
  );
  const groups = groupByMeeting(all);

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--surface-app)]">
      <div className="shrink-0 border-b border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-7 pt-[18px] pb-3.5">
        <div className="flex items-center gap-[9px]">
          <span className="inline-flex text-[color:var(--text-secondary)]">
            <Icon name={meta.icon} size={19} />
          </span>
          <h1 className="text-h2 font-semibold tracking-[-0.01em] text-foreground">
            내 {meta.label}
          </h1>
          <Badge variant="neutral">{all.length}</Badge>
          <div className="flex-1" />
          <div className="w-60">
            <SearchField
              placeholder={`${meta.label} 안에서 검색…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-3">
          <Tabs
            value={lens}
            onValueChange={(v) => onLens(v as LensKind)}
            className="gap-0"
          >
            <TabsList>
              {LENS_KINDS.map((k) => (
                <TabsTrigger key={k} value={k}>
                  {LENS_META[k].label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-[18px] pb-7">
        <div className="mx-auto flex max-w-[760px] flex-col gap-[18px]">
          {groups.length === 0 && (
            <p className="py-10 text-center text-sm text-[color:var(--text-muted)]">
              결과가 없어요. 다른 검색어를 시도해 보세요.
            </p>
          )}
          {groups.map((grp) => (
            <div key={grp.mid}>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-xs font-semibold text-[color:var(--text-secondary)]">
                  {grp.mtg}
                </span>
                <span className="font-mono text-2xs text-[color:var(--text-faint)]">
                  {grp.date}
                </span>
                <div
                  aria-hidden="true"
                  className="h-px flex-1 bg-[var(--border-subtle)]"
                />
              </div>
              <div className="flex flex-col gap-2">
                {grp.items.map((it) => (
                  <LensItem
                    key={it.id}
                    checkable={lens === "action"}
                    done={!!done[it.id]}
                    onToggle={() => onToggle(it.id)}
                    source={it.source}
                    assignee={it.who ? SPEAKERS[it.who].name : undefined}
                    assigneeSpeaker={it.who ? SPEAKERS[it.who].spk : undefined}
                    evidence={it.ev}
                    onJump={() => onJump(it.mid)}
                  >
                    {it.text}
                  </LensItem>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
