import * as net from "net";

/**
 * 고정 포트 1회 + 탐색 포트 3회. 상한이 없으면 EADDRINUSE가 반복될 때 무한 재기동이 된다
 * (스펙 R1-10).
 */
export const MAX_PORT_ATTEMPTS = 4;

/** OS에게 빈 포트를 물어본다. 닫은 직후 다른 프로세스가 가져갈 수 있으므로 판정은 자식의 bind가 한다. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        srv.close(() => reject(new Error("could not read the probe port")));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
  });
}

export async function choosePort(
  preferred: number,
  attempt: number,
  probe: () => Promise<number> = freePort,
): Promise<number> {
  if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65535) {
    throw new Error(`invalid preferred port: ${preferred}`);
  }
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(`invalid attempt index: ${attempt}`);
  }
  return attempt === 0 ? preferred : probe();
}

/** 포트 충돌과 다른 기동 실패를 갈라야 실패 화면이 옳은 원인을 말한다 (스펙 §6.4). */
export function isAddrInUse(text: string): boolean {
  return /EADDRINUSE/.test(text);
}
