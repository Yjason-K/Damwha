import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

import { routes } from "@/app/router";
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
 * 회의 셸(/meetings/:id) 통합 테스트 — mock 코퍼스 제거 후 HTTP 레이어(`apiClient`)를
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
    // 처리 중이라도 길이는 업로드 시점에 이미 알 수 있다 — 플레이바가
    // 길이가 아니라 화자 레인 유무로 숨는지 검증하기 위해 채워 둔다.
    duration_ms: 900_000,
    status: "processing",
    current_job_id: "job_1",
  });
  // 상세 조회가 실패하는 회의 — 에러 상태 렌더를 검증하기 위한 것.
  const mErr = meeting({
    id: "m_err",
    title: "불러오기 실패 회의",
    status: "done",
  });
  // 요약(summary)이 done으로 채워진 회의 — useMeetingLenses → mapMeetingLenses
  // → InsightPane으로 이어지는 전체 배선을 settled === true 경로에서 검증하기
  // 위한 것. 다른 픽스처는 전부 summary: null이라 이 경로가 비어 있었다.
  const m4 = meeting({
    id: "m4",
    title: "요약이 준비된 회의",
    recorded_at: "2026-06-25T09:00:00.000Z",
    duration_ms: 60_000,
    status: "done",
  });

  const meetingsList: WireMeeting[] = [m1, m2, m3, mErr, m4];

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
        suggested_speaker_id: null,
        suggested_speaker_name: null,
        suggested_similarity: null,
      },
      {
        id: "clu_2",
        diar_label: "SPEAKER_01",
        resolved_speaker_id: "sp_2",
        speaker_name: "이수민",
        speaker_status: "ready",
        suggested_speaker_id: null,
        suggested_speaker_name: null,
        suggested_similarity: null,
      },
      {
        id: "clu_3",
        diar_label: "SPEAKER_02",
        resolved_speaker_id: null,
        speaker_name: null,
        speaker_status: null,
        suggested_speaker_id: null,
        suggested_speaker_name: null,
        suggested_similarity: null,
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
        suggested_speaker_id: null,
        suggested_speaker_name: null,
        suggested_similarity: null,
      },
      {
        id: "clu_2",
        diar_label: "SPEAKER_01",
        resolved_speaker_id: "sp_5",
        speaker_name: "한서연",
        speaker_status: "ready",
        suggested_speaker_id: null,
        suggested_speaker_name: null,
        suggested_similarity: null,
      },
    ],
  };

  const m3Detail: WireMeetingDetail = {
    ...m3,
    summary: null,
    utterances: [],
    clusters: [],
  };

  const m4Detail: WireMeetingDetail = {
    ...m4,
    summary: {
      status: "done",
      topics: ["로드맵 정리", "예산 검토"],
      segments: [
        {
          start_utterance_id: "w1",
          end_utterance_id: "w1",
          start_ms: 0,
          end_ms: 5_000,
          title: "회의 도입부",
          bullets: ["3분기 우선순위 확정"],
        },
      ],
      error: null,
    },
    utterances: [
      utt({
        id: "w1",
        meeting_id: "m4",
        speaker_id: "sp_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        diar_label: "SPEAKER_00",
        start_ms: 0,
        end_ms: 5_000,
        order_index: 0,
        text: "로드맵부터 정리하죠.",
      }),
    ],
    clusters: [
      {
        id: "clu_4",
        diar_label: "SPEAKER_00",
        resolved_speaker_id: "sp_1",
        speaker_name: "김영재",
        speaker_status: "ready",
        suggested_speaker_id: null,
        suggested_speaker_name: null,
        suggested_similarity: null,
      },
    ],
  };

  // 테스트별 상세 덮어쓰기 — 처리 중 회의가 done으로 바뀌는 전이를 재현한다.
  const detailOverrides = new Map<string, WireMeetingDetail>();
  const setDetailOverride = (id: string, d: WireMeetingDetail) => {
    detailOverrides.set(id, d);
  };

  const detailOf = (id: string): WireMeetingDetail => {
    const o = detailOverrides.get(id);
    if (o) return o;
    if (id === "m2") return m2Detail;
    if (id === "m3") return m3Detail;
    if (id === "m4") return m4Detail;
    return m1Detail;
  };

  const status: MeetingStatusResponse = {
    status: "processing",
    stage: "stt",
    progress: 0.5,
    error: null,
    summary: null,
    search_index: null,
  };

  // 색인(search_index) 상태는 테스트별로 덮어쓴다 — reset()이 원복.
  let searchIndex: MeetingStatusResponse["search_index"] = null;
  const setSearchIndex = (v: MeetingStatusResponse["search_index"]) => {
    searchIndex = v;
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
    meeting: { id: "m1", title: null, recorded_at: null },
    evidence: [],
    ...o,
  });

  // 정상 점프 대상: m2의 실제 발화 v3(병합 블록 v2에 속함).
  const lensJumpItem = lensItem({
    id: "lens_jump",
    meeting_id: "m2",
    meeting: { id: "m2", title: "스프린트 회고", recorded_at: null },
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
    meeting: { id: "m1", title: "기획회의 — UI 개선안", recorded_at: null },
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

  // 회의별 렌즈(GET /meetings/:id/lenses) 픽스처 — m4에만 채워, settled 요약과
  // 함께 Todos/Decisions 블록이 실제 데이터로 채워지는지 검증한다.
  const m4ActionItem = lensItem({
    id: "lens_m4_action",
    kind: "action",
    meeting_id: "m4",
    meeting: { id: "m4", title: "요약이 준비된 회의", recorded_at: null },
    text: "예산안 다시 검토하기",
    completion_status: "open",
    evidence: [
      {
        relation: "primary",
        utterance: {
          id: "w1",
          start_ms: 0,
          text: "로드맵부터 정리하죠.",
          speaker_id: "sp_1",
        },
      },
    ],
  });
  const m4DecisionItem = lensItem({
    id: "lens_m4_decision",
    kind: "decision",
    meeting_id: "m4",
    meeting: { id: "m4", title: "요약이 준비된 회의", recorded_at: null },
    text: "3분기까지 v2로 한정",
    completion_status: "done",
    evidence: [
      {
        relation: "primary",
        utterance: {
          id: "w1",
          start_ms: 0,
          text: "로드맵부터 정리하죠.",
          speaker_id: "sp_1",
        },
      },
    ],
  });
  const meetingLensesOf = (id: string): LensWireItem[] =>
    id === "m4" ? [m4ActionItem, m4DecisionItem] : [];

  // 삭제된 회의 id — DELETE /meetings/:id가 채우고, 목록/상세 응답이 이를 반영해
  // 실제 서버처럼 굴게 한다. 삭제 후 리다이렉트 검증에 필요하다(낡은 목록을 읽으면
  // 목이 여전히 그 회의를 돌려줘 테스트가 엉뚱한 이유로 통과해 버린다).
  const deletedIds = new Set<string>();

  // 목록 재조회를 붙잡아 두는 게이트. 목이 즉시 resolve하면 무효화 재조회가
  // IndexRoute 렌더보다 먼저 끝나 "낡은 목록을 읽는" 창 자체가 사라진다 —
  // 실제 네트워크에서는 열리는 창이므로, 테스트가 회귀를 잡으려면 재현해야 한다.
  let listBlocked = false;
  let pendingList: Array<() => void> = [];

  function listResponse() {
    const data = meetingsList.filter((m) => !deletedIds.has(m.id));
    if (!listBlocked) return Promise.resolve({ data });
    return new Promise<{ data: WireMeeting[] }>((resolve) => {
      pendingList.push(() => resolve({ data }));
    });
  }

  function getResponse(url: string) {
    if (url === "/meetings") return listResponse();
    if (url === "/speakers") return Promise.resolve({ data: speakers });
    // 셸 안에서 열리는 /settings 라우트가 부르는 두 엔드포인트.
    if (url === "/system/capabilities")
      return Promise.resolve({
        data: {
          platform: "darwin",
          arch: "arm64",
          chip: "Apple M2 Pro",
          memory_gb: 32,
          gpu_eligible: true,
          recommended_preset: "standard",
        },
      });
    if (url === "/settings/processing")
      return Promise.resolve({
        data: {
          preset: "standard",
          preset_revision: "2026-08-12.3",
          language: "ko",
          whisper_model: "large-v3-turbo",
          devices: { diarization: "gpu", stt: "gpu" },
          summary_model: "mlx-community/Qwen3.5-9B-8bit",
        },
      });
    if (url === "/lenses/extraction-status")
      return Promise.resolve({ data: { running: 0, failed: [] } });
    const ml = url.match(/^\/meetings\/([^/]+)\/lenses$/);
    if (ml) {
      // m4는 추출이 끝난 회의, 나머지는 이 버전에서 아직 안 돌린 회의(null) —
      // 업로드에서 렌즈를 미뤘을 때의 서버 응답 모양이다.
      return Promise.resolve({
        data: {
          items: meetingLensesOf(ml[1]),
          extraction_status: ml[1] === "m4" ? "done" : null,
        },
      });
    }
    if (url.startsWith("/lenses?")) {
      const qs = new URLSearchParams(url.slice("/lenses?".length));
      const items = qs.get("kind") === "action" ? lensActionItems : [];
      return Promise.resolve({ data: { items, next_cursor: null } });
    }
    if (url.endsWith("/status"))
      return Promise.resolve({
        data: { ...status, search_index: searchIndex },
      });
    const m = url.match(/^\/meetings\/([^/]+)$/);
    if (m) {
      if (m[1] === "m_err" || deletedIds.has(m[1]))
        return Promise.reject(new Error(`detail fetch failed: ${m[1]}`));
      return Promise.resolve({ data: detailOf(m[1]) });
    }
    return Promise.reject(new Error(`unhandled GET ${url}`));
  }

  /** DELETE — 회의 삭제만 상태로 남기고, 즐겨찾기 해제 등은 기존대로 빈 응답. */
  function deleteResponse(url: string) {
    const m = url.match(/^\/meetings\/([^/]+)$/);
    if (m) deletedIds.add(m[1]);
    return Promise.resolve({ data: {} });
  }

  const blockListFetches = () => {
    listBlocked = true;
  };
  const releaseListFetches = () => {
    listBlocked = false;
    pendingList.forEach((f) => f());
    pendingList = [];
  };

  const reset = () => {
    deletedIds.clear();
    detailOverrides.clear();
    searchIndex = null;
    releaseListFetches();
  };

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
    if (/^\/lenses\/[^/]+\/(complete|reopen)$/.test(url)) {
      return Promise.resolve({ data: {} });
    }
    if (/^\/meetings\/[^/]+\/reindex$/.test(url)) {
      return Promise.resolve({
        data: { meeting_id: "m1", processing_version: 1, job_id: "job_9" },
      });
    }
    if (/^\/meetings\/[^/]+\/(summary|lenses)\/cancel$/.test(url)) {
      return Promise.resolve({ data: { job_id: "job_5", status: "failed" } });
    }
    if (/^\/meetings\/[^/]+\/cancel$/.test(url)) {
      return Promise.resolve({
        data: { meeting_id: "m3", job_id: "job_3", status: "failed" },
      });
    }
    if (/^\/meetings\/[^/]+\/lenses\/extract$/.test(url)) {
      return Promise.resolve({
        data: {
          run_id: "ler_1",
          job_id: "job_1",
          status: "queued",
          processing_version: 0,
        },
      });
    }
    return Promise.reject(new Error(`unhandled POST ${url}`));
  }

  return {
    getResponse,
    postResponse,
    deleteResponse,
    detailOf,
    reset,
    setDetailOverride,
    setSearchIndex,
    blockListFetches,
    releaseListFetches,
  };
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
      delete: vi.fn((url: string) => fx.deleteResponse(url)),
    },
  };
});

// vitest는 globals 없이 돌므로 RTL 자동 cleanup이 걸리지 않는다 — 명시 등록.
afterEach(cleanup);
// 삭제 상태는 목에 남으므로 테스트 간 누출을 막는다.
afterEach(() => fx.reset());

// 실제 라우트 트리(routes)를 메모리 라우터로 돌려 셸+뷰 조합을 그대로 검증한다.
// 반환값에 router를 얹어, 테스트가 현재 URL(location.search 등)을 단언할 수 있게 한다.
function renderShell(initialEntry = "/meetings/m1") {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const router = createMemoryRouter(routes, { initialEntries: [initialEntry] });
  const utils = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { ...utils, router, client };
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

test("silence와 transcribe_failed 발화는 전사에 렌더하지 않는다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  const log = screen.getByRole("log", { name: "회의 전사" });
  // silence 행은 렌더되지 않는다.
  expect(log.querySelector('[data-uid="u4"]')).toBeNull();
  // transcribe_failed 행도 렌더되지 않는다 — 안내 문구가 전사를 끊는다.
  expect(log.querySelector('[data-uid="u5"]')).toBeNull();
  expect(log).not.toHaveTextContent("전사하지 못한 구간입니다");
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
  fireEvent.click(screen.getByRole("link", { name: /스프린트 회고/ }));
  expect(
    await screen.findByRole("heading", { level: 1, name: "스프린트 회고" }),
  ).toBeInTheDocument();
  // 레일의 활성 표시는 URL(:meetingId)에서 나온다.
  expect(screen.getByRole("link", { name: /스프린트 회고/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("회의를 전환해도 플레이바는 하나만 남는다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  // 트랜스포트 재생 버튼(정확히 "재생")은 플레이바당 1개다.
  expect(screen.getAllByRole("button", { name: "재생" })).toHaveLength(1);

  fireEvent.click(screen.getByRole("link", { name: /스프린트 회고/ }));
  await screen.findByRole("heading", { level: 1, name: "스프린트 회고" });

  // 이전 회의의 플레이바가 남아 쌓이면 안 된다.
  expect(screen.getAllByRole("button", { name: "재생" })).toHaveLength(1);
});

test("회의를 전환해도 재생 배속이 유지된다", async () => {
  const { container } = renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.loadedMetadata(container.querySelector("audio")!);
  // 1x → 1.2x. Radix Select는 jsdom에서 pointer 이벤트를 못 받아 키보드로 연다.
  const trigger = screen.getByRole("combobox", { name: "재생 속도" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "1.2x" }));
  expect(container.querySelector("audio")!.playbackRate).toBe(1.2);

  fireEvent.click(screen.getByRole("link", { name: /스프린트 회고/ }));
  await screen.findByRole("heading", { level: 1, name: "스프린트 회고" });

  // 회의 뷰는 회의마다 리마운트되지만 배속은 살아남아야 하고(전사를 훑는 동안
  // 유지되는 작업 모드다), 새 <audio>에도 다시 적용돼야 한다.
  expect(screen.getByRole("combobox", { name: "재생 속도" })).toHaveTextContent(
    "1.2x",
  );
  const next = container.querySelector("audio")!;
  fireEvent.loadedMetadata(next);
  expect(next.playbackRate).toBe(1.2);
});

test("모든 회의(전역 렌즈)로 전환하면 렌즈 대시보드와 탭이 보인다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.click(screen.getByRole("link", { name: "모든 회의" }));
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

test("전역 렌즈 대시보드에서 근거 점프하면 회의뷰로 전환되고 발언 하이라이트와 seek이 함께 일어난다", async () => {
  const { container } = renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.click(screen.getByRole("link", { name: "모든 회의" }));
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

  // ?u=는 하이라이트와 seek을 함께 뜻한다 — v3.start_ms = 12_000 → 12초.
  const audio = container.querySelector("audio")!;
  fireEvent.loadedMetadata(audio);
  expect(audio.currentTime).toBeCloseTo(12, 3);
});

test("근거 점프 대상 발언이 재처리로 사라졌으면 토스트를 띄우고 activeId를 비운다", async () => {
  const { router } = renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.click(screen.getByRole("link", { name: "모든 회의" }));
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

  // u는 히스토리에 남지 않아야 한다 — 남으면 뒤로가기로 되살아나 토스트가 반복된다.
  // search만 보면 push로 지워도 통과하므로 historyAction까지 못 박는다.
  await waitFor(() => expect(router.state.location.search).toBe(""));
  expect(router.state.historyAction).toBe("REPLACE");
});

test("이미 열린 회의에서 ?u=만 바뀌어도 재생 위치가 옮겨진다", async () => {
  const { container } = renderShell("/meetings/m2");
  await screen.findByRole("heading", { level: 1, name: "스프린트 회고" });

  // 메타데이터를 먼저 준비시킨다 — 이 시점엔 아직 u가 없다.
  const audio = container.querySelector("audio")!;
  fireEvent.loadedMetadata(audio);
  expect(audio.currentTime).toBe(0);

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const option = await screen.findByRole("option", {
    name: /다음 스프린트도 이어가죠/,
  });
  fireEvent.click(option);

  // 같은 회의라 오디오는 재로드되지 않는다. loadedMetadata를 다시 쏘지 않아도
  // seek되어야 한다 — v3.start_ms = 12_000 → 12초.
  await waitFor(() => expect(audio.currentTime).toBeCloseTo(12, 3));
});

test("이미 활성인 발언을 다시 눌러도 그 지점으로 다시 seek되고 히스토리는 쌓이지 않는다", async () => {
  const { container, router } = renderShell("/meetings/m2");
  await screen.findByRole("heading", { level: 1, name: "스프린트 회고" });
  const audio = container.querySelector("audio")!;
  fireEvent.loadedMetadata(audio);

  const log = screen.getByRole("log", { name: "회의 전사" });
  const block = log.querySelector('[data-uid="v2"]') as HTMLElement;
  const jump = within(block).getByRole("button", { name: /원문 보기/ });

  // 거쳐 간 히스토리 동작을 기록한다 — 점프마다 PUSH가 쌓이면 회의를 벗어나는
  // 데 점프 횟수만큼 뒤로가기가 필요해진다.
  const actions: string[] = [];
  const unsubscribe = router.subscribe((s) => actions.push(s.historyAction));

  fireEvent.click(jump);
  // v2.start_ms = 5_000 → 5초.
  await waitFor(() => expect(audio.currentTime).toBeCloseTo(5, 3));

  // 계속 듣다가 같은 발언을 다시 누르는 상황("여기서 다시 듣기").
  audio.currentTime = 120;
  fireEvent.click(jump);
  expect(audio.currentTime).toBeCloseTo(5, 3);

  unsubscribe();
  expect(actions).not.toContain("PUSH");
  expect(router.state.location.search).toBe("?u=v2");
});

test("목록 첫 회의를 삭제하면 삭제된 회의로 되돌아가지 않는다", async () => {
  const { router } = renderShell("/meetings/m1");
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });

  // 거쳐 간 경로를 모두 기록한다. 최종 위치만 보면, 목록 재조회가 끝난 뒤
  // 뒤늦게 교정되는 경우까지 통과해 버려 회귀를 못 잡는다.
  const seen: string[] = [];
  const unsubscribe = router.subscribe((s) => seen.push(s.location.pathname));

  // 무효화 재조회를 붙잡아, IndexRoute가 캐시된 목록만 보고 판단하게 만든다.
  fx.blockListFetches();

  fireEvent.click(screen.getByRole("button", { name: "삭제" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));

  // 삭제 성공 → `/`로 replace → IndexRoute가 남은 회의 중 첫 회의로 보낸다.
  expect(await screen.findByText("회의를 삭제했어요.")).toBeInTheDocument();
  expect(
    await screen.findByRole("heading", { level: 1, name: "스프린트 회고" }),
  ).toBeInTheDocument();
  unsubscribe();

  // 방금 삭제한 회의로는 단 한 번도 돌아가지 않아야 한다(404 막다른 길).
  expect(seen).not.toContain("/meetings/m1");
  expect(router.state.location.pathname).toBe("/meetings/m2");

  fx.releaseListFetches();
});

test("없는 회의 id로 진입하면 상세 오류 상태를 렌더하고 레일은 살아 있다", async () => {
  renderShell("/meetings/m_err");
  expect(
    await screen.findByText(
      "회의를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("navigation", { name: "주 탐색" }),
  ).toBeInTheDocument();
});

test("처리 설정 라우트도 셸 안에서 열리고 레일에 활성 표시가 남는다", async () => {
  renderShell("/settings");
  expect(
    await screen.findByRole("heading", { level: 1, name: "처리 설정" }),
  ).toBeInTheDocument();
  // 회의 밖 화면에서도 셸 크롬(회의 목록 레일)이 끊기지 않는다.
  expect(
    screen.getByRole("navigation", { name: "주 탐색" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "처리 설정" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("새 회의 기록하기로 업로드 다이얼로그를 연다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.click(screen.getByRole("button", { name: /새 회의 기록하기/ }));
  expect(
    await screen.findByRole("heading", { name: "새 회의 기록하기" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "업로드 시작" }),
  ).toBeInTheDocument();
});

test("처리 중인 회의는 목록에 처리 중 뱃지를 보여준다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  expect(screen.getByText("처리 중")).toBeInTheDocument();
});

test("색인 실패한 회의는 색인 실패 배너와 다시 색인 버튼을 보여준다", async () => {
  fx.setSearchIndex({
    status: "failed",
    error: { code: "uncategorized", message: "boom" },
    updated_at: "2026-08-21T06:16:35.000Z",
  });
  renderShell();
  expect(await screen.findByText(/검색 색인에 실패했어요/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "다시 색인" }));
  await waitFor(() =>
    expect(apiClient.post).toHaveBeenCalledWith("/meetings/m1/reindex"),
  );
});

test("색인이 정상이면 done 회의에 색인 배너를 그리지 않는다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  expect(screen.queryByText(/검색 색인에 실패했어요/)).toBeNull();
});

test("전사가 아직 없는 처리 중 회의에서는 플레이바를 그리지 않는다", async () => {
  renderShell("/meetings/m3");
  expect(await screen.findByText(/회의를 처리하고 있어요/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "재생" })).toBeNull();
});

test("처리 중 배너의 취소 버튼은 POST /meetings/:id/cancel을 부른다", async () => {
  renderShell("/meetings/m3");
  await screen.findByText(/회의를 처리하고 있어요/);
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  await waitFor(() =>
    expect(apiClient.post).toHaveBeenCalledWith("/meetings/m3/cancel"),
  );
});

test("취소된 회의는 실패가 아니라 취소 안내를 보여준다", async () => {
  fx.setDetailOverride("m3", {
    ...fx.detailOf("m3"),
    status: "failed",
    current_job_id: null,
    error: {
      code: "cancelled",
      stage: "stt",
      message: "cancelled by operator",
    },
  });
  renderShell("/meetings/m3");
  expect(await screen.findByText(/처리를 취소했어요/)).toBeInTheDocument();
  expect(screen.queryByText(/처리에 실패했어요/)).toBeNull();
});

test("처리 중이던 회의가 done이 되면 <audio>를 다시 로드한다", async () => {
  const { container, client } = renderShell("/meetings/m3");
  await screen.findByText(/회의를 처리하고 있어요/);
  const before = container.querySelector("audio")!;
  expect(before).not.toBeNull();

  // 워커가 normalized.flac을 쓰고 나면 같은 /audio URL이 다른 파일을 내려준다.
  // src가 그대로면 브라우저는 재로드하지 않고 원본 기준의 낡은 상태에 머문다.
  fx.setDetailOverride("m3", {
    ...fx.detailOf("m3"),
    status: "done",
    current_job_id: null,
    utterances: fx.detailOf("m1").utterances,
    clusters: fx.detailOf("m1").clusters,
  });
  await client.invalidateQueries({ queryKey: ["meeting", "m3"] });
  await screen.findByRole("button", { name: "재생" });

  const after = container.querySelector("audio")!;
  expect(after).not.toBe(before);
});

test("상세 조회에 실패하면 무한 스피너 대신 에러 상태와 재시도를 보여준다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.click(screen.getByRole("link", { name: /불러오기 실패 회의/ }));
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
  fireEvent.click(screen.getByRole("link", { name: /스프린트 회고/ }));
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
  // 다른 회의로의 점프: 새 오디오가 준비된(loadedMetadata) 뒤 seek이 적용된다.
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

test("summary가 done인 회의는 요약 탭이 실제 데이터로 채워지고, 체크박스는 완료 상태를 서버에 반영한다", async () => {
  renderShell();
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });
  fireEvent.click(screen.getByRole("link", { name: /요약이 준비된 회의/ }));
  await screen.findByRole("heading", {
    level: 1,
    name: "요약이 준비된 회의",
  });

  // 주요 주제 — WireSummary → toMeetingDetail → settled 경로.
  expect(await screen.findByText("로드맵 정리")).toBeInTheDocument();
  expect(screen.getByText("예산 검토")).toBeInTheDocument();

  // 단락별 요약.
  expect(screen.getByText("회의 도입부")).toBeInTheDocument();

  // 회의별 렌즈(GET /meetings/:id/lenses) → mapMeetingLenses → Todos/Decisions.
  const actionCheckbox = (await screen.findByRole("checkbox", {
    name: "완료: 예산안 다시 검토하기",
  })) as HTMLInputElement;
  expect(actionCheckbox.checked).toBe(false);
  expect(screen.getByText("3분기까지 v2로 한정")).toBeInTheDocument();

  // 체크박스를 누르면 로컬 상태만 바뀌는 게 아니라 실제 완료 API를 호출한다.
  fireEvent.click(actionCheckbox);
  await waitFor(() =>
    expect(apiClient.post).toHaveBeenCalledWith(
      "/lenses/lens_m4_action/complete",
    ),
  );
});

test("요약 생성 중인 회의는 취소 버튼으로 POST /summary/cancel을 부른다", async () => {
  fx.setDetailOverride("m1", {
    ...fx.detailOf("m1"),
    summary: { status: "running", topics: [], segments: [], error: null },
  });
  renderShell("/meetings/m1");
  const busy = (await screen.findByText("요약을 만들고 있어요")).closest(
    "[role=status]",
  ) as HTMLElement;
  fireEvent.click(within(busy).getByRole("button", { name: "취소" }));
  await waitFor(() =>
    expect(apiClient.post).toHaveBeenCalledWith("/meetings/m1/summary/cancel"),
  );
});

test("렌즈를 미뤄둔 회의는 지금 찾기 버튼으로 추출을 걸 수 있다", async () => {
  // m4가 아닌 회의 = extraction_status null (업로드에서 defer_lens로 미룬 모습).
  renderShell("/meetings/m1");
  await screen.findByRole("heading", {
    level: 1,
    name: "기획회의 — UI 개선안",
  });

  fireEvent.click(await screen.findByRole("button", { name: "지금 찾기" }));
  await waitFor(() =>
    expect(apiClient.post).toHaveBeenCalledWith("/meetings/m1/lenses/extract"),
  );
});

test("플레이바의 다음 발언 버튼은 다음 블록으로 seek하고 하이라이트한다", async () => {
  const { container, router } = renderShell("/meetings/m2");
  await screen.findByRole("heading", { level: 1, name: "스프린트 회고" });
  const audio = container.querySelector("audio")!;
  fireEvent.loadedMetadata(audio);

  // 시작 위치(0s = v1 블록)에서 다음 → v2 블록(5초).
  fireEvent.click(screen.getByRole("button", { name: "다음 발언" }));
  await waitFor(() => expect(audio.currentTime).toBeCloseTo(5, 3));
  expect(router.state.location.search).toBe("?u=v2");

  // 마지막 블록에서는 다음 발언이 비활성.
  expect(screen.getByRole("button", { name: "다음 발언" })).toBeDisabled();

  // 5초 직후 이전 → v1(0초)로 돌아간다.
  fireEvent.click(screen.getByRole("button", { name: "이전 발언" }));
  await waitFor(() => expect(router.state.location.search).toBe("?u=v1"));
});

test("재생 위치가 속한 블록에 aria-current가 붙는다", async () => {
  const { container } = renderShell("/meetings/m2");
  await screen.findByRole("heading", { level: 1, name: "스프린트 회고" });
  const audio = container.querySelector("audio")!;
  fireEvent.loadedMetadata(audio);
  const log = screen.getByRole("log", { name: "회의 전사" });

  // 0초 → v1 블록.
  expect(log.querySelector('[aria-current="true"]')).toHaveAttribute(
    "data-uid",
    "v1",
  );

  // 6초 → v2 블록(5초 시작, v3 병합).
  audio.currentTime = 6;
  fireEvent.timeUpdate(audio);
  await waitFor(() =>
    expect(log.querySelector('[aria-current="true"]')).toHaveAttribute(
      "data-uid",
      "v2",
    ),
  );
});

test("audio.duration이 매핑된 길이와 미세하게 달라도 재생 블록이 밀리지 않는다", async () => {
  const { container } = renderShell("/meetings/m2");
  await screen.findByRole("heading", { level: 1, name: "스프린트 회고" });
  const audio = container.querySelector("audio")!;
  // 실제 브라우저는 duration_ms를 초로 내린 값과 소수점 아래가 다르다.
  Object.defineProperty(audio, "duration", {
    value: 3497.4,
    configurable: true,
  });
  fireEvent.loadedMetadata(audio);
  const log = screen.getByRole("log", { name: "회의 전사" });

  // 정확히 v2 시작(5초)에 서 있다 → v2가 재생 블록이어야 한다.
  audio.currentTime = 5;
  fireEvent.timeUpdate(audio);
  await waitFor(() =>
    expect(log.querySelector('[aria-current="true"]')).toHaveAttribute(
      "data-uid",
      "v2",
    ),
  );
  // 다음 발언도 v2에 머물지 않고 실제 다음으로 간다 — m2는 v2가 마지막 블록.
  expect(screen.getByRole("button", { name: "다음 발언" })).toBeDisabled();
});
