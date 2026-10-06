import type { MeetingSummary } from "../model/types";

export type MeetingListTab = "all" | "mine" | "decisions" | "fav";
export type MeetingListSort = "newest" | "oldest" | "longest";

export const PAGE_SIZES = [10, 20, 30] as const;
export type MeetingListPageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: MeetingListPageSize = 10;

const TABS: MeetingListTab[] = ["all", "mine", "decisions", "fav"];
const SORTS: MeetingListSort[] = ["newest", "oldest", "longest"];

/** URL 검색 파라미터를 읽는다. 모르는 값은 기본값(`전체`·`최신순`·1페이지·10개씩)으로 본다. */
export function readListParams(params: URLSearchParams): {
  tab: MeetingListTab;
  sort: MeetingListSort;
  page: number;
  size: MeetingListPageSize;
} {
  const tab = params.get("tab");
  const sort = params.get("sort");
  const page = Number.parseInt(params.get("page") ?? "", 10);
  const size = Number(params.get("size"));
  return {
    tab: TABS.includes(tab as MeetingListTab) ? (tab as MeetingListTab) : "all",
    sort: SORTS.includes(sort as MeetingListSort)
      ? (sort as MeetingListSort)
      : "newest",
    page: Number.isFinite(page) && page > 0 ? page : 1,
    size: PAGE_SIZES.includes(size as MeetingListPageSize)
      ? (size as MeetingListPageSize)
      : DEFAULT_PAGE_SIZE,
  };
}

export function matchesTab(m: MeetingSummary, tab: MeetingListTab): boolean {
  switch (tab) {
    case "all":
      return true;
    case "mine":
      return m.hasMe;
    case "decisions":
      return m.decisionCount > 0;
    case "fav":
      return m.fav;
  }
}

const startMs = (m: MeetingSummary) => new Date(m.startIso).getTime();
const byId = (a: MeetingSummary, b: MeetingSummary) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const newestFirst = (a: MeetingSummary, b: MeetingSummary) =>
  startMs(b) - startMs(a) || byId(a, b);

/** 정렬 규칙은 스펙 §2.3 표 그대로다. 원본 배열은 건드리지 않는다. */
export function sortMeetings(
  meetings: MeetingSummary[],
  sort: MeetingListSort,
): MeetingSummary[] {
  const copy = [...meetings];
  if (sort === "oldest")
    return copy.sort((a, b) => startMs(a) - startMs(b) || byId(a, b));
  if (sort === "longest")
    return copy.sort(
      (a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0) || newestFirst(a, b),
    );
  return copy.sort(newestFirst);
}
