import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HfTokenSettingsSection } from "./hf-token-settings-section";
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

test("hidden on the web", () => {
  const { container } = render(
    <HfTokenSettingsSection view={{ kind: "web" }} send={vi.fn()} />,
  );
  expect(container).toBeEmptyDOMElement();
});

test("present: masked value, account, and delete only after confirmation", () => {
  const send = vi.fn();
  render(
    <HfTokenSettingsSection
      view={ready({
        ...base,
        status: "present",
        masked: "hf_****…****4567",
        account: "jason",
      })}
      send={send}
    />,
  );
  expect(screen.getByText("hf_****…****4567")).toBeInTheDocument();
  expect(screen.getByText(/jason/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "토큰 지우기" }));
  expect(send).not.toHaveBeenCalledWith({ kind: "clear" });
  fireEvent.click(screen.getByRole("button", { name: "지우기" }));
  expect(send).toHaveBeenCalledWith({ kind: "clear" });
});

test("absent and unreadable show the input; unavailable shows the keychain guidance", () => {
  const { unmount } = render(
    <HfTokenSettingsSection view={ready(base)} send={vi.fn()} />,
  );
  expect(screen.getByLabelText("허깅페이스 토큰")).toBeInTheDocument();
  unmount();
  const u = render(
    <HfTokenSettingsSection
      view={ready({ ...base, status: "unreadable" })}
      send={vi.fn()}
    />,
  );
  expect(screen.getByText(/토큰을 읽을 수 없어요/)).toBeInTheDocument();
  u.unmount();
  render(
    <HfTokenSettingsSection
      view={ready({ ...base, status: "unavailable" })}
      send={vi.fn()}
    />,
  );
  expect(screen.queryByLabelText("허깅페이스 토큰")).toBeNull();
  expect(screen.getByText(/키체인/)).toBeInTheDocument();
});
