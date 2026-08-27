import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";

import type { LensListPage, LensWireItem } from "../model/types";
import { LensList } from "./lens-list";

afterEach(cleanup);

function item(
  id: string,
  meeting: { id: string; title: string | null; recorded_at: string | null },
  text = "본문",
): LensWireItem {
  return {
    id,
    kind: "action",
    text,
    source: "user",
    user_modified: false,
    completion_status: "open",
    lifecycle_status: "active",
    meeting_id: meeting.id,
    assignee_speaker_id: null,
    due_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    meeting,
    evidence: [],
  };
}

function renderList(pages: LensListPage[]) {
  return render(
    <MemoryRouter>
      <LensList
        pages={pages}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={() => {}}
        onToggle={() => {}}
        onJumpEvidence={() => {}}
        speakerName={() => null}
        speakerTint={() => undefined}
      />
    </MemoryRouter>,
  );
}

const 기획 = {
  id: "mtg_2",
  title: "기획 회의",
  recorded_at: "2026-08-20T01:00:00Z",
};
const 리뷰 = {
  id: "mtg_1",
  title: "스프린트 리뷰",
  recorded_at: "2026-08-18T01:00:00Z",
};

test("회의가 바뀔 때마다 헤더를 한 번씩만 세운다", () => {
  renderList([
    {
      items: [
        item("lens_4", 기획, "항목 A"),
        item("lens_3", 기획, "항목 B"),
        item("lens_2", 리뷰, "항목 C"),
      ],
      next_cursor: null,
    },
  ]);

  expect(screen.getAllByRole("link", { name: /기획 회의/ })).toHaveLength(1);
  expect(screen.getAllByRole("link", { name: /스프린트 리뷰/ })).toHaveLength(
    1,
  );
});

test("회의 헤더는 회의 상세로 가는 링크다", () => {
  renderList([{ items: [item("lens_1", 기획)], next_cursor: null }]);

  expect(screen.getByRole("link", { name: /기획 회의/ })).toHaveAttribute(
    "href",
    "/meetings/mtg_2",
  );
});

test("한 회의가 페이지 경계에 걸려도 헤더가 두 번 나오지 않는다", () => {
  renderList([
    {
      items: [item("lens_4", 기획, "항목 A"), item("lens_3", 기획, "항목 B")],
      next_cursor: "c",
    },
    {
      items: [item("lens_2", 기획, "항목 C"), item("lens_1", 리뷰, "항목 D")],
      next_cursor: null,
    },
  ]);

  expect(screen.getAllByRole("link", { name: /기획 회의/ })).toHaveLength(1);
  expect(screen.getByText("항목 C")).toBeInTheDocument();
});

test("제목 없는 회의도 헤더를 세운다", () => {
  renderList([
    {
      items: [item("lens_1", { id: "mtg_9", title: null, recorded_at: null })],
      next_cursor: null,
    },
  ]);

  expect(
    screen.getByRole("link", { name: /제목 없는 회의/ }),
  ).toBeInTheDocument();
});
