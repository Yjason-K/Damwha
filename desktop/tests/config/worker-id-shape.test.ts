import { expect, test, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { APP_WORKER_PREFIX, loadConfig } from "../../src/config/config";

/**
 * `RUN_WORKER_ID`는 모듈 안에서 사적이라 `loadConfig`의 결과로 확인한다 — 자식이 받는
 * WORKER_ID는 이 값이 `ctx.env`를 거쳐 `childEnv`에 실린 것이다(config.ts의 `withAppOwned`).
 * `childEnv(ctx(), {})`처럼 빈 `env`로 직접 부르면 WORKER_ID가 아직 얹히기 전이라 undefined다.
 */
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-config-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("자식에게 가는 WORKER_ID는 BE의 회수가 아는 접두사를 쓴다", () => {
  // be/src/jobs/worker-identity.ts의 APP_WORKER_PREFIX와 같은 문자열이어야 한다.
  expect(APP_WORKER_PREFIX).toBe("desktop-");
  const env = loadConfig(dir).env;
  expect(env.WORKER_ID?.startsWith(APP_WORKER_PREFIX)).toBe(true);
});
