import { describe, expect, it } from "vitest";
import {
  isOwnListener,
  verifyOwnListener,
  type OwnListenerDeps,
} from "../src/services/own-listener";

/**
 * 이 판정이 main.ts에 있는 동안 `owners.some(...)`을 `true`로 바꾸는 변이가 259개 초록불
 * 아래 살아남았다 (재리뷰 N4). 배포되면 남의 API가 3000을 쥐고 있어도 앱이 그것을 자기
 * 자식으로 보고 준비됐다고 판정한다 — 스펙 §6.4가 명시적으로 금지한 "포트에 응답이 있다 =
 * 준비됐다"다.
 */
describe("isOwnListener", () => {
  it("accepts the child itself as the listener — that is the packaged shape", () => {
    // packaged에서는 자식(utilityProcess 헬퍼)이 리스너 자신이고, descendantPids는 root를
    // 빼고 돌려주므로 이 항이 없으면 우리가 띄운 API가 남의 것으로 보인다.
    expect(isOwnListener([4242], 4242, new Set())).toBe(true);
  });

  it("accepts a descendant as the listener — that is the dev shape", () => {
    // dev의 자식은 pnpm이고 실제로 bind하는 것은 그 손자(pnpm → nest → node)다.
    expect(isOwnListener([9003], 4242, new Set([9001, 9003]))).toBe(true);
  });

  it("refuses a listener that is neither the child nor its descendant", () => {
    // 남이 3000을 쥐고 있는 흔한 경우. 여기서 true를 돌려주면 앱은 남의 API를 자기 것으로
    // 채택하고, 그 뒤 모든 화면이 남의 데이터를 보여준다.
    expect(isOwnListener([777], 4242, new Set([9001, 9003]))).toBe(false);
  });

  it("refuses when nothing is listening at all", () => {
    expect(isOwnListener([], 4242, new Set([9001]))).toBe(false);
  });

  it("accepts when one of several listeners is ours", () => {
    // SO_REUSEPORT나 IPv4/IPv6 이중 바인딩으로 lsof가 여럿을 돌려줄 수 있다.
    expect(isOwnListener([777, 9003], 4242, new Set([9003]))).toBe(true);
  });
});

function deps(over: Partial<OwnListenerDeps> = {}): OwnListenerDeps {
  return {
    listeners: async () => [9003],
    descendants: async () => new Set([9003]),
    ...over,
  };
}

describe("verifyOwnListener", () => {
  it("says no before there is a child — there is nothing of ours to own it", async () => {
    let asked = false;
    const d = deps({
      listeners: async () => {
        asked = true;
        return [9003];
      },
    });
    expect(await verifyOwnListener(d, 3000, undefined)).toBe(false);
    // 자식이 없으면 lsof/ps를 부를 이유도 없다.
    expect(asked).toBe(false);
  });

  it("asks about the port it was given and the child it was given", async () => {
    const seen: number[] = [];
    const d = deps({
      listeners: async (port) => {
        seen.push(port);
        return [];
      },
      descendants: async (root) => {
        seen.push(root);
        return new Set();
      },
    });
    await verifyOwnListener(d, 3000, 4242);
    expect(seen.sort()).toEqual([3000, 4242]);
  });

  it("confirms our own listener", async () => {
    expect(await verifyOwnListener(deps(), 3000, 4242)).toBe(true);
  });

  it("closes toward failure when lsof cannot answer", async () => {
    // 소유를 **증명할 수 없으면** 아니오다. 여기서 true로 열면 조회가 실패하는 모든 환경에서
    // 남의 리스너가 우리 것으로 통과한다 — 준비 판정은 실패 쪽으로 닫는다.
    const d = deps({
      listeners: async () => {
        throw new Error("lsof: command not found");
      },
    });
    expect(await verifyOwnListener(d, 3000, 4242)).toBe(false);
  });

  it("closes toward failure when ps cannot answer", async () => {
    const d = deps({
      descendants: async () => {
        throw new Error("ps failed");
      },
    });
    expect(await verifyOwnListener(d, 3000, 4242)).toBe(false);
  });

  it("refuses someone else's listener on the port we wanted", async () => {
    const d = deps({ listeners: async () => [777], descendants: async () => new Set([9003]) });
    expect(await verifyOwnListener(d, 3000, 4242)).toBe(false);
  });
});
