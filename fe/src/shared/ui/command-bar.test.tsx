import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { CommandBar } from "./command-bar";

afterEach(cleanup);

/**
 * 검색 팔레트의 안내 줄 — "지금 왜 이런가"를 말하는 자리 (Phase 4 스펙 §6.9).
 * 임베딩 모델을 받는 동안 검색이 키워드로만 돈다는 사실이 여기에 실린다.
 */
test("안내를 주면 결과 위에 보여준다", () => {
  render(
    <CommandBar
      open
      onOpenChange={() => {}}
      notice="검색 임베딩 모델을 아직 받는 중이에요"
      groups={[]}
    />,
  );
  expect(
    screen.getByText("검색 임베딩 모델을 아직 받는 중이에요"),
  ).toBeInTheDocument();
});

test("안내가 없으면 아무 줄도 만들지 않는다 — 평소에는 조용하다", () => {
  render(<CommandBar open onOpenChange={() => {}} groups={[]} />);
  expect(screen.queryByText(/받는 중/)).not.toBeInTheDocument();
  // 결과가 없다는 기존 안내는 그대로다.
  expect(screen.getByText(/결과가 없어요/)).toBeInTheDocument();
});
