import * as React from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import { Button } from "@/shared/ui/button";
import { SegmentedControl } from "@/shared/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { cn } from "@/shared/lib/utils";
import { LensOverview } from "@/features/lens/ui/lens-overview";
import { useFolders } from "@/features/meeting/api/folders";
import { useMeetings } from "@/features/meeting/api/meetings";
import {
  matchesTab,
  PAGE_SIZE,
  readListParams,
  sortMeetings,
  type MeetingListSort,
  type MeetingListTab,
} from "@/features/meeting/lib/meeting-list";
import { CenterState, Spinner } from "@/features/meeting/ui/center-state";
import { Icon } from "@/features/meeting/ui/icons";
import { MeetingCard } from "@/features/meeting/ui/meeting-card";
import { MeetingDropzone } from "@/features/meeting/ui/meeting-dropzone";
import { NewMeetingDialog } from "@/features/meeting/ui/new-meeting-dialog";
import { useSpeakers } from "@/features/speaker/api/speakers";

const TAB_OPTIONS: { value: MeetingListTab; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "mine", label: "내가 참여한 회의" },
  { value: "decisions", label: "결정 있는 회의" },
  { value: "fav", label: "즐겨찾기" },
];

const SORT_LABEL: Record<MeetingListSort, string> = {
  newest: "최신순",
  oldest: "오래된순",
  longest: "긴 회의순",
};

const linkClass =
  "rounded-xs text-sm font-medium text-[color:var(--text-link)] underline-offset-2 outline-none hover:underline focus-visible:[box-shadow:var(--focus-ring)]";

/** 보여 줄 페이지 번호 — 현재 페이지를 가운데 두고 최대 5개. */
function pageWindow(page: number, last: number): number[] {
  const start = Math.max(1, Math.min(page - 2, last - 4));
  const end = Math.min(last, start + 4);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border px-6 py-14 text-center">
      {children}
    </div>
  );
}

/**
 * `/meetings`(전체)와 `/folders/:folderId`(폴더)의 카드형 회의 목록. 데이터는 사이드바와
 * 같은 `useMeetings()` 캐시이고, 거르기·정렬·페이지 나누기는 여기서 한다(스펙 §2.4).
 * 탭·정렬·페이지는 URL 검색 파라미터라 회의를 열었다 돌아와도 유지된다(§2.3).
 */
export function MeetingListPage() {
  const { folderId } = useParams();
  const [params, setParams] = useSearchParams();
  const { tab, sort, page } = readListParams(params);
  const meetings = useMeetings();
  const folders = useFolders();
  const speakers = useSpeakers();
  const navigate = useNavigate();
  const [newMeeting, setNewMeeting] = React.useState<{
    source: "file" | "live";
    file: File | null;
  } | null>(null);

  const update = (next: {
    tab?: MeetingListTab;
    sort?: MeetingListSort;
    page?: number;
  }) => {
    const p = new URLSearchParams(params);
    const set = (key: string, value: string | null) =>
      value ? p.set(key, value) : p.delete(key);
    if (next.tab !== undefined) {
      set("tab", next.tab === "all" ? null : next.tab);
      p.delete("page");
    }
    if (next.sort !== undefined) {
      set("sort", next.sort === "newest" ? null : next.sort);
      p.delete("page");
    }
    if (next.page !== undefined)
      set("page", next.page > 1 ? String(next.page) : null);
    setParams(p);
  };

  if (meetings.isPending || (folderId && folders.isPending)) {
    return (
      <CenterState busy className="col-start-2">
        <Spinner />
        <p className="text-sm text-[color:var(--text-muted)]">
          회의를 불러오는 중…
        </p>
      </CenterState>
    );
  }

  if (meetings.isError || (folderId && folders.isError)) {
    return (
      <CenterState className="col-start-2">
        <Icon
          name="inbox"
          size={22}
          className="text-[color:var(--text-faint)]"
        />
        <p className="text-sm text-[color:var(--text-muted)]">
          회의를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void meetings.refetch();
            if (folderId) void folders.refetch();
          }}
        >
          다시 시도
        </Button>
      </CenterState>
    );
  }

  const folder = folderId
    ? folders.data?.find((f) => f.id === folderId)
    : undefined;
  if (folderId && !folder) {
    return (
      <CenterState className="col-start-2">
        <Icon
          name="folder"
          size={22}
          className="text-[color:var(--text-faint)]"
        />
        <p className="text-base font-semibold text-foreground">
          폴더를 찾을 수 없어요
        </p>
        <Link to="/meetings" className={linkClass}>
          전체 회의
        </Link>
      </CenterState>
    );
  }

  const scoped = folderId
    ? meetings.data.filter((m) => m.folderId === folderId)
    : meetings.data;
  const noMe =
    tab === "mine" && speakers.isSuccess && !speakers.data.some((s) => s.isMe);
  const rows = sortMeetings(
    scoped.filter((m) => matchesTab(m, tab)),
    sort,
  );
  const lastPage = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, lastPage);
  const from = (current - 1) * PAGE_SIZE;
  const visible = rows.slice(from, from + PAGE_SIZE);
  const now = new Date();

  return (
    <main className="col-start-2 h-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-8">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-h1 font-semibold text-foreground">
            {folder ? folder.name : "전체 회의"}
          </h1>
          <span
            aria-label={`회의 ${scoped.length}개`}
            className="rounded-xs bg-[var(--gray-3)] px-[7px] py-[3px] text-xs font-medium text-[color:var(--text-muted)]"
          >
            {scoped.length}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <SegmentedControl
              aria-label="회의 범위"
              options={TAB_OPTIONS}
              value={tab}
              onChange={(value) => update({ tab: value })}
            />
            <Select
              value={sort}
              onValueChange={(value) =>
                update({ sort: value as MeetingListSort })
              }
            >
              <SelectTrigger size="sm" aria-label="정렬" className="w-auto">
                <span className="text-[color:var(--text-muted)]">정렬:</span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {(Object.keys(SORT_LABEL) as MeetingListSort[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {SORT_LABEL[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </header>

        <MeetingDropzone
          compact={scoped.length > 0}
          onFile={(file) => setNewMeeting({ source: "file", file })}
          onRecord={() => setNewMeeting({ source: "live", file: null })}
        />
        <NewMeetingDialog
          open={newMeeting !== null}
          onOpenChange={(open) => {
            if (!open) setNewMeeting(null);
          }}
          onCreated={(id) => navigate(`/meetings/${id}`)}
          defaultFolderId={folderId}
          initialSource={newMeeting?.source}
          initialFile={newMeeting?.file}
        />

        {scoped.length === 0 ? null : (
          <>
            <LensOverview folderId={folderId} />
            {noMe ? (
              <EmptyNote>
                <p className="text-sm text-[color:var(--text-muted)]">
                  화자 관리에서 &lsquo;나&rsquo;를 지정하면 내가 참여한 회의만
                  모아 볼 수 있어요.
                </p>
                <Link to="/speakers" className={linkClass}>
                  화자 관리로 가기
                </Link>
              </EmptyNote>
            ) : visible.length === 0 ? (
              <EmptyNote>
                <p className="text-sm text-[color:var(--text-muted)]">
                  조건에 맞는 회의가 없어요.
                </p>
              </EmptyNote>
            ) : (
              <>
                <ul aria-label="회의 목록" className="flex flex-col gap-2">
                  {visible.map((m) => (
                    <li key={m.id}>
                      <MeetingCard meeting={m} now={now} />
                    </li>
                  ))}
                </ul>
                <footer className="flex items-center justify-between gap-4 pt-1">
                  <p className="text-sm text-[color:var(--text-muted)]">
                    표시 중: {from + 1}–{from + visible.length} / 총{" "}
                    {rows.length}개 회의
                  </p>
                  {lastPage > 1 ? (
                    <nav
                      aria-label="페이지"
                      className="flex items-center gap-1"
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={current === 1}
                        onClick={() => update({ page: current - 1 })}
                      >
                        이전
                      </Button>
                      {pageWindow(current, lastPage).map((n) => (
                        <Button
                          key={n}
                          variant="ghost"
                          size="sm"
                          aria-label={`${n}페이지`}
                          aria-current={n === current ? "page" : undefined}
                          className={cn(
                            "min-w-7 px-2",
                            n === current &&
                              "bg-[var(--accent-bg)] text-[color:var(--accent-text)] hover:bg-[var(--accent-bg)] hover:text-[color:var(--accent-text)]",
                          )}
                          onClick={() => update({ page: n })}
                        >
                          {n}
                        </Button>
                      ))}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={current === lastPage}
                        onClick={() => update({ page: current + 1 })}
                      >
                        다음
                      </Button>
                    </nav>
                  ) : null}
                </footer>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
