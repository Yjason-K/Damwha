import type { DamwhaClient } from './client';
import type { MeetingStatus, StageState } from './api-types';

type Stages = MeetingStatus['stages'];

export interface WaitResult {
  ok: boolean;
  stages: Stages;
  failed: (keyof Stages)[];
}

export interface WaitOptions {
  intervalMs: number;
  onProgress(stages: Stages): void;
  signal: AbortSignal;
}

/** Ctrl-C로 기다리기만 멈췄다. 서버 처리는 계속된다. */
export class WaitAbortedError extends Error {
  constructor() {
    super('wait aborted');
    this.name = 'WaitAbortedError';
  }
}

// skipped도 끝난 상태다: 끈 단계와, 처리 실패로 못 돌게 된 후속 단계를 be가 skipped로 돌려준다.
const TERMINAL: readonly StageState[] = ['done', 'failed', 'skipped'];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new WaitAbortedError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new WaitAbortedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 모든 단계가 끝날 때까지 status를 폴링한다. 긴 회의·큰 모델을 위해 시간 제한은 없다 (spec §2.4). */
export async function waitForMeeting(
  client: Pick<DamwhaClient, 'getStatus'>,
  id: string,
  opts: WaitOptions,
): Promise<WaitResult> {
  for (;;) {
    if (opts.signal.aborted) throw new WaitAbortedError();
    const { stages } = await client.getStatus(id);
    opts.onProgress(stages);
    const keys = Object.keys(stages) as (keyof Stages)[];
    if (keys.every((k) => TERMINAL.includes(stages[k]))) {
      const failed = keys.filter((k) => stages[k] === 'failed');
      return { ok: failed.length === 0, stages, failed };
    }
    await sleep(opts.intervalMs, opts.signal);
  }
}
