import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { useSamplePlayer } from "./use-sample-player";

afterEach(cleanup);

function Host() {
  return useSamplePlayer().element;
}

test("미리듣기 <audio>도 CORS 모드다 (spec 2026-10-08 §3.7)", () => {
  const { container } = render(<Host />);
  expect(container.querySelector("audio")!.getAttribute("crossorigin")).toBe(
    "anonymous",
  );
});
