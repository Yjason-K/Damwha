import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import type { Readable } from "stream";
import type { SpawnFn } from "./tool-runner";

/**
 * 시스템 오디오 헬퍼(`native/system-audio/main.swift`)를 띄우고 거두는 순수 모듈. electron을 import하지 않는다 —
 * vitest가 부를 수 있어야 한다(`main.ts`는 못 부른다).
 *
 * 헬퍼의 계약(main.swift 머리 주석과 짝): stdout은 16 kHz·mono·int16 LE PCM **바이트만**, stderr에 준비가 끝나면
 * `READY` 한 줄, 실패하면 `ERROR <단계> <OSStatus>`. stdin이 닫히면 tap·aggregate를 지우고 스스로 끝난다.
 *
 * stdout 청크는 샘플 경계와 맞지 않을 수 있다(홀수 바이트). 소비자가 이어 붙여 2바이트 단위로 자른다.
 */

/** `build-system-audio.sh`가 스테이징하는 파일 이름. dev `desktop/build/system-audio`, packaged `Resources/system-audio`. */
export const SYSTEM_AUDIO_HELPER = "damwha-system-audio";

export function systemAudioHelperPath(bundleDir: string): string {
  return path.join(bundleDir, SYSTEM_AUDIO_HELPER);
}

/** READY까지의 상한. */
export const READY_TIMEOUT_MS = 5_000;
/** stdin을 닫은 뒤 스스로 끝나기를 기다리는 시간. 넘기면 SIGTERM, 다시 넘기면 SIGKILL. */
export const STOP_GRACE_MS = 1_000;

export interface SystemAudioSession {
  pcm: Readable;
  /** 헬퍼가 끝나면 settle한다 — 정상 종료든 신호든. 거부하지 않는다. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** 여러 번 불러도 된다. stdin을 닫고(정리 경로), 끝나지 않으면 신호로 올린다. */
  stop(): void;
}

export class SystemAudioStartError extends Error {}

export interface StartOptions {
  spawnFn?: SpawnFn;
  readyTimeoutMs?: number;
  stopGraceMs?: number;
}

/**
 * 헬퍼를 띄우고 READY를 기다린다. READY 전에 ERROR·종료·시간 초과가 오면 프로세스가 **끝난 뒤에** 던진다 —
 * 반쯤 뜬 헬퍼를 남기면 tap이 열린 채 아무도 읽지 않는다.
 */
export function startSystemAudio(bin: string, opts: StartOptions = {}): Promise<SystemAudioSession> {
  const child: ChildProcess = (opts.spawnFn ?? spawn)(bin, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin" },
  });
  const graceMs = opts.stopGraceMs ?? STOP_GRACE_MS;

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }));
    // spawn 실패는 'close' 없이 'error'만 올 수 있다. 리스너가 없으면 Electron main이 통째로 죽는다.
    child.once("error", () => resolve({ code: null, signal: null }));
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.stdin?.end();
    const term = setTimeout(() => {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), graceMs);
      void exited.then(() => clearTimeout(kill));
    }, graceMs);
    void exited.then(() => clearTimeout(term));
  };

  return new Promise<SystemAudioSession>((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      void exited.then(() => reject(new SystemAudioStartError(why)));
    };
    const timer = setTimeout(
      () => fail("시스템 오디오 헬퍼가 시간 안에 준비되지 않았어요"),
      opts.readyTimeoutMs ?? READY_TIMEOUT_MS,
    );
    child.stderr?.on("data", (b: Buffer) => {
      if (settled) return;
      stderr += b.toString();
      const lines = stderr.split("\n");
      const error = lines.find((l) => l.startsWith("ERROR "));
      if (error !== undefined) {
        fail(`시스템 오디오 헬퍼가 실패했어요 (${error.slice("ERROR ".length).trim()})`);
        return;
      }
      if (lines.some((l) => l.trim() === "READY")) {
        settled = true;
        clearTimeout(timer);
        resolve({ pcm: child.stdout as Readable, exited, stop });
      }
    });
    child.once("error", (e: Error) => fail(`시스템 오디오 헬퍼를 실행하지 못했어요 (${e.message})`));
    void exited.then(({ code }) => fail(`시스템 오디오 헬퍼가 준비 전에 끝났어요 (종료 코드 ${code})`));
  });
}
