/**
 * worker는 포트가 없어 Phase 1의 소유 판정 기구(isPortOccupied / verifyOwnListener)를 쓸 수
 * 없다. 대신 ps의 커맨드라인을 본다. 두 가지를 반드시 거른다 (스펙 §6.5).
 */

/** ps 자신이나 grep이 문자열을 갖고 있는 줄. 이것을 세면 앱이 자기 worker를 안 띄운다. */
const SELF_NOISE = /\b(grep|ps)\b/;

/**
 * `uv run --directory be/worker python -m damwha_worker`(= `pnpm worker`)의 uv 프로세스 자체.
 * exec 전이라 실제 supervisor(venv의 python3)와 별개의 pid로 나란히 뜨고, 커맨드라인에
 * damwha_worker를 그대로 갖고 있어 문자열 매치만으로는 supervisor로 오탐한다(2026-09-12 실측).
 */
const UV_LAUNCHER = /^uv\s+run\b/;

export function parseWorkerProcesses(
  psOutput: string,
  ourDescendants: ReadonlySet<number>,
): number[] {
  const out: number[] = [];
  for (const line of psOutput.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const space = trimmed.indexOf(" ");
    if (space <= 0) continue;
    const pid = Number(trimmed.slice(0, space));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const command = trimmed.slice(space + 1);
    if (!command.includes("damwha_worker")) continue;
    // __main__.py:279의 일회성 자식. 이것을 supervisor로 세면 앱이 자기 worker를 영영 안 띄운다.
    if (/(^|\s)--once(\s|$)/.test(command)) continue;
    if (SELF_NOISE.test(command)) continue;
    if (UV_LAUNCHER.test(command)) continue;
    if (ourDescendants.has(pid)) continue;
    out.push(pid);
  }
  return out;
}

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
export async function probeEmbedContract(
  baseUrl: string,
  want: { model: string; dimension: number },
  fetchImpl: FetchLike = (url, init) => fetch(url, init) as never,
  timeoutMs = 3_000,
): Promise<EmbedProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: ["담화 계약 프로브"] }),
      signal: controller.signal,
    });
    if (res.status !== 200) return { kind: "absent" };
    const body = (await res.json()) as { model?: unknown; dimension?: unknown };
    const model = typeof body.model === "string" ? body.model : null;
    const dimension = typeof body.dimension === "number" ? body.dimension : null;
    if (model === null || dimension === null) return { kind: "absent" };
    if (model !== want.model || dimension !== want.dimension) {
      return {
        kind: "mismatch",
        detail: `모델 ${model}·차원 ${dimension}을 서빙하고 있어요 (앱은 ${want.model}·${want.dimension}이 필요해요)`,
      };
    }
    return { kind: "match" };
  } catch {
    // 연결 거부·타임아웃·JSON 파싱 실패는 전부 "거기 쓸 만한 게 없다"와 같다.
    return { kind: "absent" };
  } finally {
    clearTimeout(timer);
  }
}
