import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";

const put = vi.fn().mockResolvedValue({ data: { tags: [] } });
vi.mock("@/shared/api/client", () => ({
  apiClient: {
    get: vi.fn().mockResolvedValue({
      data: [{ id: "tag_9", name: "주간회의", meeting_count: 3 }],
    }),
    put: (...args: unknown[]) => put(...args),
  },
  isApiError: () => false,
}));

const { MeetingTags } = await import("./meeting-tags");

afterEach(() => {
  cleanup();
  put.mockClear();
});

function renderTags(
  tags: { id: string; name: string }[],
  suggestions: string[] = [],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MeetingTags meetingId="mtg_1" tags={tags} suggestions={suggestions} />
    </QueryClientProvider>,
  );
}

test("Enter로 새 태그를 붙인다 — 기존 태그 뒤에 이름으로 보낸다", async () => {
  renderTags([{ id: "tag_1", name: "기획" }]);
  fireEvent.click(screen.getByRole("button", { name: /추가/ }));
  const input = await screen.findByRole("textbox", { name: "새 태그 이름" });
  fireEvent.change(input, { target: { value: "  예산  " } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith("/meetings/mtg_1/tags", {
      names: ["기획", "예산"],
    }),
  );
});

test("한글 조합 중 Enter는 붙이지 않는다", async () => {
  renderTags([]);
  fireEvent.click(screen.getByRole("button", { name: "태그 추가" }));
  const input = await screen.findByRole("textbox", { name: "새 태그 이름" });
  fireEvent.change(input, { target: { value: "예" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(put).toHaveBeenCalled());
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledWith("/meetings/mtg_1/tags", { names: ["예"] });
});

test("이미 붙은 이름은 대소문자가 달라도 다시 보내지 않는다", async () => {
  renderTags([{ id: "tag_1", name: "API" }]);
  fireEvent.click(screen.getByRole("button", { name: /추가/ }));
  const input = await screen.findByRole("textbox", { name: "새 태그 이름" });
  fireEvent.change(input, { target: { value: "api" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.change(input, { target: { value: "새 태그" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(put).toHaveBeenCalled());
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledWith("/meetings/mtg_1/tags", {
    names: ["API", "새 태그"],
  });
});

test("기존 태그 제안을 누르면 그 이름으로 붙인다", async () => {
  renderTags([]);
  fireEvent.click(screen.getByRole("button", { name: "태그 추가" }));
  fireEvent.click(await screen.findByRole("button", { name: /#주간회의/ }));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith("/meetings/mtg_1/tags", {
      names: ["주간회의"],
    }),
  );
});

test("떼기 버튼은 그 태그만 빼고 보낸다", async () => {
  renderTags([
    { id: "tag_1", name: "기획" },
    { id: "tag_2", name: "예산" },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "태그 기획 떼기" }));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith("/meetings/mtg_1/tags", {
      names: ["예산"],
    }),
  );
});

test("추천 태그를 누르면 기존 태그 뒤에 붙인다", async () => {
  renderTags([{ id: "tag_1", name: "기획" }], ["주간회의"]);
  fireEvent.click(
    screen.getByRole("button", { name: "추천 태그 주간회의 붙이기" }),
  );
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith("/meetings/mtg_1/tags", {
      names: ["기획", "주간회의"],
    }),
  );
});

test("추천이 없으면 추천 영역을 그리지 않는다", () => {
  renderTags([{ id: "tag_1", name: "기획" }]);
  expect(screen.queryByText("추천")).not.toBeInTheDocument();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// 실제 화면처럼 tags prop을 ["meeting", id] 쿼리에서 읽는다 — 저장 뒤 재조회가 끝나야 prop이 바뀐다.
function renderFromQuery(
  fetchTags: () => Promise<{ id: string; name: string }[]>,
  suggestions: string[] = [],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Harness() {
    const { data } = useQuery({
      queryKey: ["meeting", "mtg_1"],
      queryFn: fetchTags,
    });
    if (!data) return null;
    return (
      <MeetingTags meetingId="mtg_1" tags={data} suggestions={suggestions} />
    );
  }
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

test("저장 중에는 추천을 연달아 눌러도 두 번째 PUT을 보내지 않는다", async () => {
  const first = deferred<{ data: { tags: [] } }>();
  put.mockImplementationOnce(() => first.promise);
  renderTags([{ id: "tag_1", name: "기획" }], ["a", "b"]);
  fireEvent.click(screen.getByRole("button", { name: "추천 태그 a 붙이기" }));
  fireEvent.click(screen.getByRole("button", { name: "추천 태그 b 붙이기" }));
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  expect(
    screen.getByRole("button", { name: "추천 태그 b 붙이기" }),
  ).toBeDisabled();
  first.resolve({ data: { tags: [] } });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "추천 태그 b 붙이기" }),
    ).toBeEnabled(),
  );
  expect(put).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledWith("/meetings/mtg_1/tags", {
    names: ["기획", "a"],
  });
});

test("저장 중에는 떼기를 연달아 눌러도 앞서 뗀 태그를 되살리지 않는다", async () => {
  const first = deferred<{ data: { tags: [] } }>();
  put.mockImplementationOnce(() => first.promise);
  renderTags([
    { id: "t1", name: "x" },
    { id: "t2", name: "y" },
    { id: "t3", name: "z" },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "태그 x 떼기" }));
  fireEvent.click(screen.getByRole("button", { name: "태그 y 떼기" }));
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  first.resolve({ data: { tags: [] } });
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  expect(put).toHaveBeenCalledWith("/meetings/mtg_1/tags", {
    names: ["y", "z"],
  });
});

test("저장 중에는 팝오버에서 Enter를 두 번 쳐도 PUT을 한 번만 보낸다", async () => {
  const first = deferred<{ data: { tags: [] } }>();
  put.mockImplementationOnce(() => first.promise);
  renderTags([{ id: "tag_1", name: "기획" }]);
  fireEvent.click(screen.getByRole("button", { name: /추가/ }));
  const input = await screen.findByRole("textbox", { name: "새 태그 이름" });
  fireEvent.change(input, { target: { value: "a" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.change(input, { target: { value: "b" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  expect(put).toHaveBeenCalledWith("/meetings/mtg_1/tags", {
    names: ["기획", "a"],
  });
});

test("PUT이 끝나도 회의 재조회가 끝나기 전에는 막고, 끝난 뒤에는 새 목록에 붙인다", async () => {
  const refetch = deferred<{ id: string; name: string }[]>();
  const fetchTags = vi
    .fn()
    .mockResolvedValueOnce([{ id: "t1", name: "기획" }])
    .mockImplementationOnce(() => refetch.promise);
  renderFromQuery(fetchTags, ["a", "b"]);
  fireEvent.click(
    await screen.findByRole("button", { name: "추천 태그 a 붙이기" }),
  );
  await waitFor(() => expect(fetchTags).toHaveBeenCalledTimes(2));
  // PUT은 이미 끝났지만 prop은 아직 [기획] — 여기서 b를 보내면 a가 지워진다.
  fireEvent.click(screen.getByRole("button", { name: "추천 태그 b 붙이기" }));
  expect(put).toHaveBeenCalledTimes(1);
  refetch.resolve([
    { id: "t1", name: "기획" },
    { id: "t2", name: "a" },
  ]);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "추천 태그 b 붙이기" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "추천 태그 b 붙이기" }));
  await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
  expect(put).toHaveBeenLastCalledWith("/meetings/mtg_1/tags", {
    names: ["기획", "a", "b"],
  });
});
