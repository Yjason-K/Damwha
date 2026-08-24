import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { Utterance } from "./utterance";

test("saved transcript utterance keeps only its marker visible until hover or selection", () => {
  const { container } = render(
    <Utterance time="01:13" speaker={1} name="민지" saved onJump={() => {}}>
      다음 주에 결정합니다.
    </Utterance>,
  );

  expect(screen.getByText("저장됨")).toBeVisible();
  expect(container.firstElementChild).toHaveAttribute("data-saved", "true");
  expect(screen.getByRole("button", { name: "저장 해제" }).parentElement).toHaveClass(
    "opacity-0",
  );
  expect(container.firstElementChild?.className).not.toContain(
    "bg-[var(--accent-1)]",
  );
});
