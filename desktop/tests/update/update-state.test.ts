import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { makeUpdateStateStore, UPDATE_STATE_FILE } from "../../src/update/update-state";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "update-state-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.chmodSync(d, 0o700);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("makeUpdateStateStore", () => {
  it("파일이 없으면 건너뛴 버전이 없다", () => {
    expect(makeUpdateStateStore(tmp(), () => undefined).loadSkipped()).toBeNull();
  });

  it("저장한 값을 다음 실행이 읽는다", () => {
    const dir = tmp();
    makeUpdateStateStore(dir, () => undefined).saveSkipped("0.4.0");
    expect(makeUpdateStateStore(dir, () => undefined).loadSkipped()).toBe("0.4.0");
    expect(JSON.parse(fs.readFileSync(path.join(dir, UPDATE_STATE_FILE), "utf8"))).toEqual({ skippedVersion: "0.4.0" });
  });

  it("임시 파일을 남기지 않는다", () => {
    const dir = tmp();
    makeUpdateStateStore(dir, () => undefined).saveSkipped("0.4.0");
    expect(fs.readdirSync(dir)).toEqual([UPDATE_STATE_FILE]);
  });

  it("손상·모양 불일치는 없음으로 읽는다", () => {
    for (const content of ["{not json", "[]", '{"skippedVersion": 4}', '{"skippedVersion": "v0.4.0"}']) {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, UPDATE_STATE_FILE), content);
      expect(makeUpdateStateStore(dir, () => undefined).loadSkipped()).toBeNull();
    }
  });

  it("쓰기에 실패하면 로그를 남기고 이번 실행에서는 메모리 값을 존중한다", () => {
    const dir = tmp();
    fs.chmodSync(dir, 0o500);
    const log: string[] = [];
    const store = makeUpdateStateStore(dir, (l) => log.push(l));
    store.saveSkipped("0.4.0");
    expect(store.loadSkipped()).toBe("0.4.0");
    expect(log.join("\n")).toContain("건너뛴 버전을 저장하지 못했어요");
  });
});
