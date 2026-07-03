import * as React from "react";

import { Avatar } from "@/shared/ui/avatar";
import { Checkbox } from "@/shared/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { Tag } from "@/shared/ui/tag";
import { cn } from "@/shared/lib/utils";

import { SPEAKERS, type LensKind, type Meeting } from "../model/data";
import { Icon } from "./icons";

/**
 * InsightPane — right rail: 요약/참석자/파일/메모 tabs. The 요약 tab stacks the
 * kit's sections (참석자 · 회의 요약 · 핵심 결정 · 할 일 · 토픽); the other tabs
 * show their focused slice. Ported from `timbre_app/InsightPane.jsx`.
 */

function CheckCircle() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5 8l2 2 4-4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SecHead({
  title,
  count,
  onMore,
}: {
  title: string;
  count?: number;
  onMore?: () => void;
}) {
  return (
    <div className="mb-[11px] flex items-center gap-[7px]">
      <span className="text-base font-semibold tracking-[-0.01em] text-foreground">
        {title}
      </span>
      {count != null && (
        <span className="font-mono text-xs text-[color:var(--text-faint)]">
          {count}
        </span>
      )}
      <div className="flex-1" />
      {onMore && (
        <button
          type="button"
          onClick={onMore}
          className="cursor-pointer rounded-xs text-xs font-medium text-[color:var(--text-link)] outline-none hover:underline focus-visible:[box-shadow:var(--focus-ring)]"
        >
          모두 보기
        </button>
      )}
    </div>
  );
}

function Section({
  children,
  last,
}: {
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        "px-4 py-4",
        !last && "border-b border-[color:var(--border-subtle)]",
      )}
    >
      {children}
    </div>
  );
}

function Attendees({
  meeting,
  onMore,
}: {
  meeting: Meeting;
  onMore?: () => void;
}) {
  return (
    <Section>
      <SecHead
        title="참석자"
        count={meeting.attendees.length}
        onMore={onMore}
      />
      <div className="grid grid-cols-2 gap-x-2 gap-y-[9px]">
        {meeting.attendees.map((a) => {
          const s = SPEAKERS[a];
          return (
            <div key={a} className="flex min-w-0 items-center gap-[7px]">
              <Avatar
                name={s.name}
                speaker={s.spk}
                size="sm"
                unconfirmed={(meeting.unverified ?? []).includes(a)}
              />
              <span className="text-xs font-semibold whitespace-nowrap text-foreground">
                {s.name}
              </span>
              <span className="truncate text-2xs text-[color:var(--text-faint)]">
                {s.role}
              </span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function Summary({ meeting }: { meeting: Meeting }) {
  return (
    <Section>
      <SecHead title="회의 요약" />
      <ul className="flex flex-col gap-[9px]">
        {meeting.summary.map((s, i) => (
          <li
            key={i}
            className="flex gap-[9px] text-sm leading-normal text-[color:var(--text-secondary)]"
          >
            <span
              aria-hidden="true"
              className="mt-[7px] size-1 shrink-0 rounded-full bg-[var(--accent-9)]"
            />
            <span className="text-pretty">{s}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Decisions({
  meeting,
  onMore,
}: {
  meeting: Meeting;
  onMore?: () => void;
}) {
  const items = meeting.lenses.decision ?? [];
  if (items.length === 0) return null;
  return (
    <Section>
      <SecHead title="핵심 결정" count={items.length} onMore={onMore} />
      <div className="flex flex-col gap-[9px]">
        {items.map((it) => (
          <div key={it.id} className="flex items-start gap-[9px]">
            <span className="mt-px shrink-0 text-[color:var(--accent-solid)]">
              <CheckCircle />
            </span>
            <span className="min-w-0 flex-1 text-sm leading-snug text-pretty text-foreground">
              {it.text}
            </span>
            <span className="mt-px shrink-0 text-[color:var(--green-9)]">
              <Icon name="check" size={14} strokeWidth={2.2} />
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Todos({
  meeting,
  done,
  onToggle,
}: {
  meeting: Meeting;
  done: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  const items = meeting.lenses.action ?? [];
  if (items.length === 0) return null;
  return (
    <Section>
      <SecHead title="할 일" count={items.length} />
      <div className="flex flex-col gap-[11px]">
        {items.map((it) => {
          const w = it.who ? SPEAKERS[it.who] : null;
          const k = w ? ((w.spk - 1) % 8) + 1 : null;
          return (
            <div key={it.id} className="flex items-start gap-[9px]">
              <span className="mt-px">
                <Checkbox
                  aria-label={`완료: ${it.text}`}
                  checked={!!done[it.id]}
                  onChange={() => onToggle(it.id)}
                />
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 text-sm leading-snug text-pretty",
                  done[it.id]
                    ? "text-[color:var(--text-muted)] line-through"
                    : "text-foreground",
                )}
              >
                {it.text}
              </span>
              {w && k && (
                <span className="inline-flex shrink-0 items-center gap-[5px]">
                  <span
                    className="inline-flex items-center gap-1 rounded-full py-0.5 pr-[7px] pl-0.5 text-2xs font-semibold"
                    style={{
                      color: `var(--spk-${k}-text)`,
                      background: `var(--spk-${k}-bg)`,
                    }}
                  >
                    <span
                      className="inline-flex size-3.5 items-center justify-center rounded-full text-[8px] font-semibold text-white"
                      style={{ background: `var(--spk-${k}-solid)` }}
                    >
                      {w.name.slice(-2, -1)}
                    </span>
                    {w.name}
                  </span>
                  {it.due && (
                    <span className="font-mono text-2xs text-[color:var(--text-faint)]">
                      {it.due}
                    </span>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function Topics({ meeting }: { meeting: Meeting }) {
  return (
    <Section last>
      <SecHead title="토픽" count={meeting.topics.length} />
      <div className="flex flex-wrap gap-[7px]">
        {meeting.topics.map((t, i) => (
          <Tag key={i} speaker={t.spk}>
            {t.label}
          </Tag>
        ))}
      </div>
    </Section>
  );
}

function Files({ meeting }: { meeting: Meeting }) {
  if (meeting.files.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <Icon
          name="folder"
          size={20}
          className="text-[color:var(--text-faint)]"
        />
        <p className="text-sm text-[color:var(--text-muted)]">
          공유된 파일이 없어요.
        </p>
      </div>
    );
  }
  return (
    <Section last>
      <SecHead title="파일" count={meeting.files.length} />
      <ul className="flex flex-col gap-1">
        {meeting.files.map((f) => (
          <li
            key={f.name}
            className="flex items-center gap-2 rounded-sm px-1.5 py-1.5 transition-colors hover:bg-[var(--surface-hover)]"
          >
            <Icon
              name="file"
              size={15}
              className="text-[color:var(--text-muted)]"
            />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {f.name}
            </span>
            <span className="shrink-0 font-mono text-2xs text-[color:var(--text-faint)]">
              {f.size}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Notes() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <Icon
        name="pencil"
        size={20}
        className="text-[color:var(--text-faint)]"
      />
      <p className="text-sm text-[color:var(--text-muted)]">
        아직 메모가 없어요.
      </p>
      <p className="text-xs text-[color:var(--text-faint)]">
        회의 중 남긴 메모가 여기에 모여요.
      </p>
    </div>
  );
}

type InsightPaneProps = {
  meeting: Meeting;
  tab: string;
  onTab: (tab: string) => void;
  done: Record<string, boolean>;
  onToggle: (id: string) => void;
  onOpenLens: (lens: LensKind) => void;
};

export function InsightPane({
  meeting,
  tab,
  onTab,
  done,
  onToggle,
  onOpenLens,
}: InsightPaneProps) {
  return (
    <aside
      aria-label="인사이트"
      className="flex w-[var(--rail-insight)] shrink-0 flex-col overflow-hidden border-l border-border bg-[var(--surface-panel)]"
    >
      <Tabs
        value={tab}
        onValueChange={onTab}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="shrink-0 border-b border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-3 pt-1">
          <TabsList className="border-b-0">
            <TabsTrigger value="summary">요약</TabsTrigger>
            <TabsTrigger value="people">참석자</TabsTrigger>
            <TabsTrigger value="files">
              파일
              {meeting.files.length > 0 && (
                <span className="rounded-xs bg-[var(--gray-3)] px-[5px] py-px font-mono text-2xs text-[color:var(--text-faint)]">
                  {meeting.files.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="notes">메모</TabsTrigger>
          </TabsList>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TabsContent value="summary" className="mt-0">
            <Attendees meeting={meeting} onMore={() => onTab("people")} />
            <Summary meeting={meeting} />
            <Decisions
              meeting={meeting}
              onMore={() => onOpenLens("decision")}
            />
            <Todos meeting={meeting} done={done} onToggle={onToggle} />
            <Topics meeting={meeting} />
          </TabsContent>
          <TabsContent value="people" className="mt-0">
            <Attendees meeting={meeting} />
          </TabsContent>
          <TabsContent value="files" className="mt-0">
            <Files meeting={meeting} />
          </TabsContent>
          <TabsContent value="notes" className="mt-0">
            <Notes />
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}
