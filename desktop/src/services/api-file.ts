import * as fsp from "fs/promises";
import * as path from "path";
import { randomBytes } from "crypto";
import type { ProcessState, HealthState } from "./types";

/**
 * `<userData>/api.json` — `damwha` CLI가 앱의 API를 찾는 유일한 길이다 (spec 2026-10-20 §2.5).
 * 모양은 cli/src/connection.ts가 읽는 것과 같다. 필드를 바꾸면 그쪽도 바꾼다.
 *
 * instance는 기동마다 새로 뽑는 nonce이고 API가 /api/health에 그대로 되돌려 준다. CLI는 파일의 instance와
 * 헬스의 instance가 같을 때만 그 포트를 믿는다 — 앱이 죽어 파일이 남았고 그 포트를 다른 프로세스가 쥐어도
 * 엉뚱한 서버에 붙지 않는다.
 */
export interface ApiFile {
  port: number;
  app_pid: number;
  instance: string;
  version: string;
}

export const API_FILE_NAME = "api.json";

/** 테스트가 가짜를 꽂을 수 있게 쓰는 fs 조각. 기본은 fs/promises다. */
export interface ApiFileFs {
  writeFile(file: string, data: string, options: { mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readFile(file: string, encoding: "utf8"): Promise<string>;
  unlink(file: string): Promise<void>;
}

/** 임시 파일에 쓰고 rename한다 — 읽는 쪽이 반쯤 쓴 JSON을 보지 못한다. 포트는 비밀이 아니지만 0600이다. */
export async function writeApiFile(dir: string, data: ApiFile, fs: ApiFileFs = fsp): Promise<void> {
  const target = path.join(dir, API_FILE_NAME);
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * 파일의 instance가 내 것일 때만 지운다. 새 앱이 이미 덮어썼다면 옛 앱의 종료가 그 파일을 지워 CLI를
 * 눈멀게 하지 않는다. 없거나 깨진 파일은 그대로 둔다 — 지울 근거가 없다.
 */
export async function removeApiFileIfOwned(dir: string, instance: string, fs: ApiFileFs = fsp): Promise<void> {
  const target = path.join(dir, API_FILE_NAME);
  let current: unknown;
  try {
    current = JSON.parse(await fs.readFile(target, "utf8"));
  } catch {
    return;
  }
  if ((current as { instance?: unknown } | null)?.instance !== instance) return;
  await fs.unlink(target).catch(() => undefined);
}

export interface ApiLaunchInfo {
  origin: string;
  instance: string;
}

/**
 * 감독자 상태 → 파일의 쓰기·지우기 결정. main.ts는 renderStatus와 종료 경로에서 이것만 부른다.
 *
 * - running+ok가 된 첫 시점에 쓴다. degraded(DB 끊김)는 프로세스가 살아 있으므로 파일을 두되, 처음부터
 *   degraded였다면 쓰지 않는다 — CLI가 받을 수 없는 서버를 가리키지 않는다.
 * - stopped·failed면 지운다. 재시작은 launch마다 새 instance를 만들므로 다시 ok가 되면 새로 쓴다.
 * - 호출이 겹쳐도 한 줄로 이어 처리한다(renderStatus는 await하지 않는다).
 */
export function createApiFileSync(opts: { dir: string; pid: number; version: string; fs?: ApiFileFs }) {
  let published: string | null = null;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (job: () => Promise<void>): Promise<void> => {
    chain = chain.then(job, job);
    return chain;
  };

  return {
    update(
      api: { process: ProcessState; health: HealthState } | undefined,
      launch: ApiLaunchInfo | null,
    ): Promise<void> {
      if (api === undefined || launch === null) return Promise.resolve();
      return enqueue(async () => {
        if (api.process === "running" && api.health === "ok") {
          if (published === launch.instance) return;
          const port = Number(new URL(launch.origin).port);
          published = launch.instance;
          await writeApiFile(
            opts.dir,
            { port, app_pid: opts.pid, instance: launch.instance, version: opts.version },
            opts.fs,
          ).catch(() => {
            published = null; // 못 썼다 — 다음 상태 갱신이 다시 시도한다.
          });
        } else if ((api.process === "stopped" || api.process === "failed") && published !== null) {
          const mine = published;
          published = null;
          await removeApiFileIfOwned(opts.dir, mine, opts.fs);
        }
      });
    },
    /** 종료 경로용. 쓴 적이 있으면 내 instance일 때만 지운다. */
    removeNow(): Promise<void> {
      return enqueue(async () => {
        if (published === null) return;
        const mine = published;
        published = null;
        await removeApiFileIfOwned(opts.dir, mine, opts.fs);
      });
    },
  };
}
