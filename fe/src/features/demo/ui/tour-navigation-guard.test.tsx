import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const runner = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    active: false,
    navigating: false,
    stop: vi.fn(),
    isActive: () => runner.active,
    isNavigating: () => runner.navigating,
    onExitRequest: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emitExit: () => listeners.forEach((cb) => cb()),
  };
});
vi.mock("@/features/demo/lib/tour-runner", () => ({ tourRunner: runner }));

const blocker = vi.hoisted(() => ({
  state: "unblocked" as "unblocked" | "blocked",
  proceed: vi.fn(),
  reset: vi.fn(),
  shouldBlock: null as
    | null
    | ((a: {
        currentLocation: { pathname: string };
        nextLocation: { pathname: string };
      }) => boolean),
}));
vi.mock("react-router", () => ({
  useBlocker: (fn: typeof blocker.shouldBlock) => {
    blocker.shouldBlock = fn;
    return blocker;
  },
}));

import { TourNavigationGuard } from "./tour-navigation-guard";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  runner.active = false;
  runner.navigating = false;
  blocker.state = "unblocked";
});

test("투어가 비활성이면 라우트 이동을 막지 않는다", () => {
  render(<TourNavigationGuard />);
  expect(
    blocker.shouldBlock!({
      currentLocation: { pathname: "/" },
      nextLocation: { pathname: "/settings" },
    }),
  ).toBe(false);
});

test("투어 활성 중 사용자의 라우트 이동은 막고, 투어 자신의 이동은 통과시킨다", () => {
  render(<TourNavigationGuard />);
  runner.active = true;
  expect(
    blocker.shouldBlock!({
      currentLocation: { pathname: "/" },
      nextLocation: { pathname: "/settings" },
    }),
  ).toBe(true);
  runner.navigating = true;
  expect(
    blocker.shouldBlock!({
      currentLocation: { pathname: "/" },
      nextLocation: { pathname: "/meetings/mtg_7" },
    }),
  ).toBe(false);
});

test("차단되면 모달이 뜨고, 계속하면 reset, 그만두면 stop + proceed", async () => {
  const user = userEvent.setup();
  blocker.state = "blocked";
  render(<TourNavigationGuard />);
  expect(
    screen.getByRole("dialog", { name: /그만둘까요/ }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "계속 둘러보기" }));
  expect(blocker.reset).toHaveBeenCalled();

  blocker.state = "blocked";
  cleanup();
  render(<TourNavigationGuard />);
  await user.click(screen.getByRole("button", { name: "그만두기" }));
  expect(runner.stop).toHaveBeenCalled();
  expect(blocker.proceed).toHaveBeenCalled();
});

test("차단되면 기본 포커스가 계속 둘러보기 버튼에 놓인다", async () => {
  blocker.state = "blocked";
  render(<TourNavigationGuard />);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "계속 둘러보기" }),
    ),
  );
});

test("ESC 등 종료 요청이 오면 모달이 뜨고, 그만두면 stop만 부른다", async () => {
  const user = userEvent.setup();
  render(<TourNavigationGuard />);
  expect(screen.queryByRole("dialog")).toBeNull();
  runner.emitExit();
  expect(
    await screen.findByRole("dialog", { name: /그만둘까요/ }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "그만두기" }));
  expect(runner.stop).toHaveBeenCalled();
  expect(blocker.proceed).not.toHaveBeenCalled();
});
