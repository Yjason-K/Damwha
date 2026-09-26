import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { makeUiLanguageStore, UI_LANGUAGE_FILE } from "../../src/config/ui-language-store";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-lang-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("makeUiLanguageStore", () => {
  it("파일이 없으면 null — 기기 언어를 따른다", () => {
    expect(makeUiLanguageStore(tmp()).read()).toBeNull();
  });
  it("쓴 값을 읽는다", () => {
    const d = tmp();
    makeUiLanguageStore(d).write("en");
    expect(makeUiLanguageStore(d).read()).toBe("en");
    expect(JSON.parse(fs.readFileSync(path.join(d, UI_LANGUAGE_FILE), "utf8"))).toEqual({ language: "en" });
  });
  it("깨진 JSON·범위 밖 값·모양이 다른 값은 null — 기동을 막지 않는다", () => {
    for (const body of ["{", '{"language":"fr"}', '"en"', "null", '{"lang":"en"}']) {
      const d = tmp();
      fs.writeFileSync(path.join(d, UI_LANGUAGE_FILE), body);
      expect(makeUiLanguageStore(d).read()).toBeNull();
    }
  });
  it("쓰기는 임시 파일을 남기지 않는다", () => {
    const d = tmp();
    makeUiLanguageStore(d).write("ko");
    expect(fs.readdirSync(d)).toEqual([UI_LANGUAGE_FILE]);
  });
  it("쓸 수 없는 폴더면 던진다 — 호출자가 이전 값으로 되돌린다", () => {
    const store = makeUiLanguageStore(path.join(tmp(), "no", "such", "dir"));
    expect(() => store.write("en")).toThrow();
  });
});
