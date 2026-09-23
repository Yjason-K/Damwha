/**
 * 새 데스크톱 릴리스 조회 (Phase 6b-1 스펙 §4.1).
 *
 * electron을 import하지 않는다 — main.ts가 전역 fetch를 주입하고, 테스트는 네트워크 없이 부른다.
 * 모양은 config/token-store.ts의 verifyHfToken을 따른다: 신호로 요청을 끊고 경주로 결과를 닫는다
 * (본문 읽기와 모든 페이지 포함).
 *
 * **불완전한 조회로 "최신"이라 말하지 않는다.** 후보가 하나도 없거나 목록을 끝까지 못 읽으면 failed다.
 * **다운로드 URL은 응답에서 받지 않는다** — 정규식을 통과한 태그로 만든다. openExternal에 외부 응답의
 * 문자열이 닿지 않는다.
 */

export const RELEASES_URL = "https://api.github.com/repos/Yjason-K/Damwha/releases?per_page=100";
export const RELEASE_PAGE_BASE = "https://github.com/Yjason-K/Damwha/releases/tag/";
const API_ORIGIN = "https://api.github.com/";
export const CHECK_TIMEOUT_MS = 10_000;
export const MAX_PAGES = 5;
export const DEFAULT_RATE_LIMIT_WAIT_MS = 60 * 60_000;

export interface ReleaseFetchInit {
  method: "GET";
  headers: Record<string, string>;
  signal: AbortSignal;
}
export interface ReleaseFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type ReleaseFetch = (url: string, init: ReleaseFetchInit) => Promise<ReleaseFetchResponse>;

export type FailReason = "offline" | "timeout" | "rate_limited" | "http" | "malformed" | "no_release";
export type CheckResult =
  | { kind: "newer"; version: string; url: string }
  | { kind: "current"; latest: string }
  | { kind: "failed"; reason: FailReason; detail: string; retryAfterMs?: number };

export type Version = readonly [number, number, number];

export const INSTALLED_VERSION_SHAPE = /^(\d+)\.(\d+)\.(\d+)$/;
/** 새 형식 v<x.y.z>와 6a의 desktop-v<x.y.z>. 스펙 §3-2. */
const TAG_SHAPE = /^(?:desktop-)?v(\d+)\.(\d+)\.(\d+)$/;

function toVersion(m: RegExpExecArray | null): Version | null {
  if (m === null) return null;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])] as const;
  return v.every(Number.isSafeInteger) ? v : null;
}

export function parseInstalledVersion(s: string): Version | null {
  return toVersion(INSTALLED_VERSION_SHAPE.exec(s));
}

export function parseReleaseTag(tag: string): Version | null {
  return toVersion(TAG_SHAPE.exec(tag));
}

export function compareVersions(a: Version, b: Version): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function formatVersion(v: Version): string {
  return v.join(".");
}

export function releasePageUrl(tag: string): string {
  return RELEASE_PAGE_BASE + tag;
}

export interface Candidate {
  version: Version;
  tag: string;
}

/** 후보 중 최대. draft·prerelease는 **엄격한 불리언 false**여야 한다 — 누락·문자열이면 후보가 아니다. */
export function pickLatest(items: readonly unknown[]): Candidate | null {
  let best: Candidate | null = null;
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (r.draft !== false || r.prerelease !== false) continue;
    if (typeof r.tag_name !== "string") continue;
    const version = parseReleaseTag(r.tag_name);
    if (version === null) continue;
    const c: Candidate = { version, tag: r.tag_name };
    if (best === null) {
      best = c;
      continue;
    }
    const cmp = compareVersions(version, best.version);
    // 같은 버전이 두 형식으로 있으면 새 형식(v*)의 페이지를 연다.
    if (cmp > 0 || (cmp === 0 && c.tag.startsWith("v") && !best.tag.startsWith("v"))) best = c;
  }
  return best;
}

type NextPage = { kind: "none" } | { kind: "next"; url: string } | { kind: "foreign" };

function nextPage(link: string | null): NextPage {
  if (link === null) return { kind: "none" };
  for (const part of link.split(",")) {
    const m = /^\s*<([^>]*)>\s*;\s*rel="next"\s*$/.exec(part);
    if (m !== null) return m[1].startsWith(API_ORIGIN) ? { kind: "next", url: m[1] } : { kind: "foreign" };
  }
  return { kind: "none" };
}

/** 대기 시간이 말이 되는가 — 양의 안전 정수이고 24시간 이하. 아니면 기본 60분 (스펙 §4.1 "없거나 이상하면"). */
const MAX_RATE_LIMIT_WAIT_MS = 24 * 60 * 60_000;
function saneWait(ms: number): number {
  return Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_RATE_LIMIT_WAIT_MS ? ms : DEFAULT_RATE_LIMIT_WAIT_MS;
}

/** 403·429 중 한도로 읽히는 것의 대기 시간. 한도가 아니면 null. */
function rateLimitWaitMs(status: number, headers: ReleaseFetchResponse["headers"], now: number): number | null {
  if (status !== 403 && status !== 429) return null;
  const retryAfter = headers.get("retry-after")?.trim() ?? null;
  if (retryAfter !== null && /^\d+$/.test(retryAfter)) return saneWait(Number(retryAfter) * 1000);
  if (headers.get("x-ratelimit-remaining")?.trim() === "0") {
    return saneWait(Math.round(Number(headers.get("x-ratelimit-reset")) * 1000 - now));
  }
  if (retryAfter !== null) return DEFAULT_RATE_LIMIT_WAIT_MS;
  return null;
}

class CheckTimeout extends Error {}
class Malformed extends Error {}
class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly waitMs: number | null,
  ) {
    super(`HTTP ${status}`);
  }
}

interface CheckDeps {
  fetch: ReleaseFetch;
  now(): number;
  timeoutMs?: number;
}

async function readAllPages(current: string, deps: CheckDeps, signal: AbortSignal): Promise<unknown[]> {
  const items: unknown[] = [];
  let url = RELEASES_URL;
  for (let page = 1; ; page++) {
    const res = await deps.fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `Damwha/${current}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal,
    });
    if (res.status !== 200) throw new HttpFailure(res.status, rateLimitWaitMs(res.status, res.headers, deps.now()));
    const body = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Malformed("GitHub 응답이 JSON이 아니에요");
    }
    if (!Array.isArray(parsed)) throw new Malformed("GitHub 응답이 목록이 아니에요");
    items.push(...parsed);
    const next = nextPage(res.headers.get("link"));
    if (next.kind === "none") return items;
    if (next.kind === "foreign") throw new Malformed("다음 페이지 주소가 GitHub API 밖이에요");
    if (page >= MAX_PAGES) throw new Malformed("목록을 다 읽지 못했어요");
    url = next.url;
  }
}

export async function checkForUpdate(current: string, deps: CheckDeps): Promise<CheckResult> {
  const installed = parseInstalledVersion(current);
  if (installed === null) return { kind: "failed", reason: "malformed", detail: `설치 버전을 읽지 못했어요: ${current}` };

  const timeoutMs = deps.timeoutMs ?? CHECK_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CheckTimeout());
    }, timeoutMs);
  });
  deadline.catch(() => undefined);

  try {
    const items = await Promise.race([readAllPages(current, deps, controller.signal), deadline]);
    const latest = pickLatest(items);
    if (latest === null) return { kind: "failed", reason: "no_release", detail: "받을 수 있는 데스크톱 릴리스가 없어요" };
    if (compareVersions(latest.version, installed) > 0) {
      return { kind: "newer", version: formatVersion(latest.version), url: releasePageUrl(latest.tag) };
    }
    return { kind: "current", latest: formatVersion(latest.version) };
  } catch (e) {
    if (e instanceof CheckTimeout) return { kind: "failed", reason: "timeout", detail: `${timeoutMs / 1000}초 안에 답이 없었어요` };
    if (e instanceof Malformed) return { kind: "failed", reason: "malformed", detail: e.message };
    if (e instanceof HttpFailure) {
      return e.waitMs !== null
        ? { kind: "failed", reason: "rate_limited", detail: e.message, retryAfterMs: e.waitMs }
        : { kind: "failed", reason: "http", detail: e.message };
    }
    return { kind: "failed", reason: "offline", detail: networkDetail(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 원본 예외 메시지를 옮기지 않는다 — 모양이 맞는 오류 코드만 싣는다 (token-store.ts와 같은 규칙). */
function networkDetail(e: unknown): string {
  const code = errorCode(e);
  return code === null ? "GitHub에 연결하지 못했어요" : `GitHub에 연결하지 못했어요 (${code})`;
}

function errorCode(e: unknown): string | null {
  const pick = (v: unknown): string | null => {
    if (v === null || typeof v !== "object") return null;
    const code = (v as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : null;
  };
  const cause = e !== null && typeof e === "object" ? (e as { cause?: unknown }).cause : undefined;
  return pick(e) ?? pick(cause ?? null);
}
