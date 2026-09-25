import { CAUSES } from "../diagnostics/causes";
import {
  HF_GATED_MODEL_PAGE_URL,
  HF_TOKENS_PAGE_URL,
  maskToken,
  type TokenVerdict,
} from "../config/token-store";
import type { BootTokenStatus } from "../app/token-boot";
import type { TokenChangeResult } from "./apply-token-change";
import type { ServiceId } from "../services/types";

/**
 * 담화 화면 안의 HF 토큰 — **흐름** (스펙 2026-09-25 §4). 잎(executeJavaScript·shell.openExternal·safeStorage·
 * 감독자 재시작)은 main.ts가 주입한다. 이 파일은 electron을 import하지 않는다(status-window.ts와 같은 나눔).
 *
 * 렌더러 → main 채널을 만들지 않는다 (Phase 2 스펙 §6.11). main이 `hfToken.next()`를 **묻고**, 사람이 무언가 하면
 * 그 호출이 답으로 끝난다. 상태는 `hfToken.show(state)` 한 방향으로 밀어 넣는다. 페이지가 보내는 것은 네 모양뿐이고
 * (parseHfTokenAction), 링크는 **열쇠**만 보낸다 — 어느 주소를 열지는 main이 고정 표(LINKS)로 정한다.
 *
 * **submit·clear는 겹치지 않는다** (스펙 §4.2). 고리 하나가 handle을 기다린 뒤 다음을 묻는 것만으로는
 * 모자란다 — ⌘R로 재부착하면 옛 고리가 아직 handle 안(예: verify·apply를 기다리는 중)에 있는 채로 새 고리가
 * 함께 돌 수 있고, 그러면 두 고리가 동시에 저장·재시작을 부를 수 있다(두 번의 applyTokenChange가 worker·embed를
 * 동시에 재시작하거나, 한쪽의 재시작 도중 다른 쪽이 clear로 파일을 지우는 식). 그래서 두 동작은 **브리지 전체가
 * 공유하는 진행 중 표시(mutating)** 하나로 막는다 — 진행 중일 때 온 새 submit·clear는 실행하지 않고 그 자리에서
 * message로만 알린다(옛 tokenBusy의 자리, 이번에는 고리가 아니라 브리지 수준). handle에서 던진 예외도 고리를
 * 끝내지 않는다 — 잡아서 message로 알리고 다음 요청을 계속 받는다.
 */

export type HfTokenStatus = BootTokenStatus;

export interface HfTokenMessage {
  tone: "info" | "warn" | "error";
  text: string;
}

/** 페이지가 받는 상태. **원문은 싣지 않는다** — masked만. message는 HF 응답 문구를 담을 수 있다(fe는 텍스트로만 그린다). */
export interface HfTokenState {
  status: HfTokenStatus;
  masked: string | null;
  /** 이번 실행에서 whoami로 확인했을 때만. */
  account: string | null;
  /** 이번 실행에서 "나중에 하기"를 눌렀나. main 메모리 — 앱을 다시 켜면 false다 (§3.3). */
  onboardingDismissed: boolean;
  busy: boolean;
  message: HfTokenMessage | null;
}

export type HfTokenLink = "accept" | "tokens";

export type HfTokenAction =
  | { kind: "submit"; token: string }
  | { kind: "clear" }
  | { kind: "dismissOnboarding" }
  | { kind: "open"; link: HfTokenLink };

const LINKS: Readonly<Record<HfTokenLink, string>> = Object.freeze({
  accept: HF_GATED_MODEL_PAGE_URL,
  tokens: HF_TOKENS_PAGE_URL,
});

export const MAX_TOKEN_INPUT = 4096;

/** 다음 동작을 묻는 식. 다리가 없으면 null — 고리를 조용히 끝낸다. 이름은 fe의 desktop-bridge.ts와 같아야 한다. */
export const HF_TOKEN_ASK_SCRIPT =
  "window.__damwha_desktop?.hfToken ? window.__damwha_desktop.hfToken.next() : null";

/** 상태를 그리는 호출문. 값은 JSON으로만 싣는다(status-view.ts의 renderCall과 같은 이유). */
export function hfTokenShowCall(state: HfTokenState): string {
  return `void window.__damwha_desktop?.hfToken?.show(${JSON.stringify(state)});`;
}

/** 페이지에서 온 값. 렌더러 데이터이므로 모양을 확인하고, 모르는 것은 null이다. */
export function parseHfTokenAction(raw: unknown): HfTokenAction | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { kind?: unknown; token?: unknown; link?: unknown };
  if (r.kind === "submit") {
    return typeof r.token === "string" && r.token.length <= MAX_TOKEN_INPUT ? { kind: "submit", token: r.token } : null;
  }
  if (r.kind === "clear") return { kind: "clear" };
  if (r.kind === "dismissOnboarding") return { kind: "dismissOnboarding" };
  if (r.kind === "open") {
    return typeof r.link === "string" && Object.prototype.hasOwnProperty.call(LINKS, r.link)
      ? { kind: "open", link: r.link as HfTokenLink }
      : null;
  }
  return null;
}

// 문구 — 옛 token-window.ts에서 옮겼다.
const EMPTY_MESSAGE = "토큰을 붙여 넣은 뒤 확인을 눌러 주세요.";
const UNKNOWN_REQUEST_MESSAGE =
  `토큰을 읽지 못했어요 — 붙여 넣은 값이 너무 길거나(${MAX_TOKEN_INPUT}자까지) 모양이 올바르지 않아요. ` +
  "토큰만 다시 붙여 넣은 뒤 확인을 눌러 주세요.";
const CHECKING_MESSAGE = "허깅페이스에서 토큰을 확인하고 있어요…";
const RECORDING_MESSAGE = "녹음을 마친 뒤 바꿔 주세요.";
const CLEARED_MESSAGE =
  "토큰을 지웠어요. 지금 도는 작업 처리기는 옛 토큰으로 계속 돌지만, 다시 시작하면 토큰 없이 떠요.";
/** 스펙 §4.2 — 진행 중인 submit·clear가 있을 때 온 새 요청. 실행하지 않고 알리기만 한다. */
const BUSY_MESSAGE = "토큰 요청을 처리하는 중이에요. 끝난 뒤 다시 시도해 주세요.";
/** handle이 예외를 던졌을 때 — 고리를 끝내지 않고 알리기만 한다. */
const HANDLE_FAILED_MESSAGE = "토큰 요청을 처리하지 못했어요. 다시 시도해 주세요.";

function verdictMessage(v: Extract<TokenVerdict, { ok: false }>): string {
  if (v.kind === "invalid") return `${CAUSES.hfTokenInvalid.text} (${v.detail}) 토큰을 확인하고 다시 입력해 주세요.`;
  return `지금은 확인할 수 없어요 (${v.detail}). 인터넷 연결을 확인한 뒤 다시 확인을 눌러 주세요. 토큰은 저장하지 않았어요.`;
}

function nameOf(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

export interface TokenBridgeDeps<W> {
  /** main → 렌더러 (executeJavaScript). 식이 프라미스면 그 결과를 기다린다. */
  run(win: W, script: string): Promise<unknown>;
  alive(win: W): boolean;
  /** 담화 화면이 녹음 중인가 (recording-bridge.ts의 askIsRecording — 상한이 있다). */
  isRecording(): Promise<boolean>;
  verify(token: string): Promise<TokenVerdict>;
  /**
   * 확인된 토큰을 저장하고 살아 있는 실행에 닿게 한다 (apply-token-change.ts의 applyTokenChange). 저장·증명
   * 실패는 던진다 — 그때는 아무 서비스도 재시작되지 않았다.
   */
  apply(token: string): Promise<TokenChangeResult>;
  /** 파일·캐시·live env의 HF_TOKEN을 지운다. 재시작하지 않는다. */
  clear(): void;
  openExternal(url: string): Promise<void>;
  /** 서비스 id 목록을 사람이 읽는 이름표로. */
  labels(ids: readonly ServiceId[]): string;
  log(line: string): void;
  /** 상태가 바뀔 때마다 — 상태 창의 토큰 줄을 다시 그리는 데 쓴다. 없어도 된다. */
  onChange?(): void;
}

export interface TokenBridge<W> {
  /** 기동 읽기 결과(app/token-boot.ts)를 싣는다. 감독자를 세울 때마다 부른다. */
  boot(status: HfTokenStatus, masked: string | null): void;
  /** 담화 화면이 붙었다 — 첫 로드와 ⌘R 모두. 상태를 밀어 넣고 새 고리를 연다. 옛 고리는 낡는다. */
  attach(win: W): void;
  state(): HfTokenState;
}

export function createTokenBridge<W>(d: TokenBridgeDeps<W>): TokenBridge<W> {
  let current: W | null = null;
  /** 페이지 세대. attach마다 오른다 — 그 전 세대의 묻기는 낡았다(status-window.ts의 page와 같은 장치). */
  let page = 0;
  /**
   * submit·clear 진행 중 표시 (스펙 §4.2). 고리(page 세대)가 아니라 **브리지** 수준이다 — ⌘R로 두 고리가
   * 동시에 도는 동안에도 이 하나만 본다. `withMutation`만 건드린다.
   */
  let mutating = false;
  let state: HfTokenState = {
    status: "absent",
    masked: null,
    account: null,
    onboardingDismissed: false,
    busy: false,
    message: null,
  };

  const push = () => {
    const win = current;
    if (win === null || !d.alive(win)) return;
    let pending: Promise<unknown>;
    try {
      pending = d.run(win, hfTokenShowCall(state));
    } catch (e) {
      if (d.alive(win)) d.log(`담화 화면에 토큰 상태를 그리지 못했어요 (${nameOf(e)}).`);
      return;
    }
    pending.catch((e: unknown) => {
      if (d.alive(win)) d.log(`담화 화면에 토큰 상태를 그리지 못했어요 (${nameOf(e)}).`);
    });
  };

  const set = (next: Partial<HfTokenState>) => {
    state = { ...state, ...next };
    push();
    d.onChange?.();
  };

  /**
   * submit·clear를 겹치지 않게 한다 (스펙 §4.2). 진행 중이면 새 요청은 **실행하지 않고** message로만
   * 알린다 — 그때 busy는 건드리지 않는다(진행 중인 쪽의 busy:true가 그대로 맞다). run이 던지든 말든
   * mutating은 finally에서 반드시 내린다 — 다음 요청이 영영 막히지 않는다.
   */
  const withMutation = async (run: () => Promise<void>): Promise<void> => {
    if (mutating) {
      set({ message: { tone: "warn", text: BUSY_MESSAGE } });
      return;
    }
    mutating = true;
    try {
      await run();
    } finally {
      mutating = false;
    }
  };

  const submit = async (raw: string) => {
    const token = raw.trim();
    if (state.status === "unavailable") {
      set({ busy: false, message: { tone: "error", text: CAUSES.safeStorageUnavailable.text } });
      return;
    }
    if (token === "") {
      set({ busy: false, message: { tone: "error", text: EMPTY_MESSAGE } });
      return;
    }
    if (await d.isRecording()) {
      set({ busy: false, message: { tone: "warn", text: RECORDING_MESSAGE } });
      return;
    }
    set({ busy: true, message: { tone: "info", text: CHECKING_MESSAGE } });
    let verdict: TokenVerdict;
    try {
      verdict = await d.verify(token);
    } catch (e) {
      verdict = { ok: false, kind: "offline", detail: `확인 중 오류 (${nameOf(e)})` };
    }
    if (!verdict.ok) {
      d.log(`허깅페이스 토큰을 확인하지 못했어요 (${verdict.kind}) — ${verdict.detail}`);
      set({ busy: false, message: { tone: "error", text: verdictMessage(verdict) } });
      return;
    }
    let result: TokenChangeResult;
    try {
      result = await d.apply(token);
    } catch (e) {
      // 원래 예외 문구는 apply-token-change.ts의 고정 문구이거나, 그 안의 store.write가 다시 던진
      // 원본 fs 오류(경로 등)다 — 어느 쪽이든 토큰 원문은 담기지 않는다.
      const why = e instanceof Error ? e.message : nameOf(e);
      d.log(`허깅페이스 토큰을 저장하지 못했어요 — ${why}`);
      set({ busy: false, message: { tone: "error", text: `토큰을 저장하지 못했어요 — ${why}` } });
      return;
    }
    d.log(`허깅페이스 토큰을 확인하고 저장했어요 — 계정 ${verdict.name}, 토큰 ${maskToken(token)}`);
    const skipped = result.skipped.length > 0 ? ` 다시 시작하지 못함: ${d.labels(result.skipped)}.` : "";
    set({
      status: "present",
      masked: maskToken(token),
      account: verdict.name,
      // 이번 실행에서 토큰을 이미 다뤘다 — 다음에 absent로 돌아가도(설정에서 지움) 온보딩이
      // Settings 위로 저절로 뜨면 안 된다. 다음 실행에는 새 브리지가 서므로 여전히 false다.
      onboardingDismissed: true,
      busy: false,
      message: {
        tone: result.skipped.length > 0 ? "warn" : "info",
        text: `토큰을 저장했어요 — 계정 ${verdict.name}.${skipped}`,
      },
    });
  };

  const handle = async (action: HfTokenAction) => {
    switch (action.kind) {
      case "submit":
        await withMutation(() => submit(action.token));
        return;
      case "clear":
        await withMutation(async () => {
          try {
            d.clear();
          } catch (e) {
            d.log(`허깅페이스 토큰을 지우지 못했어요 (${nameOf(e)}).`);
            set({ message: { tone: "error", text: "토큰을 지우지 못했어요. 다시 시도해 주세요." } });
            return;
          }
          d.log("허깅페이스 토큰을 지웠어요 — 서비스는 다시 시작하지 않았어요.");
          set({
            status: "absent",
            masked: null,
            account: null,
            // submit과 같은 이유 — 방금 지운 사람에게 Settings 위로 온보딩이 곧바로 다시 뜨면 안 된다.
            onboardingDismissed: true,
            message: { tone: "info", text: CLEARED_MESSAGE },
          });
        });
        return;
      case "dismissOnboarding":
        set({ onboardingDismissed: true });
        return;
      case "open":
        try {
          await d.openExternal(LINKS[action.link]);
        } catch (e) {
          d.log(`브라우저에서 ${LINKS[action.link]}을(를) 열지 못했어요 (${nameOf(e)}).`);
        }
        return;
    }
  };

  const ask = async (win: W, mine: number) => {
    while (mine === page && d.alive(win)) {
      let raw: unknown;
      try {
        raw = await d.run(win, HF_TOKEN_ASK_SCRIPT);
      } catch {
        // 새로 고침·창 닫기가 진행 중인 호출을 끊는다 — 다음 attach가 다시 묻는다.
        return;
      }
      if (mine !== page) return;
      // 다리가 없는 문서(웹 화면·옛 빌드) — 빈 고리를 돌지 않는다.
      if (raw === null || raw === undefined) return;
      const action = parseHfTokenAction(raw);
      if (action === null) {
        d.log("담화 화면에서 알 수 없는 토큰 요청이 와서 무시했어요.");
        set({ busy: false, message: { tone: "error", text: UNKNOWN_REQUEST_MESSAGE } });
        continue;
      }
      try {
        await handle(action);
      } catch (e) {
        // handle이 던지면(예: isRecording 거부) 고리를 끝내지 않는다 — 페이지가 영영 busy로 잠기면 안 된다.
        // 원문(페이로드)은 싣지 않는다 — nameOf만.
        d.log(`허깅페이스 토큰 요청을 처리하지 못했어요 (${nameOf(e)}).`);
        set({ busy: false, message: { tone: "error", text: HANDLE_FAILED_MESSAGE } });
      }
    }
  };

  return {
    boot(status, masked) {
      state = { ...state, status, masked: status === "present" ? masked : null, account: null, busy: false, message: null };
      push();
      d.onChange?.();
    },
    attach(win) {
      current = win;
      page += 1;
      push();
      void ask(win, page);
    },
    state: () => state,
  };
}
