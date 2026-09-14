import * as fs from "fs";
import * as path from "path";
import { CAUSES } from "../../diagnostics/causes";
import { manualUnlessTagged, ServiceFailure } from "../failure";
import { DB_NAME, DB_SUPERUSER, pgToolEnv, type PgBinaries, type PgLayout } from "./layout";
import { describeToolFailure, toolOk, type ToolOptions, type ToolResult } from "../../process/tool-runner";

/**
 * 마이그레이션 실행 게이트 (Phase 3 스펙 §6.5). api 어댑터가 API를 스폰하기 **전에** 부른다. 내장 모드에서만 돈다.
 *
 * 판정을 desktop이 재구현하지 않는다 — 상태는 be/src/database/migrate.ts가 한 줄 JSON으로 말한다. 그 줄을 파싱할 수
 * 없으면 통과시키지 않는다. 러너가 아무것도 하지 않고 exit 0으로 끝나는 경우를 성공으로 읽지 않기 위해서다.
 */

export interface MigrationStatus {
  applied: number;
  pending: string[];
  unknown: string[];
}

const isNames = (x: unknown): x is string[] => Array.isArray(x) && x.every((n) => typeof n === "string");

/** 마지막으로 나온 올바른 상태 줄. dev의 pnpm은 앞에 배너를 찍는다. */
export function parseStatusOutput(stdout: string): MigrationStatus | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let value: unknown;
    try {
      value = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const { applied, pending, unknown } = value as Record<string, unknown>;
    if (typeof applied === "number" && Number.isInteger(applied) && applied >= 0 && isNames(pending) && isNames(unknown)) {
      return { applied, pending, unknown };
    }
  }
  return null;
}

export interface MigrationRunner {
  status(signal: AbortSignal): Promise<ToolResult>;
  run(signal: AbortSignal): Promise<ToolResult>;
}

export const MIGRATION_STATUS_DEADLINE_MS = 60_000;
export const RESTORE_LIST_DEADLINE_MS = 60_000;
export const KEEP_BACKUPS = 5;

export interface MigrationGateDeps {
  runner: MigrationRunner;
  runTool(bin: string, args: readonly string[], opts: ToolOptions): Promise<ToolResult>;
  binaries: PgBinaries;
  layout: PgLayout;
  log(line: string): void;
  now?: () => Date;
}

export type GateOutcome = { kind: "up-to-date" } | { kind: "migrated"; applied: string[]; backup: string | null };

const DUMP_NAME = /^\d{8}T\d{6}Z-before-[A-Za-z0-9._-]+\.dump$/;
const PARTIAL_NAME = /^\d{8}T\d{6}Z-before-[A-Za-z0-9._-]+\.dump\.partial$/;

export function backupStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

const MAX_LOGGED_LINES = 400;

/** 마지막 한 줄의 개행만 지운다. trim()은 서두의 빈 줄까지 지워 줄 번호가 실제 출력과 어긋난다. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 러너의 stdout·stderr 전체를 supervisor.log에 남긴다 (스펙 §6.5-4). 화면에는 원인 줄 하나만 보이므로,
 * 그 줄을 못 찾을 때도 전체 진단이 로그에는 남아 있어야 한다.
 */
function logRunnerOutput(deps: MigrationGateDeps, r: ToolResult): void {
  for (const [stream, text] of [["stdout", r.stdout], ["stderr", r.stderr]] as const) {
    const lines = splitLines(text);
    for (const line of lines.slice(0, MAX_LOGGED_LINES)) deps.log(`마이그레이션 러너 ${stream}: ${line}`);
    if (lines.length > MAX_LOGGED_LINES) {
      deps.log(`마이그레이션 러너 ${stream}: … (${lines.length - MAX_LOGGED_LINES}줄 더 생략)`);
    }
  }
}

/** pg DatabaseError의 원인 줄. `error: relation "x" does not exist`처럼 서두에 온다. */
const ERROR_LINE = /^\s*(?:error|[A-Za-z]*Error)(?:\s*\[[^\]]*\])?:\s.*/;
/** DETAIL:·HINT: 같은 psql류 이어붙임 줄. 원인 줄 바로 다음일 때만 함께 보여준다. */
const CONTINUATION_LINE = /^\s*(?:DETAIL|HINT):/;

/**
 * 화면에 보일 원인 줄. describeToolFailure의 "꼬리 12줄"에는 pg DatabaseError의 원인이 없다 —
 * migrate.ts의 `console.error(e)`가 첫 줄(원인) 뒤로 스택과 20여 줄의 속성 덤프를 찍고, dev의 pnpm은
 * 그 뒤에 `ELIFECYCLE …`까지 붙인다. 원인은 항상 stderr 서두에 있으므로 거기서 찾는다. 못 찾으면
 * (원인 형태를 모르는 오류라면) 기존 방식으로 되돌아간다.
 */
function runnerFailureBlock(what: string, r: ToolResult): string {
  const head = splitLines(r.stderr).slice(0, 10);
  const idx = head.findIndex((l) => ERROR_LINE.test(l));
  if (idx === -1) return describeToolFailure(what, r);
  const next = head[idx + 1];
  const cont = next !== undefined && CONTINUATION_LINE.test(next) ? `\n${next.trim()}` : "";
  return `${what}: ${head[idx].trim()}${cont}`;
}

/** §5의 셋째·넷째 삭제. 앱이 만드는 이름 형식이고 실제 파일일 때만. */
function removeOwned(file: string, pattern: RegExp, log: (line: string) => void): void {
  if (!pattern.test(path.basename(file))) return;
  try {
    if (!fs.lstatSync(file).isFile()) return;
  } catch {
    return;
  }
  fs.rmSync(file);
  log(`마이그레이션 게이트: 지웠다 — ${file}`);
}

async function backup(deps: MigrationGateDeps, firstPending: string, signal: AbortSignal): Promise<string> {
  const dir = deps.layout.backups;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(dir)) removeOwned(path.join(dir, name), PARTIAL_NAME, deps.log);

  const stamp = backupStamp((deps.now ?? (() => new Date()))());
  const final = path.join(dir, `${stamp}-before-${firstPending.replace(/[^A-Za-z0-9._-]/g, "_")}.dump`);
  const partial = `${final}.partial`;
  const env = pgToolEnv();

  // deadline이 없다 — 데이터 크기에 비례한다. 멈추면 종료 신호가 끝낸다 (스펙 §12).
  const dump = await deps.runTool(deps.binaries.pgDump, ["-h", deps.layout.runDir, "-U", DB_SUPERUSER, "-Fc", "-f", partial, DB_NAME], { env, signal });
  if (!toolOk(dump)) throw new ServiceFailure(CAUSES.backupFailed.text(describeToolFailure("pg_dump", dump)), "manual");
  // 목차를 읽을 수 있는가까지가 "검증"이다. 복원 리허설은 Phase 5.
  const list = await deps.runTool(deps.binaries.pgRestore, ["--list", partial], { env, deadlineMs: RESTORE_LIST_DEADLINE_MS, signal });
  if (!toolOk(list)) throw new ServiceFailure(CAUSES.backupFailed.text(describeToolFailure("pg_restore --list", list)), "manual");
  fs.renameSync(partial, final);

  // 새 백업이 검증된 **뒤에만** 오래된 것을 지운다. 후보에서 방금 만든 파일 자신은 뺀다 — stamp가
  // 기존 파일들보다 이르면(시계가 되돌아갔거나 스텁 now()) 사전순 정렬에서 자신이 가장 오래된
  // 것으로 잡혀, 검증까지 마친 새 백업이 그 자리에서 지워진다.
  const finalName = path.basename(final);
  const dumps = fs.readdirSync(dir).filter((n) => DUMP_NAME.test(n) && n !== finalName).sort();
  for (const name of dumps.slice(0, Math.max(0, dumps.length - (KEEP_BACKUPS - 1)))) removeOwned(path.join(dir, name), DUMP_NAME, deps.log);
  deps.log(`마이그레이션 게이트: 적용 전 백업 — ${final}`);
  return final;
}

export function runMigrationGate(deps: MigrationGateDeps, signal: AbortSignal): Promise<GateOutcome> {
  return manualUnlessTagged(async () => {
    const s = await deps.runner.status(signal);
    if (!toolOk(s)) {
      logRunnerOutput(deps, s);
      throw new ServiceFailure(CAUSES.migrationStatusFailed.text(runnerFailureBlock("마이그레이션 러너", s)), "manual");
    }
    const status = parseStatusOutput(s.stdout);
    if (status === null) {
      const why = `마이그레이션 러너가 상태 줄을 내지 않았어요\n${s.stdout.trim().split("\n").slice(-6).join("\n")}`;
      throw new ServiceFailure(CAUSES.migrationStatusFailed.text(why), "manual");
    }
    // 옛 API 코드가 새 스키마에서 돌지 않게 한다. 아무것도 지우지 않는다 (스펙 §6.5-2).
    if (status.unknown.length > 0) throw new ServiceFailure(CAUSES.migrationUnknown.text(status.unknown), "manual");
    if (status.pending.length === 0) return { kind: "up-to-date" };

    const backupPath = status.applied > 0 ? await backup(deps, status.pending[0], signal) : null;
    deps.log(`마이그레이션 게이트: ${status.pending.length}개 적용 — ${status.pending.join(", ")}`);
    const r = await deps.runner.run(signal);
    if (!toolOk(r)) {
      logRunnerOutput(deps, r);
      throw new ServiceFailure(CAUSES.migrationFailed.text(runnerFailureBlock("마이그레이션 러너", r), backupPath), "manual");
    }
    const after = parseStatusOutput(r.stdout);
    if (after === null || after.pending.length > 0) {
      const left = after?.pending ?? status.pending;
      throw new ServiceFailure(CAUSES.migrationsStillPending.text(left.length, left.join(", ")), "manual");
    }
    return { kind: "migrated", applied: status.pending, backup: backupPath };
  });
}

/** dev — `pnpm be:migrate`와 같은 스크립트(ts-node). cwd가 be/라 dotenv가 be/.env를 읽지만 주입한 env를 덮지 않는다. */
export function devMigrationRunner(o: { repoRoot: string; env: Record<string, string>; runTool: MigrationGateDeps["runTool"] }): MigrationRunner {
  const base = ["--filter", "damwha-be", "run", "migrate"];
  return {
    status: (signal) => o.runTool("pnpm", [...base, "--", "--status"], { cwd: o.repoRoot, env: o.env, deadlineMs: MIGRATION_STATUS_DEADLINE_MS, signal }),
    // 실행에는 deadline을 두지 않는다 — 데이터 크기에 비례하고, 멈추면 종료 신호가 끝낸다.
    run: (signal) => o.runTool("pnpm", base, { cwd: o.repoRoot, env: o.env, signal }),
  };
}
