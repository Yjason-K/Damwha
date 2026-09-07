import axios from "axios";
import { afterEach, expect, test, vi } from "vitest";

import { ApiError } from "@/shared/api/client";
import {
  DEMO_READ_ONLY_CODE,
  installDemoReadOnly,
  isDemoBlocked,
} from "@/shared/api/demo-read-only";

function clientWithSpyAdapter() {
  const adapter = vi.fn(async (config) => ({
    data: { ok: true },
    status: 200,
    statusText: "OK",
    headers: {},
    config,
  }));
  const client = axios.create({ baseURL: "http://api.test/api", adapter });
  return { client, adapter };
}

afterEach(() => vi.clearAllMocks());

test("GET 요청은 서버로 그대로 나간다", async () => {
  const { client, adapter } = clientWithSpyAdapter();
  const notify = vi.fn();
  installDemoReadOnly(client, notify);
  await client.get("/meetings");
  expect(adapter).toHaveBeenCalledTimes(1);
  expect(notify).not.toHaveBeenCalled();
});

test("POST /search는 읽기라 통과한다", async () => {
  const { client, adapter } = clientWithSpyAdapter();
  installDemoReadOnly(client, vi.fn());
  await client.post("/search", { q: "출시" });
  expect(adapter).toHaveBeenCalledTimes(1);
});

test.each(["post", "put", "patch", "delete"] as const)(
  "%s 요청은 서버에 닿기 전에 DEMO_READ_ONLY ApiError로 거절되고 토스트 한 번",
  async (method) => {
    const { client, adapter } = clientWithSpyAdapter();
    const notify = vi.fn();
    installDemoReadOnly(client, notify);
    const promise = client.request({ method, url: "/meetings/mtg_1/favorite" });
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await promise.catch((e: ApiError) => {
      expect(e.statusCode).toBe(403);
      expect(e.code).toBe(DEMO_READ_ONLY_CODE);
      expect(isDemoBlocked(e)).toBe(true);
    });
    expect(adapter).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  },
);

test("isDemoBlocked는 다른 ApiError와 일반 에러에 false", () => {
  expect(isDemoBlocked(new ApiError(500, "boom"))).toBe(false);
  expect(isDemoBlocked(new Error("x"))).toBe(false);
});

test("연속 거절은 토스트를 스로틀한다 — 메모 자동저장(800ms)이 토스트를 연발하지 않게", async () => {
  vi.useFakeTimers();
  try {
    const { client } = clientWithSpyAdapter();
    const notify = vi.fn();
    installDemoReadOnly(client, notify);
    const put = () => client.put("/meetings/mtg_1/note", { body_md: "x" }).catch(() => undefined);
    await put();
    await put();
    await put();
    expect(notify).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    await put();
    expect(notify).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
