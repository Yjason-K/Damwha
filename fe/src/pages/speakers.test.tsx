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

import type { WireSpeaker } from "@/features/meeting/api/types";
import { env } from "@/shared/config/env";

/**
 * 화자 관리 페이지 통합 테스트 — 목킹한 `apiClient`로 목록 렌더와 등록 다이얼로그
 * 열기를 검증한다. 규약: vitest globals 없음 + 수동 afterEach(cleanup).
 */

const fx = vi.hoisted(() => {
  const speakers: WireSpeaker[] = [
    {
      id: "sp_1",
      name: "김영재",
      enrollment_status: "ready",
      current_job_id: null,
      enrollment_error: null,
      created_at: "2026-06-01T00:00:00.000Z",
      is_me: true,
      // 16초짜리 발화 — 미리듣기는 8초에서 끊어야 한다.
      sample_meeting_id: "mtg_3",
      sample_start_ms: 4_000,
      sample_end_ms: 20_000,
    },
    {
      id: "sp_2",
      name: "이수민",
      enrollment_status: "provisional",
      current_job_id: null,
      enrollment_error: null,
      created_at: "2026-06-10T00:00:00.000Z",
      sample_meeting_id: null,
      sample_start_ms: null,
      sample_end_ms: null,
    },
    {
      id: "sp_3",
      name: "박도윤",
      enrollment_status: "provisional",
      current_job_id: null,
      enrollment_error: null,
      created_at: "2026-06-11T00:00:00.000Z",
      sample_meeting_id: "mtg_4",
      sample_start_ms: 1_000,
      sample_end_ms: 3_000,
    },
  ];
  return { speakers };
});

vi.mock("@/shared/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/shared/api/client")>(
    "@/shared/api/client",
  );
  return {
    ...actual,
    apiClient: {
      get: vi.fn((url: string) => {
        if (url === "/speakers") return Promise.resolve({ data: fx.speakers });
        return Promise.reject(new Error(`unhandled GET ${url}`));
      }),
      post: vi.fn(() => Promise.resolve({ data: fx.speakers[0] })),
      put: vi.fn(() => Promise.resolve({ data: fx.speakers[1] })),
      patch: vi.fn(() => Promise.resolve({ data: fx.speakers[0] })),
      delete: vi.fn(() => Promise.resolve({ data: {} })),
    },
  };
});

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("@/shared/ui/use-toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/ui/use-toast")>()),
  toast: toastSpy,
}));

const { SpeakersPage } = await import("@/pages/speakers");
const { apiClient } = await import("@/shared/api/client");

afterEach(cleanup);

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SpeakersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("화자 목록을 렌더한다", async () => {
  renderPage();
  expect(await screen.findByText("김영재")).toBeInTheDocument();
  expect(screen.getByText("이수민")).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { level: 1, name: "화자 관리" }),
  ).toBeInTheDocument();
});

test("화자 등록 버튼으로 등록 다이얼로그를 연다", async () => {
  renderPage();
  await screen.findByText("김영재");
  fireEvent.click(screen.getByRole("button", { name: "화자 등록" }));
  expect(
    await screen.findByText(
      "화자의 목소리 샘플을 등록하면 회의에서 자동으로 식별할 수 있어요.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "등록" })).toBeInTheDocument();
});

test("화자가 없을 때도 등록 버튼은 헤더의 하나뿐이다", async () => {
  vi.mocked(apiClient.get).mockResolvedValueOnce({ data: [] });
  renderPage();
  expect(
    await screen.findByText("아직 등록된 화자가 없어요"),
  ).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "화자 등록" })).toHaveLength(1);
});

const rowOf = (name: string) => screen.getByText(name).closest("li")!;

test("'나'로 지정된 화자에만 나 배지와 해제 버튼이 붙는다", async () => {
  renderPage();
  await screen.findByText("김영재");
  const me = within(rowOf("김영재"));
  expect(me.getByText("나")).toBeInTheDocument();
  expect(me.getByRole("button", { name: "나 지정 해제" })).toBeInTheDocument();

  const other = within(rowOf("이수민"));
  expect(other.queryByText("나")).not.toBeInTheDocument();
  expect(other.getByRole("button", { name: "나로 지정" })).toBeInTheDocument();
});

test("나로 지정은 PUT, 해제는 DELETE를 보내고 화자 목록을 다시 읽는다", async () => {
  renderPage();
  await screen.findByText("김영재");
  const getsBefore = vi.mocked(apiClient.get).mock.calls.length;

  fireEvent.click(
    within(rowOf("이수민")).getByRole("button", { name: "나로 지정" }),
  );
  await waitFor(() =>
    expect(apiClient.put).toHaveBeenCalledWith("/speakers/sp_2/me"),
  );
  await waitFor(() =>
    expect(vi.mocked(apiClient.get).mock.calls.length).toBeGreaterThan(
      getsBefore,
    ),
  );

  fireEvent.click(
    within(rowOf("김영재")).getByRole("button", { name: "나 지정 해제" }),
  );
  await waitFor(() =>
    expect(apiClient.delete).toHaveBeenCalledWith("/speakers/sp_1/me"),
  );
});

test("지정에 실패하면 토스트를 띄우되, 데모 차단이면 건너뛴다", async () => {
  const { ApiError } = await import("@/shared/api/client");
  renderPage();
  await screen.findByText("이수민");
  const button = () =>
    within(rowOf("이수민")).getByRole("button", { name: "나로 지정" });

  toastSpy.mockClear();
  vi.mocked(apiClient.put).mockClear();
  vi.mocked(apiClient.put).mockRejectedValueOnce(
    new ApiError(403, "demo", "DEMO_READ_ONLY"),
  );
  fireEvent.click(button());
  await waitFor(() => expect(apiClient.put).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(button()).not.toBeDisabled());

  vi.mocked(apiClient.put).mockRejectedValueOnce(new ApiError(500, "boom"));
  fireEvent.click(button());
  await waitFor(() =>
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "error", description: "boom" }),
    ),
  );
  // 첫 실패(데모 차단)의 onError는 두 번째보다 먼저 돌았다 — 토스트는 500 한 번뿐이어야 한다.
  expect(toastSpy).toHaveBeenCalledTimes(1);
});

/** 미리듣기 — jsdom은 재생을 구현하지 않으므로 prototype을 가로챈다. */
function stubAudio() {
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockResolvedValue(undefined);
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => {});
  return { play, pause };
}

const listen = (name: string) =>
  screen.getByRole("button", { name: `${name} 목소리 듣기` });

test("샘플이 있는 화자에만 미리듣기 버튼이 붙는다", async () => {
  renderPage();
  expect(await screen.findByText("이수민")).toBeInTheDocument();

  expect(listen("김영재")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /이수민 목소리 듣기/ }),
  ).not.toBeInTheDocument();
});

test("미리듣기는 그 회의 오디오의 발화 구간만 8초까지 재생한다", async () => {
  const { play } = stubAudio();
  renderPage();
  fireEvent.click(
    await screen.findByRole("button", { name: "김영재 목소리 듣기" }),
  );

  const audio = document.querySelector("audio") as HTMLAudioElement;
  expect(audio.getAttribute("src")).toBe(
    `${env.apiBaseUrl}/meetings/mtg_3/audio#t=4,12`,
  );
  expect(play).toHaveBeenCalled();
  const playing = screen.getByRole("button", { name: "김영재 미리듣기 정지" });
  expect(playing).toHaveAttribute("aria-pressed", "true");
});

test("다른 화자를 누르면 앞선 미리듣기는 멈춘다", async () => {
  const { pause } = stubAudio();
  renderPage();
  fireEvent.click(
    await screen.findByRole("button", { name: "김영재 목소리 듣기" }),
  );
  fireEvent.click(listen("박도윤"));

  expect(pause).toHaveBeenCalled();
  const audio = document.querySelector("audio") as HTMLAudioElement;
  expect(audio.getAttribute("src")).toBe(
    `${env.apiBaseUrl}/meetings/mtg_4/audio#t=1,3`,
  );
  expect(listen("김영재")).toHaveAttribute("aria-pressed", "false");
  expect(
    screen.getByRole("button", { name: "박도윤 미리듣기 정지" }),
  ).toHaveAttribute("aria-pressed", "true");
});
