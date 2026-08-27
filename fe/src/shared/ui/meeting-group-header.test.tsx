import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";

import { MeetingGroupHeader } from "./meeting-group-header";

afterEach(cleanup);

function renderHeader(
  props: Partial<React.ComponentProps<typeof MeetingGroupHeader>> = {},
) {
  return render(
    <MemoryRouter>
      <MeetingGroupHeader
        meetingId="mtg_2"
        title="강형욱에게 강아지와 아기 함께 키우기 난이도 물어봄"
        recordedAt="2026-08-21T01:00:00Z"
        {...props}
      />
    </MemoryRouter>,
  );
}

test("녹음 날짜를 점 표기로 보여준다", () => {
  renderHeader();
  expect(screen.getByText("2026.08.21")).toBeInTheDocument();
});

test("개수를 주면 날짜 옆에 함께 보여준다", () => {
  renderHeader({ count: 2 });
  expect(screen.getByText("2026.08.21 · 저장된 발언 2개")).toBeInTheDocument();
});

test("개수를 주지 않으면 날짜만 남는다", () => {
  renderHeader();
  expect(screen.queryByText(/저장된 발언/)).not.toBeInTheDocument();
});

test("녹음 날짜가 없고 개수만 있으면 개수만 보여준다", () => {
  renderHeader({ recordedAt: null, count: 1 });
  expect(screen.getByText("저장된 발언 1개")).toBeInTheDocument();
});

test("제목은 회의 상세로 가는 링크다", () => {
  renderHeader();
  expect(
    screen.getByRole("link", {
      name: "강형욱에게 강아지와 아기 함께 키우기 난이도 물어봄",
    }),
  ).toHaveAttribute("href", "/meetings/mtg_2");
});
