import { describe, expect, it, vi } from "vitest";
import { captureDescendants, STOP_DETAIL, stopWorkerProcess } from "../../src/services/worker-shutdown";

describe("stopWorkerProcess", () => {
  function handle(aliveFor: number) {
    let calls = 0;
    return {
      pid: 4242,
      alive: () => ++calls <= aliveFor,
      stderrTail: () => "",
      exitCode: () => null,
      onExit: () => undefined,
      stop: async () => undefined,
    } as never;
  }

  it("sends SIGTERM exactly once when the worker stops politely", async () => {
    // handle(1)이다. 목의 alive()는 `++calls <= aliveFor`라 handle(0)은 **첫 호출부터**
    // false — 즉 "이미 죽어 있는 핸들"이지 "예의 바르게 멈추는 worker"가 아니다.
    // handle(1)은 진입 시점에 살아 있고 그 다음 확인에서 죽는다. 이 구분이 있어야
    // 진입 가드(pid가 재사용됐을 수 있는 죽은 핸들에 신호를 쏘지 않는다)를 살릴 수 있다.
    const signals: Array<[number, string]> = [];
    const out = await stopWorkerProcess(handle(1), {
      graceMs: 20,
      pollMs: 5,
      signal: (pid, sig) => signals.push([pid, sig]),
      descendants: async () => new Set<number>(),
      onGraceExpired: async () => true,
    });
    // supervisor에게는 정확히 한 번, **supervisor의 pid(양수)** 로 직접 — 전달자가 없어 보낸 수가 곧 받는
    // 수이고, supervisor는 두 번째를 강제로 읽어 --once 자식을 kill한다 (스펙 §6.9 1단계).
    // 뒤의 그룹 신호는 supervisor가 **끝난 뒤** 같은 그룹의 남은 자식을 거두는 것이라 받을 supervisor가
    // 없다 — 순서 자체는 아래 "reaps the supervisor's process group only after…" 두 테스트가 잠근다.
    expect(signals).toEqual([
      [4242, "SIGTERM"],
      [-4242, "SIGTERM"],
    ]);
    expect(out).toEqual({ stopped: true, leaked: [] });
  });

  it("reaps the supervisor's process group only after the supervisor has exited — never while it is alive (after stage 1)", async () => {
    // 살아 있는 supervisor의 그룹에는 그것이 아직 관리하는 짧은 자식(capabilities 프로브)이 있다 — 그것을
    // 거두는 자리는 supervisor가 끝난 뒤뿐이다(worker-shutdown.ts 1단계 주석; uv 런처 시절에는 이것이 곧
    // I-1의 이중 배달이기도 했다). 그래서 신호마다 **그 순간** 루트가 살아 있었는지를 함께 적는다.
    // 루트는 supervisor pid에 SIGTERM을 받은 뒤 다음 틱에 끝난다.
    let exited = false;
    const events: Array<[number, string, boolean]> = [];
    const out = await stopWorkerProcess(
      {
        pid: 4242,
        alive: () => !exited,
        stderrTail: () => "",
        exitCode: () => null,
        onExit: () => undefined,
        stop: async () => undefined,
      } as never,
      {
        graceMs: 50,
        pollMs: 5,
        signal: (target, sig) => {
          events.push([target, sig, !exited]);
          if (target === 4242 && sig === "SIGTERM") setTimeout(() => (exited = true), 1);
        },
        descendants: async () => new Set<number>(),
        onGraceExpired: async () => true,
      },
    );
    expect(events).toEqual([
      [4242, "SIGTERM", true],
      [-4242, "SIGTERM", false],
    ]);
    expect(out).toEqual({ stopped: true, leaked: [] });
  });

  it("reaps the supervisor's process group only after the supervisor has exited — never while it is alive (after the forced stage 3)", async () => {
    let exited = false;
    let terms = 0;
    const events: Array<[number, string, boolean]> = [];
    await stopWorkerProcess(
      {
        pid: 4242,
        alive: () => !exited,
        stderrTail: () => "",
        exitCode: () => null,
        onExit: () => undefined,
        stop: async () => undefined,
      } as never,
      {
        graceMs: 10,
        pollMs: 5,
        signal: (target, sig) => {
          events.push([target, sig, !exited]);
          // 첫 SIGTERM은 버틴다(job이 stage boundary에 못 닿았다). 사람이 강제를 고른 두 번째에 끝난다.
          if (target === 4242 && sig === "SIGTERM" && ++terms === 2) setTimeout(() => (exited = true), 1);
        },
        descendants: async () => new Set<number>(),
        onGraceExpired: async () => true,
        maxWaits: 4,
      },
    );
    expect(events).toEqual([
      [4242, "SIGTERM", true],
      [4242, "SIGTERM", true],
      [-4242, "SIGTERM", false],
    ]);
  });

  for (const [answer, label] of [
    [true, "the user chose to force"],
    [false, "the user chose to keep waiting"],
  ] as const) {
    it(`sends no signal at all when the supervisor died while the grace dialog was open — ${label}`, async () => {
      // 대화상자는 상한이 없다. 그 사이 루트가 끝났으면 그룹 신호의 "폴 한 번 안" 근거도, 3단계
      // SIGTERM을 받을 사람도 없다(최종 재리뷰 I-A). 신호마다 그 순간의 생존을 적어, 묻고 난 뒤에는
      // 어떤 신호도 나가지 않았음을 본다. 찍어 둔 자손이 살아 있으면 그것은 여전히 보고한다.
      let exited = false;
      let asked = false;
      const events: Array<[number, string, boolean, boolean]> = [];
      const out = await stopWorkerProcess(
        {
          pid: 4242,
          alive: () => !exited,
          stderrTail: () => "",
          exitCode: () => null,
          onExit: () => undefined,
          stop: async () => undefined,
        } as never,
        {
          graceMs: 10,
          pollMs: 5,
          maxWaits: 2,
          signal: (target, sig) => events.push([target, sig, !exited, asked]),
          descendants: async () => new Set([5001]),
          stillAlive: async (pids) => pids.filter((p) => p === 5001),
          onGraceExpired: async () => {
            asked = true;
            // 사람이 대화상자를 보고 있는 동안 supervisor가 스스로 끝난다.
            exited = true;
            await new Promise((r) => setTimeout(r, 20));
            return answer;
          },
        },
      );
      expect(events.filter(([, , , afterAsk]) => afterAsk)).toEqual([]);
      expect(events).toEqual([[4242, "SIGTERM", true, false]]);
      expect(out.stopped).toBe(false);
      expect(out.leaked).toEqual([5001]);
    });
  }

  it("does not report a same-group leftover (the capabilities probe) as leaked once the group is reaped, and gives the signal time to land", async () => {
    // capabilities.probe_mps는 supervisor가 start_new_session 없이 subprocess.run으로 띄운다 — supervisor
    // 그룹의 구성원이다. 1단계가 supervisor pid로만 보내므로 그것은 신호를 받지 않고 supervisor보다 오래
    // 산다(장난감 실측 1/1). 기동 직후 ⌘Q가 그 pid를 누수로 보고하면 P2-C4("남은 프로세스 0개")가 깨진다.
    //
    // 가짜의 생존 답은 실측을 따른다: 그룹 신호 **직후**의 확인에서는 아직 보이고(5/5), 그다음 확인에서
    // 사라진다(200ms 안, 5/5). 그래서 이 테스트는 두 가지를 함께 잠근다 — 그룹 신호가 나가는가, 그리고
    // 판정이 신호 직후 한 번만 보고 끝나지 않는가.
    let exited = false;
    let reaped = false;
    let checksAfterReap = 0;
    const out = await stopWorkerProcess(
      {
        pid: 4242,
        alive: () => !exited,
        stderrTail: () => "",
        exitCode: () => null,
        onExit: () => undefined,
        stop: async () => undefined,
      } as never,
      {
        graceMs: 50,
        pollMs: 5,
        signal: (target, sig) => {
          if (target === 4242 && sig === "SIGTERM") setTimeout(() => (exited = true), 1);
          if (target === -4242 && sig === "SIGTERM") reaped = true;
        },
        // supervisor가 살아 있을 때 찍힌 자손 — 같은 그룹의 프로브 하나.
        descendants: async () => new Set([5001]),
        onGraceExpired: async () => true,
        stillAlive: async (pids) => {
          if (!reaped) return pids;
          checksAfterReap += 1;
          return checksAfterReap === 1 ? pids : [];
        },
      },
    );
    expect(out).toEqual({ stopped: true, leaked: [] });
  });

  it("reaps the capabilities probe only through the group SIGTERM after the supervisor exits — nothing else can find it (P4-C17)", async () => {
    // 작은 커널 모형. launchPython의 `detached: true`로 supervisor(4242)가 그룹 리더이고(pgid 4242),
    // capabilities 프로브(5001)는 supervisor가 start_new_session 없이 띄워 같은 그룹이다. --once 자식(6001)은
    // start_new_session이라 자기 그룹(6001)이다 — 이 테스트에서는 job이 없어 이미 끝났다고 둔다.
    //
    // 프로브는 `[sys.executable, "-c", …]`라 `-m` 토큰도 `--run-id`도 없다. 스펙 §6.5의 argv 표식으로 훑는
    // 고아 정리(Task 7)도 앱 종료 회수(Task 8, "내 run-id만")도 그것을 보지 못한다 — 회수가 이 한 경로뿐이다.
    // cleanUnlessOrphans의 `opts.signal(-pid, "SIGTERM")`를 지우면 프로브가 살아남아 이 테스트가 깨진다.
    const pgid = new Map<number, number>([
      [4242, 4242],
      [5001, 4242],
    ]);
    const alive = new Set<number>([4242, 5001]);
    const sent: Array<[number, string]> = [];
    const received: Array<[number, string]> = [];
    const signal = (target: number, sig: NodeJS.Signals) => {
      sent.push([target, sig]);
      const members = target < 0 ? [...alive].filter((p) => pgid.get(p) === -target) : alive.has(target) ? [target] : [];
      for (const p of members) {
        received.push([p, sig]);
        // 받으면 다음 틱에 끝난다(둘 다 SIGTERM에 기본 동작으로 죽는다).
        setTimeout(() => alive.delete(p), 1);
      }
    };
    const out = await stopWorkerProcess(
      {
        pid: 4242,
        alive: () => alive.has(4242),
        stderrTail: () => "",
        exitCode: () => null,
        onExit: () => undefined,
        stop: async () => undefined,
      } as never,
      {
        graceMs: 50,
        pollMs: 5,
        signal,
        // supervisor가 살아 있는 동안의 ppid BFS — 프로브 하나가 보인다.
        descendants: async (root) => new Set([...alive].filter((p) => p !== root)),
        onGraceExpired: async () => true,
        stillAlive: async (pids) => pids.filter((p) => alive.has(p)),
      },
    );
    // 보낸 것: supervisor에 직접 한 번, 끝난 뒤 그 그룹에 한 번. 프로브를 **직접** 겨냥한 신호는 없다.
    expect(sent).toEqual([
      [4242, "SIGTERM"],
      [-4242, "SIGTERM"],
    ]);
    // 받은 것: supervisor는 정확히 한 번(전달자가 없다), 프로브는 그룹 신호로 한 번.
    expect(received).toEqual([
      [4242, "SIGTERM"],
      [5001, "SIGTERM"],
    ]);
    expect(alive.size).toBe(0);
    expect(out).toEqual({ stopped: true, leaked: [] });
  });

  it("never signals a process group while the supervisor is alive — the polite (1) and forced (3) SIGTERMs go to the supervisor pid itself", async () => {
    // supervisor의 핸들러는 받은 SIGTERM을 센다 — 두 번째에서 --once 자식을 proc.kill()하고 os._exit(1)하므로,
    // 한 단계에 두 번 닿으면 "정중한" 1단계가 곧바로 강제가 되고 requeue_for_shutdown을 건너뛴다 (P2-C5).
    // 전달자가 없는 지금 그룹 신호는 supervisor에 한 번만 닿지만, 살아 있는 동안에는 그 그룹의 프로브까지
    // 건드린다. (2026-09-13 uv 런처 실측: `process.kill(-uvPid, "SIGTERM")` 한 번에 핸들러가 두 번 불렸다
    // (5/5) — 커널 한 번, uv 전달 한 번. 전달자가 다시 끼면 이 테스트가 그 회귀도 막는다.)
    //
    // 두 SIGTERM이 모두 나오는 경로(사람이 강제를 고른다)를 끝까지 돌리고, SIGTERM 전부가
    // 핸들의 pid 그 자체로 갔는지를 본다. 음수가 하나라도 있으면 실패한다 — 1단계든 3단계든.
    const signals: Array<[number, string]> = [];
    await stopWorkerProcess(handle(999), {
      graceMs: 10,
      pollMs: 5,
      signal: (pid, sig) => signals.push([pid, sig]),
      descendants: async () => new Set<number>(),
      onGraceExpired: async () => true,
      maxWaits: 2,
      stillAlive: async () => [],
    });
    const terms = signals.filter(([, sig]) => sig === "SIGTERM");
    expect(terms).toEqual([
      [4242, "SIGTERM"],
      [4242, "SIGTERM"],
    ]);
    // 이 경로에서 supervisor는 끝까지 살아 있다(handle(999)) — 4단계까지 가도 그룹 신호는 하나도 없다.
    // 그룹에 보내는 유일한 자리는 supervisor가 끝난 **뒤**다.
    expect(signals.filter(([pid]) => pid < 0)).toEqual([]);
  });

  it("actually waits when the user says 'keep waiting', and asks again", async () => {
    // 버튼이 "계속 기다리기"라고 적혀 있으면 기다려야 한다. 예전에는 false가 "포기한다"라
    // 사용자가 조심스러운 쪽을 골랐는데 앱이 돌고 있는 job을 두고 나가 버렸다.
    // 여기서는 두 번 기다린 뒤 프로세스가 스스로 끝난다 → 대화상자 2회, 깨끗한 종료.
    const signals: Array<[number, string]> = [];
    let asked = 0;
    let alive = true;
    const out = await stopWorkerProcess(
      {
        pid: 4242,
        alive: () => alive,
        stderrTail: () => "",
        exitCode: () => null,
        onExit: () => undefined,
        stop: async () => undefined,
      } as never,
      {
        graceMs: 20,
        pollMs: 5,
        signal: (pid, sig) => signals.push([pid, sig]),
        descendants: async () => new Set<number>(),
        onGraceExpired: async () => {
          asked += 1;
          // 두 번째로 기다리기를 고른 **뒤 그 유예 안에** 프로세스가 끝난다. 대화상자가 떠 있는
          // 동안 끝나게 하면(= 여기서 곧바로 alive=false) 그것은 다른 경우다 — 언제 끝났는지 모르므로
          // 신호를 보내지 않는다(아래 "sends no signal at all when the supervisor died while the grace
          // dialog was open"). 이 픽스처는 원래 그 둘을 구별하지 않았다.
          if (asked === 2) setTimeout(() => (alive = false), 1);
          return false;
        },
        maxWaits: 2,
      },
    );
    expect(asked).toBe(2);
    // 기다리겠다는 답에 두 번째 SIGTERM을 보내면 안 된다 — 그것이 곧 강제(3단계)다. 이 한 번도
    // supervisor의 pid(양수)로 간다. 뒤의 그룹 신호는 supervisor가 스스로 끝난 **뒤**의 거두기라
    // supervisor에게 가는 두 번째 신호가 아니다.
    expect(signals).toEqual([
      [4242, "SIGTERM"],
      [-4242, "SIGTERM"],
    ]);
    expect(out).toEqual({ stopped: true, leaked: [] });
  });

  it("escalates on the round the user finally says 'force now'", async () => {
    const signals: Array<[number, string]> = [];
    let asked = 0;
    const out = await stopWorkerProcess(handle(999), {
      graceMs: 20,
      pollMs: 5,
      signal: (pid, sig) => signals.push([pid, sig]),
      descendants: async () => new Set<number>(),
      onGraceExpired: async () => {
        asked += 1;
        return asked === 2;
      },
      maxWaits: 2,
      stillAlive: async (pids) => pids,
    });
    expect(asked).toBe(2);
    // 1단계 SIGTERM + (기다림) + 3단계 SIGTERM + 4단계 SIGKILL.
    expect(signals.filter(([, sig]) => sig === "SIGTERM")).toHaveLength(2);
    expect(signals.filter(([, sig]) => sig === "SIGKILL").length).toBeGreaterThan(0);
    expect(out.stopped).toBe(false);
  });

  it("gives up instead of waiting forever when there is nobody to ask", async () => {
    // supervisor.ts의 bringOnce는 준비 못 한 자식을 치울 때 {graceMs}만 넘긴다. 그 경로에
    // "다시 묻는다"를 적용하면 아무도 답하지 않는 루프가 되어 기동 정리가 영영 안 끝난다.
    const signals: Array<[number, string]> = [];
    const out = await stopWorkerProcess(handle(999), {
      graceMs: 20,
      pollMs: 5,
      signal: (pid, sig) => signals.push([pid, sig]),
      descendants: async () => new Set<number>(),
      maxWaits: 2,
    });
    expect(signals.filter(([, sig]) => sig === "SIGKILL")).toHaveLength(0);
    expect(out).toEqual({ stopped: false, leaked: [4242], detail: STOP_DETAIL.unattended });
  });

  it("re-snapshots on every wait round, not only the first", async () => {
    // 기다리는 동안에도 시간은 간다 — job마다 새로 뜨는 --once 자식은 한 번 찍은 스냅샷
    // 으로는 안 보인다. 이 줄을 루프 밖으로 빼면 둘째 바퀴부터 새 자식을 놓친다.
    let walks = 0;
    let asked = 0;
    let alive = true;
    await stopWorkerProcess(
      {
        pid: 4242,
        alive: () => alive,
        stderrTail: () => "",
        exitCode: () => null,
        onExit: () => undefined,
        stop: async () => undefined,
      } as never,
      {
        graceMs: 20,
        pollMs: 5,
        signal: () => undefined,
        descendants: async () => {
          walks += 1;
          return new Set<number>();
        },
        onGraceExpired: async () => {
          asked += 1;
          if (asked === 3) alive = false;
          return false;
        },
        maxWaits: 2,
      },
    );
    // 진입 1회 + 대화상자 앞 3회.
    expect(walks).toBe(4);
  });

  it("escalates with a SECOND SIGTERM, not SIGKILL", async () => {
    // supervisor의 2단계 핸들러가 두 번째 SIGTERM에서 자식을 kill하고 os._exit한다.
    // 우리가 곧장 SIGKILL을 보내면 --once 자식과 mlx_lm.server가 고아로 남는다.
    const signals: string[] = [];
    await stopWorkerProcess(handle(999), {
      graceMs: 10,
      pollMs: 5,
      signal: (_pid, sig) => signals.push(sig),
      descendants: async () => new Set<number>(),
      onGraceExpired: async () => true,
      maxWaits: 2,
    });
    expect(signals[0]).toBe("SIGTERM");
    expect(signals[1]).toBe("SIGTERM");
  });

  it("SIGKILLs the tree it just walked, not the snapshots it captured two graces ago", async () => {
    // --once 자식은 start_new_session이라 그룹 kill에 안 잡히지만 부모-자식 관계는
    // 그대로라 ps의 ppid BFS가 찾는다 (스펙 §6.9 4단계).
    //
    // 그리고 4단계는 이 모듈에서 **실제 신호를 보내는 유일한 곳**이고 그 신호가 SIGKILL이다.
    // 그래서 대상이 무엇인지가 다른 어느 단계보다 중요하다: 캡처해 둔 스냅샷들은 이 시점에
    // 유예 두 번만큼 낡았고, 그 사이 끝난 pid를 OS가 재사용했다면 SIGKILL은 **남의
    // 프로세스**로 간다. worker-shutdown.ts의 4단계 주석이 바로 그것을 "세 번째 ps를 도는 이유"로
    // 적어 뒀는데, 세 스냅샷이 늘 같은 집합을 돌려주던 예전 형태로는 "방금 걸은 트리"와
    // "낡은 캡처 집합" 두 의미가 구분되지 않아 대상을 캡처 집합으로 바꿔도 초록불이었다.
    // 호출 순번마다 다른 집합을 돌려줘 그 둘을 갈라놓는다.
    const killed: number[] = [];
    let call = 0;
    await stopWorkerProcess(handle(999), {
      graceMs: 10,
      pollMs: 5,
      signal: (pid, sig) => {
        if (sig === "SIGKILL") killed.push(pid);
      },
      descendants: async () => {
        call += 1;
        if (call === 1) return new Set([5001]); // 진입 스냅샷 — 읽는 데만 쓴다
        if (call === 2) return new Set([5002]); // 유예 직후 재스냅샷 — 역시 읽기 전용
        return new Set([5003, 5004]); // 4단계가 그 자리에서 걸은 트리 — 죽일 대상은 이것뿐
      },
      onGraceExpired: async () => true,
      maxWaits: 2,
      // 여기서 stillAlive를 주는 이유는 단정이 아니라 격리다. 기본 구현은 핸들이 답해 줄 수
      // 없는 자손 pid를 signal 0으로 확인하는데, 5001~5004는 이 기계에 실제로 존재할 수
      // 있는 번호다 — 테스트가 진짜 프로세스를 건드리지 않게 가짜를 주입한다.
      stillAlive: async () => [],
    });
    // 낡은 스냅샷의 pid는 신호를 받지 않는다. 그것들은 "죽었나"를 읽는 데만 쓰인다.
    expect(killed).not.toContain(5001);
    expect(killed).not.toContain(5002);
    // root 자신은 함께 죽인다 — 자손만 죽이면 supervisor가 남는다.
    expect([...killed].sort((a, b) => a - b)).toEqual([4242, 5003, 5004]);
  });

  it("gives a SIGKILLed process time to be reaped instead of reporting it leaked", async () => {
    // SIGKILL은 즉시가 아니라 커널이 그 프로세스를 다음에 깨울 때 반영되고, 그 뒤로도 부모가
    // 거둬들이기 전까지 kill(pid,0)은 성공한다. 폴 한 번 뒤의 스냅샷 하나로 판정하면
    // **거둬지는 중일 뿐인 pid**가 "아직 살아 있을 수 있는 프로세스"로 사람에게 올라간다 —
    // 거짓 누수 보고는 진짜 누수와 똑같은 걱정을 사용자에게 지운다.
    let look = 0;
    const out = await stopWorkerProcess(handle(999), {
      graceMs: 10,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => new Set([6001]),
      onGraceExpired: async () => true,
      maxWaits: 2,
      // handle(999)라 1·3단계 대기가 모두 실패해 cleanUnlessOrphans는 안 탄다 — 아래
      // 호출은 전부 4단계 SIGKILL 뒤의 확인이다. 첫 확인에서는 아직 거둬지지 않았다.
      stillAlive: async (pids) => (++look === 1 ? [...pids] : []),
    });
    expect(look).toBeGreaterThan(1);
    expect(out).toEqual({ stopped: true, leaked: [] });
  });

  it("reports what it could not clean instead of claiming success", async () => {
    const out = await stopWorkerProcess(handle(999), {
      graceMs: 10,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => new Set([5001]),
      onGraceExpired: async () => true,
      maxWaits: 2,
      stillAlive: async () => [4242, 5001],
    });
    expect(out.stopped).toBe(false);
    expect(out.leaked.sort()).toEqual([4242, 5001]);
  });

  // 아래 두 테스트는 brief에는 없다. stillAlive를 주지 않으면 5단계가 handle.alive()만
  // 본다는 기본 경로(JSDoc의 "기본은 handle.alive()만 본다")는 위 테스트들 중 어느 것도
  // 반환값을 확인하지 않는다 — "escalates with a SECOND SIGTERM"과 "finally SIGKILLs..."는
  // signals/killed 배열만 보고 out은 버린다. 그래서 `handle.alive() ? [pid] : []`의 두
  // 갈래를 뒤집어도(mutate) 기존 15개 중 아무것도 빨개지지 않는다 — 직접 확인함(아래 보고).
  it("reports honest success through the default alive-check when the sweep actually finishes it off", async () => {
    // 진입 가드(1콜) + 1단계 대기(2회 폴 + 마지막 확인 = 3콜) + 3단계 대기(같은 모양 = 3콜)
    // 뒤, 4단계 SIGKILL 스윕 직후의 5단계 확인이 정확히 8번째 콜이다. aliveFor=7이면 그
    // 8번째 콜에서 처음으로 false가 나와 "스윕이 방금 끝장냈다"를 흉내 낸다.
    const out = await stopWorkerProcess(handle(7), {
      graceMs: 10,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => new Set<number>(),
      onGraceExpired: async () => true,
      maxWaits: 2,
    });
    expect(out).toEqual({ stopped: true, leaked: [] });
  });

  it("reports honest failure through the default alive-check when nothing kills it", async () => {
    const out = await stopWorkerProcess(handle(999), {
      graceMs: 10,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => new Set<number>(),
      onGraceExpired: async () => true,
      maxWaits: 2,
    });
    expect(out).toEqual({ stopped: false, leaked: [4242], detail: STOP_DETAIL.orphans });
  });

  // Finding 1 (재리뷰): processExists(기본 자손 생존 확인)는 실제 호출자가 쓰는 유일한
  // 경로인데, 자손이 있는 기존 테스트는 전부 stillAlive를 주입해 이 기본 분기를 우회한다.
  // 재리뷰가 실측한 변이 두 종 — (a) process.kill이 안 던질 때의 `return true`를 false로,
  // (b) catch의 `code !== "ESRCH"`를 뒤집어 EPERM(존재하지만 남의 것)을 죽음으로 읽게 —
  // 둘 다 기존 21개 테스트를 초록불로 통과시켰다. 아래 세 테스트가 각각 하나씩 잡는다.
  //
  // (round 2 잔여) 처음 넣은 두 테스트는 전부 "살아 있다" 방향만 단정했다 — try 블록과
  // catch 블록을 통째로 `return true`로 바꿔도(모든 pid가 무조건 살아 있다) 그 두 테스트는
  // 계속 초록불이었다. catch가 "죽었다"(false)를 답하는 것을 강제하는 테스트가 없었기
  // 때문이다. 세 번째 테스트가 그 방향을 잠근다.
  it("treats a real, still-running descendant as alive through the default probe", async () => {
    // 실제 신호를 보내지 않는다 — process.kill(pid, 0)은 신호를 배달하지 않고 존재만
    // 묻는다. 자기 자신의 pid(현재 이 vitest 프로세스)를 자손인 척 주입하면 항상 진짜
    // "살아 있다"를 모형화할 수 있다. 이 경로가 변이 (a)를 잡는다: process.kill이 던지지
    // 않을 때 true 대신 false를 돌려주면 이 pid가 leaked에서 사라진다.
    const out = await stopWorkerProcess(handle(1), {
      graceMs: 20,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => new Set([process.pid]),
      onGraceExpired: async () => {
        throw new Error("1단계에서 끝났으니 물을 일이 없다");
      },
    });
    expect(out).toEqual({ stopped: false, leaked: [process.pid], detail: STOP_DETAIL.orphans });
  });

  it("does not read a permission-denied descendant as dead", async () => {
    // EPERM(존재하지만 남의 프로세스)을 이식성 있게 실제로 재현하기는 어렵다 — 루트로
    // 도는 CI는 아예 안 던진다. process.kill을 흉내 내되, 어떤 pid로도 실제 커널 호출을
    // 하지 않는다(신호 0은 원래도 아무것도 배달하지 않지만, 이 테스트는 그마저도 안 부른다).
    // 이 경로가 변이 (b)를 잡는다: catch의 ESRCH 판정이 뒤집히면 EPERM이 "죽음"으로 읽혀
    // 이 pid가 leaked에서 사라진다.
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("kill EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    try {
      const out = await stopWorkerProcess(handle(1), {
        graceMs: 20,
        pollMs: 5,
        signal: () => undefined,
        descendants: async () => new Set([9999]),
        onGraceExpired: async () => {
          throw new Error("1단계에서 끝났으니 물을 일이 없다");
        },
      });
      expect(out).toEqual({ stopped: false, leaked: [9999], detail: STOP_DETAIL.orphans });
    } finally {
      spy.mockRestore();
    }
  });

  it("treats a genuinely gone descendant as dead through the default probe", async () => {
    // ESRCH(그 pid가 존재하지 않는다)를 흉내 낸다. 위 EPERM 테스트와 대칭이다 — 저건
    // "죽지 않은 것을 죽었다고 하지 않는다"를 지키고, 이건 "죽은 것을 살아 있다고 하지
    // 않는다"를 지킨다. 이 테스트가 없으면 try·catch 두 분기를 통째로 `return true`로
    // 바꿔(모든 pid가 무조건 살아 있다) 위 두 테스트를 그대로 통과시킬 수 있다 — catch가
    // "죽었다"를 답하도록 강제하는 것이 이 함수의 유일한 역할이다.
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    try {
      const out = await stopWorkerProcess(handle(1), {
        graceMs: 20,
        pollMs: 5,
        signal: () => undefined,
        descendants: async () => new Set([9998]),
        onGraceExpired: async () => {
          throw new Error("1단계에서 끝났으니 물을 일이 없다");
        },
      });
      expect(out).toEqual({ stopped: true, leaked: [] });
    } finally {
      spy.mockRestore();
    }
  });

  // 아래 세 테스트는 "supervisor가 스스로 죽었다"는 경우를 본다. 그때 --once 자식과 그
  // 자식이 띄운 mlx_lm.server는 pid 1로 재부모화되어 사후 ppid BFS로는 보이지 않는다 —
  // 그래서 진입 시점에 자손을 한 번 찍어 두지 않으면 이 모듈은 고아를 남겨 두고도
  // {stopped:true, leaked:[]}를 보고한다. 정확히 이 설계가 막으려던 것이다.
  it("does not call it clean when a descendant captured at entry outlives stage 1", async () => {
    const alive = new Set([5001]);
    const out = await stopWorkerProcess(handle(1), {
      graceMs: 20,
      pollMs: 5,
      signal: () => undefined,
      // supervisor가 살아 있는 진입 시점에만 이 자식이 보인다. 1단계 대기 중 supervisor가
      // 스스로 죽으면(handle(1)) 그 뒤의 BFS는 빈 집합을 돌려준다.
      descendants: async () => new Set([5001]),
      onGraceExpired: async () => {
        throw new Error("1단계에서 끝났으니 물을 일이 없다");
      },
      stillAlive: async (pids) => pids.filter((p) => alive.has(p)),
    });
    expect(out).toEqual({ stopped: false, leaked: [5001], detail: STOP_DETAIL.orphans });
  });

  it("does not call it clean when a descendant captured at entry outlives stage 3", async () => {
    // 진입 가드 1콜 + 1단계 대기 3콜 = 4콜까지 살아 있다가, 3단계 첫 확인(5번째 콜)에서
    // 죽는다 — supervisor는 두 번째 SIGTERM 뒤 사라졌는데 자식은 남은 모양이다.
    const alive = new Set([5001]);
    const out = await stopWorkerProcess(handle(4), {
      graceMs: 20,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => new Set([5001]),
      onGraceExpired: async () => true,
      maxWaits: 2,
      stillAlive: async (pids) => pids.filter((p) => alive.has(p)),
    });
    expect(out).toEqual({ stopped: false, leaked: [5001], detail: STOP_DETAIL.orphans });
  });

  it("catches a descendant that appears only in the re-snapshot taken when the grace expires", async () => {
    // worker의 --once 자식은 job마다 새로 뜬다. 진입 스냅샷 이후, 1단계 유예가 지날 때까지
    // 새로 뜬 자식은 진입 스냅샷 하나만으로는 안 보인다. handle(4)는 강제 단계의 두 번째
    // SIGTERM 직후 죽으므로 cleanUnlessOrphans가 참고하는 것은 "지금까지 찍어 둔
    // 스냅샷들"뿐이다 — 그 자손이 stage 4의 사후 BFS에 잡힐 기회조차 없다. 유예 직후
    // 재스냅샷이 없으면 이 경우는 {stopped:true, leaked:[]}로 뭉개진다 — 정확히 이
    // 테스트가 지키는 것이다.
    const alive = new Set([6001]);
    let call = 0;
    const out = await stopWorkerProcess(handle(4), {
      graceMs: 20,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => {
        call += 1;
        // 1번째 호출(진입 스냅샷)에는 아직 없다. 2번째 호출(유예 직후 재스냅샷)부터
        // 보인다.
        return call === 1 ? new Set<number>() : new Set([6001]);
      },
      onGraceExpired: async () => true,
      maxWaits: 2,
      stillAlive: async (pids) => pids.filter((p) => alive.has(p)),
    });
    expect(out).toEqual({ stopped: false, leaked: [6001], detail: STOP_DETAIL.orphans });
  });

  it("still reports a clean stop when the captured descendants went with it", async () => {
    // 같은 경로인데 자손도 같이 죽은 경우. 스냅샷 확인이 늘 leaked를 만들어 내면
    // 평범한 종료마다 거짓 경고가 뜬다 — leaked는 사람에게 보여 주는 값이라 그러면 안 된다.
    const out = await stopWorkerProcess(handle(1), {
      graceMs: 20,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => new Set([5001]),
      onGraceExpired: async () => true,
      stillAlive: async () => [],
    });
    expect(out).toEqual({ stopped: true, leaked: [] });
  });

  // Finding 3 (재리뷰, 이월): opts.descendants(pid).catch(() => new Set())가 열거 실패를
  // "자손 없음"으로 뭉개면 그 뒤로 이 모듈은 "깨끗하다"고 보고한다 — main.ts의
  // verifyOwnListener가 소유를 증명 못 할 때 "아니오"로 닫는 것과 정반대 방향의 편향이다.
  // 아래 두 테스트는 각각 진입 스냅샷과 유예 직후 재스냅샷이 실패하는 경우를 본다.
  it("does not report clean when the entry snapshot could not be taken", async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    try {
      const out = await stopWorkerProcess(handle(1), {
        graceMs: 20,
        pollMs: 5,
        signal: () => undefined,
        descendants: async () => {
          throw new Error("ps 실패");
        },
        onGraceExpired: async () => {
          throw new Error("1단계에서 끝났으니 물을 일이 없다");
        },
      });
      // leaked는 비어 있다 — 어떤 pid가 남았는지조차 모른다. 그래도 stopped는 false다:
      // "확인 못 했다"를 "깨끗했다"로 보고하지 않는다.
      expect(out).toEqual({ stopped: false, leaked: [], detail: STOP_DETAIL.unverifiable });
      // 기본 싱크는 console.error다 — 이 자리에 프로덕션 로그를 꽂는 것은 아래 log 테스트가 본다.
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not report clean when the re-snapshot at grace expiry could not be taken", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let call = 0;
      const out = await stopWorkerProcess(handle(4), {
        graceMs: 20,
        pollMs: 5,
        signal: () => undefined,
        descendants: async () => {
          call += 1;
          // 진입 스냅샷(1번째)은 정상이다. 유예 직후 재스냅샷(2번째)만 실패한다.
          if (call === 2) throw new Error("ps 실패");
          return new Set<number>();
        },
        onGraceExpired: async () => true,
        maxWaits: 2,
      });
      expect(out).toEqual({ stopped: false, leaked: [], detail: STOP_DETAIL.unverifiable });
    } finally {
      spy.mockRestore();
    }
  });

  it("does not report clean when the pre-SIGKILL tree walk (stage 4) could not be taken", async () => {
    // 앞의 두 테스트는 cleanUnlessOrphans(1·3단계 조기 반환) 경로만 태운다. 5단계 최종
    // 반환에도 같은 snapshotFailed 가드가 있는데, 그 갈래를 지워도 위 두 테스트는 계속
    // 초록불이다(cleanUnlessOrphans까지도 안 간다) — 이 테스트가 그 갈래를 직접 태운다.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let call = 0;
      const out = await stopWorkerProcess(handle(999), {
        graceMs: 10,
        pollMs: 5,
        signal: () => undefined,
        descendants: async () => {
          call += 1;
          // 진입(1번째)·유예 직후(2번째) 스냅샷은 정상이다. 4단계의 재확인용 트리
          // 걷기(3번째)만 실패한다.
          if (call === 3) throw new Error("ps 실패");
          return new Set<number>();
        },
        onGraceExpired: async () => true,
        maxWaits: 2,
        // 진짜 생존 여부와 무관하게 "아무것도 안 남았다"로 고정한다 — 실패했는데도
        // stopped:true가 나온다면 그건 순전히 5단계 가드가 빠졌기 때문이어야 한다.
        stillAlive: async () => [],
      });
      expect(out).toEqual({ stopped: false, leaked: [], detail: STOP_DETAIL.unverifiable });
    } finally {
      spy.mockRestore();
    }
  });

  // 재리뷰 2 (변이 12종 중 8종 생존): 아래 넷은 프로덕션 코드가 아니라 **테스트가 지키지
  // 못하던 성질**을 잠근다. 공통 원인은 이 프로젝트에서 반복된 한 가지다 — 주입 씨앗을
  // 만들고 전부 가짜를 주입하는데, 그 가짜가 **인자를 안 읽고 호출됐다는 사실도 기록하지
  // 않아** 프로덕션이 무엇을·언제 물었는지 아무도 관측하지 못한다.

  it("keeps a failed early snapshot sticky all the way to the stage-5 verdict", async () => {
    // snapshotFailed가 sticky해야만 의미가 있는 유일한 조합: **앞에서 실패하고 뒤에서
    // 성공한다.** 기존 세 실패 테스트는 실패 지점이 곧 반환 지점이라(1·3단계 조기 반환,
    // 또는 5단계 직전) 이 조합을 한 번도 안 태웠고, 4단계 직전에 `snapshotFailed = false;`
    // 한 줄을 넣어도 28개가 전부 초록불이었다.
    //
    // 프로덕션 시나리오: 진입 ps가 1초 상한에 걸려 실패한다 → 우리는 진입 시점 자손을
    // 영영 모른다 → worker가 1·3단계를 버텨 사람이 강제를 고른다 → 4단계 트리 걷기는
    // 성공한다 → 재부모화된 고아가 있어도 5단계가 {stopped:true, leaked:[]}를 보고한다.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let call = 0;
      const out = await stopWorkerProcess(handle(999), {
        graceMs: 10,
        pollMs: 5,
        signal: () => undefined,
        descendants: async () => {
          call += 1;
          // 진입 스냅샷(1번째)만 실패한다. 그 뒤 재스냅샷·4단계 트리 걷기는 정상이다.
          if (call === 1) throw new Error("ps 타임아웃");
          return new Set<number>();
        },
        onGraceExpired: async () => true,
        maxWaits: 2,
        // 진짜 생존은 "아무것도 안 남았다"로 고정한다 — stopped가 false여야 하는 이유가
        // 오직 "진입 때 확인을 못 했다"이기 위해서다.
        stillAlive: async () => [],
      });
      expect(out).toEqual({ stopped: false, leaked: [], detail: STOP_DETAIL.unverifiable });
    } finally {
      spy.mockRestore();
    }
  });

  it("hands the captured descendants to the stage-5 survivor check, not just the root pid", async () => {
    // round 1이 고친 버그("진입 때 우리 자손이었는데 BFS에서 사라진 프로세스를 5단계
    // 후보에 넣는다")를 되돌리는 변이 `const candidates = [pid];`가 28개를 전부 통과했다.
    // 원인은 5단계까지 가는 기존 두 테스트가 **인자를 안 읽는** stillAlive를 주입해
    // 후보 목록이 가짜의 입력으로만 쓰이고 버려지기 때문이다. 여기서는 건네받은 목록을
    // 그대로 기록해서 단정한다.
    const seen: number[][] = [];
    // 입력만이 아니라 **나온 것**도 적는다. 좁히기를 지키는 유일한 방법이다 — 입력만 보면
    // "매 바퀴 전체 후보로 되돌아간다"는 변이도 seen[0]의 부분집합이라 통과한다.
    const returned: number[][] = [];
    const alive = new Set([5001]);
    let call = 0;
    const out = await stopWorkerProcess(handle(999), {
      graceMs: 10,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => {
        call += 1;
        // supervisor가 살아 있는 진입 시점에만 보인다. 그 뒤 부모를 잃고 pid 1로
        // 재부모화되면 이후 ppid BFS에는 영영 안 나온다.
        return call === 1 ? new Set([5001]) : new Set<number>();
      },
      onGraceExpired: async () => true,
      maxWaits: 2,
      stillAlive: async (pids) => {
        seen.push([...pids]);
        const left = pids.filter((p) => alive.has(p));
        returned.push([...left]);
        return left;
      },
    });
    // handle(999)라 1·3단계 대기가 모두 실패하고 cleanUnlessOrphans는 안 탄다 — 여기
    // 보이는 호출은 전부 5단계의 것이다. 5단계는 SIGKILL 직후 한 번만 보지 않고 상한을 둔
    // 재확인을 돌리므로(거둬지는 중인 pid를 누수로 보고하지 않기 위해서다) 여러 번 나올 수
    // 있다. 판정 대상은 **첫 확인이 무엇을 받았는가**다 — 그 목록에 캡처 집합이 없으면
    // 진입 때만 보였던 고아는 영영 확인되지 않는다.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain(5001);
    expect(seen[0]).toContain(4242);
    // 재확인은 **직전 확인에서 살아 있던 것만** 다시 묻는다. 한 번 죽은 것으로 읽힌 pid를
    // 다시 묻지 않으므로, 그 사이 OS가 그 번호를 재사용해도 남의 프로세스를 누수로 올리지
    // 않는다.
    //
    // `seen[0]`과 비교하면 안 된다 — seen[0]은 **전체 후보 합집합**이라 어떤 후속 호출도
    // 자기 자신의 부분집합이고, 매 바퀴 그 합집합으로 되돌아가는 변이까지 통과한다.
    // 지켜야 하는 성질은 부분집합이 아니라 **등식**이다: i번째 확인의 입력 = (i-1)번째
    // 확인이 살아 있다고 답한 것 그 자체.
    expect(seen.length).toBeGreaterThan(1);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toEqual(returned[i - 1]);
    // 그리고 그 목록은 실제로 좁혀진다 — 좁혀지지 않는 픽스처였다면 위 등식은 공허하다.
    expect(seen[0].length).toBeGreaterThan(seen[1].length);
    expect(out).toEqual({ stopped: false, leaked: [5001], detail: STOP_DETAIL.orphans });
  });

  it("unions the entry snapshot with the re-snapshot instead of replacing it", async () => {
    // 합집합을 덮어쓰기로 바꿔도 28개가 전부 초록불이었다 — 기존 테스트들은 두 스냅샷이
    // 같은 값을 돌려주거나 진입이 비어 있어 두 의미가 구분되지 않았다.
    //
    // §6.9가 이 모듈을 만든 이유가 정확히 이 경우다: 진입 때 자손이던 --once 자식 A가
    // job을 마치고 종료하면 A가 띄운 mlx_lm.server는 pid 1로 재부모화되어 재스냅샷의
    // BFS에는 안 보인다. 덮어쓰기면 A는 캡처 집합에서 사라지고, A가 살아남아도
    // "깨끗함"으로 보고된다.
    const seen: number[][] = [];
    const alive = new Set([7001]);
    let call = 0;
    const out = await stopWorkerProcess(handle(999), {
      graceMs: 10,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => {
        call += 1;
        if (call === 1) return new Set([7001]); // 진입 스냅샷에만 보인다
        if (call === 2) return new Set([7002]); // 재스냅샷에만 보인다
        return new Set<number>(); // 4단계 사후 BFS에는 둘 다 없다
      },
      onGraceExpired: async () => true,
      maxWaits: 2,
      stillAlive: async (pids) => {
        seen.push([...pids]);
        return pids.filter((p) => alive.has(p));
      },
    });
    // 두 스냅샷에 한 번씩만 나타난 pid가 **둘 다** 생존 확인에 도달해야 한다.
    expect(seen[0]).toContain(7001);
    expect(seen[0]).toContain(7002);
    expect(out).toEqual({ stopped: false, leaked: [7001], detail: STOP_DETAIL.orphans });
  });

  it("walks from the positive root pid, and snapshots at the two moments the design depends on", async () => {
    // descendants 가짜가 전부 인자 없는 `async () =>`라, (a) 어떤 루트로 걷는지와
    // (b) signal 호출들과의 상대 순서를 아무도 보지 않았다. 그래서
    // `opts.descendants(pid)` → `opts.descendants(-pid)` 한 글자 오타가 28개를 통과했다
    // — 프로덕션의 descendantPids는 ps의 ppid 행을 BFS하므로 -pid로는 어떤 행도 매치되지
    // 않아 **항상 빈 집합**을 돌려준다. 고아 탐지가 통째로, 조용히 죽는다(던지지 않으니
    // snapshotFailed도 안 켜진다). 스냅샷 시점을 옮기는 변이 셋도 마찬가지로 통과했다.
    //
    // 두 가짜를 **하나의 이벤트 배열**에 기록해 루트 인자와 순서를 함께 잠근다.
    const events: Array<[string, ...unknown[]]> = [];
    const out = await stopWorkerProcess(handle(999), {
      graceMs: 10,
      pollMs: 5,
      signal: (target, sig) => events.push(["signal", target, sig]),
      descendants: async (root) => {
        events.push(["descendants", root]);
        return new Set<number>();
      },
      onGraceExpired: async () => {
        events.push(["ask"]);
        return true;
      },
      maxWaits: 2,
      stillAlive: async () => [],
    });

    // (a) BFS의 루트는 언제나 **양수** pid다. 음수는 "프로세스 그룹"이라는 뜻이고
    //     ps의 ppid 열에는 음수가 없다.
    expect(events.filter((e) => e[0] === "descendants").map((e) => e[1])).toEqual([
      4242, 4242, 4242,
    ]);

    const names = events.map((e) => e[0]);
    // (b) 진입 스냅샷은 **첫 SIGTERM보다 먼저**다. 신호를 쏜 뒤에 찍으면 supervisor의
    //     죽음과 경주하게 되고, 지면 재부모화된 자손을 영영 못 본다.
    // (c) 재스냅샷은 **대화상자보다 먼저**다. onGraceExpired는 사람이 답할 때까지 시간
    //     제한 없이 막히므로, 그 뒤에서 찍으면 supervisor 생존이라는 근거가 사라지고
    //     재사용된 pid(=남의 프로세스)를 capturedDescendants에 합칠 수 있다.
    expect(names.slice(0, 4)).toEqual(["descendants", "signal", "descendants", "ask"]);

    // 전체 순서도 함께 못 박는다. 4단계의 세 번째 걷기는 SIGKILL **직전**이어야 한다 —
    // 낡은 스냅샷을 죽이지 않고 그 자리에서 다시 걸은 트리를 죽이는 것이 그 이유다.
    // 두 SIGTERM의 대상은 supervisor의 pid(양수)다 — 살아 있는 동안에는 그룹에 보내지 않는다.
    expect(events).toEqual([
      ["descendants", 4242],
      ["signal", 4242, "SIGTERM"],
      ["descendants", 4242],
      ["ask"],
      ["signal", 4242, "SIGTERM"],
      ["descendants", 4242],
      ["signal", 4242, "SIGKILL"],
    ]);
    expect(out).toEqual({ stopped: true, leaked: [] });
  });

  it("refuses to signal a handle that is already dead at entry", async () => {
    // alive()는 `code === null`이라 자식이 끝나고 Node가 거둬들인 뒤에만 false가 된다 —
    // 바로 그 순간부터 OS가 그 pid를 재사용할 수 있다. 며칠씩 켜 두는 앱에서 죽은 핸들에
    // signal(-pid)를 쏘면 남의 프로세스 그룹을 때린다.
    //
    // 호출자가 "살아 있을 때 봤고 자손이 없었다"(빈 Set)를 넘겼으므로 깨끗한 종료다.
    // 그것을 넘기지 않는 경우는 아래 두 테스트가 따로 본다 — 그때는 깨끗하지 않다.
    const signals: Array<[number, string]> = [];
    const out = await stopWorkerProcess(handle(0), {
      graceMs: 20,
      pollMs: 5,
      signal: (pid, sig) => signals.push([pid, sig]),
      descendants: async () => new Set<number>(),
      onGraceExpired: async () => true,
      knownDescendants: new Set<number>(),
    });
    expect(signals).toEqual([]);
    expect(out).toEqual({ stopped: true, leaked: [] });
  });

  // ── 이월 결함 N2 ────────────────────────────────────────────────────────────
  // 진입 가드가 `{stopped:true, leaked:[]}`를 무조건 돌려주던 자리다. supervisor가 먼저
  // 죽으면 그 `--once` 자식(start_new_session)과 그것이 띄운 mlx_lm.server는 pid 1로
  // 재부모화되어 **어떤 ppid BFS로도 보이지 않는다** — 그래서 이 모듈이 진입해서 찍는
  // 스냅샷은 빈 집합이고, 고아가 살아 있는 종료가 "깨끗함"으로 보고됐다. 고칠 자리가
  // 모듈 밖(호출자가 살아 있을 때 찍어 둬야 한다)이라 Task 13으로 넘어왔다.
  it("reports the orphans the caller captured when the supervisor died before we got here", async () => {
    const signals: Array<[number, string]> = [];
    const out = await stopWorkerProcess(handle(0), {
      graceMs: 20,
      pollMs: 5,
      signal: (pid, sig) => signals.push([pid, sig]),
      // 지금 찍으면 빈 집합이다. 재부모화된 자손은 여기 없다 — 그것이 이 결함의 전부다.
      descendants: async () => new Set<number>(),
      onGraceExpired: async () => true,
      knownDescendants: new Set([8801, 8802]),
      stillAlive: async (pids) => pids.filter((p) => p === 8802),
    });
    // 죽은 핸들에는 여전히 신호를 쏘지 않는다. pid가 재사용됐을 수 있다.
    expect(signals).toEqual([]);
    expect(out).toEqual({
      stopped: false,
      leaked: [8802],
      detail: STOP_DETAIL.diedFirst,
    });
  });

  it("does not call a supervisor that died unseen a clean stop", async () => {
    // 호출자가 한 번도 못 찍었다 = 자손이 없다는 것도 증명하지 못했다. 스냅샷 실패를
    // "자손 없음"으로 뭉개지 않는 것과 같은 규칙이다 (스펙 §6.9).
    const out = await stopWorkerProcess(handle(0), {
      graceMs: 20,
      pollMs: 5,
      signal: () => undefined,
      descendants: async () => new Set<number>(),
      onGraceExpired: async () => true,
    });
    expect(out).toEqual({ stopped: false, leaked: [], detail: STOP_DETAIL.diedUnseen });
  });

  it("does nothing when there is no pid", async () => {
    const signals: string[] = [];
    const out = await stopWorkerProcess(
      { pid: undefined, alive: () => false } as never,
      {
        graceMs: 10,
        pollMs: 5,
        signal: (_p, s) => signals.push(s),
        descendants: async () => new Set<number>(),
        onGraceExpired: async () => true,
      },
    );
    expect(signals).toEqual([]);
    expect(out.stopped).toBe(true);
  });
});

describe("stopWorkerProcess의 로그 싱크", () => {
  function handle(aliveFor: number) {
    let calls = 0;
    return {
      pid: 4242,
      alive: () => ++calls <= aliveFor,
      stderrTail: () => "",
      exitCode: () => null,
      onExit: () => undefined,
      stop: async () => undefined,
    } as never;
  }

  it("sends the snapshot failure to the injected sink instead of console.error", async () => {
    // 패키징된 .app을 Finder로 실행하면 Electron main의 stderr에는 받을 곳이 없다. 이
    // seam이 없으면 스냅샷 실패는 dev 터미널에서만 보이고 사후 조사에는 아무 기록이 없다.
    const seen: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const out = await stopWorkerProcess(handle(1), {
        graceMs: 20,
        pollMs: 5,
        signal: () => undefined,
        descendants: async () => {
          throw new Error("ps 실패");
        },
        onGraceExpired: async () => true,
        log: (line) => seen.push(line),
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("ps 실패");
      // 싱크를 줬으면 console.error로는 가지 않는다 — 두 곳에 적으면 어느 쪽을 지워도
      // 다른 쪽이 테스트를 초록으로 붙들어 준다.
      expect(spy).not.toHaveBeenCalled();
      expect(out.stopped).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("captureDescendants", () => {
  const noLog = () => undefined;

  it("captures while the supervisor is alive", async () => {
    const out = await captureDescendants(undefined, {
      pid: () => 4242,
      alive: () => true,
      descendants: async () => new Set([1, 2]),
      log: noLog,
    });
    expect([...(out ?? [])]).toEqual([1, 2]);
  });

  it("keeps the previous capture when the supervisor is already dead", async () => {
    // 죽은 뒤의 BFS는 재부모화된 자손을 못 보고, 그 사이 OS가 재사용한 pid를 우리 것이라며
    // 주워 올 수 있다. 새로 찍지 않고 살아 있을 때 찍어 둔 것을 유지한다.
    let walked = false;
    const previous = new Set([9001]);
    const out = await captureDescendants(previous, {
      pid: () => 4242,
      alive: () => false,
      descendants: async () => {
        walked = true;
        return new Set([7777]);
      },
      log: noLog,
    });
    expect(walked).toBe(false);
    expect(out).toBe(previous);
  });

  it("does not let a late ps failure erase the only evidence we had", async () => {
    const seen: string[] = [];
    const previous = new Set([9001]);
    const out = await captureDescendants(previous, {
      pid: () => 4242,
      alive: () => true,
      descendants: async () => {
        throw new Error("ps 타임아웃");
      },
      log: (line) => seen.push(line),
    });
    expect(out).toBe(previous);
    expect(seen[0]).toContain("ps 타임아웃");
  });

  it("stays undefined when there was never anything to capture", async () => {
    // undefined는 빈 Set과 다른 뜻이다 — "자손이 없었다"가 아니라 "확인하지 못했다"다.
    const out = await captureDescendants(undefined, {
      pid: () => undefined,
      alive: () => true,
      descendants: async () => new Set([1]),
      log: noLog,
    });
    expect(out).toBeUndefined();
  });
});
