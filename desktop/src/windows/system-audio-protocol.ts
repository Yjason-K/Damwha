import type { SystemAudioSession } from "../process/system-audio";
import { originOf } from "./origin";

/**
 * 렌더러가 시스템 오디오를 받는 **유일한** 렌더러 → main 경로 (스펙 §6.11의 예외, 2026-10-26).
 *
 * preload·IPC를 두지 않고 커스텀 스킴 하나로 연다. 렌더러가 `fetch(damwha-audio://system/pcm)`하면 헬퍼가 뜨고
 * PCM이 응답 본문으로 흐른다. 녹음이 끝나면 렌더러가 본문을 cancel해 헬퍼를 끈다. 새로고침·창 파괴로 요청이
 * 끊길 때 Electron이 본문을 cancel한다는 보장은 없으므로, main이 그 사건을 직접 듣고 끈다(`stopOnRendererReset`).
 * 그것이 없으면 헬퍼가 남아 슬롯을 쥐고, 앱을 다시 켤 때까지 모든 녹음이 409를 받는다.
 *
 * electron을 import하지 않는다(vitest가 부를 수 있어야 한다). main.ts가 스킴 등록과 `protocol.handle`만 배선한다.
 */

export const SYSTEM_AUDIO_SCHEME = "damwha-audio";

/**
 * `protocol.registerSchemesAsPrivileged`에 그대로 넘긴다. corsEnabled가 없으면 http origin의 fetch가 막히고,
 * stream이 없으면 본문이 끝까지 버퍼링돼 녹음 내내 아무것도 오지 않는다.
 */
export const SYSTEM_AUDIO_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  stream: true,
} as const;

export interface SystemAudioProtocolDeps {
  allowedOrigins: () => string[];
  start: () => Promise<SystemAudioSession>;
  log: (line: string) => void;
}

export interface SystemAudioProtocol {
  handle(request: Request): Promise<Response>;
  /** 앱 종료(beginQuit)와 렌더러 리셋(`stopOnRendererReset`)에서 부른다. 시작 중인 헬퍼도 끈다. */
  stopAll(): void;
}

function json(status: number, body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(origin === null ? {} : { "Access-Control-Allow-Origin": origin }),
    },
  });
}

export function createSystemAudioProtocol(deps: SystemAudioProtocolDeps): SystemAudioProtocol {
  let active: SystemAudioSession | null = null;
  let starting = false;
  /** stopAll이 올릴 때마다 바뀐다. 시작 중에 바뀌었으면 도착한 헬퍼는 주인이 없다. */
  let generation = 0;

  async function openPcm(origin: string): Promise<Response> {
    if (active !== null || starting) return json(409, { code: "busy" }, origin);
    starting = true;
    const gen = generation;
    let session: SystemAudioSession;
    try {
      session = await deps.start();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      deps.log(`시스템 오디오를 시작하지 못했어요 — ${detail}`);
      return json(503, { code: "start_failed", detail }, origin);
    } finally {
      starting = false;
    }
    if (gen !== generation) {
      session.stop();
      return json(503, { code: "stopped" }, origin);
    }
    active = session;
    void session.exited.then(({ code, signal }) => {
      if (active === session) active = null;
      deps.log(`시스템 오디오 헬퍼 종료 — code=${code} signal=${signal}`);
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        session.pcm.on("data", (b: Buffer) => controller.enqueue(new Uint8Array(b)));
        session.pcm.once("end", () => {
          try {
            controller.close();
          } catch {
            // 렌더러가 이미 cancel했다.
          }
        });
      },
      cancel() {
        session.stop();
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": origin,
      },
    });
  }

  return {
    async handle(request) {
      // 담화 화면의 origin만 받는다. 이 스킴은 이 맥의 소리를 통째로 내주므로, 탐색 경계를 뚫고 들어온
      // 낯선 페이지가 fetch 한 줄로 녹음을 시작하면 안 된다.
      // 실측(2026-10-26, Electron 44.3): 렌더러의 fetch는 이 스킴에 Origin 헤더를 싣지 않고 referrer만 준다
      // (`http://localhost:5173/`). 페이지는 fetch의 referrer를 자기 origin 밖으로 바꿀 수 없으므로 그 origin을 쓴다.
      // 그래서 fe가 `referrerPolicy: "no-referrer"`로 부르면 여기서 403이 난다.
      const origin = request.headers.get("origin") ?? originOf(request.referrer);
      if (origin === null || !deps.allowedOrigins().includes(origin)) return json(403, { code: "forbidden" }, null);
      const url = new URL(request.url);
      if (request.method !== "GET" || url.host !== "system") return json(404, { code: "not_found" }, origin);
      if (url.pathname === "/status") return json(200, { available: true, busy: active !== null || starting }, origin);
      if (url.pathname === "/pcm") return openPcm(origin);
      return json(404, { code: "not_found" }, origin);
    },
    stopAll() {
      generation += 1;
      active?.stop();
    },
  };
}

/** `WebContents`에서 쓰는 부분만. 테스트가 EventEmitter로 대신한다. */
export interface RendererEvents {
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * 렌더러 문서가 바뀌거나 죽으면 시스템 오디오를 끈다 — 그 문서의 녹음기는 이제 없다. 같은 문서 안의 라우팅
 * (`isSameDocument`)과 서브프레임은 녹음을 끝내지 않는다. 창이 하나라 "모두 끄기"로 충분하다.
 */
export function stopOnRendererReset(contents: RendererEvents, stop: () => void): void {
  contents.on("did-start-navigation", (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (details.isMainFrame && !details.isSameDocument) stop();
  });
  contents.on("render-process-gone", () => stop());
  contents.on("destroyed", () => stop());
}
