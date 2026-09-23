import * as fs from "fs";
import * as path from "path";
import { INSTALLED_VERSION_SHAPE } from "./release-check";

/**
 * "이 버전 건너뛰기"의 영속화 (Phase 6b-1 스펙 §4.2).
 *
 * **config.json에 넣지 않는다** — 그 파일은 자식 env의 원천이고 사람이 손으로 고친다. 앱이 쓰는 상태를
 * 섞으면 저장 한 번이 사람의 편집을 덮는다. 못 읽으면 "없음"이고, 못 쓰면 이번 실행 동안 메모리 값으로
 * 존중한다 — 알림 하나 때문에 앱이 멈출 이유가 없다.
 */
export const UPDATE_STATE_FILE = "update-state.json";

export interface UpdateStateStore {
  loadSkipped(): string | null;
  saveSkipped(version: string): void;
}

export function makeUpdateStateStore(userData: string, log: (line: string) => void): UpdateStateStore {
  const file = path.join(userData, UPDATE_STATE_FILE);
  let memo: string | null | undefined;

  function readFile(): string | null {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
      const v = (raw as { skippedVersion?: unknown }).skippedVersion;
      return typeof v === "string" && INSTALLED_VERSION_SHAPE.test(v) ? v : null;
    } catch {
      return null;
    }
  }

  return {
    loadSkipped() {
      if (memo === undefined) memo = readFile();
      return memo;
    },
    saveSkipped(version) {
      memo = version;
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify({ skippedVersion: version }));
        fs.renameSync(tmp, file);
      } catch (e) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // 임시 파일을 못 지워도 할 수 있는 것이 없다.
        }
        log(`건너뛴 버전을 저장하지 못했어요 — ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
