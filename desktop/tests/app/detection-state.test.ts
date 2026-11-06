import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { DETECTION_STATE_FILE, makeDetectionStateStore } from "../../src/app/detection-state";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "detection-state-"));
}

describe("makeDetectionStateStore", () => {
  it("파일이 없으면 켜짐", () => {
    expect(makeDetectionStateStore(tmp(), () => undefined).enabled()).toBe(true);
  });

  it("깨진 파일이면 켜짐", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, DETECTION_STATE_FILE), "{not json");
    expect(makeDetectionStateStore(dir, () => undefined).enabled()).toBe(true);
    fs.writeFileSync(path.join(dir, DETECTION_STATE_FILE), JSON.stringify({ enabled: "no" }));
    expect(makeDetectionStateStore(dir, () => undefined).enabled()).toBe(true);
  });

  it("저장 후 새 store가 읽는다", () => {
    const dir = tmp();
    makeDetectionStateStore(dir, () => undefined).setEnabled(false);
    expect(makeDetectionStateStore(dir, () => undefined).enabled()).toBe(false);
    makeDetectionStateStore(dir, () => undefined).setEnabled(true);
    expect(makeDetectionStateStore(dir, () => undefined).enabled()).toBe(true);
  });

  it("쓰기 실패여도 이번 실행은 메모리 값을 쓴다", () => {
    const log = vi.fn();
    const store = makeDetectionStateStore(path.join(tmp(), "없는-디렉터리"), log);
    store.setEnabled(false);
    expect(store.enabled()).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("위치를 저장해도 enabled가 남는다", () => {
    const dir = tmp();
    const store = makeDetectionStateStore(dir, () => undefined);
    store.setEnabled(false);
    store.setPillPosition({ x: 10, y: 20 });
    const again = makeDetectionStateStore(dir, () => undefined);
    expect(again.enabled()).toBe(false);
    expect(again.pillPosition()).toEqual({ x: 10, y: 20 });
  });

  it("enabled를 바꿔도 위치가 남는다", () => {
    const dir = tmp();
    const store = makeDetectionStateStore(dir, () => undefined);
    store.setPillPosition({ x: 10, y: 20 });
    store.setEnabled(false);
    expect(makeDetectionStateStore(dir, () => undefined).pillPosition()).toEqual({ x: 10, y: 20 });
  });

  it("위치가 잘못되면 null이고 enabled는 그대로다", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, DETECTION_STATE_FILE), JSON.stringify({ enabled: false, pill: { x: "a", y: null } }));
    const s = makeDetectionStateStore(dir, () => undefined);
    expect(s.pillPosition()).toBeNull();
    expect(s.enabled()).toBe(false);
  });
});
