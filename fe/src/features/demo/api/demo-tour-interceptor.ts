import type { AxiosInstance, AxiosResponse } from "axios";

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
 * 데모 둘러보기의 응답 가공(투어 설계 §4.2·§4.3). 업로드 전엔 투어 회의를 목록류 응답에서
 * 숨기고, 시뮬레이션이 도는 동안엔 그 회의의 상태를 processing/stage로 덮어쓴다.
 * 그 밖의 응답과 404는 손대지 않는다.
 */
export function installDemoTour(client: AxiosInstance, opts: Opts): void {
  const { tourMeetingId: tour } = opts;
  const isTour = (v: unknown) => v === tour;

  client.interceptors.response.use((res) => {
    const method = (res.config.method ?? "get").toLowerCase();
    const path = pathOf(res);
    const data: unknown = res.data;

    if (!opts.isUploaded()) {
      if (method === "get" && path === "/meetings" && Array.isArray(data)) {
        res.data = data.filter((m) => !isRecord(m) || !isTour(m.id));
      } else if (method === "post" && path === "/search" && isRecord(data) && Array.isArray(data.results)) {
        res.data = { ...data, results: data.results.filter((h) => !isRecord(h) || !isTour(h.meetingId)) };
      } else if (method === "get" && (path === "/lenses" || path === "/saved-utterances") && isRecord(data) && Array.isArray(data.items)) {
        res.data = {
          ...data,
          items: data.items.filter((it) => {
            if (!isRecord(it)) return true;
            const meeting = isRecord(it.meeting) ? it.meeting : null;
            return !isTour(it.meeting_id) && !isTour(meeting?.id);
          }),
        };
      }
      return res;
    }

    const view = opts.view();
    if (!view || view.meetingId !== tour || method !== "get") return res;

    if (path === "/meetings" && Array.isArray(data)) {
      res.data = data.map((m) => (isRecord(m) && isTour(m.id) ? { ...m, status: "processing" } : m));
    } else if (path === `/meetings/${tour}` && isRecord(data)) {
      res.data = { ...data, status: "processing" };
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
