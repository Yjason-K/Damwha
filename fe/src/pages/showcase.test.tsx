import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";

import { ShowcasePage } from "./showcase";

afterEach(cleanup);

// 쇼케이스는 디자인 시스템 갤러리라 로직이 없지만, NoteEditor를 들여오면서
// features/ 쪽과 처음으로 엮였다. 이 스모크는 그 배선이 끊어지는 것만 잡는다.

test("NoteEditor 섹션이 샘플 메모를 렌더한다", () => {
  render(<ShowcasePage />);

  expect(
    screen.getByRole("heading", { name: "NoteEditor (마크다운 메모)" }),
  ).toBeInTheDocument();
  // 샘플 본문이 마크다운으로 렌더된다 — 원문 "## 결정사항"이 아니라 제목으로.
  expect(
    screen.getByRole("heading", { name: "결정사항", level: 2 }),
  ).toBeInTheDocument();
});

test("빈 상태 칸에서 편집을 열면 본문을 칠 수 있다", async () => {
  const user = userEvent.setup();
  render(<ShowcasePage />);

  await user.click(screen.getByRole("button", { name: "메모 쓰기" }));
  const box = screen.getByRole("textbox", { name: "메모 본문" });
  await user.type(box, "로컬 상태로 동작");

  expect(box).toHaveValue("로컬 상태로 동작");
});

test("불러오기 실패 칸은 편집 진입로를 주지 않는다", () => {
  render(<ShowcasePage />);

  // 실패 화면은 "다시 시도"만 준다. 여기서 편집이 열리면 진짜 메모를 덮어쓰는
  // 경로가 되므로, 쇼케이스에서도 그 불변식이 보여야 한다.
  expect(screen.getByText("메모를 불러오지 못했어요.")).toBeInTheDocument();
  // 편집 버튼은 읽기 칸 것 하나뿐 — 실패 칸이 하나 더 만들지 않는다.
  expect(screen.getAllByRole("button", { name: "편집" })).toHaveLength(1);
});
