import axios from "axios";
import { expect, test, vi } from "vitest";

import type { SimView } from "../model/upload-simulation";
import { installDemoTour } from "./demo-tour-interceptor";

const TOUR = "mtg_7";

function client(data: unknown) {
  const adapter = vi.fn(async (config) => ({
    data,
    status: 200,
    statusText: "OK",
    headers: {},
    config,
  }));
  return axios.create({ baseURL: "http://api.test/api", adapter });
}

function install(
  c: ReturnType<typeof client>,
  { uploaded = false, view = null }: { uploaded?: boolean; view?: SimView | null } = {},
) {
  installDemoTour(c, { tourMeetingId: TOUR, isUploaded: () => uploaded, view: () => view });
}

test("업로드 전: GET /meetings에서 투어 회의를 뺀다", async () => {
  const c = client([{ id: "mtg_5" }, { id: TOUR }, { id: "mtg_6" }]);
  install(c);
  const { data } = await c.get("/meetings");
  expect(data.map((m: { id: string }) => m.id)).toEqual(["mtg_5", "mtg_6"]);
});

test("업로드 전: POST /search·GET /lenses·GET /saved-utterances에서 투어 회의 항목을 뺀다", async () => {
  const s = client({ results: [{ meetingId: TOUR }, { meetingId: "mtg_5" }] });
  install(s);
  expect((await s.post("/search", { q: "x" })).data.results).toEqual([{ meetingId: "mtg_5" }]);

  const l = client({ items: [{ meeting_id: TOUR }, { meeting_id: "mtg_5" }], next_cursor: null });
  install(l);
  expect((await l.get("/lenses?kind=action")).data.items).toEqual([{ meeting_id: "mtg_5" }]);

  const u = client({ items: [{ meeting: { id: TOUR } }, { meeting: { id: "mtg_5" } }], next_cursor: null });
  install(u);
  expect((await u.get("/saved-utterances")).data.items).toEqual([{ meeting: { id: "mtg_5" } }]);
});

test("업로드 전: GET /saved-utterances/ids와 GET /meetings/:id는 건드리지 않는다", async () => {
  const ids = client({ utterance_ids: ["u1"] });
  install(ids);
  expect((await ids.get("/saved-utterances/ids?meeting_id=mtg_7")).data).toEqual({ utterance_ids: ["u1"] });

  const d = client({ id: TOUR, status: "done" });
  install(d);
  expect((await d.get(`/meetings/${TOUR}`)).data).toEqual({ id: TOUR, status: "done" });
});

test("업로드 후·시뮬레이션 없음: 응답을 그대로 흘린다", async () => {
  const c = client([{ id: TOUR, status: "done" }]);
  install(c, { uploaded: true });
  expect((await c.get("/meetings")).data).toEqual([{ id: TOUR, status: "done" }]);
});

test("시뮬레이션 중: 목록의 status와 /status 응답을 덮어쓴다", async () => {
  const view: SimView = { meetingId: TOUR, stage: "stt", progress: 0.25 };
  const list = client([{ id: TOUR, status: "done" }, { id: "mtg_5", status: "done" }]);
  install(list, { uploaded: true, view });
  expect((await list.get("/meetings")).data).toEqual([
    { id: TOUR, status: "processing" },
    { id: "mtg_5", status: "done" },
  ]);

  const status = client({ status: "done", stage: null, progress: null, error: null, summary: { status: "done" }, search_index: { status: "done" } });
  install(status, { uploaded: true, view });
  expect((await status.get(`/meetings/${TOUR}/status`)).data).toEqual({
    status: "processing",
    stage: "stt",
    progress: 0.25,
    error: null,
    summary: { status: "queued", model: null, error: null },
    search_index: { status: "queued", error: null, updated_at: expect.any(String) },
  });
});

test("시뮬레이션 중: 상세에서 완성된 전사·클러스터·요약을 비운다", async () => {
  const view: SimView = { meetingId: TOUR, stage: "stt", progress: 0.25 };
  const detail = client({
    id: TOUR,
    title: "투어 회의",
    status: "done",
    utterances: [{ id: "u1" }],
    clusters: [{ id: "c1" }],
    summary: { status: "done", body: "요약" },
  });
  install(detail, { uploaded: true, view });
  expect((await detail.get(`/meetings/${TOUR}`)).data).toEqual({
    id: TOUR,
    title: "투어 회의",
    status: "processing",
    utterances: [],
    clusters: [],
    summary: null,
  });
});

test("시뮬레이션 중: /meetings/:id/lenses를 빈 queued로 덮어쓴다", async () => {
  const view: SimView = { meetingId: TOUR, stage: "embed", progress: 0.5 };
  const c = client({ items: [{ id: "l1" }], extraction_status: "done" });
  install(c, { uploaded: true, view });
  expect((await c.get(`/meetings/${TOUR}/lenses`)).data).toEqual({
    items: [],
    extraction_status: "queued",
  });
});

test("시뮬레이션이 끝나면 상세·렌즈가 다시 진짜 응답이다", async () => {
  const detail = client({ id: TOUR, status: "done", utterances: [{ id: "u1" }] });
  install(detail, { uploaded: true });
  expect((await detail.get(`/meetings/${TOUR}`)).data).toEqual({
    id: TOUR,
    status: "done",
    utterances: [{ id: "u1" }],
  });

  const lenses = client({ items: [{ id: "l1" }], extraction_status: "done" });
  install(lenses, { uploaded: true });
  expect((await lenses.get(`/meetings/${TOUR}/lenses`)).data).toEqual({
    items: [{ id: "l1" }],
    extraction_status: "done",
  });
});

test("시뮬레이션 중이라도 다른 회의 응답은 그대로다", async () => {
  const view: SimView = { meetingId: TOUR, stage: "vad", progress: 0 };
  const c = client({ id: "mtg_5", status: "done" });
  install(c, { uploaded: true, view });
  expect((await c.get("/meetings/mtg_5")).data).toEqual({ id: "mtg_5", status: "done" });
});

/** cursor 쿼리에 따라 다른 페이지를 돌려주는 클라이언트. 호출된 cursor 목록을 함께 준다. */
function pagedClient(pages: Record<string, unknown>) {
  const cursors: (string | null)[] = [];
  const adapter = vi.fn(async (config) => {
    const cursor = new URL(config.url ?? "", "http://api.test").searchParams.get("cursor");
    cursors.push(cursor);
    return { data: pages[cursor ?? "first"], status: 200, statusText: "OK", headers: {}, config };
  });
  return { c: axios.create({ baseURL: "http://api.test/api", adapter }), cursors };
}

test("업로드 전: 숨김으로 비어 버린 페이지는 next_cursor를 따라가 채운다", async () => {
  const { c, cursors } = pagedClient({
    first: { items: [{ meeting_id: TOUR }, { meeting_id: TOUR }], next_cursor: "c1" },
    c1: { items: [{ meeting_id: TOUR }], next_cursor: "c2" },
    c2: { items: [{ meeting_id: "mtg_5" }, { meeting_id: TOUR }], next_cursor: "c3" },
  });
  install(c);
  const { data } = await c.get("/lenses?kind=action&completion_status=open");
  expect(data).toEqual({ items: [{ meeting_id: "mtg_5" }], next_cursor: "c3" });
  expect(cursors).toEqual([null, "c1", "c2"]);
});

test("업로드 전: 커서가 끝나면 빈 페이지를 그대로 돌려준다", async () => {
  const { c, cursors } = pagedClient({
    first: { items: [{ meeting: { id: TOUR } }], next_cursor: "c1" },
    c1: { items: [{ meeting: { id: TOUR } }], next_cursor: null },
  });
  install(c);
  const { data } = await c.get("/saved-utterances");
  expect(data).toEqual({ items: [], next_cursor: null });
  expect(cursors).toEqual([null, "c1"]);
});

test("업로드 전: 재충전은 최대 10번까지만 따라간다", async () => {
  const pages: Record<string, unknown> = {
    first: { items: [{ meeting_id: TOUR }], next_cursor: "c1" },
  };
  for (let i = 1; i <= 30; i++) pages[`c${i}`] = { items: [{ meeting_id: TOUR }], next_cursor: `c${i + 1}` };
  const { c, cursors } = pagedClient(pages);
  install(c);
  const { data } = await c.get("/lenses?kind=action");
  expect(data).toEqual({ items: [], next_cursor: "c11" });
  expect(cursors).toHaveLength(11);
});

test("업로드 전: 항목이 남은 페이지는 커서를 따라가지 않는다", async () => {
  const { c, cursors } = pagedClient({
    first: { items: [{ meeting_id: TOUR }, { meeting_id: "mtg_5" }], next_cursor: "c1" },
  });
  install(c);
  const { data } = await c.get("/lenses?kind=action");
  expect(data).toEqual({ items: [{ meeting_id: "mtg_5" }], next_cursor: "c1" });
  expect(cursors).toEqual([null]);
});
