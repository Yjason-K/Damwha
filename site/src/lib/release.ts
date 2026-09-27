// 빌드 때 GitHub 최신 릴리스를 한 번 읽는다(스펙 §3.7). 자산 이름에 버전이 들어 있어
// releases/latest/download/<고정이름> 링크를 쓸 수 없기 때문이다. 어떤 실패도 빌드를 멈추지 않는다 —
// 버튼이 릴리스 페이지를 가리키고 버전 표기가 빠질 뿐이다.
export const RELEASES_PAGE = "https://github.com/Yjason-K/Damwha/releases/latest";
const API = "https://api.github.com/repos/Yjason-K/Damwha/releases/latest";
const DMG = /^Damwha-.+-arm64\.dmg$/;

export type ReleaseInfo =
  | { kind: "asset"; version: string; dmgUrl: string; sizeBytes: number; publishedAt: string }
  | { kind: "fallback"; pageUrl: string };

const FALLBACK: ReleaseInfo = { kind: "fallback", pageUrl: RELEASES_PAGE };

type Asset = { name: string; browser_download_url: string; size: number };

function isDmgAsset(a: unknown): a is Asset {
  if (!a || typeof a !== "object") return false;
  const r = a as Record<string, unknown>;
  return (
    typeof r.name === "string" &&
    DMG.test(r.name) &&
    typeof r.browser_download_url === "string" &&
    typeof r.size === "number"
  );
}

export function parseRelease(json: unknown): ReleaseInfo | null {
  if (!json || typeof json !== "object") return null;
  const r = json as Record<string, unknown>;
  if (typeof r.tag_name !== "string" || typeof r.published_at !== "string" || !Array.isArray(r.assets)) return null;
  const asset = r.assets.find(isDmgAsset);
  if (!asset) return null;
  return {
    kind: "asset",
    version: r.tag_name.replace(/^v/, ""),
    dmgUrl: asset.browser_download_url,
    sizeBytes: asset.size,
    publishedAt: r.published_at,
  };
}

export async function fetchLatestRelease(
  deps: { fetchImpl?: typeof fetch; warn?: (msg: string) => void; timeoutMs?: number; token?: string } = {},
): Promise<ReleaseInfo> {
  // Cloudflare 빌더는 나가는 IP를 여러 고객이 나눠 쓴다. 비인증 한도(IP당 60/h)에 남의 빌드가 닿으면
  // 우리 빌드가 403으로 폴백한다 — GITHUB_TOKEN(권한 없는 fine-grained 토큰이면 충분)이 있으면 싣는다.
  const { fetchImpl = fetch, warn = (m) => console.warn(m), timeoutMs = 10_000, token = process.env.GITHUB_TOKEN ?? "" } = deps;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "damwha-site-build" };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetchImpl(API, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      warn(`[release] GitHub API ${res.status} — 다운로드 버튼을 릴리스 페이지로 돌린다`);
      return FALLBACK;
    }
    const parsed = parseRelease(await res.json());
    if (!parsed) warn("[release] 최신 릴리스에 arm64 DMG가 없다 — 릴리스 페이지로 돌린다");
    return parsed ?? FALLBACK;
  } catch (e) {
    warn(`[release] 조회 실패(${e instanceof Error ? e.message : String(e)}) — 릴리스 페이지로 돌린다`);
    return FALLBACK;
  }
}

let cached: Promise<ReleaseInfo> | undefined;
/** 두 언어 페이지가 같은 빌드에서 한 번만 부른다. */
export function getLatestRelease(): Promise<ReleaseInfo> {
  cached ??= fetchLatestRelease();
  return cached;
}

export function formatSize(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function downloadHref(r: ReleaseInfo): string {
  return r.kind === "asset" ? r.dmgUrl : r.pageUrl;
}
