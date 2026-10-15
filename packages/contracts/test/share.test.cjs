// contracts에는 테스트 러너 의존성이 없다 — node 내장 러너로 빌드 결과(dist/cjs)를 시험한다.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  SHARE_DURATION_DAYS,
  DEFAULT_SHARE_DURATION_DAYS,
  isShareDurationDays,
  SHARE_CONSENT_VERSION,
} = require("../dist/cjs/index.js");

test("공유 기간 목록과 기본값", () => {
  assert.deepEqual([...SHARE_DURATION_DAYS], [1, 7, 30]);
  assert.equal(DEFAULT_SHARE_DURATION_DAYS, 7);
});

test("isShareDurationDays — 목록 안의 숫자만", () => {
  for (const ok of [1, 7, 30]) assert.equal(isShareDurationDays(ok), true);
  for (const bad of [0, 2, 31, "7", null, undefined, Infinity]) assert.equal(isShareDurationDays(bad), false);
});

test("동의 문구 버전", () => {
  assert.equal(SHARE_CONSENT_VERSION, 1);
});
