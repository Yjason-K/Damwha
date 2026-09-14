import { describe, expect, it } from "vitest";
import { askIsRecording, runHandshake } from "../../src/windows/recording-bridge";

describe("askIsRecording", () => {
  // 이 왕복은 봉쇄된 렌더러가 ⌘Q·⌘W를 영구히 막는 유일한 남은 자리였다. 상한이 있다는
  // 사실과, 상한에 걸렸을 때의 답이 무엇인가가 판정 대상이다.
  const never = () => new Promise<never>(() => undefined);

  it("answers what the renderer answered, without waiting out the bound", async () => {
    const late: string[] = [];
    const opts = { timeoutMs: 50, onTimeout: () => late.push("timeout") };
    expect(await askIsRecording(async () => true, opts)).toBe(true);
    expect(await askIsRecording(async () => false, opts)).toBe(false);
    // 답이 왔으면 타이머는 꺼진다 — 상한이 뒤늦게 발화해 답을 덮어쓰지 않는다.
    await new Promise((r) => setTimeout(r, 70));
    expect(late).toEqual([]);
  });

  it("answers NO when the round-trip rejects", async () => {
    // 프레임이 이미 없거나 훅이 없다는 뜻이다. 중지할 녹음도 없으므로 확인을 묻지 않는다.
    const late: string[] = [];
    const out = await askIsRecording(() => Promise.reject(new Error("Script failed to execute")), {
      timeoutMs: 50,
      onTimeout: () => late.push("timeout"),
    });
    expect(out).toBe(false);
    expect(late).toEqual([]);
  });

  it("answers NO — instead of rejecting — when the round-trip throws synchronously", async () => {
    // webContents.executeJavaScript는 파괴된 webContents에서 프라미스가 아니라 **동기 예외**를 낸다.
    // `call().then(…)`은 그것을 못 잡아 이 함수가 거부했고, 그 거부가 종료 흐름을 확인 전에 끝내
    // 서비스를 하나도 내리지 않은 채 앱이 나갔다 (최종 리뷰 I-2).
    const late: string[] = [];
    const out = await askIsRecording(
      () => {
        throw new Error("Object has been destroyed");
      },
      { timeoutMs: 50, onTimeout: () => late.push("timeout") },
    );
    expect(out).toBe(false);
    expect(late).toEqual([]);
  });

  it("answers YES — not 'unknown' — when the renderer never answers, and says so", async () => {
    // 렌더러의 JS 스레드가 막히면 executeJavaScript는 거부하지도 해결하지도 않는다.
    // 여기서 "아니오"로 닫으면 확인도 핸드셰이크도 건너뛰어 녹음을 조용히 버린다.
    // 그 반대 비용(확인 한 번 더)이 훨씬 싸다.
    const said: string[] = [];
    const out = await askIsRecording(never, {
      timeoutMs: 10,
      onTimeout: () => said.push("timeout"),
    });
    expect(out).toBe(true);
    expect(said).toEqual(["timeout"]);
  });

  it("comes back within the bound instead of waiting on a wedged renderer", async () => {
    // 상한이 없으면 ⌘Q는 before-quit의 preventDefault 뒤 이 물음에서 멎어 app.quit()이
    // 영영 안 불린다 — 어떤 키를 눌러도 앱을 끌 수 없어진다.
    const t0 = Date.now();
    await askIsRecording(never, { timeoutMs: 20, onTimeout: () => undefined });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  // 상한에 걸린 뒤 늦게 도착하는 거부가 unhandled가 되는가 — **테스트를 두지 않는다.**
  // `Promise.race`는 진 프라미스에도 언제나 반응을 등록하므로 늦은 거부는 **어떤 구현에서도**
  // unhandled가 되지 않는다. 즉 이것은 우리 코드의 성질이 아니라 언어의 성질이고, 그 테스트를
  // 빨갛게 만드는 코드 변경이 존재하지 않는다 (재리뷰 3이 askIsRecording의 선행 거부 핸들러를
  // 지우는 변이로 실측했다 — 죽은 것은 `answers NO when the round-trip rejects` 하나뿐이었고
  // 이 테스트는 초록으로 살아남았다). 실패할 수 없는 테스트는 없는 것보다 나쁘다: 진짜 방어가
  // 들어갈 자리를 차지하고, 모든 집계에서 커버리지처럼 읽힌다.
  // 거부가 값으로 바뀐다는 성질 자체는 위의 `answers NO when the round-trip rejects`가 지킨다.
});

describe("runHandshake", () => {
  it("returns stopped when the renderer finishes", async () => {
    const r = await runHandshake(async () => ({ stopped: true }), { timeoutMs: 50 });
    expect(r).toEqual({ kind: "stopped" });
  });

  it("reports the renderer's own reason for failing", async () => {
    const r = await runHandshake(async () => ({ stopped: false, reason: "업로드 실패" }), {
      timeoutMs: 50,
    });
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.detail).toContain("업로드 실패");
  });

  it("times out instead of blocking the quit forever", async () => {
    const r = await runHandshake(() => new Promise(() => undefined), { timeoutMs: 20 });
    expect(r.kind).toBe("timeout");
  });

  it("treats a destroyed renderer as failed, not as success", async () => {
    const r = await runHandshake(async () => {
      throw new Error("Object has been destroyed");
    }, { timeoutMs: 50 });
    expect(r.kind).toBe("failed");
  });
});
