import type { MicWatchEvent } from "../process/mic-watch";

/**
 * 회의 감지 상태 기계 (스펙 §3·§4.2·§4.7). electron을 import하지 않는다 — vitest가 부를 수 있어야 한다.
 * 시간·헬퍼 이벤트·잎 동작(카드 창, 렌더러 호출)은 전부 `DetectionDeps`로 주입받고, 시간은 `setTimer` 하나로만 쓴다.
 *
 * 감시 상태는 `정상`/`불명` 둘이다. 첫 스냅숏 전, `error`·`exit`, 잠자기·종료 직전, 기능을 끈 동안은 `불명`이고,
 * `불명`을 "입력 없음"으로 읽지 않는다 — 새 카드도, 자동 종료도 없다. 이 인스턴스는 앱 실행 동안 하나다.
 */

export interface DetectionTarget {
  name: string;
  bundlePrefix: string;
  autoStop: boolean;
}

/**
 * T0 실측값. 접두사 일치라 helper 프로세스(`com.google.Chrome.helper` 등)도 잡는다.
 * 앞쪽이 우선이다 — 동시에 여럿이면 앞쪽이 카드의 대상이다. Teams는 첫 버전에 넣지 않는다.
 */
export const DETECTION_TARGETS: DetectionTarget[] = [
  { name: "Zoom", bundlePrefix: "us.zoom.xos", autoStop: true },
  { name: "Chrome", bundlePrefix: "com.google.Chrome", autoStop: true },
];

export type CardAction = "start" | "dismiss" | "stop" | "open";

export type CardView =
  | { kind: "prompt"; token: number }
  | { kind: "recording"; token: number; micOnly: boolean; micSwitched: boolean }
  | {
      kind: "finished";
      token: number;
      variant: "done" | "interrupted" | "empty" | "lost" | "startFailed";
      meetingId: string | null;
    };

export interface RecordingSnapshot {
  phase: "idle" | "starting" | "recording" | "stopping" | "ended";
  meetingId: string | null;
  failed: boolean;
  systemAudioLost: boolean;
  micSwitched: boolean;
  end: "acked" | "discarded" | "sealed" | "failed" | null;
}

export interface DetectionDeps {
  targets: DetectionTarget[];
  /** 시간은 이것 하나로만 간다. 돌려주는 함수가 취소다. */
  setTimer(fn: () => void, ms: number): () => void;
  /** 담화 화면이 붙어 있고 창이 있다. */
  ready(): boolean;
  show(view: CardView): void;
  hide(): void;
  start(): Promise<{ started: boolean; meetingId?: string; reason?: string }>;
  /** 시간 초과·suspend. 시작 중이면 무르고, 이미 붙었으면 멈춘다. */
  cancelStart(): Promise<unknown>;
  stop(): Promise<unknown>;
  finish(): Promise<unknown>;
  snapshot(): Promise<RecordingSnapshot | "timeout" | "gone">;
  open(meetingId: string): void;
  log(line: string): void;
}

export type SuspendReason = "quit" | "close" | "sleep";

/** 입력이 이만큼 이어져야 카드를 띄운다 (음성 검색 같은 찰나의 사용을 거른다). */
const SETTLE_MS = 2_000;
/** 카드를 이만큼 두고 응답이 없으면 닫기와 같다. */
const PROMPT_MS = 30_000;
/** 시작 상한. 사람이 권한 창에 답할 시간이다. */
const START_LIMIT_MS = 60_000;
/** 대상 앱 입력이 이만큼 연속으로 꺼져야 닫기 억제가 풀린다. */
const SUPPRESS_MS = 60_000;
/** 모든 대상 입력이 이만큼 연속으로 꺼지면 자동으로 멈춘다. */
const AUTO_STOP_MS = 10_000;
/** 끝 카드를 보이는 시간. */
const FINISHED_MS = 10_000;
/** 녹음 상태를 묻는 주기. */
const POLL_MS = 2_000;
/** 응답 없음이 이만큼 연속이면 끊긴 것으로 본다 (§4.7). */
const TIMEOUT_LIMIT = 3;
/** finish가 끝난 뒤 end가 이만큼 연속 null이면 중단으로 닫는다. */
const FINISH_POLL_LIMIT = 3;

type Phase = "idle" | "settling" | "prompting" | "starting" | "recording" | "abandoning" | "external" | "finished";

export function createMeetingDetection(deps: DetectionDeps) {
  const { targets } = deps;

  let phase: Phase = "idle";
  let enabled = true;
  let disposed = false;
  const suspended = new Set<SuspendReason>();

  /** 정상이면 true. 첫 스냅숏 전·오류·종료·꺼짐·잠자기는 false(불명). */
  let watchOk = false;
  let active = new Set<string>();

  /** 억제: 대상 이름 → 해제 타이머(입력이 켜져 있거나 불명이면 null). */
  const suppressed = new Map<string, (() => void) | null>();

  let current: DetectionTarget | null = null;
  /** 비동기 응답이 낡았는지 보는 세대. 상태가 바뀌어 응답을 버려야 할 때마다 올린다. */
  let gen = 0;
  let token = 0;
  let view: CardView | null = null;
  let micOnly = false;
  let micSwitched = false;
  let meetingId: string | null = null;
  let finishCalled = false;
  /** 진행 중인 stop. 어떤 결과로 끝나든 풀린다 — 끝났는지는 poll이 판단한다. */
  let stopInFlight: Promise<void> | null = null;
  let finishSettledPolls: number | null = null;
  let timeouts = 0;

  let settleCancel: (() => void) | null = null;
  let promptCancel: (() => void) | null = null;
  let startCancel: (() => void) | null = null;
  let countdownCancel: (() => void) | null = null;
  let finishedCancel: (() => void) | null = null;
  let pollCancel: (() => void) | null = null;
  let pollGen = 0;

  const clear = (c: (() => void) | null): null => {
    c?.();
    return null;
  };

  function present(v: CardView): void {
    view = v;
    deps.show(v);
  }

  function closeCard(): void {
    view = null;
    deps.hide();
  }

  function canJudge(): boolean {
    return enabled && suspended.size === 0 && watchOk && !disposed;
  }

  // ---- 억제 ---------------------------------------------------------------

  /** 억제된 대상의 해제 타이머를 입력 상태에 맞춘다: 켜져 있으면 취소, 꺼져 있으면 60초를 처음부터 잰다. */
  function syncSuppression(): void {
    for (const [name, cancel] of suppressed) {
      if (!watchOk || active.has(name)) {
        suppressed.set(name, clear(cancel));
      } else if (!cancel) {
        suppressed.set(
          name,
          deps.setTimer(() => {
            suppressed.delete(name);
            consider();
          }, SUPPRESS_MS),
        );
      }
    }
  }

  function suppress(name: string): void {
    suppressed.set(name, suppressed.get(name) ?? null);
    syncSuppression();
  }

  // ---- 감지 → 카드 --------------------------------------------------------

  /** 대기 중에 입력이 이어지고 있는 대상이 있으면 2초를 잰다. */
  function consider(): void {
    if (phase !== "idle" || !canJudge()) return;
    const t = targets.find((x) => active.has(x.name) && !suppressed.has(x.name));
    if (!t) return;
    current = t;
    phase = "settling";
    const g = ++gen;
    settleCancel = deps.setTimer(() => void settled(g), SETTLE_MS);
  }

  function backToIdle(): void {
    phase = "idle";
    gen++;
    settleCancel = clear(settleCancel);
    promptCancel = clear(promptCancel);
    startCancel = clear(startCancel);
    finishedCancel = clear(finishedCancel);
  }

  async function settled(g: number): Promise<void> {
    if (g !== gen) return;
    settleCancel = null;
    if (!deps.ready()) {
      // 준비 안 된 동안 지난 2초는 센 것으로 치지 않는다. reevaluate가 다시 잰다.
      phase = "idle";
      return;
    }
    let snap: RecordingSnapshot | "timeout" | "gone";
    try {
      snap = await deps.snapshot();
    } catch {
      snap = "timeout";
    }
    if (g !== gen || !current) return;
    if (snap === "timeout" || snap === "gone" || !deps.ready()) {
      phase = "idle";
      return;
    }
    if (snap.phase === "recording" || snap.phase === "starting" || snap.phase === "stopping") {
      // 모달 등 다른 경로가 이미 녹음 중이다. 카드 없이 끝날 때까지 지켜보고 그때 억제한다.
      deps.log(`meeting-detection: ${current.name} 입력, 이미 녹음 중 — 카드 없음`);
      enterExternal();
      return;
    }
    token++;
    phase = "prompting";
    present({ kind: "prompt", token });
    promptCancel = deps.setTimer(() => {
      if (phase === "prompting") dismissPrompt();
    }, PROMPT_MS);
  }

  function dismissPrompt(): void {
    if (current) suppress(current.name);
    closeCard();
    backToIdle();
    consider(); // 동시에 입력 중인 다른 대상이 있으면 그 차례다
  }

  function enterExternal(): void {
    phase = "external";
    gen++;
    closeCard();
    timeouts = 0;
    schedulePoll();
  }

  // ---- 시작 ---------------------------------------------------------------

  function beginStart(): void {
    if (!current) return;
    phase = "starting";
    promptCancel = clear(promptCancel);
    const g = ++gen;
    const target = current;
    finishCalled = false;
    stopInFlight = null;
    finishSettledPolls = null;
    meetingId = null;
    micOnly = false;
    micSwitched = false;
    startCancel = deps.setTimer(() => {
      if (g !== gen) return;
      startCancel = null;
      gen++;
      deps.log(`meeting-detection: 시작 ${START_LIMIT_MS / 1000}초 초과 — 취소`);
      void deps.cancelStart().catch((e) => deps.log(`meeting-detection: cancelStart 실패 ${String(e)}`));
      showFinished("startFailed", null, target);
    }, START_LIMIT_MS);
    deps
      .start()
      .then(
        (r) => r,
        (e): Awaited<ReturnType<DetectionDeps["start"]>> => ({ started: false, reason: String(e) }),
      )
      .then((r) => {
        if (g !== gen) return; // 초과·suspend·꺼짐으로 이미 정리됐다. 낡은 응답은 상태를 바꾸지 않는다.
        startCancel = clear(startCancel);
        if (r.started) {
          phase = "recording";
          meetingId = r.meetingId ?? null;
          timeouts = 0;
          token++;
          present({ kind: "recording", token, micOnly: false, micSwitched: false });
          schedulePoll();
          syncCountdown();
        } else if (r.reason === "busy") {
          // 조회 뒤에 모달이 먼저 시작했다. 카드를 닫고 남의 녹음으로 지켜본다.
          deps.log("meeting-detection: 시작이 busy — external");
          enterExternal();
        } else {
          deps.log(`meeting-detection: 시작 실패 ${r.reason ?? ""}`);
          // 시스템 오디오 권한 창은 헬퍼의 5초 상한보다 오래 뜬다. 허용한 뒤 같은 회의에서 카드가 돌아와야 한다.
          showFinished("startFailed", null, target, r.reason !== "system_audio");
        }
      });
  }

  // ---- 녹음 중 ------------------------------------------------------------

  function schedulePoll(): void {
    cancelPoll();
    if (suspended.size > 0) return;
    pollCancel = deps.setTimer(() => void poll(), POLL_MS);
  }

  function cancelPoll(): void {
    pollCancel = clear(pollCancel);
    pollGen++;
  }

  async function poll(): Promise<void> {
    pollCancel = null;
    const g = pollGen;
    let r: RecordingSnapshot | "timeout" | "gone";
    try {
      r = await deps.snapshot();
    } catch {
      r = "timeout";
    }
    if (g !== pollGen || disposed) return;
    if (phase === "recording") judgeRecording(r);
    else if (phase === "external") judgeExternal(r);
    if (g === pollGen && (phase === "recording" || phase === "external")) schedulePoll();
  }

  /** 끝난 방식별 카드 (§4.7). 판정 순서가 곧 우선순위다. */
  function judgeRecording(r: RecordingSnapshot | "timeout" | "gone"): void {
    const t = current;
    if (!t) return;
    if (r === "gone") return showFinished("lost", null, t);
    if (r === "timeout") {
      if (++timeouts >= TIMEOUT_LIMIT) abandon(t);
      return;
    }
    timeouts = 0;
    // 다른 id는 다른 세션이다. 카드의 세션은 끝났고, 그 세션을 자동 종료하면 안 된다.
    if (r.meetingId !== null && r.meetingId !== meetingId) return showFinished("lost", null, t);
    if (r.end === "discarded") return showFinished("empty", null, t);
    if (r.end !== null) {
      const broken = r.failed || r.end === "failed";
      return showFinished(broken ? "interrupted" : "done", meetingId, t);
    }
    if (r.meetingId === null) return showFinished("lost", null, t);
    if (r.failed) {
      if (!finishCalled) {
        // 레코더가 실패해 서버 stop이 안 갔을 수 있다. 마감을 한 번 부르고 end가 나올 때까지 기다린다.
        finishCalled = true;
        const g = gen;
        const settle = () => {
          if (g === gen && phase === "recording") finishSettledPolls = 0;
        };
        deps.finish().then(settle, (e) => {
          deps.log(`meeting-detection: finish 실패 ${String(e)}`);
          if (g === gen && phase === "recording") showFinished("interrupted", meetingId, t);
        });
      } else if (finishSettledPolls !== null && ++finishSettledPolls >= FINISH_POLL_LIMIT) {
        // finish가 끝났는데도 end가 안 나온다 — 더 기다려도 회의를 마감할 길이 없다.
        return showFinished("interrupted", meetingId, t);
      }
    }
    if ((r.systemAudioLost && !micOnly) || (r.micSwitched && !micSwitched)) {
      micOnly = r.systemAudioLost;
      micSwitched = r.micSwitched;
      present({ kind: "recording", token, micOnly, micSwitched });
    }
  }

  /** 바쁜 렌더러는 답이 없어도 마이크를 쥐고 있을 수 있다. 멈춰 본 뒤에 lost를 보여 카드의 말을 참으로 만든다. */
  function abandon(t: DetectionTarget): void {
    cancelPoll();
    countdownCancel = clear(countdownCancel);
    phase = "abandoning";
    const stopped = requestStop();
    const g = ++gen;
    void stopped.then(() => {
      if (g === gen) showFinished("lost", null, t);
    });
  }

  function judgeExternal(r: RecordingSnapshot | "timeout" | "gone"): void {
    const t = current;
    if (r === "timeout") {
      if (++timeouts < TIMEOUT_LIMIT) return;
    } else if (r !== "gone") {
      timeouts = 0;
      if (r.phase === "recording" || r.phase === "starting" || r.phase === "stopping") return;
    }
    cancelPoll();
    if (t) suppress(t.name);
    backToIdle();
    consider();
  }

  function showFinished(
    variant: Extract<CardView, { kind: "finished" }>["variant"],
    id: string | null,
    t: DetectionTarget,
    suppressTarget = true,
  ): void {
    cancelPoll();
    countdownCancel = clear(countdownCancel);
    startCancel = clear(startCancel);
    promptCancel = clear(promptCancel);
    phase = "finished";
    gen++;
    // 끝난 뒤·시작 실패 뒤에도 같은 억제를 건다 — 없으면 회의가 이어지는 동안 카드가 반복해서 뜬다.
    if (suppressTarget) suppress(t.name);
    token++;
    present({ kind: "finished", token, variant, meetingId: id });
    finishedCancel = deps.setTimer(() => {
      if (phase !== "finished") return;
      closeCard();
      backToIdle();
      consider();
    }, FINISHED_MS);
  }

  /** 카드로 시작한 녹음의 자동 종료 카운트다운을 입력 상태에 맞춘다. */
  function syncCountdown(): void {
    const armed =
      phase === "recording" &&
      canJudge() &&
      current?.autoStop === true &&
      !stopInFlight &&
      active.size === 0;
    if (!armed) {
      countdownCancel = clear(countdownCancel);
      return;
    }
    if (countdownCancel) return;
    countdownCancel = deps.setTimer(() => {
      countdownCancel = null;
      if (phase !== "recording" || !canJudge() || active.size > 0) return;
      deps.log("meeting-detection: 입력 꺼짐 — 자동 종료");
      void requestStop();
    }, AUTO_STOP_MS);
  }

  /** stop을 한 번에 하나만 건다. 결과가 무엇이든 settle하면 풀고, 입력이 여전히 꺼져 있으면 카운트다운을 다시 세운다. */
  function requestStop(): Promise<void> {
    if (stopInFlight) return stopInFlight;
    const g = gen;
    const done = () => {
      if (g !== gen) return;
      stopInFlight = null;
      syncCountdown();
    };
    stopInFlight = deps.stop().then(done, (e) => {
      deps.log(`meeting-detection: stop 실패 ${String(e)}`);
      done();
    });
    return stopInFlight;
  }

  // ---- 바깥 입구 ----------------------------------------------------------

  function onWatch(e: MicWatchEvent): void {
    if (disposed || !enabled) return;
    // 잠든 동안 온 스냅숏은 낡을 수 있다 — 돌아온 뒤 헬퍼를 다시 띄워 받는 전체 스냅숏만 믿는다.
    if (e.kind === "snapshot" && suspended.size > 0) return;
    if (e.kind !== "snapshot") {
      deps.log(`meeting-detection: 감시 불명 (${e.kind === "error" ? e.detail : "exit"})`);
      goUnknown();
      return;
    }
    watchOk = true;
    active = new Set(targets.filter((t) => e.input.some((b) => b.startsWith(t.bundlePrefix))).map((t) => t.name));
    syncSuppression();
    if (phase === "settling" && current && !active.has(current.name)) backToIdle();
    syncCountdown();
    consider();
  }

  /** 불명으로 간다: 카운트다운·억제 해제 타이머·2초 재기를 모두 취소한다. 녹음은 멈추지 않는다. */
  function goUnknown(): void {
    watchOk = false;
    active = new Set();
    countdownCancel = clear(countdownCancel);
    syncSuppression();
    if (phase === "settling") backToIdle();
  }

  function onCard(t: number, action: CardAction): void {
    if (disposed || t !== token || !view) return;
    if (phase === "prompting" && action === "start") {
      beginStart();
    } else if (phase === "prompting" && action === "dismiss") {
      dismissPrompt();
    } else if (phase === "recording" && action === "stop") {
      void requestStop();
    } else if (phase === "finished" && action === "open") {
      const id = view.kind === "finished" ? view.meetingId : null;
      if (id) deps.open(id);
      closeCard();
      backToIdle();
      consider();
    } else if (phase === "finished" && action === "dismiss") {
      closeCard();
      backToIdle();
      consider();
    }
  }

  /** 담화 화면이 붙은 뒤 마지막 스냅숏으로 다시 판단한다. */
  function reevaluate(): void {
    consider();
  }

  /** 뜨기 전 단계(2초·카드·시작)를 걷는다. 녹음·끝 카드는 건드리지 않는다. */
  function abandonPending(): void {
    if (phase === "starting") {
      void deps.cancelStart().catch((e) => deps.log(`meeting-detection: cancelStart 실패 ${String(e)}`));
    }
    if (phase === "settling" || phase === "prompting" || phase === "starting") {
      closeCard();
      backToIdle();
    }
  }

  function setEnabled(on: boolean): void {
    if (disposed || on === enabled) return;
    enabled = on;
    if (on) return; // 헬퍼를 다시 띄우는 것은 main의 일 — 첫 스냅숏 뒤에야 판단한다.
    // 시작 중인 녹음은 사람이 누른 것이라 그대로 두고, 아직 안 시작된 것만 걷는다.
    if (phase === "settling" || phase === "prompting") {
      closeCard();
      backToIdle();
    }
    goUnknown();
  }

  function suspend(reason: SuspendReason): void {
    if (disposed) return;
    suspended.add(reason);
    countdownCancel = clear(countdownCancel);
    abandonPending();
    // 녹음 표시는 유지하되 렌더러를 묻지 않고, 돌아온 뒤 첫 스냅숏 전에는 판단하지 않는다.
    cancelPoll();
    goUnknown();
  }

  function resume(reason: SuspendReason): void {
    if (disposed || !suspended.delete(reason) || suspended.size > 0) return;
    if (phase === "recording" || phase === "external") schedulePoll();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const c of [settleCancel, promptCancel, startCancel, countdownCancel, finishedCancel, pollCancel]) c?.();
    for (const c of suppressed.values()) c?.();
    suppressed.clear();
    gen++;
    pollGen++;
  }

  return { onWatch, onCard, reevaluate, setEnabled, suspend, resume, dispose };
}
