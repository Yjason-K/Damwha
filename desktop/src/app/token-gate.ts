import { CAUSES } from "../diagnostics/causes";
import type { TokenStore } from "../config/token-store";
import { TokenWindowClosed } from "../windows/token-window";

/**
 * 기동 게이트 — **어떤 서비스도(postgres 포함) 띄우기 전에** HF 토큰을 확보한다 (Phase 4 스펙 §6.4·§8).
 * main.ts는 electron을 값으로 import해 테스트가 못 부르므로 판정은 여기 있고, main.ts의 createSupervisorFor는
 * 결과를 배선만 한다.
 *
 * | 상태 | 결과 |
 * | --- | --- |
 * | `safeStorage`를 못 쓴다 | blocked — 읽지도, 창을 띄우지도 않는다. 평문 폴백은 없다 |
 * | 저장된 토큰을 읽었다 | ready |
 * | 파일이 없다 | 온보딩(안내 없음) |
 * | 파일은 있는데 못 읽었다 | 온보딩("토큰을 읽을 수 없어요 — 다시 입력해 주세요"). **파일은 그대로 둔다** |
 * | 사람이 온보딩 창을 닫았다 | quit — 실패 화면도 재시도도 없다(창이 이미 앱 종료를 불렀다) |
 *
 * 온보딩의 그 밖의 실패(창을 못 띄움)는 그대로 던진다 — 실패 화면과 "다시 시도"의 몫이다.
 */

export const UNREADABLE_TOKEN_NOTICE = "토큰을 읽을 수 없어요 — 다시 입력해 주세요";

export type TokenGateResult =
  | { kind: "ready"; token: string }
  | { kind: "blocked"; detail: string }
  | { kind: "quit" };

export interface TokenGateDeps {
  store: TokenStore;
  /** `<userData>/hf-token.bin`이 있는가. read()의 null이 "없음"인지 "못 읽음"인지 가른다. */
  fileExists(): boolean;
  /** 토큰 창 (windows/token-window.ts의 openTokenWindow). 확인·저장을 마친 토큰으로 끝난다. */
  onboard(notice: string | null): Promise<string>;
  log(line: string): void;
}

export async function runTokenGate(d: TokenGateDeps): Promise<TokenGateResult> {
  if (!d.store.available()) {
    d.log("키체인 암호화(safeStorage)를 쓸 수 없어 서비스를 띄우지 않아요.");
    return { kind: "blocked", detail: CAUSES.safeStorageUnavailable.text };
  }
  const stored = d.store.read();
  if (stored !== null) return { kind: "ready", token: stored };

  const unreadable = d.fileExists();
  d.log(
    unreadable
      ? "허깅페이스 토큰 파일을 풀지 못했어요 — 파일은 그대로 두고 토큰 창을 띄웁니다. 서비스는 아직 띄우지 않았어요."
      : "허깅페이스 토큰이 없어요 — 토큰 창을 띄웁니다. 서비스는 아직 띄우지 않았어요.",
  );
  try {
    const token = await d.onboard(unreadable ? UNREADABLE_TOKEN_NOTICE : null);
    return { kind: "ready", token };
  } catch (e) {
    if (e instanceof TokenWindowClosed) return { kind: "quit" };
    throw e;
  }
}
