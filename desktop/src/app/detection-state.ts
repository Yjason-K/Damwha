import * as fs from "fs";
import * as path from "path";

/**
 * 회의 감지 켜고 끄기와 녹음 중 알약의 마지막 자리의 영속화. update-state.ts와 같은 모양이다.
 *
 * config.json에 넣지 않는다 — 그 파일은 사람이 손으로 고치고 앱은 다시 쓰지 않는다. 못 읽으면(없음·깨짐)
 * 켜짐이 기본이고, 못 쓰면 이번 실행 동안은 메모리 값을 존중한다.
 */
export const DETECTION_STATE_FILE = "detection-state.json";

export interface PillPoint {
  x: number;
  y: number;
}

export interface DetectionStateStore {
  enabled(): boolean;
  setEnabled(on: boolean): void;
  /** 녹음 중 알약을 마지막으로 둔 자리. 저장된 적 없거나 값이 깨졌으면 null. */
  pillPosition(): PillPoint | null;
  setPillPosition(p: PillPoint): void;
}

interface State {
  enabled: boolean;
  pill: PillPoint | null;
}

export function makeDetectionStateStore(userData: string, log: (line: string) => void): DetectionStateStore {
  const file = path.join(userData, DETECTION_STATE_FILE);
  let memo: State | undefined;

  function readFile(): State {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { enabled: true, pill: null };
      const { enabled, pill } = raw as { enabled?: unknown; pill?: unknown };
      let point: PillPoint | null = null;
      if (pill !== null && typeof pill === "object" && !Array.isArray(pill)) {
        const { x, y } = pill as { x?: unknown; y?: unknown };
        if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) point = { x, y };
      }
      return { enabled: typeof enabled === "boolean" ? enabled : true, pill: point };
    } catch {
      return { enabled: true, pill: null };
    }
  }

  function state(): State {
    if (memo === undefined) memo = readFile();
    return memo;
  }

  function write(next: State): void {
    memo = next;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      const body = next.pill ? { enabled: next.enabled, pill: next.pill } : { enabled: next.enabled };
      fs.writeFileSync(tmp, JSON.stringify(body));
      fs.renameSync(tmp, file);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // 임시 파일을 못 지워도 할 수 있는 것이 없다.
      }
      log(`회의 감지 설정을 저장하지 못했어요 — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    enabled: () => state().enabled,
    setEnabled: (on) => write({ ...state(), enabled: on }),
    pillPosition: () => state().pill,
    setPillPosition: (p) => write({ ...state(), pill: { x: p.x, y: p.y } }),
  };
}
