import * as fs from "fs";
import * as path from "path";

/**
 * 0.4.x까지의 빌드가 safeStorage로 암호화해 둔 HF 토큰 파일 (옛 `config/token-store.ts`의 TOKEN_FILE_NAME).
 * 앱은 더는 토큰을 쓰지 않으므로(스펙 2026-09-30 §5.1) 기동 때 지운다 — 쓰지 않는 비밀을 디스크에 두지 않는다.
 * 실패해도 기동을 막지 않는다. 로그만 남기고 다음 기동이 다시 시도한다.
 */
export const LEGACY_TOKEN_FILE = "hf-token.bin";

export function removeLegacyToken(
  userData: string,
  deps: { rm?: (p: string) => void; log?: (line: string) => void } = {},
): "removed" | "absent" | "failed" {
  const file = path.join(userData, LEGACY_TOKEN_FILE);
  if (!fs.existsSync(file)) return "absent";
  const rm = deps.rm ?? ((p: string) => fs.rmSync(p, { force: true }));
  try {
    rm(file);
    deps.log?.(`예전 HF 토큰 파일을 지웠어요 — ${LEGACY_TOKEN_FILE} (앱은 더는 토큰을 쓰지 않아요)`);
    return "removed";
  } catch (e) {
    deps.log?.(`예전 HF 토큰 파일(${LEGACY_TOKEN_FILE})을 지우지 못했어요: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}
