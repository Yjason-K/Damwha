import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@/features/lens/ui/lens-dashboard", () => ({
  LensDashboard: ({
    lens,
    onLens,
    onJumpEvidence,
  }: {
    lens: string;
    onLens: (k: string) => void;
    onJumpEvidence: (m: string, u: string) => void;
  }) => (
    <div>
      <span>렌즈: {lens}</span>
      <button type="button" onClick={() => onLens("decision")}>
        결정으로
      </button>
      <button type="button" onClick={() => onJumpEvidence("m2", "v3")}>
        근거로
      </button>
    </div>
  ),
}));

const { LensView } = await import("@/pages/lens");

afterEach(cleanup);

function Probe() {
  const loc = useLocation();
  return <span>경로: {loc.pathname + loc.search}</span>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Probe />
      <Routes>
        <Route path="/lenses/:kind" element={<LensView />} />
        <Route path="/meetings/:meetingId" element={<div>회의 상세</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

test("유효한 kind는 그대로 대시보드에 전달된다", () => {
  renderAt("/lenses/promise");
  expect(screen.getByText("렌즈: promise")).toBeInTheDocument();
});

test("알 수 없는 kind는 action으로 정규화된다", () => {
  renderAt("/lenses/nope");
  expect(screen.getByText("렌즈: action")).toBeInTheDocument();
  expect(screen.getByText("경로: /lenses/action")).toBeInTheDocument();
});

test("렌즈 전환은 경로 이동이다", () => {
  renderAt("/lenses/action");
  fireEvent.click(screen.getByRole("button", { name: "결정으로" }));
  expect(screen.getByText("경로: /lenses/decision")).toBeInTheDocument();
});

test("근거 점프는 회의 경로에 u 쿼리를 붙여 이동한다", () => {
  renderAt("/lenses/action");
  fireEvent.click(screen.getByRole("button", { name: "근거로" }));
  expect(screen.getByText("경로: /meetings/m2?u=v3")).toBeInTheDocument();
});
