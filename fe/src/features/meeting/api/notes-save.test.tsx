import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { noteQueryKey, useSaveMeetingNote } from "./notes";

afterEach(() => vi.restoreAllMocks());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient();
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test.each([false, true])(
  "#75 이전 저장의 지연/실패(%s) 뒤에도 최신 메모가 서버와 캐시에 남는다",
  async (failOlder) => {
    const qc = new QueryClient();
    const key = noteQueryKey("mtg_1");
    qc.setQueryData(key, {
      body_md: "원본",
      updated_at: "2026-11-04T00:00:00.000Z",
    });
    function localWrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    }
    const olderStarted = deferred();
    const releaseOlder = deferred();
    let stored = "원본";
    vi.spyOn(apiClient, "put").mockImplementation(async (_url, body) => {
      const text: unknown =
        typeof body === "object" && body !== null && "body_md" in body
          ? body.body_md
          : undefined;
      if (typeof text !== "string") throw new Error("invalid note body");
      if (text === "이전 초안") {
        olderStarted.resolve();
        await releaseOlder.promise;
        if (failOlder) throw new Error("older save failed");
      }
      stored = text;
      return {
        data: {
          note: { body_md: text, updated_at: "2026-11-04T00:00:01.000Z" },
        },
      };
    });
    const first = renderHook(() => useSaveMeetingNote(), {
      wrapper: localWrapper,
    });
    let older = Promise.resolve<unknown>(null);
    await act(async () => {
      older = first.result.current
        .mutateAsync({ meetingId: "mtg_1", bodyMd: "이전 초안" })
        .catch((error: unknown) => error);
      await olderStarted.promise;
    });
    // 화면 재진입도 같은 회의의 진행 중 저장을 추월하지 않아야 한다.
    first.unmount();
    const second = renderHook(() => useSaveMeetingNote(), {
      wrapper: localWrapper,
    });
    let newer = Promise.resolve<unknown>(null);
    await act(async () => {
      newer = second.result.current.mutateAsync({
        meetingId: "mtg_1",
        bodyMd: "최신 초안",
      });
    });
    await act(async () => {
      releaseOlder.resolve();
      await Promise.all([older, newer]);
    });

    expect(stored).toBe("최신 초안");
    expect(qc.getQueryData(key)).toMatchObject({ body_md: "최신 초안" });
    qc.clear();
  },
);

test("#75 겹친 저장이 모두 실패하면 마지막 서버 확인값으로 되돌린다", async () => {
  const qc = new QueryClient();
  const key = noteQueryKey("mtg_1");
  const original = {
    body_md: "서버 원본",
    updated_at: "2026-11-04T00:00:00.000Z",
  };
  qc.setQueryData(key, original);
  function localWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  const started = deferred();
  const release = deferred();
  vi.spyOn(apiClient, "put").mockImplementation(async () => {
    started.resolve();
    await release.promise;
    throw new Error("save failed");
  });
  const { result } = renderHook(() => useSaveMeetingNote(), {
    wrapper: localWrapper,
  });
  let older = Promise.resolve<unknown>(null);
  let newer = Promise.resolve<unknown>(null);
  await act(async () => {
    older = result.current
      .mutateAsync({ meetingId: "mtg_1", bodyMd: "이전 초안" })
      .catch((error: unknown) => error);
    await started.promise;
  });
  await act(async () => {
    newer = result.current
      .mutateAsync({ meetingId: "mtg_1", bodyMd: "최신 초안" })
      .catch((error: unknown) => error);
  });
  await act(async () => {
    release.resolve();
    await Promise.all([older, newer]);
  });

  expect(qc.getQueryData(key)).toEqual(original);
  qc.clear();
});

test("#75 한 회의의 느린 저장은 다른 회의의 저장을 막지 않는다", async () => {
  const release = deferred();
  const started = deferred();
  const stored = new Map<string, string>();
  vi.spyOn(apiClient, "put").mockImplementation(async (url, body) => {
    const text: unknown =
      typeof body === "object" && body !== null && "body_md" in body
        ? body.body_md
        : undefined;
    if (typeof text !== "string") throw new Error("invalid note body");
    if (url === "/meetings/mtg_1/note") {
      started.resolve();
      await release.promise;
    }
    stored.set(url, text);
    return {
      data: {
        note: { body_md: text, updated_at: "2026-11-04T00:00:00.000Z" },
      },
    };
  });
  const { result } = renderHook(() => useSaveMeetingNote(), { wrapper });
  let slow = Promise.resolve<unknown>(null);
  await act(async () => {
    slow = result.current.mutateAsync({
      meetingId: "mtg_1",
      bodyMd: "첫 회의",
    });
    await started.promise;
  });
  try {
    await act(async () => {
      await result.current.mutateAsync({
        meetingId: "mtg_2",
        bodyMd: "둘째 회의",
      });
    });
    expect(stored.get("/meetings/mtg_2/note")).toBe("둘째 회의");
    expect(stored.has("/meetings/mtg_1/note")).toBe(false);
  } finally {
    await act(async () => {
      release.resolve();
      await slow;
    });
  }
});
