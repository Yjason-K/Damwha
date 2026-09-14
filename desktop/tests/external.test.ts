import { describe, expect, it } from "vitest";
import {
  listExternalWorkers,
  parseWorkerProcesses,
  probeEmbedContract,
} from "../src/services/external";

// 2026-09-12 실측한 다섯 가지 모양을 한 fixture에 모았다. 첫 줄(4101)만 supervisor다.
// 4102/4103이 핵심이다 — 둘 다 `-m damwha_worker`를 인자로 그대로 갖고 있고, 4103이
// **앱이 자기 worker를 띄울 때 나오는 기본 모양**이다(Task 2의 findExecutable이 절대
// 경로를 주고 Task 8의 launchWithUv가 그 경로로 spawn한다). 문자열 필터로는 못 거른다.
const PS = [
  "  PID COMMAND",
  " 4101 /Users/jason/projects/Damwha2/be/worker/.venv/bin/python3 -m damwha_worker",
  " 4102 uv run --directory be/worker python -m damwha_worker",
  " 4103 /opt/homebrew/bin/uv run --directory /Users/jason/projects/Damwha2/be/worker python -m damwha_worker",
  " 4207 /Users/jason/projects/Damwha2/be/worker/.venv/bin/python3 -m damwha_worker --once",
  " 4300 /usr/bin/grep damwha_worker",
  " 4310 /bin/zsh -c source /snap.sh && pnpm worker && echo damwha_worker",
  " 4400 /Applications/Damwha.app/Contents/MacOS/Damwha",
].join("\n");

// 위 fixture를 만든 실제 캡처를 그대로 박아 둔다. 명령은
// `/opt/homebrew/bin/uv run --directory …/be/worker python -m damwha_worker`(앱이 부르는
// 방식 그대로)였고, 아래는 `ps -axo pid,command | grep "[d]amwha_worker"`의 원문이다.
// 4310을 손으로 줄인 것과 달리 실제 셸 줄에는 `-m damwha_worker`가 **토큰 쌍으로**
// 들어 있어, argv[0] 검사 없이는 원리적으로 구분할 수 없다.
const REAL_PS = [
  "  PID COMMAND",
  "19645 /bin/zsh -c source /Users/jason/.claude/shell-snapshots/snapshot-zsh-1789195230214-jc6uuq.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval '/opt/homebrew/bin/uv run --directory /Users/jason/projects/Damwha2/be/worker python -m damwha_worker > /tmp/scratch/w.log 2>&1' < /dev/null && pwd -P >| /tmp/claude-59b3-cwd",
  "19651 /opt/homebrew/bin/uv run --directory /Users/jason/projects/Damwha2/be/worker python -m damwha_worker",
  "19652 /Users/jason/projects/Damwha2/be/worker/.venv/bin/python3 -m damwha_worker",
].join("\n");

// Phase 4에서 번들 런타임이 venv를 대체하면 앱은 uv를 거치지 않고 python을 직접 spawn한다.
// 그러면 우리가 띄운 root 자신이 supervisor 줄이 되고, 이름 필터는 그걸 (당연히) 잡는다.
const PS_APP_OWNED = [
  "  PID COMMAND",
  " 5001 /Applications/Damwha.app/Contents/Resources/python/bin/python3 -m damwha_worker",
].join("\n");

describe("parseWorkerProcesses", () => {
  it("finds the venv-python supervisor and nothing else", () => {
    expect(parseWorkerProcesses(PS, new Set())).toEqual([4101]);
  });

  it("accepts any python-named argv[0], not just the venv path", () => {
    // 허용 목록이 실측 경로 하나에만 맞춰지면, 사용자가 시스템 python으로 띄운 외부
    // supervisor를 놓쳐 앱이 그 옆에 두 번째 worker를 띄운다.
    for (const argv0 of [
      "/opt/homebrew/bin/python3.12",
      "/usr/bin/python3",
      "/opt/homebrew/opt/python@3.13/bin/python3.13",
      "python",
    ]) {
      expect(parseWorkerProcesses(`  PID COMMAND\n 7001 ${argv0} -m damwha_worker`, new Set())).toEqual(
        [7001],
      );
    }
  });

  it("ignores the bare `uv run` launcher (a terminal `pnpm worker`)", () => {
    // uv가 exec로 자신을 대체하지 않아 실제 supervisor의 부모로 남는다. 별개의 pid다.
    expect(parseWorkerProcesses(PS, new Set())).not.toContain(4102);
  });

  it("ignores the absolute-path `uv run` launcher the app itself spawns", () => {
    // 앞선 구현의 `^uv\s+run` 앵커가 놓친 모양이다. 앱은 uv를 늘 절대 경로로 부르므로
    // 이것이 예외가 아니라 기본이다. 이걸 세면 앱은 자기 런처를 외부 supervisor로 보고
    // worker를 영영 띄우지 않는다.
    expect(parseWorkerProcesses(PS, new Set())).not.toContain(4103);
  });

  it("ignores the one-shot child", () => {
    // __main__.py:279가 자식을 [sys.executable, "-m", "damwha_worker", "--once"]로 띄운다.
    // 거르지 않으면 job 하나를 처리 중인 자식을 상시 supervisor로 오인해 앱이 영영 안 띄운다.
    expect(parseWorkerProcesses(PS, new Set())).not.toContain(4207);
    // 다만 토큰 비교라서 `--once`로 시작하는 다른 플래그에는 걸리지 않는다.
    expect(
      parseWorkerProcesses("  PID COMMAND\n 7100 /usr/bin/python3 -m damwha_worker --once-ish", new Set()),
    ).toEqual([7100]);
  });

  it("ignores a grep that merely mentions the module", () => {
    expect(parseWorkerProcesses(PS, new Set())).not.toContain(4300);
  });

  it("ignores a shell whose command text merely mentions the module", () => {
    expect(parseWorkerProcesses(PS, new Set())).not.toContain(4310);
  });

  it("ignores an unrelated process with no module argument at all", () => {
    expect(parseWorkerProcesses(PS, new Set())).not.toContain(4400);
  });

  it("returns only the supervisor from the real 2026-09-12 ps capture", () => {
    // 앞선 거부 목록 구현은 이 원문에 [19645, 19651, 19652]를 돌려줬다 — 셋 중 둘이 오탐이다.
    expect(parseWorkerProcesses(REAL_PS, new Set())).toEqual([19652]);
  });

  it("excludes any pid in ourPids, including the launcher root itself", () => {
    // 이 함수는 우리 것/남의 것을 pid 집합으로만 가른다. main.ts의 descendantPids(root)는
    // root를 반환값에 넣지 않으므로(main.ts:261-273) 호출부가 root를 손수 합쳐야 한다 —
    // verifyOwnListener가 main.ts:287에서 하는 것과 같다. 그 의무를 여기서 못 박는다.
    expect(parseWorkerProcesses(PS_APP_OWNED, new Set())).toEqual([5001]);
    expect(parseWorkerProcesses(PS_APP_OWNED, new Set([5001]))).toEqual([]);
    expect(parseWorkerProcesses(PS, new Set([4101]))).toEqual([]);
  });

  it("returns nothing for empty or header-only input", () => {
    expect(parseWorkerProcesses("", new Set())).toEqual([]);
    expect(parseWorkerProcesses("  PID COMMAND", new Set())).toEqual([]);
  });
});

describe("listExternalWorkers", () => {
  // parseWorkerProcesses의 테스트는 ourPids를 손으로 받으므로 **그 집합을 누가 어떻게
  // 채우는지**는 검증하지 않는다. 그 채우는 두 줄이 여기 있고, 여기서 잠근다 — 한 줄만
  // 빠져도 앱은 자기가 방금 띄운 worker를 "외부 worker"로 보고 스스로 서서(§6.5의
  // stand-down) worker를 영영 띄우지 않는다 (P2-C6).

  it("does not report the worker we launched ourselves — the root pid included", async () => {
    // Phase 4의 번들 런타임처럼 root 자신이 python supervisor 줄인 경우. descendants는
    // 비어 있으므로 root를 ours에 직접 넣지 않으면 우리 자신이 외부 worker가 된다.
    const out = await listExternalWorkers({
      ps: async () => PS_APP_OWNED,
      ownPid: () => 5001,
      descendants: async () => new Set<number>(),
    });
    expect(out).toEqual([]);
  });

  it("does not report a supervisor that is a descendant of our launcher", async () => {
    // 지금의 기본 모양: root는 uv(4103)이고 진짜 supervisor(4101)는 그 자손이다.
    const out = await listExternalWorkers({
      ps: async () => PS,
      ownPid: () => 4103,
      descendants: async (root) => (root === 4103 ? new Set([4101]) : new Set<number>()),
    });
    expect(out).toEqual([]);
  });

  it("reports the external supervisor when we have not launched one", async () => {
    let asked = 0;
    const out = await listExternalWorkers({
      ps: async () => PS,
      ownPid: () => undefined,
      descendants: async () => {
        asked += 1;
        return new Set<number>();
      },
    });
    expect(out).toEqual([4101]);
    // 띄운 적이 없으면 자손을 물을 대상도 없다 — ps를 한 번 더 도는 값을 낭비하지 않는다.
    expect(asked).toBe(0);
  });

  it("still reports a stranger while our own worker runs", async () => {
    const out = await listExternalWorkers({
      ps: async () => `${PS_APP_OWNED}\n 4101 /usr/bin/python3 -m damwha_worker`,
      ownPid: () => 5001,
      descendants: async () => new Set<number>(),
    });
    expect(out).toEqual([4101]);
  });
});

describe("probeEmbedContract", () => {
  const want = { model: "BAAI/bge-m3", dimension: 1024 };

  it("matches when model and dimension agree", async () => {
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => ({
      status: 200,
      json: async () => ({ model: "BAAI/bge-m3", dimension: 1024, vectors: [[0.1]] }),
    }));
    expect(r.kind).toBe("match");
  });

  it("reports a mismatched model instead of adopting it", async () => {
    // /health는 {"status":"ok"}만 돌려주므로 다른 모델도 200을 준다 (embed_service.py:24-25).
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => ({
      status: 200,
      json: async () => ({ model: "other/model", dimension: 1024, vectors: [[0.1]] }),
    }));
    expect(r.kind).toBe("mismatch");
    expect(r.kind === "mismatch" && r.detail).toContain("other/model");
  });

  it("reports a mismatched dimension", async () => {
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => ({
      status: 200,
      json: async () => ({ model: "BAAI/bge-m3", dimension: 768, vectors: [[0.1]] }),
    }));
    expect(r.kind).toBe("mismatch");
    expect(r.kind === "mismatch" && r.detail).toContain("768");
  });

  it("treats a refused connection as absent", async () => {
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(r.kind).toBe("absent");
  });

  it("treats a non-200 as absent", async () => {
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => ({
      status: 503,
      json: async () => ({}),
    }));
    expect(r.kind).toBe("absent");
  });

  it("treats unparseable JSON as absent rather than throwing", async () => {
    const r = await probeEmbedContract("http://127.0.0.1:8100", want, async () => ({
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }));
    expect(r.kind).toBe("absent");
  });

  it("returns absent instead of hanging when the request never settles", async () => {
    // AbortController만으로는 못 막는 경우다 — signal을 보지 않는 상대는 abort해도 안 끝난다.
    // 여기서 매달리면 기동 순서 전체가 멈춰 앱이 아무 서비스도 못 띄운다.
    const r = await probeEmbedContract(
      "http://127.0.0.1:8100",
      want,
      () => new Promise<never>(() => {}),
      10,
    );
    expect(r.kind).toBe("absent");
  });

  it("returns absent instead of hanging when the body never arrives", async () => {
    // 헤더는 200으로 왔지만 본문이 안 오는 경우. res.json()에서 매달린다.
    const r = await probeEmbedContract(
      "http://127.0.0.1:8100",
      want,
      async () => ({ status: 200, json: () => new Promise<never>(() => {}) }),
      10,
    );
    expect(r.kind).toBe("absent");
  });

  it("aborts the signal it handed the fetch when the timeout fires, and not otherwise", async () => {
    // 매달림 안전성은 두 가지에 기대고 있다: (1) 내부 경주가 우리 쪽 판정을 끝내는 것,
    // (2) 전역 fetch가 AbortSignal을 지켜 실제 요청을 정리하는 것. 주입한 fake로 (2)를
    // 증명할 수는 없다 — 그건 Node의 몫이다. 대신 증명할 수 있는 우리 쪽 계약을 고정한다:
    // 타임아웃이 울린 시점에 우리가 넘긴 signal이 abort되어 있어야 한다. 그러지 않으면
    // 경주만 이기고 요청은 그대로 떠 있어, 매 프로브가 소켓을 하나씩 남긴다.
    let captured: AbortSignal | undefined;
    const timedOut = await probeEmbedContract(
      "http://127.0.0.1:8100",
      want,
      (_url, init) => {
        captured = init.signal;
        return new Promise<never>(() => {});
      },
      10,
    );
    expect(timedOut.kind).toBe("absent");
    expect(captured?.aborted).toBe(true);

    // 성공 경로에서는 abort하지 않는다 — 이걸 같이 못 박지 않으면 위 단정이 공허해진다
    // (늘 abort된 signal을 넘겨도 통과하니까). finally의 clearTimeout이 이걸 보장한다.
    let onSuccess: AbortSignal | undefined;
    const matched = await probeEmbedContract("http://127.0.0.1:8100", want, async (_url, init) => {
      onSuccess = init.signal;
      return { status: 200, json: async () => ({ model: want.model, dimension: want.dimension }) };
    });
    expect(matched.kind).toBe("match");
    expect(onSuccess?.aborted).toBe(false);
  });
});
