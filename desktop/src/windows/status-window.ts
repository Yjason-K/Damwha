import {
  parseServicesAction,
  renderCall,
  SERVICES_ASK_SCRIPT,
  type ServicesAction,
  type ServicesView,
} from "./status-view";
import type { ServiceId, ServiceStatus } from "../services/types";

/**
 * 서비스 상태 창의 **수명과 갱신 규칙**. 창을 만들고 스크립트를 부르는 잎(BrowserWindow,
 * executeJavaScript)은 electron이라 main.ts가 주입한다 — 이 파일은 electron을 import하지 않는다.
 *
 * 이 창이 있어야 하는 이유: 담화 화면이 붙은 뒤에는 준비 화면이 다시 그려지지 않으므로
 * (shell-latch.ts) 앱을 쓰는 동안 서비스 상태를 볼 곳이 이것뿐이다. 완료 기준 P2-C1·C6·C10·C11이
 * 전부 "앱 화면이 떠 있는 채로 상태 창에서 본다"이고, C11은 `degraded`가 `ok`로 **돌아오는 것**을
 * 보는 기준이라 연 순간의 스냅숏으로는 판정할 수 없다 — 감독자가 상태를 낼 때마다 다시 그린다.
 *
 * **렌더러에서 main으로 오는 경로를 만들지 않는다** (스펙 §6.11 — preload도 IPC도 없다). Phase 4의
 * 버튼(토큰 설정 §6.4, "서비스 다시 시작" §6.10 2층)도 그 규칙 안에 있다: main이 페이지에 **묻고**
 * (`SERVICES_ASK_SCRIPT`), 사람이 무언가 누르면 그 호출이 답으로 끝난다. 밖으로 나오는 값은 main이
 * 건 호출의 결과이지 렌더러가 연 채널이 아니다 — `windows/token-window.ts`가 세운 논리 그대로다.
 */
export interface StatusWindowHost<W> {
  /** 창을 만들고 services.html을 건다. `focus`가 false면 포커스를 뺏지 않고 띄운다. */
  create(focus: boolean): W;
  /** 파괴되지 않았는가. */
  alive(win: W): boolean;
  /** 앞으로 가져온다. */
  focus(win: W): void;
  /** 문서가 로드를 마칠 때마다 — 첫 로드와 ⌘R 새로 고침 모두. */
  onLoad(win: W, listener: () => void): void;
  onClosed(win: W, listener: () => void): void;
  /** main → 렌더러 한 방향 (executeJavaScript). */
  run(win: W, script: string): Promise<unknown>;
  /** 지금 그릴 것. */
  view(): ServicesView;
  /** 지금 감독자의 상태. 감독자가 없으면 빈 배열. */
  statuses(): readonly ServiceStatus[];
  /** 앱이 스스로 창을 띄워도 되는 순간인가 (mayAutoOpen). */
  mayAutoOpen(): boolean;
  /**
   * 사람이 이 창에서 무언가 눌렀다 (스펙 §6.4·§6.10 2층). **던지지 않아야 한다** — 이 호출이 거부되면
   * 묻는 고리가 끊겨 그 뒤의 버튼이 전부 죽는다. 배선(main.ts)이 자기 실패를 화면과 로그로 바꾼다.
   */
  onAction(action: ServicesAction): Promise<void> | void;
  log(line: string): void;
}

export interface AutoOpenGate {
  /** before-quit이 이미 지나갔다. 종료 중인 앱에 새 창을 띄우지 않는다(activate와 같은 규칙). */
  quitting: boolean;
  /** 메인 창이 살아 있다. */
  hasWindow: boolean;
  /** 메인 창이 지금 담화 화면을 보고 있다 (!mayRenderShell). */
  rendererAttached: boolean;
}

/**
 * 실패가 났을 때 상태 창을 앱이 스스로 띄워도 되는가.
 *
 * - 담화 화면이 붙기 **전**에는 띄우지 않는다. 그때의 실패는 메인 창의 실패 화면이 이미 원인과
 *   안내를 보여주고, 게이트 실패면 자동 재시도(3·8·20초)마다 같은 창이 또 튀어나온다.
 * - 메인 창이 **없으면** 띄우지 않는다. 사용자가 방금 닫은 앱이 화면 한가운데 창을 여는 셈이다 —
 *   announceRestartNotice가 같은 이유로 창 없을 때 대화상자를 띄우지 않는다. 그 실패는 버리지
 *   않고 남겨 뒀다가, 창을 다시 열어 담화 화면이 붙은 뒤(reconsider) 띄운다.
 */
export function mayAutoOpen(gate: AutoOpenGate): boolean {
  if (gate.quitting) return false;
  return gate.hasWindow && gate.rendererAttached;
}

export interface StatusWindow {
  /** 메뉴의 "서비스 상태". 있으면 앞으로 가져오고, 없으면 만든다. */
  open(): void;
  /** 감독자가 상태를 낼 때마다. 필요하면 창을 스스로 띄우고, 떠 있으면 다시 그린다. */
  onStatus(statuses: readonly ServiceStatus[]): void;
  /** 담화 화면이 막 붙었다. 붙기 전에 미뤄 둔 실패가 있으면 지금 띄운다. */
  reconsider(): void;
  /** 상태 밖의 재료(재시작 안내)가 바뀌었다. 떠 있으면 다시 그린다. */
  refresh(): void;
  /**
   * 지금 창이 떠 있나. 배선이 **볼 사람이 있을 때만** 값을 읽으려고 묻는다 — 모델 준비 행을 읽는
   * 것은 psql 프로세스 하나라(main.ts의 modelReadinessReader) 닫힌 창을 위해 2초마다 띄우면 낭비다.
   */
  isOpen(): boolean;
}

export function createStatusWindow<W>(host: StatusWindowHost<W>): StatusWindow {
  let current: W | null = null;
  /**
   * 페이지 세대. 로드마다 오른다 — ⌘R 뒤의 새 페이지는 새 다리를 갖고, 그 전 세대의 묻기는 낡았다
   * (token-window.ts의 `page`와 같은 장치, 같은 까닭).
   */
  let page = 0;
  /**
   * 이미 한 번 띄워 알린 실패. `running`에 닿으면 지운다 — 다음 실패는 새 사건이다.
   *
   * `failed`가 아닌 모든 상태에서 지우면 백오프 재시작(failed → starting → failed)이 시도마다
   * 창을 다시 띄운다. 사용자가 닫은 창이 몇 초마다 되살아나는 것은 알림이 아니라 방해다.
   */
  const announced = new Set<ServiceId>();

  const pushTo = (win: W) => {
    if (!host.alive(win)) return;
    let pending: Promise<unknown>;
    try {
      pending = host.run(win, renderCall(host.view()));
    } catch (e) {
      // 파괴와 겹치면 webContents 접근이 동기로 던진다.
      if (host.alive(win)) host.log(`상태 창을 갱신하지 못했어요 — ${reasonOf(e)}`);
      return;
    }
    pending.catch((e: unknown) => {
      // 창이 닫히는 순간과 겹친 거부는 예상된 일이라 적지 않는다. 살아 있는 창에서의 거부는
      // 렌더 함수의 결함이다 — 삼키면 상태 창이 조용히 멈춘 채로 남는다.
      if (host.alive(win)) host.log(`상태 창을 갱신하지 못했어요 — ${reasonOf(e)}`);
    });
  };

  const push = () => {
    if (current !== null) pushTo(current);
  };

  const show = (focus: boolean) => {
    if (current !== null && host.alive(current)) {
      if (focus) host.focus(current);
      return;
    }
    let created: W;
    try {
      created = host.create(focus);
    } catch (e) {
      // onStatus는 감독자의 set() **안에서** 불린다. 여기서 던지면 그 예외가 감독자의 기동·재시작
      // 흐름을 끊는다 — 상태 창을 못 여는 것은 서비스가 멈출 이유가 아니다.
      host.log(`상태 창을 열지 못했어요 — ${reasonOf(e)}`);
      return;
    }
    current = created;
    // 로드 전에 부른 갱신은 렌더 함수가 아직 없어 아무 일도 하지 않는다. 로드가 끝나면 한 번
    // 그린다 — 이 줄이 없으면 넷이 다 running/ok로 **변화가 없는** 앱에서 창은 영영 빈 채다.
    host.onLoad(created, () => {
      pushTo(created);
      page += 1;
      void ask(created, page);
    });
    host.onClosed(created, () => {
      if (current === created) current = null;
    });
  };

  /**
   * 사람이 누를 때까지 끝나지 않는 호출을 걸고, 답이 오면 처리하고, 다시 건다.
   *
   * - 창이 죽었거나 새 페이지가 로드됐으면(세대가 오르면) 조용히 물러난다.
   * - 다리가 없으면(스크립트가 안 돌았다) **한 번만 적고 멈춘다.** 여기서 계속 물으면 몇
   *   밀리초마다 executeJavaScript를 거는 바쁜 고리가 된다.
   * - 모르는 모양은 버리고 계속 묻는다 — 한 번 이상한 값이 왔다고 버튼 전체를 죽이지 않는다.
   */
  const ask = async (win: W, mine: number) => {
    while (mine === page && host.alive(win)) {
      let raw: unknown;
      try {
        raw = await host.run(win, SERVICES_ASK_SCRIPT);
      } catch (e) {
        // 새로 고침이 진행 중인 호출을 끊을 수 있다 — 새 페이지의 로드가 다시 묻는다.
        if (mine === page && host.alive(win)) host.log(`상태 창에 묻지 못했어요 — ${reasonOf(e)}`);
        return;
      }
      if (mine !== page || !host.alive(win)) return;
      if (raw === null || raw === undefined) {
        host.log("상태 창의 스크립트가 돌지 않아 버튼을 쓸 수 없어요.");
        return;
      }
      const action = parseServicesAction(raw);
      if (action === null) {
        host.log("상태 창에서 알 수 없는 요청이 와서 무시했어요.");
        continue;
      }
      try {
        await host.onAction(action);
      } catch (e) {
        // 배선이 자기 실패를 삼키기로 돼 있지만, 삼키지 못한 것 때문에 묻는 고리가 끊기면
        // 그 뒤의 모든 버튼이 죽는다. 적고 계속 묻는다.
        host.log(`상태 창의 요청을 처리하지 못했어요 — ${reasonOf(e)}`);
      }
    }
  };

  const consider = (statuses: readonly ServiceStatus[]) => {
    for (const s of statuses) if (s.process === "running") announced.delete(s.id);
    const fresh = statuses.filter((s) => s.process === "failed" && !announced.has(s.id));
    if (fresh.length === 0) return;
    // 띄울 수 없는 순간이면 **표시하지 않는다.** 여기서 알린 것으로 치면 담화 화면이 붙기 직전에
    // 넘어진 worker(번들 python이 없으면 몇 밀리초 만에 넘어진다)가 붙은 뒤로는 영영 아무 데도 안 보인다.
    if (!host.mayAutoOpen()) return;
    for (const s of fresh) announced.add(s.id);
    show(false);
  };

  return {
    open: () => show(true),
    onStatus(statuses) {
      consider(statuses);
      push();
    },
    reconsider() {
      consider(host.statuses());
    },
    refresh: push,
    isOpen: () => current !== null && host.alive(current),
  };
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
