import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HfTokenGateProvider, useDiarizationGate } from "./hf-token-gate";
import type { HfTokenState, HfTokenView } from "../model/types";

afterEach(cleanup);

const base: HfTokenState = {
  status: "absent",
  masked: null,
  account: null,
  onboardingDismissed: false,
  busy: false,
  message: null,
};

function Probe({ onOpen }: { onOpen: () => void }) {
  const gate = useDiarizationGate();
  return (
    <button
      type="button"
      disabled={gate.locked}
      onClick={() => gate.run(onOpen)}
    >
      새 회의
    </button>
  );
}

function renderGate(view: HfTokenView, onOpen = vi.fn()) {
  const send = vi.fn();
  const utils = render(
    <HfTokenGateProvider view={view} send={send}>
      <Probe onOpen={onOpen} />
    </HfTokenGateProvider>,
  );
  return { ...utils, send, onOpen };
}

test("web: passes straight through", () => {
  const { onOpen } = renderGate({ kind: "web" });
  fireEvent.click(screen.getByRole("button", { name: "새 회의" }));
  expect(onOpen).toHaveBeenCalledOnce();
});

test("present: passes straight through", () => {
  const { onOpen } = renderGate({
    kind: "ready",
    state: { ...base, status: "present", masked: "hf_****…****4567" },
  });
  fireEvent.click(screen.getByRole("button", { name: "새 회의" }));
  expect(onOpen).toHaveBeenCalledOnce();
});

test("absent: opens the token dialog instead of the action", () => {
  const { onOpen } = renderGate({ kind: "ready", state: base });
  fireEvent.click(screen.getByRole("button", { name: "새 회의" }));
  expect(onOpen).not.toHaveBeenCalled();
  expect(
    screen.getByRole("dialog", { name: "허깅페이스 토큰이 필요해요" }),
  ).toBeInTheDocument();
});

test("pending: locked and does nothing", () => {
  const { onOpen } = renderGate({ kind: "pending" });
  expect(screen.getByRole("button", { name: "새 회의" })).toBeDisabled();
  expect(onOpen).not.toHaveBeenCalled();
});

test("the dialog closes by itself once the token is saved — the person clicks the action again", () => {
  const onOpen = vi.fn();
  const send = vi.fn();
  const { rerender } = render(
    <HfTokenGateProvider view={{ kind: "ready", state: base }} send={send}>
      <Probe onOpen={onOpen} />
    </HfTokenGateProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "새 회의" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  rerender(
    <HfTokenGateProvider
      view={{
        kind: "ready",
        state: { ...base, status: "present", masked: "hf_****…****4567" },
      }}
      send={send}
    >
      <Probe onOpen={onOpen} />
    </HfTokenGateProvider>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onOpen).not.toHaveBeenCalled();
});

test("outside the provider the gate passes (unit tests render nav pieces alone)", () => {
  const onOpen = vi.fn();
  render(<Probe onOpen={onOpen} />);
  fireEvent.click(screen.getByRole("button", { name: "새 회의" }));
  expect(onOpen).toHaveBeenCalledOnce();
});
