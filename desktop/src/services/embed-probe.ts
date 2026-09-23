import { CAUSES } from "../diagnostics/causes";

export type EmbedProbe =
  | { kind: "match" }
  | { kind: "mismatch"; detail: string }
  | { kind: "absent" };

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/**
 * 채택 판정을 /health로 하지 않는 이유: embed_service.py:24-25의 /health는 {"status":"ok"}만
 * 돌려주므로 다른 모델·다른 차원을 서빙하는 서비스도 200을 준다. 채택하면 API가 /embed 응답을
 * 거절해 모든 의미 검색이 오류 없이 키워드 검색으로 떨어진다 (스펙 §6.5).
 */
async function readContract(
  baseUrl: string,
  want: { model: string; dimension: number },
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<EmbedProbe> {
  const res = await fetchImpl(`${baseUrl}/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ texts: ["담화 계약 프로브"] }),
    signal,
  });
  if (res.status !== 200) return { kind: "absent" };
  const body = (await res.json()) as { model?: unknown; dimension?: unknown };
  const model = typeof body.model === "string" ? body.model : null;
  const dimension = typeof body.dimension === "number" ? body.dimension : null;
  if (model === null || dimension === null) return { kind: "absent" };
  if (model !== want.model || dimension !== want.dimension) {
    return { kind: "mismatch", detail: CAUSES.embedMismatch.text(model, dimension, want.model, want.dimension) };
  }
  return { kind: "match" };
}

/**
 * 계약 프로브. 던지지도 않고 멈춰 있지도 않는다 — 둘 다 기동 순서 전체를 끝낸다.
 *
 * 타임아웃을 `AbortController`만으로 걸지 않고 `Promise.race`로 거는 이유: abort는
 * 그것을 보는 상대에게만 통한다. 주입된 `fetchImpl`(테스트)이나 signal을 무시하는 구현,
 * 응답 헤더는 왔지만 본문이 안 오는 embed 서비스(`res.json()`에서 멈춘다)에서는 abort가
 * 아무것도 끝내지 못하고 await가 영원히 매달린다. 경주에서 이긴 쪽이 absent로 닫으므로
 * 이 함수는 어떤 상대에게도 `timeoutMs` 안에 반드시 답한다.
 */
export async function probeEmbedContract(
  baseUrl: string,
  want: { model: string; dimension: number },
  fetchImpl: FetchLike = (url, init) => fetch(url, init) as never,
  timeoutMs = 3_000,
): Promise<EmbedProbe> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<EmbedProbe>((resolve) => {
    timer = setTimeout(() => {
      // 상대가 볼 수도 있으니 abort는 그대로 보낸다. 판정은 abort를 기다리지 않는다.
      controller.abort();
      resolve({ kind: "absent" });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      readContract(baseUrl, want, fetchImpl, controller.signal),
      deadline,
    ]);
  } catch {
    // 연결 거부·JSON 파싱 실패·fetchImpl의 동기 예외는 전부 "거기 쓸 만한 게 없다"와 같다.
    return { kind: "absent" };
  } finally {
    clearTimeout(timer);
  }
}
