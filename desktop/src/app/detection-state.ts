import * as fs from "fs";
import * as path from "path";

/**
 * 회의 감지 켜고 끄기의 영속화. update-state.ts와 같은 모양이다.
 *
 * config.json에 넣지 않는다 — 그 파일은 사람이 손으로 고치고 앱은 다시 쓰지 않는다. 못 읽으면(없음·깨짐)
 * 켜짐이 기본이고, 못 쓰면 이번 실행 동안은 메모리 값을 존중한다.
 */
export const DETECTION_STATE_FILE = "detection-state.json";

export interface DetectionStateStore {
  enabled(): boolean;
  setEnabled(on: boolean): void;
}

export function makeDetectionStateStore(userData: string, log: (line: string) => void): DetectionStateStore {
  const file = path.join(userData, DETECTION_STATE_FILE);
  let memo: boolean | undefined;

  function readFile(): boolean {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return true;
      const v = (raw as { enabled?: unknown }).enabled;
      return typeof v === "boolean" ? v : true;
    } catch {
      return true;
    }
  }

  return {
    enabled() {
      if (memo === undefined) memo = readFile();
      return memo;
    },
    setEnabled(on) {
      memo = on;
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify({ enabled: on }));
        fs.renameSync(tmp, file);
      } catch (e) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // 임시 파일을 못 지워도 할 수 있는 것이 없다.
        }
        log(`회의 감지 설정을 저장하지 못했어요 — ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
