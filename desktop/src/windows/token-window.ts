import { CAUSES } from "../diagnostics/causes";
import {
  HF_GATED_MODEL_PAGE_URL,
  HF_TOKENS_PAGE_URL,
  maskToken,
  type TokenVerdict,
} from "../config/token-store";

/**
 * 첫 실행의 토큰 창 (Phase 4 스펙 §6.4) — **흐름**. 창을 만들고 스크립트를 부르는 잎(BrowserWindow,
 * executeJavaScript, shell.openExternal, app.quit)은 main.ts가 주입한다. 이 파일은 electron을 import하지 않는다
 * (status-window.ts와 같은 나눔).
 *
 * 렌더러 → main 채널을 만들지 않는다 (Phase 2 스펙 §6.11 — preload도 IPC도 없다). 대신 main이 페이지에
 * **묻는다**: `ASK_SCRIPT`는 사람이 무언가 할 때까지 끝나지 않는 프라미스를 돌려주고, executeJavaScript는 그
 * 결과를 기다린다. 반환값은 main이 건 호출의 결과이지 렌더러가 연 채널이 아니다 — Phase 2가 종료 핸드셰이크에서
 * 세운 논리 그대로다. 페이지가 보내는 것은 두 모양뿐이고(parseAction), 링크는 **열쇠**만 보낸다 — 어느 주소를
 * 열지는 main이 고정 표(TOKEN_LINKS)로 정한다. 앱 창 안에서 huggingface.co를 열지 않는다(origin 경계 밖).
 *
 * 건너뛰기가 없다. 창을 닫으면 앱이 종료된다 — `quit()`을 부르고 TokenWindowClosed로 거부한다.
 */

export type TokenLink = "accept" | "tokens";

/** 페이지의 두 링크가 여는 주소. 페이지가 주소를 보내지 않는다. */
export const TOKEN_LINKS: Readonly<Record<TokenLink, string>> = Object.freeze({
  accept: HF_GATED_MODEL_PAGE_URL,
  tokens: HF_TOKENS_PAGE_URL,
});

export type TokenPageAction = { kind: "submit"; token: string } | { kind: "open"; link: TokenLink };

/** 페이지가 그리는 것. message는 HF 응답 문구를 담을 수 있다 — 페이지는 textContent로만 넣는다. */
export interface TokenPageState {
  busy: boolean;
  tone: "info" | "warn" | "error" | null;
  message: string | null;
}

/** 페이지에 다음 동작을 묻는다. 다리가 없으면(스크립트가 안 돌았다) null이다. */
export const ASK_SCRIPT = "window.__damwha_token ? window.__damwha_token.next() : null";

/** 상태를 그리는 호출문. 값은 JSON으로만 싣는다 — status-view.ts의 renderCall과 같은 이유. */
export function showCall(state: TokenPageState): string {
  return `void window.__damwha_token?.show(${JSON.stringify(state)});`;
}

/** 페이지에서 온 값. 렌더러 데이터이므로 모양을 확인하고, 모르는 것은 null이다. */
export function parseAction(raw: unknown): TokenPageAction | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { kind?: unknown; token?: unknown; link?: unknown };
  if (r.kind === "submit") {
    return typeof r.token === "string" && r.token.length <= MAX_TOKEN_INPUT ? { kind: "submit", token: r.token } : null;
  }
  if (r.kind === "open") {
    return typeof r.link === "string" && Object.prototype.hasOwnProperty.call(TOKEN_LINKS, r.link)
      ? { kind: "open", link: r.link as TokenLink }
      : null;
  }
  return null;
}

/** 사람이 창을 닫았다 — 실패가 아니라 종료다. 게이트가 이것을 "quit"으로 읽는다. */
export class TokenWindowClosed extends Error {
  constructor() {
    super("토큰 창을 닫았어요.");
    this.name = "TokenWindowClosed";
  }
}

export interface TokenWindowDeps<W> {
  /** 첫 화면의 안내. 파일은 있는데 못 읽은 경우의 "토큰을 읽을 수 없어요 — 다시 입력해 주세요". */
  notice: string | null;
  /** token.html을 건 창을 만든다. 로드가 실패하면 onLoadError를 부른다. */
  create(onLoadError: (e: unknown) => void): W;
  alive(win: W): boolean;
  /** 문서가 로드를 마칠 때마다 — 첫 로드와 ⌘R 새로 고침 모두. */
  onLoad(win: W, listener: () => void): void;
  onClosed(win: W, listener: () => void): void;
  /** main → 렌더러 (executeJavaScript). 식이 프라미스면 그 결과를 기다린다. */
  run(win: W, script: string): Promise<unknown>;
  close(win: W): void;
  /** 기본 브라우저로 연다 (shell.openExternal). */
  openExternal(url: string): Promise<void>;
  /** 앱을 끝낸다 (app.quit). */
  quit(): void;
  /**
   * 창을 닫으면 앱이 끝나는가. 기본은 true — **첫 실행 게이트**에는 건너뛰기가 없다.
   *
   * 상태 창의 "토큰 바꾸기"(Task 11)는 false로 연다. 그쪽은 이미 토큰이 있고 서비스가 돌고 있어
   * "닫았다"가 "그만두겠다"이지 "앱을 끝내겠다"가 아니다 — 둘을 한 값으로 두면 설정 창을 닫은
   * 사람의 앱이 꺼진다.
   */
  closeQuitsApp?: boolean;
  log(line: string): void;
  /** HF에 묻는다 (verifyHfToken). */
  verify(token: string): Promise<TokenVerdict>;
  /** 확인된 토큰을 저장한다 (TokenStore.write). 던지면 창이 남고 다시 받는다. */
  save(token: string): void;
}

const MAX_TOKEN_INPUT = 4096;

const EMPTY_MESSAGE = "토큰을 붙여 넣은 뒤 확인을 눌러 주세요.";
const CHECKING_MESSAGE = "허깅페이스에서 토큰을 확인하고 있어요…";
const SAVE_FAILED_MESSAGE =
  "토큰은 확인했지만 키체인에 저장하지 못했어요. 키체인 잠금을 확인한 뒤 다시 확인을 눌러 주세요.";

function verdictMessage(v: Extract<TokenVerdict, { ok: false }>): string {
  if (v.kind === "invalid") return `${CAUSES.hfTokenInvalid.text} (${v.detail}) 토큰을 확인하고 다시 입력해 주세요.`;
  return `지금은 확인할 수 없어요 (${v.detail}). 인터넷 연결을 확인한 뒤 다시 확인을 눌러 주세요. 토큰은 저장하지 않았어요.`;
}

/** 예외의 이름만. 메시지에는 무엇이 담겼는지 모른다. */
function nameOf(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

/**
 * 토큰 창을 띄우고 **확인·저장까지 마친** 토큰으로 끝난다.
 *
 * - 확인(verify)이 ok가 아니면 저장하지 않고, 사유를 화면에 싣고 다시 묻는다. invalid와 offline은 다른 문구다.
 * - 저장(save)이 던지면 창을 닫지 않는다 — 원래 예외 문구는 화면에도 로그에도 옮기지 않는다.
 * - 사람이 창을 닫으면 `quit()` 후 TokenWindowClosed로 거부한다. 확인 중에 닫혀도 늦게 온 결과는 버린다.
 * - 페이지를 못 띄우거나 다리가 없으면(null) 창을 닫고 **종료하지 않고** 거부한다 — 실패 화면과 "다시 시도"의 몫이다.
 * - 새로 고침(⌘R)하면 새 페이지에 지금 상태를 다시 그리고 새로 묻는다. 옛 페이지의 답은 버린다.
 * - 토큰은 페이지로 되돌려 보내지도, 로그에 적지도 않는다. 저장한 사실은 가린 모양으로 적는다.
 */
export function openTokenWindow<W>(d: TokenWindowDeps<W>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    /** 페이지 세대. 로드마다 오른다 — 그 전 세대의 묻기는 낡았다. */
    let page = 0;
    let state: TokenPageState = {
      busy: false,
      tone: d.notice === null ? null : "warn",
      message: d.notice,
    };

    /** 우리가 닫는다 — 종료가 아니다. */
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      d.log(why);
      if (d.alive(win)) d.close(win);
      reject(new Error(why));
    };

    // 한 박자 미룬다 — 잎이 create 안에서 동기로 부르면 아래 win이 아직 없다.
    const win = d.create((e) => queueMicrotask(() => fail(`토큰 화면을 띄우지 못했어요 (${nameOf(e)}).`)));

    d.onClosed(win, () => {
      if (settled) return;
      settled = true;
      // 사람이 닫았거나 종료(⌘Q)가 닫았다 — 둘 다 여기로 온다. 앞의 경우 quit()이 종료를 시작하고, 뒤의 경우 이미 도는 종료에 겹쳐 무해하다.
      if (d.closeQuitsApp === false) {
        d.log("토큰 창을 닫았어요 — 토큰을 바꾸지 않았습니다.");
      } else {
        d.log("토큰 창이 닫혔어요 — 토큰 없이는 시작하지 않으므로 앱을 종료합니다.");
        d.quit();
      }
      reject(new TokenWindowClosed());
    });

    const push = () => {
      if (!d.alive(win)) return;
      let pending: Promise<unknown>;
      try {
        pending = d.run(win, showCall(state));
      } catch (e) {
        if (d.alive(win)) d.log(`토큰 화면을 갱신하지 못했어요 (${nameOf(e)}).`);
        return;
      }
      pending.catch((e: unknown) => {
        if (d.alive(win)) d.log(`토큰 화면을 갱신하지 못했어요 (${nameOf(e)}).`);
      });
    };

    const setState = (next: TokenPageState) => {
      state = next;
      push();
    };

    const submit = async (raw: string) => {
      const token = raw.trim();
      if (token === "") {
        setState({ busy: false, tone: "error", message: EMPTY_MESSAGE });
        return;
      }
      setState({ busy: true, tone: "info", message: CHECKING_MESSAGE });
      let verdict: TokenVerdict;
      try {
        verdict = await d.verify(token);
      } catch (e) {
        verdict = { ok: false, kind: "offline", detail: `확인 중 오류 (${nameOf(e)})` };
      }
      if (settled) return;
      if (!verdict.ok) {
        d.log(`허깅페이스 토큰을 확인하지 못했어요 (${verdict.kind}) — ${verdict.detail}`);
        setState({ busy: false, tone: "error", message: verdictMessage(verdict) });
        return;
      }
      try {
        d.save(token);
      } catch (e) {
        d.log(`허깅페이스 토큰을 확인했지만 저장하지 못했어요 (${nameOf(e)}).`);
        setState({ busy: false, tone: "error", message: SAVE_FAILED_MESSAGE });
        return;
      }
      settled = true;
      d.log(`허깅페이스 토큰을 확인하고 키체인으로 암호화해 저장했어요 — 계정 ${verdict.name}, 토큰 ${maskToken(token)}`);
      if (d.alive(win)) d.close(win);
      resolve(token);
    };

    const handle = async (action: TokenPageAction) => {
      if (action.kind === "open") {
        try {
          await d.openExternal(TOKEN_LINKS[action.link]);
        } catch (e) {
          d.log(`브라우저에서 ${TOKEN_LINKS[action.link]}을(를) 열지 못했어요 (${nameOf(e)}).`);
        }
        return;
      }
      await submit(action.token);
    };

    const ask = async (mine: number) => {
      while (!settled && mine === page && d.alive(win)) {
        let raw: unknown;
        try {
          raw = await d.run(win, ASK_SCRIPT);
        } catch (e) {
          // 새로 고침이 진행 중인 호출을 끊을 수 있다 — 새 페이지의 로드가 다시 묻는다.
          if (!settled && mine === page && d.alive(win)) d.log(`토큰 화면에 묻지 못했어요 (${nameOf(e)}).`);
          return;
        }
        if (settled || mine !== page) return;
        if (raw === null || raw === undefined) {
          fail("토큰 화면의 스크립트가 돌지 않아 토큰을 받을 수 없어요.");
          return;
        }
        const action = parseAction(raw);
        if (action === null) {
          d.log("토큰 화면에서 알 수 없는 요청이 와서 무시했어요.");
          continue;
        }
        await handle(action);
      }
    };

    d.onLoad(win, () => {
      if (settled) return;
      page += 1;
      push();
      void ask(page);
    });
  });
}
