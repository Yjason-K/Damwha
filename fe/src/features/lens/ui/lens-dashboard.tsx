import * as React from "react";
import { useSpeakers } from "@/features/speaker/api/speakers";
import { Icon } from "@/features/meeting/ui/icons";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { LENS_KINDS, LENS_META } from "../model/meta";
import type { LensFilters, LensKind } from "../model/types";
import { useLensList, useSetLensCompletion } from "../api/lenses";
import { LensFilterBar } from "./lens-filter-bar";
import { LensExtractionBanner } from "./lens-extraction-banner";
import { LensList } from "./lens-list";

/**
 * LensDashboard — 전역 렌즈 대시보드 셸. kind는 URL(`/lenses/:kind`)에서 오며
 * 상위(pages/lens.tsx)가 읽어 내려준다. 그 외 필터(완료 상태/기한/화자/회의)는
 * 이 컴포넌트가 소유한다. 화자 tint는 화자 목록 순번(1..n)으로 매핑한다.
 */

type Props = {
  lens: LensKind;
  onLens: (k: LensKind) => void;
  onJumpEvidence: (meetingId: string, utteranceId: string) => void;
};

export function LensDashboard({ lens, onLens, onJumpEvidence }: Props) {
  const [filters, setFilters] = React.useState<Omit<LensFilters, "kind">>({
    completion_status: "open",
  });
  const full: LensFilters = { kind: lens, ...filters };
  const list = useLensList(full);
  const completion = useSetLensCompletion();

  const speakers = useSpeakers();
  const speakerIndex = React.useMemo(() => {
    const map = new Map<string, number>();
    (speakers.data ?? []).forEach((s, i) => map.set(s.id, i + 1));
    return map;
  }, [speakers.data]);
  const speakerName = React.useCallback(
    (id: string | null) =>
      id
        ? ((speakers.data ?? []).find((s) => s.id === id)?.name ?? null)
        : null,
    [speakers.data],
  );
  const speakerTint = React.useCallback(
    (id: string | null) => (id ? speakerIndex.get(id) : undefined),
    [speakerIndex],
  );

  // LensList는 onLoadMore의 identity가 바뀔 때마다 IntersectionObserver를
  // 재생성하므로, 매 렌더 새 화살표 대신 안정된 콜백을 전달한다.
  const { fetchNextPage } = list;
  const onLoadMore = React.useCallback(() => {
    fetchNextPage();
  }, [fetchNextPage]);

  const { mutate: setCompletion } = completion;
  const onToggle = React.useCallback(
    (id: string, done: boolean) => setCompletion({ id, done }),
    [setCompletion],
  );

  const meta = LENS_META[lens];
  const pages = list.data?.pages ?? [];
  const isEmpty = list.isSuccess && pages.every((p) => p.items.length === 0);

  return (
    <main className="col-start-2 flex min-w-0 flex-col overflow-hidden bg-[var(--surface-app)]">
      <div className="shrink-0 border-b border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-7 pt-[18px] pb-3.5">
        <div className="flex items-center gap-[9px]">
          <span className="inline-flex text-[color:var(--text-secondary)]">
            <Icon name={meta.icon} size={19} />
          </span>
          <h1 className="text-h2 font-semibold tracking-[-0.01em] text-foreground">
            내 {meta.label}
          </h1>
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
        <div className="mt-3">
          <LensFilterBar
            filters={full}
            onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
        <div className="mx-auto flex max-w-[760px] flex-col gap-3">
          <LensExtractionBanner />
          {list.isLoading && (
            <p
              role="status"
              aria-busy="true"
              className="py-8 text-center text-sm text-[color:var(--text-muted)]"
            >
              불러오는 중…
            </p>
          )}
          {list.isError && (
            <div
              role="alert"
              className="py-8 text-center text-sm text-[color:var(--text-muted)]"
            >
              목록을 불러오지 못했어요.
              <button
                type="button"
                onClick={() => list.refetch()}
                className="ml-2 underline"
              >
                다시 시도
              </button>
            </div>
          )}
          {isEmpty && (
            <p className="py-8 text-center text-sm text-[color:var(--text-muted)]">
              조건에 맞는 {meta.label} 항목이 없어요.
            </p>
          )}
          {list.isSuccess && !isEmpty && (
            <LensList
              pages={pages}
              hasNextPage={!!list.hasNextPage}
              isFetchingNextPage={list.isFetchingNextPage}
              onLoadMore={onLoadMore}
              onToggle={onToggle}
              onJumpEvidence={onJumpEvidence}
              speakerName={speakerName}
              speakerTint={speakerTint}
            />
          )}
        </div>
      </div>
    </main>
  );
}
