import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import type { ForkOptions, UtilityProcess } from "electron";

/**
 * 외부 도구 실행기 (Phase 3 스펙 §6.4 "기동 중단"). initdb·pg_controldata·psql·createdb·pg_dump·pg_restore·마이그레이션
 * 러너(dev)가 이것 하나를 거친다. deadline과 중단 신호 중 먼저 오는 쪽이 도구를 끝낸다 — 도구 프로세스이지
 * postmaster가 아니므로 SIGTERM 뒤 SIGKILL로 올라가도 된다.
 *
 * 던지지 않는다. 실행 파일이 없어도, 시간이 넘어도, 중단돼도 결과로 돌려준다. 부르는 쪽이 그것을 원인 문구와 부류로
 * 바꾼다.
 */

/**
 * utilityProcess.fork의 모양. packaged API(api-process.ts)와 packaged 마이그레이션 러너가 받는다 — 테스트가 스폰 env를 본다.
 * 타입만이다: electron을 값으로 import하지 않는다.
 */
export type ForkFn = (modulePath: string, args: string[], options: ForkOptions) => UtilityProcess;

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ToolResult {
  /** 신호로 끝났거나 실행하지 못했으면 null. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

export interface ToolOptions {
  env: Record<string, string>;
  cwd?: string;
  deadlineMs?: number;
  signal?: AbortSignal;
  /** SIGTERM 뒤 SIGKILL까지. */
  killGraceMs?: number;
  spawnFn?: SpawnFn;
}

/** 스트림 하나당 보관하는 꼬리. pg_dump는 -f로 파일에 쓰므로 stdout이 크지 않다. */
const OUTPUT_LIMIT = 256_000;

export function runTool(bin: string, args: readonly string[], opts: ToolOptions): Promise<ToolResult> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted === true) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, aborted: true });
      return;
    }
    const child = (opts.spawnFn ?? spawn)(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let spawnError: string | undefined;
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    let killer: NodeJS.Timeout | undefined;

    const terminate = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // 이미 끝났다.
      }
      killer ??= setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 이미 끝났다.
        }
      }, opts.killGraceMs ?? 2_000);
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted, ...(spawnError === undefined ? {} : { spawnError }) });
    };

    child.stdout?.on("data", (b: Buffer) => {
      stdout = (stdout + b.toString()).slice(-OUTPUT_LIMIT);
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-OUTPUT_LIMIT);
    });
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.deadlineMs !== undefined) {
      deadline = setTimeout(() => {
        timedOut = true;
        terminate();
      }, opts.deadlineMs);
    }
    // spawn 실패는 'exit'가 아니라 'error'로 온다. 리스너가 없으면 Electron main이 통째로 죽는다.
    child.on("error", (e: Error) => {
      spawnError = e.message;
      finish(null);
    });
    child.on("close", (code: number | null) => finish(code));
  });
}

export function toolOk(r: ToolResult): boolean {
  return r.code === 0 && !r.timedOut && !r.aborted && r.spawnError === undefined;
}

/** 원인 블록. 사람에게 보이는 첫 줄과 stderr 꼬리 열두 줄. */
export function describeToolFailure(what: string, r: ToolResult): string {
  const why =
    r.spawnError !== undefined
      ? `실행하지 못했어요 (${r.spawnError})`
      : r.aborted
        ? "종료 중이라 멈췄어요"
        : r.timedOut
          ? "시간 안에 끝나지 않았어요"
          : `종료 코드 ${r.code}`;
  const tail = r.stderr.trim().split("\n").slice(-12).join("\n");
  return tail === "" ? `${what}: ${why}` : `${what}: ${why}\n${tail}`;
}
