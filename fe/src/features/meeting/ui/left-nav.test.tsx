import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

/**
 * LeftNav가 스스로 하는 이동(업로드 완료 → 새 회의 경로)만 좁게 검증한다.
 * 업로드 자체는 NewMeetingDialog 목으로 대체해 흉내 낸다.
 */

vi.mock("@/shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/client")>()),
  apiClient: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/features/meeting/ui/new-meeting-dialog", () => ({
  NewMeetingDialog: ({
    open,
    onCreated,
    defaultFolderId,
  }: {
    open: boolean;
    onCreated: (id: string) => void;
    defaultFolderId?: string;
  }) =>
    open ? (
      <>
        <button type="button" onClick={() => onCreated("m9")}>
          업로드 완료 흉내
        </button>
        <button type="button" onClick={() => onCreated("m8")}>
          녹음 시작 흉내
        </button>
        <span>모달 폴더: {defaultFolderId ?? "없음"}</span>
      </>
    ) : null,
}));

const { LeftNav } = await import("@/features/meeting/ui/left-nav");

afterEach(cleanup);

function Probe() {
  return <span>경로: {useLocation().pathname}</span>;
}

test("업로드가 끝나면 새 회의 경로로 이동한다", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Probe />
        <Routes>
          <Route
            path="*"
            element={
              <LeftNav
                filter="all"
                onFilter={() => {}}
                onOpenSearch={() => {}}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /새 회의 기록하기/ }));
  fireEvent.click(screen.getByRole("button", { name: "업로드 완료 흉내" }));
  expect(await screen.findByText("경로: /meetings/m9")).toBeInTheDocument();
});

test("통합 다이얼로그에서 녹음을 시작하면 새 회의 경로로 이동한다", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Probe />
        <Routes>
          <Route
            path="*"
            element={
              <LeftNav
                filter="all"
                onFilter={() => {}}
                onOpenSearch={() => {}}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(
    screen.queryByRole("button", { name: "녹음 시작" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /새 회의 기록하기/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "녹음 시작 흉내" }),
  );
  expect(await screen.findByText("경로: /meetings/m8")).toBeInTheDocument();
});

test("녹음 중인 회의에는 '녹음 중' 뱃지가 붙는다", async () => {
  const { apiClient } = await import("@/shared/api/client");
  (apiClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    data: [
      {
        id: "m1",
        title: "지금 회의",
        original_filename: null,
        audio_key: "k",
        normalized_key: null,
        recorded_at: "2026-09-05T10:00:00.000Z",
        duration_ms: null,
        status: "recording",
        is_favorite: false,
        current_job_id: "job_1",
        processing_version: 0,
        error: null,
        created_at: "2026-09-05T10:00:00.000Z",
      },
    ],
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="*"
            element={
              <LeftNav
                filter="all"
                onFilter={() => {}}
                onOpenSearch={() => {}}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("녹음 중")).toBeInTheDocument();
});

test("새 회의 기록하기 버튼은 잠겨 있지 않다", () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <LeftNav filter="all" onFilter={() => {}} onOpenSearch={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(
    screen.getByRole("button", { name: /새 회의 기록하기/ }),
  ).not.toBeDisabled();
});

test("사이드바 맨 아래에 화면 테마 버튼이 있다", () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <LeftNav filter="all" onFilter={() => {}} onOpenSearch={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const nav = screen.getByRole("navigation", { name: "주 탐색" });
  const button = screen.getByRole("button", { name: /^화면 테마: / });
  expect(nav).toContainElement(button);
});

test("태그를 누르면 그 태그가 붙은 회의만 남고, 다시 누르면 풀린다", async () => {
  const { apiClient } = await import("@/shared/api/client");
  const row = (
    id: string,
    title: string,
    tags: { id: string; name: string }[],
  ) => ({
    id,
    title,
    original_filename: null,
    audio_key: "k",
    normalized_key: null,
    recorded_at: "2026-09-05T10:00:00.000Z",
    duration_ms: 60000,
    status: "done",
    is_favorite: false,
    current_job_id: null,
    processing_version: 0,
    error: null,
    created_at: "2026-09-05T10:00:00.000Z",
    tags,
  });
  const get = apiClient.get as ReturnType<typeof vi.fn>;
  get.mockImplementation(async (url: string) =>
    url === "/tags"
      ? { data: [{ id: "tag_1", name: "프로젝트A", meeting_count: 1 }] }
      : {
          data: [
            row("m1", "태그 붙은 회의", [{ id: "tag_1", name: "프로젝트A" }]),
            row("m2", "다른 회의", []),
          ],
        },
  );
  try {
    renderNav();
    const pill = await screen.findByRole("button", { name: "#프로젝트A" });
    expect(await screen.findByText("다른 회의")).toBeInTheDocument();

    fireEvent.click(pill);
    expect(pill).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("태그 붙은 회의")).toBeInTheDocument();
    expect(screen.queryByText("다른 회의")).not.toBeInTheDocument();

    fireEvent.click(pill);
    expect(screen.getByText("다른 회의")).toBeInTheDocument();
  } finally {
    get.mockResolvedValue({ data: [] });
  }
});

function renderNav() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <LeftNav filter="all" onFilter={() => {}} onOpenSearch={() => {}} />
        <input aria-label="다른 입력" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("N 키로 새 회의 모달을 연다 — 한글 자판이어도", () => {
  renderNav();
  fireEvent.keyDown(document.body, { key: "ㅜ", code: "KeyN" });
  expect(
    screen.getByRole("button", { name: "업로드 완료 흉내" }),
  ).toBeInTheDocument();
});

test("입력란에서 누른 N이나 조합키는 가로채지 않는다", () => {
  renderNav();
  fireEvent.keyDown(screen.getByRole("textbox", { name: "다른 입력" }), {
    key: "n",
    code: "KeyN",
  });
  fireEvent.keyDown(document.body, { key: "n", code: "KeyN", metaKey: true });
  expect(
    screen.queryByRole("button", { name: "업로드 완료 흉내" }),
  ).not.toBeInTheDocument();
});

type Wire = Record<string, unknown>;

const folder = (id: string, name: string, isDefault = false) => ({
  id,
  name,
  is_default: isDefault,
  created_at: "2026-10-04T00:00:00.000Z",
});

const meetingRow = (
  id: string,
  title: string,
  folderId: string,
  tags: { id: string; name: string }[] = [],
) => ({
  id,
  title,
  original_filename: null,
  audio_key: "k",
  normalized_key: null,
  recorded_at: "2026-09-05T10:00:00.000Z",
  duration_ms: 60000,
  status: "done",
  is_favorite: false,
  current_job_id: null,
  processing_version: 0,
  error: null,
  created_at: "2026-09-05T10:00:00.000Z",
  tags,
  folder_id: folderId,
});

/** URL별 GET 응답. 함수라서 테스트 도중 바꾼 값이 재조회에 반영된다. */
async function routeGet(routes: Record<string, () => Wire[]>) {
  const { apiClient } = await import("@/shared/api/client");
  const get = apiClient.get as ReturnType<typeof vi.fn>;
  get.mockImplementation(async (url: string) => ({
    data: routes[url]?.() ?? [],
  }));
  return () => get.mockResolvedValue({ data: [] });
}

const folderList = () => screen.getByRole("list", { name: "폴더" });
const folderButton = (name: string) =>
  within(folderList()).getByText(name).closest("button")!;

test("폴더를 누르면 그 폴더의 회의만 남고, 태그와 함께 걸리며, 새 회의 모달의 초기값이 된다", async () => {
  const restore = await routeGet({
    "/folders": () => [
      folder("fld_1", "기본 폴더", true),
      folder("fld_2", "기획팀"),
    ],
    "/tags": () => [{ id: "tag_1", name: "중요", meeting_count: 1 }],
    "/meetings": () => [
      meetingRow("m1", "기획 킥오프", "fld_2", [{ id: "tag_1", name: "중요" }]),
      meetingRow("m2", "기획 리뷰", "fld_2"),
      meetingRow("m3", "잡담", "fld_1"),
    ],
  });
  try {
    renderNav();
    expect(await screen.findByText("잡담")).toBeInTheDocument();
    expect(await within(folderList()).findByText("기획팀")).toBeInTheDocument();
    expect(folderButton("전체 회의")).toHaveTextContent("3");
    expect(folderButton("기본 폴더")).toHaveTextContent("1");
    expect(folderButton("기획팀")).toHaveTextContent("2");
    expect(folderButton("전체 회의")).toHaveAttribute("aria-current", "page");

    fireEvent.click(folderButton("기획팀"));
    expect(folderButton("기획팀")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText("잡담")).not.toBeInTheDocument();
    expect(screen.getByText("기획 킥오프")).toBeInTheDocument();
    expect(screen.getByText("기획 리뷰")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "#중요" }));
    expect(screen.getByText("기획 킥오프")).toBeInTheDocument();
    expect(screen.queryByText("기획 리뷰")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /새 회의 기록하기/ }));
    expect(screen.getByText("모달 폴더: fld_2")).toBeInTheDocument();
  } finally {
    restore();
  }
});

test("빈 폴더와 겹친 조건은 서로 다른 빈 목록 문구를 보인다", async () => {
  const restore = await routeGet({
    "/folders": () => [
      folder("fld_1", "기본 폴더", true),
      folder("fld_2", "기획팀"),
    ],
    "/tags": () => [{ id: "tag_1", name: "중요", meeting_count: 1 }],
    "/meetings": () => [
      meetingRow("m1", "기획 킥오프", "fld_2", [{ id: "tag_1", name: "중요" }]),
    ],
  });
  try {
    renderNav();
    await screen.findByText("기획 킥오프");
    fireEvent.click(await within(folderList()).findByText("기본 폴더"));
    expect(screen.getByText("이 폴더에 회의가 없어요.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "#중요" }));
    expect(screen.getByText("조건에 맞는 회의가 없어요.")).toBeInTheDocument();
  } finally {
    restore();
  }
});

test("기본 폴더에는 메뉴가 없고, 고른 폴더를 지우면 선택이 전체 회의로 풀린다", async () => {
  const { apiClient } = await import("@/shared/api/client");
  const del = apiClient.delete as ReturnType<typeof vi.fn>;
  del.mockResolvedValue({ data: undefined });
  let folders = [folder("fld_1", "기본 폴더", true), folder("fld_2", "기획팀")];
  const restore = await routeGet({
    "/folders": () => folders,
    "/meetings": () => [meetingRow("m1", "기획 킥오프", "fld_2")],
  });
  try {
    renderNav();
    fireEvent.click(await within(folderList()).findByText("기획팀"));
    expect(
      screen.queryByRole("button", { name: "기본 폴더 폴더 메뉴" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "기획팀 폴더 메뉴" }));
    fireEvent.click(await screen.findByRole("button", { name: "삭제" }));
    expect(
      await screen.findByText(/안에 있던 회의 1개는 기본 폴더로 옮겨져요/),
    ).toBeInTheDocument();

    folders = [folder("fld_1", "기본 폴더", true)];
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() =>
      expect(
        within(folderList()).queryByText("기획팀"),
      ).not.toBeInTheDocument(),
    );
    expect(del).toHaveBeenCalledWith("/folders/fld_2");
    expect(folderButton("전체 회의")).toHaveAttribute("aria-current", "page");
  } finally {
    restore();
  }
});

test("새 폴더: 이름이 겹치면 입력란에 알리고, 만들면 그 폴더를 고른다", async () => {
  const { apiClient, ApiError } = await import("@/shared/api/client");
  const post = apiClient.post as ReturnType<typeof vi.fn>;
  let folders = [folder("fld_1", "기본 폴더", true)];
  const restore = await routeGet({ "/folders": () => folders });
  try {
    renderNav();
    fireEvent.click(await screen.findByRole("button", { name: "새 폴더" }));
    fireEvent.change(await screen.findByLabelText("폴더 이름"), {
      target: { value: "  새팀 " },
    });

    post.mockRejectedValueOnce(new ApiError(409, "folder name already exists"));
    fireEvent.click(screen.getByRole("button", { name: "만들기" }));
    expect(
      await screen.findByText("같은 이름의 폴더가 있어요."),
    ).toBeInTheDocument();
    expect(post).toHaveBeenLastCalledWith("/folders", { name: "새팀" });

    post.mockResolvedValueOnce({ data: folder("fld_5", "새팀") });
    folders = [...folders, folder("fld_5", "새팀")];
    fireEvent.click(screen.getByRole("button", { name: "만들기" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("폴더 이름")).not.toBeInTheDocument(),
    );
    expect(await within(folderList()).findByText("새팀")).toBeInTheDocument();
    expect(folderButton("새팀")).toHaveAttribute("aria-current", "page");
  } finally {
    restore();
  }
});
