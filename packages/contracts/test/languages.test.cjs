// contracts에는 테스트 러너 의존성이 없다 — node 내장 러너로 빌드 결과(dist/cjs)를 시험한다.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  UI_LANGUAGES,
  SUMMARY_LANGUAGES,
  isUiLanguage,
  isSummaryLanguage,
  pickUiLanguage,
} = require("../dist/cjs/index.js");

test("목록", () => {
  assert.deepEqual([...UI_LANGUAGES], ["ko", "en"]);
  assert.deepEqual([...SUMMARY_LANGUAGES], ["transcript", "ko", "en"]);
});

test("pickUiLanguage — 앞에서부터 처음 걸리는 ko/en", () => {
  const table = [
    [["ko-KR"], "ko"],
    [["ko"], "ko"],
    [["KO_kr"], "ko"],
    [["en-US"], "en"],
    [["en-GB", "ko-KR"], "en"],
    [["ja-JP", "ko-KR"], "ko"],
    [["ja-JP", "en-US"], "en"],
    [["ja-JP"], "en"],
    [[], "en"],
    [["kok-IN"], "en"], // 콘칸어 — 접두 'ko'지만 한국어가 아니다
    [["  ko-KR  "], "ko"],
  ];
  for (const [input, want] of table) {
    assert.equal(pickUiLanguage(input), want, JSON.stringify(input));
  }
});

test("isUiLanguage / isSummaryLanguage", () => {
  assert.equal(isUiLanguage("ko"), true);
  assert.equal(isUiLanguage("transcript"), false);
  assert.equal(isUiLanguage(null), false);
  assert.equal(isSummaryLanguage("transcript"), true);
  assert.equal(isSummaryLanguage("ja"), false);
});
