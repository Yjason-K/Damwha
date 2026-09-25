import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HfTokenOnboarding } from "./hf-token-onboarding";
import type { HfTokenState } from "../model/types";

afterEach(cleanup);

const base: HfTokenState = {
  status: "absent",
  masked: null,
  account: null,
  onboardingDismissed: false,
  busy: false,
  message: null,
};
const ready = (state: HfTokenState) => ({ kind: "ready" as const, state });

test("shows on a first run without a token", () => {
  render(<HfTokenOnboarding view={ready(base)} send={vi.fn()} />);
  expect(
    screen.getByRole("dialog", { name: "화자 분리를 쓰려면 토큰이 필요해요" }),
  ).toBeInTheDocument();
});

test("shows for an unreadable token with its own wording", () => {
  render(
    <HfTokenOnboarding
      view={ready({ ...base, status: "unreadable" })}
      send={vi.fn()}
    />,
  );
  expect(screen.getByText(/토큰을 읽을 수 없어요/)).toBeInTheDocument();
});

test("does not show for present, unavailable, web or pending (Review Focus 4)", () => {
  for (const view of [
    ready({ ...base, status: "present", masked: "hf_****…****4567" }),
    ready({ ...base, status: "unavailable" }),
    { kind: "web" as const },
    { kind: "pending" as const },
  ]) {
    const { unmount } = render(
      <HfTokenOnboarding view={view} send={vi.fn()} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();
  }
});

test("'나중에 하기' tells main and hides at once", () => {
  const send = vi.fn();
  render(<HfTokenOnboarding view={ready(base)} send={send} />);
  fireEvent.click(screen.getByRole("button", { name: "나중에 하기" }));
  expect(send).toHaveBeenCalledWith({ kind: "dismissOnboarding" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a new run (onboardingDismissed false again) shows it again", () => {
  const { unmount } = render(
    <HfTokenOnboarding
      view={ready({ ...base, onboardingDismissed: true })}
      send={vi.fn()}
    />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  unmount();
  render(<HfTokenOnboarding view={ready(base)} send={vi.fn()} />);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});
