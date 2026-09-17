import { describe, expect, it } from "vitest";
import { hasOnceChild, listExternalWorkers, parseWorkerProcesses } from "../../src/services/worker-discovery";

// 2026-09-12 실측한 다섯 가지 모양을 한 fixture에 모았다. 첫 줄(4101)만 supervisor다.
// 4102/4103이 핵심이다 — 둘 다 `-m damwha_worker`를 인자로 그대로 갖고 있고, 4103이
// **Phase 2의 앱이 자기 worker를 띄울 때 나오던 기본 모양**이다(탐색으로 찾은 uv의 절대
// 경로로 spawn했다). 문자열 필터로는 못 거른다.
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
    // 이 함수는 우리 것/남의 것을 pid 집합으로만 가른다. process-tree.ts의 descendantPids(root)는
    // root를 반환값에 넣지 않으므로 호출부가 root를 손수 합쳐야 한다 —
    // verifyOwnListener가 own-listener.ts에서 하는 것과 같다. 그 의무를 여기서 못 박는다.
    expect(parseWorkerProcesses(PS_APP_OWNED, new Set())).toEqual([5001]);
    expect(parseWorkerProcesses(PS_APP_OWNED, new Set([5001]))).toEqual([]);
    expect(parseWorkerProcesses(PS, new Set([4101]))).toEqual([]);
  });

  it("returns nothing for empty or header-only input", () => {
    expect(parseWorkerProcesses("", new Set())).toEqual([]);
    expect(parseWorkerProcesses("  PID COMMAND", new Set())).toEqual([]);
  });

  // Phase 4 스펙 §6.5 — ps의 args는 argv를 공백으로 이은 평탄한 문자열이다. Task 5 뒤로 앱 worker의 argv[0]은
  // 번들 python의 절대 경로라, 공백이 든 설치 경로에서 `split(/\s+/)`는 argv[0]을 `/Users/me/My`로 잘랐고
  // 이 판정은 **항상 거짓**이었다 — 고아·외부 worker 탐지가 조용히 빠졌다.
  const SPACED = "/Users/me/My Apps/Damwha.app/Contents/Resources/python/bin/python3.12";

  it("finds a supervisor under an install path with spaces, cutting the known interpreter first", () => {
    const ps = `  PID ARGS\n 8101 ${SPACED} -m damwha_worker --run-id=desktop-x`;
    expect(parseWorkerProcesses(ps, new Set(), [SPACED])).toEqual([8101]);
    const dashed = "/Users/me/Apps - Work/Damwha.app/Contents/Resources/python/bin/python3.12";
    const dashedPs = `  PID ARGS\n 8103 ${dashed} -m damwha_worker --run-id=desktop-x`;
    expect(parseWorkerProcesses(dashedPs, new Set(), [dashed])).toEqual([8103]);
    expect(parseWorkerProcesses(dashedPs, new Set())).toEqual([]);
    // 이 소비자는 run-id를 요구하지 않는다 — "앱이 아닌 worker가 도는가"를 묻는다.
    expect(parseWorkerProcesses(`  PID ARGS\n 8102 ${SPACED} -m damwha_worker`, new Set(), [SPACED])).toEqual([8102]);
  });

  it("finds a spaced supervisor it has no prefix for, and still skips its --once child", () => {
    const venv = "/Users/me/My Projects/daewha/be/worker/.venv/bin/python3";
    const ps = [
      "  PID ARGS",
      ` 8201 ${venv} -m damwha_worker`,
      ` 8202 ${venv} -m damwha_worker --once`,
      ` 8203 ${SPACED} -m damwha_worker --once --run-id=desktop-x`,
    ].join("\n");
    expect(parseWorkerProcesses(ps, new Set(), [SPACED])).toEqual([8201]);
  });

  it("does not let the spaced-path reading turn a shell or grep line into a supervisor", () => {
    const ps = [
      "  PID ARGS",
      ` 8301 /bin/zsh -c ${SPACED} -m damwha_worker`,
      " 8302 /bin/zsh -c /usr/bin/python3 -m damwha_worker",
      " 8303 /usr/bin/grep /usr/bin/python3 -m damwha_worker",
      " 8305 /bin/zsh -c .venv/bin/python -m damwha_worker",
      ` 8304 /usr/bin/grep ${SPACED} -m damwha_worker`,
    ].join("\n");
    expect(parseWorkerProcesses(ps, new Set(), [SPACED])).toEqual([]);
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
      interpreters: [],
    });
    expect(out).toEqual([]);
  });

  it("does not report a supervisor that is a descendant of our launcher", async () => {
    // 지금의 기본 모양: root는 uv(4103)이고 진짜 supervisor(4101)는 그 자손이다.
    const out = await listExternalWorkers({
      ps: async () => PS,
      ownPid: () => 4103,
      descendants: async (root) => (root === 4103 ? new Set([4101]) : new Set<number>()),
      interpreters: [],
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
      interpreters: [],
    });
    expect(out).toEqual([4101]);
    // 띄운 적이 없으면 자손을 물을 대상도 없다 — ps를 한 번 더 도는 값을 낭비하지 않는다.
    expect(asked).toBe(0);
  });

  it("reads the scan with the interpreters it is given — a spaced install path is found", async () => {
    // ` -`가 든 폴더 이름이라 ` -m ` 앞을 읽는 추측은 거부한다 — 아는 인터프리터를 넘겨야만 읽힌다.
    const spaced = "/Users/me/Apps - Work/Damwha.app/Contents/Resources/python/bin/python3.12";
    const out = await listExternalWorkers({
      ps: async () => `  PID ARGS\n 8401 ${spaced} -m damwha_worker --run-id=desktop-old`,
      ownPid: () => undefined,
      descendants: async () => new Set<number>(),
      interpreters: [spaced],
    });
    expect(out).toEqual([8401]);
  });

  it("still reports a stranger while our own worker runs", async () => {
    const out = await listExternalWorkers({
      ps: async () => `${PS_APP_OWNED}\n 4101 /usr/bin/python3 -m damwha_worker`,
      ownPid: () => 5001,
      descendants: async () => new Set<number>(),
      interpreters: [],
    });
    expect(out).toEqual([4101]);
  });
});

describe("hasOnceChild", () => {
  const PS = [
    "  PID COMMAND",
    " 4242 /opt/uv run --directory /r/be/worker python -m damwha_worker",
    " 4243 /opt/uv run python -m damwha_worker --once --job 17",
    " 7777 /opt/uv run python -m damwha_worker --once --job 99",
  ].join("\n");

  it("finds the --once child of our own worker", () => {
    expect(hasOnceChild(PS, new Set([4243]))).toBe(true);
  });

  it("ignores an external worker's --once child", () => {
    // 7777도 --once지만 우리 자손이 아니다. 외부 worker가 하는 일은 우리가 소유하지
    // 않으므로 우리 종료가 확인을 받을 이유가 없다 (스펙 §6.9). tree 검사를 지우면
    // 이 단언이 무너진다 — 우리 트리에는 --once가 하나도 없는데 true가 된다.
    expect(hasOnceChild(PS, new Set([4242]))).toBe(false);
  });

  it("does not match --once inside a longer word", () => {
    // 낱말 경계가 없으면 --once-only나 경로 안의 --once가 걸려, 진행 중이 아닌 종료가
    // 매번 확인을 묻는다.
    const ps = ["  PID COMMAND", " 5150 python -m damwha_worker --once-only"].join("\n");
    expect(hasOnceChild(ps, new Set([5150]))).toBe(false);
  });

  it("survives a header-only or empty listing", () => {
    expect(hasOnceChild("  PID COMMAND", new Set([4243]))).toBe(false);
    expect(hasOnceChild("", new Set([4243]))).toBe(false);
  });
});
