import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { NotePane } from "./note-pane";

// vitest는 globals 없이 돌므로 RTL 자동 cleanup이 걸리지 않는다 — 명시 등록.
afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

function renderPane() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <NotePane meetingId="mtg_1" />
    </QueryClientProvider>,
  );
}

test("메모가 없으면 빈 상태와 '메모 쓰기'를 보여 준다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { note: null },
  } as never);
  renderPane();
  expect(await screen.findByText("아직 메모가 없어요.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "메모 쓰기" })).toBeInTheDocument();
});

test("메모가 있으면 마크다운을 렌더한다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      note: { body_md: "## 결정사항", updated_at: "2026-08-27T00:00:00.000Z" },
    },
  } as never);
  renderPane();
  expect(
    await screen.findByRole("heading", { name: "결정사항", level: 2 }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

test("raw HTML은 태그가 아니라 텍스트로 나온다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      note: {
        body_md: "<img src=x onerror=alert(1)>",
        updated_at: "2026-08-27T00:00:00.000Z",
      },
    },
  } as never);
  const { container } = renderPane();
  await screen.findByText(/onerror/);
  expect(container.querySelector("img")).toBeNull();
});

test("마크다운 이미지는 <img> 없이 alt 텍스트로 나온다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      note: {
        body_md: "![beacon](http://evil.tracker.example/pixel.gif)",
        updated_at: "2026-08-27T00:00:00.000Z",
      },
    },
  } as never);
  const { container } = renderPane();
  await screen.findByText("beacon");
  expect(container.querySelector("img")).toBeNull();
});

test("메모 조회가 실패하면 에러 메시지와 다시 시도 버튼만 보여 주고 편집을 허용하지 않는다", async () => {
  vi.spyOn(apiClient, "get").mockRejectedValue(new Error("boom"));
  renderPane();
  expect(
    await screen.findByText("메모를 불러오지 못했어요."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "메모 쓰기" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

test("'편집'을 누르면 textarea가 열린다", async () => {
  const user = userEvent.setup();
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { note: { body_md: "본문", updated_at: "2026-08-27T00:00:00.000Z" } },
  } as never);
  renderPane();
  await user.click(await screen.findByRole("button", { name: "편집" }));
  expect(screen.getByRole("textbox", { name: "메모 본문" })).toHaveValue(
    "본문",
  );
});

test("툴바 '굵게'가 선택 영역을 감싼다", async () => {
  const user = userEvent.setup();
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { note: null },
  } as never);
  vi.spyOn(apiClient, "put").mockResolvedValue({
    data: {
      note: { body_md: "**가나**", updated_at: "2026-08-27T00:00:00.000Z" },
    },
  } as never);
  renderPane();
  await user.click(await screen.findByRole("button", { name: "메모 쓰기" }));

  const box = screen.getByRole("textbox", {
    name: "메모 본문",
  }) as HTMLTextAreaElement;
  await user.type(box, "가나");
  box.setSelectionRange(0, 2);
  await user.click(screen.getByRole("button", { name: "굵게" }));

  expect(box).toHaveValue("**가나**");
});

test("'완료'를 누르면 읽기모드로 돌아온다", async () => {
  const user = userEvent.setup();
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { note: { body_md: "본문", updated_at: "2026-08-27T00:00:00.000Z" } },
  } as never);
  vi.spyOn(apiClient, "put").mockResolvedValue({
    data: { note: { body_md: "본문", updated_at: "2026-08-27T00:00:00.000Z" } },
  } as never);
  renderPane();
  await user.click(await screen.findByRole("button", { name: "편집" }));
  await user.click(screen.getByRole("button", { name: "완료" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("textbox", { name: "메모 본문" }),
    ).not.toBeInTheDocument(),
  );
});

test("회의가 바뀌면 편집 중이었어도 읽기모드로 돌아온다", async () => {
  const user = userEvent.setup();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { note: { body_md: "본문", updated_at: "2026-08-27T00:00:00.000Z" } },
  } as never);
  const { rerender } = render(
    <QueryClientProvider client={qc}>
      <NotePane meetingId="mtg_1" />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "편집" }));
  expect(
    screen.getByRole("textbox", { name: "메모 본문" }),
  ).toBeInTheDocument();

  rerender(
    <QueryClientProvider client={qc}>
      <NotePane meetingId="mtg_2" />
    </QueryClientProvider>,
  );

  await waitFor(() =>
    expect(
      screen.queryByRole("textbox", { name: "메모 본문" }),
    ).not.toBeInTheDocument(),
  );
});

test("저장이 실패하면 편집기 안에 다시 시도 버튼이 뜬다", async () => {
  const user = userEvent.setup();
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { note: null },
  } as never);
  vi.spyOn(apiClient, "put").mockRejectedValue(new Error("boom"));
  renderPane();
  await user.click(await screen.findByRole("button", { name: "메모 쓰기" }));
  await user.type(screen.getByRole("textbox", { name: "메모 본문" }), "가");

  expect(
    await screen.findByRole("button", { name: "다시 시도" }, { timeout: 3000 }),
  ).toBeInTheDocument();
});
