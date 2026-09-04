import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const runner = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("@/features/demo/lib/tour-runner", () => ({ tourRunner: runner }));

import { readTourState } from "@/features/demo/model/tour-state";
import { DemoNoticeDialog } from "@/features/demo/ui/demo-notice-dialog";

function renderDialog() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <DemoNoticeDialog />
    </QueryClientProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("첫 방문이면 안내 모달이 열리고 두 버튼이 있다", () => {
  renderDialog();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /데모/ })).toBeInTheDocument();
  expect(screen.getByText(/NotebookLM/)).toBeInTheDocument();
  expect(screen.getByText(/읽기 전용/)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "둘러보기 시작" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "그냥 볼게요" }),
  ).toBeInTheDocument();
});

test("둘러보기 시작 버튼에 포커스가 간다", async () => {
  renderDialog();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "둘러보기 시작" }),
    ),
    { timeout: 3000 }
  );
});

test("둘러보기 시작 → 닫히고 러너를 시작하며 다음 방문엔 안 뜬다", async () => {
  const user = userEvent.setup();
  const { unmount } = renderDialog();
  await user.click(screen.getByRole("button", { name: "둘러보기 시작" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(runner.start).toHaveBeenCalledTimes(1);
  expect(readTourState().noticeSeen).toBe(true);
  unmount();
  renderDialog();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("그냥 볼게요 → 닫히기만 한다", async () => {
  const user = userEvent.setup();
  renderDialog();
  await user.click(screen.getByRole("button", { name: "그냥 볼게요" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(runner.start).not.toHaveBeenCalled();
  expect(readTourState().noticeSeen).toBe(true);
});

test("localStorage를 못 읽어도 모달은 뜬다", () => {
  const original = Storage.prototype.getItem;
  Storage.prototype.getItem = () => {
    throw new Error("blocked");
  };
  try {
    renderDialog();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  } finally {
    Storage.prototype.getItem = original;
  }
});
