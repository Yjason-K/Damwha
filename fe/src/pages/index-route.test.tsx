import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, test } from "vitest";

import { IndexRoute } from "@/pages/index-route";

afterEach(cleanup);

test("/는 전체 회의 목록으로 리다이렉트한다", async () => {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<IndexRoute />} />
        <Route path="/meetings" element={<div>전체 회의 목록</div>} />
      </Routes>
    </MemoryRouter>,
  );
  expect(await screen.findByText("전체 회의 목록")).toBeInTheDocument();
});
