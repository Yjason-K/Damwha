import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { makeReadinessWatch, workerSpec } from "../../src/services/worker";
import { BLOCK_MAX_CHARS } from "../../src/diagnostics/stderr";
import type { LaunchContext, ServiceHandle } from "../../src/services/types";
import { fakeChild } from "../fake-child";

const READY = "INFO supervisor desktop-7 ready (db connected)";
const STARTED = "INFO supervisor desktop-7 started";
const RECONNECT_FAILED = "WARNING reconnect failed — retry in 2s";

/**
 * 처리 중인 worker가 몇 초마다 찍는 STT 진행 줄. 2026-09-13 packaged 실측: 실제 worker.log에서
 * ready 줄 뒤 60번째 줄(15% 진행 줄)에서 stderr 꼬리가 8,000자를 넘었다. 여기서는 그보다 넉넉히 쌓는다.
 */
const PROGRESS = Array.from(
  { length: 250 },
  (_, i) => `INFO [stt] meeting 42 transcribing ${i % 100}% (chunk ${i}/250)\n`,
).join("");

function ctx(over: Partial<LaunchContext> = {}): LaunchContext {
  return {
    repoRoot: "/r",
    userData: "/u",
    packaged: true,
    databaseMode: "embedded",
    env: { DATABASE_URL: "postgres://x", STORAGE_ROOT: "/u/storage" },
    bins: { uv: "/opt/homebrew/bin/uv", python: "/b/python/bin/python3.12", ffmpeg: "/b/ffmpeg/bin/ffmpeg", ffprobe: "/b/ffmpeg/bin/ffprobe" },
    runId: "desktop-test",
    searchDirs: ["/opt/homebrew/bin"],
    logFile: (id) => `/u/logs/${id}.log`,
    signal: new AbortController().signal,
    ...over,
  };
}

function handle(tail: string, alive = true): ServiceHandle {
  return {
    pid: 4242,
    alive: () => alive,
    stderrTail: () => tail,
    exitCode: () => (alive ? null : 1),
    onExit: () => undefined,
    stop: async () => undefined,
  } as unknown as ServiceHandle;
}

describe("makeReadinessWatch", () => {
  it("survives a worker id with dashes and digits", () => {
    const watch = makeReadinessWatch();
    watch.feed("INFO supervisor desktop-1757600000-99 ready (db connected)\n");
    expect(watch.state()).toBe("ready");
  });

  it("keeps the END of an over-long unterminated line — a ready line after a `\\r` bar still counts", () => {
    // 진행 바는 줄바꿈 없이 `\r`로 다시 그린다. 그 뒤에 로그 줄이 이어 붙으면 한 "줄"이 길어진다.
    const watch = makeReadinessWatch();
    watch.feed(`${"\r 15% |####      |".repeat(10_000)}\r${READY}`);
    expect(watch.state()).toBe("not-ready");
    watch.feed("\n");
    expect(watch.state()).toBe("ready");
  });

  it("bounds the carried partial line — a marker buried far before the newline is dropped, not kept forever", () => {
    // 끝나지 않는 한 줄이 메모리를 한없이 키우지 않는다는 것의, 밖에서 볼 수 있는 모서리다.
    // 실제 ready 줄은 logging이 줄바꿈까지 한 번에 쓰므로 이렇게 묻히지 않는다.
    const watch = makeReadinessWatch();
    watch.feed(READY);
    watch.feed("x".repeat(100_000));
    watch.feed("\n");
    expect(watch.state()).toBe("not-ready");
  });
});

let tmpDir: string | undefined;
afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

/**
 * 진짜 launch() 경로로 띄운다 — spawn만 가짜다. readiness가 무엇을 읽는지는 launchWithUv의
 * stderr 리스너에서 readiness()까지의 배선 전체가 정하므로, 손으로 만든 handle로는 그 배선을 볼 수 없다.
 */
async function launched() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-worker-"));
  const dir = tmpDir;
  const child = fakeChild();
  const spec = workerSpec({ listExternal: async () => [], exists: () => true, spawnFn: () => child });
  const launchCtx = ctx({ logFile: (id) => path.join(dir, `${id}.log`) });
  const result = await spec.launch(launchCtx);
  const h = result.handle;
  if (h === null) throw new Error("handle이 없다");
  return {
    handle: h,
    stderr: (text: string) => child.stderr.emit("data", Buffer.from(text)),
    exit: (code: number) => child.emit("exit", code),
    readiness: () => spec.readiness(result, launchCtx),
  };
}

describe("workerSpec readiness — stderr 스트림의 마지막 준비 이벤트로 판정한다", () => {
  it("stays ready after the ready line scrolls out of the 8,000-char stderr tail (packaged 실측 결함)", async () => {
    const w = await launched();
    w.stderr(`${STARTED}\n${READY}\n`);
    w.stderr(PROGRESS);
    // 전제: ready 줄이 정말로 꼬리에서 밀려났다. 이것이 거짓이면 이 테스트는 아무것도 지키지 않는다.
    expect(w.handle.stderrTail()).not.toContain("ready (db connected)");
    expect((await w.readiness()).kind).toBe("ready");
    w.exit(0);
  });

  it("started alone is not ready — the pre-connect line must never count (P2-C10)", async () => {
    // __main__.py의 started 줄은 DB에 붙기 전에 찍힌다. 이 줄을 준비로 읽으면 화면은
    // "준비됨"인데 큐는 영원히 안 돈다.
    const w = await launched();
    w.stderr(`${STARTED}\n`);
    expect((await w.readiness()).kind).toBe("not-ready");
    w.exit(0);
  });

  it("a DB broken from the start is not-ready, never degraded — reconnect failure before any ready (P2-C10)", async () => {
    // degraded를 답하면 감독자의 applyReadiness가 running으로 적는다. 한 번도 붙은 적 없는 worker는
    // 준비 유예를 넘겨 failed가 되어야 한다.
    const w = await launched();
    w.stderr(`${STARTED}\n${RECONNECT_FAILED}\nTraceback (most recent call last):\n  psycopg.OperationalError: boom\n`);
    expect((await w.readiness()).kind).toBe("not-ready");
    w.exit(0);
  });

  it("ready → (long processing) → reconnect failed is degraded", async () => {
    const w = await launched();
    w.stderr(`${STARTED}\n${READY}\n`);
    w.stderr(PROGRESS);
    w.stderr(`${RECONNECT_FAILED}\nTraceback (most recent call last):\n  psycopg.OperationalError: boom\n`);
    expect(await w.readiness()).toMatchObject({ kind: "degraded" });
    w.exit(0);
  });

  it("reconnect failed → ready is ready again, and stays so through long processing (회복)", async () => {
    const w = await launched();
    w.stderr(`${STARTED}\n${READY}\n${RECONNECT_FAILED}\n`);
    expect((await w.readiness()).kind).toBe("degraded");
    w.stderr(`${READY}\n`);
    w.stderr(PROGRESS);
    expect((await w.readiness()).kind).toBe("ready");
    w.exit(0);
  });

  it("recognizes a ready line split across two stderr chunks", async () => {
    const w = await launched();
    w.stderr(`${STARTED}\nINFO supervisor desktop-7 rea`);
    w.stderr("dy (db connected)\n");
    expect((await w.readiness()).kind).toBe("ready");
    w.exit(0);
  });

  it("an exited worker is failed with its exit cause, even after it was ready", async () => {
    const w = await launched();
    w.stderr(`${STARTED}\n${READY}\n`);
    w.stderr(PROGRESS);
    w.stderr("Traceback (most recent call last):\nRuntimeError: boom\n");
    w.exit(1);
    const r = await w.readiness();
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" ? r.detail : "").toContain("RuntimeError: boom");
  });
});

describe("workerSpec", () => {
  const deps = (over = {}) => ({
    listExternal: async () => [] as number[],
    ...over,
  });

  it("depends on postgres and is not a gate", () => {
    const spec = workerSpec(deps() as never);
    expect(spec.dependsOn).toContain("postgres");
    expect(spec.gate).toBe(false);
  });

  it("stands down when an external supervisor is running", async () => {
    const spec = workerSpec(deps({ listExternal: async () => [4101] }) as never);
    const ext = await spec.detectExternal(ctx());
    expect(ext.kind).toBe("stand-down");
    // env를 읽을 수 없으므로(ps eww는 SIP가 막는다) 채택을 증명할 수 없다 — 경고한다.
    expect(ext.kind === "stand-down" && ext.detail).toMatch(/STORAGE_ROOT/);
  });

  it("launches when nothing external is running", async () => {
    expect((await workerSpec(deps() as never).detectExternal(ctx())).kind).toBe("absent");
  });

  it("refuses to launch without uv and names what is missing (the fix is recoveryHint's)", async () => {
    const spec = workerSpec(deps() as never);
    await expect(spec.launch(ctx({ bins: { ...ctx().bins, uv: null } }))).rejects.toThrow(/uv/);
  });

  it("refuses to launch when the worker .env is missing", async () => {
    // be/.gitignore:7이 be/worker/.env를 무시하므로 새 체크아웃에는 없다. 없으면
    // LENS_LLM_BASE_URL이 비어 worker가 로그 한 줄 전에 죽는다 (config.py:34-39).
    const spec = workerSpec(deps({ exists: () => false }) as never);
    await expect(spec.launch(ctx())).rejects.toThrow(/\.env/);
  });

  it("keeps watching health after it is ready", () => {
    // worker도 ready 뒤 DB가 끊기면 _reconnect 루프에 들어가 프로세스는 살고 큐만 멈춘다.
    // 이미 쌓아 둔 마지막 이벤트를 읽을 뿐이라 주기가 짧아도 값싸다.
    expect(workerSpec(deps() as never).healthIntervalMs).toBeGreaterThan(0);
  });

  it("reports failed when the process died", async () => {
    const spec = workerSpec(deps() as never);
    const r = await spec.readiness({ handle: handle("boom", false), owned: true }, ctx());
    expect(r.kind).toBe("failed");
  });

  it("bounds a dead worker's cause by characters too, keeping the end (리뷰 M-5)", async () => {
    // 줄 수(12)만 자르면 줄바꿈 없는 한 줄 — 진행 바의 `\r` 덩어리 — 이 stderr 꼬리를 통째로 싣는다.
    const spec = workerSpec(deps() as never);
    const r = await spec.readiness({ handle: handle(`${"x".repeat(8_000)}RuntimeError: boom`, false), owned: true }, ctx());
    const detail = r.kind === "failed" ? r.detail : "";
    expect(detail.length).toBe(BLOCK_MAX_CHARS + 1);
    expect(detail.endsWith("RuntimeError: boom")).toBe(true);
  });

  it("hands the injected stop the WHOLE plan, not just the grace", async () => {
    // 유예 초과 대화상자를 띄우는 것은 plan.onGraceExpired다. graceMs만 넘기면 어댑터가
    // 그 콜백에 닿을 길이 없고, 감독자도 그것을 부르지 않으므로(stopAll은 plan을
    // spec.stop에 넘기기만 한다) 아무도 부르지 않는 콜백이 된다 — 유예가 지나도 사람에게
    // 묻지 않고 조용히 강제 단계를 건너뛴다. 그 상태로는 P2-C4·P2-C5가 둘 다 조용히
    // 실패한다: worker는 살아남고, 사용자는 자기가 받은 적 없는 질문의 결과를 본다.
    const asked: string[] = [];
    const seen: unknown[] = [];
    const spec = workerSpec(
      deps({
        stop: async (_result: unknown, plan: { onGraceExpired?: (id: string) => Promise<boolean> }) => {
          seen.push(plan);
          // 어댑터가 하는 일이 바로 이것이다 — 자기가 묻지 않고 감독자가 준 것을 전달한다.
          await plan.onGraceExpired?.("worker");
          return { stopped: true, leaked: [] };
        },
      }) as never,
    );
    await spec.stop(
      { handle: handle(READY), owned: true },
      {
        graceMs: 5_000,
        onGraceExpired: async (id) => {
          asked.push(id);
          return true;
        },
      },
    );
    expect(asked).toEqual(["worker"]);
    expect(seen[0]).toMatchObject({ graceMs: 5_000 });
  });

  it("carries the adapter's reason back out", async () => {
    // 어댑터가 구분해 돌려준 detail이 여기서 떨어지면 대화상자가 그것을 볼 수 없다.
    const spec = workerSpec(
      deps({
        stop: async () => ({ stopped: false, leaked: [7], detail: "사람이 강제를 거절했어요." }),
      }) as never,
    );
    const out = await spec.stop({ handle: handle(READY), owned: true }, { graceMs: 10 });
    expect(out).toEqual({ stopped: false, leaked: [7], detail: "사람이 강제를 거절했어요." });
  });
});
