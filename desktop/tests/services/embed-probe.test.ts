import { describe, expect, it } from "vitest";
import { probeEmbedContract } from "../../src/services/embed-probe";

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
