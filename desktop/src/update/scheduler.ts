/**
 * 자동 확인 타이머 (Phase 6b-1 스펙 §4.4).
 *
 * - packaged에서만, 담화 화면이 **처음** 붙을 때 한 번 무장한다 — 재시도·Dock 재활성화로 다시 붙어도
 *   두 번 무장하지 않는다.
 * - `run`은 기다리지 않는다(부르는 쪽이 `void flow.autoCheck().catch(…)`). 기동 경로가 알림을 기다리면
 *   안 된다.
 * - 개발용 env 주기는 유한 정수 60,000~86,400,000만 받는다. Node는 NaN·2³¹−1 초과를 1ms로 바꾼다.
 *   env가 유효하면 첫 확인도 한 주기 뒤다 — 보류 시나리오를 실측할 수 있게(스펙 §8.2-4).
 * - 해제는 main.ts의 beginQuit에서 한다. before-quit이 아니다(종료 확인에서 취소하면 앱이 산다).
 */
export const DEFAULT_INTERVAL_MS = 86_400_000;
export const MIN_INTERVAL_MS = 60_000;

export type IntervalOverride = { kind: "unset" } | { kind: "ok"; ms: number } | { kind: "invalid"; raw: string };

export function parseIntervalOverride(raw: string | undefined): IntervalOverride {
  if (raw === undefined || raw === "") return { kind: "unset" };
  if (!/^\d+$/.test(raw)) return { kind: "invalid", raw };
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms < MIN_INTERVAL_MS || ms > DEFAULT_INTERVAL_MS) return { kind: "invalid", raw };
  return { kind: "ok", ms };
}

export interface UpdateScheduler {
  onAttached(): void;
  dispose(): void;
}

export function createUpdateScheduler(opts: {
  packaged: boolean;
  override: string | undefined;
  run(): void;
  log(line: string): void;
}): UpdateScheduler {
  let armed = false;
  let disposed = false;
  let first: ReturnType<typeof setTimeout> | null = null;
  let every: ReturnType<typeof setInterval> | null = null;

  return {
    onAttached() {
      if (!opts.packaged || armed || disposed) return;
      armed = true;
      const parsed = parseIntervalOverride(opts.override);
      if (parsed.kind === "invalid") {
        opts.log(`DAMWHA_UPDATE_CHECK_INTERVAL_MS 값을 쓰지 않아요 (${JSON.stringify(parsed.raw)}) — 24시간으로 확인합니다.`);
      }
      const interval = parsed.kind === "ok" ? parsed.ms : DEFAULT_INTERVAL_MS;
      first = setTimeout(() => {
        first = null;
        opts.run();
        every = setInterval(() => opts.run(), interval);
      }, parsed.kind === "ok" ? interval : 0);
    },
    dispose() {
      disposed = true;
      if (first !== null) clearTimeout(first);
      if (every !== null) clearInterval(every);
      first = null;
      every = null;
    },
  };
}
