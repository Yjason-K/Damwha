import type { MessageBoxOptions } from "electron";
import type { JournalStep, RestoreJournal } from "../services/postgres/restore-journal";
import type { SnapshotInfo, SnapshotManifest } from "../services/postgres/snapshot";

/**
 * 되돌리기의 정책과 문구 (Phase 6b-2 스펙 §7). 대화상자를 띄우는 것은 main.ts다. electron을 값으로 import하지 않는다.
 * `cancelId`를 반드시 준다 — 한국어 라벨은 취소로 인식되지 않아 Escape가 파괴적 선택을 고를 수 있다(6b-1 스펙 §3-11).
 */

export const RELEASES_PAGE_URL = "https://github.com/Yjason-K/Damwha/releases";

export function restoreMenuEnabled(s: { external: boolean; restorable: readonly SnapshotInfo[]; journalPresent: boolean }): boolean {
  return !s.external && !s.journalPresent && s.restorable.length > 0;
}

export function versionOfBuild(build: string | null): string | null {
  return build === null ? null : build.split("+")[0];
}

export function snapshotLine(m: SnapshotManifest, fmt: (iso: string) => string): string {
  const from = versionOfBuild(m.fromBuild) ?? "이전 판";
  const unclean = m.clusterState === "shut down" ? "" : " (비정상 종료 뒤의 상태)";
  return `${from} → ${versionOfBuild(m.toBuild)} 업데이트 직전 · ${fmt(m.createdAt)}${unclean}`;
}

export function confirmRestoreDialog(
  snaps: readonly SnapshotInfo[],
  fmt: (iso: string) => string,
): { options: MessageBoxOptions; choices: (string | null)[] } {
  const buttons = [...snaps.map((s) => `${fmt(s.manifest.createdAt)} 상태로 되돌리고 다시 시작`), "취소"];
  return {
    options: {
      type: "warning",
      message: "업데이트 전으로 되돌릴까요?",
      detail: [
        ...snaps.map((s) => `• ${snapshotLine(s.manifest, fmt)}`),
        "",
        "그 뒤에 만든 회의와 바꾼 설정은 지우지 않고 data.replaced-… 폴더로 옮겨 둬요. 토큰·마이크 권한·모델은 그대로예요. 앱이 다시 시작돼요.",
      ].join("\n"),
      buttons,
      defaultId: buttons.length - 1,
      cancelId: buttons.length - 1,
      noLink: true,
    },
    choices: [...snaps.map((s) => s.id), null],
  };
}

export type HoldChoice = "quit" | "download" | "continue";

export function holdDialog(
  h: { journal: RestoreJournal; snapshot: SnapshotInfo | null; replacedDir: string },
  fmt: (iso: string) => string,
): { options: MessageBoxOptions; choices: HoldChoice[] } {
  const when = fmt(h.journal.completedAt ?? h.journal.requestedAt);
  const at = h.snapshot === null ? "" : `(${fmt(h.snapshot.manifest.createdAt)} 상태)`;
  const prev = versionOfBuild(h.snapshot?.manifest.fromBuild ?? null);
  const prevName = prev === null ? "업데이트 전에 쓰던 판" : `이전 판(${prev})`;
  return {
    options: {
      type: "info",
      message: `${when}에 업데이트 전 데이터${at}로 되돌렸어요.`,
      detail: [
        "그 뒤 이전 판에서 쓴 내용은 지금 데이터에 그대로 있어요.",
        `되돌리기 전 데이터는 ${h.replacedDir}에 있어요.`,
        "",
        `${prevName}을 쓰려면 앱을 종료하고 그 판을 설치하세요. 이 판으로 계속하면 데이터를 다시 업데이트해요.`,
      ].join("\n"),
      buttons: ["종료", "다운로드 페이지 열고 종료", "이 판으로 계속"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    },
    choices: ["quit", "download", "continue"],
  };
}

const STEPS: readonly JournalStep[] = ["requested", "staged", "moved-aside", "hold"];

/** 실측용 `DAMWHA_RESTORE_PAUSE_AFTER_STEP` (스펙 §12.2-6). 모르는 값은 무시한다. */
export function parsePauseStep(v: string | undefined): JournalStep | null {
  return v !== undefined && (STEPS as readonly string[]).includes(v) ? (v as JournalStep) : null;
}

/**
 * 데이터 가드의 파일 I/O를 종료 흐름이 기다리게 한다 (스펙 §5.2 "종료와의 관계"). 감독자가 없으면 stopServices가 곧바로
 * 끝나 `/bin/cp`가 Electron 뒤에 남는다. 대화상자(보류)는 넣지 않는다 — 종료가 사람의 선택을 기다리면 순환이다.
 */
/** 종료의 서비스 정지를 가드 I/O가 끝난 **뒤에** 부른다. main의 stopServices가 이것으로 감싼다 — 배선을 테스트하려고 뺐다. */
export async function afterIo<T>(io: { settled(): Promise<void> }, stop: () => Promise<T>): Promise<T> {
  await io.settled();
  return stop();
}

export function createIoTracker(): { track<T>(p: Promise<T>): Promise<T>; settled(): Promise<void> } {
  const pending = new Set<Promise<unknown>>();
  return {
    track<T>(p: Promise<T>): Promise<T> {
      const tracked = p.catch(() => undefined);
      pending.add(tracked);
      void tracked.finally(() => pending.delete(tracked));
      return p;
    },
    async settled(): Promise<void> {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}
