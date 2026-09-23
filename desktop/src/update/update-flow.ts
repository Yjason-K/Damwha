import { failureMessage, type NewerChoice } from "./dialogs";
import { DEFAULT_RATE_LIMIT_WAIT_MS, type CheckResult } from "./release-check";

/**
 * 새 버전 알림의 정책 (Phase 6b-1 스펙 §4.3). 잎은 main.ts가 주입한다.
 *
 * - **자동**은 방해하지 않는다: 실패는 로그만, 건너뛴 버전·이미 보인 버전은 조용히, 화면이 안 붙었거나
 *   녹음 중이거나 다른 모달이 떠 있거나 종료 중이면 보류한다. 보류 표시는 두지 않는다 — 다음 자동 확인이
 *   다시 조회하면 같은 결과가 나온다.
 * - **수동**은 사람이 방금 누른 메뉴에 대한 답이라 결과를 항상 말한다(main.ts의 ask()와 같은 원칙).
 * - 조회는 공유하고(동시 호출 → 한 번), 대화상자는 동시에 하나다. 수동은 조회 **전에** 잠금을 잡아
 *   연타와 자동을 앞선다.
 * - 한도(rate_limited)를 받으면 만료까지 요청 없이 실패로 답한다 — 연타가 한도를 더 태우지 않는다.
 */
export interface UpdateFlowDeps {
  check(): Promise<CheckResult>;
  now(): number;
  isAttached(): boolean;
  isRecording(): Promise<boolean>;
  isShuttingDown(): boolean;
  isOtherModalOpen(): boolean;
  loadSkipped(): string | null;
  saveSkipped(version: string): void;
  showNewer(info: { current: string; latest: string }): Promise<NewerChoice>;
  showInfo(info: { kind: "current"; current: string } | { kind: "failed"; detail: string }): Promise<void>;
  openExternal(url: string): Promise<void>;
  log(line: string): void;
}

export interface UpdateFlow {
  autoCheck(): Promise<void>;
  manualCheck(): Promise<void>;
}

type Newer = Extract<CheckResult, { kind: "newer" }>;

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createUpdateFlow(deps: UpdateFlowDeps, current: string): UpdateFlow {
  let inflight: Promise<CheckResult> | null = null;
  let blockedUntil = 0;
  let presenting = false;
  const shown = new Set<string>();

  function check(): Promise<CheckResult> {
    const now = deps.now();
    if (now < blockedUntil) {
      return Promise.resolve({ kind: "failed", reason: "rate_limited", detail: "쿨다운", retryAfterMs: blockedUntil - now });
    }
    if (inflight !== null) return inflight;
    const started = deps.check().then(
      (r) => {
        if (r.kind === "failed" && r.reason === "rate_limited") {
          blockedUntil = deps.now() + (r.retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS);
        }
        return r;
      },
      (e: unknown): CheckResult => ({ kind: "failed", reason: "offline", detail: reasonOf(e) }),
    );
    inflight = started.finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function holdReason(): string | null {
    if (deps.isShuttingDown()) return "종료 중";
    if (!deps.isAttached()) return "담화 화면이 붙지 않음";
    if (deps.isOtherModalOpen()) return "다른 대화상자가 떠 있음";
    return null;
  }

  async function presentNewer(r: Newer): Promise<void> {
    shown.add(r.version);
    const choice = await deps.showNewer({ current, latest: r.version });
    if (deps.isShuttingDown()) {
      deps.log(`업데이트 알림: 종료가 시작돼 선택(${choice})을 버렸어요`);
      return;
    }
    if (choice === "open") await deps.openExternal(r.url);
    else if (choice === "skip") deps.saveSkipped(r.version);
  }

  return {
    async autoCheck() {
      if (deps.isShuttingDown()) return;
      const r = await check();
      if (r.kind === "failed") {
        deps.log(`업데이트 확인 실패 (${r.reason}) — ${r.detail}`);
        return;
      }
      // 조용히 끝나는 갈래도 한 줄 남긴다 — 실측이 "타이머가 돌았다"를 로그로 판정한다(계획 T10).
      if (r.kind === "current") {
        deps.log(`업데이트 확인: 최신 (${r.latest})`);
        return;
      }
      if (r.version === deps.loadSkipped()) {
        deps.log(`업데이트 확인: ${r.version} (건너뛴 버전)`);
        return;
      }
      if (shown.has(r.version)) {
        deps.log(`업데이트 확인: ${r.version} (이번 실행에서 이미 알림)`);
        return;
      }

      const before = holdReason();
      if (before !== null) {
        deps.log(`업데이트 알림 보류: ${before} (${r.version})`);
        return;
      }
      let recording: boolean;
      try {
        recording = await deps.isRecording();
      } catch {
        recording = true;
      }
      if (recording) {
        deps.log(`업데이트 알림 보류: 녹음 중 (${r.version})`);
        return;
      }
      const after = holdReason();
      if (after !== null) {
        deps.log(`업데이트 알림 보류: ${after} (${r.version})`);
        return;
      }
      // 기다리는 사이 다른 확인이 이 버전을 이미 띄웠거나(수동·다른 자동) 건너뛰기가 저장됐을 수 있다.
      // presenting만 보면 먼저 띄운 대화상자가 **닫힌 뒤** 도착한 쪽이 같은 버전을 또 띄운다 (계획 검증 #3).
      if (presenting || shown.has(r.version) || r.version === deps.loadSkipped()) {
        deps.log(`업데이트 알림 버림: 이미 처리됨 (${r.version})`);
        return;
      }

      presenting = true;
      try {
        await presentNewer(r);
      } catch (e) {
        deps.log(`업데이트 알림을 띄우지 못했어요 — ${reasonOf(e)}`);
      } finally {
        presenting = false;
      }
    },

    async manualCheck() {
      if (deps.isShuttingDown() || presenting) return;
      presenting = true;
      try {
        const r = await check();
        if (deps.isShuttingDown()) return;
        if (r.kind === "newer") await presentNewer(r);
        else if (r.kind === "current") await deps.showInfo({ kind: "current", current });
        else await deps.showInfo({ kind: "failed", detail: failureMessage(r) });
      } catch (e) {
        deps.log(`업데이트 알림을 띄우지 못했어요 — ${reasonOf(e)}`);
      } finally {
        presenting = false;
      }
    },
  };
}
