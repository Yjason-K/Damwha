import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";

import { Utterance } from "./utterance";

// vitest는 globals가 꺼져 있어 testing-library의 자동 cleanup이 걸리지 않는다.
afterEach(cleanup);

test("saved transcript utterance keeps only its marker visible until hover or selection", () => {
  const { container } = render(
    <Utterance time="01:13" speaker={1} name="민지" saved onJump={() => {}}>
      다음 주에 결정합니다.
    </Utterance>,
  );

  expect(screen.getByText("저장됨")).toBeVisible();
  expect(container.firstElementChild).toHaveAttribute("data-saved", "true");
  expect(
    screen.getByRole("button", { name: "저장 해제" }).parentElement,
  ).toHaveClass("opacity-0");
  expect(container.firstElementChild?.className).not.toContain(
    "bg-[var(--accent-1)]",
  );
});

test("to를 주면 발언 본문이 행 전체를 덮는 링크가 된다", () => {
  render(
    <MemoryRouter>
      <Utterance
        time="00:03"
        speaker={1}
        name="조승연"
        to="/meetings/mtg_2?u=utt_4"
        onJump={() => {}}
      >
        아기 아닙니까? 그죠
      </Utterance>
    </MemoryRouter>,
  );

  const link = screen.getByRole("link", { name: "아기 아닙니까? 그죠" });
  expect(link).toHaveAttribute("href", "/meetings/mtg_2?u=utt_4");
  // 행 전체를 덮는 오버레이 — 어디를 눌러도 원문으로 간다.
  expect(link.className).toContain("after:absolute");
});

test("to를 준 행에서는 원문 보기가 버튼이 아니라 힌트다", () => {
  render(
    <MemoryRouter>
      <Utterance
        time="00:03"
        speaker={1}
        name="조승연"
        to="/meetings/mtg_2?u=utt_4"
        onJump={() => {}}
        onSaveToggle={() => {}}
        saved
      >
        아기 아닙니까? 그죠
      </Utterance>
    </MemoryRouter>,
  );

  expect(
    screen.queryByRole("button", { name: "원문 보기" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "저장 해제" })).toBeInTheDocument();
});

test("savedBadge를 끄면 저장됨 배지 없이 저장 상태만 남는다", () => {
  render(
    <Utterance
      time="00:03"
      speaker={1}
      name="조승연"
      saved
      savedBadge={false}
      onSaveToggle={() => {}}
    >
      아기 아닙니까? 그죠
    </Utterance>,
  );

  expect(screen.queryByText("저장됨")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "저장 해제" })).toBeInTheDocument();
});
