/**
 * 렌더러와의 왕복 — "녹음 중인가" 묻기, 라이브 중지 핸드셰이크, 렌더러가 끝내 줘야 끝나는 대기. 셋 다 **상한**이 존재
 * 이유다: 봉쇄된 렌더러가 ⌘Q나 창 닫기를 영영 막으면 안 된다. 실제 호출(executeJavaScript·loadFile)은 main.ts가
 * 주입하고, 순서는 app/quit-flow.ts가 정한다. 통신 방식을 바꿀 때 바뀌는 자리가 여기다.
 */

/**
 * "이 창이 지금 녹음 중인가"를 렌더러에 묻는 왕복 하나. **상한이 이 함수의 존재 이유다.**
 *
 * `webContents.executeJavaScript`는 렌더러의 JS 스레드가 막혀 있으면 거부하지도 해결하지도
 * 않는다. 상한이 없으면 ⌘Q는 before-quit이 이미 preventDefault를 부른 뒤 이 물음에서 멎어
 * `app.quit()`이 영영 안 불리고, ⌘W도 같은 이유로 창을 영영 못 닫는다 — 어떤 키를 눌러도
 * 나갈 길이 없어진다. 봉쇄된 렌더러가 앱의 종료나 창의 닫힘을 막는 일은 없어야 한다.
 *
 * 세 갈래의 답이 각각 다르다.
 * - 답했다 → 그 답 그대로.
 * - 거부했다 → **아니오.** 프레임이 이미 없거나 훅이 없다는 뜻이고, 그러면 중지할 녹음도 없다.
 * - 시간이 지났다 → **예.** "모른다"를 "녹음 아님"으로 닫지 않는다. 확인을 한 번 더 묻는
 *   비용이 녹음을 조용히 버리는 비용보다 싸고, 이 답으로 이어지는 핸드셰이크에는 자기
 *   상한(runHandshake)이 있어 그쪽에서 다시 막히지 않는다.
 *
 * main.ts에 두면 어떤 테스트도 이것을 부를 수 없다 — electron을 값으로 import하는 파일은
 * vitest가 못 불러온다(shell-window.ts:1). 저 자리에 있는 동안에는 상한을 통째로 지우는
 * 변이도, 시간 초과의 답을 false로 뒤집는 변이도 초록불로 살아남는다.
 */
export async function askIsRecording(
  call: () => Promise<unknown>,
  opts: { timeoutMs: number; onTimeout: () => void },
): Promise<boolean> {
  // 거부를 **값으로** 바꾼다 — 위 세 갈래의 둘째("거부했다 → 아니오")가 이 핸들러다.
  // 상한에 진 뒤 늦게 오는 거부를 unhandled로부터 막는 장치로 읽지 말 것: `Promise.race`는
  // 진 프라미스에도 언제나 반응을 등록하므로 그것은 이 핸들러가 없어도 성립한다.
  //
  // `call()`을 직접 부르지 않고 `then` 안에서 부른다. `webContents.executeJavaScript`는 파괴된
  // webContents에서 프라미스를 돌려주는 대신 **동기로 던지고**, `call().then(…)`은 그 예외를
  // 잡지 못해 이 함수 전체가 거부했다 — "거부했다 → 아니오"라는 약속이 가장 흔한 거부 모양에서
  // 깨졌고, 그 거부가 종료 흐름을 확인 전에 끝냈다 (최종 리뷰 I-2).
  const asked = Promise.resolve().then(call).then(
    (v) => Boolean(v),
    () => false,
  );
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      opts.onTimeout();
      resolve(true);
    }, opts.timeoutMs);
  });
  try {
    return await Promise.race([asked, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 렌더러에 매달리는 **어떤** 대기든 상한 안에 끝내고 돌아온다. 답이 필요 없고 "끝났는가"만
 * 필요한 자리용이다 — `askIsRecording`이 세 갈래의 **답**을 판정하는 것과 다르다.
 *
 * 존재 이유는 askIsRecording과 같다. `before-quit`이 `preventDefault`를 부른 뒤로 `app.quit()`은
 * 반드시 다시 불려야 하는데, 그 사이에 **렌더러가 끝내 줘야 끝나는 await**가 하나라도 상한
 * 없이 있으면 봉쇄된 렌더러가 앱을 영영 못 끄게 만든다. `win.loadFile()`이 정확히 그런
 * 프라미스다 — Chromium이 교차 출처 내비게이션을 새 렌더 프로세스로 처리해 구해 줄 수도
 * 있지만, 그것은 우리 코드가 보장하는 것이 아니고 §6.9의 "증명하지 못하면 깨끗하다고 말하지
 * 않는다"가 그대로 적용되는 자리다.
 *
 * **거부는 삼키지 않는다.** 부르는 쪽의 `catch`가 "화면을 못 걸었다"를 적는 유일한 자리다.
 * (상한에 걸린 뒤 늦게 도착하는 거부는 `Promise.race`가 이미 진 쪽에도 핸들러를 달아 두므로
 * unhandled rejection이 되지 않는다 — 그것을 값으로 들고 있다가 다시 던지는 장치를 한 번
 * 넣었다가 뺐다. 그 장치를 지우는 변이가 아무 테스트도 죽이지 않았고, 실제로 동작이 같다.)
 */
export async function runWithin(
  call: () => Promise<unknown>,
  opts: { timeoutMs: number; onTimeout: () => void },
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      opts.onTimeout();
      resolve();
    }, opts.timeoutMs);
  });
  try {
    await Promise.race([call().then(() => undefined), expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type HandshakeResult =
  | { kind: "stopped" }
  | { kind: "failed"; detail: string }
  | { kind: "timeout" };

/**
 * 렌더러의 라이브 중지를 부르고 서버 ACK까지 기다린다. 실패하거나 시간을 넘기면 그 사실을
 * 돌려준다 — 그때는 sweeper 경로로 떨어지고, 다음 앱 실행 때 API가 뜨면 봉인·마감된다.
 * 종료 자체를 막지는 않는다 (스펙 §6.9).
 */
export async function runHandshake(
  call: () => Promise<{ stopped: boolean; reason?: string }>,
  opts: { timeoutMs: number },
): Promise<HandshakeResult> {
  const timeout = new Promise<HandshakeResult>((resolve) => {
    const t = setTimeout(() => resolve({ kind: "timeout" }), opts.timeoutMs);
    if (typeof t === "object" && "unref" in t) t.unref();
  });
  const work = (async (): Promise<HandshakeResult> => {
    try {
      const r = await call();
      // 창이 이미 파괴됐거나 훅이 없으면 여기로 온다. 성공으로 읽으면 안 된다.
      if (!r.stopped) return { kind: "failed", detail: r.reason ?? "이유를 알 수 없어요." };
      return { kind: "stopped" };
    } catch (e) {
      return { kind: "failed", detail: e instanceof Error ? e.message : String(e) };
    }
  })();
  return Promise.race([work, timeout]);
}

/**
 * 창 하나의 렌더러 — 왕복 셋이 필요로 하는 것만. main.ts가 `BrowserWindow`로 채운다.
 * electron을 값으로 import하지 않아야 아래 셋을 테스트가 부를 수 있다.
 */
export interface RendererTarget {
  isDestroyed(): boolean;
  /** 렌더러 프로세스가 죽었다(크래시·OOM·kill). 창은 남아 있어도 답할 쪽이 없다. */
  isGone(): boolean;
  /** `webContents.executeJavaScript`. 파괴된 webContents에서는 동기로 던진다. */
  run(js: string): Promise<unknown>;
}

/**
 * 녹음 중인가 — 렌더러의 훅에 묻는다. 캡처는 브라우저가 갖고 있으므로 렌더러만이 안다.
 *
 * 전역 `win`이 아니라 창을 받는다. 창 닫기 경로는 **닫히려는 그 창**에 물어야 하고,
 * 그 창이 전역과 다를 수 있다(더 새 창이 이미 전역을 차지했다).
 */
export function isRecordingIn(
  target: RendererTarget,
  opts: { timeoutMs: number; onTimeout: () => void },
): Promise<boolean> {
  // 죽은 렌더러는 막힌 렌더러와 다르다 (#145). 그 executeJavaScript는 거부도 해결도 하지 않아 상한이 "녹음 중"으로
  // 닫히는데, 답할 렌더러가 없으니 녹음도 없다. 그 안에서 돌던 녹음은 서버 sweeper가 마무리한다.
  if (target.isDestroyed() || target.isGone()) return Promise.resolve(false);
  return askIsRecording(() => target.run("Boolean(window.__damwha_desktop?.isRecording?.())"), opts);
}

/** 렌더러의 라이브 중지. 훅이 없거나 창이 죽었으면 성공으로 읽지 않는다. */
export function stopRecordingIn(target: RendererTarget): Promise<{ stopped: boolean; reason?: string }> {
  if (target.isDestroyed()) return Promise.resolve({ stopped: false, reason: "창이 이미 없어요." });
  if (target.isGone()) return Promise.resolve({ stopped: false, reason: "렌더러가 이미 종료됐어요." });
  return target.run(
    "window.__damwha_desktop?.stopLiveRecording?.() ?? {stopped:false, reason:'no-bridge'}",
  ) as Promise<{ stopped: boolean; reason?: string }>;
}

/**
 * 렌더러의 메모 flush (#133). 훅이 없으면(셀 화면·구버전 fe) 곧바로 끝난다. 파괴된 webContents의
 * executeJavaScript는 동기로 던지므로 then 안에서 부른다(askIsRecording과 같은 이유). 상한은 quit-flow.ts가 건다.
 */
export function flushNotesIn(target: RendererTarget): Promise<void> {
  return Promise.resolve().then(async () => {
    if (target.isDestroyed() || target.isGone()) return;
    await target.run("window.__damwha_desktop?.flushNotes?.()");
  });
}
