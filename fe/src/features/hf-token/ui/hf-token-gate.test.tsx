import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  HfTokenGateProvider,
  useDiarizationGate,
  useHfTokenDialog,
} from "./hf-token-gate";
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

function ReplaceProbe() {
  const dialog = useHfTokenDialog();
  return (
    <button type="button" onClick={dialog.open}>
      토큰 교체
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

test("the dialog does not pop back up on its own once the token is cleared again", () => {
  const onOpen = vi.fn();
  const send = vi.fn();
  const { rerender } = render(
    <HfTokenGateProvider view={{ kind: "ready", state: base }} send={send}>
      <Probe onOpen={onOpen} />
    </HfTokenGateProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "새 회의" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();

  const presentState = {
    ...base,
    status: "present" as const,
    masked: "hf_****…****4567",
  };
  rerender(
    <HfTokenGateProvider
      view={{ kind: "ready", state: presentState }}
      send={send}
    >
      <Probe onOpen={onOpen} />
    </HfTokenGateProvider>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();

  // 토큰이 다시 지워져도(예: 만료·삭제) 다이얼로그가 클릭 없이 저절로 뜨면 안 된다.
  rerender(
    <HfTokenGateProvider view={{ kind: "ready", state: base }} send={send}>
      <Probe onOpen={onOpen} />
    </HfTokenGateProvider>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("useHfTokenDialog().open() shows the dialog even while a token is present, to replace a revoked one", () => {
  const send = vi.fn();
  const presentState = {
    ...base,
    status: "present" as const,
    masked: "hf_****…****4567",
  };
  const { rerender } = render(
    <HfTokenGateProvider
      view={{ kind: "ready", state: presentState }}
      send={send}
    >
      <ReplaceProbe />
    </HfTokenGateProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "토큰 교체" }));
  expect(
    screen.getByRole("dialog", { name: "허깅페이스 토큰이 필요해요" }),
  ).toBeInTheDocument();

  // 같은 present 상태로 다시 그려도(예: 다른 필드 갱신) 열어 둔 다이얼로그가 닫히면 안 된다.
  rerender(
    <HfTokenGateProvider
      view={{ kind: "ready", state: presentState }}
      send={send}
    >
      <ReplaceProbe />
    </HfTokenGateProvider>,
  );
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

test("Finding 4: closes when replacing a present token succeeds while open (masked changes to a new value)", () => {
  const send = vi.fn();
  const presentState1 = {
    ...base,
    status: "present" as const,
    masked: "hf_****…****0000",
  };
  const { rerender } = render(
    <HfTokenGateProvider view={{ kind: "ready", state: presentState1 }} send={send}>
      <ReplaceProbe />
    </HfTokenGateProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "토큰 교체" }));
  expect(
    screen.getByRole("dialog", { name: "허깅페이스 토큰이 필요해요" }),
  ).toBeInTheDocument();

  const presentState2 = {
    ...base,
    status: "present" as const,
    masked: "hf_****…****4567",
  };
  rerender(
    <HfTokenGateProvider view={{ kind: "ready", state: presentState2 }} send={send}>
      <ReplaceProbe />
    </HfTokenGateProvider>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("outside the provider the gate passes (unit tests render nav pieces alone)", () => {
  const onOpen = vi.fn();
  render(<Probe onOpen={onOpen} />);
  fireEvent.click(screen.getByRole("button", { name: "새 회의" }));
  expect(onOpen).toHaveBeenCalledOnce();
});
