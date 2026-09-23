import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUpdateScheduler, DEFAULT_INTERVAL_MS, parseIntervalOverride } from "../../src/update/scheduler";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("parseIntervalOverride", () => {
  it("범위 안의 정수만 받는다", () => {
    expect(parseIntervalOverride(undefined)).toEqual({ kind: "unset" });
    expect(parseIntervalOverride("")).toEqual({ kind: "unset" });
    expect(parseIntervalOverride("60000")).toEqual({ kind: "ok", ms: 60_000 });
    expect(parseIntervalOverride("86400000")).toEqual({ kind: "ok", ms: 86_400_000 });
    for (const raw of ["59999", "86400001", "NaN", "-1", "1e5", "60000.5", "abc", "9999999999999"]) {
      expect(parseIntervalOverride(raw)).toEqual({ kind: "invalid", raw });
    }
  });
});

function make(packaged: boolean, override?: string) {
  const run = vi.fn();
  const log = vi.fn();
  return { run, log, s: createUpdateScheduler({ packaged, override, run, log }) };
}

describe("createUpdateScheduler", () => {
  it("dev에서는 무장하지 않는다", () => {
    const { run, s } = make(false);
    s.onAttached();
    vi.advanceTimersByTime(2 * DEFAULT_INTERVAL_MS);
    expect(run).not.toHaveBeenCalled();
  });

  it("packaged는 붙자마자 한 번, 그 뒤 24시간마다", () => {
    const { run, s } = make(true);
    s.onAttached();
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DEFAULT_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("여러 번 붙어도 한 번만 무장한다", () => {
    const { run, s } = make(true);
    s.onAttached();
    s.onAttached();
    s.onAttached();
    vi.advanceTimersByTime(DEFAULT_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("env 주기가 유효하면 첫 확인도 한 주기 뒤다", () => {
    const { run, s } = make(true, "60000");
    s.onAttached();
    vi.advanceTimersByTime(59_999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("env 주기가 잘못되면 로그를 남기고 기본값", () => {
    const { run, log, s } = make(true, "NaN");
    s.onAttached();
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("DAMWHA_UPDATE_CHECK_INTERVAL_MS"));
  });

  it("해제 뒤에는 발화하지 않고 다시 무장하지도 않는다", () => {
    const { run, s } = make(true);
    s.onAttached();
    s.dispose();
    s.onAttached();
    vi.advanceTimersByTime(2 * DEFAULT_INTERVAL_MS);
    expect(run).not.toHaveBeenCalled();
  });
});
