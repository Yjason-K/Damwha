import type { TokenStore } from "../config/token-store";

/**
 * 기동 때 HF 토큰을 **읽기만** 한다 (스펙 2026-09-25 §5.1 — Phase 4 §6.4의 첫 실행 게이트를 대체한다).
 * 창을 띄우지도, 기동을 막지도 않는다. 토큰이 없으면 서비스는 HF_TOKEN 없이 뜨고, fe의 게이트가 화자 분리가
 * 필요한 동작을 막는다. main.ts는 electron을 값으로 import해 테스트가 못 부르므로 판정은 여기 있다.
 *
 * | 상태 | 뜻 |
 * | --- | --- |
 * | `unavailable` | safeStorage를 쓸 수 없다 — 읽지 않는다. 평문 폴백은 없다 |
 * | `present` | 저장된 토큰을 읽었다 |
 * | `absent` | 파일이 없다 |
 * | `unreadable` | 파일은 있는데 못 풀었다 — **파일은 그대로 둔다**. 새 토큰을 저장하면 덮어쓴다 |
 */
export type BootTokenStatus = "present" | "absent" | "unreadable" | "unavailable";

export interface BootToken {
  status: BootTokenStatus;
  /** status가 present일 때만 값이 있다. */
  token: string | null;
}

export interface BootTokenDeps {
  store: TokenStore;
  /** `<userData>/hf-token.bin`이 있는가. read()의 null이 "없음"인지 "못 읽음"인지 가른다. */
  fileExists(): boolean;
  log(line: string): void;
}

export function readBootToken(d: BootTokenDeps): BootToken {
  if (!d.store.available()) {
    d.log("키체인 암호화(safeStorage)를 쓸 수 없어 허깅페이스 토큰 없이 서비스를 띄워요.");
    return { status: "unavailable", token: null };
  }
  const stored = d.store.read();
  if (stored !== null) return { status: "present", token: stored };
  if (d.fileExists()) {
    d.log("허깅페이스 토큰 파일을 풀지 못했어요 — 파일은 그대로 두고 토큰 없이 서비스를 띄워요.");
    return { status: "unreadable", token: null };
  }
  d.log("허깅페이스 토큰이 없어요 — 토큰 없이 서비스를 띄워요. 담화 화면에서 넣을 수 있어요.");
  return { status: "absent", token: null };
}
