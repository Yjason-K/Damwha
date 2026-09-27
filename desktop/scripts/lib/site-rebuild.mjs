// 데스크톱 릴리스 뒤 제품 사이트(damwha.0kimjae.dev)를 다시 빌드시킨다(제품 사이트 스펙 §3.7).
// 사이트는 빌드 때 최신 릴리스 DMG를 읽으므로, 훅이 없으면 다운로드 버튼이 한 버전 늦는다.
// 훅 URL은 Cloudflare Pages가 준 비밀 URL이라 저장소에 두지 않는다 — 로컬 env DAMWHA_SITE_DEPLOY_HOOK.
// 어떤 실패도 발행을 실패시키지 않는다. 릴리스는 이미 나갔고, 늦은 버튼의 최악은 "한 버전 늦은 설치"다.
import { fileURLToPath } from "node:url";

export async function triggerSiteRebuild({ hookUrl, fetchImpl = fetch, log = console.log }) {
  if (!hookUrl) {
    log("사이트 재빌드 건너뜀 — DAMWHA_SITE_DEPLOY_HOOK이 없다. Cloudflare Pages에서 직접 재배포할 것.");
    return "skipped";
  }
  try {
    const res = await fetchImpl(hookUrl, { method: "POST", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      log(`사이트 재빌드 요청 실패(HTTP ${res.status}) — Cloudflare Pages에서 직접 재배포할 것.`);
      return "failed";
    }
    log("사이트 재빌드 요청함 — 몇 분 뒤 다운로드 버튼이 새 버전을 가리킨다.");
    return "triggered";
  } catch (e) {
    log(`사이트 재빌드 요청 실패(${e instanceof Error ? e.message : String(e)}) — Cloudflare Pages에서 직접 재배포할 것.`);
    return "failed";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await triggerSiteRebuild({ hookUrl: process.env.DAMWHA_SITE_DEPLOY_HOOK ?? "" });
}
