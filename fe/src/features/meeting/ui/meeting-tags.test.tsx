import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

function renderTags(tags: { id: string; name: string }[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MeetingTags meetingId="mtg_1" tags={tags} />
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
