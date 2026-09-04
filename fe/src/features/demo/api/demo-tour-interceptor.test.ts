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

test("시뮬레이션 중: 목록·상세의 status와 /status 응답을 덮어쓴다", async () => {
  const view: SimView = { meetingId: TOUR, stage: "stt", progress: 0.25 };
  const list = client([{ id: TOUR, status: "done" }, { id: "mtg_5", status: "done" }]);
  install(list, { uploaded: true, view });
  expect((await list.get("/meetings")).data).toEqual([
    { id: TOUR, status: "processing" },
    { id: "mtg_5", status: "done" },
  ]);

  const detail = client({ id: TOUR, status: "done", utterances: [1] });
  install(detail, { uploaded: true, view });
  expect((await detail.get(`/meetings/${TOUR}`)).data).toEqual({
    id: TOUR,
    status: "processing",
    utterances: [1],
  });

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

test("시뮬레이션 중이라도 다른 회의 응답은 그대로다", async () => {
  const view: SimView = { meetingId: TOUR, stage: "vad", progress: 0 };
  const c = client({ id: "mtg_5", status: "done" });
  install(c, { uploaded: true, view });
  expect((await c.get("/meetings/mtg_5")).data).toEqual({ id: "mtg_5", status: "done" });
});
