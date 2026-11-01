import { postLiveStart } from "../api/live";
import { defaultLiveTitle } from "./default-live-title";
import { LiveCaptureCancelled } from "./live-recorder";
import {
  awaitLiveStart,
  finishLiveCapture,
  getLiveRecorder,
  hasLiveCapture,
  isLiveStarting,
  LiveCaptureBusy,
  liveSessionSnapshot,
  stopActiveLiveCapture,
  type RecordingSnapshot,
} from "./live-session";
import { startLiveRecording } from "./start-live";
import { openDesktopSystemAudio, SystemAudioUnavailable } from "./system-audio";
import { languageStore } from "@/shared/i18n";
import type { UiLanguageBridge } from "@/shared/i18n/language-store";

export interface DesktopBridge {
  isRecording(): boolean;
  stopLiveRecording(): Promise<{ stopped: boolean; reason?: string }>;
  /** 회의 감지 카드의 `녹음 시작`. 던지지 않고 reason으로 답한다 (설계 §4.4). */
  startDetectedRecording(): Promise<{
    started: boolean;
    meetingId?: string;
    reason?: string;
  }>;
  /** 시작 중이면 무르고, 이미 시작됐으면 멈춘다. 다른 경로로 시작한 녹음은 건드리지 않는다. */
  cancelDetectedRecording(): Promise<void>;
  recordingStatus(): RecordingSnapshot;
  /** 레코더 실패로 이미 stopped인 세션에도 서버 stop을 보낸다. */
  finishRecording(): Promise<void>;
  openMeeting(id: string): void;
  /** 화면 언어 (다국어 스펙 §4.1). main의 language-bridge.ts가 이 이름으로 부른다 — 이름을 바꾸면 조용히 끊긴다. */
  uiLanguage: UiLanguageBridge;
}

declare global {
  interface Window {
    __damwha_desktop?: DesktopBridge;
  }
}

type StartResult = Awaited<ReturnType<DesktopBridge["startDetectedRecording"]>>;

/** 라우터·쿼리 캐시는 React 트리 안(`providers.tsx`)에 있어 거기서 꽂아 준다. */
export interface DesktopBridgeDeps {
  navigate(path: string): void;
  invalidateMeetings(): void;
}

let deps: DesktopBridgeDeps | null = null;

export function connectDesktopBridge(next: DesktopBridgeDeps): void {
  deps = next;
}

/** 카드가 시작한 녹음 하나. `cancelDetectedRecording`이 자기 것만 멈추려고 기억한다. */
let detected: {
  abort: AbortController;
  done: Promise<StartResult>;
  meetingId: string | null;
} | null = null;

async function runDetectedStart(
  d: DesktopBridgeDeps,
  abort: AbortController,
  record: (id: string) => void,
): Promise<StartResult> {
  let creating = false;
  try {
    const meetingId = await startLiveRecording({
      openSystemAudio: openDesktopSystemAudio,
      signal: abort.signal,
      createMeeting: () => {
        creating = true;
        // 사용자가 정한 것이 없으니 제목만 보낸다. 후속 처리는 서버 기본(자동)이다.
        return postLiveStart({ title: defaultLiveTitle() });
      },
    });
    record(meetingId);
    d.invalidateMeetings();
    return { started: true, meetingId };
  } catch (e) {
    if (e instanceof LiveCaptureCancelled)
      return { started: false, reason: "cancelled" };
    if (e instanceof LiveCaptureBusy) return { started: false, reason: "busy" };
    if (e instanceof SystemAudioUnavailable)
      return { started: false, reason: "system_audio" };
    // 회의 생성 POST 실패와, 그 앞의 준비(권한 거절·장치 부재)를 가른다.
    return {
      started: false,
      reason: creating ? "create_failed" : "permission",
    };
  }
}

/**
 * main → 렌더러 한 방향이다. 렌더러가 먼저 부를 수 있는 채널은 생기지 않으므로 Phase 1의
 * "렌더러에서 main을 부를 경로를 새로 만들지 않는다"는 계약이 그대로 산다 (스펙 §6.11).
 * 웹 배포에서는 아무도 부르지 않아 무해하고, fe는 이 객체 없이도 그대로 동작한다.
 */
export function installDesktopBridge(w: Window = window): void {
  // 두 번 설치하지 않는다 — HMR이나 StrictMode의 이중 마운트에서 훅이 갈리면
  // main이 낡은 레지스트리를 보는 쪽을 잡을 수 있다.
  if (w.__damwha_desktop !== undefined) return;
  w.__damwha_desktop = {
    // 시작 중(준비~회의 생성)에는 아직 meetingId가 없어 hasLiveCapture가 거짓이다.
    isRecording: () => hasLiveCapture() || isLiveStarting(),
    async stopLiveRecording() {
      await awaitLiveStart();
      if (!hasLiveCapture()) return { stopped: true, reason: "no-recording" };
      try {
        await stopActiveLiveCapture();
        return { stopped: true };
      } catch (e) {
        // 여기서 던지면 executeJavaScript가 거부로 끝나 main이 이유를 못 읽는다.
        return {
          stopped: false,
          reason: e instanceof Error ? e.message : String(e),
        };
      }
    },
    async startDetectedRecording() {
      if (deps === null) return { started: false, reason: "not_ready" };
      const abort = new AbortController();
      const entry: NonNullable<typeof detected> = {
        abort,
        meetingId: null,
        done: Promise.resolve({ started: false }),
      };
      entry.done = runDetectedStart(deps, abort, (id) => {
        entry.meetingId = id;
      });
      detected = entry;
      return entry.done;
    },
    async cancelDetectedRecording() {
      const mine = detected;
      if (mine === null) return;
      mine.abort.abort();
      await mine.done;
      if (mine.meetingId === null || !getLiveRecorder(mine.meetingId)) return;
      try {
        await stopActiveLiveCapture();
      } catch {
        // 결과는 recordingStatus의 end가 말해 준다.
      }
    },
    recordingStatus: () => liveSessionSnapshot(),
    async finishRecording() {
      try {
        await finishLiveCapture();
      } catch {
        // 던지면 executeJavaScript가 거부로 끝난다. 실패는 end: "failed"로 읽힌다.
      }
    },
    openMeeting(id: string) {
      deps?.navigate(`/meetings/${id}`);
    },
    uiLanguage: languageStore.bridge,
  };
}
