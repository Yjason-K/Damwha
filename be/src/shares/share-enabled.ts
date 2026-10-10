const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * 공유를 켤 수 있는가 (spec 2026-10-09 §2.7 공유 활성 조건). 로컬 API 접근 제어는 브라우저만 막을 뿐 인증이
 * 아니다 — Origin 없는 요청(curl 등)은 통과한다. loopback 바인드면 그런 요청은 같은 Mac에서만 오지만, Docker
 * (`HOST=0.0.0.0`)나 데모에서는 네트워크의 누구나 공유를 만들고 키를 읽게 된다. 그래서 앱에서만 켠다.
 */
export function shareEnabled(env: { HOST: string; DEMO_READ_ONLY: string }): boolean {
  return LOOPBACK.has(env.HOST) && env.DEMO_READ_ONLY !== 'true';
}
