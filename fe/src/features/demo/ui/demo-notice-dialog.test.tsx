import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import {
  DEMO_NOTICE_STORAGE_KEY,
  DemoNoticeDialog,
} from "@/features/demo/ui/demo-notice-dialog";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

test("첫 방문이면 데모 안내 모달이 열린다", () => {
  render(<DemoNoticeDialog />);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /데모/ })).toBeInTheDocument();
  expect(screen.getByText(/읽기 전용|결과.*확인/)).toBeInTheDocument();
  expect(screen.getByText(/실제 인물의 음성이 아닙니다/)).toBeInTheDocument();
});

test("확인을 누르면 닫히고 다음 방문엔 뜨지 않는다", async () => {
  const user = userEvent.setup();
  const { unmount } = render(<DemoNoticeDialog />);
  await user.click(screen.getByRole("button", { name: "확인" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(localStorage.getItem(DEMO_NOTICE_STORAGE_KEY)).not.toBeNull();
  unmount();
  render(<DemoNoticeDialog />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("localStorage를 못 읽어도 모달은 뜬다", () => {
  const original = Storage.prototype.getItem;
  Storage.prototype.getItem = () => {
    throw new Error("blocked");
  };
  try {
    render(<DemoNoticeDialog />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  } finally {
    Storage.prototype.getItem = original;
  }
});
