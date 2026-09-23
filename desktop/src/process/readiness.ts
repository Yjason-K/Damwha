export type ProbeResult = "ready" | "db-unreachable" | "no-response";

export type ReadyOutcome =
  | { kind: "ready" }
  | { kind: "db-unreachable" }
  | { kind: "child-exited" }
  | { kind: "timeout" };

/**
 * NestJS의 콜드 스타트는 이 기계에서 수 초다. 30초는 느린 첫 실행까지 덮는 값이고,
 * 250ms는 사람이 "멈췄다"고 느끼기 전에 상태가 바뀌게 하는 값이다. 실측치는 결과
 * 문서에 기록한다 (스펙 §12).
 */
export const READY_TIMEOUT_MS = 30_000;
export const READY_INTERVAL_MS = 250;
/**
 * 개별 probe의 상한. 소켓은 붙었는데 응답이 없는 API가 실제로 있으며, 그 경우
 * fetch는 스스로 끝나지 않는다. 이 상한이 없으면 READY_TIMEOUT_MS에 도달하지 못한다.
 */
export const PROBE_TIMEOUT_MS = 2_000;

export interface WaitOptions {
  probe: () => Promise<ProbeResult>;
  /** 자식이 아직 살아 있나. 죽었으면 폴링을 계속할 이유가 없다. */
  isAlive: () => boolean;
  timeoutMs: number;
  intervalMs: number;
  /** 개별 probe의 상한. 기본 PROBE_TIMEOUT_MS. */
  probeTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function waitForReady(options: WaitOptions): Promise<ReadyOutcome> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const deadline = now() + options.timeoutMs;
  const remaining = () => deadline - now();

  for (;;) {
    if (!options.isAlive()) return { kind: "child-exited" };
    if (remaining() <= 0) return { kind: "timeout" };
    // probe가 스스로 끝나지 않을 수 있으므로 상한과 경주시킨다. probe에 자체 상한이
    // 있어도 이중으로 막는다 — 루프가 멈추는 것이 probe 구현에 의존하면 안 된다.
    // 주입된 sleep을 쓰지 않는 이유: 테스트의 가짜 시계를 밀어 버린다.
    const result = await Promise.race([options.probe(), noResponseAfter(probeTimeoutMs)]);
    if (result === "ready") return { kind: "ready" };
    if (result === "db-unreachable") return { kind: "db-unreachable" };
    if (remaining() <= 0) return { kind: "timeout" };
    await sleep(options.intervalMs);
  }
}

function noResponseAfter(ms: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("no-response"), ms);
    // 매 회차마다 타이머가 쌓이지 않게 한다. probe가 먼저 끝나면 이 promise는 버려진다.
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  });
}

type FetchLike = (url: string, init?: { signal: AbortSignal }) => Promise<{ status: number }>;

/**
 * 200은 API와 DB 둘 다 살아 있음, 503은 API만 살아 있음(be/src/health/health.controller.ts).
 * 부팅 프로브가 fail-fast라 503은 부팅 뒤 DB가 끊긴 경우에만 나온다 (스펙 §6.5).
 */
export async function probeHealth(
  baseUrl: string,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  // 소켓은 붙었는데 응답이 없으면 fetch는 스스로 끝나지 않는다. abort로 실제 요청을
  // 끊고, race로 호출자에게는 시간 안에 돌려준다 — signal을 무시하는 구현도 막힌다.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    const status = await Promise.race([
      fetchImpl(`${baseUrl}/api/health`, { signal: controller.signal }).then((r) => r.status),
      expired,
    ]);
    if (status === 200) return "ready";
    if (status === 503) return "db-unreachable";
    return "no-response";
  } catch {
    return "no-response";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
