import { describe, expect, it } from "vitest";
import * as contracts from "@damwha/contracts";
import { isUiLanguage, pickUiLanguage, UI_LANGUAGES } from "../../src/i18n/locale";

/**
 * desktop은 런타임 의존성이 없어(electron-builder.yml — asar에는 컴파일된 main만) contracts를 import하지
 * 못하고 사본을 둔다. 이 표가 두 벌이 같은 답을 내는지 묶는다.
 */
const INPUTS: string[][] = [
  ["ko-KR"], ["ko"], ["KO_kr"], ["en-US"], ["en-GB", "ko-KR"], ["ja-JP", "ko-KR"],
  ["ja-JP", "en-US"], ["ja-JP"], [], ["kok-IN"], ["  ko-KR  "], ["zh-Hans-CN", "fr-FR"],
];

describe("locale — contracts와 같은 규칙", () => {
  it("목록이 같다", () => {
    expect([...UI_LANGUAGES]).toEqual([...contracts.UI_LANGUAGES]);
  });
  it.each(INPUTS.map((i) => [i]))("pickUiLanguage(%j)", (input) => {
    expect(pickUiLanguage(input)).toBe(contracts.pickUiLanguage(input));
  });
  it("isUiLanguage", () => {
    for (const v of ["ko", "en", "ja", "transcript", null, 1]) {
      expect(isUiLanguage(v)).toBe(contracts.isUiLanguage(v));
    }
  });
});
