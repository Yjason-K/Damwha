import { renderCall, type ServicesView } from "./status-view";
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
 * 표시 전용이다. 렌더러에서 main으로 오는 경로를 만들지 않는다 (스펙 §6.11).
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
}

export function createStatusWindow<W>(host: StatusWindowHost<W>): StatusWindow {
  let current: W | null = null;
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
    host.onLoad(created, () => pushTo(created));
    host.onClosed(created, () => {
      if (current === created) current = null;
    });
  };

  const consider = (statuses: readonly ServiceStatus[]) => {
    for (const s of statuses) if (s.process === "running") announced.delete(s.id);
    const fresh = statuses.filter((s) => s.process === "failed" && !announced.has(s.id));
    if (fresh.length === 0) return;
    // 띄울 수 없는 순간이면 **표시하지 않는다.** 여기서 알린 것으로 치면 담화 화면이 붙기 직전에
    // 넘어진 worker(uv 없음은 몇 밀리초 만에 넘어진다)가 붙은 뒤로는 영영 아무 데도 안 보인다.
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
  };
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
