import * as path from "path";
import { CAUSES } from "../causes";
import type { LaunchContext, LaunchResult, ReadinessResult, ServiceSpec } from "./types";

export type DockerRunner = (
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

export type ComposeState =
  | { kind: "healthy" }
  | { kind: "starting" }
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string };

/**
 * 데몬이 없을 때 docker CLI가 내는 문구. 2026-09-12 실측(compose v5.5.0):
 *   failed to connect to the docker API at unix://…; check if the path is correct and if the
 *   daemon is running: dial unix …: connect: no such file or directory   (exit 1, stdout 빈 문자열)
 * 예전 Docker는 "Cannot connect to the Docker daemon at …"를 냈으므로 둘 다 받는다.
 */
const DAEMON_DOWN =
  /cannot connect to the docker daemon|failed to connect to the docker api|daemon is running/i;
/** 원인만 적는다. "Docker Desktop을 실행하세요"는 shell-hints.ts의 안내가 붙인다. */
const DAEMON_DOWN_CAUSE = CAUSES.dockerDaemonDown.text;

function composeFile(ctx: LaunchContext): string {
  return path.join(ctx.repoRoot, "be", "docker-compose.yml");
}

/** compose의 한 행인가. JSON으로는 멀쩡하지만 객체가 아닌 값(null·true·숫자·문자열·배열)을 가른다. */
function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * compose는 버전에 따라 JSON 배열 하나를 주기도 하고 줄마다 객체를 주기도 한다. 둘 다 받는다 —
 * 형식 하나만 받으면 사람의 Docker Desktop 판올림이 준비 판정을 조용히 깨뜨린다.
 *
 * 무슨 입력에도 **던지지 않는다**. 이 함수는 readiness가 부르고, readiness가 던지면 그 서비스는
 * 기동 시퀀스를 통째로 세운다 — "준비를 못 했다"는 판정이어야 할 일이 예외가 된다. 못 읽으면
 * 못 읽었다고(unreadable) 원문을 달아 답하는 것이 이 함수의 유일한 실패 방식이다.
 */
export function parseComposeStatus(stdout: string): ComposeState {
  const text = stdout.trim();
  if (text.length === 0) return { kind: "absent" };
  const unreadable: ComposeState = { kind: "unreadable", detail: text.slice(0, 200) };

  let values: unknown[];
  try {
    if (text.startsWith("[")) {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return unreadable;
      values = parsed;
    } else {
      values = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown);
    }
  } catch {
    return unreadable;
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const value of values) {
    // 객체가 아닌 행은 "우리가 안 보는 서비스"가 아니라 **깨진 출력**이다. `null` 하나에
    // r.Service가 TypeError를 던진 것이 이 검사가 생긴 이유고, 조용히 건너뛰어 absent로
    // 내려가면 그것대로 나쁘다 — absent는 not-ready라 사람은 준비 유예가 다 찰 때까지 아무
    // 설명도 못 본다. 살아 있는지를 읽으려던 출력이 이해가 안 되면 모른다고 말한다.
    if (!isRow(value)) return unreadable;
    rows.push(value);
  }

  const row = rows.find((r) => r.Service === "postgres");
  if (row === undefined) return { kind: "absent" };
  if (String(row.State) !== "running") return { kind: "absent" };
  return String(row.Health ?? "") === "healthy" ? { kind: "healthy" } : { kind: "starting" };
}

export function postgresSpec(run: DockerRunner): ServiceSpec {
  const status = async (ctx: LaunchContext): Promise<ComposeState> => {
    const r = await run(["compose", "-f", composeFile(ctx), "ps", "-a", "--format", "json"]);
    if (r.code !== 0) {
      const detail = DAEMON_DOWN.test(r.stderr) ? DAEMON_DOWN_CAUSE : r.stderr.trim().slice(0, 400);
      return { kind: "unreadable", detail };
    }
    return parseComposeStatus(r.stdout);
  };

  return {
    id: "postgres",
    dependsOn: [],
    gate: true,
    // 준비 뒤에도 이 주기로 다시 본다. 없으면 컨테이너가 내려가도 아무도 모르고 running/ok로
    // 남는다. docker compose ps는 서브프로세스 스폰이라 30초로 둔다 (스펙 §6.6, P2-C11).
    healthIntervalMs: 30_000,
    async detectExternal(ctx) {
      const s = await status(ctx);
      // 이미 떠 있으면 그게 정상이다. 우리가 띄웠든 사람이 띄웠든 컨테이너는 하나다.
      if (s.kind === "healthy") return { kind: "adopt", detail: "이미 실행 중인 컨테이너" };
      return { kind: "absent" };
    },
    async launch(ctx): Promise<LaunchResult> {
      // up -d만 부른다. down·stop·rm은 이 파일 어디에도 없다 — 앱은 컨테이너를 내리지 않는다.
      const r = await run(["compose", "-f", composeFile(ctx), "up", "-d"]);
      if (r.code !== 0) {
        throw new Error(DAEMON_DOWN.test(r.stderr) ? DAEMON_DOWN_CAUSE : r.stderr.trim().slice(0, 400));
      }
      // 컨테이너는 Docker 데몬 소유다. 앱이 쥔 프로세스 핸들이 없으므로 null이고,
      // owned가 true여도 stop()이 아무것도 하지 않는다.
      return { handle: null, owned: true };
    },
    async readiness(_result, ctx): Promise<ReadinessResult> {
      const s = await status(ctx);
      if (s.kind === "healthy") return { kind: "ready" };
      // unreadable을 not-ready로 두면 데몬이 꺼진 상태에서 유예가 다 찰 때까지
      // 사용자가 아무 설명도 못 본다.
      if (s.kind === "unreadable") return { kind: "failed", detail: s.detail };
      return { kind: "not-ready" };
    },
    async stop() {
      // 의도적으로 아무것도 하지 않는다. compose의 restart: unless-stopped가 컨테이너를 소유하고,
      // 앱이 오기 전부터 떠 있던 컨테이너를 앱이 내리면 "외부 서비스를 구분해 관리"가 깨진다.
      return { stopped: true, leaked: [] };
    },
    // compose가 이미 재시작을 한다. 앱이 겹쳐 하면 두 감독자가 같은 컨테이너를 다툰다.
    restart: "never",
  };
}
