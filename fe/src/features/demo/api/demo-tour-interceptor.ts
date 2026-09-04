import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";

import type { SimView } from "../model/upload-simulation";

type Opts = {
  tourMeetingId: string;
  isUploaded: () => boolean;
  view: () => SimView | null;
};

/** baseURL·/api 접두를 벗긴 경로. demo-read-only.ts와 같은 규칙. */
function pathOf(res: AxiosResponse): string {
  return (res.config.url ?? "")
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^\/api/, "")
    .split("?")[0]
    .replace(/\/$/, "");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * 숨김 필터가 한 페이지를 통째로 비웠을 때 next_cursor를 따라가는 최대 횟수. 서버 페이지가
 * 20건이라 투어 회의 항목이 한 페이지를 다 채우는 건 저장한 발언 정도인데, 커서만 남은 빈
 * 페이지를 그대로 흘리면 렌즈 대시보드는 "항목이 없어요"를 그리고 더 보기 감시자도 안 단다.
 */
const MAX_REFILL_HOPS = 10;

type HopConfig = AxiosRequestConfig & { demoTourHop?: number };

function withCursor(url: string, cursor: string): string {
  const u = new URL(url, "http://demo.local");
  u.searchParams.set("cursor", cursor);
  return `${u.pathname}${u.search}`;
}

/**
 * 데모 둘러보기의 응답 가공(투어 설계 §4.2·§4.3). 업로드 전엔 투어 회의를 목록류 응답에서
 * 숨기고, 시뮬레이션이 도는 동안엔 그 회의의 상태를 processing/stage로 덮어쓴다.
 * 그 밖의 응답과 404는 손대지 않는다.
 */
export function installDemoTour(client: AxiosInstance, opts: Opts): void {
  const { tourMeetingId: tour } = opts;
  const isTour = (v: unknown) => v === tour;

  client.interceptors.response.use(async (res) => {
    const method = (res.config.method ?? "get").toLowerCase();
    const path = pathOf(res);
    const data: unknown = res.data;

    if (!opts.isUploaded()) {
      if (method === "get" && path === "/meetings" && Array.isArray(data)) {
        res.data = data.filter((m) => !isRecord(m) || !isTour(m.id));
      } else if (method === "post" && path === "/search" && isRecord(data) && Array.isArray(data.results)) {
        res.data = { ...data, results: data.results.filter((h) => !isRecord(h) || !isTour(h.meetingId)) };
      } else if (method === "get" && (path === "/lenses" || path === "/saved-utterances") && isRecord(data) && Array.isArray(data.items)) {
        const items = data.items.filter((it) => {
          if (!isRecord(it)) return true;
          const meeting = isRecord(it.meeting) ? it.meeting : null;
          return !isTour(it.meeting_id) && !isTour(meeting?.id);
        });
        const cursor = data.next_cursor;
        const hop = (res.config as HopConfig).demoTourHop ?? 0;
        if (items.length === 0 && typeof cursor === "string" && cursor && hop < MAX_REFILL_HOPS) {
          // 다음 페이지를 같은 클라이언트로 받는다 — 이 인터셉터가 다시 걸려 필터·재충전이 이어진다.
          const next = await client.get(withCursor(res.config.url ?? path, cursor), {
            demoTourHop: hop + 1,
          } as HopConfig);
          res.data = next.data;
        } else {
          res.data = { ...data, items };
        }
      }
      return res;
    }

    const view = opts.view();
    if (!view || view.meetingId !== tour || method !== "get") return res;

    if (path === "/meetings" && Array.isArray(data)) {
      res.data = data.map((m) => (isRecord(m) && isTour(m.id) ? { ...m, status: "processing" } : m));
    } else if (path === `/meetings/${tour}` && isRecord(data)) {
      // 상세는 status만 덮으면 안 된다 — MeetingPage는 meeting이 있으면 전사·인사이트를
      // 그대로 그리므로, 완성된 발화·클러스터·요약이 "처리 중" 배너 뒤에 비친다.
      res.data = { ...data, status: "processing", utterances: [], clusters: [], summary: null };
    } else if (path === `/meetings/${tour}/lenses` && isRecord(data)) {
      // 같은 이유로 렌즈도 비운다. queued면 LensState가 "찾고 있어요"로 그린다.
      res.data = { ...data, items: [], extraction_status: "queued" };
    } else if (path === `/meetings/${tour}/status`) {
      res.data = {
        status: "processing",
        stage: view.stage,
        progress: view.progress,
        error: null,
        summary: { status: "queued", model: null, error: null },
        search_index: { status: "queued", error: null, updated_at: new Date().toISOString() },
      };
    }
    return res;
  });
}
