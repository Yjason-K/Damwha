/**
 * URL의 origin. file:은 origin이 "null"이라 쓸 수 없으므로 null을 돌려준다 —
 * 셸 화면은 file:로 뜨지만 권한이 필요 없다 (스펙 §6.6).
 */
export function originOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.origin;
}

export function isAllowedOrigin(url: string, allowed: readonly string[]): boolean {
  const origin = originOf(url);
  return origin !== null && allowed.includes(origin);
}
