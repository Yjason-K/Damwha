import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { Toaster } from "@/shared/ui/toaster";
import { toMeetingDetail } from "@/features/meeting/api/mappers";
import { useResolveCluster } from "@/features/meeting/api/meetings";
import type {
  MeetingStatusResponse,
  SearchResponse,
  WireMeeting,
  WireMeetingDetail,
  WireSpeaker,
  WireUtterance,
} from "@/features/meeting/api/types";
import type { LensWireItem } from "@/features/lens/model/types";

/**
 * 회의 셸(/app) 통합 테스트 — mock 코퍼스 제거 후 HTTP 레이어(`apiClient`)를
 * 와이어 형태 픽스처로 목킹해 TanStack Query 경유 렌더를 검증한다. 기존 시맨틱
 * 단언(전사 렌더·사이드바 이동·전역 렌즈 빈 상태)을 유지하고, 실데이터 연결에서
 * 새로 생긴 흐름(화자 확인 다이얼로그·업로드 다이얼로그·처리 중 뱃지)을 더한다.
 *
 * 규약: vitest globals 없음(test/expect/vi 명시 import) + 수동 afterEach(cleanup),
 * Radix Tabs는 mousedown으로 활성화(fe-arch §6).
 */

/* ── 와이어 픽스처 ─────────────────────────────────────────────────── */
const fx = vi.hoisted(() => {
  const meeting = (o: Partial<WireMeeting>): WireMeeting => ({
    id: "m1",
    title: "회의",
    original_filename: null,
    audio_key: "meetings/m1/original.m4a",
    normalized_key: null,
    recorded_at: null,
    duration_ms: null,
    status: "done",
    is_favorite: false,
    current_job_id: null,
    processing_version: 1,
    error: null,
    created_at: "2026-06-21T09:00:00.000Z",
    ...o,
  });

  const utt = (o: Partial<WireUtterance>): WireUtterance => ({
    id: "u0",
    meeting_id: "m1",
    speaker_id: null,
    diar_label: "SPEAKER_00",
    start_ms: 0,
    end_ms: 0,
    text: "",
    confidence: null,
    status: "ok",
    transcript_error: null,
    order_index: 0,
    processing_version: 1,
    job_id: null,
    speaker_name: null,
    speaker_status: null,
    ...o,
  });

  const m1 = meeting({
    id: "m1",
    title: "기획회의 — UI 개선안",
    recorded_at: "2026-06-21T10:30:00.000Z",
    duration_ms: 2_520_000,
    status: "done",
    is_favorite: true,
  });
  const m2 = meeting({
    id: "m2",
    title: "스프린트 회고",
    recorded_at: "2026-06-18T14:00:00.000Z",
    duration_ms: 3_497_000,
    status: "done",
  });
  const m3 = meeting({
    id: "m3",
    title: "검색 인덱싱 설계",
    recorded_at: null,
    duration_ms: null,
    status: "processing",
    current_job_id: "job_1",
  });
  // 상세 조회가 실패하는 회의 — 에러 상태 렌더를 검증하기 위한 것.
  const mErr = meeting({
    id: "m_err",
    title: "불러오기 실패 회의",
    status: "done",
  });

  const meetingsList: WireMeeting[] = [m1, m2, m3, mErr];

  const m1Detail: WireMeetingDetail = {
    ...m1,
    summary: null,
    utterances: [
      utt({
        id: "u1",
        speaker_id: "sp_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 0,
        end_ms: 8_000,
        order_index: 0,
        text: "오늘은 홈 구조부터 정하죠. 앱을 열면 뭘 먼저 보여줄지요.",
      }),
      utt({
        id: "u2",
        speaker_id: "sp_2",
        speaker_name: "이수민",
        speaker_status: "ready",
        diar_label: "SPEAKER_01",
        start_ms: 8_000,
        end_ms: 15_000,
        order_index: 1,
        text: "저는 브라우즈 우선이 맞다고 봐요.",
      }),
      utt({
        id: "u3",
        speaker_id: null,
        speaker_name: null,
        speaker_status: null,
        diar_label: "SPEAKER_02",
        start_ms: 15_000,
        end_ms: 22_000,
        order_index: 2,
        text: "검색 인덱싱이 먼저 붙어야 합니다. 이번 스프린트에 넣죠.",
      }),
      utt({
        id: "u4",
        speaker_id: "sp_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 22_000,
        end_ms: 24_000,
        order_index: 3,
        text: null,
        status: "silence",
      }),
      utt({
        id: "u5",
        speaker_id: "sp_2",
        speaker_name: "이수민",
        speaker_status: "ready",
        diar_label: "SPEAKER_01",
        start_ms: 24_000,
        end_ms: 27_000,
        order_index: 4,
        text: null,
        status: "transcribe_failed",
      }),
    ],
    clusters: [
      {
        id: "clu_1",
        diar_label: "SPEAKER_00",
        resolved_speaker_id: "sp_1",
        speaker_name: "김영재",
        speaker_status: "ready",
      },
      {
        id: "clu_2",
        diar_label: "SPEAKER_01",
        resolved_speaker_id: "sp_2",
        speaker_name: "이수민",
        speaker_status: "ready",
      },
      {
        id: "clu_3",
        diar_label: "SPEAKER_02",
        resolved_speaker_id: null,
        speaker_name: null,
        speaker_status: null,
      },
    ],
  };

  const m2Detail: WireMeetingDetail = {
    ...m2,
    summary: null,
    utterances: [
      utt({
        id: "v1",
        meeting_id: "m2",
        speaker_id: "sp_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 0,
        end_ms: 5_000,
        order_index: 0,
        text: "지난 스프린트 돌아보죠. 좋았던 것부터요.",
      }),
      utt({
        id: "v2",
        meeting_id: "m2",
        speaker_id: "sp_5",
        speaker_name: "한서연",
        speaker_status: "ready",
        diar_label: "SPEAKER_01",
        start_ms: 5_000,
        end_ms: 12_000,
        order_index: 1,
        text: "리뷰 사이클이 짧아진 게 컸어요.",
      }),
      utt({
        id: "v3",
        meeting_id: "m2",
        speaker_id: "sp_5",
        speaker_name: "한서연",
        speaker_status: "ready",
        diar_label: "SPEAKER_01",
        start_ms: 12_000,
        end_ms: 20_000,
        order_index: 2,
        text: "다음 스프린트도 이어가죠",
      }),
    ],
    clusters: [
      {
        id: "clu_1",
        diar_label: "SPEAKER_00",
        resolved_speaker_id: "sp_1",
        speaker_name: "김영재",
        speaker_status: "ready",
      },
      {
        id: "clu_2",
        diar_label: "SPEAKER_01",
        resolved_speaker_id: "sp_5",
        speaker_name: "한서연",
        speaker_status: "ready",
      },
    ],
  };

  const m3Detail: WireMeetingDetail = {
    ...m3,
    summary: null,
    utterances: [],
    clusters: [],
  };

  const detailOf = (id: string): WireMeetingDetail => {
    if (id === "m2") return m2Detail;
    if (id === "m3") return m3Detail;
    return m1Detail;
  };

  const status: MeetingStatusResponse = {
    status: "processing",
    stage: "stt",
    progress: 0.5,
    error: null,
    summary_status: null,
  };

  const speakers: WireSpeaker[] = [
    {
      id: "sp_1",
      name: "김영재",
      enrollment_status: "ready",
      current_job_id: null,
      enrollment_error: null,
      created_at: "2026-06-01T00:00:00.000Z",
    },
    {
      id: "sp_2",
      name: "이수민",
      enrollment_status: "ready",
      current_job_id: null,
      enrollment_error: null,
      created_at: "2026-06-01T00:00:00.000Z",
    },
  ];

  const search: SearchResponse = {
    mode: "hybrid",
    semantic: true,
    hasMore: false,
    results: [
      {
        utteranceId: "u1",
        meetingId: "m1",
        meetingTitle: "기획회의 — UI 개선안",
        recordedAt: "2026-06-21T10:30:00.000Z",
        speaker: { id: "sp_1", name: "김영재" },
        diarLabel: "SPEAKER_00",
        startMs: 0,
        endMs: 8_000,
        text: "오늘은 홈 구조부터 정하죠.",
        score: 0.9,
      },
      {
        utteranceId: "v3",
        meetingId: "m2",
        meetingTitle: "스프린트 회고",
        recordedAt: "2026-06-18T14:00:00.000Z",
        speaker: { id: "sp_5", name: "한서연" },
        diarLabel: "SPEAKER_01",
        startMs: 12_000,
        endMs: 20_000,
        text: "다음 스프린트도 이어가죠",
        score: 0.8,
      },
    ],
  };

  // 전역 렌즈 대시보드용 액션아이템 픽스처 — 근거 점프(정상/historical) 검증에 쓴다.
  const lensItem = (o: Partial<LensWireItem>): LensWireItem => ({
    id: "lens_1",
    kind: "action",
    text: "",
    source: "ai",
    user_modified: false,
    completion_status: "open",
    lifecycle_status: "active",
    meeting_id: "m1",
    assignee_speaker_id: null,
    due_at: null,
    created_at: "2026-06-21T09:00:00.000Z",
    updated_at: "2026-06-21T09:00:00.000Z",
    meeting: { id: "m1", title: null },
    evidence: [],
    ...o,
  });

  // 정상 점프 대상: m2의 실제 발화 v3(병합 블록 v2에 속함).
  const lensJumpItem = lensItem({
    id: "lens_jump",
    meeting_id: "m2",
    meeting: { id: "m2", title: "스프린트 회고" },
    text: "다음 스프린트 자료 공유하기",
    evidence: [
      {
        relation: "primary",
        utterance: {
          id: "v3",
          start_ms: 12_000,
          text: "다음 스프린트도 이어가죠",
          speaker_id: "sp_5",
        },
      },
    ],
  });
  // historical 대상: m1에 존재하지 않는 발화 id를 가리켜, 재처리로 근거가
  // 사라진 상황을 재현한다.
  const lensGhostItem = lensItem({
    id: "lens_ghost",
    meeting_id: "m1",
    meeting: { id: "m1", title: "기획회의 — UI 개선안" },
    text: "지난 회의 후속 조치 확인하기",
    evidence: [
      {
        relation: "primary",
        utterance: {
          id: "u_ghost",
          start_ms: 3_000,
          text: "존재하지 않는 발언",
          speaker_id: null,
        },
      },
    ],
  });
  const lensActionItems = [lensJumpItem, lensGhostItem];

  function getResponse(url: string) {
    if (url === "/meetings") return Promise.resolve({ data: meetingsList });
    if (url === "/speakers") return Promise.resolve({ data: speakers });
    if (url === "/lenses/extraction-status")
      return Promise.resolve({ data: { running: 0, failed: [] } });
    if (url.startsWith("/lenses?")) {
      const qs = new URLSearchParams(url.slice("/lenses?".length));
      const items = qs.get("kind") === "action" ? lensActionItems : [];
      return Promise.resolve({ data: { items, next_cursor: null } });
    }
    if (url.endsWith("/status")) return Promise.resolve({ data: status });
    const m = url.match(/^\/meetings\/([^/]+)$/);
    if (m) {
      if (m[1] === "m_err")
        return Promise.reject(new Error(`detail fetch failed: ${m[1]}`));
      return Promise.resolve({ data: detailOf(m[1]) });
    }
    return Promise.reject(new Error(`unhandled GET ${url}`));
  }

  function postResponse(url: string) {
    if (url === "/search") return Promise.resolve({ data: search });
    if (url === "/meetings")
      return Promise.resolve({
        data: meeting({ id: "m9", status: "uploaded" }),
      });
    // resolve는 반드시 실제 clu_* PK로 호출해야 한다. diar_label(예: SPEAKER_02)로
    // 오면 백엔드가 404를 내므로, 여기서도 clu_* 형식만 통과시킨다.
    const rm = url.match(/^\/meetings\/([^/]+)\/clusters\/([^/]+)\/resolve$/);
    if (rm) {
      if (!/^clu_[0-9]+$/.test(rm[2]))
        return Promise.reject(new Error(`resolve got non-clu id: ${rm[2]}`));
      return Promise.resolve({
        data: {
          speaker_id: "sp_x",
          updated_utterances: 1,
          merged_speaker_deleted: false,
        },
      });
    }
    return Promise.reject(new Error(`unhandled POST ${url}`));
  }

  return { getResponse, postResponse, detailOf };
});

vi.mock("@/shared/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/shared/api/client")>(
    "@/shared/api/client",
  );
  return {
    ...actual,
    apiClient: {
      get: vi.fn((url: string) => fx.getResponse(url)),
      post: vi.fn((url: string) => fx.postResponse(url)),
      put: vi.fn(() => Promise.resolve({ data: fx.detailOf("m1") })),
      patch: vi.fn(() => Promise.resolve({ data: fx.detailOf("m1") })),
      delete: vi.fn(() => Promise.resolve({ data: {} })),
    },
  };
});

// mock을 등록한 뒤 import해야 페이지가 목킹된 apiClient를 소비한다.
const { MeetingPage } = await import("@/pages/meeting");

// vitest는 globals 없이 돌므로 RTL 자동 cleanup이 걸리지 않는다 — 명시 등록.
afterEach(cleanup);

function renderShell() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MeetingPage />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("회의 셸은 전사·인사이트·플레이어를 렌더한다", async () => {
  renderShell();
  expect(
    await screen.findByRole("heading", {
      level: 1,
      name: "기획회의 — UI 개선안",
    }),
  ).toBeInTheDocument();
  expect(screen.getByRole("log", { name: "회의 전사" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "재생" })).toBeInTheDocument();
  expect(screen.getByText(/오늘은 홈 구조부터 정하죠/)).toBeInTheDocument();
});

test("silence 발화는 숨기고 transcribe_failed는 플레이스홀더로 렌더한다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  const log = screen.getByRole("log", { name: "회의 전사" });
  // silence 행은 렌더되지 않는다.
  expect(log.querySelector('[data-uid="u4"]')).toBeNull();
  // transcribe_failed 행은 플레이스홀더 문구와 함께 렌더된다.
  const failedRow = log.querySelector('[data-uid="u5"]');
  expect(failedRow).not.toBeNull();
  expect(failedRow).toHaveTextContent("전사하지 못한 구간입니다");
  // 플레이스홀더는 이탤릭(회색) 스타일로 구분된다.
  expect(failedRow!.querySelector("span.italic")).not.toBeNull();
});

test("미해결 클러스터가 있으면 화자 확인 배너와 다이얼로그가 뜬다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  expect(
    screen.getByText("확인이 필요한 화자가 1명 있어요"),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "화자 확인" }));

  expect(
    await screen.findByText(/성문으로 자동 연결하지 못한 화자예요/),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "연결" })).toBeInTheDocument();
});

test("사이드바에서 다른 회의로 이동할 수 있다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.click(screen.getByRole("button", { name: /스프린트 회고/ }));
  expect(
    await screen.findByRole("heading", { level: 1, name: "스프린트 회고" }),
  ).toBeInTheDocument();
});

test("회의를 전환해도 플레이바는 하나만 남는다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  // 트랜스포트 재생 버튼(정확히 "재생")은 플레이바당 1개다.
  expect(screen.getAllByRole("button", { name: "재생" })).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: /스프린트 회고/ }));
  await screen.findByRole("heading", { level: 1, name: "스프린트 회고" });

  // 이전 회의의 플레이바가 남아 쌓이면 안 된다.
  expect(screen.getAllByRole("button", { name: "재생" })).toHaveLength(1);
});

test("모든 회의(전역 렌즈)로 전환하면 렌즈 대시보드와 탭이 보인다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.click(screen.getByRole("button", { name: "모든 회의" }));
  expect(
    await screen.findByRole("heading", { level: 1, name: "내 액션아이템" }),
  ).toBeInTheDocument();
  expect(
    await screen.findByText("다음 스프린트 자료 공유하기"),
  ).toBeInTheDocument();
  // Radix Tabs는 mousedown으로 탭을 활성화한다
  fireEvent.mouseDown(screen.getByRole("tab", { name: "결정사항" }));
  expect(
    await screen.findByRole("heading", { level: 1, name: "내 결정사항" }),
  ).toBeInTheDocument();
  expect(
    await screen.findByText("조건에 맞는 결정사항 항목이 없어요."),
  ).toBeInTheDocument();
});

test("전역 렌즈 대시보드에서 근거 점프하면 회의뷰로 전환되고 발언이 하이라이트되지만 오디오는 seek되지 않는다", async () => {
  const { container } = renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.click(screen.getByRole("button", { name: "모든 회의" }));
  await screen.findByRole("heading", { level: 1, name: "내 액션아이템" });

  const jumpCard = (
    await screen.findByText("다음 스프린트 자료 공유하기")
  ).closest(".rounded-sm") as HTMLElement;
  fireEvent.click(within(jumpCard).getByRole("button", { name: /원문 보기/ }));

  // m2("스프린트 회고")로 전환되고, v3를 포함하는 병합 블록(v2)이 하이라이트된다.
  expect(
    await screen.findByRole("heading", { level: 1, name: "스프린트 회고" }),
  ).toBeInTheDocument();
  const log = screen.getByRole("log", { name: "회의 전사" });
  expect(log.querySelector('[data-uid="v2"]')).toHaveClass(
    "bg-[var(--accent-1)]",
  );

  // jumpTo(검색 점프)와 달리 근거 점프는 pendingSeek을 걸지 않으므로, 오디오
  // 메타데이터가 로드돼도 currentTime이 그대로다(0에서 변화 없음).
  const audio = container.querySelector("audio")!;
  fireEvent.loadedMetadata(audio);
  expect(audio.currentTime).toBe(0);
});

test("근거 점프 대상 발언이 재처리로 사라졌으면 토스트를 띄우고 activeId를 비운다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.click(screen.getByRole("button", { name: "모든 회의" }));
  await screen.findByRole("heading", { level: 1, name: "내 액션아이템" });

  const ghostCard = (
    await screen.findByText("지난 회의 후속 조치 확인하기")
  ).closest(".rounded-sm") as HTMLElement;
  fireEvent.click(within(ghostCard).getByRole("button", { name: /원문 보기/ }));

  // 대상 회의(m1)는 이미 로드돼 있으므로 뷰만 회의뷰로 전환된다.
  await screen.findByRole("log", { name: "회의 전사" });
  expect(
    await screen.findByText(
      "재처리로 근거 발언을 현재 버전에서 찾을 수 없어요.",
    ),
  ).toBeInTheDocument();
});

test("새 회의 기록하기로 업로드 다이얼로그를 연다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.click(screen.getByRole("button", { name: /새 회의 기록하기/ }));
  expect(
    await screen.findByRole("heading", { name: "새 회의 업로드" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "업로드" })).toBeInTheDocument();
});

test("처리 중인 회의는 목록에 처리 중 뱃지를 보여준다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  expect(screen.getByText("처리 중")).toBeInTheDocument();
});

test("상세 조회에 실패하면 무한 스피너 대신 에러 상태와 재시도를 보여준다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.click(screen.getByRole("button", { name: /불러오기 실패 회의/ }));
  expect(
    await screen.findByText(/회의를 불러오지 못했어요/),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
});

test("빈 검색어로 팔레트를 열면 브라우즈 결과가 보인다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  // 빈 질의(브라우즈 모드)에도 결과 옵션이 나오고, 빈 상태 문구는 사라진다.
  const options = await screen.findAllByRole("option");
  expect(options.length).toBeGreaterThan(0);
  expect(
    screen.queryByText("결과가 없어요. 다른 검색어를 시도해 보세요."),
  ).not.toBeInTheDocument();
});

test("resolve는 diar_label이 아니라 실제 clu_* id로 호출한다", async () => {
  // 매퍼가 미해결 클러스터의 id를 실제 clu_* PK로 노출하는지 먼저 고정한다.
  const detail = toMeetingDetail(fx.detailOf("m1"));
  const cluster = detail.clusters.find((c) => c.resolvedSpeakerId == null)!;
  expect(cluster.id).toBe("clu_3");

  function Harness() {
    const resolve = useResolveCluster();
    return (
      <button
        onClick={() =>
          resolve.mutate({
            meetingId: "m1",
            clusterId: cluster.id,
            body: { speaker_id: "sp_1" },
          })
        }
      >
        연결
      </button>
    );
  }

  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "연결" }));
  await waitFor(() =>
    expect(apiClient.post).toHaveBeenCalledWith(
      "/meetings/m1/clusters/clu_3/resolve",
      { speaker_id: "sp_1" },
    ),
  );
});

test("연속된 같은 화자 발화는 한 블록으로 병합 렌더된다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.click(screen.getByRole("button", { name: /스프린트 회고/ }));
  await screen.findByRole("heading", { level: 1, name: "스프린트 회고" });
  const log = screen.getByRole("log", { name: "회의 전사" });
  // v2+v3가 한 블록(id는 첫 발화 v2)으로 병합, v3 행은 따로 없다.
  const block = log.querySelector('[data-uid="v2"]');
  expect(block).toHaveTextContent(
    "리뷰 사이클이 짧아진 게 컸어요. 다음 스프린트도 이어가죠",
  );
  expect(log.querySelector('[data-uid="v3"]')).toBeNull();
});

test("다른 회의의 병합 블록 중간 발화로 검색 점프하면 해당 시점으로 seek되고 블록이 하이라이트된다", async () => {
  const { container } = renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const option = await screen.findByRole("option", {
    name: /다음 스프린트도 이어가죠/,
  });
  fireEvent.click(option);
  await screen.findByRole("heading", { level: 1, name: "스프린트 회고" });
  // cross-meeting pendingSeek: 오디오 메타데이터 로드 시점에 적용된다.
  const audio = container.querySelector("audio")!;
  fireEvent.loadedMetadata(audio);
  // v3.start_ms = 12_000 → 12초 지점 (jsdom은 duration NaN → totalSeconds 사용).
  expect(audio.currentTime).toBeCloseTo(12, 3);
  // 하이라이트는 v3를 포함하는 블록(v2)에 걸린다.
  const log = screen.getByRole("log", { name: "회의 전사" });
  expect(log.querySelector('[data-uid="v2"]')).toHaveClass(
    "bg-[var(--accent-1)]",
  );
});
