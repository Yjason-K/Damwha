import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptShare, decryptShare, generateShareKey, SHARE_ID_RE } from "../dist/esm/index.js";

test("ESM 빌드에서 named export로 왕복한다", async () => {
  const key = generateShareKey();
  const p = { v: 1, created_at: "a", ui_language: "en", meeting: { title: null, recorded_at: "c", duration_ms: null }, speakers: [] };
  assert.deepEqual(await decryptShare(await encryptShare(p, key), key), p);
  assert.ok(SHARE_ID_RE instanceof RegExp);
});
