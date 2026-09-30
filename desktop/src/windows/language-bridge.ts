import { isUiLanguage, type UiLanguage } from "../i18n/locale";

/**
 * 담화 화면 안의 화면 언어 — **흐름** (다국어 스펙 §4.1). 잎(executeJavaScript·파일 쓰기·메뉴 재구성)은
 * main.ts가 주입한다. 이 파일은 electron을 import하지 않는다.
 *
 * "main이 묻고 페이지가 답한다" — 렌더러 → main 채널을 만들지 않는다(Phase 2 스펙 §6.11). 페이지에서
 * 나오는 값은 main이 건 호출의 반환값뿐이다. 쓰기 직렬화는 필요 없다: 언어 변경은 멱등이고 마지막 값이
 * 이긴다. 필요한 것은 **페이지 세대**다 — ⌘R 전 문서의 묻기가 늦게 끝나 새 문서에 옛 값을 밀어 넣지 않게.
 */
export const UI_LANGUAGE_ASK_SCRIPT =
  "window.__damwha_desktop?.uiLanguage ? window.__damwha_desktop.uiLanguage.next() : null";

/** 값은 JSON으로만 싣는다 — 문자열을 스크립트에 이어 붙이면 따옴표 하나로 주입이 된다(status-view.ts의 renderCall과 같은 규칙). */
export function uiLanguageShowCall(lang: UiLanguage): string {
  return `void window.__damwha_desktop?.uiLanguage?.show(${JSON.stringify(lang)});`;
}

export interface LanguageBridgeDeps<W> {
  run(win: W, script: string): Promise<unknown>;
  alive(win: W): boolean;
  /** 기동 시 값 — 저장값 ?? 기기 언어. 처음 쓸 때 한 번 부른다(app ready 전에 부르지 않게). */
  initial(): UiLanguage;
  /** 파일에 쓴다. 던지면 화면을 이전 값으로 되돌린다. */
  save(lang: UiLanguage): void;
  /** 값이 실제로 바뀌었다 — 메뉴 재구성 등. */
  onChange(lang: UiLanguage): void;
  log(line: string): void;
}

export interface LanguageBridge<W> {
  /** 담화 화면이 붙었다 — 첫 로드와 ⌘R 모두. 현재 값을 밀어 넣고 새 고리를 연다. 옛 고리는 낡는다. */
  attach(win: W): void;
  current(): UiLanguage;
}

function nameOf(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : typeof e;
}

export function createLanguageBridge<W>(d: LanguageBridgeDeps<W>): LanguageBridge<W> {
  let value: UiLanguage | null = null;
  let page = 0;
  const current = (): UiLanguage => (value ??= d.initial());

  const push = (win: W) => {
    if (!d.alive(win)) return;
    d.run(win, uiLanguageShowCall(current())).catch((e: unknown) => {
      if (d.alive(win)) d.log(`담화 화면에 화면 언어를 알리지 못했어요 (${nameOf(e)}).`);
    });
  };

  const loop = async (win: W, gen: number): Promise<void> => {
    for (;;) {
      if (gen !== page || !d.alive(win)) return;
      let raw: unknown;
      try {
        raw = await d.run(win, UI_LANGUAGE_ASK_SCRIPT);
      } catch (e) {
        if (d.alive(win)) d.log(`화면 언어 요청을 기다리지 못했어요 (${nameOf(e)}).`);
        return;
      }
      if (gen !== page) return; // ⌘R 전 문서의 답 — 버린다
      if (raw === null) return; // 다리가 없는 페이지
      if (!isUiLanguage(raw)) {
        d.log(`알 수 없는 화면 언어 요청을 버렸어요 (${JSON.stringify(raw)}).`);
        continue;
      }
      if (raw !== current()) {
        // save 실패는 값 자체가 안 바뀐 것 — 이전 값으로 되돌렸다고 말해도 맞다.
        // onChange 실패는 값은 이미 바뀌었고 메뉴 재구성만 못한 것 — 다른 원인, 다른 문구.
        try {
          d.save(raw);
          value = raw;
        } catch (e) {
          d.log(`화면 언어를 저장하지 못해 이전 값으로 되돌렸어요 (${nameOf(e)}).`);
        }
        if (value === raw) {
          try {
            d.onChange(raw);
          } catch (e) {
            d.log(`화면 언어는 바꿨지만 메뉴를 다시 만들지 못했어요 (${nameOf(e)}).`);
          }
        }
      }
      push(win);
    }
  };

  return {
    attach(win) {
      const gen = ++page;
      push(win);
      void loop(win, gen);
    },
    current,
  };
}
