import { describe, expect, it, vi } from "vitest";
import {
  applyTokenChange,
  ownedByStatus,
  TOKEN_SERVICES,
  type TokenChangeDeps,
} from "../../src/windows/apply-token-change";
import type { TokenStore } from "../../src/config/token-store";
import type { ServiceId, ServiceStatus } from "../../src/services/types";

const OLD = "hf_oldoldoldoldoldoldoldoldoldoldold";
const NEW = "hf_newnewnewnewnewnewnewnewnewnewnew";

/** 실제 TokenStore처럼 쓴 값을 그대로 돌려주는 가짜. `readBack`으로 왕복을 깨뜨릴 수 있다. */
function fakeStore(over: Partial<TokenStore> = {}): TokenStore & { written: string[] } {
  let held: string | null = OLD;
  const written: string[] = [];
  return {
    written,
    available: () => true,
    read: () => held,
    write: (t: string) => {
      written.push(t);
      held = t;
    },
    clear: () => {
      held = null;
    },
    ...over,
  } as TokenStore & { written: string[] };
}

function deps(over: Partial<TokenChangeDeps> = {}): TokenChangeDeps & {
  liveEnv: Record<string, string>;
  cached: string[];
} {
  const cached: string[] = [];
  const base = {
    store: fakeStore(),
    liveEnv: { HF_TOKEN: OLD, PORT: "3000" } as Record<string, string>,
    restartService: vi.fn(async () => undefined),
    owned: () => true,
    cacheToken: (t: string) => cached.push(t),
  };
  return { ...base, ...over, cached } as TokenChangeDeps & {
    liveEnv: Record<string, string>;
    cached: string[];
  };
}

describe("applyTokenChange", () => {
  it("저장하고, live env를 갱신하고, 토큰을 받는 두 서비스를 다시 시작한다", async () => {
    const d = deps();
    const out = await applyTokenChange(d, NEW);
    expect(d.store.read()).toBe(NEW);
    expect(d.liveEnv.HF_TOKEN).toBe(NEW);
    // 다른 키는 건드리지 않는다 — 감독자가 쥔 바로 그 객체다.
    expect(d.liveEnv.PORT).toBe("3000");
    expect(out.restarted).toEqual([...TOKEN_SERVICES]);
    expect(out.skipped).toEqual([]);
    expect(d.restartService).toHaveBeenCalledTimes(2);
  });

  it("live env와 main.ts의 캐시를 **같이** 갱신한다 — 하나만 바꾸면 감독자 재생성이 옛 토큰을 다시 쓴다", async () => {
    const d = deps();
    await applyTokenChange(d, NEW);
    expect(d.cached).toEqual([NEW]);
  });

  it("저장은 됐는데 다시 읽히지 않으면 **재시작 전에** 던진다", async () => {
    const restartService = vi.fn(async () => undefined);
    const d = deps({ store: fakeStore({ read: () => null }), restartService });
    await expect(applyTokenChange(d, NEW)).rejects.toThrow(/다시 읽지 못했어요/);
    expect(restartService).not.toHaveBeenCalled();
    // env도 건드리지 않았다 — 증명되지 않은 토큰을 자식에게 주지 않는다.
    expect(d.liveEnv.HF_TOKEN).toBe(OLD);
    expect(d.cached).toEqual([]);
  });

  it("다시 읽은 값이 방금 넣은 값과 다르면 던진다 (다른 맥에서 옮겨 온 파일 등)", async () => {
    const d = deps({ store: fakeStore({ read: () => OLD }) });
    await expect(applyTokenChange(d, NEW)).rejects.toThrow(/다시 읽지 못했어요/);
  });

  it("저장 자체가 던지면 그대로 올린다 — env도 재시작도 없다", async () => {
    const restartService = vi.fn(async () => undefined);
    const d = deps({
      store: fakeStore({
        write: () => {
          throw new Error("키체인 암호화를 쓸 수 없어 토큰을 저장하지 않았어요.");
        },
      }),
      restartService,
    });
    await expect(applyTokenChange(d, NEW)).rejects.toThrow(/키체인/);
    expect(restartService).not.toHaveBeenCalled();
    expect(d.liveEnv.HF_TOKEN).toBe(OLD);
  });

  it("채택한 외부 embed는 skipped에 들어가고 **예외가 아니다**", async () => {
    const restartService = vi.fn(async () => undefined);
    const d = deps({ owned: (id: ServiceId) => id !== "embed", restartService });
    const out = await applyTokenChange(d, NEW);
    expect(out.restarted).toEqual(["worker"]);
    expect(out.skipped).toEqual(["embed"]);
    expect(restartService).toHaveBeenCalledTimes(1);
    expect(restartService).toHaveBeenCalledWith("worker");
    // 소유하지 않은 서비스여도 토큰 자체는 갈아 끼웠다 — 다음 기동이 새 값을 쓴다.
    expect(d.liveEnv.HF_TOKEN).toBe(NEW);
  });

  it("한 서비스의 재시작이 거부돼도 나머지는 다시 시작한다", async () => {
    const restartService = vi.fn(async (id: ServiceId) => {
      if (id === "worker") throw new Error("boom");
    });
    const d = deps({ restartService });
    const out = await applyTokenChange(d, NEW);
    expect(out.restarted).toEqual(["embed"]);
    expect(out.skipped).toEqual(["worker"]);
  });

  it("빈 토큰은 저장하지 않는다", async () => {
    const d = deps();
    await expect(applyTokenChange(d, "   ")).rejects.toThrow();
    expect(d.liveEnv.HF_TOKEN).toBe(OLD);
  });

  it("토큰을 받는 것은 python 자식 둘뿐이다 — api·postgres는 대상이 아니다", () => {
    expect([...TOKEN_SERVICES].sort()).toEqual(["embed", "worker"]);
  });
});

describe("ownedByStatus", () => {
  const s = (over: Partial<ServiceStatus>): ServiceStatus => ({
    id: "worker",
    process: "running",
    health: "ok",
    owned: true,
    restarts: 0,
    ...over,
  });

  it("감독자의 restartRefused를 그대로 쓴다 — 버튼과 토큰 교체가 같은 판정을 본다", () => {
    const owned = ownedByStatus([
      s({ id: "worker" }),
      s({ id: "embed", owned: false }),
    ]);
    expect(owned("worker")).toBe(true);
    expect(owned("embed")).toBe(false);
  });

  it("정리 중인 서비스도 소유하지 않은 것으로 본다 — 두 번째 종료 신호는 강제 종료다", () => {
    expect(ownedByStatus([s({ cleaningUp: true })])("worker")).toBe(false);
  });

  it("감독자가 모르는 서비스는 소유하지 않은 것이다", () => {
    expect(ownedByStatus([])("worker")).toBe(false);
  });

  it("아직 뜨지 않은(failed) 서비스는 대상이다 — 소유의 문제가 아니라 '띄운 적이 없다'이다", () => {
    expect(ownedByStatus([s({ process: "failed", owned: false })])("worker")).toBe(true);
  });
});
