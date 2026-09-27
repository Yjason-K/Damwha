import { expect, test, vi } from "vitest";
import {
  createLanguageStore,
  resolveInitialLanguage,
  type LanguageEnv,
} from "./language-store";

function fakeEnv(over: Partial<LanguageEnv> & { stored?: string | null } = {}) {
  let stored = over.stored ?? null;
  const env: LanguageEnv & { writes: string[]; applied: string[] } = {
    writes: [],
    applied: [],
    search: () => "",
    readStored: () => stored,
    writeStored(v) {
      stored = v;
      env.writes.push(v);
    },
    systemLanguages: () => ["ko-KR"],
    apply(lang) {
      env.applied.push(lang);
    },
    ...over,
  };
  return env;
}

test("초기 언어: ?lang → 저장값 → 기기 언어", () => {
  expect(resolveInitialLanguage(fakeEnv({ search: () => "?lang=en", stored: "ko" }))).toBe("en");
  expect(resolveInitialLanguage(fakeEnv({ search: () => "?lang=fr", stored: "en" }))).toBe("en");
  expect(resolveInitialLanguage(fakeEnv({ stored: "en" }))).toBe("en");
  expect(resolveInitialLanguage(fakeEnv({ stored: "xx" }))).toBe("ko");
  expect(resolveInitialLanguage(fakeEnv({ systemLanguages: () => ["ja-JP"] }))).toBe("en");
});

test("저장소 읽기가 던져도 기기 언어로 뜬다", () => {
  const env = fakeEnv({
    readStored: () => {
      throw new Error("blocked");
    },
  });
  expect(resolveInitialLanguage(env)).toBe("ko");
});

test("기기 언어로 떴을 때는 아무것도 저장하지 않는다 — 고르기 전까지 기기를 따른다", () => {
  const env = fakeEnv();
  const s = createLanguageStore(env);
  s.start();
  expect(s.getSnapshot()).toBe("ko");
  expect(env.writes).toEqual([]);
  expect(env.applied).toEqual(["ko"]);
});

test("choose: 저장하고, 적용하고, 구독자에게 알리고, main이 물으면 그 값을 준다", async () => {
  const env = fakeEnv();
  const s = createLanguageStore(env);
  const listener = vi.fn();
  s.subscribe(listener);
  const asked = s.bridge.next();
  s.choose("en");
  expect(s.getSnapshot()).toBe("en");
  expect(env.writes).toEqual(["en"]);
  expect(env.applied).toEqual(["en"]);
  expect(listener).toHaveBeenCalledTimes(1);
  await expect(asked).resolves.toBe("en");
});

test("main이 묻기 전에 여러 번 고르면 대기열에는 마지막 값 하나만 남는다", async () => {
  const s = createLanguageStore(fakeEnv());
  s.choose("en");
  s.choose("ko");
  s.choose("en");
  await expect(s.bridge.next()).resolves.toBe("en");
  let second: string | null = null;
  void s.bridge.next().then((v) => (second = v));
  await Promise.resolve();
  expect(second).toBeNull(); // 더 쌓인 것이 없다
});

test("show(main이 확정한 값): 적용하고 캐시로 저장하지만 main에게 되돌려 보내지 않는다", async () => {
  const env = fakeEnv();
  const s = createLanguageStore(env);
  s.bridge.show("en");
  expect(s.getSnapshot()).toBe("en");
  expect(env.writes).toEqual(["en"]); // ⌘R로 ?lang 없이 다시 떠도 이 값으로 뜬다
  let got: string | null = null;
  void s.bridge.next().then((v) => (got = v));
  await Promise.resolve();
  expect(got).toBeNull();
});

test("show는 모르는 값을 무시한다 — 렌더러 밖에서 온 데이터다", () => {
  const s = createLanguageStore(fakeEnv());
  s.bridge.show("fr");
  s.bridge.show(null);
  expect(s.getSnapshot()).toBe("ko");
});

test("저장 실패해도 이번 세션에는 고른 언어가 적용된다", () => {
  const env = fakeEnv({
    writeStored: () => {
      throw new Error("quota");
    },
  });
  const s = createLanguageStore(env);
  s.choose("en");
  expect(s.getSnapshot()).toBe("en");
});

test("같은 값이면 다시 적용하지 않는다", () => {
  const env = fakeEnv();
  const s = createLanguageStore(env);
  const listener = vi.fn();
  s.subscribe(listener);
  s.bridge.show("ko");
  expect(listener).not.toHaveBeenCalled();
  expect(env.applied).toEqual([]);
});
