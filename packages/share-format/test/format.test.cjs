const { test } = require("node:test");
const assert = require("node:assert/strict");
const f = require("../dist/cjs/index.js");

const payload = () => ({
  v: 1,
  created_at: "2026-10-09T00:00:00.000Z",
  ui_language: "ko",
  meeting: { title: "주간 회의 🗓️", recorded_at: "2026-10-08T01:00:00.000Z", duration_ms: 3_600_000 },
  speakers: [{ ref: "s1", name: "김담화" }, { ref: "s2", name: null }],
  summary: { topics: ["배포 일정"], segments: [{ title: "배포", bullets: ["다음 주 화요일 🚀"], start_ms: 0, end_ms: 60_000 }] },
  lenses: [{ kind: "action", text: "릴리스 노트 쓰기", done: false, due_at: "2026-10-14", assignee_ref: "s1", start_ms: 1000, linkable: true }],
  transcript: [{ speaker_ref: "s1", start_ms: 1000, end_ms: 4000, text: "가".repeat(10_000) }],
  note: { body_md: "## 메모\n- 확인 ✅" },
});

test("왕복 — 한글·이모지·긴 문자열이 그대로 돌아온다", async () => {
  const key = f.generateShareKey();
  const env = await f.encryptShare(payload(), key);
  assert.equal(env[0], f.SHARE_FORMAT_VERSION);
  assert.deepEqual(await f.decryptShare(env, key), payload());
});

test("같은 페이로드도 매번 다른 봉투다 (IV)", async () => {
  const key = f.generateShareKey();
  const a = await f.encryptShare(payload(), key);
  const b = await f.encryptShare(payload(), key);
  assert.notDeepEqual(Buffer.from(a), Buffer.from(b));
});

test("키는 32바이트 base64url (43자)", () => {
  const key = f.generateShareKey();
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(f.fromBase64Url(key).length, 32);
});

const rejects = (p, code) => assert.rejects(p, (e) => e instanceof f.ShareFormatError && e.code === code);

test("다른 키 → bad_key", async () => {
  const env = await f.encryptShare(payload(), f.generateShareKey());
  await rejects(f.decryptShare(env, f.generateShareKey()), "bad_key");
});

test("암호문 한 바이트 변조 → bad_key (GCM 태그)", async () => {
  const key = f.generateShareKey();
  const env = await f.encryptShare(payload(), key);
  env[env.length - 1] ^= 0x01;
  await rejects(f.decryptShare(env, key), "bad_key");
});

test("버전 바이트가 다르면 unsupported_version", async () => {
  const key = f.generateShareKey();
  const env = await f.encryptShare(payload(), key);
  env[0] = 2;
  await rejects(f.decryptShare(env, key), "unsupported_version");
});

test("너무 짧은 봉투 → bad_envelope", async () => {
  await rejects(f.decryptShare(new Uint8Array(10), f.generateShareKey()), "bad_envelope");
});

test("키 형식이 틀리면 bad_key", async () => {
  const env = await f.encryptShare(payload(), f.generateShareKey());
  await rejects(f.decryptShare(env, "not base64url!"), "bad_key");
  await rejects(f.decryptShare(env, f.toBase64Url(new Uint8Array(16))), "bad_key");
});

test("16바이트 키로는 암호화도 거절한다 (AES-128로 조용히 내려가지 않는다)", async () => {
  await rejects(f.encryptShare(payload(), f.toBase64Url(new Uint8Array(16))), "bad_key");
});

test("v1 모양이 아니면 bad_payload", async () => {
  const key = f.generateShareKey();
  const env = await f.encryptShare({ v: 2 }, key);
  await rejects(f.decryptShare(env, key), "bad_payload");
});

test("isSharePayloadV1 — 선택 섹션은 없어도 되고, 있으면 모양이 맞아야 한다", () => {
  const p = payload();
  assert.equal(f.isSharePayloadV1(p), true);
  const { summary, lenses, transcript, note, ...bare } = p;
  assert.equal(f.isSharePayloadV1(bare), true);
  assert.equal(f.isSharePayloadV1({ ...bare, note: { body_md: 3 } }), false);
  assert.equal(f.isSharePayloadV1({ ...bare, lenses: {} }), false);
  assert.equal(f.isSharePayloadV1({ ...bare, ui_language: "ja" }), false);
  assert.equal(f.isSharePayloadV1(null), false);
});

test("공유 id 규칙과 기간", () => {
  assert.match("7-AAAAAAAAAAAAAAAAAAAAAA", f.SHARE_ID_RE);
  assert.match("30-abcdefghijklmnopqrstu_", f.SHARE_ID_RE);
  for (const bad of ["2-AAAAAAAAAAAAAAAAAAAAAA", "7-AAAA", "7_AAAAAAAAAAAAAAAAAAAAAA", "../d7/x"]) {
    assert.doesNotMatch(bad, f.SHARE_ID_RE);
  }
  assert.equal(f.shareIdDays("1-AAAAAAAAAAAAAAAAAAAAAA"), 1);
});

test("be가 만드는 id·삭제 토큰", () => {
  for (const d of [1, 7, 30]) {
    const id = f.newShareId(d);
    assert.match(id, f.SHARE_ID_RE);
    assert.equal(f.shareIdDays(id), d);
  }
  assert.notEqual(f.newShareId(7), f.newShareId(7));
  assert.match(f.newDeleteToken(), f.DELETE_TOKEN_RE);
  assert.notEqual(f.newDeleteToken(), f.newDeleteToken());
});

test("봉투 상한은 5MiB", () => {
  assert.equal(f.SHARE_MAX_ENVELOPE_BYTES, 5 * 1024 * 1024);
});
