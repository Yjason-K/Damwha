/**
 * 떠 있는 셸 창의 수명과 묻기 고리. 렌더러 → main 채널은 없고, 페이지의 사건은 main이 건 `next()` 호출의
 * 반환값으로만 나온다. 감지 카드와 녹음 알약이 같이 쓴다. electron은 호스트가 주입한다.
 */
export interface AskedWindowHost<W, V, A> {
  /** 창을 만들고 페이지를 건다. 포커스를 뺏지 않고 띄워야 한다. */
  create(): W;
  alive(win: W): boolean;
  /** 창을 닫는다. */
  close(win: W): void;
  /** 문서가 로드를 마칠 때마다 — 첫 로드와 ⌘R 모두. */
  onLoad(win: W, listener: () => void): void;
  onClosed(win: W, listener: () => void): void;
  run(win: W, script: string): Promise<unknown>;
  /** view를 페이지에 그리는 호출문. */
  render(view: V): string;
  /** 페이지에 다음 동작을 묻는 식. */
  askScript: string;
  /** 페이지가 보낸 값은 렌더러 데이터다. 모양이 맞지 않으면 null. */
  parse(raw: unknown): A | null;
  /** 로그에 쓰는 창 이름. 받침 없는 말이어야 조사가 맞는다. */
  what: string;
  /** 던지지 않아야 한다 — 거부되면 묻는 고리가 끊긴다. */
  onAction(answer: A): Promise<void> | void;
  log(line: string): void;
}

export interface AskedWindow<W, V> {
  show(view: V): void;
  hide(): void;
  dispose(): void;
  /** 지금 떠 있는 창. 없으면 null. */
  window(): W | null;
  /** 지금 그리고 있는 view. 창이 닫혔으면 null. */
  view(): V | null;
}

/** 묻는 호출이 연달아 거부돼도 다시 거는 횟수 (status-window.ts와 같다). */
export const ASK_RETRY_LIMIT = 3;

export function createAskedWindow<W, V, A>(host: AskedWindowHost<W, V, A>): AskedWindow<W, V> {
  let current: W | null = null;
  let currentView: V | null = null;
  /** 페이지 세대. 로드·닫힘마다 오른다 — 낡은 세대의 묻기는 답을 받지 않는다. */
  let page = 0;

  const push = (win: W) => {
    if (currentView === null || !host.alive(win)) return;
    let pending: Promise<unknown>;
    try {
      pending = host.run(win, host.render(currentView));
    } catch (e) {
      if (host.alive(win)) host.log(`${host.what}를 그리지 못했어요 — ${reasonOf(e)}`);
      return;
    }
    pending.catch((e: unknown) => {
      if (host.alive(win)) host.log(`${host.what}를 그리지 못했어요 — ${reasonOf(e)}`);
    });
  };

  const ask = async (win: W, mine: number) => {
    let refusals = 0;
    while (mine === page && host.alive(win)) {
      let raw: unknown;
      try {
        raw = await host.run(win, host.askScript);
        refusals = 0;
      } catch (e) {
        if (mine !== page || !host.alive(win)) return;
        refusals += 1;
        host.log(`${host.what}에 묻지 못했어요 (${refusals}/${ASK_RETRY_LIMIT}) — ${reasonOf(e)}`);
        if (refusals < ASK_RETRY_LIMIT) continue;
        return;
      }
      if (mine !== page || !host.alive(win)) return;
      if (raw === null || raw === undefined) {
        host.log(`${host.what}의 스크립트가 돌지 않아 버튼을 쓸 수 없어요.`);
        return;
      }
      const answer = host.parse(raw);
      if (answer === null) {
        host.log(`${host.what}에서 알 수 없는 요청이 와서 무시했어요.`);
        continue;
      }
      try {
        await host.onAction(answer);
      } catch (e) {
        host.log(`${host.what}의 요청을 처리하지 못했어요 — ${reasonOf(e)}`);
      }
    }
  };

  const close = () => {
    page += 1;
    currentView = null;
    const win = current;
    current = null;
    if (win !== null && host.alive(win)) host.close(win);
  };

  return {
    show(view) {
      currentView = view;
      if (current !== null && host.alive(current)) {
        push(current);
        return;
      }
      let created: W;
      try {
        created = host.create();
      } catch (e) {
        host.log(`${host.what}를 열지 못했어요 — ${reasonOf(e)}`);
        return;
      }
      current = created;
      // ⌘R로 다시 로드된 페이지는 빈 채다 — 지금 view를 다시 그리고 새 세대로 묻는다.
      host.onLoad(created, () => {
        push(created);
        page += 1;
        void ask(created, page);
      });
      host.onClosed(created, () => {
        if (current === created) {
          current = null;
          currentView = null;
          page += 1;
        }
      });
    },
    hide: close,
    dispose: close,
    window: () => (current !== null && host.alive(current) ? current : null),
    view: () => currentView,
  };
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
