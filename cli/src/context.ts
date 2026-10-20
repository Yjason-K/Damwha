import type { DamwhaClient } from './client';
import type { ConnectionResult } from './connection';
import type { Lang } from './messages';
import type { Out } from './output';

/** run()의 입출력과 환경. 선택 필드는 테스트가 갈아끼우는 자리이고 main.ts는 안 채운다. */
export interface RunIo {
  stdout: Out;
  stderr: Out;
  env: NodeJS.ProcessEnv;
  now(): Date;
  /** Ctrl-C로 abort된다. `--wait`만 쓴다. */
  signal?: AbortSignal;
  userDataDir?: string;
  connect?: () => Promise<ConnectionResult>;
  createClient?: (baseUrl: string) => DamwhaClient;
  waitIntervalMs?: number;
}

export interface Ctx {
  client: DamwhaClient;
  io: RunIo;
  lang: Lang;
  json: boolean;
}
