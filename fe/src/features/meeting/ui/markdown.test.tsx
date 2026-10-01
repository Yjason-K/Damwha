import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { Markdown } from "./markdown";

afterEach(cleanup);

test("단일 줄바꿈을 공백으로 접지 않고 <br>로 살린다", () => {
  const { container } = render(<Markdown body={"첫 줄\n둘째 줄\n셋째 줄"} />);
  const p = container.querySelector("p");
  expect(p?.querySelectorAll("br")).toHaveLength(2);
});
