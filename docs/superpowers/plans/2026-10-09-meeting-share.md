# 회의 공유 링크 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 회의 하나를 암호화된 고정 스냅샷으로 개인 서버의 공유 서버에 올리고, `https://<share>/s/<id>#<key>` 링크를 가진 사람만 브라우저에서 읽게 한다. 링크는 1·7·30일 뒤 막히고, 앱에서 언제든 중지할 수 있다.

**Architecture:** 암호화 포맷은 `packages/share-format`(be가 암호화, 뷰어가 복호화), 화면 렌더러는 `packages/share-view`(fe 미리보기와 뷰어가 같은 React 컴포넌트를 쓴다). 공유 서버 `share/`는 개인 서버의 Docker 컨테이너에서 도는 Node 프로세스 하나로, API(`/api/shares`)와 정적 뷰어(`/s/:id`)를 디스크 파일 위에서 서빙하고 Cloudflare Tunnel로 `https://damwha-share.0kimjae.dev`에 공개된다. be의 `src/shares/`가 스냅샷 → 암호화 → 업로드 → 확정을 하고, `meeting_share` 테이블이 활성 링크와 철회 대기열을 겸한다. 공유는 be가 loopback에 바인드되고 데모가 아닐 때만 켜진다.

**Tech Stack:** NestJS 10 + pg(raw SQL) + zod, React 19 + TanStack Query + i18next, Node 22 + `@hono/node-server`(공유 서버), Docker, Cloudflare Tunnel(사용자가 연결), WebCrypto AES-256-GCM + CompressionStream gzip, vitest / jest / node:test.

**Spec:** `docs/superpowers/specs/2026-10-09-meeting-share-selfhost-design.md` (같은 날짜의 Worker판 spec과 2026-10-08 spec을 대체). 선행: `docs/superpowers/reports/2026-10-08-local-api-access-control-results.md`의 "공유 기능이 따를 규칙".

## Global Constraints

- 공유 기간은 `1 | 7 | 30`일, 기본 7. 무제한 없음. 목록은 `@damwha/contracts`의 `SHARE_DURATION_DAYS` 하나뿐이다.
- 봉투 상한 `SHARE_MAX_ENVELOPE_BYTES = 5 * 1024 * 1024`. be와 공유 서버가 같은 상수를 `@damwha/share-format`에서 읽는다.
- 키는 공유마다 새로 만든 AES-256-GCM 32바이트, base64url. 서버·레포·env에 저장하지 않는다. 로컬 `meeting_share.share_key`에만, 공유가 끝나면 NULL.
- 봉투 = `[버전 1바이트 = 1][IV 12바이트][암호문+태그]`, 평문 = `gzip(JSON.stringify(payload))`.
- 공유 id = `<기간>-<22자 base64url>`(`SHARE_ID_RE = /^(1|7|30)-[A-Za-z0-9_-]{22}$/`). 공유 서버의 파일 이름은 이 정규식을 통과한 id만 쓴다.
- 만료 시각의 권위는 공유 서버다. 페이로드에는 만료 시각이 없고, be는 서버가 돌려준 `expires_at`만 저장한다. 뷰어는 `X-Share-Expires-At` 응답 헤더로 받는다.
- 새 링크를 만들 때 기존 링크는 업로드 요청의 `X-Replace-Id`·`X-Replace-Token`으로 **같은 요청 안에서** 서버가 지운다.
- 공유 서버의 포트는 호스트 `127.0.0.1`에만 연다 — 그래야 `CF-Connecting-IP`를 믿을 수 있다.
- 공유는 `HOST ∈ {127.0.0.1, ::1, localhost}`이고 `DEMO_READ_ONLY !== 'true'`일 때만 켜진다. 아니면 공유 라우트 전부 404, 스윕 안 돎.
- 공유 라우트의 쓰기는 POST·DELETE뿐이다. 상태를 바꾸는 GET을 만들지 않는다(선행 결과 규칙 1).
- 공유 서비스 도메인을 be의 `ALLOWED_ORIGINS`에 넣지 않는다(선행 결과 규칙 2).
- be가 공유 서비스로 보내는 요청: `https:`만(개발용 `http://localhost`·`http://127.0.0.1` 예외), 리다이렉트 안 따라감, 타임아웃 10초, 키·삭제 토큰을 로그·오류 메시지에 싣지 않는다.
- 동의 문구 버전 `SHARE_CONSENT_VERSION = 1`(`@damwha/contracts`). be는 다른 버전을 400으로 거절하고, 발화 기록 포함이면 `transcript_ack: true`도 필수.
- 오디오·성문·저장한 발화·태그·폴더·즐겨찾기·`is_me`는 어떤 경로로도 페이로드에 들어가지 않는다. 페이로드는 허용 목록으로 새로 만든다.
- 공유본에 내부 id(`mtg_`, `utt_`, `spk_`, `lens_`)를 넣지 않는다. 근거 원문 인용도 넣지 않는다.
- `share/`의 스크립트 이름에 `dev`를 쓰지 않는다(루트 `pnpm dev`가 `--recursive run dev`). 로컬 실행은 `pnpm share:dev`.
- 새 워크스페이스 패키지는 CJS+ESM 둘 다 낸다(`share-format`). `share-view`는 소스(TSX)를 내보내고 Vite 소비자만 쓴다.
- 운영 공유 서버 주소의 기본값은 `https://damwha-share.0kimjae.dev`(아직 Tunnel 연결 전). `be/src/config/env.ts`의 기본값 한 곳에만 있다.
- GET 핸들러는 DB를 바꾸지 않는다. 만료 정리(`expired`로 바꾸기)는 스위퍼만 한다 — GET은 만료가 지난 행을 걸러 읽기만 한다.
- 모든 사용자 문구는 ko·en 둘 다. 문구 원문은 spec §2.6·§2.9를 따른다.
- 명령: be는 `pnpm --filter damwha-be exec …`(`pnpm be exec`는 깨져 있다), desktop은 `pnpm --filter damwha-desktop exec …`(`pnpm desktop exec`는 테스트 0개로 통과한다).

## Review Focus

- **한글·이모지 본문의 왕복.** 요약·메모에 한글과 이모지가 섞여도 복호화 결과가 바이트 단위로 같아야 한다 → Task 2 왕복 테스트에 한글·이모지·`\u0000` 없는 긴 문자열을 넣는다.
- **공유 버튼 연타.** 같은 회의에 공유 요청이 겹치면 둘 중 하나는 `409 SHARE_IN_PROGRESS`이고 링크는 하나만 남아야 한다. 화면은 일반 실패가 아니라 "이미 공유를 만드는 중"이라고 말해야 한다 → Task 10 동시성 e2e, Task 14 409 문구 테스트.
- **요약이 없거나 실패한 회의.** 요약 `failed`·없음·렌즈 0개·발화 0개인 회의도 공유가 되고(요약 체크만 비활성) 뷰어는 빈 섹션을 그리지 않아야 한다 → Task 9 빌더 테스트, Task 5 렌더러 테스트, Task 14 체크박스 비활성 테스트.
- **키가 사라진 공유의 링크.** `revoke_pending`·`expired`·`revoked` 행은 키가 NULL일 수 있고, 그때 `url`은 `null`이며 복사 버튼은 없어야 한다 → Task 10 `toView` 테스트, Task 14 관리 화면 테스트.
- **새 링크를 만든 직후의 기존 링크.** 응답이 돌아온 순간 기존 링크는 이미 "만료되었거나 중지되었어요"여야 한다. 교체 토큰이 틀리면 새 링크도 생기지 않아야 한다 → Task 3 교체 테스트, Task 10 교체 e2e(응답 직후 가짜 서버에 옛 객체 없음).
- **긴 회의의 크기.** 3시간 회의의 발화 기록은 압축 전 JSON이 5MB를 넘을 수 있다. 상한은 **압축·암호화 뒤 봉투** 크기로 판정하고, 넘으면 업로드 전에 `413 SHARE_TOO_LARGE`로 거절해야 한다 → Task 10 대용량 e2e(업로드 요청 0건 확인).

---

## 파일 구조

| 경로 | 책임 |
| --- | --- |
| `packages/contracts/src/index.ts` | `SHARE_DURATION_DAYS`, `DEFAULT_SHARE_DURATION_DAYS`, `isShareDurationDays`, `SHARE_CONSENT_VERSION` |
| `packages/share-format/` (신규) | 페이로드 타입·가드, 봉투 암호화/복호화, base64url, 공유 id 규칙, 상한 |
| `packages/share-view/` (신규) | `ShareDocument` React 렌더러 + ko/en 문구 + CSS |
| `share/` (신규, `damwha-share`) | 공유 서버(`src/` — 설정, 디스크 저장소, 제한, 핸들러, 정적 서빙, `main.ts`), 뷰어 앱(`viewer/`), 테스트 |
| `deploy/share/` (신규) | 공유 서버 Dockerfile, compose, Tunnel 연결 안내 |
| `be/src/database/migrations/032_meeting_share.sql` (신규) | `meeting_share` |
| `be/src/shares/` (신규) | 주소 검증, 활성 조건, 공유 서비스 클라이언트, 스냅샷, 페이로드 빌더, 저장소, 서비스, 컨트롤러, 스위퍼, 가드 |
| `be/src/meetings/meetings.service.ts` | 회의 삭제 시 공유 철회 |
| `fe/src/features/share/` (신규) | API 훅, 공유 다이얼로그, 헤더 버튼, 설정 섹션 |
| `fe/src/shared/i18n/locales/{ko,en}/share.ts` (신규) | `share` 네임스페이스 |
| `pnpm-workspace.yaml`, `deploy/api.Dockerfile`, `desktop/scripts/package.mjs`, `desktop/src/services/api-process.ts`, `demo/seed/build.sh` | 워크스페이스·패키징·데모 |
| `site/src/i18n/{ko,en}.ts` | 프라이버시·FAQ 문구 |

---
## 1단계 — 공유 계약과 암호화 포맷

### Task 1: contracts에 공유 기간·동의 버전

**Files:**
- Modify: `packages/contracts/src/index.ts` (파일 끝에 추가)
- Create: `packages/contracts/test/share.test.cjs`

**Interfaces:**
- Produces: `SHARE_DURATION_DAYS: readonly [1, 7, 30]`, `type ShareDurationDays = 1 | 7 | 30`, `DEFAULT_SHARE_DURATION_DAYS: ShareDurationDays` (= 7), `isShareDurationDays(v: unknown): v is ShareDurationDays`, `SHARE_CONSENT_VERSION: 1`.

- [ ] **Step 1: 실패하는 테스트**

`packages/contracts/test/share.test.cjs`:

```js
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
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @damwha/contracts test`
Expected: FAIL — `SHARE_DURATION_DAYS`가 `undefined`라 `deepEqual`이 실패한다.

- [ ] **Step 3: 구현**

`packages/contracts/src/index.ts` 끝에:

```ts
/**
 * 공유 링크 기간(일) (공유 spec 2026-10-09 §1). 무제한은 없다 — "늦어도 30일 뒤에는 막힌다"는 약속이
 * 이 목록에서 나온다. be(요청 검증)·fe(기간 선택)·share-format(공유 id 규칙)이 함께 읽는다.
 */
export const SHARE_DURATION_DAYS = [1, 7, 30] as const;
export type ShareDurationDays = (typeof SHARE_DURATION_DAYS)[number];
export const DEFAULT_SHARE_DURATION_DAYS: ShareDurationDays = 7;

export function isShareDurationDays(v: unknown): v is ShareDurationDays {
  return (SHARE_DURATION_DAYS as readonly unknown[]).includes(v);
}

/**
 * 공유 동의 문구의 버전 (spec §2.6). 문구를 바꾸면 올린다 — be는 현재 버전이 아닌 동의를 400으로
 * 거절하고, `meeting_share.consent_version`에 남긴다.
 */
export const SHARE_CONSENT_VERSION = 1;
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @damwha/contracts test`
Expected: PASS (기존 `languages.test.cjs` 포함 전부)

- [ ] **Step 5: 커밋**

```bash
git add packages/contracts/src/index.ts packages/contracts/test/share.test.cjs
git commit -m "feat(contracts): 공유 기간 목록과 동의 문구 버전"
```

### Task 2: `@damwha/share-format` — 페이로드와 봉투

**Files:**
- Create: `packages/share-format/package.json`, `tsconfig.base.json`, `tsconfig.cjs.json`, `tsconfig.esm.json`
- Create: `packages/share-format/src/index.ts`, `src/errors.ts`, `src/base64url.ts`, `src/constants.ts`, `src/payload.ts`, `src/envelope.ts`
- Create: `packages/share-format/test/format.test.cjs`, `test/esm.test.mjs`

spec §2.2는 이 패키지에 "zod 스키마"를 두라고 했지만 **의존성 없는 가드(`isSharePayloadV1`)로 대신한다.** 요청 검증은 be가 자기 zod로 하고(Task 10), 뷰어가 받는 페이로드는 GCM이 "키를 가진 쪽이 만들었다"를 보장하므로 버전과 큰 모양만 보면 된다. zod를 빼면 Docker 런타임·desktop 번들에 의존성이 하나 덜 실리고, contracts와 같은 CJS+ESM 빌드를 그대로 쓴다.

**Interfaces:**
- Consumes: `ShareDurationDays`, `UiLanguage` (Task 1, contracts)
- Produces:
  - `SHARE_FORMAT_VERSION = 1`, `SHARE_MAX_ENVELOPE_BYTES = 5_242_880`, `SHARE_ID_RE`, `shareIdDays(id: string): ShareDurationDays`
  - `type ShareScope = { summary: boolean; lenses: boolean; transcript: boolean; note: boolean; anonymize: boolean }`
  - `type ShareSpeaker`, `ShareSummarySegment`, `ShareLens`, `ShareUtterance`, `SharePayloadV1` (spec §2.2 그대로)
  - `isSharePayloadV1(x: unknown): x is SharePayloadV1`
  - `generateShareKey(): string`, `encryptShare(payload, keyB64): Promise<Uint8Array<ArrayBuffer>>`, `decryptShare(envelope: Uint8Array<ArrayBuffer>, keyB64): Promise<SharePayloadV1>`
  - `class ShareFormatError extends Error { code: 'bad_key' | 'bad_envelope' | 'unsupported_version' | 'bad_payload' }`
  - `toBase64Url(bytes: Uint8Array): string`, `fromBase64Url(s: string): Uint8Array<ArrayBuffer>`

- [ ] **Step 1: 패키지 뼈대**

`packages/share-format/package.json`:

```json
{
  "name": "@damwha/share-format",
  "version": "0.1.0",
  "private": true,
  "description": "Encrypted share envelope and payload shape. damwha-be encrypts, the share viewer decrypts — one copy of the format.",
  "license": "MIT",
  "type": "commonjs",
  "main": "dist/cjs/index.js",
  "module": "dist/esm/index.js",
  "types": "dist/cjs/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/cjs/index.d.ts",
      "import": "./dist/esm/index.js",
      "require": "./dist/cjs/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.cjs.json && tsc -p tsconfig.esm.json && node -e \"require('fs').writeFileSync('dist/esm/package.json', JSON.stringify({type:'module'}))\"",
    "prepare": "pnpm run build",
    "test": "pnpm run build && node --test \"test/*.test.cjs\" \"test/*.test.mjs\""
  },
  "dependencies": {
    "@damwha/contracts": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.9.3"
  }
}
```

`tsconfig.base.json` — contracts와 같되 `lib`에 `DOM`을 더한다(WebCrypto·`CompressionStream`·`Blob` 타입. 런타임은 Node 22·브라우저·workerd 모두 전역으로 갖고 있다):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM"],
    "declaration": true,
    "rootDir": "src",
    "strict": true
  },
  "include": ["src"]
}
```

`tsconfig.cjs.json`·`tsconfig.esm.json`은 `packages/contracts`의 두 파일을 그대로 복사한다(`outDir` `dist/cjs`·`dist/esm`).

Run: `pnpm install` (루트에서 — 새 워크스페이스 패키지를 링크한다)

- [ ] **Step 2: 실패하는 테스트**

`packages/share-format/test/format.test.cjs`:

```js
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

test("봉투 상한은 5MiB", () => {
  assert.equal(f.SHARE_MAX_ENVELOPE_BYTES, 5 * 1024 * 1024);
});
```

`packages/share-format/test/esm.test.mjs` — ESM 산출물이 named export를 내는지(CLAUDE.md의 `vite dev` 함정):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptShare, decryptShare, generateShareKey, SHARE_ID_RE } from "../dist/esm/index.js";

test("ESM 빌드에서 named export로 왕복한다", async () => {
  const key = generateShareKey();
  const p = { v: 1, created_at: "a", ui_language: "en", meeting: { title: null, recorded_at: "c", duration_ms: null }, speakers: [] };
  assert.deepEqual(await decryptShare(await encryptShare(p, key), key), p);
  assert.ok(SHARE_ID_RE instanceof RegExp);
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm --filter @damwha/share-format test`
Expected: FAIL — `src/index.ts`가 없어 `tsc`가 실패한다.

- [ ] **Step 4: 구현**

`src/errors.ts`:

```ts
export type ShareFormatErrorCode = 'bad_key' | 'bad_envelope' | 'unsupported_version' | 'bad_payload';

/** 복호화 실패의 종류. 뷰어는 code로 안내 문구를 고르고, 메시지는 개발자용이다. */
export class ShareFormatError extends Error {
  readonly code: ShareFormatErrorCode;
  constructor(code: ShareFormatErrorCode, message: string) {
    super(message);
    this.name = 'ShareFormatError';
    this.code = code;
  }
}
```

`src/base64url.ts`:

```ts
import { ShareFormatError } from './errors';

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new ShareFormatError('bad_key', 'not base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
```

`src/constants.ts`:

```ts
import type { ShareDurationDays } from '@damwha/contracts';

/** 봉투(압축·암호화 뒤) 상한. be는 업로드 전에, 공유 서버는 본문을 읽으면서 강제한다. */
export const SHARE_MAX_ENVELOPE_BYTES = 5 * 1024 * 1024;

/**
 * `<기간>-<22자 base64url>`. 22자는 16바이트(128비트) 난수다. 공유 서버는 이 정규식을 통과한 id만 파일 이름으로
 * 쓴다 — 경로 탈출 문자가 들어갈 자리가 없다. 기간을 앞에 두면 로그·디렉터리에서 한눈에 보인다.
 */
export const SHARE_ID_RE = /^(1|7|30)-[A-Za-z0-9_-]{22}$/;

export function shareIdDays(id: string): ShareDurationDays {
  return Number(id.slice(0, id.indexOf('-'))) as ShareDurationDays;
}
```

`src/payload.ts`:

```ts
import type { UiLanguage } from '@damwha/contracts';

/** 사용자가 고른 공유 범위 (spec §2.1). anonymize는 구조화된 화자 이름에만 적용된다. */
export type ShareScope = {
  summary: boolean;
  lenses: boolean;
  transcript: boolean;
  note: boolean;
  anonymize: boolean;
};

export type ShareSpeaker = { ref: string; name: string | null };
export type ShareSummarySegment = { title: string; bullets: string[]; start_ms: number; end_ms: number };
export type ShareLens = {
  kind: 'action' | 'decision' | 'promise';
  text: string;
  done: boolean;
  due_at: string | null;
  assignee_ref: string | null;
  start_ms: number | null;
  /** primary 근거가 현재 버전 발화일 때만 true — 그때만 뷰어가 발화 목록으로 스크롤한다 (spec §2.1). */
  linkable: boolean;
};
export type ShareUtterance = { speaker_ref: string | null; start_ms: number; end_ms: number; text: string };

/**
 * 만료 시각은 페이로드에 없다 — 권위는 공유 서버다(spec selfhost §2.4). 암호화는 업로드 전에 끝나므로 여기 넣으면
 * 서버가 정한 실제 값과 어긋난다. 뷰어는 GET 응답의 `X-Share-Expires-At`으로 받는다.
 */
export type SharePayloadV1 = {
  v: 1;
  created_at: string;
  ui_language: UiLanguage;
  meeting: { title: string | null; recorded_at: string; duration_ms: number | null };
  speakers: ShareSpeaker[];
  summary?: { topics: string[]; segments: ShareSummarySegment[] };
  lenses?: ShareLens[];
  transcript?: ShareUtterance[];
  note?: { body_md: string };
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * 복호화한 값이 v1인지. GCM이 "키를 가진 쪽이 만들었다"는 건 보장하므로 여기서는 버전과 섹션의 큰 모양만 본다 —
 * 렌더러가 배열 대신 객체를 받아 깨지는 일을 막는 정도면 된다.
 */
export function isSharePayloadV1(x: unknown): x is SharePayloadV1 {
  if (!isObj(x)) return false;
  return (
    x.v === 1 &&
    typeof x.created_at === 'string' &&
    (x.ui_language === 'ko' || x.ui_language === 'en') &&
    isObj(x.meeting) &&
    Array.isArray(x.speakers) &&
    (x.summary === undefined || (isObj(x.summary) && Array.isArray(x.summary.topics) && Array.isArray(x.summary.segments))) &&
    (x.lenses === undefined || Array.isArray(x.lenses)) &&
    (x.transcript === undefined || Array.isArray(x.transcript)) &&
    (x.note === undefined || (isObj(x.note) && typeof x.note.body_md === 'string'))
  );
}
```

`src/envelope.ts`:

```ts
import { fromBase64Url, toBase64Url } from './base64url';
import { ShareFormatError } from './errors';
import { isSharePayloadV1, type SharePayloadV1 } from './payload';

export const SHARE_FORMAT_VERSION = 1;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;

/** 공유마다 새 키. 서버·레포·env에 두지 않는다 — 링크의 `#` 뒤와 로컬 DB에만 있다. */
export function generateShareKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64Url(keyB64);
  } catch {
    throw new ShareFormatError('bad_key', 'key is not base64url');
  }
  if (raw.length !== KEY_BYTES) throw new ShareFormatError('bad_key', `key must be ${KEY_BYTES} bytes`);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function through(bytes: Uint8Array<ArrayBuffer>, t: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(t);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 봉투 = [버전 1바이트][IV 12바이트][암호문+태그]. 평문은 gzip(JSON). */
export async function encryptShare(payload: SharePayloadV1, keyB64: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await importKey(keyB64);
  const plain = await through(new TextEncoder().encode(JSON.stringify(payload)), new CompressionStream('gzip'));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(1 + IV_BYTES + sealed.length);
  out[0] = SHARE_FORMAT_VERSION;
  out.set(iv, 1);
  out.set(sealed, 1 + IV_BYTES);
  return out;
}

export async function decryptShare(envelope: Uint8Array<ArrayBuffer>, keyB64: string): Promise<SharePayloadV1> {
  if (envelope.length < 1 + IV_BYTES + TAG_BYTES) throw new ShareFormatError('bad_envelope', 'envelope too short');
  if (envelope[0] !== SHARE_FORMAT_VERSION) {
    throw new ShareFormatError('unsupported_version', `envelope version ${envelope[0]}`);
  }
  const key = await importKey(keyB64);
  let plain: Uint8Array<ArrayBuffer>;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: envelope.slice(1, 1 + IV_BYTES) },
        key,
        envelope.slice(1 + IV_BYTES),
      ),
    );
  } catch {
    throw new ShareFormatError('bad_key', 'decryption failed — wrong key or tampered envelope');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await through(plain, new DecompressionStream('gzip'))));
  } catch {
    throw new ShareFormatError('bad_payload', 'payload is not gzip JSON');
  }
  if (!isSharePayloadV1(parsed)) throw new ShareFormatError('bad_payload', 'payload is not v1');
  return parsed;
}
```

`src/index.ts`:

```ts
/**
 * 공유 봉투와 페이로드의 단일 원본 (spec 2026-10-09 §2.2·§2.3). be가 암호화하고 공유 뷰어가 복호화한다 —
 * 두 쪽이 손으로 같은 포맷을 맞추면 @damwha/contracts가 생긴 이유(양쪽 사본이 어긋남)를 되풀이한다.
 * Node 22·브라우저·workerd 모두에서 돌도록 전역 WebCrypto·CompressionStream만 쓴다.
 */
export * from './errors';
export * from './base64url';
export * from './constants';
export * from './payload';
export * from './envelope';
```

- [ ] **Step 5: 통과 확인**

Run: `pnpm --filter @damwha/share-format test`
Expected: PASS — cjs 12개, mjs 1개.

- [ ] **Step 6: 커밋**

```bash
git add packages/share-format pnpm-lock.yaml
git commit -m "feat(share-format): 공유 페이로드와 AES-GCM 봉투"
```

---
## 2단계 — 공유 서버 (`share/`)

공유 서버는 개인 서버의 Docker 컨테이너에서 도는 Node 22 프로세스 하나다(spec selfhost §2.4). 핵심은
`createApp(deps).fetch(req: Request, info: { ip }) → Response`인 순수 핸들러이고, `main.ts`만 `@hono/node-server`로 Node HTTP에
붙인다. 테스트는 네트워크 없이 핸들러를 직접 부른다.

### Task 3: 공유 서버 — 디스크 저장소와 업로드·조회·삭제·교체

**Files:**
- Modify: `pnpm-workspace.yaml` (`share` 추가), `package.json` (루트 scripts)
- Create: `share/package.json`, `share/tsconfig.json`, `share/tsconfig.build.json`, `share/vitest.config.ts`, `share/.gitignore`, `share/.env.example`
- Create: `share/src/config.ts`, `share/src/store.ts`, `share/src/http.ts`, `share/src/body.ts`, `share/src/app.ts`, `share/src/main.ts`
- Create: `share/test/app.test.ts`, `share/test/store.test.ts`

**Interfaces:**
- Consumes: `SHARE_ID_RE`, `SHARE_MAX_ENVELOPE_BYTES`, `toBase64Url` (Task 2), `isShareDurationDays` (Task 1)
- Produces (HTTP — be의 `ShareClient`가 의존한다):
  - `POST /api/shares` — 헤더 `X-Share-Days: 1|7|30`, 본문 = 봉투. 선택 헤더 `X-Replace-Id`·`X-Replace-Token`(교체). `201 { id, delete_token, expires_at, replaced: boolean }`. 오류 `400 {code:'BAD_DURATION'|'EMPTY'|'BAD_REPLACE'}`, `403 {code:'BAD_TOKEN'}`(교체 토큰 틀림 — 아무것도 만들지 않음), `413 {code:'TOO_LARGE'}`.
  - `GET /api/shares/:id` — `200` 봉투 + 헤더 `X-Share-Expires-At` | `410 {code:'GONE'}`(없음·만료) | `404 {code:'NOT_FOUND'}`(id 형식 틀림)
  - `DELETE /api/shares/:id` — `Authorization: Bearer <delete_token>`. `204` | `403 {code:'BAD_TOKEN'}` | `404 {code:'NOT_FOUND'}`
  - `GET /healthz` — `200 {ok:true}`
  - 모든 응답에 보안 헤더
  - `createApp(deps: AppDeps): { fetch(req: Request, info: { ip: string }): Promise<Response> }`, `readConfig(env): ShareConfig`, `class DiskStore { init(); put(id, body, meta); head(id); get(id); delete(id); sweep(now) }`

- [ ] **Step 1: 워크스페이스와 패키지 뼈대**

`pnpm-workspace.yaml`의 `packages:`에 `- share`를 더한다(`site` 다음). 이게 없으면 `pnpm --filter damwha-share`가 아무것도 고르지 못한다.

`share/package.json`:

```json
{
  "name": "damwha-share",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Share link server — one Node process serving the encrypted-share API and the static viewer. Runs in Docker on a personal server behind a Cloudflare Tunnel.",
  "scripts": {
    "start": "tsx src/main.ts",
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@damwha/contracts": "workspace:*",
    "@damwha/share-format": "workspace:*"
  }
}
```

Run: `pnpm install && pnpm --filter damwha-share add @hono/node-server && pnpm --filter damwha-share add -D typescript tsx vitest @types/node@^22`

Expected: `pnpm --filter damwha-share exec node -e "1"`이 오류 없이 끝난다(필터가 패키지를 고른다).

`share/tsconfig.json` — 서버는 Node가 ESM으로 직접 실행하므로 `NodeNext`이고, 상대 import에 `.js`를 붙인다:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023", "DOM"],
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

`share/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "outDir": "dist/server", "rootDir": "src" },
  "include": ["src"]
}
```

`share/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { environment: 'node', include: ['test/**/*.test.ts'] } });
```

`share/.gitignore`:

```
.data/
dist/
.env
```

`share/.env.example`:

```
# 로컬 실행(pnpm share:dev)용. 운영 컨테이너는 deploy/share/docker-compose.yml의 environment를 쓴다.
# 링크를 이 초 뒤 만료시켜 만료 흐름을 바로 확인한다. NODE_ENV=production이거나 Host가 localhost가 아니면 무시된다.
DEV_EXPIRY_SECONDS=60
```

루트 `package.json` scripts에(`site:*` 옆):

```json
"share": "pnpm --filter damwha-share run",
"share:dev": "pnpm --filter damwha-share run start",
"share:test": "pnpm --filter damwha-share run test",
```

- [ ] **Step 2: 실패하는 테스트**

`share/test/store.test.ts`:

```ts
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DiskStore } from '../src/store.js';

let dir: string;
let store: DiskStore;
const ID = '7-AAAAAAAAAAAAAAAAAAAAAA';
const meta = (expires_at: string) => ({ expires_at, token_hash: 'h', size: 3, created_at: '2026-10-09T00:00:00.000Z' });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dw-share-store-'));
  store = new DiskStore(dir);
  await store.init();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('put → get → delete', async () => {
  await store.put(ID, new Uint8Array([1, 2, 3]), meta('2026-10-16T00:00:00.000Z'));
  expect(await store.get(ID)).toEqual({ body: new Uint8Array([1, 2, 3]), meta: meta('2026-10-16T00:00:00.000Z') });
  expect(await store.delete(ID)).toBe(true);
  expect(await store.get(ID)).toBeNull();
  expect(await store.delete(ID)).toBe(false);
});

it('메타가 없으면 봉투가 있어도 없는 것이다 (쓰다 만 상태)', async () => {
  writeFileSync(join(dir, 'shares', `${ID}.bin`), new Uint8Array([9]));
  expect(await store.get(ID)).toBeNull();
});

it('경로를 벗어나는 id는 받지 않는다', async () => {
  await expect(store.put('../x', new Uint8Array([1]), meta('2026-10-16T00:00:00.000Z'))).rejects.toThrow(/invalid share id/);
  await expect(store.head('7-../../etc')).rejects.toThrow(/invalid share id/);
});

it('sweep — 만료된 쌍을 지우고 아직 유효한 것은 남긴다', async () => {
  const live = '7-BBBBBBBBBBBBBBBBBBBBBB';
  await store.put(ID, new Uint8Array([1]), meta('2026-10-09T00:00:00.000Z'));
  await store.put(live, new Uint8Array([1]), meta('2026-10-20T00:00:00.000Z'));
  expect(await store.sweep(new Date('2026-10-10T00:00:00.000Z'))).toBe(1);
  expect(existsSync(join(dir, 'shares', `${ID}.bin`))).toBe(false);
  expect(await store.head(live)).not.toBeNull();
});

it('sweep — 메타 없는 봉투·임시 파일은 1시간이 지나야 지운다', async () => {
  const orphan = join(dir, 'shares', `${ID}.bin`);
  const tmp = join(dir, 'shares', `7-CCCCCCCCCCCCCCCCCCCCCC.json.tmp`);
  writeFileSync(orphan, new Uint8Array([1]));
  writeFileSync(tmp, '{}');
  const now = new Date();
  expect(await store.sweep(now)).toBe(0);
  const old = new Date(now.getTime() - 2 * 3_600_000);
  utimesSync(orphan, old, old);
  utimesSync(tmp, old, old);
  expect(await store.sweep(now)).toBe(2);
  expect(existsSync(orphan)).toBe(false);
  expect(existsSync(tmp)).toBe(false);
});
```

`share/test/app.test.ts`:

```ts
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHARE_ID_RE, SHARE_MAX_ENVELOPE_BYTES } from '@damwha/share-format';
import { createApp } from '../src/app.js';
import { readConfig, type ShareConfig } from '../src/config.js';
import { DiskStore } from '../src/store.js';

const ORIGIN = 'https://damwha-share.example';
const IP = { ip: '203.0.113.9' };
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
let dir: string;
let store: DiskStore;
let clock: Date;
let logs: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dw-share-app-'));
  store = new DiskStore(dir);
  await store.init();
  clock = new Date('2026-10-09T03:00:00.000Z');
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeApp(over: Partial<ShareConfig> = {}) {
  const config = { ...readConfig({}), dataDir: dir, ...over };
  return createApp({ store, config, now: () => clock, viewerDir: null, log: (l) => logs.push(l) });
}
type App = ReturnType<typeof makeApp>;
const post = (app: App, body = bytes(64), headers: Record<string, string> = {}) =>
  app.fetch(new Request(`${ORIGIN}/api/shares`, { method: 'POST', headers: { 'X-Share-Days': '7', ...headers }, body }), IP);
const get = (app: App, id: string) => app.fetch(new Request(`${ORIGIN}/api/shares/${id}`), IP);
const del = (app: App, id: string, token?: string) =>
  app.fetch(new Request(`${ORIGIN}/api/shares/${id}`, { method: 'DELETE', headers: token === undefined ? {} : { Authorization: `Bearer ${token}` } }), IP);
type Created = { id: string; delete_token: string; expires_at: string; replaced: boolean };

describe('업로드', () => {
  it('저장하고 id·삭제 토큰·만료 시각을 돌려준다', async () => {
    const app = makeApp();
    const res = await post(app);
    expect(res.status).toBe(201);
    const b = (await res.json()) as Created;
    expect(b.id).toMatch(SHARE_ID_RE);
    expect(b.id.startsWith('7-')).toBe(true);
    expect(b.delete_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.expires_at).toBe('2026-10-16T03:00:00.000Z');
    expect(b.replaced).toBe(false);
  });

  it('디스크에 토큰 원문이 남지 않는다', async () => {
    const b = (await (await post(makeApp())).json()) as Created;
    const raw = readFileSync(join(dir, 'shares', `${b.id}.json`), 'utf8');
    expect(raw).not.toContain(b.delete_token);
  });

  it('기간이 목록 밖이면 400', async () => {
    for (const d of ['0', '2', '31', '', 'abc']) {
      const res = await post(makeApp(), bytes(8), { 'X-Share-Days': d });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: 'BAD_DURATION' });
    }
  });

  it('빈 본문은 400', async () => {
    expect((await post(makeApp(), new Uint8Array(0))).status).toBe(400);
  });

  it('상한을 넘는 본문은 413이고 아무것도 쓰지 않는다', async () => {
    const res = await post(makeApp(), bytes(SHARE_MAX_ENVELOPE_BYTES + 1));
    expect(res.status).toBe(413);
    expect(readdirSync(join(dir, 'shares'))).toEqual([]);
  });
});

describe('조회', () => {
  it('올린 바이트와 만료 시각 헤더', async () => {
    const app = makeApp();
    const b = (await (await post(app, bytes(32, 9))).json()) as Created;
    const res = await get(app, b.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-share-expires-at')).toBe(b.expires_at);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes(32, 9));
  });

  it('형식이 맞지만 없는 id는 410, 형식이 틀리면 404', async () => {
    const app = makeApp();
    expect((await get(app, '7-AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(410);
    expect((await get(app, '..%2Fshares%2Fx')).status).toBe(404);
    expect((await get(app, '7-short')).status).toBe(404);
  });

  it('만료 시각이 지나면 410 — 스위퍼를 기다리지 않는다', async () => {
    const app = makeApp();
    const b = (await (await post(app)).json()) as Created;
    clock = new Date(Date.parse(b.expires_at));
    expect((await get(app, b.id)).status).toBe(410);
  });
});

describe('삭제', () => {
  it('맞는 토큰이면 204, 이후 조회 410, 다시 지우면 404', async () => {
    const app = makeApp();
    const b = (await (await post(app)).json()) as Created;
    expect((await del(app, b.id, b.delete_token)).status).toBe(204);
    expect((await get(app, b.id)).status).toBe(410);
    expect((await del(app, b.id, b.delete_token)).status).toBe(404);
  });

  it('틀린 토큰·토큰 없음은 403이고 지우지 않는다', async () => {
    const app = makeApp();
    const b = (await (await post(app)).json()) as Created;
    expect((await del(app, b.id, 'wrong')).status).toBe(403);
    expect((await del(app, b.id)).status).toBe(403);
    expect((await get(app, b.id)).status).toBe(200);
  });
});

describe('교체 (spec selfhost §2.4)', () => {
  it('맞는 토큰이면 새 공유가 생기고, 응답 시점에 기존 공유는 이미 410이다', async () => {
    const app = makeApp();
    const old = (await (await post(app)).json()) as Created;
    const res = await post(app, bytes(16), { 'X-Replace-Id': old.id, 'X-Replace-Token': old.delete_token });
    expect(res.status).toBe(201);
    const fresh = (await res.json()) as Created;
    expect(fresh.replaced).toBe(true);
    expect(fresh.id).not.toBe(old.id);
    expect((await get(app, old.id)).status).toBe(410);
    expect((await get(app, fresh.id)).status).toBe(200);
  });

  it('토큰이 틀리면 403이고 새 공유를 만들지 않으며 기존 공유는 그대로다', async () => {
    const app = makeApp();
    const old = (await (await post(app)).json()) as Created;
    const res = await post(app, bytes(16), { 'X-Replace-Id': old.id, 'X-Replace-Token': 'wrong' });
    expect(res.status).toBe(403);
    expect(readdirSync(join(dir, 'shares')).filter((f) => f.endsWith('.json'))).toEqual([`${old.id}.json`]);
    expect((await get(app, old.id)).status).toBe(200);
  });

  it('기존 공유가 이미 없으면 그냥 새로 만들고 replaced=false', async () => {
    const res = await post(makeApp(), bytes(16), { 'X-Replace-Id': '7-AAAAAAAAAAAAAAAAAAAAAA', 'X-Replace-Token': 't' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Created).replaced).toBe(false);
  });

  it('교체 헤더 형식이 틀리면 400', async () => {
    expect((await post(makeApp(), bytes(16), { 'X-Replace-Id': '../x', 'X-Replace-Token': 't' })).status).toBe(400);
    expect((await post(makeApp(), bytes(16), { 'X-Replace-Id': '7-AAAAAAAAAAAAAAAAAAAAAA' })).status).toBe(400);
  });
});

describe('공통', () => {
  it('보안 헤더 — 성공·실패 모두', async () => {
    const app = makeApp();
    for (const res of [await post(app), await get(app, '7-short'), await app.fetch(new Request(`${ORIGIN}/nope`), IP)]) {
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('지원하지 않는 메서드는 405, /healthz는 200', async () => {
    const app = makeApp();
    expect((await app.fetch(new Request(`${ORIGIN}/api/shares`), IP)).status).toBe(405);
    expect((await app.fetch(new Request(`${ORIGIN}/healthz`), IP)).status).toBe(200);
  });

  it('로그에 토큰이 없다', async () => {
    const app = makeApp();
    const b = (await (await post(app)).json()) as Created;
    await del(app, b.id, b.delete_token);
    await post(app, bytes(8), { 'X-Replace-Id': b.id, 'X-Replace-Token': 'REPLACE-SECRET' });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(b.delete_token);
    expect(logs.join('\n')).not.toContain('REPLACE-SECRET');
  });

  it('저장소 오류는 500 INTERNAL이고 원인 메시지를 응답에 싣지 않는다', async () => {
    const app = makeApp();
    store.put = async () => { throw new Error('EACCES /data/secret/path'); };
    const res = await post(app);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('/data/secret');
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm share:test`
Expected: FAIL — `../src/store.js` 없음.

- [ ] **Step 4: 구현**

`share/src/config.ts`:

```ts
export interface ShareConfig {
  port: number;
  host: string;
  dataDir: string;
  /** Docker 이미지는 NODE_ENV=production. 그때는 개발용 설정(DEV_EXPIRY_SECONDS)을 읽지 않는다. */
  production: boolean;
  uploadsEnabled: boolean;
  dailyMaxUploads: number;
  dailyMaxBytes: number;
  devExpirySeconds: number | null;
  /** IP당 분당 요청 수 — 업로드·조회·삭제를 따로 센다 (Task 4). */
  limits: { upload: number; read: number; delete: number };
}

const positive = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

export function readConfig(env: Record<string, string | undefined>): ShareConfig {
  const production = env.NODE_ENV === 'production';
  const dev = Number(env.DEV_EXPIRY_SECONDS);
  return {
    port: positive(env.PORT, 8787),
    host: env.HOST ?? '127.0.0.1',
    dataDir: env.DATA_DIR ?? './.data',
    production,
    uploadsEnabled: env.UPLOADS_ENABLED !== 'false',
    dailyMaxUploads: positive(env.DAILY_MAX_UPLOADS, 500),
    dailyMaxBytes: positive(env.DAILY_MAX_BYTES, 524_288_000),
    devExpirySeconds: !production && env.DEV_EXPIRY_SECONDS && Number.isFinite(dev) && dev > 0 ? dev : null,
    limits: {
      upload: positive(env.UPLOAD_LIMIT_PER_MIN, 10),
      read: positive(env.READ_LIMIT_PER_MIN, 120),
      delete: positive(env.DELETE_LIMIT_PER_MIN, 30),
    },
  };
}
```

`share/src/store.ts`:

```ts
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SHARE_ID_RE } from '@damwha/share-format';

export interface ShareMeta {
  expires_at: string;
  /** 삭제 토큰의 SHA-256(hex). 원문은 저장하지 않는다. */
  token_hash: string;
  size: number;
  created_at: string;
}

const ORPHAN_AGE_MS = 3_600_000;
const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * 공유본 하나 = `shares/<id>.bin`(봉투) + `shares/<id>.json`(메타). **메타가 있어야 존재한다** — 봉투를 먼저 쓰고
 * 메타를 나중에 쓰며(둘 다 임시 파일 → rename), 지울 때는 메타를 먼저 지운다. 그래서 쓰다 죽거나 지우다 죽어도
 * 읽기 경로에 반쯤 된 공유가 보이지 않는다. 파일 이름은 SHARE_ID_RE를 통과한 id만 쓴다(경로 탈출 차단).
 */
export class DiskStore {
  private readonly dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'shares');
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private path(id: string, ext: 'bin' | 'json'): string {
    if (!SHARE_ID_RE.test(id)) throw new Error('invalid share id');
    return join(this.dir, `${id}.${ext}`);
  }

  async put(id: string, body: Uint8Array, meta: ShareMeta): Promise<void> {
    const bin = this.path(id, 'bin');
    const json = this.path(id, 'json');
    await writeFile(`${bin}.tmp`, body);
    await rename(`${bin}.tmp`, bin);
    await writeFile(`${json}.tmp`, JSON.stringify(meta));
    await rename(`${json}.tmp`, json);
  }

  async head(id: string): Promise<ShareMeta | null> {
    try {
      return JSON.parse(await readFile(this.path(id, 'json'), 'utf8')) as ShareMeta;
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  async get(id: string): Promise<{ body: Uint8Array; meta: ShareMeta } | null> {
    const meta = await this.head(id);
    if (!meta) return null;
    try {
      return { body: new Uint8Array(await readFile(this.path(id, 'bin'))), meta };
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  async delete(id: string): Promise<boolean> {
    const existed = (await this.head(id)) !== null;
    await rm(this.path(id, 'json'), { force: true });
    await rm(this.path(id, 'bin'), { force: true });
    return existed;
  }

  /** 만료된 공유를 지우고, 메타 없는 봉투·임시 파일은 1시간이 지난 것만 지운다(쓰는 중일 수 있다). */
  async sweep(now: Date): Promise<number> {
    let removed = 0;
    for (const name of await readdir(this.dir)) {
      const full = join(this.dir, name);
      if (name.endsWith('.json')) {
        const id = name.slice(0, -'.json'.length);
        if (!SHARE_ID_RE.test(id)) continue;
        const meta = await this.head(id);
        if (meta && Date.parse(meta.expires_at) <= now.getTime()) {
          await this.delete(id);
          removed++;
        }
        continue;
      }
      const isTmp = name.endsWith('.tmp');
      const binId = name.endsWith('.bin') ? name.slice(0, -'.bin'.length) : null;
      const orphan = isTmp || (binId !== null && SHARE_ID_RE.test(binId) && (await this.head(binId)) === null);
      if (!orphan) continue;
      const age = now.getTime() - (await stat(full)).mtimeMs;
      if (age > ORPHAN_AGE_MS) {
        await rm(full, { force: true });
        removed++;
      }
    }
    return removed;
  }
}
```

`share/src/http.ts`:

```ts
/**
 * 뷰어 HTML은 같은 origin의 스크립트·스타일·API만 쓴다. 키가 페이지 URL(#)에 있으므로 바깥으로 나가는 경로
 * (외부 스크립트, referrer, 프레이밍)를 모두 닫는다 (spec §2.4·§2.5).
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  out.headers.set('Referrer-Policy', 'no-referrer');
  out.headers.set('Cache-Control', 'no-store');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Content-Security-Policy', CSP);
  return out;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
```

`share/src/body.ts`:

```ts
/** 본문을 읽으면서 상한을 강제한다 — Content-Length를 속이거나 생략해도 상한 너머는 메모리에 담지 않는다. */
export async function readLimited(req: Request, max: number): Promise<Uint8Array | 'too_large'> {
  const declared = Number(req.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) return 'too_large';
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return 'too_large';
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
```

`share/src/app.ts`:

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isShareDurationDays } from '@damwha/contracts';
import { SHARE_ID_RE, SHARE_MAX_ENVELOPE_BYTES, toBase64Url } from '@damwha/share-format';
import { readLimited } from './body.js';
import type { ShareConfig } from './config.js';
import { json, withSecurityHeaders } from './http.js';
import type { DiskStore } from './store.js';

export interface AppDeps {
  store: DiskStore;
  config: ShareConfig;
  now: () => Date;
  /** 뷰어 빌드 산출물(dist/viewer). Task 6 전까지 null. */
  viewerDir: string | null;
  /** 한 줄 로그. 메서드·경로·상태만 — 본문과 Authorization·교체 토큰은 넘기지 않는다. */
  log?: (line: string) => void;
}
export interface RequestInfo {
  ip: string;
}

const DAY_MS = 86_400_000;
const API = /^\/api\/shares(?:\/([^/]+))?\/?$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createApp(deps: AppDeps) {
  const { store } = deps;

  function ttlMs(_req: Request, days: number): number {
    return days * DAY_MS;
  }

  async function create(req: Request, now: Date): Promise<Response> {
    const days = Number(req.headers.get('X-Share-Days'));
    if (!isShareDurationDays(days)) return json(400, { code: 'BAD_DURATION' });

    // 교체: 기존 공유의 토큰이 맞는지 **먼저** 본다 — 틀리면 아무것도 만들지 않는다.
    const replaceId = req.headers.get('X-Replace-Id');
    let replacing = false;
    if (replaceId !== null) {
      const token = req.headers.get('X-Replace-Token') ?? '';
      if (!SHARE_ID_RE.test(replaceId) || token === '') return json(400, { code: 'BAD_REPLACE' });
      const old = await store.head(replaceId);
      if (old) {
        if (!sameHash(sha256(token), old.token_hash)) return json(403, { code: 'BAD_TOKEN' });
        replacing = true;
      }
    }

    const body = await readLimited(req, SHARE_MAX_ENVELOPE_BYTES);
    if (body === 'too_large') return json(413, { code: 'TOO_LARGE' });
    if (body.byteLength === 0) return json(400, { code: 'EMPTY' });

    const id = `${days}-${toBase64Url(randomBytes(16))}`;
    const deleteToken = toBase64Url(randomBytes(32));
    const expiresAt = new Date(now.getTime() + ttlMs(req, days)).toISOString();
    await store.put(id, body, { expires_at: expiresAt, token_hash: sha256(deleteToken), size: body.byteLength, created_at: now.toISOString() });
    if (replacing) {
      try {
        await store.delete(replaceId!);
      } catch (e) {
        // 기존 공유를 못 지웠으면 새 공유도 남기지 않는다 — "새 링크는 생겼는데 옛 링크가 열린다"를 만들지 않는다.
        await store.delete(id).catch(() => undefined);
        throw e;
      }
    }
    return json(201, { id, delete_token: deleteToken, expires_at: expiresAt, replaced: replacing });
  }

  async function read(id: string, now: Date): Promise<Response> {
    if (!SHARE_ID_RE.test(id)) return json(404, { code: 'NOT_FOUND' });
    const found = await store.get(id);
    if (!found || Date.parse(found.meta.expires_at) <= now.getTime()) return json(410, { code: 'GONE' });
    return new Response(found.body, {
      headers: { 'Content-Type': 'application/octet-stream', 'X-Share-Expires-At': found.meta.expires_at },
    });
  }

  async function remove(req: Request, id: string): Promise<Response> {
    if (!SHARE_ID_RE.test(id)) return json(404, { code: 'NOT_FOUND' });
    const meta = await store.head(id);
    if (!meta) return json(404, { code: 'NOT_FOUND' });
    const auth = req.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    if (!token || !sameHash(sha256(token), meta.token_hash)) return json(403, { code: 'BAD_TOKEN' });
    await store.delete(id);
    return new Response(null, { status: 204 });
  }

  async function route(req: Request, _info: RequestInfo, now: Date): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/healthz' && req.method === 'GET') return json(200, { ok: true });
    const m = url.pathname.match(API);
    if (m) {
      const id = m[1];
      if (id === undefined && req.method === 'POST') return create(req, now);
      if (id !== undefined && req.method === 'GET') return read(id, now);
      if (id !== undefined && req.method === 'DELETE') return remove(req, id);
      return json(405, { code: 'METHOD_NOT_ALLOWED' });
    }
    return json(404, { code: 'NOT_FOUND' });
  }

  return {
    async fetch(req: Request, info: RequestInfo): Promise<Response> {
      const now = deps.now();
      const path = new URL(req.url).pathname;
      let res: Response;
      try {
        res = await route(req, info, now);
      } catch (e) {
        deps.log?.(`error ${req.method} ${path}: ${(e as Error).name}`);
        res = json(500, { code: 'INTERNAL' });
      }
      deps.log?.(`${req.method} ${path} ${res.status}`);
      return withSecurityHeaders(res);
    },
  };
}
```

`share/src/main.ts`:

```ts
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve, type HttpBindings } from '@hono/node-server';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { DiskStore } from './store.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = readConfig(process.env);
const store = new DiskStore(config.dataDir);
await store.init();

// tsx(src/main.ts)로 돌면 share/dist/viewer, Docker는 VIEWER_DIR로 넘긴다.
const viewerDir = process.env.VIEWER_DIR ?? fileURLToPath(new URL('../dist/viewer', import.meta.url));
const app = createApp({
  store,
  config,
  now: () => new Date(),
  viewerDir: existsSync(viewerDir) ? viewerDir : null,
  log: (line) => console.log(line),
});

const sweep = () =>
  store
    .sweep(new Date())
    .then((n) => { if (n > 0) console.log(`sweep removed ${n}`); })
    .catch((e: Error) => console.error(`sweep failed: ${e.name}`));
await sweep();
setInterval(sweep, 10 * 60_000).unref();

/**
 * 클라이언트 IP는 Tunnel이 붙이는 CF-Connecting-IP. 이 헤더를 믿을 수 있는 건 포트가 Tunnel에만 열려 있어서다
 * (spec selfhost §2.4) — 포트를 바깥에 열면 누구나 위조할 수 있다. 로컬 실행은 소켓 주소로 센다.
 */
serve({
  port: config.port,
  hostname: config.host,
  fetch: (req: Request, env: HttpBindings) =>
    app.fetch(req, { ip: req.headers.get('CF-Connecting-IP') ?? env.incoming.socket.remoteAddress ?? 'unknown' }),
});
console.log(`damwha-share listening on ${config.host}:${config.port} (data ${config.dataDir})`);
```

- [ ] **Step 5: 통과 확인**

Run: `pnpm share:test && pnpm share typecheck`
Expected: PASS, 타입 오류 없음.

- [ ] **Step 6: 실제로 띄워 보기**

Run: `pnpm share:dev` (다른 터미널에서)

```bash
curl -s http://127.0.0.1:8787/healthz
curl -s -X POST -H 'X-Share-Days: 1' --data-binary 'hello' http://127.0.0.1:8787/api/shares
```

Expected: `{"ok":true}`, `{"id":"1-…","delete_token":"…","expires_at":"…","replaced":false}`, `share/.data/shares/`에 파일 두 개. 확인 뒤 `share/.data`를 지운다.

- [ ] **Step 7: 커밋**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml share
git commit -m "feat(share): 공유 서버 — 디스크 저장, 업로드·조회·삭제·원자적 교체, 보안 헤더"
```

### Task 4: 공유 서버 남용 방지와 개발용 만료 단축

**Files:**
- Create: `share/src/limits.ts`
- Modify: `share/src/app.ts`
- Create: `share/test/limits.test.ts`

**Interfaces:**
- Consumes: `createApp`, `ShareConfig` (Task 3)
- Produces: 업로드 거절 `503 {code:'UPLOADS_DISABLED'|'DAILY_CAP'}`, `429 {code:'RATE_LIMITED'}`. be의 `ShareClient`는 503·429를 "잠시 후 다시"로 보여 준다(Task 10). `class WindowLimiter`, `class DailyBudget`.

- [ ] **Step 1: 실패하는 테스트**

`share/test/limits.test.ts` (Task 3의 `app.test.ts`와 같은 준비 코드 — 파일마다 자기 임시 디렉터리를 쓴다):

```ts
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig, type ShareConfig } from '../src/config.js';
import { DailyBudget, WindowLimiter } from '../src/limits.js';
import { DiskStore } from '../src/store.js';

let dir: string;
let store: DiskStore;
let clock: Date;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dw-share-limits-'));
  store = new DiskStore(dir);
  await store.init();
  clock = new Date('2026-10-09T03:00:00.000Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const makeApp = (over: Partial<ShareConfig> = {}) =>
  createApp({ store, config: { ...readConfig({}), dataDir: dir, ...over }, now: () => clock, viewerDir: null });
type App = ReturnType<typeof makeApp>;
const post = (app: App, origin = 'https://damwha-share.example', ip = '203.0.113.9', size = 100) =>
  app.fetch(new Request(`${origin}/api/shares`, { method: 'POST', headers: { 'X-Share-Days': '7' }, body: new Uint8Array(size).fill(1) }), { ip });

describe('업로드 차단 스위치', () => {
  it('uploadsEnabled=false면 업로드만 503, 조회·삭제는 그대로', async () => {
    const on = makeApp();
    const b = (await (await post(on)).json()) as { id: string; delete_token: string };
    const off = makeApp({ uploadsEnabled: false });
    const res = await post(off);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UPLOADS_DISABLED' });
    expect((await off.fetch(new Request(`https://x/api/shares/${b.id}`), { ip: 'a' })).status).toBe(200);
    expect((await off.fetch(new Request(`https://x/api/shares/${b.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${b.delete_token}` } }), { ip: 'a' })).status).toBe(204);
  });

  it('readConfig — UPLOADS_ENABLED=false일 때만 꺼진다', () => {
    expect(readConfig({}).uploadsEnabled).toBe(true);
    expect(readConfig({ UPLOADS_ENABLED: 'false' }).uploadsEnabled).toBe(false);
  });
});

describe('IP별 요청 제한', () => {
  it('업로드는 IP마다 따로 센다', async () => {
    const app = makeApp({ limits: { upload: 2, read: 100, delete: 100 } });
    expect((await post(app)).status).toBe(201);
    expect((await post(app)).status).toBe(201);
    expect((await post(app)).status).toBe(429);
    expect((await post(app, undefined, '198.51.100.1')).status).toBe(201);
  });

  it('조회를 다 써도 삭제(지금 중지)는 막히지 않는다', async () => {
    const app = makeApp({ limits: { upload: 100, read: 1, delete: 100 } });
    const b = (await (await post(app)).json()) as { id: string; delete_token: string };
    const ip = { ip: '203.0.113.9' };
    await app.fetch(new Request(`https://x/api/shares/${b.id}`), ip);
    expect((await app.fetch(new Request(`https://x/api/shares/${b.id}`), ip)).status).toBe(429);
    const del = await app.fetch(new Request(`https://x/api/shares/${b.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${b.delete_token}` } }), ip);
    expect(del.status).toBe(204);
  });

  it('창이 지나면 다시 허용한다', () => {
    const l = new WindowLimiter(1, 60_000);
    expect(l.allow('k', 0)).toBe(true);
    expect(l.allow('k', 1000)).toBe(false);
    expect(l.allow('k', 60_000)).toBe(true);
  });
});

describe('서비스 전체 일일 상한', () => {
  it('객체 수 상한 — 동시에 몰려도 정확히 상한까지만', async () => {
    const app = makeApp({ dailyMaxUploads: 3, limits: { upload: 100, read: 100, delete: 100 } });
    const res = await Promise.all(Array.from({ length: 6 }, () => post(app)));
    expect(res.map((r) => r.status).sort()).toEqual([201, 201, 201, 503, 503, 503]);
    // 거절된 요청은 파일도 남기지 않는다 — 상한 검사가 저장보다 앞선다
    expect(readdirSync(join(dir, 'shares')).filter((f) => f.endsWith('.json'))).toHaveLength(3);
  });

  it('바이트 상한', async () => {
    const app = makeApp({ dailyMaxBytes: 150 });
    expect((await post(app)).status).toBe(201);
    const res = await post(app);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'DAILY_CAP' });
  });

  it('날짜가 바뀌면 새로 센다', async () => {
    const app = makeApp({ dailyMaxUploads: 1 });
    expect((await post(app)).status).toBe(201);
    expect((await post(app)).status).toBe(503);
    clock = new Date('2026-10-10T00:00:01.000Z');
    expect((await post(app)).status).toBe(201);
  });

  it('저장에 실패한 업로드는 상한을 쓰지 않는다', async () => {
    const app = makeApp({ dailyMaxUploads: 1 });
    const put = store.put.bind(store);
    store.put = async () => { throw new Error('disk'); };
    expect((await post(app)).status).toBe(500);
    store.put = put;
    expect((await post(app)).status).toBe(201);
  });

  it('DailyBudget — 확인과 차감이 한 번에', () => {
    const b = new DailyBudget(2, 1000);
    const now = new Date('2026-10-09T00:00:00Z');
    expect(b.reserve(10, now)).toBe(true);
    expect(b.reserve(10, now)).toBe(true);
    expect(b.reserve(10, now)).toBe(false);
    b.release(10);
    expect(b.reserve(10, now)).toBe(true);
  });
});

describe('개발용 만료 단축', () => {
  const expiresAfter = async (app: App, origin: string) => {
    const { expires_at } = (await (await post(app, origin)).json()) as { expires_at: string };
    return Date.parse(expires_at) - clock.getTime();
  };

  it('localhost·127.0.0.1에서는 devExpirySeconds를 따른다', async () => {
    const app = makeApp({ devExpirySeconds: 60 });
    expect(await expiresAfter(app, 'http://localhost:8787')).toBe(60_000);
    expect(await expiresAfter(app, 'http://127.0.0.1:8787')).toBe(60_000);
  });

  it('공개 도메인 Host에서는 무시한다', async () => {
    expect(await expiresAfter(makeApp({ devExpirySeconds: 60 }), 'https://damwha-share.0kimjae.dev')).toBe(7 * 86_400_000);
  });

  it('readConfig — production이면 DEV_EXPIRY_SECONDS를 읽지 않는다, 숫자가 아니거나 0 이하도 무시', () => {
    expect(readConfig({ DEV_EXPIRY_SECONDS: '60' }).devExpirySeconds).toBe(60);
    expect(readConfig({ DEV_EXPIRY_SECONDS: '60', NODE_ENV: 'production' }).devExpirySeconds).toBeNull();
    for (const v of ['', 'abc', '0', '-5']) expect(readConfig({ DEV_EXPIRY_SECONDS: v }).devExpirySeconds).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm share:test`
Expected: FAIL — `../src/limits.js` 없음.

- [ ] **Step 3: 구현**

`share/src/limits.ts`:

```ts
/** IP별 고정 창 제한. 프로세스 하나라 메모리 Map으로 충분하다. */
export class WindowLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();
  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}

  allow(key: string, now: number): boolean {
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      if (this.hits.size > 10_000) this.prune(now);
      return true;
    }
    h.count++;
    return h.count <= this.limit;
  }

  private prune(now: number) {
    for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k);
  }
}

/**
 * 서비스 전체 일일 업로드 상한 (spec selfhost §2.4). 확인과 차감이 await 없이 한 번에 일어나므로 동시 요청이
 * 몰려도 상한을 넘지 않는다 — 프로세스 하나가 전제다. 메모리 카운터라 재시작하면 0부터 다시 센다.
 */
export class DailyBudget {
  private day = '';
  private count = 0;
  private bytes = 0;
  constructor(private readonly maxUploads: number, private readonly maxBytes: number) {}

  reserve(size: number, now: Date): boolean {
    const d = now.toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.count = 0;
      this.bytes = 0;
    }
    if (this.count + 1 > this.maxUploads || this.bytes + size > this.maxBytes) return false;
    this.count++;
    this.bytes += size;
    return true;
  }

  release(size: number): void {
    this.count = Math.max(0, this.count - 1);
    this.bytes = Math.max(0, this.bytes - size);
  }
}
```

`share/src/app.ts`:

- import에 `import { DailyBudget, WindowLimiter } from './limits.js';`
- `createApp` 첫 줄(`const { store } = deps;`) 다음에:

```ts
  const { config } = deps;
  const limiters = {
    upload: new WindowLimiter(config.limits.upload),
    read: new WindowLimiter(config.limits.read),
    delete: new WindowLimiter(config.limits.delete),
  };
  const daily = new DailyBudget(config.dailyMaxUploads, config.dailyMaxBytes);
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
```

- `ttlMs`를:

```ts
  /** 개발용 만료 단축은 로컬 Host에서만 — Tunnel을 거친 요청의 Host는 공개 도메인이다. production은 readConfig가 이미 null로 둔다. */
  function ttlMs(req: Request, days: number): number {
    if (config.devExpirySeconds !== null && LOCAL_HOSTS.has(new URL(req.url).hostname)) return config.devExpirySeconds * 1000;
    return days * DAY_MS;
  }
```

- `create`의 맨 앞에 `if (!config.uploadsEnabled) return json(503, { code: 'UPLOADS_DISABLED' });`
- `create`의 `if (body.byteLength === 0) …` 다음에 `if (!daily.reserve(body.byteLength, now)) return json(503, { code: 'DAILY_CAP' });`
- `create`의 `await store.put(...)` 줄을 감싼다:

```ts
    try {
      await store.put(id, body, { expires_at: expiresAt, token_hash: sha256(deleteToken), size: body.byteLength, created_at: now.toISOString() });
    } catch (e) {
      daily.release(body.byteLength);
      throw e;
    }
```

- 교체 실패 분기(`await store.delete(id).catch(...)`) 다음 줄에 `daily.release(body.byteLength);`
- `route`의 API 분기를 IP 제한과 함께:

```ts
  async function route(req: Request, info: RequestInfo, now: Date): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/healthz' && req.method === 'GET') return json(200, { ok: true });
    const m = url.pathname.match(API);
    if (m) {
      const id = m[1];
      const t = now.getTime();
      if (id === undefined && req.method === 'POST') {
        return limiters.upload.allow(info.ip, t) ? create(req, now) : json(429, { code: 'RATE_LIMITED' });
      }
      if (id !== undefined && req.method === 'GET') {
        return limiters.read.allow(info.ip, t) ? read(id, now) : json(429, { code: 'RATE_LIMITED' });
      }
      if (id !== undefined && req.method === 'DELETE') {
        // 삭제는 조회와 따로 센다 — 조회가 몰려도 "지금 중지"가 막히지 않는다.
        return limiters.delete.allow(info.ip, t) ? remove(req, id) : json(429, { code: 'RATE_LIMITED' });
      }
      return json(405, { code: 'METHOD_NOT_ALLOWED' });
    }
    return json(404, { code: 'NOT_FOUND' });
  }
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm share:test && pnpm share typecheck`
Expected: PASS (Task 3 테스트 포함)

- [ ] **Step 5: 변이 확인**

`ttlMs`의 `LOCAL_HOSTS.has(...)` 조건을 지우고 실행 → "공개 도메인 Host에서는 무시한다"가 FAIL. 되돌린다. `route`의 DELETE 분기에서 `limiters.delete`를 `limiters.read`로 바꾸고 → "조회를 다 써도 삭제…"가 FAIL. 되돌린다. `create`에서 `daily.reserve` 호출을 `store.put` **뒤**로 옮기고 → "동시에 몰려도 정확히…"가 파일 개수 단언에서 FAIL. 되돌린다.

- [ ] **Step 6: 커밋**

```bash
git add share
git commit -m "feat(share): IP별 요청 제한(삭제 분리)·정확한 일일 상한·업로드 차단·개발용 만료 단축"
```

### Task 5: `@damwha/share-view` — 공유본 렌더러

fe 미리보기와 공유 뷰어가 **같은 컴포넌트**로 그린다(spec §2.5·§2.6). 소스(TSX)를 그대로 내보내고 두 Vite 앱이 번들한다. 스타일은 Tailwind가 아니라 패키지 자체 CSS(`sv-` 접두사)다 — 뷰어에는 Tailwind가 없고, fe의 Tailwind가 패키지 경로를 스캔하게 만들 이유도 없다.

**Files:**
- Create: `packages/share-view/package.json`, `tsconfig.json`, `vitest.config.ts`, `vitest.setup.ts`
- Create: `packages/share-view/src/index.ts`, `src/strings.ts`, `src/format.ts`, `src/markdown.tsx`, `src/share-document.tsx`, `src/styles.css`
- Create: `packages/share-view/src/share-document.test.tsx`

**Interfaces:**
- Consumes: `SharePayloadV1`, `ShareSpeaker` (Task 2), `UiLanguage` (contracts)
- Produces: `ShareDocument({ payload, lang, expiresAt }: { payload: SharePayloadV1; lang: UiLanguage; expiresAt: string | null }): JSX.Element` — `expiresAt`은 뷰어가 서버 헤더에서, fe 미리보기가 예상값으로 넘긴다, `viewerStrings(lang: UiLanguage): ViewerStrings`, `import '@damwha/share-view/styles.css'`

- [ ] **Step 1: 패키지 뼈대**

`packages/share-view/package.json`:

```json
{
  "name": "@damwha/share-view",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Read-only renderer of a decrypted share payload. Used by the fe share preview and the share viewer — the preview is the real thing.",
  "exports": {
    ".": "./src/index.ts",
    "./styles.css": "./src/styles.css"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "peerDependencies": {
    "react": "^19.2.7"
  },
  "dependencies": {
    "@damwha/contracts": "workspace:*",
    "@damwha/share-format": "workspace:*",
    "react-markdown": "^10.1.0",
    "remark-breaks": "^4.0.0",
    "remark-gfm": "^4.0.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.2",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.3",
    "jsdom": "^29.1.1",
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "typescript": "^5.9.3",
    "vitest": "^4.1.11"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "vitest.setup.ts"]
}
```

`vitest.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', globals: true, setupFiles: ['./vitest.setup.ts'], css: false },
});
```

`vitest.setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

Run: `pnpm install`

- [ ] **Step 2: 실패하는 테스트**

`src/share-document.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import type { SharePayloadV1 } from '@damwha/share-format';
import { ShareDocument } from './share-document';

const full = (): SharePayloadV1 => ({
  v: 1,
  created_at: '2026-10-09T00:00:00.000Z',
  ui_language: 'ko',
  meeting: { title: '주간 회의', recorded_at: '2026-10-08T01:00:00.000Z', duration_ms: 3_725_000 },
  speakers: [{ ref: 's1', name: '김담화' }, { ref: 's2', name: null }],
  summary: { topics: ['배포 일정'], segments: [{ title: '배포 논의', bullets: ['화요일 배포'], start_ms: 65_000, end_ms: 120_000 }] },
  lenses: [
    { kind: 'decision', text: '화요일에 배포한다', done: false, due_at: null, assignee_ref: null, start_ms: 65_000, linkable: true },
    { kind: 'action', text: '릴리스 노트', done: true, due_at: '2026-10-14', assignee_ref: 's1', start_ms: 70_000, linkable: false },
  ],
  transcript: [
    { speaker_ref: 's1', start_ms: 65_000, end_ms: 69_000, text: '화요일에 하죠' },
    { speaker_ref: 's2', start_ms: 70_000, end_ms: 72_000, text: '좋아요' },
  ],
  note: { body_md: '## 메모\n<img src=x onerror="alert(1)">\n[링크](javascript:alert(1)) [안전](https://example.com)' },
});

it('모든 섹션을 그린다', () => {
  render(<ShareDocument payload={full()} lang="ko" expiresAt="2026-10-16T00:00:00.000Z" />);
  expect(screen.getByRole('heading', { level: 1, name: '주간 회의' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '요약' })).toBeInTheDocument();
  expect(screen.getByText('배포 일정')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '결정' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '할 일' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '발화 기록' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '메모' })).toBeInTheDocument();
});

it('없는 섹션은 제목도 그리지 않는다', () => {
  const { summary, lenses, transcript, note, ...bare } = full();
  render(<ShareDocument payload={bare} lang="ko" expiresAt={null} />);
  for (const name of ['요약', '결정', '할 일', '약속', '발화 기록', '메모']) {
    expect(screen.queryByRole('heading', { name })).toBeNull();
  }
});

it('렌즈 0개·요약 세그먼트 0개도 빈 제목을 남기지 않는다', () => {
  render(<ShareDocument payload={{ ...full(), lenses: [], summary: { topics: [], segments: [] }, transcript: [] }} lang="ko" expiresAt={null} />);
  expect(screen.queryByRole('heading', { name: '결정' })).toBeNull();
  expect(screen.queryByRole('heading', { name: '요약' })).toBeNull();
  expect(screen.queryByRole('heading', { name: '발화 기록' })).toBeNull();
});

it('이름이 없는 화자는 "화자 N"으로 — N은 ref 번호다', () => {
  render(<ShareDocument payload={full()} lang="ko" expiresAt="2026-10-16T00:00:00.000Z" />);
  const transcript = screen.getByRole('region', { name: '발화 기록' });
  expect(within(transcript).getByText('김담화')).toBeInTheDocument();
  expect(within(transcript).getByText('화자 2')).toBeInTheDocument();
});

it('메모의 raw HTML과 javascript: 링크는 살아나지 않는다', () => {
  const { container } = render(<ShareDocument payload={full()} lang="ko" expiresAt="2026-10-16T00:00:00.000Z" />);
  expect(container.querySelector('img')).toBeNull();
  const links = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  expect(links).toEqual(['https://example.com']);
  expect(container.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
});

it('linkable이고 발화 기록이 있을 때만 시각이 버튼이다', () => {
  render(<ShareDocument payload={full()} lang="ko" expiresAt="2026-10-16T00:00:00.000Z" />);
  const decisions = screen.getByRole('region', { name: '결정' });
  expect(within(decisions).getByRole('button', { name: /1:05/ })).toBeInTheDocument();
  const actions = screen.getByRole('region', { name: '할 일' });
  expect(within(actions).queryByRole('button')).toBeNull();
  expect(within(actions).getByText('1:10')).toBeInTheDocument();
});

it('발화 기록이 없으면 linkable이어도 시각은 글자다', () => {
  const { transcript, ...p } = full();
  render(<ShareDocument payload={p} lang="ko" expiresAt={null} />);
  expect(within(screen.getByRole('region', { name: '결정' })).queryByRole('button')).toBeNull();
});

it('영어 문구', () => {
  render(<ShareDocument payload={full()} lang="en" expiresAt="2026-10-16T00:00:00.000Z" />);
  expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Transcript' })).toBeInTheDocument();
  expect(screen.getByText('Speaker 2')).toBeInTheDocument();
});

it('만료 시각이 있으면 하단에 표시, 없으면 만료 문구를 빼고 스냅샷 안내만', () => {
  const { unmount } = render(<ShareDocument payload={full()} lang="ko" expiresAt="2026-10-16T00:00:00.000Z" />);
  expect(screen.getByText(/링크 만료/)).toBeInTheDocument();
  unmount();
  render(<ShareDocument payload={full()} lang="ko" expiresAt={null} />);
  expect(screen.queryByText(/링크 만료/)).toBeNull();
  expect(screen.getByText(/담화로 만든 공유본/)).toBeInTheDocument();
});

it('제목이 없으면 대체 제목, 하단에 스냅샷 안내', () => {
  render(<ShareDocument payload={{ ...full(), meeting: { ...full().meeting, title: null } }} lang="ko" expiresAt={null} />);
  expect(screen.getByRole('heading', { level: 1, name: '제목 없는 대화' })).toBeInTheDocument();
  expect(screen.getByText('보낸 사람이 공유한 시점의 내용이에요.')).toBeInTheDocument();
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm --filter @damwha/share-view test`
Expected: FAIL — `./share-document`가 없다.

- [ ] **Step 4: 구현**

`src/strings.ts`:

```ts
import type { UiLanguage } from '@damwha/contracts';

const ko = {
  untitled: '제목 없는 대화',
  summary: '요약',
  topics: '주요 주제',
  decision: '결정',
  action: '할 일',
  promise: '약속',
  transcript: '발화 기록',
  note: '메모',
  speaker: (n: number) => `화자 ${n}`,
  due: (d: string) => `기한 ${d}`,
  done: '완료',
  jumpTo: (t: string) => `${t} 발화로 이동`,
  madeWith: '담화로 만든 공유본',
  expires: (d: string) => `링크 만료 ${d}`,
  snapshot: '보낸 사람이 공유한 시점의 내용이에요.',
};

export type ViewerStrings = typeof ko;

const en: ViewerStrings = {
  untitled: 'Untitled conversation',
  summary: 'Summary',
  topics: 'Topics',
  decision: 'Decisions',
  action: 'Action items',
  promise: 'Promises',
  transcript: 'Transcript',
  note: 'Notes',
  speaker: (n) => `Speaker ${n}`,
  due: (d) => `Due ${d}`,
  done: 'Done',
  jumpTo: (t) => `Jump to ${t}`,
  madeWith: 'Shared from Damwha',
  expires: (d) => `Link expires ${d}`,
  snapshot: 'This is a snapshot from when it was shared.',
};

export function viewerStrings(lang: UiLanguage): ViewerStrings {
  return lang === 'ko' ? ko : en;
}
```

`src/format.ts`:

```ts
import type { UiLanguage } from '@damwha/contracts';

/** 65_000 → "1:05", 3_725_000 → "1:02:05". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function dateTime(iso: string, lang: UiLanguage): string {
  return new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso));
}
```

`src/markdown.tsx` — fe의 `features/meeting/ui/markdown.tsx`와 같은 규칙(`rehype-raw` 없음 → raw HTML은 텍스트, `http(s)`만 링크):

```tsx
import type * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

/**
 * 공유본 메모 렌더러. 키가 페이지 URL(#)에 있으므로 XSS는 곧 키 유출이다 (spec §2.5).
 * `rehype-raw`를 붙이지 않아 raw HTML은 텍스트로 남고, 링크는 http(s)만 살린다.
 */
function SafeLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="sv-link">
      {children}
    </a>
  );
}

export function Markdown({ body }: { body: string }) {
  return (
    <div className="sv-md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ a: SafeLink, img: () => null }}>
        {body}
      </ReactMarkdown>
    </div>
  );
}
```

`src/share-document.tsx`:

```tsx
import type * as React from 'react';
import type { UiLanguage } from '@damwha/contracts';
import type { ShareLens, SharePayloadV1, ShareSpeaker } from '@damwha/share-format';
import { clock, dateTime } from './format';
import { Markdown } from './markdown';
import { viewerStrings, type ViewerStrings } from './strings';

const LENS_ORDER = ['decision', 'action', 'promise'] as const;

function nameOf(speakers: ShareSpeaker[], ref: string | null, s: ViewerStrings): string {
  if (ref === null) return '';
  const sp = speakers.find((x) => x.ref === ref);
  return sp?.name ?? s.speaker(Number(ref.slice(1)));
}

function scrollToUtterance(ms: number) {
  document.querySelector<HTMLElement>(`[data-sv-start="${ms}"]`)?.scrollIntoView({ block: 'center' });
}

function Time({ ms, linkable, s }: { ms: number | null; linkable: boolean; s: ViewerStrings }) {
  if (ms === null) return null;
  const t = clock(ms);
  if (!linkable) return <span className="sv-time">{t}</span>;
  return (
    <button type="button" className="sv-time sv-time-link" aria-label={s.jumpTo(t)} onClick={() => scrollToUtterance(ms)}>
      {t}
    </button>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="sv-section" aria-labelledby={id}>
      <h2 id={id} className="sv-h2">{title}</h2>
      {children}
    </section>
  );
}

/** 복호화한 공유본을 그린다. 없는 섹션·빈 섹션은 제목째 그리지 않는다. */
export function ShareDocument({ payload, lang, expiresAt }: { payload: SharePayloadV1; lang: UiLanguage; expiresAt: string | null }) {
  const s = viewerStrings(lang);
  const hasTranscript = (payload.transcript?.length ?? 0) > 0;
  const lensesBy = (kind: ShareLens['kind']) => (payload.lenses ?? []).filter((l) => l.kind === kind);
  const summary = payload.summary;
  const showSummary = summary !== undefined && (summary.topics.length > 0 || summary.segments.length > 0);

  return (
    <article className="sv-root">
      <header className="sv-header">
        <h1 className="sv-h1">{payload.meeting.title ?? s.untitled}</h1>
        <p className="sv-meta">
          {dateTime(payload.meeting.recorded_at, lang)}
          {payload.meeting.duration_ms !== null && <> · {clock(payload.meeting.duration_ms)}</>}
        </p>
      </header>

      {showSummary && (
        <Section id="sv-summary" title={s.summary}>
          {summary.topics.length > 0 && (
            <ul className="sv-topics" aria-label={s.topics}>
              {summary.topics.map((t) => <li key={t} className="sv-chip">{t}</li>)}
            </ul>
          )}
          {summary.segments.map((seg) => (
            <div key={`${seg.start_ms}-${seg.title}`} className="sv-segment">
              <h3 className="sv-h3">
                <Time ms={seg.start_ms} linkable={hasTranscript} s={s} /> {seg.title}
              </h3>
              <ul className="sv-bullets">{seg.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
            </div>
          ))}
        </Section>
      )}

      {LENS_ORDER.map((kind) => {
        const items = lensesBy(kind);
        if (items.length === 0) return null;
        return (
          <Section key={kind} id={`sv-lens-${kind}`} title={s[kind]}>
            <ul className="sv-lenses">
              {items.map((l, i) => (
                <li key={i} className={l.done ? 'sv-lens sv-done' : 'sv-lens'}>
                  <span className="sv-lens-text">{l.text}</span>
                  <span className="sv-lens-meta">
                    {l.done && <span className="sv-badge">{s.done}</span>}
                    {l.assignee_ref && <span>{nameOf(payload.speakers, l.assignee_ref, s)}</span>}
                    {l.due_at && <span>{s.due(l.due_at)}</span>}
                    <Time ms={l.start_ms} linkable={l.linkable && hasTranscript} s={s} />
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        );
      })}

      {hasTranscript && (
        <Section id="sv-transcript" title={s.transcript}>
          <ol className="sv-utterances">
            {payload.transcript!.map((u, i) => (
              <li key={i} className="sv-utterance" data-sv-start={u.start_ms}>
                <span className="sv-speaker">{nameOf(payload.speakers, u.speaker_ref, s)}</span>
                <span className="sv-time">{clock(u.start_ms)}</span>
                <p className="sv-text">{u.text}</p>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {payload.note && (
        <Section id="sv-note" title={s.note}>
          <Markdown body={payload.note.body_md} />
        </Section>
      )}

      <footer className="sv-footer">
        <p>
          {s.madeWith}
          {expiresAt && <> · {s.expires(dateTime(expiresAt, lang))}</>}
        </p>
        <p>{s.snapshot}</p>
      </footer>
    </article>
  );
}
```

`src/index.ts`:

```ts
export { ShareDocument } from './share-document';
export { viewerStrings, type ViewerStrings } from './strings';
```

`src/styles.css` — 색은 `fe/DESIGN.md`의 중립 회색·강조색 값을 옮겨 `.sv-root`에 토큰으로 둔다(라이트 + `prefers-color-scheme: dark`). 모든 클래스는 `sv-` 접두사, `.sv-root` 밖을 건드리지 않는다:

```css
.sv-root {
  --sv-bg: #ffffff;
  --sv-fg: #1a1a1a;
  --sv-muted: #6b6b6b;
  --sv-border: #e6e6e6;
  --sv-chip: #f2f2f2;
  --sv-accent: #3b5bdb;
  max-width: 760px;
  margin: 0 auto;
  padding: 32px 16px 48px;
  color: var(--sv-fg);
  background: var(--sv-bg);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", sans-serif;
}
@media (prefers-color-scheme: dark) {
  .sv-root {
    --sv-bg: #161616;
    --sv-fg: #ececec;
    --sv-muted: #9a9a9a;
    --sv-border: #2c2c2c;
    --sv-chip: #232323;
    --sv-accent: #8ea2ff;
  }
}
.sv-h1 { font-size: 24px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.02em; }
.sv-h2 { font-size: 17px; font-weight: 600; margin: 0 0 12px; }
.sv-h3 { font-size: 15px; font-weight: 600; margin: 12px 0 4px; }
.sv-meta, .sv-footer, .sv-lens-meta, .sv-time { color: var(--sv-muted); font-size: 13px; }
.sv-section { border-top: 1px solid var(--sv-border); padding: 20px 0; }
.sv-topics { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; padding: 0; margin: 0 0 8px; }
.sv-chip { background: var(--sv-chip); border-radius: 999px; padding: 2px 10px; font-size: 13px; }
.sv-bullets, .sv-lenses, .sv-utterances { margin: 0; padding-left: 18px; }
.sv-lenses, .sv-utterances { list-style: none; padding: 0; }
.sv-lens { display: flex; flex-direction: column; gap: 2px; padding: 8px 0; }
.sv-done .sv-lens-text { text-decoration: line-through; color: var(--sv-muted); }
.sv-lens-meta { display: flex; flex-wrap: wrap; gap: 8px; }
.sv-badge { border: 1px solid var(--sv-border); border-radius: 4px; padding: 0 6px; }
.sv-time-link { background: none; border: 0; padding: 0; color: var(--sv-accent); cursor: pointer; font: inherit; }
.sv-utterance { display: grid; grid-template-columns: auto 1fr; column-gap: 8px; padding: 6px 0; }
.sv-speaker { font-weight: 600; font-size: 13px; }
.sv-text { grid-column: 1 / -1; margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.sv-md { overflow-wrap: anywhere; }
.sv-link { color: var(--sv-accent); }
.sv-footer { border-top: 1px solid var(--sv-border); padding-top: 16px; }
```

- [ ] **Step 5: 통과 확인**

Run: `pnpm --filter @damwha/share-view test && pnpm --filter @damwha/share-view typecheck`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add packages/share-view pnpm-lock.yaml
git commit -m "feat(share-view): 공유본 렌더러 — fe 미리보기와 뷰어가 같은 컴포넌트를 쓴다"
```

### Task 6: 공유 뷰어와 공유 서버의 정적 서빙

**Files:**
- Create: `share/viewer/index.html`, `share/viewer/vite.config.ts`, `share/viewer/vitest.config.ts`, `share/viewer/tsconfig.json`
- Create: `share/viewer/src/main.tsx`, `share/viewer/src/app.tsx`, `share/viewer/src/load-share.ts`, `share/viewer/src/language.ts`, `share/viewer/src/viewer.css`
- Create: `share/viewer/test/load-share.test.ts`, `share/viewer/test/language.test.ts`
- Create: `share/src/static.ts`, `share/test/viewer-route.test.ts`
- Modify: `share/package.json`, `share/src/app.ts`, `share/tsconfig.json` (`include`에서 viewer 제외)

**Interfaces:**
- Consumes: `decryptShare`, `SHARE_ID_RE` (Task 2), `ShareDocument` (Task 5), `pickUiLanguage` (contracts), `createApp` (Task 3)
- Produces: `GET /s/:id` → 뷰어 HTML, `GET /assets/<파일>` → 번들(보안 헤더 포함). `loadShare(loc, fetchFn): Promise<LoadResult>`(`ok`면 `expiresAt` 포함), `viewerLanguage(locales, fallback): UiLanguage`, `serveViewer(pathname, dir): Promise<Response | null>`

- [ ] **Step 1: 뷰어 뼈대와 의존성**

Run: `pnpm --filter damwha-share add @damwha/share-view@workspace:* react@^19.2.7 react-dom@^19.2.7 && pnpm --filter damwha-share add -D vite@^8.1.0 @vitejs/plugin-react@^6.0.3 @types/react@^19.2.17 @types/react-dom@^19.2.3 jsdom@^29.1.1`

`share/package.json` scripts:

```json
"start": "pnpm run build:viewer && tsx src/main.ts",
"build": "pnpm run build:viewer && tsc -p tsconfig.build.json",
"build:viewer": "vite build --config viewer/vite.config.ts",
"test": "pnpm run build:viewer && vitest run && vitest run --config viewer/vitest.config.ts",
"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p viewer/tsconfig.json --noEmit"
```

`share/tsconfig.json`의 `include`는 `["src", "test"]` 그대로 둔다(viewer는 자기 tsconfig).

`share/viewer/vite.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  // CSP가 inline 스크립트를 막는다 — modulepreload 폴리필(inline)을 넣지 않는다.
  build: { outDir: '../dist/viewer', emptyOutDir: true, modulePreload: { polyfill: false } },
});
```

`share/viewer/vitest.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: { environment: 'jsdom', include: ['test/**/*.test.ts'] },
});
```

`share/viewer/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

`share/viewer/index.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="referrer" content="no-referrer" />
    <title>Damwha</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: 실패하는 테스트**

`share/viewer/test/load-share.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { encryptShare, generateShareKey, type SharePayloadV1 } from '@damwha/share-format';
import { loadShare } from '../src/load-share';

const ID = '7-AAAAAAAAAAAAAAAAAAAAAA';
const EXP = '2026-10-16T03:00:00.000Z';
const payload: SharePayloadV1 = {
  v: 1, created_at: 'a', ui_language: 'ko',
  meeting: { title: '회의', recorded_at: '2026-10-08T00:00:00.000Z', duration_ms: null }, speakers: [],
};
const respond = (status: number, body?: Uint8Array, headers: Record<string, string> = {}) => async () =>
  new Response(body ?? null, { status, headers });

describe('loadShare', () => {
  it('id·키가 맞으면 복호화한 페이로드와 서버가 정한 만료 시각', async () => {
    const key = generateShareKey();
    const env = await encryptShare(payload, key);
    const calls: string[] = [];
    const r = await loadShare({ pathname: `/s/${ID}`, hash: `#${key}` }, async (url) => {
      calls.push(String(url));
      return new Response(env, { headers: { 'X-Share-Expires-At': EXP } });
    });
    expect(r).toEqual({ kind: 'ok', payload, expiresAt: EXP });
    expect(calls).toEqual([`/api/shares/${ID}`]); // 키는 요청 URL에 실리지 않는다
  });

  it('키가 없거나 id 형식이 틀리면 요청하지 않고 invalid', async () => {
    let called = false;
    const f = async () => ((called = true), new Response(null));
    expect(await loadShare({ pathname: `/s/${ID}`, hash: '' }, f)).toEqual({ kind: 'invalid' });
    expect(await loadShare({ pathname: '/s/nope', hash: '#k' }, f)).toEqual({ kind: 'invalid' });
    expect(called).toBe(false);
  });

  it('410이면 gone', async () => {
    expect(await loadShare({ pathname: `/s/${ID}`, hash: '#k' }, respond(410))).toEqual({ kind: 'gone' });
  });

  it('다른 키로는 invalid — 페이로드를 내지 않는다', async () => {
    const env = await encryptShare(payload, generateShareKey());
    expect(await loadShare({ pathname: `/s/${ID}`, hash: `#${generateShareKey()}` }, respond(200, env, { 'X-Share-Expires-At': EXP }))).toEqual({ kind: 'invalid' });
  });

  it('네트워크 실패·5xx·429는 error', async () => {
    expect(await loadShare({ pathname: `/s/${ID}`, hash: '#k' }, async () => { throw new TypeError('offline'); })).toEqual({ kind: 'error' });
    expect(await loadShare({ pathname: `/s/${ID}`, hash: '#k' }, respond(503))).toEqual({ kind: 'error' });
    expect(await loadShare({ pathname: `/s/${ID}`, hash: '#k' }, respond(429))).toEqual({ kind: 'error' });
  });
});
```

`share/viewer/test/language.test.ts`:

```ts
import { expect, it } from 'vitest';
import { viewerLanguage } from '../src/language';

it('브라우저 언어가 ko/en이면 그것', () => {
  expect(viewerLanguage(['ko-KR'], 'en')).toBe('ko');
  expect(viewerLanguage(['en-US'], 'ko')).toBe('en');
  expect(viewerLanguage(['ja-JP', 'en-GB'], 'ko')).toBe('en');
});

it('둘 다 아니면 공유한 사람의 언어', () => {
  expect(viewerLanguage(['ja-JP'], 'ko')).toBe('ko');
  expect(viewerLanguage([], 'en')).toBe('en');
});
```

`share/test/viewer-route.test.ts` — `pnpm share:test`가 먼저 `build:viewer`를 돌리므로 `dist/viewer`가 있다:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { DiskStore } from '../src/store.js';

const VIEWER = fileURLToPath(new URL('../dist/viewer', import.meta.url));
let dir: string;
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dw-share-viewer-'));
  const store = new DiskStore(dir);
  await store.init();
  app = createApp({ store, config: { ...readConfig({}), dataDir: dir }, now: () => new Date(), viewerDir: VIEWER });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const get = (path: string) => app.fetch(new Request(`https://damwha-share.example${path}`), { ip: 'a' });

it('/s/:id는 뷰어 HTML이고 inline 스크립트가 없으며 보안 헤더가 붙는다', async () => {
  const res = await get('/s/7-AAAAAAAAAAAAAAAAAAAAAA');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  const html = await res.text();
  expect(html).toContain('<div id="root"></div>');
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
});

it('번들 자산은 맞는 Content-Type과 보안 헤더로', async () => {
  const html = await (await get('/s/7-AAAAAAAAAAAAAAAAAAAAAA')).text();
  const src = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  expect(src).toBeDefined();
  const res = await get(src!);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
});

it('assets 밖의 파일·경로 탈출·모르는 확장자는 404', async () => {
  for (const p of ['/index.html', '/assets/../index.html', '/assets/%2e%2e%2fpackage.json', '/assets/x.exe', '/s/a/b']) {
    expect((await get(p)).status).toBe(404);
  }
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm share:test`
Expected: FAIL — `viewer/src/main.tsx`가 없어 `build:viewer`가 실패한다.

- [ ] **Step 4: 구현 — 뷰어**

`share/viewer/src/load-share.ts`:

```ts
import { decryptShare, SHARE_ID_RE, type SharePayloadV1 } from '@damwha/share-format';

export type LoadResult =
  | { kind: 'ok'; payload: SharePayloadV1; expiresAt: string | null }
  | { kind: 'invalid' }
  | { kind: 'gone' }
  | { kind: 'error' };

/**
 * 링크(`/s/<id>#<key>`)를 읽어 공유본을 받는다. 키는 `#` 뒤라 서버로 가지 않는다 — 요청 URL에는 id만 실린다.
 * 만료 시각은 페이로드가 아니라 서버 응답 헤더에서 온다(권위가 서버다, spec selfhost §2.4).
 */
export async function loadShare(
  loc: { pathname: string; hash: string },
  fetchFn: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<LoadResult> {
  const id = loc.pathname.match(/^\/s\/([^/]+)\/?$/)?.[1];
  const key = loc.hash.replace(/^#/, '');
  if (!id || !SHARE_ID_RE.test(id) || !key) return { kind: 'invalid' };
  let res: Response;
  try {
    res = await fetchFn(`/api/shares/${id}`, { cache: 'no-store' });
  } catch {
    return { kind: 'error' };
  }
  if (res.status === 410) return { kind: 'gone' };
  if (res.status === 404) return { kind: 'invalid' };
  if (!res.ok) return { kind: 'error' };
  try {
    const payload = await decryptShare(new Uint8Array(await res.arrayBuffer()), key);
    return { kind: 'ok', payload, expiresAt: res.headers.get('X-Share-Expires-At') };
  } catch {
    return { kind: 'invalid' };
  }
}
```

`share/viewer/src/language.ts`:

```ts
import { pickUiLanguage, type UiLanguage } from '@damwha/contracts';

/** 브라우저 언어가 ko/en 중 하나면 그것, 아니면 공유한 사람의 화면 언어 (spec §2.5). */
export function viewerLanguage(locales: readonly string[], fallback: UiLanguage): UiLanguage {
  const known = locales.some((l) => /^(ko|en)([-_]|$)/i.test(l.trim()));
  return known ? pickUiLanguage(locales) : fallback;
}
```

`share/viewer/src/app.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { pickUiLanguage } from '@damwha/contracts';
import { ShareDocument } from '@damwha/share-view';
import { loadShare, type LoadResult } from './load-share';
import { viewerLanguage } from './language';

const MESSAGES = {
  ko: { loading: '불러오는 중…', invalid: '링크가 올바르지 않아요.', gone: '이 공유는 만료되었거나 중지되었어요.', error: '공유본을 불러오지 못했어요. 잠시 후 다시 열어 주세요.' },
  en: { loading: 'Loading…', invalid: 'This link is not valid.', gone: 'This share has expired or was stopped.', error: "Couldn't load this share. Please try again shortly." },
};

export function App() {
  const [result, setResult] = useState<LoadResult | null>(null);
  useEffect(() => {
    void loadShare(window.location).then(setResult);
  }, []);

  const browserLang = pickUiLanguage(navigator.languages);
  if (result === null) return <p className="viewer-state">{MESSAGES[browserLang].loading}</p>;
  if (result.kind !== 'ok') return <p className="viewer-state" role="alert">{MESSAGES[browserLang][result.kind]}</p>;
  const lang = viewerLanguage(navigator.languages, result.payload.ui_language);
  document.documentElement.lang = lang;
  return <ShareDocument payload={result.payload} lang={lang} expiresAt={result.expiresAt} />;
}
```

`share/viewer/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@damwha/share-view/styles.css';
import './viewer.css';
import { App } from './app';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`share/viewer/src/viewer.css`:

```css
html, body { margin: 0; }
body { background: #ffffff; }
@media (prefers-color-scheme: dark) { body { background: #161616; } }
.viewer-state { max-width: 760px; margin: 0 auto; padding: 48px 16px; font: 15px/1.6 -apple-system, sans-serif; color: #6b6b6b; }
```

- [ ] **Step 5: 구현 — 정적 서빙**

`share/src/static.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const VIEWER_PAGE = /^\/s\/[^/]+\/?$/;
// 파일 이름 한 단계만 — `..`·슬래시·인코딩된 문자는 이 정규식을 통과하지 못한다.
const ASSET = /^\/assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

async function file(path: string, type: string): Promise<Response | null> {
  try {
    return new Response(await readFile(path), { headers: { 'Content-Type': type } });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** `/s/<id>` → 뷰어 index.html, `/assets/<파일>` → 번들. 그 밖은 null(호출부가 404). id 검사는 뷰어가 한다. */
export async function serveViewer(pathname: string, dir: string): Promise<Response | null> {
  if (VIEWER_PAGE.test(pathname)) return file(join(dir, 'index.html'), 'text/html; charset=utf-8');
  if (!ASSET.test(pathname)) return null;
  const type = TYPES[extname(pathname)];
  return type ? file(join(dir, pathname), type) : null;
}
```

`share/src/app.ts` — import에 `import { serveViewer } from './static.js';`를 더하고, `route` 끝의 `return json(404, …)` 앞에:

```ts
    if (req.method === 'GET' && deps.viewerDir) {
      const page = await serveViewer(url.pathname, deps.viewerDir);
      if (page) return page;
    }
```

- [ ] **Step 6: 통과 확인**

Run: `pnpm share:test && pnpm share typecheck`
Expected: PASS — 서버 테스트(Task 3·4·6)와 뷰어 테스트 전부.

- [ ] **Step 7: 로컬에서 직접 열어 보기**

Run: `pnpm share:dev` (다른 터미널)

```bash
node --input-type=module -e "
import { encryptShare, generateShareKey } from './packages/share-format/dist/esm/index.js';
const key = generateShareKey();
const p = { v:1, created_at:new Date().toISOString(), ui_language:'ko',
  meeting:{ title:'로컬 확인', recorded_at:new Date().toISOString(), duration_ms:60000 }, speakers:[{ref:'s1',name:'김담화'}],
  transcript:[{ speaker_ref:'s1', start_ms:0, end_ms:2000, text:'안녕하세요' }] };
const res = await fetch('http://localhost:8787/api/shares', { method:'POST', headers:{'X-Share-Days':'1'}, body: await encryptShare(p, key) });
const { id } = await res.json();
console.log('http://localhost:8787/s/' + id + '#' + key);
"
```

Expected: 출력된 링크를 브라우저로 열면 "로컬 확인" 제목, 발화 한 줄, 하단 만료 날짜(서버가 정한 값)가 보이고, 개발자 도구 콘솔에 CSP 위반이 없다. `#` 뒤를 지우고 열면 "링크가 올바르지 않아요."

- [ ] **Step 8: 커밋**

```bash
git add share pnpm-lock.yaml
git commit -m "feat(share): 공유 뷰어 — 브라우저에서 복호화, 만료 시각은 서버 헤더, 같은 서버가 정적 서빙"
```

---

## 3단계 — be 공유 모듈

### Task 7: 마이그레이션 032 `meeting_share`

**Files:**
- Create: `be/src/database/migrations/032_meeting_share.sql`
- Modify: `be/test/db.ts` (`reset`의 TRUNCATE 목록)
- Create: `be/test/meeting-share-schema.spec.ts`

**Interfaces:**
- Produces: 테이블 `meeting_share` — spec §2.7 그대로에 `revoke_attempts int NOT NULL DEFAULT 0`을 더한다(재시도 간격을 늘리는 데 필요하다. spec의 "5분 → 최대 1시간"을 구현하려면 시도 횟수가 있어야 한다). 인덱스 `meeting_share_one_creating_idx`, `meeting_share_one_active_idx`, `meeting_share_status_idx`.

- [ ] **Step 1: 실패하는 테스트**

`be/test/meeting-share-schema.spec.ts`:

```ts
import { startTestDb, StartedTestDb } from './db';

describe('meeting_share 스키마', () => {
  let db: StartedTestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  const mkMeeting = async () =>
    (await db.pool.query(`INSERT INTO meeting(audio_key,status) VALUES('a','done') RETURNING id`)).rows[0].id as string;
  const insert = (meetingId: string, status: string) =>
    db.pool.query(
      `INSERT INTO meeting_share(meeting_id,status,scope,duration_days,consent_version,consented_at)
       VALUES($1,$2,'{}'::jsonb,7,1,now()) RETURNING id`,
      [meetingId, status],
    );

  it('id는 shr_<n>', async () => {
    const { rows } = await insert(await mkMeeting(), 'creating');
    expect(rows[0].id).toMatch(/^shr_[1-9][0-9]*$/);
  });

  it('회의당 active는 하나, creating도 하나', async () => {
    const m = await mkMeeting();
    await insert(m, 'active');
    await expect(insert(m, 'active')).rejects.toMatchObject({ constraint: 'meeting_share_one_active_idx' });
    await insert(m, 'creating');
    await expect(insert(m, 'creating')).rejects.toMatchObject({ constraint: 'meeting_share_one_creating_idx' });
    await insert(m, 'revoke_pending');
    await insert(m, 'revoke_pending');
  });

  it('회의를 지워도 행은 남고 meeting_id만 NULL이 된다 — 삭제 토큰을 잃지 않는다', async () => {
    const m = await mkMeeting();
    const { rows } = await insert(m, 'revoke_pending');
    await db.pool.query(`DELETE FROM meeting WHERE id=$1`, [m]);
    const after = await db.pool.query(`SELECT meeting_id FROM meeting_share WHERE id=$1`, [rows[0].id]);
    expect(after.rows).toEqual([{ meeting_id: null }]);
  });

  it('status는 다섯 값만', async () => {
    await expect(insert(await mkMeeting(), 'deleted')).rejects.toMatchObject({ code: '23514' });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-be exec jest test/meeting-share-schema.spec.ts`
Expected: FAIL — `relation "meeting_share" does not exist`

- [ ] **Step 3: 구현**

`be/src/database/migrations/032_meeting_share.sql`:

```sql
-- 회의 공유 링크 (spec 2026-10-09-meeting-share §2.7). 활성 링크이자 철회 대기열이다.
-- meeting에 CASCADE로 묶지 않는다: 회의와 함께 삭제 토큰이 사라지면 서버 객체를 철회할 수 없다.
-- 그래서 SET NULL로 행을 살리고, 회의 삭제는 같은 트랜잭션에서 active를 revoke_pending으로 바꾼다.
-- share_key는 링크의 #뒤에 들어가는 복호화 키 — 회의 원본과 같은 Mac 안에만 있고, 끝나면 NULL이다.
CREATE SEQUENCE shr_id_seq;
CREATE TABLE meeting_share (
  id                  text PRIMARY KEY DEFAULT 'shr_' || nextval('shr_id_seq') CHECK (id ~ '^shr_[1-9][0-9]*$'),
  meeting_id          text REFERENCES meeting(id) ON DELETE SET NULL,
  status              text NOT NULL CHECK (status IN ('creating','active','revoke_pending','revoked','expired')),
  remote_id           text UNIQUE,
  share_key           text,
  delete_token        text,
  scope               jsonb NOT NULL,
  duration_days       int NOT NULL,
  expires_at          timestamptz,
  consent_version     int NOT NULL,
  consented_at        timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  revoke_attempted_at timestamptz,
  revoke_attempts     int NOT NULL DEFAULT 0,
  revoke_error        jsonb
);
ALTER SEQUENCE shr_id_seq OWNED BY meeting_share.id;
-- 동시 공유 요청 두 개가 둘 다 링크를 남기지 못하게 한다 (spec §2.7 1단계).
CREATE UNIQUE INDEX meeting_share_one_creating_idx ON meeting_share(meeting_id) WHERE status = 'creating';
CREATE UNIQUE INDEX meeting_share_one_active_idx   ON meeting_share(meeting_id) WHERE status = 'active';
CREATE INDEX meeting_share_status_idx ON meeting_share(status, created_at DESC);
```

`be/test/db.ts`의 `reset` TRUNCATE 목록 맨 앞에 `meeting_share, `를 더한다(시퀀스도 `RESTART IDENTITY`로 되돌아간다).

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter damwha-be exec jest test/meeting-share-schema.spec.ts test/migration.spec.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add be/src/database/migrations/032_meeting_share.sql be/test/db.ts be/test/meeting-share-schema.spec.ts
git commit -m "feat(be): meeting_share 마이그레이션 — 회의를 지워도 철회할 수 있게 SET NULL"
```

### Task 8: 공유 서비스 주소·활성 조건·HTTP 클라이언트

**Files:**
- Modify: `be/package.json` (의존성 `@damwha/share-format`)
- Modify: `be/src/config/env.ts`
- Create: `be/src/shares/share-api-url.ts`, `be/src/shares/share-enabled.ts`, `be/src/shares/share-client.ts`
- Create: `be/test/fake-share-server.ts`, `be/test/share-client.spec.ts`
- Modify: `be/.env.example`

**Interfaces:**
- Consumes: `SHARE_ID_RE`, `SHARE_MAX_ENVELOPE_BYTES` (Task 2), `ShareDurationDays` (Task 1), 공유 서버 HTTP 계약 (Task 3·4)
- Produces:
  - env `SHARE_API_URL: string` (기본 `https://damwha-share.0kimjae.dev`)
  - `parseShareApiUrl(raw: string): URL` (잘못되면 throw)
  - `shareEnabled(env: { HOST: string; DEMO_READ_ONLY: string }): boolean`
  - `class ShareClient { constructor(baseUrl: string, timeoutMs?: number); upload(envelope: Uint8Array, days: ShareDurationDays, replace?: { id: string; token: string }): Promise<UploadResult>; remove(remoteId: string, deleteToken: string): Promise<'deleted' | 'gone'>; linkFor(remoteId: string, key: string): string }`
  - `type UploadResult = { id: string; delete_token: string; expires_at: string; replaced: boolean }`
  - `class ShareServiceError extends Error { kind: 'unreachable' | 'rejected'; status: number | null }`, `class ShareTooLargeError extends Error`
  - 테스트 도우미 `startFakeShareServer(): Promise<FakeShareServer>` (Task 10·11이 쓴다) — `nextUpload(): Promise<void>`로 "업로드 요청이 도착했다"를 기다릴 수 있다

- [ ] **Step 1: 의존성**

Run: `pnpm --filter damwha-be add @damwha/share-format@workspace:*`

- [ ] **Step 2: 가짜 공유 서버 (테스트 도우미)**

`be/test/fake-share-server.ts`:

```ts
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 공유 서버의 HTTP 계약(share/src/app.ts)만 흉내 내는 서버. be 테스트가 실제 공유 서버 없이 업로드·교체·철회·
 * 장애를 재현한다. mode로 장애를 고른다 — drop: 소켓을 끊음(오프라인), down500, busy503, redirect, garbage(201인데 본문이 틀림).
 * nextUpload()는 다음 POST가 **도착한 순간** 풀린다 — 경합 테스트가 "업로드 중"을 시간 대신 사건으로 기다린다.
 */
export type FakeMode = 'ok' | 'drop' | 'down500' | 'busy503' | 'redirect' | 'garbage';

export interface FakeShareServer {
  url: string;
  objects: Map<string, { body: Buffer; token: string; expires_at: string }>;
  requests: { method: string; path: string; headers: http.IncomingHttpHeaders }[];
  mode: FakeMode;
  delayMs: number;
  nextUpload(): Promise<void>;
  close(): Promise<void>;
}

export async function startFakeShareServer(): Promise<FakeShareServer> {
  let n = 0;
  let uploadWaiters: (() => void)[] = [];
  const state = {
    objects: new Map<string, { body: Buffer; token: string; expires_at: string }>(),
    requests: [] as FakeShareServer['requests'],
    mode: 'ok' as FakeMode,
    delayMs: 0,
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      state.requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers });
      if (req.method === 'POST') {
        const w = uploadWaiters;
        uploadWaiters = [];
        w.forEach((resolve) => resolve());
      }
      if (state.delayMs > 0) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.mode === 'drop') { req.socket.destroy(); return; }
      if (state.mode === 'down500') { res.writeHead(500).end(); return; }
      if (state.mode === 'busy503') { res.writeHead(503, { 'content-type': 'application/json' }).end('{"code":"DAILY_CAP"}'); return; }
      if (state.mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' }).end(); return; }
      const m = (req.url ?? '').match(/^\/api\/shares(?:\/([^/?]+))?$/);
      if (req.method === 'POST' && m && !m[1]) {
        if (state.mode === 'garbage') { res.writeHead(201, { 'content-type': 'application/json' }).end('{}'); return; }
        // 교체 — 토큰이 틀리면 아무것도 만들지 않는다 (share/src/app.ts와 같은 규칙)
        const replaceId = req.headers['x-replace-id'] as string | undefined;
        let replaced = false;
        if (replaceId !== undefined) {
          const old = state.objects.get(replaceId);
          if (old && req.headers['x-replace-token'] !== old.token) { res.writeHead(403).end('{"code":"BAD_TOKEN"}'); return; }
          replaced = old !== undefined;
        }
        const days = String(req.headers['x-share-days']);
        const id = `${days}-${String(++n).padStart(22, 'A')}`;
        const token = `tok-${n}`;
        const expires_at = new Date(Date.now() + Number(days) * 86_400_000).toISOString();
        state.objects.set(id, { body: Buffer.concat(chunks), token, expires_at });
        if (replaced) state.objects.delete(replaceId!);
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id, delete_token: token, expires_at, replaced }));
        return;
      }
      if (req.method === 'DELETE' && m?.[1]) {
        const o = state.objects.get(m[1]);
        if (!o) { res.writeHead(404).end(); return; }
        if (req.headers.authorization !== `Bearer ${o.token}`) { res.writeHead(403).end(); return; }
        state.objects.delete(m[1]);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    nextUpload: () => new Promise<void>((resolve) => uploadWaiters.push(resolve)),
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  });
}
```

- [ ] **Step 3: 실패하는 테스트**

`be/test/share-client.spec.ts`:

```ts
import { SHARE_MAX_ENVELOPE_BYTES } from '@damwha/share-format';
import { parseShareApiUrl } from '../src/shares/share-api-url';
import { shareEnabled } from '../src/shares/share-enabled';
import { ShareClient, ShareServiceError, ShareTooLargeError } from '../src/shares/share-client';
import { startFakeShareServer, FakeShareServer } from './fake-share-server';

describe('parseShareApiUrl', () => {
  it.each(['https://share.example', 'https://share.example/', 'http://localhost:8787', 'http://127.0.0.1:8787'])('%s 허용', (u) => {
    expect(() => parseShareApiUrl(u)).not.toThrow();
  });
  it.each(['http://share.example', 'https://share.example/api', 'https://u:p@share.example', 'https://share.example/?a=1', 'ftp://x', 'nope', ''])(
    '%s 거절',
    (u) => { expect(() => parseShareApiUrl(u)).toThrow(/SHARE_API_URL/); },
  );
});

describe('shareEnabled', () => {
  it.each([
    ['127.0.0.1', 'false', true],
    ['::1', 'false', true],
    ['localhost', 'false', true],
    ['0.0.0.0', 'false', false],
    ['192.168.0.10', 'false', false],
    ['127.0.0.1', 'true', false],
  ])('HOST=%s DEMO_READ_ONLY=%s → %s', (HOST, DEMO_READ_ONLY, expected) => {
    expect(shareEnabled({ HOST, DEMO_READ_ONLY })).toBe(expected);
  });
});

describe('ShareClient', () => {
  let fake: FakeShareServer;
  let client: ShareClient;
  beforeEach(async () => { fake = await startFakeShareServer(); client = new ShareClient(fake.url, 300); });
  afterEach(async () => { await fake.close(); });

  it('업로드 — 기간 헤더와 본문을 보내고 응답을 그대로 돌려준다', async () => {
    const up = await client.upload(new Uint8Array([1, 2, 3]), 7);
    expect(up.id).toMatch(/^7-/);
    expect(fake.requests[0]).toMatchObject({ method: 'POST', path: '/api/shares' });
    expect(fake.requests[0].headers['x-share-days']).toBe('7');
    expect(fake.requests[0].headers['content-type']).toBe('application/octet-stream');
    expect([...fake.objects.get(up.id)!.body]).toEqual([1, 2, 3]);
  });

  it('교체 — 기존 id·토큰을 헤더로 싣고, 응답의 replaced를 돌려준다', async () => {
    const old = await client.upload(new Uint8Array([1]), 7);
    const fresh = await client.upload(new Uint8Array([2]), 7, { id: old.id, token: old.delete_token });
    expect(fresh.replaced).toBe(true);
    expect(fake.requests[1].headers['x-replace-id']).toBe(old.id);
    expect(fake.requests[1].headers['x-replace-token']).toBe(old.delete_token);
    expect(fake.objects.has(old.id)).toBe(false);
  });

  it('교체 토큰이 틀리면 rejected/403', async () => {
    const old = await client.upload(new Uint8Array([1]), 7);
    await expect(client.upload(new Uint8Array([2]), 7, { id: old.id, token: 'wrong' })).rejects.toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('상한을 넘는 봉투는 보내지도 않는다', async () => {
    await expect(client.upload(new Uint8Array(SHARE_MAX_ENVELOPE_BYTES + 1), 7)).rejects.toBeInstanceOf(ShareTooLargeError);
    expect(fake.requests).toHaveLength(0);
  });

  it('철회 — 처음엔 deleted, 다시 하면 gone', async () => {
    const up = await client.upload(new Uint8Array([1]), 1);
    expect(await client.remove(up.id, up.delete_token)).toBe('deleted');
    expect(await client.remove(up.id, up.delete_token)).toBe('gone');
  });

  it('리다이렉트를 따라가지 않는다', async () => {
    fake.mode = 'redirect';
    await expect(client.upload(new Uint8Array([1]), 7)).rejects.toMatchObject({ kind: 'rejected', status: 302 });
    expect(fake.requests).toHaveLength(1);
  });

  it('503은 rejected/503', async () => {
    fake.mode = 'busy503';
    await expect(client.upload(new Uint8Array([1]), 7)).rejects.toMatchObject({ kind: 'rejected', status: 503 });
  });

  it('연결이 끊기면 unreachable', async () => {
    fake.mode = 'drop';
    await expect(client.upload(new Uint8Array([1]), 7)).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('타임아웃이면 unreachable', async () => {
    fake.delayMs = 1000;
    await expect(client.upload(new Uint8Array([1]), 7)).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('201인데 본문이 틀리면 rejected', async () => {
    fake.mode = 'garbage';
    await expect(client.upload(new Uint8Array([1]), 7)).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('오류 메시지에 삭제 토큰이 없다', async () => {
    fake.mode = 'down500';
    const err = await client.remove('7-AAAAAAAAAAAAAAAAAAAAA1', 'SECRET-TOKEN-123').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShareServiceError);
    expect(String((err as Error).message) + String((err as Error).stack)).not.toContain('SECRET-TOKEN-123');
  });

  it('링크는 <origin>/s/<id>#<key>', () => {
    expect(new ShareClient('https://share.example/').linkFor('7-x', 'KEY')).toBe('https://share.example/s/7-x#KEY');
  });
});
```

- [ ] **Step 4: 실패 확인**

Run: `pnpm --filter damwha-be exec jest test/share-client.spec.ts`
Expected: FAIL — `../src/shares/share-api-url` 모듈 없음.

- [ ] **Step 5: 구현**

`be/src/shares/share-api-url.ts`:

```ts
const LOCAL = new Set(['localhost', '127.0.0.1']);

/**
 * 공유 서버 주소 (spec selfhost §2.7 "밖으로 나가는 HTTP"). https만, 개발용 http://localhost·127.0.0.1만 예외.
 * 경로·쿼리·자격 증명이 붙은 값은 받지 않는다 — 링크(`<origin>/s/<id>#<key>`)와 API 경로를 이 origin에서 만든다.
 */
export function parseShareApiUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`SHARE_API_URL ${JSON.stringify(raw)} is not a URL`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.has(u.hostname))) {
    throw new Error('SHARE_API_URL must be https (http is allowed only for localhost and 127.0.0.1)');
  }
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') {
    throw new Error('SHARE_API_URL must be a bare origin — no path, query or credentials');
  }
  return u;
}
```

`be/src/shares/share-enabled.ts`:

```ts
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * 공유를 켤 수 있는가 (spec 2026-10-09 §2.7 공유 활성 조건). 로컬 API 접근 제어는 브라우저만 막을 뿐 인증이
 * 아니다 — Origin 없는 요청(curl 등)은 통과한다. loopback 바인드면 그런 요청은 같은 Mac에서만 오지만, Docker
 * (`HOST=0.0.0.0`)나 데모에서는 네트워크의 누구나 공유를 만들고 키를 읽게 된다. 그래서 앱에서만 켠다.
 */
export function shareEnabled(env: { HOST: string; DEMO_READ_ONLY: string }): boolean {
  return LOOPBACK.has(env.HOST) && env.DEMO_READ_ONLY !== 'true';
}
```

`be/src/shares/share-client.ts`:

```ts
import { SHARE_ID_RE, SHARE_MAX_ENVELOPE_BYTES } from '@damwha/share-format';
import type { ShareDurationDays } from '@damwha/contracts';
import { parseShareApiUrl } from './share-api-url';

export type UploadResult = { id: string; delete_token: string; expires_at: string; replaced: boolean };

/** 공유 서비스 호출 실패. 메시지에 키·삭제 토큰을 싣지 않는다 — 로그와 응답으로 흘러간다. */
export class ShareServiceError extends Error {
  readonly kind: 'unreachable' | 'rejected';
  readonly status: number | null;
  constructor(kind: 'unreachable' | 'rejected', status: number | null, message: string) {
    super(message);
    this.name = 'ShareServiceError';
    this.kind = kind;
    this.status = status;
  }
}

export class ShareTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`share envelope is ${bytes} bytes, over the ${SHARE_MAX_ENVELOPE_BYTES}-byte limit`);
    this.name = 'ShareTooLargeError';
  }
}

/**
 * be가 밖으로 보내는 첫 HTTP 요청 (spec §2.7). 리다이렉트를 따라가지 않고(`manual` — 3xx는 그대로 실패로 본다),
 * 요청마다 타임아웃을 건다. 들어오는 요청의 접근 제어(be/src/access)와는 무관하다(선행 결과 규칙 4).
 */
export class ShareClient {
  private readonly base: URL;
  constructor(baseUrl: string, private readonly timeoutMs = 10_000) {
    this.base = parseShareApiUrl(baseUrl);
  }

  /**
   * 업로드. `replace`를 주면 공유 서버가 같은 요청 안에서 기존 공유를 지운다(spec selfhost §2.4 교체) —
   * 응답이 오면 기존 링크는 이미 막혀 있다. 교체 토큰이 틀리면 서버는 아무것도 만들지 않고 403이다.
   */
  async upload(envelope: Uint8Array, days: ShareDurationDays, replace?: { id: string; token: string }): Promise<UploadResult> {
    if (envelope.byteLength > SHARE_MAX_ENVELOPE_BYTES) throw new ShareTooLargeError(envelope.byteLength);
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'X-Share-Days': String(days) };
    if (replace) {
      headers['X-Replace-Id'] = replace.id;
      headers['X-Replace-Token'] = replace.token;
    }
    const res = await this.send('/api/shares', { method: 'POST', headers, body: envelope });
    if (res.status !== 201) throw new ShareServiceError('rejected', res.status, `share service answered ${res.status} to upload`);
    const body = (await res.json().catch(() => null)) as Partial<UploadResult> | null;
    if (
      !body ||
      typeof body.id !== 'string' ||
      !SHARE_ID_RE.test(body.id) ||
      typeof body.delete_token !== 'string' ||
      typeof body.expires_at !== 'string' ||
      Number.isNaN(Date.parse(body.expires_at))
    ) {
      throw new ShareServiceError('rejected', res.status, 'share service returned a malformed upload response');
    }
    return { id: body.id, delete_token: body.delete_token, expires_at: body.expires_at, replaced: body.replaced === true };
  }

  /** 'deleted'·'gone'(이미 없음) 둘 다 성공이다. */
  async remove(remoteId: string, deleteToken: string): Promise<'deleted' | 'gone'> {
    const res = await this.send(`/api/shares/${encodeURIComponent(remoteId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${deleteToken}` },
    });
    if (res.status === 204 || res.status === 200) return 'deleted';
    if (res.status === 404 || res.status === 410) return 'gone';
    throw new ShareServiceError('rejected', res.status, `share service answered ${res.status} to delete`);
  }

  linkFor(remoteId: string, key: string): string {
    return `${this.base.origin}/s/${remoteId}#${key}`;
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(new URL(path, this.base), { ...init, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      // 원인 이름만 남긴다 — undici의 오류 객체는 요청 헤더(Authorization)를 cause에 담을 수 있다.
      throw new ShareServiceError('unreachable', null, `share service unreachable (${(e as Error).name})`);
    }
  }
}
```

`be/src/config/env.ts` — import에 `import { parseShareApiUrl } from '../shares/share-api-url';`를 더하고, `ALLOWED_HOSTS` 다음 줄에:

```ts
  // 공유 서버(share/, 개인 서버 + Cloudflare Tunnel)의 origin (spec selfhost §2.4·§2.7). 개발은 be/.env의
  // http://localhost:8787. 기본값이 운영 주소라 packaged 앱은 따로 넘기지 않는다 — desktop은 상속 env의 값을 지운다.
  SHARE_API_URL: z.string().default('https://damwha-share.0kimjae.dev').superRefine(validatedBy(parseShareApiUrl)),
```

`be/.env.example` 끝에:

```
# 공유 서비스 주소. 개발 중 공유를 시험하려면 `pnpm share:dev`를 띄우고 아래 줄을 켠다.
# 비워 두면 운영 주소(https://damwha-share.0kimjae.dev)다.
# SHARE_API_URL=http://localhost:8787
```

- [ ] **Step 6: 통과 확인**

Run: `pnpm --filter damwha-be exec jest test/share-client.spec.ts test/env.spec.ts`
Expected: PASS

- [ ] **Step 7: 변이 확인**

`send`의 `redirect: 'manual'`을 지우고 실행 → "리다이렉트를 따라가지 않는다"가 FAIL(요청이 2건이거나 unreachable). 되돌린다. `shareEnabled`의 `&& env.DEMO_READ_ONLY !== 'true'`를 지우고 → 마지막 행이 FAIL. 되돌린다.

- [ ] **Step 8: 커밋**

```bash
git add be/package.json pnpm-lock.yaml be/src/config/env.ts be/src/shares be/test/fake-share-server.ts be/test/share-client.spec.ts be/.env.example
git commit -m "feat(be): 공유 서비스 주소 검증·활성 조건·HTTP 클라이언트"
```

### Task 9: 스냅샷과 페이로드 빌더

**Files:**
- Create: `be/src/shares/share-snapshot.ts`, `be/src/shares/share-payload.ts`
- Create: `be/test/share-fixtures.ts`, `be/test/share-payload.spec.ts`, `be/test/share-snapshot.spec.ts`

**Interfaces:**
- Consumes: `SharePayloadV1`, `ShareScope`, `ShareSpeaker` (Task 2), `UiLanguage` (contracts)
- Produces:
  - `type MeetingSnapshot` (아래 코드)
  - `readSnapshot(pool: Pool, meetingId: string, hooks?: { afterFirstRead?: () => Promise<void> }): Promise<MeetingSnapshot | null>`
  - `buildPayload(snap: MeetingSnapshot, scope: ShareScope, opts: { now: Date; uiLanguage: UiLanguage }): SharePayloadV1` — 만료 시각은 받지 않는다(서버가 권위)
  - `class SummaryNotReadyError extends Error`
  - 테스트 도우미 `seedSharedMeeting(pool): Promise<{ meetingId; speakerId; u1; lensId }>`

- [ ] **Step 1: 실패하는 테스트 — 빌더(순수 함수)**

`be/test/share-payload.spec.ts`:

```ts
import type { ShareScope } from '@damwha/share-format';
import { buildPayload, SummaryNotReadyError } from '../src/shares/share-payload';
import type { MeetingSnapshot } from '../src/shares/share-snapshot';

const NOW = new Date('2026-10-09T00:00:00.000Z');
const ALL: ShareScope = { summary: true, lenses: true, transcript: true, note: true, anonymize: false };

const snap = (): MeetingSnapshot => ({
  meeting: { title: '주간 회의', recorded_at: new Date('2026-10-08T01:00:00.000Z'), duration_ms: 60_000, processing_version: 2 },
  summary: { status: 'done', topics: ['배포'], segments: [{ start_utterance_id: 'utt_9', end_utterance_id: 'utt_9', start_ms: 1000, end_ms: 3000, title: '배포', bullets: ['화요일'] }] },
  lenses: [
    { kind: 'action', text: '릴리스 노트', completion_status: 'open', due_at: '2026-10-14', assignee_speaker_id: 'spk_1', assignee_name: '김담화', primary: { start_ms: 1000, processing_version: 2, shared: true } },
    { kind: 'decision', text: '화요일 배포', completion_status: 'done', due_at: null, assignee_speaker_id: 'spk_7', assignee_name: '이참석', primary: { start_ms: 500, processing_version: 1, shared: false } },
    { kind: 'promise', text: '근거 없음', completion_status: 'open', due_at: null, assignee_speaker_id: null, assignee_name: null, primary: null },
    { kind: 'action', text: '침묵 근거', completion_status: 'open', due_at: null, assignee_speaker_id: null, assignee_name: null, primary: { start_ms: 6000, processing_version: 2, shared: false } },
  ],
  utterances: [
    { speaker_key: 'spk_1', speaker_name: '김담화', start_ms: 1000, end_ms: 3000, text: '화요일에 하죠' },
    { speaker_key: 'SPEAKER_01', speaker_name: null, start_ms: 4000, end_ms: 5000, text: '좋아요' },
  ],
  note: '## 메모',
});

const build = (scope: Partial<ShareScope>, s = snap()) =>
  buildPayload(s, { ...ALL, ...scope }, { now: NOW, uiLanguage: 'ko' });

it('허용 목록의 키만 나간다 — 내부 id·source·is_me·인용이 없다', () => {
  const p = build({});
  expect(Object.keys(p).sort()).toEqual(['created_at', 'lenses', 'meeting', 'note', 'speakers', 'summary', 'transcript', 'ui_language', 'v']);
  expect(Object.keys(p.meeting).sort()).toEqual(['duration_ms', 'recorded_at', 'title']);
  expect(Object.keys(p.summary!.segments[0]).sort()).toEqual(['bullets', 'end_ms', 'start_ms', 'title']);
  expect(Object.keys(p.lenses![0]).sort()).toEqual(['assignee_ref', 'done', 'due_at', 'kind', 'linkable', 'start_ms', 'text']);
  expect(Object.keys(p.transcript![0]).sort()).toEqual(['end_ms', 'speaker_ref', 'start_ms', 'text']);
  expect(JSON.stringify(p)).not.toMatch(/utt_|spk_|mtg_|lens_|SPEAKER_/);
});

it('화자 ref는 등장 순서 s1, s2… 이고 공유본에 나오는 화자만 담는다', () => {
  const p = build({});
  expect(p.speakers).toEqual([
    { ref: 's1', name: '김담화' },
    { ref: 's2', name: null },
    { ref: 's3', name: '이참석' },
  ]);
  expect(p.transcript!.map((u) => u.speaker_ref)).toEqual(['s1', 's2']);
  expect(p.lenses!.map((l) => l.assignee_ref)).toEqual(['s1', 's3', null, null]);
  expect(build({ transcript: false, lenses: false }).speakers).toEqual([]);
});

it('익명화는 발화 기록의 화자와 렌즈 담당자 두 곳에 같이 걸린다', () => {
  const p = build({ anonymize: true });
  expect(p.speakers.every((s) => s.name === null)).toBe(true);
  expect(JSON.stringify(p)).not.toContain('김담화');
  expect(JSON.stringify(p)).not.toContain('이참석');
});

it('익명화는 자유 텍스트 안의 이름을 바꾸지 않는다 (spec §2.1)', () => {
  const s = snap();
  s.summary!.segments[0].bullets = ['김담화 님이 정리'];
  expect(build({ anonymize: true }, s).summary!.segments[0].bullets).toEqual(['김담화 님이 정리']);
});

it('근거가 공유되는 발화일 때만 linkable — 예전 버전·silence·빈 본문이면 false, 근거가 없으면 start_ms=null', () => {
  const p = build({});
  expect(p.lenses!.map((l) => [l.start_ms, l.linkable])).toEqual([[1000, true], [500, false], [null, false], [6000, false]]);
  expect(p.lenses!.map((l) => l.done)).toEqual([false, true, false, false]);
});

it('고르지 않은 섹션은 키째 없다', () => {
  const p = build({ summary: false, lenses: false, transcript: false, note: false });
  expect(p).not.toHaveProperty('summary');
  expect(p).not.toHaveProperty('lenses');
  expect(p).not.toHaveProperty('transcript');
  expect(p).not.toHaveProperty('note');
});

it('요약을 골랐는데 done이 아니거나 없으면 SummaryNotReadyError', () => {
  const s = snap();
  s.summary!.status = 'failed';
  expect(() => build({}, s)).toThrow(SummaryNotReadyError);
  expect(() => build({}, { ...snap(), summary: null })).toThrow(SummaryNotReadyError);
  expect(() => build({ summary: false }, { ...snap(), summary: null })).not.toThrow();
});

it('메모가 없으면 note를 골라도 키가 없다, 발화 0개면 빈 배열', () => {
  const p = build({}, { ...snap(), note: null, utterances: [] });
  expect(p).not.toHaveProperty('note');
  expect(p.transcript).toEqual([]);
});

it('시각과 언어', () => {
  const p = build({});
  expect(p).toMatchObject({ v: 1, created_at: NOW.toISOString(), ui_language: 'ko' });
  expect(p).not.toHaveProperty('expires_at');
  expect(p.meeting.recorded_at).toBe('2026-10-08T01:00:00.000Z');
});
```

- [ ] **Step 2: 실패하는 테스트 — 스냅샷(DB)**

`be/test/share-fixtures.ts`:

```ts
import type { Pool } from 'pg';

/** 공유 테스트용 회의 하나: 화자 1명(+미확정 1), 발화 3(하나는 silence), 요약 done, 렌즈 1(근거 있음), 메모. */
export async function seedSharedMeeting(pool: Pool) {
  const q = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows[0];
  const speakerId = (await q(`INSERT INTO speaker(name, is_me) VALUES('김담화', true) RETURNING id`)).id as string;
  const meetingId = (await q(
    `INSERT INTO meeting(audio_key,status,title,duration_ms,processing_version) VALUES('a','done','주간 회의',60000,1) RETURNING id`,
  )).id as string;
  const u1 = (await q(
    `INSERT INTO utterance(meeting_id,speaker_id,diar_label,start_ms,end_ms,text,order_index,processing_version)
     VALUES($1,$2,'SPEAKER_00',1000,3000,'화요일에 배포하죠',0,1) RETURNING id`,
    [meetingId, speakerId],
  )).id as string;
  await pool.query(
    `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,order_index,processing_version)
     VALUES($1,'SPEAKER_01',4000,5000,'좋아요',1,1)`,
    [meetingId],
  );
  await pool.query(
    `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
     VALUES($1,'SPEAKER_01',6000,7000,NULL,'silence',2,1)`,
    [meetingId],
  );
  await pool.query(
    `INSERT INTO meeting_summary(meeting_id,processing_version,model,status,topics,segments)
     VALUES($1,1,'m','done',$2::jsonb,$3::jsonb)`,
    [meetingId, JSON.stringify(['배포']), JSON.stringify([{ start_utterance_id: u1, end_utterance_id: u1, start_ms: 1000, end_ms: 3000, title: '배포', bullets: ['화요일'] }])],
  );
  const lensId = (await q(
    `INSERT INTO lens_item(meeting_id,kind,text,source,assignee_speaker_id,due_at)
     VALUES($1,'action','릴리스 노트','user',$2,'2026-10-14') RETURNING id`,
    [meetingId, speakerId],
  )).id as string;
  await pool.query(`INSERT INTO lens_evidence(lens_item_id,utterance_id,relation) VALUES($1,$2,'primary')`, [lensId, u1]);
  await pool.query(`INSERT INTO meeting_note(meeting_id, body_md) VALUES($1,'## 메모')`, [meetingId]);
  return { meetingId, speakerId, u1, lensId };
}
```

`be/test/share-snapshot.spec.ts`:

```ts
import { readSnapshot } from '../src/shares/share-snapshot';
import { startTestDb, StartedTestDb } from './db';
import { seedSharedMeeting } from './share-fixtures';

describe('readSnapshot', () => {
  let db: StartedTestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  it('현재 버전의 ok 발화·요약·active 렌즈·메모를 읽는다', async () => {
    const { meetingId, speakerId } = await seedSharedMeeting(db.pool);
    const snap = (await readSnapshot(db.pool, meetingId))!;
    expect(snap.meeting).toMatchObject({ title: '주간 회의', duration_ms: 60000, processing_version: 1 });
    expect(snap.utterances).toEqual([
      { speaker_key: speakerId, speaker_name: '김담화', start_ms: 1000, end_ms: 3000, text: '화요일에 배포하죠' },
      { speaker_key: 'SPEAKER_01', speaker_name: null, start_ms: 4000, end_ms: 5000, text: '좋아요' },
    ]);
    expect(snap.summary).toMatchObject({ status: 'done', topics: ['배포'] });
    expect(snap.lenses).toEqual([
      expect.objectContaining({ kind: 'action', due_at: '2026-10-14', assignee_name: '김담화', primary: { start_ms: 1000, processing_version: 1, shared: true } }),
    ]);
    expect(snap.note).toBe('## 메모');
  });

  it('없는 회의는 null', async () => {
    expect(await readSnapshot(db.pool, 'mtg_999')).toBeNull();
  });

  it('재처리로 버전이 오르면 새 버전 발화만, 요약은 없음, 렌즈 근거는 옛 버전을 가리킨다', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    await db.pool.query(`UPDATE meeting SET processing_version=2 WHERE id=$1`, [meetingId]);
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,order_index,processing_version)
       VALUES($1,'SPEAKER_00',1200,3100,'재처리된 발화',0,2)`,
      [meetingId],
    );
    const snap = (await readSnapshot(db.pool, meetingId))!;
    expect(snap.utterances.map((u) => u.text)).toEqual(['재처리된 발화']);
    expect(snap.summary).toBeNull();
    expect(snap.lenses[0].primary).toEqual({ start_ms: 1000, processing_version: 1, shared: false });
  });

  it('근거 발화가 silence면 shared=false', async () => {
    const { meetingId, lensId } = await seedSharedMeeting(db.pool);
    const silent = (await db.pool.query(
      `SELECT id FROM utterance WHERE meeting_id=$1 AND status='silence'`, [meetingId],
    )).rows[0].id;
    await db.pool.query(`UPDATE lens_evidence SET utterance_id=$1 WHERE lens_item_id=$2`, [silent, lensId]);
    const snap = (await readSnapshot(db.pool, meetingId))!;
    expect(snap.lenses[0].primary).toEqual({ start_ms: 6000, processing_version: 1, shared: false });
  });

  it('한 시점의 값만 담는다 — 읽는 도중 커밋된 이름·메모 변경은 보이지 않는다', async () => {
    const { meetingId, speakerId } = await seedSharedMeeting(db.pool);
    const snap = (await readSnapshot(db.pool, meetingId, {
      afterFirstRead: async () => {
        await db.pool.query(`UPDATE speaker SET name='바뀐 이름' WHERE id=$1`, [speakerId]);
        await db.pool.query(`UPDATE meeting_note SET body_md='바뀐 메모' WHERE meeting_id=$1`, [meetingId]);
      },
    }))!;
    expect(snap.utterances[0].speaker_name).toBe('김담화');
    expect(snap.lenses[0].assignee_name).toBe('김담화');
    expect(snap.note).toBe('## 메모');
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm --filter damwha-be exec jest test/share-payload.spec.ts test/share-snapshot.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 4: 구현**

`be/src/shares/share-snapshot.ts`:

```ts
import type { Pool } from 'pg';
import type { SummarySegment } from '../summary/summary.types';

export type LensKind = 'action' | 'decision' | 'promise';

/** 공유 한 번에 담을 회의의 한 시점. 내부 id는 화자 식별용 speaker_key 말고는 들고 나가지 않는다. */
export interface MeetingSnapshot {
  meeting: { title: string | null; recorded_at: Date; duration_ms: number | null; processing_version: number };
  /** 현재 processing_version의 요약. 없으면 null. */
  summary: { status: string; topics: string[]; segments: SummarySegment[] } | null;
  lenses: {
    kind: LensKind;
    text: string;
    completion_status: 'open' | 'done';
    due_at: string | null;
    assignee_speaker_id: string | null;
    assignee_name: string | null;
    /**
     * primary 근거 발화. 마이그레이션 013 이후 예전 버전 발화일 수 있다. `shared` = 이 발화가 공유본의 발화 기록에
     * 실제로 들어가는가(현재 버전 · status='ok' · 본문 있음) — 아니면 뷰어가 스크롤할 대상이 없다(Codex 계획 리뷰 #8).
     */
    primary: { start_ms: number; processing_version: number; shared: boolean } | null;
  }[];
  /** 현재 버전, status='ok', 본문 있는 발화. speaker_key = speaker_id ?? diar_label (fe mappers와 같은 식별). */
  utterances: { speaker_key: string; speaker_name: string | null; start_ms: number; end_ms: number; text: string }[];
  note: string | null;
}

/**
 * 공유할 내용을 **한 트랜잭션, 한 시점**에서 읽는다 (spec §2.7 2단계). REPEATABLE READ라 첫 쿼리에서 잡힌
 * 스냅샷을 끝까지 본다 — 읽는 도중 재처리·이름 변경·메모 저장이 커밋돼도 서로 다른 시점의 값이 섞이지 않는다.
 * 암호화·업로드는 이 트랜잭션을 닫은 뒤에 한다(외부 요청 동안 연결을 붙잡지 않는다).
 * `hooks.afterFirstRead`는 테스트가 "읽는 도중의 커밋"을 끼워 넣는 자리다.
 */
export async function readSnapshot(
  pool: Pool,
  meetingId: string,
  hooks: { afterFirstRead?: () => Promise<void> } = {},
): Promise<MeetingSnapshot | null> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const m = (
      await c.query<{ title: string | null; recorded_at: Date; duration_ms: number | null; processing_version: number }>(
        `SELECT title, recorded_at, duration_ms, processing_version FROM meeting WHERE id=$1`,
        [meetingId],
      )
    ).rows[0];
    if (!m) {
      await c.query('COMMIT');
      return null;
    }
    await hooks.afterFirstRead?.();
    const summary =
      (
        await c.query<{ status: string; topics: string[]; segments: SummarySegment[] }>(
          `SELECT status, topics, segments FROM meeting_summary WHERE meeting_id=$1 AND processing_version=$2`,
          [meetingId, m.processing_version],
        )
      ).rows[0] ?? null;
    const lensRows = (
      await c.query(
        `SELECT li.kind, li.text, li.completion_status, to_char(li.due_at, 'YYYY-MM-DD') AS due_at,
                li.assignee_speaker_id, s.name AS assignee_name,
                pu.start_ms AS primary_start_ms, pu.processing_version AS primary_version,
                (pu.processing_version = $2 AND pu.status = 'ok' AND btrim(coalesce(pu.text, '')) <> '') AS primary_shared
           FROM lens_item li
           LEFT JOIN speaker s ON s.id = li.assignee_speaker_id
           LEFT JOIN lens_evidence le ON le.lens_item_id = li.id AND le.relation = 'primary'
           LEFT JOIN utterance pu ON pu.id = le.utterance_id
          WHERE li.meeting_id = $1 AND li.lifecycle_status = 'active'
          ORDER BY li.created_at, li.id`,
        [meetingId, m.processing_version],
      )
    ).rows;
    const utterances = (
      await c.query(
        `SELECT COALESCE(u.speaker_id, u.diar_label) AS speaker_key, s.name AS speaker_name, u.start_ms, u.end_ms, u.text
           FROM utterance u LEFT JOIN speaker s ON s.id = u.speaker_id
          WHERE u.meeting_id=$1 AND u.processing_version=$2 AND u.status='ok' AND btrim(coalesce(u.text,'')) <> ''
          ORDER BY u.order_index`,
        [meetingId, m.processing_version],
      )
    ).rows;
    const note = (await c.query<{ body_md: string }>(`SELECT body_md FROM meeting_note WHERE meeting_id=$1`, [meetingId])).rows[0]?.body_md ?? null;
    await c.query('COMMIT');
    return {
      meeting: m,
      summary,
      lenses: lensRows.map((r) => ({
        kind: r.kind,
        text: r.text,
        completion_status: r.completion_status,
        due_at: r.due_at,
        assignee_speaker_id: r.assignee_speaker_id,
        assignee_name: r.assignee_name,
        primary:
          r.primary_start_ms === null
            ? null
            : { start_ms: r.primary_start_ms, processing_version: r.primary_version, shared: r.primary_shared === true },
      })),
      utterances,
      note,
    };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
```

`be/src/shares/share-payload.ts`:

```ts
import type { UiLanguage } from '@damwha/contracts';
import type { SharePayloadV1, ShareScope, ShareSpeaker } from '@damwha/share-format';
import type { MeetingSnapshot } from './share-snapshot';

export class SummaryNotReadyError extends Error {
  constructor() {
    super('the summary is not ready to share');
    this.name = 'SummaryNotReadyError';
  }
}

/**
 * 스냅샷 → 공유 페이로드 (spec §2.1·§2.2). 허용 목록으로 **새로 만든다** — DB 행을 펼치지 않으므로 표에 없는
 * 필드(내부 id, source, is_me, 근거 인용)는 나갈 길이 없다. 화자 ref는 발화 기록 → 렌즈 담당자 순서로 처음
 * 나온 차례대로 s1, s2…다. 익명화는 이 ref의 이름만 지운다 — 요약·렌즈 문장 속 이름은 그대로다.
 */
export function buildPayload(
  snap: MeetingSnapshot,
  scope: ShareScope,
  opts: { now: Date; uiLanguage: UiLanguage },
): SharePayloadV1 {
  if (scope.summary && snap.summary?.status !== 'done') throw new SummaryNotReadyError();

  const speakers = new Map<string, ShareSpeaker>();
  const refOf = (key: string, name: string | null): string => {
    let sp = speakers.get(key);
    if (!sp) {
      sp = { ref: `s${speakers.size + 1}`, name: scope.anonymize ? null : name };
      speakers.set(key, sp);
    }
    return sp.ref;
  };

  const payload: SharePayloadV1 = {
    v: 1,
    created_at: opts.now.toISOString(),
    ui_language: opts.uiLanguage,
    meeting: {
      title: snap.meeting.title,
      recorded_at: snap.meeting.recorded_at.toISOString(),
      duration_ms: snap.meeting.duration_ms,
    },
    speakers: [],
  };
  if (scope.summary && snap.summary) {
    payload.summary = {
      topics: snap.summary.topics,
      segments: snap.summary.segments.map((s) => ({ title: s.title, bullets: s.bullets, start_ms: s.start_ms, end_ms: s.end_ms })),
    };
  }
  if (scope.transcript) {
    payload.transcript = snap.utterances.map((u) => ({
      speaker_ref: refOf(u.speaker_key, u.speaker_name),
      start_ms: u.start_ms,
      end_ms: u.end_ms,
      text: u.text,
    }));
  }
  if (scope.lenses) {
    payload.lenses = snap.lenses.map((l) => ({
      kind: l.kind,
      text: l.text,
      done: l.completion_status === 'done',
      due_at: l.due_at,
      assignee_ref: l.assignee_speaker_id === null ? null : refOf(l.assignee_speaker_id, l.assignee_name),
      start_ms: l.primary?.start_ms ?? null,
      linkable: l.primary?.shared === true,
    }));
  }
  if (scope.note && snap.note !== null) payload.note = { body_md: snap.note };
  payload.speakers = [...speakers.values()];
  return payload;
}
```

주의: 빌더 테스트의 화자 순서(`s1` 김담화, `s2` 미확정, `s3` 이참석)는 **발화 기록을 렌즈보다 먼저** 처리해야 나온다. 위 코드 순서(요약 → 발화 기록 → 렌즈)를 바꾸지 않는다.

- [ ] **Step 5: 통과 확인**

Run: `pnpm --filter damwha-be exec jest test/share-payload.spec.ts test/share-snapshot.spec.ts`
Expected: PASS

- [ ] **Step 6: 변이 확인**

`readSnapshot`의 `ISOLATION LEVEL REPEATABLE READ READ ONLY`를 지워 `BEGIN`만 남기고 실행 → "한 시점의 값만 담는다"가 FAIL이어야 한다. 되돌린다. 스냅샷 SQL의 `primary_shared` 식에서 `AND pu.status = 'ok'`를 지우고 → "근거 발화가 silence면 shared=false"가 FAIL. 되돌린다.

- [ ] **Step 7: 커밋**

```bash
git add be/src/shares/share-snapshot.ts be/src/shares/share-payload.ts be/test/share-fixtures.ts be/test/share-payload.spec.ts be/test/share-snapshot.spec.ts
git commit -m "feat(be): 공유 스냅샷(REPEATABLE READ)과 허용 목록 페이로드 빌더"
```

---
### Task 10: 공유 저장소·서비스·API

**Files:**
- Create: `be/src/shares/shares.repository.ts`, `be/src/shares/shares.service.ts`, `be/src/shares/shares.controller.ts`, `be/src/shares/share-enabled.guard.ts`, `be/src/shares/shares.module.ts`
- Modify: `be/src/app.module.ts`
- Create: `be/test/shares.e2e-spec.ts`

**Interfaces:**
- Consumes: `ShareClient`, `ShareServiceError`, `ShareTooLargeError`, `shareEnabled` (Task 8), `readSnapshot`, `buildPayload`, `SummaryNotReadyError` (Task 9), `encryptShare`, `generateShareKey`, `ShareScope` (Task 2), `SHARE_CONSENT_VERSION`, `isShareDurationDays`, `UI_LANGUAGES` (contracts)
- Produces (HTTP, fe가 의존한다 — 경로는 `/api` prefix 아래):
  - `GET /meetings/:id/share` → `200 { share: ShareView | null }`
  - `POST /meetings/:id/share/preview` body `{ scope, ui_language, duration_days? }` → `200 { payload: SharePayloadV1; expires_at_estimate: string }` (예상 만료 = 지금 + 기간 — 미리보기·동의 문구용, 실제 값은 서버가 정한다)
  - `POST /meetings/:id/share` body `{ scope, duration_days, consent_version, transcript_ack?, ui_language }` → `201 { share: ShareView }` — 기존 active가 있으면 업로드 요청이 서버에서 그것을 지운다(교체)
  - `DELETE /meetings/:id/share` → `200 { share }`(철회됨) | `202 { share }`(대기) | `404 {code:'NO_ACTIVE_SHARE'}`
  - `GET /shares` → `200 { shares: ListedShare[] }`
  - 오류 code: `BAD_REQUEST`, `EMPTY_SCOPE`, `CONSENT_REQUIRED`, `SUMMARY_NOT_READY`(400), `SHARE_IN_PROGRESS`(409), `MEETING_DELETED`(410), `SHARE_TOO_LARGE`(413), `SHARE_SERVICE_BUSY`(503·429), `SHARE_SERVICE_UNREACHABLE`·`SHARE_SERVICE_REJECTED`(502)
  - `type ShareView = { id: string; meeting_id: string | null; status: ShareStatus; url: string | null; expires_at: string | null; scope: ShareScope; duration_days: number; created_at: string }`, `type ListedShare = ShareView & { meeting_title: string | null }`
  - `SharesService.revokeRows(rows: ShareRow[]): Promise<{ share_revoke: 'none' | 'revoked' | 'pending'; share_expires_at: string | null }>`, `SharesService.sweep(): Promise<void>` (Task 11)
  - `SharesRepository.markActiveRevokePending(exec, meetingId): Promise<ShareRow[]>` (Task 11)
  - DI 토큰 `SHARE_ENABLED: symbol` (boolean 값)

- [ ] **Step 1: 실패하는 테스트**

`be/test/shares.e2e-spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { decryptShare } from '@damwha/share-format';

import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { SHARE_ENABLED } from '../src/shares/share-enabled.guard';
import { startTestDb, StartedTestDb } from './db';
import { startFakeShareServer, FakeShareServer } from './fake-share-server';
import { seedSharedMeeting } from './share-fixtures';

const CAPS = { platform: 'darwin', arch: 'arm64', chip: 'test', memory_gb: 32, gpu_eligible: true, recommended_preset: 'standard' };
const SCOPE = { summary: true, lenses: true, transcript: false, note: false, anonymize: false };
const body = (over: Record<string, unknown> = {}) => ({ scope: SCOPE, duration_days: 7, consent_version: 1, ui_language: 'ko', ...over });

async function makeApp(enabled?: boolean) {
  let b = Test.createTestingModule({ imports: [AppModule] }).overrideProvider(CAPABILITIES).useValue(CAPS);
  if (enabled !== undefined) b = b.overrideProvider(SHARE_ENABLED).useValue(enabled);
  const app = (await b.compile()).createNestApplication<NestExpressApplication>();
  app.useBodyParser('json', { limit: '1mb' });
  await app.init();
  return app;
}

/** 비동기로 도는 철회를 기다린다. */
async function until(check: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
}

describe('공유 API', () => {
  let db: StartedTestDb;
  let fake: FakeShareServer;
  let app: NestExpressApplication;

  beforeAll(async () => {
    db = await startTestDb();
    fake = await startFakeShareServer();
    process.env.SHARE_API_URL = fake.url;
    app = await makeApp();
  });
  afterEach(async () => {
    await db.reset();
    fake.objects.clear();
    fake.requests.length = 0;
    fake.mode = 'ok';
    fake.delayMs = 0;
  });
  afterAll(async () => {
    await app?.close();
    await fake?.close();
    await db?.stop();
    delete process.env.SHARE_API_URL;
  });

  const srv = () => app.getHttpServer();
  const rows = async () => (await db.pool.query(`SELECT * FROM meeting_share ORDER BY id`)).rows;

  describe('미리보기', () => {
    it('업로드도 저장도 하지 않고 페이로드를 돌려준다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      const res = await request(srv()).post(`/meetings/${meetingId}/share/preview`).send({ scope: SCOPE, ui_language: 'ko' }).expect(200);
      expect(res.body.payload).toMatchObject({ v: 1, meeting: { title: '주간 회의' }, summary: { topics: ['배포'] } });
      expect(res.body.payload).not.toHaveProperty('transcript');
      expect(res.body.payload).not.toHaveProperty('expires_at');
      expect(Date.parse(res.body.expires_at_estimate) - Date.now()).toBeGreaterThan(7 * 86_400_000 - 60_000);
      expect(fake.requests).toHaveLength(0);
      expect(await rows()).toEqual([]);
    });
  });

  describe('만들기', () => {
    it('업로드한 봉투를 링크의 키로 풀면 고른 범위가 나온다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      const res = await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201);
      const { share } = res.body;
      expect(share).toMatchObject({ meeting_id: meetingId, status: 'active', duration_days: 7, scope: SCOPE });
      const m = String(share.url).match(/^(http:\/\/127\.0\.0\.1:\d+)\/s\/([^#]+)#(.+)$/)!;
      expect(m[1]).toBe(fake.url);
      const payload = await decryptShare(new Uint8Array(fake.objects.get(m[2])!.body), m[3]);
      expect(payload.summary?.topics).toEqual(['배포']);
      expect(payload.lenses).toHaveLength(1);
      expect(payload.transcript).toBeUndefined();
      expect(share.expires_at).toBe(fake.objects.get(m[2])!.expires_at); // 서버가 정한 만료 시각을 그대로 쓴다
    });

    it.each([
      ['동의 버전이 다름', body({ consent_version: 0 }), 'CONSENT_REQUIRED'],
      ['발화 기록인데 책임 확인 없음', body({ scope: { ...SCOPE, transcript: true } }), 'CONSENT_REQUIRED'],
      ['내용을 하나도 안 고름', body({ scope: { ...SCOPE, summary: false, lenses: false } }), 'EMPTY_SCOPE'],
      ['기간이 목록 밖', body({ duration_days: 3 }), 'BAD_REQUEST'],
      ['모르는 키', body({ audio: true }), 'BAD_REQUEST'],
    ])('%s → 400 %s', async (_name, b, code) => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      const res = await request(srv()).post(`/meetings/${meetingId}/share`).send(b).expect(400);
      expect(res.body.code).toBe(code);
      expect(fake.requests).toHaveLength(0);
      expect(await rows()).toEqual([]);
    });

    it('발화 기록 + 책임 확인이면 된다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      await request(srv()).post(`/meetings/${meetingId}/share`).send(body({ scope: { ...SCOPE, transcript: true }, transcript_ack: true })).expect(201);
    });

    it('요약이 done이 아닌데 요약을 고르면 400 SUMMARY_NOT_READY', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      await db.pool.query(`UPDATE meeting_summary SET status='failed' WHERE meeting_id=$1`, [meetingId]);
      const res = await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(400);
      expect(res.body.code).toBe('SUMMARY_NOT_READY');
      expect(await rows()).toEqual([]);
    });

    it('없는 회의는 404', async () => {
      await request(srv()).post(`/meetings/mtg_999/share`).send(body()).expect(404);
      await request(srv()).post(`/meetings/not-an-id/share`).send(body()).expect(404);
    });

    it('새 링크를 만들면 응답 시점에 기존 링크는 이미 서버에 없고 행은 revoked다 (교체)', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201);
      const firstRow = (await rows())[0];
      const second = (await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201)).body.share;
      // 기다리지 않는다 — 교체는 업로드 요청 안에서 끝났다
      expect(fake.objects.has(firstRow.remote_id)).toBe(false);
      expect(fake.objects.size).toBe(1);
      const upload = fake.requests.filter((r) => r.method === 'POST')[1];
      expect(upload.headers['x-replace-id']).toBe(firstRow.remote_id);
      expect(upload.headers['x-replace-token']).toBe(firstRow.delete_token);
      const r = await rows();
      expect(r.find((x) => x.id === firstRow.id)).toMatchObject({ status: 'revoked', share_key: null, delete_token: null });
      expect(r.find((x) => x.id === second.id)?.status).toBe('active');
    });

    it('서버가 교체 토큰을 거절하면 새 링크도 없고 기존 링크는 그대로다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      const first = (await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201)).body.share;
      await db.pool.query(`UPDATE meeting_share SET delete_token='tampered' WHERE id=$1`, [first.id]);
      const res = await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(502);
      expect(res.body.code).toBe('SHARE_SERVICE_REJECTED');
      expect((await rows()).map((x) => [x.id, x.status])).toEqual([[first.id, 'active']]);
      expect(fake.objects.size).toBe(1);
    });

    it('업로드가 실패하면 기존 링크는 그대로이고 creating 행도 남지 않는다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      const first = (await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201)).body.share;
      fake.mode = 'drop';
      const res = await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(502);
      expect(res.body.code).toBe('SHARE_SERVICE_UNREACHABLE');
      const r = await rows();
      expect(r.map((x) => [x.id, x.status])).toEqual([[first.id, 'active']]);
    });

    it('공유 서비스가 바쁘면 503 SHARE_SERVICE_BUSY', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      fake.mode = 'busy503';
      expect((await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(503)).body.code).toBe('SHARE_SERVICE_BUSY');
    });

    it('동시에 두 번 누르면 하나는 409 SHARE_IN_PROGRESS이고 링크는 하나다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      fake.delayMs = 300;
      const [a, b] = await Promise.all([
        request(srv()).post(`/meetings/${meetingId}/share`).send(body()).then((r) => r),
        request(srv()).post(`/meetings/${meetingId}/share`).send(body()).then((r) => r),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect([a, b].find((r) => r.status === 409)!.body.code).toBe('SHARE_IN_PROGRESS');
      expect(fake.objects.size).toBe(1);
      expect((await rows()).map((x) => x.status)).toEqual(['active']);
    });

    it('업로드하는 사이 회의가 지워지면 410이고 올라간 객체는 철회된다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      fake.delayMs = 300;
      const uploading = fake.nextUpload();
      // supertest는 then/await 전까지 요청을 보내지 않는다 — .then으로 지금 시작시킨다
      const pending = request(srv()).post(`/meetings/${meetingId}/share`).send(body()).then((r) => r);
      await uploading; // 업로드 요청이 공유 서버에 도착했다 = 스냅샷은 끝났고 확정 전이다
      await db.pool.query(`DELETE FROM meeting WHERE id=$1`, [meetingId]);
      const res = await pending;
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('MEETING_DELETED');
      fake.delayMs = 0;
      await until(async () => (await rows())[0]?.status === 'revoked');
      expect(fake.objects.size).toBe(0);
    });

    it('압축·암호화 뒤에도 5MB를 넘으면 413이고 업로드하지 않는다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      // md5 16진수는 gzip으로 절반쯤만 준다 — 10,000행 × 1,280자 ≈ 12.8MB → 봉투 ≈ 6.5MB
      await db.pool.query(
        `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,order_index,processing_version)
         SELECT $1,'SPEAKER_00',g*1000,g*1000+900,
                (SELECT string_agg(md5(random()::text || g::text || i::text), '') FROM generate_series(1,40) i),
                g+10, 1
           FROM generate_series(1,10000) g`,
        [meetingId],
      );
      const res = await request(srv())
        .post(`/meetings/${meetingId}/share`)
        .send(body({ scope: { ...SCOPE, transcript: true }, transcript_ack: true }))
        .expect(413);
      expect(res.body.code).toBe('SHARE_TOO_LARGE');
      expect(fake.requests).toHaveLength(0);
      expect(await rows()).toEqual([]);
    });
  });

  describe('조회·중지·목록', () => {
    it('조회 — 활성 공유, 없으면 null', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      expect((await request(srv()).get(`/meetings/${meetingId}/share`).expect(200)).body).toEqual({ share: null });
      await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201);
      expect((await request(srv()).get(`/meetings/${meetingId}/share`).expect(200)).body.share.status).toBe('active');
    });

    it('조회 — 만료가 지난 공유는 보이지 않지만 GET은 행을 바꾸지 않는다(정리는 스위퍼)', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      const { share } = (await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201)).body;
      await db.pool.query(`UPDATE meeting_share SET expires_at = now() - interval '1 minute' WHERE id=$1`, [share.id]);
      const before = (await rows())[0];
      expect((await request(srv()).get(`/meetings/${meetingId}/share`).expect(200)).body).toEqual({ share: null });
      expect((await request(srv()).get('/shares').expect(200)).body).toEqual({ shares: [] });
      expect((await rows())[0]).toEqual(before);
    });

    it('중지 — 온라인이면 200 revoked, 서버 객체도 사라진다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201);
      const res = await request(srv()).delete(`/meetings/${meetingId}/share`).expect(200);
      expect(res.body.share).toMatchObject({ status: 'revoked', url: null });
      expect(fake.objects.size).toBe(0);
    });

    it('중지 — 오프라인이면 202 revoke_pending, 키는 지우고 삭제 토큰은 남긴다', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201);
      fake.mode = 'drop';
      const res = await request(srv()).delete(`/meetings/${meetingId}/share`).expect(202);
      expect(res.body.share).toMatchObject({ status: 'revoke_pending', url: null });
      const r = (await rows())[0];
      expect(r.share_key).toBeNull();
      expect(r.delete_token).not.toBeNull();
      expect(r.revoke_attempts).toBe(1);
    });

    it('중지할 공유가 없으면 404 NO_ACTIVE_SHARE', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      expect((await request(srv()).delete(`/meetings/${meetingId}/share`).expect(404)).body.code).toBe('NO_ACTIVE_SHARE');
    });

    it('목록 — active와 revoke_pending만, 회의 제목과 함께', async () => {
      const { meetingId } = await seedSharedMeeting(db.pool);
      await request(srv()).post(`/meetings/${meetingId}/share`).send(body()).expect(201);
      const { shares } = (await request(srv()).get('/shares').expect(200)).body;
      expect(shares).toHaveLength(1);
      expect(shares[0]).toMatchObject({ meeting_title: '주간 회의', status: 'active' });
      expect(shares[0].url).toMatch(/\/s\/7-/);
    });
  });
});

describe('공유가 꺼진 실행 (Docker·데모)', () => {
  let db: StartedTestDb;
  let app: NestExpressApplication;
  beforeAll(async () => { db = await startTestDb(); app = await makeApp(false); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  it('공유 라우트 전부 404', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    const srv = app.getHttpServer();
    await request(srv).get(`/meetings/${meetingId}/share`).expect(404);
    await request(srv).post(`/meetings/${meetingId}/share`).send(body()).expect(404);
    await request(srv).post(`/meetings/${meetingId}/share/preview`).send({ scope: SCOPE, ui_language: 'ko' }).expect(404);
    await request(srv).delete(`/meetings/${meetingId}/share`).expect(404);
    await request(srv).get('/shares').expect(404);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-be exec jest test/shares.e2e-spec.ts`
Expected: FAIL — `../src/shares/share-enabled.guard` 없음.

- [ ] **Step 3: 구현 — 가드와 저장소**

`be/src/shares/share-enabled.guard.ts`:

```ts
import { CanActivate, Inject, Injectable, NotFoundException } from '@nestjs/common';

/** 공유 활성 여부 (shareEnabled(loadEnv())). 기동 시 한 번 정한다 — 테스트는 이 토큰을 덮어쓴다. */
export const SHARE_ENABLED = Symbol('SHARE_ENABLED');

/** 공유가 꺼진 실행(Docker·데모)에서는 라우트가 없는 것처럼 404다 — fe는 404를 보고 공유 UI를 숨긴다. */
@Injectable()
export class ShareEnabledGuard implements CanActivate {
  constructor(@Inject(SHARE_ENABLED) private readonly enabled: boolean) {}
  canActivate(): boolean {
    if (!this.enabled) throw new NotFoundException();
    return true;
  }
}
```

`be/src/shares/shares.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { ShareScope } from '@damwha/share-format';

type Exec = Pool | PoolClient;

export type ShareStatus = 'creating' | 'active' | 'revoke_pending' | 'revoked' | 'expired';

export interface ShareRow {
  id: string;
  meeting_id: string | null;
  status: ShareStatus;
  remote_id: string | null;
  share_key: string | null;
  delete_token: string | null;
  scope: ShareScope;
  duration_days: number;
  expires_at: Date | null;
  consent_version: number;
  consented_at: Date;
  created_at: Date;
  revoke_attempted_at: Date | null;
  revoke_attempts: number;
  revoke_error: unknown;
}

export interface ListedShareRow extends ShareRow {
  meeting_title: string | null;
}

export class ShareInProgressError extends Error {
  constructor() {
    super('a share for this meeting is already being created');
    this.name = 'ShareInProgressError';
  }
}

@Injectable()
export class SharesRepository {
  /** 회의 행을 잠근다. 없으면 false — 그사이 지워진 것이다. */
  async lockMeeting(exec: Exec, meetingId: string): Promise<boolean> {
    return (await exec.query('SELECT 1 FROM meeting WHERE id=$1 FOR UPDATE', [meetingId])).rowCount === 1;
  }

  async insertCreating(
    exec: Exec,
    a: { meetingId: string; scope: ShareScope; durationDays: number; consentVersion: number },
  ): Promise<string> {
    try {
      const { rows } = await exec.query<{ id: string }>(
        `INSERT INTO meeting_share(meeting_id,status,scope,duration_days,consent_version,consented_at)
         VALUES($1,'creating',$2::jsonb,$3,$4,now()) RETURNING id`,
        [a.meetingId, JSON.stringify(a.scope), a.durationDays, a.consentVersion],
      );
      return rows[0].id;
    } catch (e) {
      const pg = e as { code?: string; constraint?: string };
      if (pg.code === '23505' && pg.constraint === 'meeting_share_one_creating_idx') throw new ShareInProgressError();
      throw e;
    }
  }

  async findById(exec: Exec, id: string): Promise<ShareRow | null> {
    return (await exec.query<ShareRow>('SELECT * FROM meeting_share WHERE id=$1', [id])).rows[0] ?? null;
  }

  /** 회의 화면이 보여 줄 공유: active가 있으면 그것, 없으면 가장 최근 revoke_pending. 만료가 지난 행은 걸러낸다(바꾸지 않는다). */
  async findCurrent(exec: Exec, meetingId: string): Promise<ShareRow | null> {
    const { rows } = await exec.query<ShareRow>(
      `SELECT * FROM meeting_share WHERE meeting_id=$1 AND status IN ('active','revoke_pending')
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY (status='active') DESC, created_at DESC, id DESC LIMIT 1`,
      [meetingId],
    );
    return rows[0] ?? null;
  }

  async findActive(exec: Exec, meetingId: string): Promise<ShareRow | null> {
    return (await exec.query<ShareRow>(`SELECT * FROM meeting_share WHERE meeting_id=$1 AND status='active'`, [meetingId])).rows[0] ?? null;
  }

  async activate(exec: Exec, id: string, a: { remoteId: string; key: string; deleteToken: string; expiresAt: string }): Promise<void> {
    await exec.query(
      `UPDATE meeting_share SET status='active', remote_id=$2, share_key=$3, delete_token=$4, expires_at=$5
        WHERE id=$1 AND status='creating'`,
      [id, a.remoteId, a.key, a.deleteToken, a.expiresAt],
    );
  }

  /** 업로드는 됐는데 회의가 사라진 경우 — 링크는 내보낸 적 없으니 키 없이 바로 철회 대기열로. */
  async attachRevokePending(exec: Exec, id: string, a: { remoteId: string; deleteToken: string; expiresAt: string }): Promise<ShareRow> {
    const { rows } = await exec.query<ShareRow>(
      `UPDATE meeting_share SET status='revoke_pending', remote_id=$2, delete_token=$3, expires_at=$4, share_key=NULL
        WHERE id=$1 RETURNING *`,
      [id, a.remoteId, a.deleteToken, a.expiresAt],
    );
    return rows[0];
  }

  /** 회의의 active를 철회 대기로. 키는 지금 지운다(링크가 죽었다), 삭제 토큰은 철회가 끝날 때까지 남긴다. */
  async markActiveRevokePending(exec: Exec, meetingId: string): Promise<ShareRow[]> {
    const { rows } = await exec.query<ShareRow>(
      `UPDATE meeting_share SET status='revoke_pending', share_key=NULL
        WHERE meeting_id=$1 AND status='active' RETURNING *`,
      [meetingId],
    );
    return rows;
  }

  async deleteIfCreating(exec: Exec, id: string): Promise<void> {
    await exec.query(`DELETE FROM meeting_share WHERE id=$1 AND status='creating'`, [id]);
  }

  async markRevoked(exec: Exec, id: string): Promise<ShareRow> {
    const { rows } = await exec.query<ShareRow>(
      `UPDATE meeting_share SET status='revoked', share_key=NULL, delete_token=NULL, revoke_error=NULL,
              revoke_attempted_at=now()
        WHERE id=$1 RETURNING *`,
      [id],
    );
    return rows[0];
  }

  async recordRevokeFailure(exec: Exec, id: string, error: { kind: string; status: number | null }): Promise<ShareRow> {
    const { rows } = await exec.query<ShareRow>(
      `UPDATE meeting_share SET revoke_attempted_at=now(), revoke_attempts=revoke_attempts+1, revoke_error=$2::jsonb
        WHERE id=$1 RETURNING *`,
      [id, JSON.stringify(error)],
    );
    return rows[0];
  }

  /** 다시 시도할 때가 된 철회. 간격은 5분에서 두 배씩, 최대 1시간 (spec §2.7 재시도). */
  async listRevokeDue(exec: Exec): Promise<ShareRow[]> {
    const { rows } = await exec.query<ShareRow>(
      `SELECT * FROM meeting_share
        WHERE status='revoke_pending'
          AND (revoke_attempted_at IS NULL
               OR revoke_attempted_at + LEAST(interval '5 minutes' * power(2, GREATEST(revoke_attempts-1, 0)), interval '1 hour') <= now())
        ORDER BY created_at, id`,
    );
    return rows;
  }

  /** 만료된 active·revoke_pending → expired. **스위퍼만 부른다**(GET은 상태를 바꾸지 않는다). 물리 삭제는 공유 서버의 스위퍼 몫. */
  async expireDue(exec: Exec): Promise<number> {
    const { rowCount } = await exec.query(
      `UPDATE meeting_share SET status='expired', share_key=NULL, delete_token=NULL
        WHERE status IN ('active','revoke_pending') AND expires_at <= now()`,
    );
    return rowCount ?? 0;
  }

  /** 확정 전에 프로세스가 죽어 남은 creating. 서버 객체가 남았어도 토큰을 모르니 만료를 기다린다 (spec §2.7 고아 정리). */
  async deleteStaleCreating(exec: Exec): Promise<number> {
    const { rowCount } = await exec.query(
      `DELETE FROM meeting_share WHERE status='creating' AND created_at < now() - interval '10 minutes'`,
    );
    return rowCount ?? 0;
  }

  async listVisible(exec: Exec): Promise<ListedShareRow[]> {
    const { rows } = await exec.query<ListedShareRow>(
      `SELECT ms.*, m.title AS meeting_title FROM meeting_share ms LEFT JOIN meeting m ON m.id = ms.meeting_id
        WHERE ms.status IN ('active','revoke_pending') AND (ms.expires_at IS NULL OR ms.expires_at > now())
        ORDER BY ms.created_at DESC, ms.id DESC`,
    );
    return rows;
  }
}
```

- [ ] **Step 4: 구현 — 서비스**

`be/src/shares/shares.service.ts`:

```ts
import {
  BadRequestException, ConflictException, GoneException, HttpException, Injectable, Logger, NotFoundException,
  PayloadTooLargeException, ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { SHARE_CONSENT_VERSION, UI_LANGUAGES, isShareDurationDays, type ShareDurationDays } from '@damwha/contracts';
import { encryptShare, generateShareKey, type ShareScope } from '@damwha/share-format';
import { DatabaseService } from '../database/database.service';
import { ShareClient, ShareServiceError, ShareTooLargeError } from './share-client';
import { buildPayload, SummaryNotReadyError } from './share-payload';
import { readSnapshot } from './share-snapshot';
import { ShareInProgressError, SharesRepository, type ListedShareRow, type ShareRow, type ShareStatus } from './shares.repository';

const MEETING_ID_RE = /^mtg_[1-9][0-9]*$/;
const DAY_MS = 86_400_000;

const ScopeSchema = z.object({
  summary: z.boolean(), lenses: z.boolean(), transcript: z.boolean(), note: z.boolean(), anonymize: z.boolean(),
}).strict();
const PreviewSchema = z.object({
  scope: ScopeSchema,
  ui_language: z.enum(UI_LANGUAGES),
  duration_days: z.number().refine(isShareDurationDays).optional(),
}).strict();
const CreateSchema = z.object({
  scope: ScopeSchema,
  ui_language: z.enum(UI_LANGUAGES),
  duration_days: z.number().refine(isShareDurationDays),
  consent_version: z.number().int(),
  transcript_ack: z.boolean().optional(),
}).strict();

export type ShareView = {
  id: string;
  meeting_id: string | null;
  status: ShareStatus;
  url: string | null;
  expires_at: string | null;
  scope: ShareScope;
  duration_days: number;
  created_at: string;
};
export type ListedShare = ShareView & { meeting_title: string | null };
export type RevokeSummary = { share_revoke: 'none' | 'revoked' | 'pending'; share_expires_at: string | null };

const bad = (code: string, message: string) => new BadRequestException({ statusCode: 400, code, message });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw bad('BAD_REQUEST', r.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '));
  return r.data;
}

/** 내부 오류 → HTTP. 화면은 code로 문구를 고른다. */
function toHttp(e: unknown): unknown {
  if (e instanceof ShareInProgressError) return new ConflictException({ statusCode: 409, code: 'SHARE_IN_PROGRESS', message: e.message });
  if (e instanceof SummaryNotReadyError) return bad('SUMMARY_NOT_READY', e.message);
  if (e instanceof ShareTooLargeError) return new PayloadTooLargeException({ statusCode: 413, code: 'SHARE_TOO_LARGE', message: e.message });
  if (e instanceof ShareServiceError) {
    if (e.kind === 'unreachable') {
      return new HttpException({ statusCode: 502, code: 'SHARE_SERVICE_UNREACHABLE', message: 'the share service is unreachable' }, 502);
    }
    if (e.status === 413) return new PayloadTooLargeException({ statusCode: 413, code: 'SHARE_TOO_LARGE', message: 'the share service refused the size' });
    if (e.status === 503 || e.status === 429) {
      return new ServiceUnavailableException({ statusCode: 503, code: 'SHARE_SERVICE_BUSY', message: 'the share service is not accepting uploads right now' });
    }
    return new HttpException({ statusCode: 502, code: 'SHARE_SERVICE_REJECTED', message: `the share service answered ${e.status}` }, 502);
  }
  return e;
}

@Injectable()
export class SharesService {
  private readonly logger = new Logger(SharesService.name);
  private retrying: Promise<void> | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly repo: SharesRepository,
    private readonly client: ShareClient,
  ) {}

  toView(row: ShareRow): ShareView {
    return {
      id: row.id,
      meeting_id: row.meeting_id,
      status: row.status,
      url: row.status === 'active' && row.remote_id && row.share_key ? this.client.linkFor(row.remote_id, row.share_key) : null,
      expires_at: row.expires_at ? row.expires_at.toISOString() : null,
      scope: row.scope,
      duration_days: row.duration_days,
      created_at: row.created_at.toISOString(),
    };
  }

  private assertMeetingId(meetingId: string) {
    if (!MEETING_ID_RE.test(meetingId)) throw new NotFoundException('meeting not found');
  }

  async preview(meetingId: string, body: unknown) {
    this.assertMeetingId(meetingId);
    const req = parse(PreviewSchema, body);
    const snap = await readSnapshot(this.db.pool, meetingId);
    if (!snap) throw new NotFoundException('meeting not found');
    const now = new Date();
    const days: ShareDurationDays = req.duration_days ?? 7;
    try {
      return {
        payload: buildPayload(snap, req.scope, { now, uiLanguage: req.ui_language }),
        expires_at_estimate: new Date(now.getTime() + days * DAY_MS).toISOString(),
      };
    } catch (e) {
      throw toHttp(e);
    }
  }

  async create(meetingId: string, body: unknown): Promise<{ share: ShareView }> {
    this.assertMeetingId(meetingId);
    const req = parse(CreateSchema, body);
    const { scope } = req;
    if (!scope.summary && !scope.lenses && !scope.transcript && !scope.note) {
      throw bad('EMPTY_SCOPE', 'choose at least one of summary, lenses, transcript, note');
    }
    if (req.consent_version !== SHARE_CONSENT_VERSION || (scope.transcript && req.transcript_ack !== true)) {
      throw bad('CONSENT_REQUIRED', 'the current consent (and the transcript acknowledgement) is required');
    }

    // 1. 예약 — 같은 회의의 creating은 하나뿐이다(유니크 인덱스). 두 번째 요청은 409.
    let shareId: string;
    try {
      shareId = await this.db.withTransaction(async (c) => {
        if (!(await this.repo.lockMeeting(c, meetingId))) throw new NotFoundException('meeting not found');
        return this.repo.insertCreating(c, { meetingId, scope, durationDays: req.duration_days, consentVersion: req.consent_version });
      });
    } catch (e) {
      throw toHttp(e);
    }

    try {
      // 2. 스냅샷 — 한 시점. 3. 암호화·업로드 — 트랜잭션 밖.
      const snap = await readSnapshot(this.db.pool, meetingId);
      if (!snap) throw new GoneException({ statusCode: 410, code: 'MEETING_DELETED', message: 'the meeting was deleted' });
      const key = generateShareKey();
      const payload = buildPayload(snap, scope, { now: new Date(), uiLanguage: req.ui_language });
      // 교체 — 기존 active의 원격 id·삭제 토큰을 업로드 요청에 싣는다. 서버가 같은 요청에서 지우므로 응답이 오면
      // 기존 링크는 이미 막혀 있다(spec selfhost §2.4). 토큰이 틀리면 서버는 아무것도 만들지 않는다(403).
      const current = await this.repo.findActive(this.db.pool, meetingId);
      const replace = current?.remote_id && current.delete_token ? { id: current.remote_id, token: current.delete_token } : undefined;
      const up = await this.client.upload(await encryptShare(payload, key), req.duration_days, replace);

      // 4. 확정 — 기존 active를 먼저 내려야 active 유니크 인덱스와 부딪히지 않는다.
      const outcome = await this.db.withTransaction(async (c) => {
        if (!(await this.repo.lockMeeting(c, meetingId))) {
          const orphan = await this.repo.attachRevokePending(c, shareId, { remoteId: up.id, deleteToken: up.delete_token, expiresAt: up.expires_at });
          return { gone: true as const, toRevoke: [orphan] };
        }
        const old = await this.repo.markActiveRevokePending(c, meetingId);
        // 서버가 교체로 지운 행은 바로 revoked. 서버가 몰랐던 행(다른 주소 등)만 철회 대기열에 남긴다.
        const toRevoke: ShareRow[] = [];
        for (const row of old) {
          if (up.replaced && row.remote_id === replace?.id) await this.repo.markRevoked(c, row.id);
          else toRevoke.push(row);
        }
        await this.repo.activate(c, shareId, { remoteId: up.id, key, deleteToken: up.delete_token, expiresAt: up.expires_at });
        return { gone: false as const, toRevoke };
      });
      // 5. 남은 철회는 응답을 기다리지 않는다(보통 비어 있다).
      void this.revokeRows(outcome.toRevoke);
      if (outcome.gone) throw new GoneException({ statusCode: 410, code: 'MEETING_DELETED', message: 'the meeting was deleted while sharing' });
      return { share: this.toView((await this.repo.findById(this.db.pool, shareId))!) };
    } catch (e) {
      await this.repo.deleteIfCreating(this.db.pool, shareId).catch(() => undefined);
      throw toHttp(e);
    }
  }

  async get(meetingId: string): Promise<{ share: ShareView | null }> {
    this.assertMeetingId(meetingId);
    const row = await this.repo.findCurrent(this.db.pool, meetingId);
    return { share: row ? this.toView(row) : null };
  }

  async stop(meetingId: string): Promise<{ share: ShareView; pending: boolean }> {
    this.assertMeetingId(meetingId);
    const rows = await this.db.withTransaction((c) => this.repo.markActiveRevokePending(c, meetingId));
    if (rows.length === 0) throw new NotFoundException({ statusCode: 404, code: 'NO_ACTIVE_SHARE', message: 'no active share for this meeting' });
    const row = await this.tryRevoke(rows[0]);
    return { share: this.toView(row), pending: row.status === 'revoke_pending' };
  }

  async list(): Promise<{ shares: ListedShare[] }> {
    const rows = await this.repo.listVisible(this.db.pool);
    return { shares: rows.map((r: ListedShareRow) => ({ ...this.toView(r), meeting_title: r.meeting_title })) };
  }

  /** 철회를 한 번씩 시도한다. 회의 삭제(Task 11)가 결과를 화면에 알리려고 기다린다. */
  async revokeRows(rows: ShareRow[]): Promise<RevokeSummary> {
    if (rows.length === 0) return { share_revoke: 'none', share_expires_at: null };
    const after = await Promise.all(rows.map((r) => this.tryRevoke(r)));
    const pending = after.filter((r) => r.status === 'revoke_pending');
    if (pending.length === 0) return { share_revoke: 'revoked', share_expires_at: null };
    const latest = pending.map((r) => r.expires_at?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
    return { share_revoke: 'pending', share_expires_at: latest ? new Date(latest).toISOString() : null };
  }

  /** 만료 정리 → 오래된 creating 정리 → 때가 된 철회 재시도 (Task 11의 스위퍼가 부른다). */
  async sweep(): Promise<void> {
    try {
      await this.repo.expireDue(this.db.pool);
      await this.repo.deleteStaleCreating(this.db.pool);
    } catch (e) {
      this.logger.warn(`share sweep cleanup failed: ${(e as Error).message}`);
    }
    await this.retryPending();
  }

  /** 겹쳐 부르면 진행 중인 한 번을 같이 기다린다. */
  retryPending(): Promise<void> {
    this.retrying ??= (async () => {
      try {
        for (const row of await this.repo.listRevokeDue(this.db.pool)) await this.tryRevoke(row);
      } catch (e) {
        this.logger.warn(`share revoke retry failed: ${(e as Error).message}`);
      }
    })().finally(() => {
      this.retrying = null;
    });
    return this.retrying;
  }

  private async tryRevoke(row: ShareRow): Promise<ShareRow> {
    if (!row.remote_id || !row.delete_token) return this.repo.markRevoked(this.db.pool, row.id);
    try {
      await this.client.remove(row.remote_id, row.delete_token);
      return await this.repo.markRevoked(this.db.pool, row.id);
    } catch (e) {
      const err = e instanceof ShareServiceError ? { kind: e.kind, status: e.status } : { kind: 'unknown', status: null };
      this.logger.warn(`share ${row.id} revoke failed (${err.kind}${err.status ? ` ${err.status}` : ''}) — will retry`);
      return this.repo.recordRevokeFailure(this.db.pool, row.id, err);
    }
  }
}
```

- [ ] **Step 5: 구현 — 컨트롤러·모듈**

`be/src/shares/shares.controller.ts`:

```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ShareEnabledGuard } from './share-enabled.guard';
import { SharesService } from './shares.service';

/** 상태를 바꾸는 동작은 POST·DELETE뿐이다 — no-cors GET은 Origin 없이 와서 접근 제어를 통과한다(선행 결과 규칙 1). */
@ApiTags('shares')
@UseGuards(ShareEnabledGuard)
@Controller('meetings/:id/share')
export class MeetingShareController {
  constructor(private readonly service: SharesService) {}

  @Get()
  @ApiOperation({ summary: '회의의 현재 공유 (active 또는 철회 대기). 없으면 share: null' })
  get(@Param('id') id: string) { return this.service.get(id); }

  @Post('preview')
  @HttpCode(200)
  @ApiOperation({ summary: '공유될 페이로드 미리보기 (업로드·저장 없음)' })
  preview(@Param('id') id: string, @Body() body: unknown) { return this.service.preview(id, body); }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: '공유 링크 만들기 — 기존 링크는 철회된다' })
  create(@Param('id') id: string, @Body() body: unknown) { return this.service.create(id, body); }

  @Delete()
  @ApiOperation({ summary: '공유 중지 — 서버 삭제가 끝나면 200, 오프라인이면 202(대기)' })
  async stop(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.service.stop(id);
    if (r.pending) res.status(202);
    return { share: r.share };
  }
}

@ApiTags('shares')
@UseGuards(ShareEnabledGuard)
@Controller('shares')
export class SharesController {
  constructor(private readonly service: SharesService) {}

  @Get()
  @ApiOperation({ summary: '공유 중이거나 철회 대기 중인 링크 목록' })
  list() { return this.service.list(); }
}
```

`be/src/shares/shares.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { ShareClient } from './share-client';
import { shareEnabled } from './share-enabled';
import { SHARE_ENABLED, ShareEnabledGuard } from './share-enabled.guard';
import { MeetingShareController, SharesController } from './shares.controller';
import { SharesRepository } from './shares.repository';
import { SharesService } from './shares.service';

@Module({
  controllers: [MeetingShareController, SharesController],
  providers: [
    SharesRepository,
    SharesService,
    ShareEnabledGuard,
    { provide: SHARE_ENABLED, useFactory: () => shareEnabled(loadEnv()) },
    { provide: ShareClient, useFactory: () => new ShareClient(loadEnv().SHARE_API_URL) },
  ],
  exports: [SharesRepository, SharesService, SHARE_ENABLED],
})
export class SharesModule {}
```

`be/src/app.module.ts` — import 목록에 `SharesModule`을 더한다(`FoldersModule` 다음).

- [ ] **Step 6: 통과 확인**

Run: `pnpm --filter damwha-be exec jest test/shares.e2e-spec.ts`
Expected: PASS

- [ ] **Step 7: 변이 확인**

1. `create`의 4단계에서 `markActiveRevokePending` 줄을 `activate` **뒤로** 옮긴다 → "새 링크를 만들면…"이 `meeting_share_one_active_idx` 위반으로 FAIL. 되돌린다.
2. 마이그레이션의 `meeting_share_one_creating_idx`를 지우고(테스트 DB는 매번 새로 만든다) → "동시에 두 번 누르면…"이 FAIL. 되돌린다.
3. `create`에서 `upload(…, replace)`의 세 번째 인자를 빼고 실행 → "새 링크를 만들면 응답 시점에…"가 FAIL(서버에 옛 객체가 남는다). 되돌린다.
4. `findCurrent`의 `expires_at > now()` 조건을 지운다 → "조회 — 만료가 지난 공유는 보이지 않지만…"이 FAIL. 되돌린다.

- [ ] **Step 8: 커밋**

```bash
git add be/src/shares be/src/app.module.ts be/test/shares.e2e-spec.ts
git commit -m "feat(be): 공유 API — 예약·스냅샷·업로드·확정, 교체·중지·목록, 꺼진 실행은 404"
```

### Task 11: 스위퍼와 회의 삭제 연동

**Files:**
- Create: `be/src/shares/shares.sweeper.ts`
- Modify: `be/src/shares/shares.module.ts` (provider 추가)
- Modify: `be/src/meetings/meetings.module.ts`, `be/src/meetings/meetings.service.ts`, `be/src/meetings/meetings.controller.ts`
- Modify: `be/test/meetings-management.e2e-spec.ts:115-117`, `be/test/tags.e2e-spec.ts:95`
- Create: `be/test/shares-lifecycle.e2e-spec.ts`

**Interfaces:**
- Consumes: `SharesService.sweep`, `SharesService.revokeRows`, `SharesRepository.markActiveRevokePending`, `SHARE_ENABLED` (Task 10)
- Produces: `DELETE /meetings/:id` → **`200 { share_revoke: 'none' | 'revoked' | 'pending', share_expires_at: string | null }`** (전에는 204, 본문 없음). fe의 삭제 다이얼로그가 `pending`일 때 안내 토스트를 띄운다(Task 15).

- [ ] **Step 1: 실패하는 테스트**

`be/test/shares-lifecycle.e2e-spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { SHARE_ENABLED } from '../src/shares/share-enabled.guard';
import { SharesSweeper } from '../src/shares/shares.sweeper';
import { startTestDb, StartedTestDb } from './db';
import { startFakeShareServer, FakeShareServer } from './fake-share-server';
import { seedSharedMeeting } from './share-fixtures';

const CAPS = { platform: 'darwin', arch: 'arm64', chip: 'test', memory_gb: 32, gpu_eligible: true, recommended_preset: 'standard' };
const BODY = { scope: { summary: true, lenses: false, transcript: false, note: false, anonymize: false }, duration_days: 7, consent_version: 1, ui_language: 'ko' };

describe('공유 수명 주기', () => {
  let db: StartedTestDb;
  let fake: FakeShareServer;
  let app: NestExpressApplication;
  let sweeper: SharesSweeper;

  beforeAll(async () => {
    db = await startTestDb();
    fake = await startFakeShareServer();
    process.env.SHARE_API_URL = fake.url;
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(CAPABILITIES).useValue(CAPS).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    await app.init();
    sweeper = app.get(SharesSweeper);
  });
  afterEach(async () => {
    await db.reset();
    fake.objects.clear();
    fake.requests.length = 0;
    fake.mode = 'ok';
  });
  afterAll(async () => { await app?.close(); await fake?.close(); await db?.stop(); delete process.env.SHARE_API_URL; });

  const srv = () => app.getHttpServer();
  const row = async () => (await db.pool.query(`SELECT * FROM meeting_share ORDER BY id DESC LIMIT 1`)).rows[0];
  const share = async (meetingId: string) => (await request(srv()).post(`/meetings/${meetingId}/share`).send(BODY).expect(201)).body.share;

  it('회의 삭제 — 온라인이면 공유도 철회되고 응답이 revoked', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    await share(meetingId);
    const res = await request(srv()).delete(`/meetings/${meetingId}`).expect(200);
    expect(res.body).toEqual({ share_revoke: 'revoked', share_expires_at: null });
    expect(await row()).toMatchObject({ meeting_id: null, status: 'revoked', delete_token: null });
    expect(fake.objects.size).toBe(0);
  });

  it('회의 삭제 — 오프라인이어도 회의는 지워지고, 응답이 pending과 만료 시각을 준다', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    const s = await share(meetingId);
    fake.mode = 'drop';
    const res = await request(srv()).delete(`/meetings/${meetingId}`).expect(200);
    expect(res.body).toEqual({ share_revoke: 'pending', share_expires_at: s.expires_at });
    expect((await db.pool.query(`SELECT 1 FROM meeting WHERE id=$1`, [meetingId])).rowCount).toBe(0);
    expect(await row()).toMatchObject({ meeting_id: null, status: 'revoke_pending' });
    expect((await row()).delete_token).not.toBeNull();
  });

  it('다시 연결되면 스위퍼가 철회를 끝낸다 (간격이 지난 행만)', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    await share(meetingId);
    fake.mode = 'drop';
    await request(srv()).delete(`/meetings/${meetingId}`).expect(200);
    fake.mode = 'ok';
    fake.requests.length = 0;
    await sweeper.tick();
    expect(fake.requests).toHaveLength(0); // 방금 실패했다 — 5분이 안 됐다
    await db.pool.query(`UPDATE meeting_share SET revoke_attempted_at = now() - interval '6 minutes'`);
    await sweeper.tick();
    expect(await row()).toMatchObject({ status: 'revoked' });
    expect(fake.objects.size).toBe(0);
  });

  it('공유가 없는 회의 삭제는 none', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    expect((await request(srv()).delete(`/meetings/${meetingId}`).expect(200)).body).toEqual({ share_revoke: 'none', share_expires_at: null });
  });

  it('스위퍼 — 만료된 행은 expired, 10분 넘은 creating은 지운다', async () => {
    const { meetingId } = await seedSharedMeeting(db.pool);
    await share(meetingId);
    await db.pool.query(`UPDATE meeting_share SET expires_at = now() - interval '1 second'`);
    const fresh = (await db.pool.query(
      `INSERT INTO meeting_share(meeting_id,status,scope,duration_days,consent_version,consented_at) VALUES($1,'creating','{}',7,1,now()) RETURNING id`, [meetingId],
    )).rows[0].id;
    await db.pool.query(
      `INSERT INTO meeting_share(meeting_id,status,scope,duration_days,consent_version,consented_at,created_at) VALUES(NULL,'creating','{}',7,1,now(), now() - interval '11 minutes')`,
    );
    await sweeper.tick();
    const statuses = (await db.pool.query(`SELECT id, status, share_key FROM meeting_share ORDER BY id`)).rows;
    expect(statuses.map((r) => r.status)).toEqual(['expired', 'creating']);
    expect(statuses[1].id).toBe(fresh);
    expect(statuses[0].share_key).toBeNull();
  });
});

describe('공유가 꺼진 실행의 스위퍼', () => {
  let db: StartedTestDb;
  let fake: FakeShareServer;
  let app: NestExpressApplication;
  beforeAll(async () => {
    db = await startTestDb();
    fake = await startFakeShareServer();
    process.env.SHARE_API_URL = fake.url;
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CAPABILITIES).useValue(CAPS)
      .overrideProvider(SHARE_ENABLED).useValue(false)
      .compile();
    app = mod.createNestApplication<NestExpressApplication>();
    await app.init();
  });
  afterAll(async () => { await app?.close(); await fake?.close(); await db?.stop(); delete process.env.SHARE_API_URL; });

  it('아무것도 하지 않는다', async () => {
    await db.pool.query(
      `INSERT INTO meeting_share(meeting_id,status,remote_id,delete_token,scope,duration_days,expires_at,consent_version,consented_at)
       VALUES(NULL,'revoke_pending','7-AAAAAAAAAAAAAAAAAAAAA1','t','{}',7, now() + interval '1 day',1,now())`,
    );
    await app.get(SharesSweeper).tick();
    expect(fake.requests).toHaveLength(0);
  });
});
```

`be/test/meetings-management.e2e-spec.ts`의

```ts
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
```

를

```ts
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ share_revoke: 'none', share_expires_at: null });
```

로, `be/test/tags.e2e-spec.ts:95`의 `.expect(204)`를 `.expect(200)`으로 바꾼다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-be exec jest test/shares-lifecycle.e2e-spec.ts test/meetings-management.e2e-spec.ts test/tags.e2e-spec.ts`
Expected: FAIL — `SharesSweeper` 없음, 삭제가 204.

- [ ] **Step 3: 구현**

`be/src/shares/shares.sweeper.ts`:

```ts
import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SHARE_ENABLED } from './share-enabled.guard';
import { SharesService } from './shares.service';

/**
 * 공유의 뒷정리 (spec §2.7): 기동 시와 5분마다 만료 정리 → 오래된 creating 정리 → 철회 재시도.
 * 오프라인에서 지운 회의의 링크가 여기서 다시 연결될 때 철회된다. 공유가 꺼진 실행에서는 아무것도 하지 않는다.
 */
@Injectable()
export class SharesSweeper implements OnApplicationBootstrap {
  constructor(@Inject(SHARE_ENABLED) private readonly enabled: boolean, private readonly service: SharesService) {}

  onApplicationBootstrap(): void {
    // 기동을 붙잡지 않는다 — 공유 서버가 안 닿으면 타임아웃까지 걸린다. sweep()은 오류를 삼키므로(경고 로그만),
    // 다른 e2e 파일이 reset()으로 테이블을 비우는 사이에 돌아도 테스트 실패로 번지지 않는다(Codex 계획 리뷰 #13).
    void this.tick();
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    if (!this.enabled) return;
    await this.service.sweep();
  }
}
```

`shares.module.ts`의 providers에 `SharesSweeper`를 더한다.

`be/src/meetings/meetings.module.ts` — `imports`에 `SharesModule`을 더한다(`import { SharesModule } from '../shares/shares.module';`).

`be/src/meetings/meetings.service.ts` — 생성자 끝에 `private readonly shares: SharesRepository, private readonly sharesService: SharesService,`를 더하고(import 두 줄), `remove`를:

```ts
  // Cascade removes clusters/utterances/embeddings/jobs; then drop on-disk files.
  // An in-flight worker holding this meeting's job is tolerated: its ownership
  // guards discard when the job/meeting rows disappear (see db-schema notes).
  // 공유 링크는 같은 트랜잭션에서 철회 대기로 돌린다(spec 2026-10-09 §2.7) — meeting_share는 SET NULL이라 행과
  // 삭제 토큰이 남고, 커밋 뒤 한 번 철회를 시도한다. 오프라인이면 pending으로 응답하고 스위퍼가 이어 간다.
  async remove(id: string): Promise<RevokeSummary> {
    const result = await this.db.withTransaction(async (c) => {
      const shares = await this.shares.markActiveRevokePending(c, id);
      const deleted = await this.meetings.deleteById(c, id);
      return { deleted, shares };
    });
    if (!result.deleted) throw new NotFoundException('meeting not found');
    await this.storage.deleteDir(this.storage.meetingDir(id));
    return this.sharesService.revokeRows(result.shares);
  }
```

(`import type { RevokeSummary } from '../shares/shares.service';`) 회의가 없으면 `markActiveRevokePending`은 0행을 바꾸고 트랜잭션은 롤백되지 않아도 무해하다.

`be/src/meetings/meetings.controller.ts`의 삭제 라우트에서 `@HttpCode(204)`를 지우고 요약을 바꾼다:

```ts
  @Delete(':id')
  @ApiOperation({ summary: '회의 삭제 (연관 데이터·저장 파일 정리, 공유 링크 철회 결과를 돌려준다)' })
  remove(@Param('id') id: string) { return this.service.remove(id); }
```

`new MeetingsService(`를 직접 부르는 테스트가 있으면(`grep -rn "new MeetingsService" be/test`) 생성자 인자 두 개를 더한다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter damwha-be exec jest test/shares-lifecycle.e2e-spec.ts test/shares.e2e-spec.ts test/meetings-management.e2e-spec.ts test/tags.e2e-spec.ts`
Expected: PASS

- [ ] **Step 5: 변이 확인**

`remove`에서 `markActiveRevokePending` 줄을 지운다 → "회의 삭제 — 온라인이면…"이 FAIL(행이 active로 남고 서버 객체가 남는다). 되돌린다. `tick`의 `if (!this.enabled) return;`을 지운다 → "아무것도 하지 않는다"가 FAIL. 되돌린다.

- [ ] **Step 6: 커밋**

```bash
git add be/src/shares be/src/meetings be/test/shares-lifecycle.e2e-spec.ts be/test/meetings-management.e2e-spec.ts be/test/tags.e2e-spec.ts
git commit -m "feat(be): 공유 스위퍼와 회의 삭제 시 링크 철회 — 오프라인이면 대기열로"
```

### Task 12: 라우트 불변식 — GET 목록 스냅샷과 접근 제어

**Files:**
- Create: `be/test/get-routes.e2e-spec.ts`
- Modify: `be/test/access-control.e2e-spec.ts` (공유 시나리오 추가)

**Interfaces:**
- Consumes: `configureHttp`, `buildAccessPolicy` (선행 작업), 공유 라우트 (Task 10)

- [ ] **Step 1: GET 라우트 스냅샷 테스트 (목록은 다음 단계에서 채운다)**

`be/test/get-routes.e2e-spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from '../src/app.module';
import { buildAccessPolicy } from '../src/access/access-policy';
import { configureHttp } from '../src/http/configure-http';
import { startTestDb, StartedTestDb } from './db';

/**
 * 상태를 바꾸는 GET 금지 (spec 2026-10-09 §2.7, 선행 결과 규칙 1). 쓰기 보호는 GET이 아닌 요청의 Origin 검사에
 * 기댄다 — no-cors GET은 Origin 없이 와서 통과한다. GET 라우트가 새로 생기면 이 테스트가 실패한다: 그 GET이
 * 아무것도 바꾸지 않는지 리뷰한 뒤 목록에 더한다.
 */
const EXPECTED_GET_ROUTES: string[] = [];

type Layer = { route?: { path: string; methods: Record<string, boolean> } };

describe('GET 라우트 목록', () => {
  let db: StartedTestDb;
  let app: NestExpressApplication;
  beforeAll(async () => {
    db = await startTestDb();
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication<NestExpressApplication>();
    configureHttp(app, { policy: buildAccessPolicy('', ''), publicDir: null });
    await app.init();
  });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  it('리뷰된 목록과 같다', () => {
    const stack: Layer[] = app.getHttpAdapter().getInstance()._router.stack;
    const gets = stack
      .filter((l) => l.route?.methods.get)
      .map((l) => l.route!.path)
      .filter((p) => p.startsWith('/api/'))
      .sort();
    expect(gets).toEqual(EXPECTED_GET_ROUTES);
  });
});
```

- [ ] **Step 2: 현재 목록을 만들고 리뷰한다**

Run: `pnpm --filter damwha-be exec jest test/get-routes.e2e-spec.ts`
Expected: FAIL — 받은 배열(`Received`)이 지금의 GET 라우트 전부다.

출력된 배열을 `EXPECTED_GET_ROUTES`에 그대로 붙인다. 붙이기 전에 **각 GET 핸들러가 DB·파일·job을 바꾸지 않는지** 컨트롤러를 열어 확인한다(선행 작업 검증에서 22개를 읽어 모두 읽기 전용이었다. 이번에 더해진 것은 `/api/meetings/:id/share`, `/api/shares` 둘이고 둘 다 순수 읽기다 — 만료 정리는 스위퍼만 하고 GET은 걸러 읽기만 한다. Task 10의 "GET은 행을 바꾸지 않는다" 테스트가 이를 지킨다).

- [ ] **Step 3: 통과와 변이 확인**

Run: `pnpm --filter damwha-be exec jest test/get-routes.e2e-spec.ts`
Expected: PASS

변이: `be/src/notes/notes.controller.ts`에 `@Get('probe') probe() { return 1; }`를 임시로 더하고 실행 → FAIL. 지운다.

- [ ] **Step 4: 접근 제어 시나리오 (선행 결과 규칙 3)**

`be/test/access-control.e2e-spec.ts`의 `describe('2~4·CSRF simple request', …)` 안에 더한다(이 파일은 `SHARE_API_URL`을 따로 잡지 않는다 — 요청은 미들웨어에서 끊겨 업로드까지 가지 않는다):

```ts
    it('다른 Origin의 공유 만들기는 403이고 meeting_share 행이 생기지 않는다', async () => {
      const mid = await seedMeeting();
      await http().post(`/api/meetings/${mid}/share`).set('Host', SELF_HOST).set('Origin', EVIL)
        .type('text/plain').send(JSON.stringify({ scope: {}, duration_days: 7, consent_version: 1, ui_language: 'ko' }))
        .expect(403);
      expect(await count('SELECT count(*) AS n FROM meeting_share')).toBe(0);
    });

    it('다른 Origin은 공유 목록(키가 든 링크)을 읽지 못한다', async () => {
      const res = await http().get('/api/shares').set('Host', SELF_HOST).set('Origin', EVIL).expect(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
```

Run: `pnpm --filter damwha-be exec jest test/access-control.e2e-spec.ts`
Expected: PASS

- [ ] **Step 5: be 전체**

Run: `pnpm --filter damwha-be exec jest --runInBand`
Expected: PASS (선행 작업 기준 783개 + 이번에 더한 것)

- [ ] **Step 6: 커밋**

```bash
git add be/test/get-routes.e2e-spec.ts be/test/access-control.e2e-spec.ts
git commit -m "test(be): GET 라우트 스냅샷과 공유 라우트의 접근 제어 시나리오"
```

---
## 4단계 — fe

### Task 13: 공유 API 훅과 `share` 네임스페이스

**Files:**
- Modify: `fe/package.json` (의존성 `@damwha/share-format`, `@damwha/share-view`)
- Create: `fe/src/features/share/api/share.ts`, `fe/src/features/share/api/share.test.tsx`
- Create: `fe/src/shared/i18n/locales/ko/share.ts`, `fe/src/shared/i18n/locales/en/share.ts`
- Modify: `fe/src/shared/i18n/locales/ko/index.ts`, `en/index.ts`, `fe/src/shared/i18n/create-i18n.ts` (`NAMESPACES`)
- Modify: `fe/src/features/meeting/api/meetings.ts` (`useDeleteMeeting`가 응답을 돌려주고 `["shares"]`를 무효화)

**Interfaces:**
- Consumes: be 공유 API (Task 10), `DELETE /meetings/:id` 응답 (Task 11)
- Produces:
  - `type ShareStatus`, `type ShareView`, `type ListedShare` (be와 같은 모양), `type ShareScope` (share-format 재수출)
  - `shareKeys = { meeting: (id) => ["meeting-share", id], list: ["shares"] }`
  - `useMeetingShare(meetingId?: string): UseQueryResult<ShareView | null | "disabled">` — 404면 `"disabled"`
  - `useSharePreview(meetingId: string, scope: ShareScope, uiLanguage: UiLanguage, durationDays: ShareDurationDays, enabled: boolean): UseQueryResult<SharePreview>`, `type SharePreview = { payload: SharePayloadV1; expiresAtEstimate: string }`
  - `useCreateShare(): UseMutationResult<ShareView, ApiError, { meetingId; scope; durationDays; transcriptAck; uiLanguage }>`
  - `useStopShare(): UseMutationResult<{ share: ShareView; pending: boolean }, ApiError, { meetingId: string }>`
  - `useShares(): UseQueryResult<ListedShare[] | "disabled">`
  - `shareErrorKey(error: unknown): string` — i18n 키(`errors.<CODE>` 또는 `errors.generic`)
  - `useDeleteMeeting()`의 data: `{ share_revoke: "none" | "revoked" | "pending"; share_expires_at: string | null }`
  - i18n 네임스페이스 `share` (아래 키)

- [ ] **Step 1: 의존성**

Run: `pnpm --filter damwha-fe add @damwha/share-format@workspace:* @damwha/share-view@workspace:*`

- [ ] **Step 2: 실패하는 테스트**

`fe/src/features/share/api/share.test.tsx`:

```tsx
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, apiClient } from "@/shared/api/client";
import { shareErrorKey, useCreateShare, useMeetingShare, useStopShare } from "./share";

afterEach(() => vi.restoreAllMocks());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const VIEW = {
  id: "shr_1", meeting_id: "mtg_1", status: "active", url: "https://s/s/7-x#k",
  expires_at: "2026-10-16T00:00:00.000Z", scope: { summary: true, lenses: true, transcript: false, note: false, anonymize: false },
  duration_days: 7, created_at: "2026-10-09T00:00:00.000Z",
};

test("useMeetingShare — 공유가 있으면 그 view", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { share: VIEW } } as never);
  const { result } = renderHook(() => useMeetingShare("mtg_1"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toEqual(VIEW);
});

test("useMeetingShare — 404면 'disabled' (공유가 꺼진 실행)", async () => {
  vi.spyOn(apiClient, "get").mockRejectedValue(new ApiError(404, "Not Found"));
  const { result } = renderHook(() => useMeetingShare("mtg_1"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toBe("disabled");
});

test("useCreateShare — 동의 버전과 책임 확인을 실어 보낸다", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: { share: VIEW } } as never);
  const { result } = renderHook(() => useCreateShare(), { wrapper });
  await result.current.mutateAsync({
    meetingId: "mtg_1", scope: { ...VIEW.scope, transcript: true }, durationDays: 30, transcriptAck: true, uiLanguage: "ko",
  });
  expect(post).toHaveBeenCalledWith("/meetings/mtg_1/share", {
    scope: { ...VIEW.scope, transcript: true }, duration_days: 30, consent_version: 1, transcript_ack: true, ui_language: "ko",
  });
});

test("useStopShare — 202면 pending", async () => {
  vi.spyOn(apiClient, "delete").mockResolvedValue({ status: 202, data: { share: { ...VIEW, status: "revoke_pending", url: null } } } as never);
  const { result } = renderHook(() => useStopShare(), { wrapper });
  expect((await result.current.mutateAsync({ meetingId: "mtg_1" })).pending).toBe(true);
});

test("shareErrorKey — 아는 code는 그 키, 아니면 generic", () => {
  expect(shareErrorKey(new ApiError(409, "x", "SHARE_IN_PROGRESS"))).toBe("errors.SHARE_IN_PROGRESS");
  expect(shareErrorKey(new ApiError(500, "x", "SOMETHING"))).toBe("errors.generic");
  expect(shareErrorKey(new Error("x"))).toBe("errors.generic");
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm fe vitest run src/features/share/api/share.test.tsx`
Expected: FAIL — `./share` 없음.

- [ ] **Step 4: 구현 — 사전**

`fe/src/shared/i18n/locales/ko/share.ts` (문구 원문은 spec §2.6·§2.9):

```ts
/** 회의 공유 (features/share). */
export const share = {
  button: "공유",
  status: {
    active: "공유 중 · {{date}}까지",
    pending: "중지 대기 중",
  },
  dialog: {
    createTitle: "공유 링크 만들기",
    manageTitle: "공유 링크",
    scopeLabel: "공유할 내용",
    scope: {
      summary: "요약",
      lenses: "할 일·결정·약속",
      transcript: "발화 기록",
      note: "메모",
    },
    summaryUnavailable: "요약이 아직 없어요",
    anonymize: "화자 이름 가리기",
    anonymizeHint: "요약·할 일 문장 안에 적힌 이름은 그대로 남아요. 미리보기에서 확인해 주세요.",
    durationLabel: "공유 기간",
    days_one: "{{count}}일",
    days_other: "{{count}}일",
    previewTitle: "받는 사람에게 이렇게 보여요",
    previewLoading: "미리보기를 만드는 중…",
    previewFailed: "미리보기를 만들지 못했어요.",
    notice:
      "링크를 가진 사람은 누구나 이 내용을 볼 수 있어요. 요약·할 일에도 참석자의 이름과 발언 내용이 담길 수 있어요. 서버에는 암호문만 저장되고 키는 저장하지 않아요. 링크는 {{date}}에 막히고 서버 기록은 그 뒤 한 시간 안에 삭제돼요. 공유한 뒤 회의를 고쳐도 반영되지 않아요. 받은 사람이 이미 복사하거나 캡처한 내용은 되돌릴 수 없어요.",
    consent: "위 내용을 확인했고, 참석자에게 공유해도 되는 내용이에요",
    transcriptWarning:
      "발화 기록에는 다른 참석자의 발언이 그대로 담겨 있어요. 공유하기 전에 참석자에게 허락을 받았는지 확인해 주세요. 공유로 생기는 책임은 공유한 사람에게 있어요.",
    transcriptAck: "참석자의 허락을 받았고, 공유 책임이 나에게 있음을 이해했어요",
    replaceWarning_one:
      "기존 링크({{count}}일 남음)는 바로 중지되고 서버에서 삭제돼요. 기존 링크를 받은 사람은 더 이상 볼 수 없어요.",
    replaceWarning_other:
      "기존 링크({{count}}일 남음)는 바로 중지되고 서버에서 삭제돼요. 기존 링크를 받은 사람은 더 이상 볼 수 없어요.",
    submit: "링크 만들기",
    cancel: "취소",
    created: "공유 링크를 만들었어요.",
    linkLabel: "공유 링크",
    copy: "링크 복사",
    copied: "링크를 복사했어요.",
    expiresOn: "{{date}}에 링크가 막혀요.",
    stop: "공유 중지",
    stopped: "공유를 중지했어요.",
    newLink: "새 링크 만들기",
    pendingNotice: "중지 대기 중이에요. 인터넷에 연결되면 중지돼요.",
  },
  errors: {
    SHARE_IN_PROGRESS: "이미 이 회의의 공유 링크를 만드는 중이에요.",
    SHARE_SERVICE_UNREACHABLE: "인터넷에 연결해야 공유할 수 있어요.",
    SHARE_SERVICE_BUSY: "공유 서버가 지금 바빠요. 잠시 후 다시 시도해 주세요.",
    SHARE_TOO_LARGE: "공유할 내용이 너무 커요. 발화 기록을 빼고 다시 시도해 주세요.",
    SUMMARY_NOT_READY: "요약이 아직 준비되지 않았어요.",
    MEETING_DELETED: "회의가 삭제되어 공유하지 못했어요.",
    generic: "공유하지 못했어요.",
  },
  settings: {
    title: "공유한 링크",
    description: "지금 공유 중이거나 중지를 기다리는 링크예요.",
    empty: "공유 중인 링크가 없어요.",
    deletedMeeting: "삭제된 회의",
    until: "{{date}}까지",
    pending: "중지 대기 중",
  },
  deleteMeeting: {
    activeShare: "이 회의의 공유 링크도 중지돼요.",
    pendingToast:
      "인터넷에 연결되어 있지 않아요. 공유 링크는 다음에 연결될 때 중지되고, 늦어도 {{date}}에는 막혀요.",
  },
};
```

`fe/src/shared/i18n/locales/en/share.ts`:

```ts
import type { LocaleShape } from "../../locale-shape";
import type { share as ko } from "../ko/share";

export const share = {
  button: "Share",
  status: {
    active: "Shared · until {{date}}",
    pending: "Stopping…",
  },
  dialog: {
    createTitle: "Create a share link",
    manageTitle: "Share link",
    scopeLabel: "What to share",
    scope: {
      summary: "Summary",
      lenses: "Action items, decisions, promises",
      transcript: "Transcript",
      note: "Notes",
    },
    summaryUnavailable: "No summary yet",
    anonymize: "Hide speaker names",
    anonymizeHint: "Names written inside summary or action-item sentences stay as they are. Check the preview.",
    durationLabel: "Share for",
    days_one: "{{count}} day",
    days_other: "{{count}} days",
    previewTitle: "This is what recipients will see",
    previewLoading: "Building the preview…",
    previewFailed: "Couldn't build the preview.",
    notice:
      "Anyone with the link can see this. Summaries and action items can include attendees' names and what they said. The server stores only encrypted data and never the key. The link stops working on {{date}} and the server copy is deleted within an hour after. Edits you make after sharing are not included. Anything a recipient has already copied or captured can't be taken back.",
    consent: "I've read this, and this is fine to share with the attendees",
    transcriptWarning:
      "The transcript contains other attendees' words verbatim. Make sure they agreed before you share. You are responsible for what you share.",
    transcriptAck: "The attendees agreed, and I understand I'm responsible for sharing this",
    replaceWarning_one:
      "The current link ({{count}} day left) stops right away and is deleted from the server. People who have it can no longer open it.",
    replaceWarning_other:
      "The current link ({{count}} days left) stops right away and is deleted from the server. People who have it can no longer open it.",
    submit: "Create link",
    cancel: "Cancel",
    created: "Share link created.",
    linkLabel: "Share link",
    copy: "Copy link",
    copied: "Link copied.",
    expiresOn: "The link stops working on {{date}}.",
    stop: "Stop sharing",
    stopped: "Sharing stopped.",
    newLink: "Create a new link",
    pendingNotice: "Waiting to stop. It will stop once you're back online.",
  },
  errors: {
    SHARE_IN_PROGRESS: "A share link for this meeting is already being created.",
    SHARE_SERVICE_UNREACHABLE: "You need to be online to share.",
    SHARE_SERVICE_BUSY: "The share server is busy. Please try again shortly.",
    SHARE_TOO_LARGE: "This is too large to share. Try again without the transcript.",
    SUMMARY_NOT_READY: "The summary isn't ready yet.",
    MEETING_DELETED: "The meeting was deleted, so it wasn't shared.",
    generic: "Couldn't share.",
  },
  settings: {
    title: "Shared links",
    description: "Links that are shared now or waiting to stop.",
    empty: "No shared links.",
    deletedMeeting: "Deleted meeting",
    until: "until {{date}}",
    pending: "Stopping…",
  },
  deleteMeeting: {
    activeShare: "Its share link will stop too.",
    pendingToast:
      "You're offline. The share link will stop the next time you're online, and no later than {{date}}.",
  },
} satisfies LocaleShape<typeof ko>;
```

`ko/index.ts`: `import { share } from "./share";` + `export const ko = { common, settings, share };`. `en/index.ts`도 같은 모양으로. `create-i18n.ts`: `export const NAMESPACES = ["common", "settings", "share"] as const;`

- [ ] **Step 5: 구현 — 훅**

`fe/src/features/share/api/share.ts`:

```ts
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { SHARE_CONSENT_VERSION, type ShareDurationDays, type UiLanguage } from "@damwha/contracts";
import type { SharePayloadV1, ShareScope } from "@damwha/share-format";
import { ApiError, apiClient, isApiError } from "@/shared/api/client";
import { env } from "@/shared/config/env";

export type { ShareScope };
export type ShareStatus = "creating" | "active" | "revoke_pending" | "revoked" | "expired";
export type ShareView = {
  id: string;
  meeting_id: string | null;
  status: ShareStatus;
  url: string | null;
  expires_at: string | null;
  scope: ShareScope;
  duration_days: number;
  created_at: string;
};
export type ListedShare = ShareView & { meeting_title: string | null };
/** 미리보기 = be가 실제로 암호화할 페이로드 + 예상 만료(지금 + 기간). 실제 만료는 서버가 정한다. */
export type SharePreview = { payload: SharePayloadV1; expiresAtEstimate: string };

export const shareKeys = {
  meeting: (meetingId: string | undefined) => ["meeting-share", meetingId] as const,
  list: ["shares"] as const,
};

const KNOWN_ERRORS = new Set([
  "SHARE_IN_PROGRESS", "SHARE_SERVICE_UNREACHABLE", "SHARE_SERVICE_BUSY", "SHARE_TOO_LARGE", "SUMMARY_NOT_READY", "MEETING_DELETED",
]);

/** be가 붙인 code → `share` 사전의 키. */
export function shareErrorKey(error: unknown): string {
  return isApiError(error) && error.code && KNOWN_ERRORS.has(error.code) ? `errors.${error.code}` : "errors.generic";
}

/**
 * 공유가 꺼진 실행(Docker·데모 — be가 loopback이 아니거나 DEMO_READ_ONLY)에서는 공유 라우트가 404다.
 * 그때 `"disabled"`를 돌려 화면이 공유 UI를 통째로 숨긴다. 데모 빌드는 요청조차 하지 않는다.
 */
export function useMeetingShare(meetingId: string | undefined): UseQueryResult<ShareView | null | "disabled"> {
  return useQuery({
    queryKey: shareKeys.meeting(meetingId),
    queryFn: async () => {
      try {
        const { data } = await apiClient.get<{ share: ShareView | null }>(`/meetings/${meetingId}/share`);
        // undefined를 돌려주면 TanStack이 오류로 본다 — 모양이 틀린 응답도 "공유 없음"으로 둔다.
        return data?.share ?? null;
      } catch (e) {
        if (isApiError(e) && e.statusCode === 404) return "disabled" as const;
        throw e;
      }
    },
    enabled: !!meetingId && !env.demoMode,
    retry: false,
  });
}

export function useSharePreview(
  meetingId: string,
  scope: ShareScope,
  uiLanguage: UiLanguage,
  durationDays: ShareDurationDays,
  enabled: boolean,
): UseQueryResult<SharePreview> {
  return useQuery({
    queryKey: ["share-preview", meetingId, scope, uiLanguage, durationDays],
    queryFn: async () => {
      const { data } = await apiClient.post<{ payload: SharePayloadV1; expires_at_estimate: string }>(
        `/meetings/${meetingId}/share/preview`,
        { scope, ui_language: uiLanguage, duration_days: durationDays },
      );
      return { payload: data.payload, expiresAtEstimate: data.expires_at_estimate };
    },
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

type CreateVars = {
  meetingId: string;
  scope: ShareScope;
  durationDays: ShareDurationDays;
  transcriptAck: boolean;
  uiLanguage: UiLanguage;
};

export function useCreateShare() {
  const qc = useQueryClient();
  return useMutation<ShareView, ApiError, CreateVars>({
    mutationFn: async (v) => {
      const { data } = await apiClient.post<{ share: ShareView }>(`/meetings/${v.meetingId}/share`, {
        scope: v.scope,
        duration_days: v.durationDays,
        consent_version: SHARE_CONSENT_VERSION,
        transcript_ack: v.transcriptAck,
        ui_language: v.uiLanguage,
      });
      return data.share;
    },
    onSuccess: (share, v) => {
      qc.setQueryData(shareKeys.meeting(v.meetingId), share);
      void qc.invalidateQueries({ queryKey: shareKeys.list });
    },
  });
}

export function useStopShare() {
  const qc = useQueryClient();
  return useMutation<{ share: ShareView; pending: boolean }, ApiError, { meetingId: string }>({
    mutationFn: async ({ meetingId }) => {
      const res = await apiClient.delete<{ share: ShareView }>(`/meetings/${meetingId}/share`);
      return { share: res.data.share, pending: res.status === 202 };
    },
    onSuccess: (r, v) => {
      qc.setQueryData(shareKeys.meeting(v.meetingId), r.pending ? r.share : null);
      void qc.invalidateQueries({ queryKey: shareKeys.list });
    },
  });
}

export function useShares(): UseQueryResult<ListedShare[] | "disabled"> {
  return useQuery({
    queryKey: shareKeys.list,
    queryFn: async () => {
      try {
        const { data } = await apiClient.get<{ shares: ListedShare[] }>("/shares");
        return data.shares;
      } catch (e) {
        if (isApiError(e) && e.statusCode === 404) return "disabled" as const;
        throw e;
      }
    },
    enabled: !env.demoMode,
    retry: false,
  });
}
```

`fe/src/features/meeting/api/meetings.ts`의 `useDeleteMeeting`:

```ts
export type DeleteMeetingResult = {
  share_revoke: "none" | "revoked" | "pending";
  share_expires_at: string | null;
};

export function useDeleteMeeting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string }) => {
      const { data } = await apiClient.delete<DeleteMeetingResult>(`/meetings/${vars.id}`);
      return data;
    },
    onSuccess: (_data, vars) => {
      // 목록 캐시에서 삭제된 회의를 즉시 빼낸다. (기존 주석 그대로 둔다)
      queryClient.setQueryData<MeetingSummary[]>(["meetings"], (old) =>
        old?.filter((m) => m.id !== vars.id),
      );
      removeMeetingCaches(queryClient, vars.id);
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
      // 공유 목록의 회의 제목이 "삭제된 회의"로 바뀌고 상태가 철회 대기일 수 있다.
      queryClient.invalidateQueries({ queryKey: ["shares"] });
      queryClient.removeQueries({ queryKey: ["meeting-share", vars.id] });
    },
  });
}
```


- [ ] **Step 6: 통과 확인**

Run: `pnpm fe vitest run src/features/share src/features/meeting/api src/shared/i18n && pnpm fe build`
Expected: PASS, `tsc -b`가 `en`의 `satisfies LocaleShape`까지 통과.

- [ ] **Step 7: 커밋**

```bash
git add fe/package.json pnpm-lock.yaml fe/src/features/share fe/src/shared/i18n fe/src/features/meeting/api/meetings.ts
git commit -m "feat(fe): 공유 API 훅과 share 사전 — 꺼진 실행(404)은 disabled"
```

### Task 14: 공유 다이얼로그와 회의 헤더 버튼

**Files:**
- Create: `fe/src/features/share/ui/share-dialog.tsx`, `fe/src/features/share/ui/share-button.tsx`, `fe/src/features/share/lib/dates.ts`
- Create: `fe/src/features/share/ui/share-dialog.test.tsx`, `fe/src/features/share/ui/share-button.test.tsx`
- Modify: `fe/src/features/meeting/ui/transcript-pane.tsx` (헤더 액션)
- Modify: `fe/src/main.tsx` 또는 `fe/src/index.css` (share-view CSS import)

**Interfaces:**
- Consumes: Task 13의 훅·타입, `ShareDocument` (Task 5), `Meeting` (`fe/src/features/meeting/model/types.ts` — `id`, `status`, `summaryStatus`)
- Produces: `ShareButton({ meeting }: { meeting: Meeting })`, `ShareDialog({ meeting, current, open, onOpenChange })`, `formatShareDate(iso: string, lang: UiLanguage): string`, `daysLeft(iso: string, now?: Date): number`

- [ ] **Step 1: 실패하는 테스트**

`fe/src/features/share/ui/share-dialog.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError, apiClient } from "@/shared/api/client";
import type { Meeting } from "@/features/meeting/model/types";
import { ShareDialog } from "./share-dialog";
import type { ShareView } from "../api/share";

const PAYLOAD = {
  v: 1, created_at: "2026-10-09T00:00:00.000Z", ui_language: "ko",
  meeting: { title: "주간 회의", recorded_at: "2026-10-08T01:00:00.000Z", duration_ms: 60000 }, speakers: [],
  summary: { topics: ["배포 일정"], segments: [] },
};
const meeting = (over: Partial<Meeting> = {}) => ({ id: "mtg_1", title: "주간 회의", status: "done", summaryStatus: "done", ...over }) as Meeting;
const ACTIVE: ShareView = {
  id: "shr_1", meeting_id: "mtg_1", status: "active", url: "https://share.example/s/7-x#KEY",
  expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
  scope: { summary: true, lenses: true, transcript: false, note: false, anonymize: false }, duration_days: 7, created_at: "2026-10-09T00:00:00.000Z",
};

let post: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  post = vi.spyOn(apiClient, "post").mockImplementation(async (url: string) => {
    if (url.endsWith("/preview")) return { data: { payload: PAYLOAD, expires_at_estimate: "2026-10-16T00:00:00.000Z" } } as never;
    return { data: { share: ACTIVE } } as never;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderDialog(props: Partial<React.ComponentProps<typeof ShareDialog>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ShareDialog meeting={meeting()} current={null} open onOpenChange={() => {}} {...props} />
    </QueryClientProvider>,
  );
}

const submit = () => screen.getByRole("button", { name: "링크 만들기" });
const consent = () => fireEvent.click(screen.getByLabelText("위 내용을 확인했고, 참석자에게 공유해도 되는 내용이에요"));
/** 미리보기가 그려질 때까지 — 그 전에는 공유 버튼이 꺼져 있다. */
const previewShown = async () => {
  const region = await screen.findByRole("region", { name: "받는 사람에게 이렇게 보여요" });
  await within(region).findByText("배포 일정");
};

test("기본 동의를 체크하기 전에는 링크를 만들 수 없다", async () => {
  renderDialog();
  await previewShown();
  expect(submit()).toBeDisabled();
  consent();
  expect(submit()).toBeEnabled();
});

test("미리보기가 오기 전과 실패했을 때는 동의해도 버튼이 꺼져 있다", async () => {
  let release!: () => void;
  post.mockImplementation(
    (url: string) =>
      new Promise((resolve, reject) => {
        if (!url.endsWith("/preview")) return resolve({ data: { share: ACTIVE } } as never);
        release = () => reject(new ApiError(500, "x"));
      }),
  );
  renderDialog();
  consent();
  expect(submit()).toBeDisabled(); // 아직 미리보기가 없다
  release();
  expect(await screen.findByText("공유하지 못했어요.")).toBeInTheDocument();
  expect(submit()).toBeDisabled(); // 실패한 미리보기로는 공유하지 않는다
});

test("발화 기록을 켜면 책임 확인이 나타나고, 체크해야 버튼이 켜진다", async () => {
  renderDialog();
  consent();
  expect(screen.queryByLabelText("참석자의 허락을 받았고, 공유 책임이 나에게 있음을 이해했어요")).toBeNull();
  fireEvent.click(screen.getByLabelText("발화 기록"));
  expect(screen.getByText(/발화 기록에는 다른 참석자의 발언이 그대로/)).toBeInTheDocument();
  await previewShown(); // 범위가 바뀌어 새 미리보기를 받는다
  expect(submit()).toBeDisabled();
  fireEvent.click(screen.getByLabelText("참석자의 허락을 받았고, 공유 책임이 나에게 있음을 이해했어요"));
  expect(submit()).toBeEnabled();
});

test("요약이 done이 아니면 요약 체크는 꺼져 있고 비활성이다", () => {
  renderDialog({ meeting: meeting({ summaryStatus: "failed" }) });
  const box = screen.getByLabelText(/요약/) as HTMLInputElement;
  expect(box.checked).toBe(false);
  expect(box.disabled).toBe(true);
  expect(screen.getByText("요약이 아직 없어요")).toBeInTheDocument();
});

test("내용을 하나도 고르지 않으면 버튼이 꺼진다", () => {
  renderDialog();
  fireEvent.click(screen.getByLabelText("위 내용을 확인했고, 참석자에게 공유해도 되는 내용이에요"));
  fireEvent.click(screen.getByLabelText(/요약/));
  fireEvent.click(screen.getByLabelText("할 일·결정·약속"));
  expect(submit()).toBeDisabled();
});

test("미리보기는 be가 만든 페이로드를 공유 렌더러로 그린다", async () => {
  renderDialog();
  const preview = await screen.findByRole("region", { name: "받는 사람에게 이렇게 보여요" });
  expect(await within(preview).findByText("배포 일정")).toBeInTheDocument();
  expect(post).toHaveBeenCalledWith("/meetings/mtg_1/share/preview", expect.objectContaining({ ui_language: "ko", duration_days: 7 }));
});

test("익명화 토글 아래에 자유 텍스트 한계를 적는다", () => {
  renderDialog();
  expect(screen.getByText("요약·할 일 문장 안에 적힌 이름은 그대로 남아요. 미리보기에서 확인해 주세요.")).toBeInTheDocument();
});

test("이미 공유 중이면 새 링크 화면에 기존 링크 중지 경고가 뜬다", () => {
  renderDialog({ current: ACTIVE });
  fireEvent.click(screen.getByRole("button", { name: "새 링크 만들기" }));
  expect(screen.getByText(/기존 링크\(5일 남음\)는 바로 중지되고/)).toBeInTheDocument();
});

test("409는 '이미 만드는 중' 문구로 알린다", async () => {
  post.mockImplementation(async (url: string) => {
    if (url.endsWith("/preview")) return { data: { payload: PAYLOAD, expires_at_estimate: "2026-10-16T00:00:00.000Z" } } as never;
    throw new ApiError(409, "x", "SHARE_IN_PROGRESS");
  });
  renderDialog();
  consent();
  await previewShown();
  fireEvent.click(submit());
  expect(await screen.findByText("이미 이 회의의 공유 링크를 만드는 중이에요.")).toBeInTheDocument();
});

test("만들기에 성공하면 관리 화면 — 링크 복사", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText: write } });
  renderDialog();
  consent();
  await previewShown();
  fireEvent.click(submit());
  fireEvent.click(await screen.findByRole("button", { name: "링크 복사" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith("https://share.example/s/7-x#KEY"));
});

test("철회 대기 중이면 복사 버튼이 없고 안내만 있다", () => {
  renderDialog({ current: { ...ACTIVE, status: "revoke_pending", url: null } });
  expect(screen.queryByRole("button", { name: "링크 복사" })).toBeNull();
  expect(screen.getByText("중지 대기 중이에요. 인터넷에 연결되면 중지돼요.")).toBeInTheDocument();
});

test("중지 — 202면 대기 안내", async () => {
  vi.spyOn(apiClient, "delete").mockResolvedValue({ status: 202, data: { share: { ...ACTIVE, status: "revoke_pending", url: null } } } as never);
  renderDialog({ current: ACTIVE });
  fireEvent.click(screen.getByRole("button", { name: "공유 중지" }));
  expect(await screen.findByText("중지 대기 중이에요. 인터넷에 연결되면 중지돼요.")).toBeInTheDocument();
});
```

`fe/src/features/share/ui/share-button.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, apiClient } from "@/shared/api/client";
import type { Meeting } from "@/features/meeting/model/types";
import { ShareButton } from "./share-button";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const meeting = { id: "mtg_1", title: "회의", status: "done", summaryStatus: "done" } as Meeting;
const renderBtn = (m: Meeting = meeting) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ShareButton meeting={m} />
    </QueryClientProvider>,
  );

test("공유가 없으면 '공유' 버튼", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { share: null } } as never);
  renderBtn();
  expect(await screen.findByRole("button", { name: "공유" })).toBeInTheDocument();
});

test("공유 중이면 만료일이 붙은 상태 버튼", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { share: { id: "shr_1", status: "active", url: "u", expires_at: "2026-10-15T06:00:00.000Z", scope: {}, duration_days: 7, created_at: "x", meeting_id: "mtg_1" } },
  } as never);
  renderBtn();
  expect(await screen.findByRole("button", { name: /공유 중 · .*15일.*까지/ })).toBeInTheDocument();
});

test("공유가 꺼진 실행(404)이면 아무것도 그리지 않는다", async () => {
  const get = vi.spyOn(apiClient, "get").mockRejectedValue(new ApiError(404, "Not Found"));
  const { container } = renderBtn();
  await vi.waitFor(() => expect(get).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

test("처리가 끝나지 않은 회의에는 없다", () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { share: null } } as never);
  const { container } = renderBtn({ ...meeting, status: "processing" } as Meeting);
  expect(container).toBeEmptyDOMElement();
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm fe vitest run src/features/share/ui`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`fe/src/features/share/lib/dates.ts`:

```ts
import type { UiLanguage } from "@damwha/contracts";

export function formatShareDate(iso: string, lang: UiLanguage): string {
  return new Intl.DateTimeFormat(lang === "ko" ? "ko-KR" : "en-US", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** 남은 날(올림). 경고 문구의 "N일 남음". */
export function daysLeft(iso: string, now: Date = new Date()): number {
  return Math.max(1, Math.ceil((Date.parse(iso) - now.getTime()) / 86_400_000));
}
```

`fe/src/features/share/ui/share-dialog.tsx`:

```tsx
import * as React from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_SHARE_DURATION_DAYS, SHARE_DURATION_DAYS, type ShareDurationDays } from "@damwha/contracts";
import { ShareDocument } from "@damwha/share-view";
import { isDemoBlocked } from "@/shared/api/demo-read-only";
import { useUiLanguage } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { SegmentedControl } from "@/shared/ui/segmented-control";
import { Switch } from "@/shared/ui/switch";
import { toast } from "@/shared/ui/use-toast";
import type { Meeting } from "@/features/meeting/model/types";
import { shareErrorKey, useCreateShare, useSharePreview, useStopShare, type ShareScope, type ShareView } from "../api/share";
import { daysLeft, formatShareDate } from "../lib/dates";

type Props = { meeting: Meeting; current: ShareView | null; open: boolean; onOpenChange: (open: boolean) => void };

const CONTENT_KEYS = ["summary", "lenses", "transcript", "note"] as const;

/**
 * 공유 다이얼로그 (spec §2.6). 범위 → 미리보기 → 고지·확인이 한 화면이다. 미리보기는 be가 실제로 암호화할
 * 페이로드를 공유 뷰어와 같은 렌더러(share-view)로 그린다 — 근사치가 아니다.
 * 공유 중이면 관리 화면(복사·중지·새 링크)으로 열린다.
 */
export function ShareDialog({ meeting, current, open, onOpenChange }: Props) {
  const { t } = useTranslation("share");
  const [view, setView] = React.useState<"manage" | "create">(current ? "manage" : "create");
  const [shown, setShown] = React.useState<ShareView | null>(current);
  React.useEffect(() => {
    if (open) {
      setView(current ? "manage" : "create");
      setShown(current);
    }
  }, [open, current]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{view === "manage" ? t("dialog.manageTitle") : t("dialog.createTitle")}</DialogTitle>
          <DialogDescription>{meeting.title}</DialogDescription>
        </DialogHeader>
        {view === "manage" && shown ? (
          <ManageView meetingId={meeting.id} share={shown} onShareChange={setShown} onNewLink={() => setView("create")} />
        ) : (
          <CreateView
            meeting={meeting}
            replacing={current?.status === "active" ? current : null}
            onCancel={() => onOpenChange(false)}
            onCreated={(s) => {
              setShown(s);
              setView("manage");
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreateView({
  meeting, replacing, onCancel, onCreated,
}: { meeting: Meeting; replacing: ShareView | null; onCancel: () => void; onCreated: (s: ShareView) => void }) {
  const { t } = useTranslation("share");
  const lang = useUiLanguage();
  const summaryReady = meeting.summaryStatus === "done";
  const [scope, setScope] = React.useState<ShareScope>({
    summary: summaryReady, lenses: true, transcript: false, note: false, anonymize: false,
  });
  const [days, setDays] = React.useState<ShareDurationDays>(DEFAULT_SHARE_DURATION_DAYS);
  const [consent, setConsent] = React.useState(false);
  const [ack, setAck] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const hasContent = CONTENT_KEYS.some((k) => scope[k]);
  const preview = useSharePreview(meeting.id, scope, lang, days, hasContent);
  const create = useCreateShare();
  // 쿼리 키에 범위·언어·기간이 들어 있어 값을 바꾸면 새 키가 pending이 된다 — 그동안 버튼은 꺼진다(spec selfhost §2.6).
  const previewReady = preview.isSuccess && !preview.isFetching;
  const expiresEstimate = preview.data?.expiresAtEstimate ?? new Date(Date.now() + days * 86_400_000).toISOString();
  const canSubmit = hasContent && consent && (!scope.transcript || ack) && previewReady && !create.isPending;

  const toggle = (k: keyof ShareScope) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setScope((s) => ({ ...s, [k]: e.target.checked }));
    if (k === "transcript" && !e.target.checked) setAck(false);
  };

  const submit = () => {
    setError(null);
    create.mutate(
      { meetingId: meeting.id, scope, durationDays: days, transcriptAck: scope.transcript && ack, uiLanguage: lang },
      {
        onSuccess: (s) => {
          toast({ variant: "success", title: t("dialog.created") });
          onCreated(s);
        },
        onError: (e) => {
          if (isDemoBlocked(e)) return;
          setError(t(shareErrorKey(e)));
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-[color:var(--text-secondary)]">{t("dialog.scopeLabel")}</legend>
        <Checkbox label={t("dialog.scope.summary")} checked={scope.summary} disabled={!summaryReady} onChange={toggle("summary")} />
        {!summaryReady && <p className="pl-6 text-xs text-[color:var(--text-muted)]">{t("dialog.summaryUnavailable")}</p>}
        <Checkbox label={t("dialog.scope.lenses")} checked={scope.lenses} onChange={toggle("lenses")} />
        <Checkbox label={t("dialog.scope.transcript")} checked={scope.transcript} onChange={toggle("transcript")} />
        <Checkbox label={t("dialog.scope.note")} checked={scope.note} onChange={toggle("note")} />
      </fieldset>

      <div className="flex flex-col gap-1">
        <Switch label={t("dialog.anonymize")} checked={scope.anonymize} onChange={toggle("anonymize")} />
        <p className="text-xs text-[color:var(--text-muted)]">{t("dialog.anonymizeHint")}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-[color:var(--text-secondary)]">{t("dialog.durationLabel")}</span>
        <SegmentedControl
          options={SHARE_DURATION_DAYS.map((d) => ({ value: String(d), label: t("dialog.days", { count: d }) }))}
          value={String(days)}
          onChange={(v) => setDays(Number(v) as ShareDurationDays)}
        />
      </div>

      <section aria-labelledby="share-preview-title" className="rounded-md border border-[color:var(--border-subtle)]">
        <h3 id="share-preview-title" className="px-4 pt-3 text-sm font-medium text-[color:var(--text-secondary)]">
          {t("dialog.previewTitle")}
        </h3>
        <div className="max-h-[320px] overflow-y-auto">
          {!hasContent ? null : preview.isPending ? (
            <p role="status" className="p-4 text-sm text-[color:var(--text-muted)]">{t("dialog.previewLoading")}</p>
          ) : preview.isError ? (
            <p className="p-4 text-sm text-[color:var(--text-muted)]">{t(shareErrorKey(preview.error))}</p>
          ) : (
            <ShareDocument payload={preview.data.payload} lang={lang} expiresAt={preview.data.expiresAtEstimate} />
          )}
        </div>
      </section>

      <div className="flex flex-col gap-3 rounded-md bg-[var(--surface-sunken)] p-4 text-sm">
        <p>{t("dialog.notice", { date: formatShareDate(expiresEstimate, lang) })}</p>
        <Checkbox label={t("dialog.consent")} checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        {scope.transcript && (
          <>
            <p className="font-medium">{t("dialog.transcriptWarning")}</p>
            <Checkbox label={t("dialog.transcriptAck")} checked={ack} onChange={(e) => setAck(e.target.checked)} />
          </>
        )}
        {replacing?.expires_at && <p>{t("dialog.replaceWarning", { count: daysLeft(replacing.expires_at) })}</p>}
      </div>

      {error && <p role="alert" className="text-sm text-[color:var(--color-danger-text)]">{error}</p>}

      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>{t("dialog.cancel")}</Button>
        <Button onClick={submit} disabled={!canSubmit} loading={create.isPending}>{t("dialog.submit")}</Button>
      </DialogFooter>
    </div>
  );
}

function ManageView({
  meetingId, share, onShareChange, onNewLink,
}: { meetingId: string; share: ShareView; onShareChange: (s: ShareView) => void; onNewLink: () => void }) {
  const { t } = useTranslation("share");
  const lang = useUiLanguage();
  const stop = useStopShare();
  const copy = async () => {
    if (!share.url) return;
    await navigator.clipboard.writeText(share.url);
    toast({ variant: "success", title: t("dialog.copied") });
  };
  const doStop = () =>
    stop.mutate(
      { meetingId },
      {
        onSuccess: (r) => {
          onShareChange(r.share);
          if (!r.pending) toast({ variant: "success", title: t("dialog.stopped") });
        },
        onError: (e) => {
          if (!isDemoBlocked(e)) toast({ variant: "error", title: t("errors.generic") });
        },
      },
    );

  if (share.status === "revoke_pending") {
    return <p className="text-sm">{t("dialog.pendingNotice")}</p>;
  }
  if (share.status !== "active") {
    return (
      <DialogFooter>
        <Button onClick={onNewLink}>{t("dialog.newLink")}</Button>
      </DialogFooter>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <Input readOnly aria-label={t("dialog.linkLabel")} value={share.url ?? ""} onFocus={(e) => e.currentTarget.select()} />
        <Button variant="secondary" onClick={() => void copy()} disabled={!share.url}>{t("dialog.copy")}</Button>
      </div>
      {share.expires_at && (
        <p className="text-sm text-[color:var(--text-muted)]">{t("dialog.expiresOn", { date: formatShareDate(share.expires_at, lang) })}</p>
      )}
      <DialogFooter>
        <Button variant="danger" onClick={doStop} loading={stop.isPending}>{t("dialog.stop")}</Button>
        <Button variant="secondary" onClick={onNewLink}>{t("dialog.newLink")}</Button>
      </DialogFooter>
    </div>
  );
}
```

색은 `fe/src/index.css`에 있는 토큰만 쓴다(`--surface-sunken`, `--border-subtle`, `--color-danger-text`, `--text-muted`, `--text-secondary`). 새 토큰을 만들지 않는다(`fe/DESIGN.md`).

`fe/src/features/share/ui/share-button.tsx`:

```tsx
import * as React from "react";
import { useTranslation } from "react-i18next";
import { env } from "@/shared/config/env";
import { useUiLanguage } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { IconButton } from "@/shared/ui/icon-button";
import { Icon } from "@/features/meeting/ui/icons";
import type { Meeting } from "@/features/meeting/model/types";
import { useMeetingShare } from "../api/share";
import { formatShareDate } from "../lib/dates";
import { ShareDialog } from "./share-dialog";

/**
 * 회의 헤더의 공유 진입점. 데모 빌드·공유가 꺼진 실행(404)·처리가 안 끝난 회의에서는 그리지 않는다.
 * 공유 중이면 "공유 중 · 날짜까지", 철회 대기면 "중지 대기 중"이 버튼 자체다 — 지금 공유 중인지가 바로 보인다.
 */
export function ShareButton({ meeting }: { meeting: Meeting }) {
  const { t } = useTranslation("share");
  const lang = useUiLanguage();
  const [open, setOpen] = React.useState(false);
  const enabled = !env.demoMode && meeting.status === "done";
  const q = useMeetingShare(enabled ? meeting.id : undefined);
  if (!enabled || q.data === undefined || q.data === "disabled") return null;
  const current = q.data;

  return (
    <>
      {current?.status === "active" && current.expires_at ? (
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {t("status.active", { date: formatShareDate(current.expires_at, lang) })}
        </Button>
      ) : current?.status === "revoke_pending" ? (
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{t("status.pending")}</Button>
      ) : (
        <IconButton label={t("button")} size="sm" onClick={() => setOpen(true)}>
          <Icon name="link" size={16} />
        </IconButton>
      )}
      <ShareDialog meeting={meeting} current={current} open={open} onOpenChange={setOpen} />
    </>
  );
}
```

`transcript-pane.tsx` — 내보내기 `IconButton` 블록 바로 뒤에 `<ShareButton meeting={meeting} />`(`import { ShareButton } from "@/features/share/ui/share-button";`). 버튼 자신이 조건을 판단하므로 감싸는 조건을 두지 않는다.

`fe/src/features/meeting/ui/transcript-pane.test.tsx` — 이 파일은 `apiClient.get`을 모듈째 `{ data: [] }`로 목킹하고, 새 훅은 그 응답을 `share: null`로 읽어 **공유 버튼을 그린다.** 그래서 73행의 `expect(screen.queryByRole("button", { name: "공유" })).toBeNull();`(배선되지 않은 버튼이 없다는 옛 단언)을 지우고, 대신:

```tsx
test("done 회의에는 공유 버튼이 생긴다 (공유 기능이 배선됐다)", async () => {
  renderPane();
  expect(await screen.findByRole("button", { name: "공유" })).toBeInTheDocument();
});
```

`fe/src/main.tsx`의 `import "./index.css";` 다음 줄에 `import "@damwha/share-view/styles.css";`.

- [ ] **Step 4: 통과 확인**

Run: `pnpm fe vitest run src/features/share src/features/meeting/ui/transcript-pane.test.tsx && pnpm fe build`
Expected: PASS (`transcript-pane.test.tsx` 포함 — 위에서 옛 단언을 바꿨다).

- [ ] **Step 5: 커밋**

```bash
git add fe/src/features/share fe/src/features/meeting/ui/transcript-pane.tsx fe/src/features/meeting/ui/transcript-pane.test.tsx fe/src/main.tsx
git commit -m "feat(fe): 공유 다이얼로그 — 범위·실제 페이로드 미리보기·동의, 헤더 공유 버튼"
```

### Task 15: 설정의 "공유한 링크"와 회의 삭제 안내

**Files:**
- Create: `fe/src/features/share/ui/shared-links-section.tsx`, `fe/src/features/share/ui/shared-links-section.test.tsx`
- Modify: `fe/src/pages/settings.tsx`
- Modify: `fe/src/features/meeting/ui/transcript-pane.tsx` (`DeleteDialog`)
- Modify: `fe/src/features/meeting/ui/transcript-pane.test.tsx` (삭제 안내 테스트 추가)

**Interfaces:**
- Consumes: `useShares`, `useStopShare`, `useMeetingShare`, `DeleteMeetingResult` (Task 13), `formatShareDate` (Task 14)
- Produces: `SharedLinksSection(): JSX.Element | null`

- [ ] **Step 1: 실패하는 테스트**

`fe/src/features/share/ui/shared-links-section.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, apiClient } from "@/shared/api/client";
import { SharedLinksSection } from "./shared-links-section";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SharedLinksSection />
    </QueryClientProvider>,
  );
const base = { scope: {}, duration_days: 7, created_at: "x", expires_at: "2026-10-15T06:00:00.000Z" };

test("공유 중·대기 중 링크를 회의 제목과 함께, 삭제된 회의는 '삭제된 회의'", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { shares: [
      { ...base, id: "shr_2", meeting_id: "mtg_1", meeting_title: "주간 회의", status: "active", url: "https://s/s/7-a#k" },
      { ...base, id: "shr_1", meeting_id: null, meeting_title: null, status: "revoke_pending", url: null },
    ] },
  } as never);
  renderIt();
  const rows = await screen.findAllByRole("listitem");
  expect(within(rows[0]).getByText("주간 회의")).toBeInTheDocument();
  expect(within(rows[0]).getByRole("button", { name: "링크 복사" })).toBeInTheDocument();
  expect(within(rows[1]).getByText("삭제된 회의")).toBeInTheDocument();
  expect(within(rows[1]).getByText("중지 대기 중")).toBeInTheDocument();
  expect(within(rows[1]).queryByRole("button", { name: "링크 복사" })).toBeNull();
});

test("비어 있으면 안내 문구", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { shares: [] } } as never);
  renderIt();
  expect(await screen.findByText("공유 중인 링크가 없어요.")).toBeInTheDocument();
});

test("공유가 꺼진 실행이면 섹션이 없다", async () => {
  const get = vi.spyOn(apiClient, "get").mockRejectedValue(new ApiError(404, "nf"));
  const { container } = renderIt();
  await vi.waitFor(() => expect(get).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

test("지금 중지", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { shares: [{ ...base, id: "shr_2", meeting_id: "mtg_1", meeting_title: "주간 회의", status: "active", url: "u" }] },
  } as never);
  const del = vi.spyOn(apiClient, "delete").mockResolvedValue({ status: 200, data: { share: { ...base, id: "shr_2", status: "revoked", url: null } } } as never);
  renderIt();
  fireEvent.click(await screen.findByRole("button", { name: "공유 중지" }));
  expect(del).toHaveBeenCalledWith("/meetings/mtg_1/share");
});
```

`fe/src/features/meeting/ui/transcript-pane.test.tsx` — 이 파일은 `@/shared/api/client`를 모듈째 목킹한다(`get`은 `{ data: [] }`). 맨 위 import에 `within`과 `import { apiClient } from "@/shared/api/client";`(목 객체)를 더하고, 파일 끝에:

```tsx
test("공유 중인 회의를 지우면 확인 창이 링크도 중지된다고 말하고, 오프라인이면 만료일 안내 토스트", async () => {
  const ACTIVE = {
    id: "shr_1", meeting_id: "m1", status: "active", url: "u", expires_at: "2026-10-15T06:00:00.000Z",
    scope: {}, duration_days: 7, created_at: "x",
  };
  vi.mocked(apiClient.get).mockImplementation(async (url: string) =>
    (url.endsWith("/share") ? { data: { share: ACTIVE } } : { data: [] }) as never,
  );
  vi.mocked(apiClient.delete).mockResolvedValueOnce({
    data: { share_revoke: "pending", share_expires_at: "2026-10-15T06:00:00.000Z" },
  } as never);
  try {
    renderPane();
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    expect(await screen.findByText(/이 회의의 공유 링크도 중지돼요\./)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "삭제" }));
    expect(
      await screen.findByText(/인터넷에 연결되어 있지 않아요\. 공유 링크는 다음에 연결될 때 중지되고, 늦어도 .*15일.*에는 막혀요\./),
    ).toBeInTheDocument();
  } finally {
    vi.mocked(apiClient.get).mockImplementation(async () => ({ data: [] }) as never);
  }
});
```

토스트는 `Toaster`가 있어야 화면에 그려진다. `renderPane`이 `Toaster`를 그리지 않으면 이 테스트 안에서만 `render(<Toaster />)`를 함께 그린다(`import { Toaster } from "@/shared/ui/toaster";`).

- [ ] **Step 2: 실패 확인**

Run: `pnpm fe vitest run src/features/share/ui/shared-links-section.test.tsx src/features/meeting/ui/transcript-pane.test.tsx`
Expected: FAIL

- [ ] **Step 3: 구현**

`fe/src/features/share/ui/shared-links-section.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { useUiLanguage } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { toast } from "@/shared/ui/use-toast";
import { useShares, useStopShare } from "../api/share";
import { formatShareDate } from "../lib/dates";

/** 설정 › 공유한 링크 (spec §2.9). 공유가 꺼진 실행·데모에서는 섹션이 없다. */
export function SharedLinksSection() {
  const { t } = useTranslation("share");
  const lang = useUiLanguage();
  const q = useShares();
  const stop = useStopShare();
  if (q.data === undefined || q.data === "disabled") return null;

  return (
    <section aria-labelledby="settings-shares">
      <Card className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h2 id="settings-shares" className="text-h2 font-semibold text-foreground">{t("settings.title")}</h2>
          <p className="text-sm text-[color:var(--text-muted)]">{t("settings.description")}</p>
        </header>
        {q.data.length === 0 ? (
          <p className="text-sm text-[color:var(--text-muted)]">{t("settings.empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-[color:var(--border-subtle)]">
            {q.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">{s.meeting_title ?? t("settings.deletedMeeting")}</span>
                <span className="text-xs text-[color:var(--text-muted)]">
                  {s.status === "revoke_pending"
                    ? t("settings.pending")
                    : s.expires_at && t("settings.until", { date: formatShareDate(s.expires_at, lang) })}
                </span>
                {s.status === "active" && s.url && (
                  <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard.writeText(s.url!).then(() => toast({ variant: "success", title: t("dialog.copied") }))}>
                    {t("dialog.copy")}
                  </Button>
                )}
                {s.status === "active" && s.meeting_id && (
                  <Button size="sm" variant="ghost" onClick={() => stop.mutate({ meetingId: s.meeting_id! })}>
                    {t("dialog.stop")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
```

`fe/src/pages/settings.tsx` — `<ModelsCard />` 다음 줄에 `<SharedLinksSection />`(import 추가).

`transcript-pane.tsx`의 `DeleteDialog`:

```tsx
function DeleteDialog({
  meeting,
  open,
  onOpenChange,
  onDeleted,
}: {
  meeting: Meeting;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const del = useDeleteMeeting();
  const { t } = useTranslation("share");
  const lang = useUiLanguage();
  const share = useMeetingShare(open ? meeting.id : undefined);
  const sharing = typeof share.data === "object" && share.data?.status === "active";

  const submit = () => {
    del.mutate(
      { id: meeting.id },
      {
        onSuccess: (data) => {
          toast({ variant: "success", title: "회의를 삭제했어요." });
          if (data?.share_revoke === "pending" && data.share_expires_at) {
            toast({ variant: "info", title: t("deleteMeeting.pendingToast", { date: formatShareDate(data.share_expires_at, lang) }) });
          }
          onOpenChange(false);
          onDeleted();
        },
        onError: (err) => {
          if (isDemoBlocked(err)) return;
          toast({
            variant: "error",
            title: "삭제에 실패했어요.",
            description: isApiError(err) ? err.message : undefined,
          });
        },
      },
    );
  };
  // DialogDescription 안, 기존 문장 뒤에:
  //   {sharing && <> {t("deleteMeeting.activeShare")}</>}
```

(import: `useTranslation`, `useUiLanguage`, `useMeetingShare`, `formatShareDate`.)

- [ ] **Step 4: 통과 확인**

Run: `pnpm fe test && pnpm fe build && pnpm fe lint`
Expected: PASS (전체 835개 + 새 테스트)

- [ ] **Step 5: 커밋**

```bash
git add fe/src/features/share fe/src/pages/settings.tsx fe/src/features/meeting/ui/transcript-pane.tsx fe/src/features/meeting/ui/transcript-pane.test.tsx
git commit -m "feat(fe): 설정의 공유한 링크, 회의 삭제 시 공유 중지 안내"
```

---
## 5단계 — 패키징·데모·사이트·문서·검증

### Task 16: 패키징 — 공유 서버 이미지, API 이미지, desktop env, 데모 시드

**Files:**
- Create: `deploy/share/Dockerfile`, `deploy/share/docker-compose.yml`, `deploy/share/README.md`
- Modify: `.dockerignore` (`share/.data`, `share/.env` — 로컬 공유 데이터가 빌드 컨텍스트에 실리지 않게)
- Modify: `deploy/api.Dockerfile`
- Modify: `desktop/scripts/package.mjs:82-93`
- Modify: `desktop/src/services/api-process.ts` (`apiChildEnv`), `desktop/tests/services/api-process.test.ts`
- Modify: `demo/seed/build.sh:29`

**Interfaces:**
- Consumes: `@damwha/share-format`(be 런타임 의존), `@damwha/share-view`(fe 빌드 의존), `SHARE_API_URL` (Task 8)

- [ ] **Step 1: 실패하는 테스트 — desktop**

`desktop/tests/services/api-process.test.ts`의 `describe("apiChildEnv", …)` 안에:

```ts
  it("packaged: an inherited SHARE_API_URL is dropped — the API uses its built-in production address", () => {
    const out = apiChildEnv({ PORT: "3000" }, "packaged", { SHARE_API_URL: "http://localhost:8787", PATH: "/usr/bin" });
    expect(out.SHARE_API_URL).toBeUndefined();
  });

  it("dev: SHARE_API_URL passes through so be/.env or the shell can point at pnpm share:dev", () => {
    const out = apiChildEnv({ PORT: "3000" }, "dev", { SHARE_API_URL: "http://localhost:8787", PATH: "/usr/bin" });
    expect(out.SHARE_API_URL).toBe("http://localhost:8787");
  });
```

Run: `pnpm --filter damwha-desktop exec vitest run tests/services/api-process.test.ts`
Expected: FAIL — packaged에서 값이 남는다.

- [ ] **Step 2: 구현 — desktop**

`apiChildEnv`의 `delete out.ALLOWED_HOSTS;` 다음 줄에:

```ts
  // 공유 서비스 주소(spec 2026-10-09 §2.7). packaged는 be의 기본값(운영 주소)을 쓴다 — 개발자 셸에서
  // 상속된 http://localhost:8787 같은 값이 서명된 앱으로 새지 않게 한다. dev는 be/.env·셸 값을 그대로 둔다.
  if (mode === "packaged") delete out.SHARE_API_URL;
```

함수 머리 주석의 목록에 `SHARE_API_URL` 한 줄을 더한다.

Run: `pnpm --filter damwha-desktop exec vitest run tests/services/api-process.test.ts`
Expected: PASS

- [ ] **Step 3: 구현 — Docker**

`deploy/api.Dockerfile` 빌드 단계:

```dockerfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# 워크스페이스 패키지 전부 — contracts·share-format은 prepare로 빌드되고, fe 빌드가 share-view 소스를 번들한다
COPY packages ./packages
COPY be/package.json ./be/
COPY fe/package.json ./fe/
```

(기존 `COPY packages/contracts ./packages/contracts`와 그 아래 주석을 이것으로 바꾼다.)

런타임 단계:

```dockerfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/share-format/package.json ./packages/share-format/
COPY packages/share-view/package.json ./packages/share-view/
COPY be/package.json ./be/
COPY fe/package.json ./fe/
# --ignore-scripts: contracts·share-format의 `prepare`는 tsc가 필요한데 --prod는 설치하지 않는다;
# 두 패키지의 dist는 빌드 단계에서 복사한다. share-view는 fe 번들에 들어가 런타임에 쓰지 않는다
# (fe/package.json이 의존하므로 package.json만 있으면 된다).
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --from=build /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /repo/packages/share-format/dist ./packages/share-format/dist
```

- [ ] **Step 4: Docker 이미지 확인 — 공유가 꺼지고, 모듈은 로드된다**

```bash
docker build -f deploy/api.Dockerfile -t damwha-api:share-test .
docker network create dst-net
docker run -d --name dst-pg --network dst-net -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=damwha damwha/postgres-bigm:pg16
sleep 5
docker run -d --name dst-api --network dst-net -p 127.0.0.1:3999:3000 \
  -e DATABASE_URL=postgres://postgres:postgres@dst-pg:5432/damwha damwha-api:share-test
sleep 5
curl -s -o /dev/null -w 'health %{http_code}\n' http://127.0.0.1:3999/api/health
curl -s -o /dev/null -w 'shares %{http_code}\n' http://127.0.0.1:3999/api/shares
docker exec -w /repo/be dst-api node -e "require('@damwha/share-format'); console.log('share-format ok')"
docker rm -f dst-api dst-pg && docker network rm dst-net
```

Expected: `health 200`, `shares 404`(이미지는 `HOST=0.0.0.0`이라 공유가 꺼진다), `share-format ok`.

- [ ] **Step 5: 구현 — desktop 패키징의 `file:` 경로 정리**

`desktop/scripts/package.mjs`의

```js
if (apiPkg.dependencies?.["@damwha/contracts"]?.startsWith("@damwha/contracts@file:")) {
  apiPkg.dependencies["@damwha/contracts"] = "workspace:*";
}
```

를 모든 워크스페이스 패키지로 넓힌다(위 주석의 "(@damwha/contracts)"도 "(@damwha/*)"로):

```js
for (const [name, spec] of Object.entries(apiPkg.dependencies ?? {})) {
  if (name.startsWith("@damwha/") && typeof spec === "string" && spec.startsWith(`${name}@file:`)) {
    apiPkg.dependencies[name] = "workspace:*";
  }
}
```

실제 패키징 확인은 Task 19에서 한다(시간이 오래 걸리고 `out/`·고아 `desktop:dev` 점검이 필요하다).

- [ ] **Step 6: 구현 — 데모 시드**

`demo/seed/build.sh:29`:

```bash
# 개발 DB에서 만든 공유의 키·삭제 토큰이 데모 덤프로 넘어가지 않게 한다 (spec 2026-10-09 §2.8). 스키마는 남긴다.
pg pg_dump "$DATABASE_URL" -Fc --no-owner --no-acl --exclude-table-data=meeting_share > "$HERE/damwha-demo.dump"
```

확인 — 개발 DB에 공유 행을 하나 넣고 같은 옵션으로 덤프해 데이터가 없는지 본다:

```bash
pnpm db:up && pnpm be:migrate
docker exec damwha-postgres psql -U postgres -d damwha -c \
  "INSERT INTO meeting_share(meeting_id,status,share_key,delete_token,scope,duration_days,consent_version,consented_at) VALUES(NULL,'revoke_pending','KEY-PROBE','TOKEN-PROBE','{}',7,1,now())"
docker exec damwha-postgres pg_dump -U postgres -d damwha -Fc --exclude-table-data=meeting_share \
  | docker exec -i damwha-postgres pg_restore --data-only -t meeting_share -f - | grep -c PROBE
docker exec damwha-postgres psql -U postgres -d damwha -c "DELETE FROM meeting_share WHERE share_key='KEY-PROBE'"
```

Expected: `grep -c` 출력이 `0`.

- [ ] **Step 7: 공유 서버 이미지와 compose**

`.dockerignore` 끝에 두 줄: `share/.data`, `share/.env`.

`deploy/share/Dockerfile` (빌드 컨텍스트는 레포 루트):

```dockerfile
# 공유 서버 (spec selfhost §2.4). 빌드: docker build -f deploy/share/Dockerfile -t damwha-share:<ver> .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY share/package.json ./share/
RUN pnpm install --frozen-lockfile --filter damwha-share...
COPY share ./share
RUN pnpm --filter damwha-share run build
# 런타임 node_modules만 따로 — 워크스페이스 링크를 실제 디렉터리로 펼친다
RUN pnpm --filter damwha-share --prod --config.inject-workspace-packages=true deploy /out

FROM node:22-alpine
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/share/dist/server ./server
COPY --from=build /repo/share/dist/viewer ./viewer
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    VIEWER_DIR=/app/viewer
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
USER node
CMD ["node", "server/main.js"]
```

컨테이너 **안**에서는 `0.0.0.0`에 바인드하지만(그래야 포트 매핑이 닿는다), 호스트에는 `127.0.0.1`로만 연다 — compose가 그 경계다.

`deploy/share/docker-compose.yml`:

```yaml
# 개인 서버에서: docker compose -f deploy/share/docker-compose.yml up -d
# 공개는 같은 호스트의 cloudflared가 http://127.0.0.1:8787 로 잇는다 (deploy/share/README.md).
name: damwha-share
services:
  share:
    image: damwha-share:latest
    build:
      context: ../..
      dockerfile: deploy/share/Dockerfile
    restart: unless-stopped
    ports:
      # loopback만 — 바깥에 열면 CF-Connecting-IP를 누구나 위조할 수 있다 (spec selfhost §2.4)
      - "127.0.0.1:8787:8787"
    environment:
      UPLOADS_ENABLED: "true"
      DAILY_MAX_UPLOADS: "500"
      DAILY_MAX_BYTES: "524288000"
    volumes:
      - share_data:/data
volumes:
  share_data:
```

`deploy/share/README.md`:

```markdown
# 공유 서버 배포 (개인 서버 + Cloudflare Tunnel)

spec: `docs/superpowers/specs/2026-10-09-meeting-share-selfhost-design.md` §2.4.

## 띄우기

    git pull && docker compose -f deploy/share/docker-compose.yml up -d --build
    curl -s http://127.0.0.1:8787/healthz     # {"ok":true}

## 공개 (Cloudflare Tunnel)

같은 호스트의 cloudflared에 ingress 한 줄을 더하고 DNS를 연결한다:

    # ~/.cloudflared/config.yml
    ingress:
      - hostname: damwha-share.0kimjae.dev
        service: http://127.0.0.1:8787
      - service: http_status:404

    cloudflared tunnel route dns <터널 이름> damwha-share.0kimjae.dev

cloudflared를 Docker로 돌린다면 이 compose의 `ports`를 지우고 같은 Docker 네트워크에 두고
`service: http://share:8787`로 잇는다. 어느 쪽이든 **8787을 바깥 인터페이스에 열지 않는다.**

## 운영

- 업로드만 긴급 차단: compose의 `UPLOADS_ENABLED: "false"` → `docker compose up -d`. 열람·삭제는 그대로.
- 일일 상한·IP별 제한: `DAILY_MAX_UPLOADS`, `DAILY_MAX_BYTES`, `UPLOAD_LIMIT_PER_MIN`, `READ_LIMIT_PER_MIN`, `DELETE_LIMIT_PER_MIN`.
  카운터는 메모리라 재시작하면 0부터 센다.
- **백업에서 `share_data` 볼륨을 뺀다.** 백업에 남으면 만료 삭제 약속이 깨진다.
- 만료 파일은 서버가 10분마다 지운다. 서버가 꺼져 있던 동안 만료된 것은 다시 켜질 때 지운다.
- 로그(`docker compose logs share`)에는 메서드·경로·상태만 남는다.
```

- [ ] **Step 8: 공유 서버 이미지 확인**

```bash
docker build -f deploy/share/Dockerfile -t damwha-share:test .
docker run -d --name dss -p 127.0.0.1:18787:8787 -v dss-data:/data damwha-share:test
sleep 3
curl -s http://127.0.0.1:18787/healthz
ID=$(curl -s -X POST -H 'X-Share-Days: 1' --data-binary 'probe' http://127.0.0.1:18787/api/shares | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
docker restart dss && sleep 3
curl -s -o /dev/null -w 'after restart %{http_code}\n' http://127.0.0.1:18787/api/shares/$ID
curl -s -o /dev/null -w 'viewer %{http_code}\n' http://127.0.0.1:18787/s/$ID
docker exec dss sh -c 'ls /data/shares | wc -l'
docker rm -f dss && docker volume rm dss-data
```

Expected: `{"ok":true}`, `after restart 200`(디스크에 남는다), `viewer 200`, 파일 `2`. 이미지 안에서 `DEV_EXPIRY_SECONDS`를 줘도 무시되는지는 Task 4의 `readConfig` 테스트가 지킨다.

- [ ] **Step 9: 커밋**

```bash
git add deploy/api.Dockerfile deploy/share .dockerignore desktop/scripts/package.mjs desktop/src/services/api-process.ts desktop/tests/services/api-process.test.ts demo/seed/build.sh
git commit -m "build: 공유 서버 Docker 이미지·compose·Tunnel 안내, API 이미지·desktop 패키징에 공유 패키지, 데모 덤프에서 공유 데이터 제외"
```

### Task 17: 제품 사이트 문구

**Files:**
- Modify: `site/src/i18n/ko.ts` (`privacy.body`, `faq.items`), `site/src/i18n/en.ts`

- [ ] **Step 1: 문구 수정**

`ko.ts`:

```ts
    body: "클라우드 ML이 없어요. 전사·화자 식별·검색·요약이 모두 내 Mac에서 돌고 목소리 특징(성문)은 디스크에만 남아요. 모델은 처음 쓸 때 한 번 받고 녹음은 이 Mac을 떠나지 않아요. 공유 링크를 만들 때만 고른 내용의 암호화된 사본이 서버에 올라가고, 링크는 최대 30일 뒤 막혀요. 오디오는 공유되지 않아요.",
```

FAQ의 인터넷 항목과 새 항목:

```ts
      { q: "인터넷이 필요한가요?", a: "모델을 처음 받을 때, 업데이트를 확인할 때, 공유 링크를 만들거나 중지할 때만요. 녹음·전사·검색은 오프라인에서도 돼요." },
      { q: "회의를 다른 사람에게 보여 줄 수 있나요?", a: "네. 회의 화면의 공유에서 요약·할 일·발화 기록·메모 중 고른 내용을 링크로 보낼 수 있어요. 내용은 내 Mac에서 암호화되어 올라가고 서버는 키를 갖지 않아요. 링크는 1·7·30일 중 고른 기간이 지나면 막히고 언제든 중지할 수 있어요. 오디오는 공유되지 않아요." },
```

`en.ts`:

```ts
    body: "No cloud ML. Transcription, speaker identification, search and summaries all run on your Mac, and voiceprints stay on disk. Models download once, the first time they're needed — your recordings never leave the machine. Only when you create a share link does an encrypted copy of what you chose go to the server, and the link stops working within 30 days. Audio is never shared.",
```

```ts
      { q: "Do I need an internet connection?", a: "Only to download models the first time they're used, to check for updates, and to create or stop a share link. Recording, transcription and search work offline." },
      { q: "Can I show a meeting to someone else?", a: "Yes. Share from the meeting screen sends a link with what you choose — summary, action items, transcript, notes. It's encrypted on your Mac before upload and the server never has the key. The link stops after 1, 7 or 30 days, whichever you pick, and you can stop it any time. Audio is never shared." },
```

새 FAQ 항목은 기존 "인터넷" 항목 바로 뒤에 둔다.

- [ ] **Step 2: 확인**

Run: `pnpm site test && pnpm site:build`
Expected: PASS, 빌드 성공.

- [ ] **Step 3: 커밋**

```bash
git add site/src/i18n/ko.ts site/src/i18n/en.ts
git commit -m "feat(site): 공유 링크를 프라이버시 문구와 FAQ에 반영한다"
```

### Task 18: 문서

**Files:**
- Modify: `CLAUDE.md` (루트 — 모노레포 표·명령·통신 문단)
- Modify: `be/CLAUDE.md`, `fe/CLAUDE.md`, `desktop/CLAUDE.md`
- Create: `share/README.md`

- [ ] **Step 1: 루트 `CLAUDE.md`**

모노레포 표에 세 줄:

```markdown
| `share/` | `damwha-share` | 공유 링크 서버 — Node 프로세스 하나가 암호문 API(`/api/shares`)와 정적 뷰어(`/s/:id`)를 디스크 파일 위에서 서빙한다. 개인 서버의 Docker(`deploy/share/`) + Cloudflare Tunnel로 `damwha-share.0kimjae.dev`. Read [`share/README.md`](share/README.md). |
| `packages/share-format/` | `@damwha/share-format` | 공유 봉투(AES-256-GCM + gzip)와 페이로드 모양, 공유 id 규칙. be가 암호화, 뷰어가 복호화. CJS+ESM. |
| `packages/share-view/` | `@damwha/share-view` | 공유본 React 렌더러(소스 TSX). fe 미리보기와 뷰어가 같이 쓴다. |
```

명령 블록에:

```bash
pnpm share:dev                # 공유 서버+뷰어 :8787 (데이터 share/.data). be/.env에 SHARE_API_URL=http://localhost:8787
pnpm share:test               # 공유 서버(node) + 뷰어(jsdom) 테스트
```

"API와 worker는 Postgres로만…" 문단 뒤에 한 문단: be는 공유 서버로 **나가는** HTTP를 보낸다(유일한 외부 호출, `be/src/shares/share-client.ts`). 공유는 be가 loopback이고 데모가 아닐 때만 켜진다. 공유 서버의 만료 시각이 권위다.

- [ ] **Step 2: `be/CLAUDE.md`** — "Non-obvious invariants"에 항목 하나:

```markdown
- **공유 (`src/shares/`, spec 2026-10-09 selfhost).** `meeting_share`는 활성 링크이자 철회 대기열이다. `meeting`에 **SET NULL**로
  묶여 회의를 지워도 삭제 토큰이 남는다 — CASCADE로 바꾸면 오프라인에서 지운 회의의 링크를 영영 철회할 수 없다. 공유는
  `shareEnabled()`(HOST가 loopback이고 데모가 아님)일 때만 켜지고, 아니면 공유 라우트가 404다: 접근 제어는 인증이 아니라
  Docker·데모에서 공유를 열면 네트워크의 누구나 키를 읽는다. 생성은 예약(creating, 유니크) → REPEATABLE READ 스냅샷 →
  암호화·업로드(트랜잭션 밖, 기존 active가 있으면 `X-Replace-*`로 서버가 같은 요청에서 지움) → 확정(기존 active를 **먼저**
  내림) 순서다. 만료 시각은 공유 서버가 정한 값만 저장한다. 상태를 바꾸는 GET을 만들지 않는다 — 만료 정리는 스위퍼만 하고,
  `test/get-routes.e2e-spec.ts`가 GET 목록을 고정한다. `DELETE /meetings/:id`는 204가 아니라 `200 { share_revoke, share_expires_at }`.
```

- [ ] **Step 3: `fe/CLAUDE.md`** — Architecture에 한 문단:

```markdown
- **공유 (`features/share/`, spec 2026-10-09 selfhost).** 회의 헤더의 `ShareButton`, `ShareDialog`(범위 → 미리보기 → 고지·동의,
  관리 화면), 설정의 `SharedLinksSection`. 공유 라우트가 404면(Docker·데모 실행) 훅이 `"disabled"`를 돌려 UI를 통째로 숨긴다.
  미리보기는 be `POST …/share/preview`가 만든 **실제 페이로드**를 `@damwha/share-view`로 그리고, 그 미리보기가 성공해야
  공유 버튼이 켜진다. 문구는 `share` 네임스페이스(ko/en).
```

- [ ] **Step 4: `desktop/CLAUDE.md`** — 자식 env 설명에 한 줄: packaged는 상속된 `SHARE_API_URL`을 지운다(be 기본값 = `https://damwha-share.0kimjae.dev`), dev는 통과.

- [ ] **Step 5: `share/README.md`**

```markdown
# damwha-share

공유 링크 서버 (spec `docs/superpowers/specs/2026-10-09-meeting-share-selfhost-design.md`). Node 프로세스 하나가
`/api/shares`(암호문 업로드·조회·삭제·교체)와 `/s/:id`(정적 뷰어)를 서빙한다. 서버는 암호문만 받고 키는 링크의 `#` 뒤에만 있다.

## 로컬

    pnpm share:dev                         # :8787, 데이터는 share/.data/
    cp share/.env.example share/.env       # DEV_EXPIRY_SECONDS=60 — 만료 흐름을 1분 만에 본다

be는 `be/.env`의 `SHARE_API_URL=http://localhost:8787`로 붙는다. 스크립트 이름을 `dev`로 바꾸지 않는다 —
루트 `pnpm dev`가 `--recursive run dev`라 끌려 들어간다.

## 구조

- `src/app.ts` — 순수 핸들러 `createApp(deps).fetch(req, { ip })`. 테스트는 네트워크 없이 이것을 부른다.
- `src/store.ts` — `shares/<id>.bin` + `<id>.json`. 메타가 있어야 존재한다(쓰기는 봉투 → 메타, 지우기는 메타 → 봉투).
- `src/limits.ts` — IP별 제한(업로드·조회·삭제 따로), 일일 상한(프로세스 하나 전제, 메모리).
- `src/main.ts` — `@hono/node-server`로 붙이고 10분마다 만료 파일을 지운다.

## 배포

`deploy/share/README.md` (개인 서버 Docker + Cloudflare Tunnel).
```

- [ ] **Step 6: 커밋**

```bash
git add CLAUDE.md be/CLAUDE.md fe/CLAUDE.md desktop/CLAUDE.md share/README.md
git commit -m "docs: 공유 링크 — 모노레포 지도, 불변식, 공유 서버 안내"
```

### Task 19: 개발 환경 연계 검증과 결과 기록

**Files:**
- Create: `docs/superpowers/reports/2026-10-09-meeting-share-results.md`

- [ ] **Step 1: 전체 테스트**

```bash
pnpm --filter @damwha/contracts test
pnpm --filter @damwha/share-format test
pnpm --filter @damwha/share-view test
pnpm share:test && pnpm share typecheck
pnpm --filter damwha-be exec jest --runInBand
pnpm fe test && pnpm fe build && pnpm fe lint
pnpm --filter damwha-desktop exec vitest run
```

각 명령의 통과 수를 기록한다. 실패가 있으면 여기서 멈추고 고친다.

- [ ] **Step 2: 개발 환경 연계 시나리오 (spec selfhost §3 표)**

준비: `be/.env`에 `SHARE_API_URL=http://localhost:8787`, `share/.env`에 `DEV_EXPIRY_SECONDS=60`. 터미널 둘에서 `pnpm dev`, `pnpm share:dev`. 브라우저 자동화를 쓰면 탭이 hidden이라 TanStack 폴링이 멈춘다 — 상태 확인은 새로고침으로 한다.

| # | 시나리오 | 확인 |
| --- | --- | --- |
| 1 | `http://localhost:5173`에서 done 회의 → 공유 → 요약·렌즈, 미리보기가 뜬 뒤 기본 동의 → 링크 만들기 → 다른 브라우저(시크릿)로 링크 열기 | 고른 범위만 보이고 하단 만료 날짜가 서버 값이다. `share/.data/shares/*.bin`에 평문이 없다(`grep -c '주간' share/.data/shares/*.bin` = 0) |
| 2 | 같은 회의에서 새 링크 | 응답 직후 기존 링크를 새로고침하면 "이 공유는 만료되었거나 중지되었어요", 새 링크는 열림. `share/.data/shares`에 `.json`이 하나 |
| 3 | 공유 중지 | 링크가 막히고 설정 목록에서 사라진다 |
| 4 | `share:dev`를 끈 채 공유 중인 회의 삭제 → 다시 켜고 5분 뒤(또는 be 재시작) | 삭제 직후 토스트가 만료일 안내, 설정 목록에 "삭제된 회의 · 중지 대기 중", 재시도 후 사라지고 링크가 막힘 |
| 5 | `DEV_EXPIRY_SECONDS=60`으로 공유 → 1분 뒤 | 링크가 막히고, 회의 화면의 공유 버튼이 다시 "공유". 10분 안에 `.data`의 파일도 사라진다 |
| 6 | `share/.env`에 `UPLOADS_ENABLED=false`를 더해 `share:dev` 재시작 | 공유 만들기는 "공유 서버가 지금 바빠요", 기존 링크 열람은 됨. 되돌린다 |
| 7 | `share:dev` 재시작 | 기존 링크가 계속 열린다(디스크 저장) |
| 8 | 3시간짜리(또는 Task 10의 대용량 SQL로 만든) 회의에 발화 기록 포함 공유 | "공유할 내용이 너무 커요", `share:dev` 로그에 POST 없음 |
| 9 | 화면 언어 English로 바꿔 1번 반복, 뷰어를 영어 브라우저로 열기 | 다이얼로그·뷰어 문구가 영어 |
| 10 | `be/.env`에서 `HOST=0.0.0.0`(+ `ALLOWED_HOSTS`)로 be 재시작 | 회의 화면에 공유 버튼이 없고 설정에 "공유한 링크" 섹션이 없다. 되돌린다 |

- [ ] **Step 3: 공유 서버 Docker 이미지로 같은 연계**

Task 16 Step 8의 이미지를 `-p 127.0.0.1:8787:8787`로 띄우고(`pnpm share:dev`는 끈다) 시나리오 1·2·3을 한 번 더 한다. 이미지는 `NODE_ENV=production`이라 `DEV_EXPIRY_SECONDS`가 무시된다 — 5번은 하지 않는다.

- [ ] **Step 4: 패키징된 앱 (desktop)**

메모리의 패키징 주의를 따른다: `out/`에 옛 DMG가 있거나 `out/mac-arm64`에서 앱이 떠 있으면 먼저 정리, 고아 `desktop:dev`(build/postgres·python)가 살아 있으면 사용자에게 묻고 멈춘 뒤, `FORCE_COLOR`를 빼고(`env -u FORCE_COLOR pnpm desktop:build`) 패키징한다. 그다음:

- 패키지된 앱의 API 자식 env에 `SHARE_API_URL`이 없다(`ps eww <api pid> | tr ' ' '\n' | grep SHARE` 결과 없음).
- 앱에서 공유 다이얼로그가 열리고 미리보기가 그려진다.
- `damwha-share.0kimjae.dev`가 아직 연결되지 않았으면 링크 만들기는 "인터넷에 연결해야 공유할 수 있어요"(`SHARE_SERVICE_UNREACHABLE`)로 끝난다 — 이건 정상이며 **성공 판정이 아니다.** 결과에 "연결 전, 미확인"으로 적는다.

- [ ] **Step 5: 연결 후 확인 (사용자가 개인 서버에 띄우고 Tunnel을 연결한 뒤)**

`deploy/share/README.md`대로 띄우고 연결되면: 패키징된 앱에서 공유 → 다른 기기로 `https://damwha-share.0kimjae.dev/s/…` 열람 → 새 링크(기존 링크 막힘) → 중지 → 막힘. `curl -sI`로 응답 헤더(noindex, no-referrer, no-store, CSP). 같은 IP로 조회를 분당 120번 넘게 보내 429가 나오는지(`CF-Connecting-IP` 기준 제한). 그 전까지는 결과에 "미확인"으로 남긴다.

- [ ] **Step 6: 그래프 갱신**

Run: `graphify update .`

- [ ] **Step 7: 결과 기록**

`docs/superpowers/reports/2026-10-09-meeting-share-results.md` — 기존 결과 문서와 같은 모양: spec·plan 링크, 브랜치 `feat/meeting-share`, Step 1 명령과 통과 수, Step 2 표의 각 행 결과(재현한 사실만), Step 3·4·5, spec §1 성공 기준별 판정(충족/부분/미확인과 근거), 남은 것(spec §4 미결 — 요청 제한 수치 확정, Tunnel 연결, 법률 검토).

- [ ] **Step 8: 커밋**

```bash
git add docs/superpowers/reports/2026-10-09-meeting-share-results.md
git commit -m "docs(report): 회의 공유 링크 결과"
```
