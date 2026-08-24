import * as React from "react";

import { Avatar } from "@/shared/ui/avatar";
import { Checkbox } from "@/shared/ui/checkbox";
import { IconButton } from "@/shared/ui/icon-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { cn } from "@/shared/lib/utils";

import type { LensExtractionStatus } from "../api/lenses";
import type { SummaryModel } from "@/features/settings/api/types";
import { SUMMARY_MODEL_OPTIONS } from "@/features/settings/lib/presets";
import type {
  LensEntry,
  LensKind,
  Meeting,
  SummarySegmentView,
} from "../model/types";
import { Icon } from "./icons";

/**
 * InsightPane — right rail: 요약/파일/메모 tabs. The 요약 tab stacks 요약 모델
 * 선택 → 참석자 → 주요 주제 → 다음 할 일 → 핵심 결정 → 단락별 요약; the other
 * tabs show their focused slice. Ported from `timbre_app/InsightPane.jsx`.
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

function Attendees({ meeting }: { meeting: Meeting }) {
  return (
    <Section>
      <SecHead title="참석자" count={meeting.attendees.length} />
      <div className="grid grid-cols-2 gap-x-2 gap-y-[9px]">
        {meeting.attendees.map((a) => {
          const s = meeting.speakers[a];
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

function Decisions({
  lenses,
  onMore,
}: {
  lenses: Partial<Record<LensKind, LensEntry[]>>;
  onMore?: () => void;
}) {
  const items = lenses.decision ?? [];
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
  lenses,
  meeting,
  onToggle,
}: {
  lenses: Partial<Record<LensKind, LensEntry[]>>;
  meeting: Meeting;
  onToggle: (id: string, done: boolean) => void;
}) {
  const items = lenses.action ?? [];
  if (items.length === 0) return null;
  return (
    <Section>
      <SecHead title="다음 할 일" count={items.length} />
      <div className="flex flex-col gap-[11px]">
        {items.map((it) => {
          const w = it.who ? meeting.speakers[it.who] : null;
          const k = w ? ((w.spk - 1) % 8) + 1 : null;
          return (
            <div key={it.id} className="flex items-start gap-[9px]">
              <span className="mt-px">
                <Checkbox
                  aria-label={`완료: ${it.text}`}
                  checked={it.done}
                  onChange={() => onToggle(it.id, !it.done)}
                />
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 text-sm leading-snug text-pretty",
                  it.done
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

function TopicList({ topics }: { topics: string[] }) {
  return (
    <Section>
      <SecHead title="주요 주제" count={topics.length} />
      {topics.length === 0 ? (
        <p className="text-sm text-[color:var(--text-faint)]">
          추출된 주제가 없어요.
        </p>
      ) : (
        <ul className="flex flex-col gap-[9px]">
          {topics.map((t, i) => (
            <li
              key={i}
              className="flex gap-[9px] text-sm leading-normal text-[color:var(--text-secondary)]"
            >
              <span
                aria-hidden="true"
                className="mt-[7px] size-1 shrink-0 rounded-full bg-[var(--accent-solid)]"
              />
              <span className="text-pretty">{t}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function SummarySegments({
  segments,
  onJump,
}: {
  segments: SummarySegmentView[];
  onJump: (utteranceId: string) => void;
}) {
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  if (segments.length === 0) return null;
  return (
    <Section last>
      <SecHead title="단락별 요약" count={segments.length} />
      <ul className="flex flex-col">
        {segments.map((s) => {
          const expanded = !!open[s.id];
          return (
            <li key={s.id} className="flex flex-col">
              {/* 시각(11px mono)과 제목(13px)은 크기도 세로 패딩도 달라
                  items-start로는 글자가 어긋난다 — 베이스라인으로 맞춘다. */}
              <div className="flex items-baseline gap-[7px]">
                <button
                  type="button"
                  aria-label={`${s.t}로 이동`}
                  onClick={() => onJump(s.startUtteranceId)}
                  className="shrink-0 cursor-pointer rounded-xs py-1 font-mono text-2xs text-[color:var(--text-link)] outline-none hover:underline active:translate-y-[0.5px] focus-visible:[box-shadow:var(--focus-ring)]"
                >
                  {s.t}
                </button>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}
                  className="min-w-0 flex-1 cursor-pointer rounded-xs py-1 text-left text-sm leading-snug text-pretty text-foreground outline-none hover:bg-[var(--surface-hover)] active:translate-y-[0.5px] focus-visible:[box-shadow:var(--focus-ring)]"
                >
                  {s.title}
                </button>
              </div>
              {expanded && (
                <ul className="mt-[5px] mb-[9px] ml-[46px] flex flex-col gap-[7px]">
                  {s.bullets.map((b, i) => (
                    <li
                      key={i}
                      className="flex gap-[9px] text-sm leading-normal text-[color:var(--text-secondary)]"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-[7px] size-1 shrink-0 rounded-full bg-[var(--text-faint)]"
                      />
                      <span className="text-pretty">{b}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/**
 * 렌즈 섹션이 비어 있는 이유를 설명하고 실행 길을 준다. `extractionStatus`가
 * null이면 이 처리 버전에서 추출을 돌린 적이 없다는 뜻 — 업로드에서 미뤘거나
 * 워커에 렌즈 모델이 없다. 'done'이면 돌렸는데 뽑을 게 없었던 것이라 아무것도
 * 그리지 않는다(0건이면 섹션이 스스로 사라진다는 제품 원칙 유지).
 */
function LensState({
  meetingStatus,
  status,
  onExtract,
  extracting,
}: {
  meetingStatus: Meeting["status"];
  status: LensExtractionStatus | null;
  onExtract: () => void;
  extracting: boolean;
}) {
  if (status === "done") return null;
  if (status === "queued" || status === "running" || extracting) {
    return (
      <Section>
        <div role="status" aria-busy="true">
          <p className="text-sm text-[color:var(--text-muted)]">
            할 일과 결정을 찾고 있어요
          </p>
        </div>
      </Section>
    );
  }
  // 처리가 끝나기 전에는 서버가 추출 요청을 409로 막는다. 같은 안내를 요약
  // 블록이 이미 하고 있어 여기서는 아무것도 더 얹지 않는다.
  if (meetingStatus !== "done") return null;
  return (
    <Section>
      <div
        className="flex flex-col items-start gap-2"
        {...(status === "failed" ? { role: "alert" } : {})}
      >
        <p className="text-sm text-[color:var(--text-faint)]">
          {status === "failed"
            ? "할 일과 결정을 찾지 못했어요."
            : "아직 할 일과 결정을 찾지 않았어요."}
        </p>
        <button
          type="button"
          onClick={onExtract}
          className="cursor-pointer rounded-xs text-xs font-medium text-[color:var(--text-link)] outline-none hover:underline active:translate-y-[0.5px] focus-visible:[box-shadow:var(--focus-ring)]"
        >
          {status === "failed" ? "다시 찾기" : "지금 찾기"}
        </button>
      </div>
    </Section>
  );
}

function SummaryState({
  meetingStatus,
  status,
  onRegenerate,
  regenerating,
}: {
  meetingStatus: Meeting["status"];
  status: Meeting["summaryStatus"];
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  if (status === "queued" || status === "running" || regenerating) {
    return (
      <Section>
        <div role="status" aria-busy="true">
          <p className="text-sm text-[color:var(--text-muted)]">
            요약을 만들고 있어요
          </p>
        </div>
      </Section>
    );
  }
  // 회의 처리가 끝나지 않은 동안은 요약 생성 요청이 서버에서 항상 거부된다
  // (409). 만들기/다시 만들기 버튼 대신 안내만 보여준다.
  if (meetingStatus !== "done") {
    return (
      <Section>
        <p className="text-sm text-[color:var(--text-faint)]">
          대화 처리가 끝나야 요약을 만들 수 있어요.
        </p>
      </Section>
    );
  }
  if (status === "failed") {
    return (
      <Section>
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="text-sm text-[color:var(--text-muted)]">
            요약을 만들지 못했어요.
          </p>
          <button
            type="button"
            onClick={onRegenerate}
            className="cursor-pointer rounded-xs text-xs font-medium text-[color:var(--text-link)] outline-none hover:underline active:translate-y-[0.5px] focus-visible:[box-shadow:var(--focus-ring)]"
          >
            요약 다시 만들기
          </button>
        </div>
      </Section>
    );
  }
  // status === null — 요약이 한 번도 만들어지지 않은 회의(워커에 요약 모델이
  // 설정되지 않았거나 이 회의가 그 전에 처리됨). 빈 화면 대신 만들 길을 준다.
  return (
    <Section>
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-[color:var(--text-faint)]">
          아직 요약이 없어요.
        </p>
        <button
          type="button"
          onClick={onRegenerate}
          className="cursor-pointer rounded-xs text-xs font-medium text-[color:var(--text-link)] outline-none hover:underline active:translate-y-[0.5px] focus-visible:[box-shadow:var(--focus-ring)]"
        >
          요약 만들기
        </button>
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
  lenses: Partial<Record<LensKind, LensEntry[]>>;
  tab: string;
  onTab: (tab: string) => void;
  onToggle: (id: string, done: boolean) => void;
  onOpenLens: (lens: LensKind) => void;
  onJumpSegment: (utteranceId: string) => void;
  onRegenerateSummary: () => void;
  summaryModel: SummaryModel | undefined;
  onSummaryModelChange: (model: SummaryModel) => void;
  regenerating: boolean;
  /** 현재 처리 버전의 렌즈 추출 상태. null = 이 버전에서 돌린 적 없음. */
  lensExtractionStatus: LensExtractionStatus | null;
  onExtractLenses: () => void;
  extracting: boolean;
};

export function InsightPane({
  meeting,
  lenses,
  tab,
  onTab,
  onToggle,
  onOpenLens,
  onJumpSegment,
  onRegenerateSummary,
  summaryModel,
  onSummaryModelChange,
  regenerating,
  lensExtractionStatus,
  onExtractLenses,
  extracting,
}: InsightPaneProps) {
  const settled = meeting.summaryStatus === "done" && !regenerating;
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
        <div className="flex shrink-0 items-center border-b border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-3 pt-1">
          <TabsList className="border-b-0">
            <TabsTrigger value="summary">요약</TabsTrigger>
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
          {tab === "summary" && settled && (
            <IconButton
              label="요약 다시 만들기"
              size="sm"
              className="ml-auto"
              onClick={onRegenerateSummary}
            >
              <Icon name="rotateCcw" size={14} />
            </IconButton>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TabsContent value="summary" className="mt-0">
            {meeting.status === "done" && (
              <div className="flex items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2">
                <span className="text-xs text-[color:var(--text-muted)]">
                  재생성 모델
                </span>
                <Select
                  value={summaryModel}
                  onValueChange={(v) => onSummaryModelChange(v as SummaryModel)}
                >
                  <SelectTrigger aria-label="요약 모델" size="sm">
                    <SelectValue placeholder="전역 설정" />
                  </SelectTrigger>
                  <SelectContent>
                    {SUMMARY_MODEL_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <Attendees meeting={meeting} />
            {settled ? (
              <TopicList topics={meeting.topics} />
            ) : (
              <SummaryState
                meetingStatus={meeting.status}
                status={meeting.summaryStatus}
                onRegenerate={onRegenerateSummary}
                regenerating={regenerating}
              />
            )}
            <Todos lenses={lenses} meeting={meeting} onToggle={onToggle} />
            <Decisions lenses={lenses} onMore={() => onOpenLens("decision")} />
            <LensState
              meetingStatus={meeting.status}
              status={lensExtractionStatus}
              onExtract={onExtractLenses}
              extracting={extracting}
            />
            {settled && (
              <SummarySegments
                segments={meeting.segments}
                onJump={onJumpSegment}
              />
            )}
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
