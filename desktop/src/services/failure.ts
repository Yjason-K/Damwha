import type { Recovery } from "./types";

/**
 * 복구 부류를 싣는 실패. 문구로 부류를 가르지 않는 이유(Phase 3 스펙 §6.7, 외부 리뷰 #2): 카탈로그의 정규식은 원인을
 * 알아볼 때만 맞고, 알아보지 못한 원문은 부류를 잃는다. 새 코드가 던지는 예상 밖의 오류가 그렇게 자동 재시도로 샌다.
 */
export class ServiceFailure extends Error {
  readonly recovery: Recovery;

  constructor(message: string, recovery: Recovery) {
    super(message);
    this.name = "ServiceFailure";
    this.recovery = recovery;
  }
}

export function recoveryOf(e: unknown): Recovery | undefined {
  return e instanceof ServiceFailure ? e.recovery : undefined;
}

/**
 * 본문 전체를 감싸, 명시적으로 부류를 붙이지 않은 실패를 manual로 만든다. postgres 어댑터와 마이그레이션 게이트가
 * 이것으로 launch()를 감싼다 — "명시적으로 auto라고 적은 경로가 아니면 manual"이 스펙의 규칙이다.
 */
export async function manualUnlessTagged<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (e) {
    if (e instanceof ServiceFailure) throw e;
    throw new ServiceFailure(e instanceof Error ? e.message : String(e), "manual");
  }
}
