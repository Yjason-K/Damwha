import { shareEnabled } from '../shares/share-enabled';

/**
 * 연동 API(설정 화면의 CLI 링크·MCP 등록)를 켤 수 있는가 (spec 2026-10-20 §2.7). 홈 디렉터리의 파일을 만지므로
 * 공유와 같은 이유로 loopback·비데모일 때만 켜고, 거기에 앱이 런처 경로(`DAMWHA_CLI_LAUNCHER`)를 알려 줬을 때만이다.
 */
export function integrationsEnabled(env: {
  HOST: string;
  DEMO_READ_ONLY: string;
  DAMWHA_CLI_LAUNCHER?: string;
}): boolean {
  return shareEnabled(env) && !!env.DAMWHA_CLI_LAUNCHER;
}
