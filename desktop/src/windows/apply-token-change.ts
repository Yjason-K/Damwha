import { restartRefused } from "../services/supervisor";
import type { TokenStore } from "../config/token-store";
import type { ServiceId, ServiceStatus } from "../services/types";

/**
 * 토큰 교체를 **살아 있는 실행에 닿게** 한다 (Phase 4 스펙 §6.4·§6.10 2층).
 *
 * 저장만으로는 안 된다. 감독자가 쥔 `ctx.env`는 기동 시점에 얼어붙고, 기존 설정 재적용
 * (`config/config-reload.ts`)은 **`config.json`만** 읽는다 — 토큰은 거기 없다(Keychain에 있다).
 * 그래서 이 모듈이 세 가지를 한 번에 한다: 저장 → 증명 → live env·캐시 → 재시작.
 *
 * **순서가 계약이다.**
 *
 * 1. `store.write` — 원자적 쓰기. 던지면 여기서 끝난다.
 * 2. `store.read` — **다시 읽어** 암호화·복호화 왕복을 그 자리에서 증명한다. 못 읽으면 재시작
 *    **전에** 던진다: 재시작한 뒤 "왜 안 되지"보다 지금 "저장하지 못했어요"가 낫고, 증명되지 않은
 *    토큰으로 멀쩡히 도는 서비스를 내리면 되돌릴 것이 없다.
 * 3. live env와 main.ts의 캐시를 **같이** 갱신한다. 하나만 바꾸면 갈린다 — `main.ts`의 모듈 전역
 *    `hfToken`은 실패한 `start()` 뒤 감독자를 다시 세울 때 `launchEnv`에 실리므로, 그것을 안 바꾸면
 *    그 재생성이 옛 토큰을 되살린다(Task 6 인계).
 * 4. **앱이 소유한 서비스만** 다시 시작하고, 못 한 것을 결과에 실어 화면이 말하게 한다.
 *
 * 거부는 예외가 아니다. 채택한 외부 embed·stand-down worker·정리 중인 서비스는 `skipped`로 간다 —
 * 예외로 올리면 토큰 교체 전체가 한 서비스 때문에 실패하고, 그 서비스는 애초에 앱이 내릴 수 없는
 * 것이라 사람이 할 수 있는 일도 없다.
 */

/**
 * 토큰을 받는 서비스. `config/config.ts`의 `PYTHON_ONLY_ENV_KEYS`가 `HF_TOKEN`을 python 자식에게만
 * 주므로 api·postgres를 다시 시작해 봐야 바뀌는 것이 없다 — 괜히 DB를 내리면 그 위의 전부가 흔들린다.
 */
export const TOKEN_SERVICES: readonly ServiceId[] = ["worker", "embed"];

export interface TokenChangeDeps {
  store: TokenStore;
  /** 감독자가 쥔 `ctx.env` **그 객체**. 새 객체를 주면 갱신이 아무 데도 안 닿는다. */
  liveEnv: Record<string, string>;
  restartService(id: ServiceId): Promise<void>;
  /** 앱이 이 서비스를 내릴 수 있나. `ownedByStatus`가 감독자 상태에서 만든다. */
  owned(id: ServiceId): boolean;
  /**
   * main.ts의 모듈 전역 토큰 캐시를 갱신한다 (위 3번). 계약(common-context)의 네 항목에 더한
   * 다섯째다 — 그 인계가 없으면 이 함수가 성립시키려는 성질("교체가 살아 있는 실행에 닿는다")이
   * 감독자 재생성 한 번에 무너진다.
   */
  cacheToken(token: string): void;
}

export interface TokenChangeResult {
  restarted: ServiceId[];
  /** 앱이 내릴 수 없었거나 재시작이 끝내 실패한 서비스. 까닭은 supervisor.log에 있다. */
  skipped: ServiceId[];
}

export async function applyTokenChange(
  d: TokenChangeDeps,
  token: string,
): Promise<TokenChangeResult> {
  const value = token.trim();
  if (value === "") throw new Error("빈 토큰은 저장하지 않아요.");

  d.store.write(value);
  // 왕복 증명. store.write도 내부에서 한 번 보지만(token-store.ts), 그것은 **메모리의** 암호문이고
  // 이것은 **디스크에 닿은** 파일이다 — rename이 끝난 뒤 그 파일이 정말 풀리는지는 여기서만 안다.
  if (d.store.read() !== value) {
    throw new Error("토큰을 저장했지만 다시 읽지 못했어요. 서비스를 다시 시작하지 않았어요.");
  }

  d.liveEnv.HF_TOKEN = value;
  d.cacheToken(value);

  const restarted: ServiceId[] = [];
  const skipped: ServiceId[] = [];
  // 차례로 돈다. 동시에 내리면 두 서비스의 정지 유예가 겹쳐 어느 쪽이 왜 안 내려갔는지 로그에서
  // 갈라 읽기 어렵고, worker의 정지는 최대 90초라 그 사이 embed의 실패가 묻힌다.
  for (const id of TOKEN_SERVICES) {
    if (!d.owned(id)) {
      skipped.push(id);
      continue;
    }
    try {
      await d.restartService(id);
      restarted.push(id);
    } catch {
      // 감독자의 거부는 던지지 않는다(restartOnce). 여기 오는 것은 그 밖의 실패이고, 까닭은
      // 감독자가 이미 supervisor.log에 적었다 — 토큰 교체가 그 하나 때문에 통째로 실패하지 않는다.
      skipped.push(id);
    }
  }
  return { restarted, skipped };
}

/**
 * 감독자 상태에서 `owned`를 만든다. 판정은 감독자의 `restartRefused` **하나**다 — 여기서 조건을
 * 다시 적으면 버튼이 켜져 있는데 토큰 교체는 건너뛰는(또는 그 반대) 상태가 생긴다.
 *
 * 감독자가 모르는 서비스는 소유하지 않은 것으로 본다. 그 id의 런타임이 없으면 `restartService`가
 * 쥘 것도 없다.
 */
export function ownedByStatus(
  statuses: readonly ServiceStatus[],
): (id: ServiceId) => boolean {
  return (id) => {
    const s = statuses.find((x) => x.id === id);
    return s !== undefined && !restartRefused(s);
  };
}
