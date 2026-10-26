import type { SystemAudioSession } from "../process/system-audio";
import { originOf } from "./origin";

/**
 * 렌더러가 시스템 오디오를 받는 **유일한** 렌더러 → main 경로 (스펙 §6.11의 예외, 2026-10-26).
 *
 * preload·IPC를 두지 않고 커스텀 스킴 하나로 연다. 렌더러가 `fetch(damwha-audio://system/pcm)`하면 헬퍼가 뜨고
 * PCM이 응답 본문으로 흐른다. 수명은 요청에 묶인다 — 렌더러가 본문을 cancel하거나 창이 새로고침·파괴돼 요청이
 * 끊기면 본문의 cancel이 헬퍼를 끈다. 그래서 "렌더러가 죽었는데 tap이 열려 있다"를 따로 막을 장치가 필요 없다.
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
  /** 앱 종료(beginQuit)에서 부른다. 렌더러가 cancel을 보내기 전에 프로세스가 끝날 수 있다. */
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

  async function openPcm(origin: string): Promise<Response> {
    if (active !== null || starting) return json(409, { code: "busy" }, origin);
    starting = true;
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
      active?.stop();
    },
  };
}
