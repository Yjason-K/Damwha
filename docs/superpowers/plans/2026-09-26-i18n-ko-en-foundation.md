# 다국어(ko·en) — 기반과 요약 언어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 화면 언어(ko·en)를 기기 언어로 시작해 설정에서 바꿀 수 있게 하는 **기반**(FE i18n·언어 저장소·desktop 브리지·메뉴)과, 요약·렌즈의 출력 언어를 고르는 **요약 언어**(설정 → job 계약 → worker 프롬프트)를 만든다.

**Architecture:** 언어 결정 규칙(`pickUiLanguage`)은 `@damwha/contracts`에 두고 FE가 쓴다. desktop은 런타임 의존성이 없어(asar에는 컴파일된 main만) 같은 함수의 사본을 두고 테스트로 contracts와 대조한다. 화면 언어의 원본은 desktop main(`ui-language.json`)이고, 첫 화면에는 `?lang=`으로, 이후에는 기존 "main이 묻고 페이지가 답한다" 브리지(`uiLanguage.next()/show()`)로 오간다. 요약 언어는 처리 설정의 필드이고, job을 처음 만들 때 해석해 payload에 싣는다(process_meeting v6, summarize_meeting·extract_lenses v2, live_session v2). worker는 옛 버전을 `transcript`로 읽는다.

**Tech Stack:** `@damwha/contracts`(TS, CJS+ESM, node:test) · React 19 + i18next 26 + react-i18next 17 (vitest) · Electron 44 main(TS, vitest) · NestJS 10 + zod 3 (jest, testcontainers) · Python 3.12 + pydantic (pytest).

**Spec:** `docs/superpowers/specs/2026-09-26-i18n-ko-en-design.md` §3–§5, §8, §9의 1·2단계. 3–6단계(문구 이전·에러 코드·문서)는 이 계획의 범위가 아니다 — 이 계획이 끝난 뒤 별도 계획으로 쓴다. §4.3의 `format.ts`(Intl 날짜·숫자)와 §4.4의 메뉴 밖 desktop 문구(상태 창·다이얼로그·진단)도 3·4단계다 — 이 계획은 사전 뼈대와 메뉴까지만 옮긴다. 계획이 스펙과 어긋나면 **스펙을 따르고** 스펙에 적는다. 이 계획이 스펙에서 의도적으로 바꾼 것 세 가지는 Task 18에서 스펙에 반영한다(아래 "스펙과 다른 점").

### 스펙과 다른 점 (Task 18에서 스펙에 적는다)

1. **desktop은 `@damwha/contracts`를 런타임에 import하지 않는다.** `desktop/electron-builder.yml`은 "desktop에는 dependencies가 없으므로" asar에 컴파일된 main만 싣는다. 런타임 의존성을 들이면 패키징이 바뀐다. 대신 `desktop/src/i18n/locale.ts`에 사본을 두고, 테스트가 contracts(devDependency)와 입력 표 전체에서 같은 답을 내는지 확인한다.
2. **`SUMMARY_LANGUAGE`는 `apiChildEnv`가 아니라 `launchEnv`(`desktop/src/config/config.ts`)에서 얹는다.** `launchEnv`가 "이 실행이 정한 값"(LLM 주소·HF 토큰)을 얹는 자리이고, 기준선(baseline)에 넣지 않아 재적용(refreshEnv)이 지우지 않는다. config.json에 사람이 적은 `SUMMARY_LANGUAGE`가 있으면 그 값이 이긴다(디버깅용).
3. **localStorage 키는 `damwha:ui-language`.** 스펙의 `damwha.uiLanguage` 대신 기존 테마 키 `damwha:theme`의 모양을 따른다.

## Global Constraints

- 지원 UI 언어는 `ko`·`en` 둘. 요약 언어는 `transcript`·`ko`·`en` 셋. 값의 진실원은 `@damwha/contracts`의 `UI_LANGUAGES`·`SUMMARY_LANGUAGES`.
- `pickUiLanguage`: 목록 앞에서부터, 대소문자 무시, `ko`/`ko-*`/`ko_*` → `ko`, `en`/`en-*`/`en_*` → `en`, 처음 걸리는 것. 없으면 `en`. (`kok`(콘칸어)는 `ko`가 아니다.)
- "기기 언어를 따르다가, 고르면 고정": 저장값이 없으면 저장하지 않고 매번 기기 언어를 따른다. 사람이 고를 때만 쓴다. (desktop 안의 FE가 main에서 받은 값을 localStorage에 캐시하는 것은 예외 — §Task 4.)
- desktop은 렌더러→main 채널을 새로 만들지 않는다. main이 `executeJavaScript`로 묻고 페이지가 답한다.
- 사전: FE는 TS 객체(`ko`가 기준, `en`은 `satisfies LocaleShape<typeof ko>` — 키가 빠지거나 남으면 `tsc -b` 실패). 복수형 키는 **ko에도 `_one`·`_other`를 둘 다** 둔다(모양을 같게 — 한국어는 같은 문장).
- 사전 밖에 남는 한글 문자열 리터럴(언어 자기 이름 `한국어` 등)은 줄 끝에 `// i18n-allow: autonym`을 단다 — 3단계의 하드코딩 가드가 이 표시를 읽는다.
- job 계약: 옛 버전은 **손대지 않고** 계속 받는다(worker는 process_meeting v1–v6, summarize/extract v1–v2, live_session v1–v2). 새 버전의 새 필드는 wire에서 **필수**.
- `transcript`일 때 worker 프롬프트는 **지금과 바이트 단위로 같다**.
- 코드 주석·UI 문구·커밋 메시지는 한국어(영어 사전 값은 영어). 커밋 메시지 끝에 `Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC`.
- 영어 문체: 짧은 평서문, sentence case, 느낌표 없음. 용어는 스펙 §7 용어집.
- 테스트 명령: contracts `pnpm --filter @damwha/contracts test` · fe `pnpm --filter damwha-fe exec vitest run <경로>` / 타입 `pnpm --filter damwha-fe exec tsc -b` / `pnpm fe lint` · desktop `pnpm --filter damwha-desktop exec vitest run <경로>`(**`pnpm desktop exec`는 0개 실행·exit 0이라 쓰지 않는다**) / 타입 `pnpm desktop lint` · be 단위 `pnpm --filter damwha-be exec jest --runInBand <패턴>` / 타입 `pnpm --filter damwha-be exec tsc --noEmit` · worker `uv run --directory be/worker pytest -q <파일>`(`pnpm worker:test -- <경로>`는 인자가 안 넘어간다) / 전체 `pnpm worker:test`.
- 루트에서 패키지를 직접 띄우지 않는다. `npm install` 금지(`pnpm install`은 루트에서). 파괴적 git 명령 금지.

## Review Focus

1. **⌘R 새로고침 뒤 언어가 옛 값으로 돌아가지 않는가.** 설정에서 영어로 바꾼 뒤 다른 화면으로 이동해(`?lang` 사라짐) ⌘R — 영어로 떠야 한다. FE가 main에서 받은(`show`) 값을 localStorage에 캐시하고, 초기 해석이 `?lang` → localStorage 순이라 성립한다. Task 4의 "show는 캐시를 쓴다" 테스트가 지킨다.
2. **main이 듣지 않는 동안 고른 언어가 쌓이지 않는가.** 브라우저 단독(브리지를 묻는 main이 없음)에서 언어를 열 번 바꾸면 대기열이 열 개가 되면 안 된다 — 마지막 하나만 남는다. Task 4의 "대기열은 마지막 값 하나" 테스트.
3. **main이 저장에 실패하면 화면이 되돌아가는가.** `ui-language.json` 쓰기가 실패하면 main은 이전 값을 `show`하고, FE는 그 값으로 돌아간다. Task 8의 "저장 실패 → 이전 값 show" 테스트.
4. **override가 있는 업로드·재처리·라이브에서 요약 언어가 떨어지지 않는가.** `resolveProcessingConfig`의 프리셋 분기와 개별 노브 분기 모두 전역 `summary_language`를 이어받는다. Task 10의 두 테스트.
5. **큐에 남은 옛 job이 새 worker에서 도는가.** v5 process_meeting(라이브 v1 안에 박힌 것 포함, API 마무리 경로 포함), v1 summarize/extract가 `transcript`로 돈다. Task 13·15의 변환 테스트와 Task 12의 API 마무리 e2e.

---

## Part 0 — 공유 언어 규칙

### Task 1: contracts — 언어 목록과 `pickUiLanguage`

**Files:**
- Modify: `packages/contracts/src/index.ts` (파일 끝에 추가)
- Modify: `packages/contracts/package.json` (`test` 스크립트)
- Create: `packages/contracts/test/languages.test.cjs`
- Modify: `CLAUDE.md` (루트, Monorepo map 표의 contracts 행)

**Interfaces:**
- Produces: `UI_LANGUAGES: readonly ['ko','en']`, `type UiLanguage`, `SUMMARY_LANGUAGES: readonly ['transcript','ko','en']`, `type SummaryLanguage`, `isUiLanguage(v: unknown): v is UiLanguage`, `isSummaryLanguage(v: unknown): v is SummaryLanguage`, `pickUiLanguage(locales: readonly string[]): UiLanguage`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/contracts/test/languages.test.cjs`:

```js
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
```

`packages/contracts/package.json`의 `scripts`에 추가:

```json
"test": "pnpm run build && node --test \"test/*.test.cjs\""
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @damwha/contracts test`
Expected: FAIL — `pickUiLanguage is not a function` (또는 `UI_LANGUAGES` undefined).

- [ ] **Step 3: 구현한다**

`packages/contracts/src/index.ts` 끝에:

```ts
/**
 * 화면 언어 (다국어 스펙 2026-09-26 §3.1). FE와 desktop이 같은 규칙으로 기기 언어에서 고른다.
 * desktop은 런타임 의존성이 없어 `desktop/src/i18n/locale.ts`에 사본을 두고, 그쪽 테스트가
 * 이 함수와 같은 답을 내는지 확인한다 — 여기를 고치면 그쪽도 고친다.
 */
export const UI_LANGUAGES = ['ko', 'en'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

/**
 * 요약·렌즈 출력 언어 (스펙 §5). `transcript`는 녹취 언어를 따른다 — 이 설정이 생기기 전의 동작이고,
 * 옛 job 버전은 이 값으로 읽힌다.
 */
export const SUMMARY_LANGUAGES = ['transcript', 'ko', 'en'] as const;
export type SummaryLanguage = (typeof SUMMARY_LANGUAGES)[number];

export function isUiLanguage(v: unknown): v is UiLanguage {
  return (UI_LANGUAGES as readonly unknown[]).includes(v);
}

export function isSummaryLanguage(v: unknown): v is SummaryLanguage {
  return (SUMMARY_LANGUAGES as readonly unknown[]).includes(v);
}

/**
 * 선호 언어 목록(BCP 47, `navigator.languages`·`app.getPreferredSystemLanguages()`)에서 앞에서부터
 * 처음 걸리는 ko/en. 없으면 en — 한국어도 영어도 아닌 사람에게는 영어가 더 읽힐 가능성이 높다.
 * 접두 비교는 구분자까지 본다: `kok`(콘칸어)는 `ko`가 아니다.
 */
export function pickUiLanguage(locales: readonly string[]): UiLanguage {
  for (const raw of locales) {
    const tag = raw.trim().toLowerCase();
    for (const lang of UI_LANGUAGES) {
      if (tag === lang || tag.startsWith(`${lang}-`) || tag.startsWith(`${lang}_`)) return lang;
    }
  }
  return 'en';
}
```

파일 머리 주석의 "Keep this package dependency-free and value-only."를 "Keep this package dependency-free: values and pure helpers only."로 고친다.

루트 `CLAUDE.md` 표의 contracts 행 설명을 `Wire enums and pure helpers both Node packages must agree on (\`SUMMARY_MODELS\`, \`WHISPER_MODELS\`, \`PRESET_NAMES\`, \`DEVICES\`, \`UI_LANGUAGES\`, \`SUMMARY_LANGUAGES\`, \`pickUiLanguage\`). Dependency-free.`로 바꾼다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm --filter @damwha/contracts test`
Expected: PASS (3 tests).

- [ ] **Step 5: 커밋**

```bash
git add packages/contracts CLAUDE.md
git commit -m "feat(contracts): 화면·요약 언어 목록과 pickUiLanguage

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

### Task 2: desktop — 언어 규칙 사본과 대조 테스트

**Files:**
- Create: `desktop/src/i18n/locale.ts`
- Create: `desktop/tests/i18n/locale.test.ts`
- Modify: `desktop/package.json` (devDependencies에 `"@damwha/contracts": "workspace:*"`)

**Interfaces:**
- Consumes: Task 1의 contracts export (테스트에서만).
- Produces: `desktop/src/i18n/locale.ts` — `UI_LANGUAGES`, `type UiLanguage`, `isUiLanguage(v: unknown): v is UiLanguage`, `pickUiLanguage(locales: readonly string[]): UiLanguage`.

- [ ] **Step 1: devDependency를 더하고 설치한다**

`desktop/package.json`의 `devDependencies`에 `"@damwha/contracts": "workspace:*"`를 넣고(알파벳 순서 맨 앞), 루트에서:

Run: `pnpm install`
Expected: lockfile에 `desktop` → `@damwha/contracts` link가 생긴다. `dependencies` 필드는 여전히 없다(asar 구성 불변).

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`desktop/tests/i18n/locale.test.ts`:

```ts
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
```

- [ ] **Step 3: 실패를 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/i18n/locale.test.ts`
Expected: FAIL — `Cannot find module '../../src/i18n/locale'`.

- [ ] **Step 4: 구현한다**

`desktop/src/i18n/locale.ts`:

```ts
/**
 * 화면 언어 규칙 — `@damwha/contracts`의 사본이다 (다국어 스펙 2026-09-26 §3.1).
 *
 * 사본인 이유: desktop에는 런타임 dependencies가 없고 asar에는 컴파일된 main만 들어간다
 * (electron-builder.yml). contracts를 들이면 패키징이 바뀐다. 두 벌이 어긋나면
 * tests/i18n/locale.test.ts가 잡는다 — 여기를 고치면 contracts도 고친다.
 */
export const UI_LANGUAGES = ["ko", "en"] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

export function isUiLanguage(v: unknown): v is UiLanguage {
  return (UI_LANGUAGES as readonly unknown[]).includes(v);
}

export function pickUiLanguage(locales: readonly string[]): UiLanguage {
  for (const raw of locales) {
    const tag = raw.trim().toLowerCase();
    for (const lang of UI_LANGUAGES) {
      if (tag === lang || tag.startsWith(`${lang}-`) || tag.startsWith(`${lang}_`)) return lang;
    }
  }
  return "en";
}
```

- [ ] **Step 5: 통과와 타입을 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/i18n/locale.test.ts && pnpm desktop lint`
Expected: PASS, lint 오류 없음.

- [ ] **Step 6: 커밋**

```bash
git add desktop/package.json desktop/src/i18n desktop/tests/i18n pnpm-lock.yaml
git commit -m "feat(desktop): 화면 언어 규칙 사본 — contracts와 대조 테스트로 묶는다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

## Part A — 화면 언어 기반 (스펙 §9의 1단계)

### Task 3: FE — i18n 코어와 첫 사전

**Files:**
- Modify: `fe/package.json` (dependencies: `i18next@^26.4.2`, `react-i18next@^17.0.15`)
- Create: `fe/src/shared/i18n/locale-shape.ts`
- Create: `fe/src/shared/i18n/locales/ko/common.ts`, `fe/src/shared/i18n/locales/ko/settings.ts`, `fe/src/shared/i18n/locales/ko/index.ts`
- Create: `fe/src/shared/i18n/locales/en/common.ts`, `fe/src/shared/i18n/locales/en/settings.ts`, `fe/src/shared/i18n/locales/en/index.ts`
- Create: `fe/src/shared/i18n/create-i18n.ts`
- Create: `fe/src/shared/i18n/i18next.d.ts`
- Test: `fe/src/shared/i18n/create-i18n.test.ts`

**Interfaces:**
- Produces: `createAppI18n(lng: UiLanguage): i18n` (i18next 인스턴스, 동기 초기화, `initReactI18next` 연결), `ko`·`en` 리소스(네임스페이스 `common`·`settings`), `type LocaleShape<T>`.

- [ ] **Step 1: 의존성을 설치한다**

Run: `pnpm --filter damwha-fe add i18next@^26.4.2 react-i18next@^17.0.15`
Expected: `fe/package.json` dependencies에 두 줄, 루트 `pnpm-lock.yaml` 갱신.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`fe/src/shared/i18n/create-i18n.test.ts`:

```ts
import { expect, test } from "vitest";
import { createAppI18n } from "./create-i18n";

test("초기화가 동기다 — 만든 직후 t가 번역을 돌려준다", () => {
  const i = createAppI18n("en");
  expect(i.t("settings:general.title")).toBe("General");
});

test("언어를 바꾸면 같은 키가 그 언어로 나온다", async () => {
  const i = createAppI18n("ko");
  expect(i.t("settings:general.title")).toBe("일반");
  await i.changeLanguage("en");
  expect(i.t("settings:general.title")).toBe("General");
});

test("보간은 HTML 이스케이프를 하지 않는다 — React가 한다", () => {
  const i = createAppI18n("en");
  expect(i.t("common:test.echo", { value: "<b>" })).toBe("<b>");
});
```

- [ ] **Step 3: 실패를 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run src/shared/i18n/create-i18n.test.ts`
Expected: FAIL — `Cannot find module './create-i18n'`.

- [ ] **Step 4: 사전 모양 타입과 사전을 쓴다**

`fe/src/shared/i18n/locale-shape.ts`:

```ts
/**
 * 사전의 모양 — 값이 문자열인 자리는 아무 문자열이나, 객체인 자리는 같은 키의 객체.
 * `en`이 `satisfies LocaleShape<typeof ko>`를 걸어 키가 빠지거나 남으면 `tsc -b`가 실패한다
 * (다국어 스펙 §4.3). 복수형 키는 ko에도 `_one`·`_other`를 둘 다 둬야 모양이 같다.
 */
export type LocaleShape<T> = {
  [K in keyof T]: T[K] extends string ? string : LocaleShape<T[K]>;
};
```

`fe/src/shared/i18n/locales/ko/common.ts`:

```ts
/** 여러 화면이 함께 쓰는 문구. */
export const common = {
  test: {
    /** 인프라 테스트 전용 — 보간이 이스케이프되지 않는지 본다. */
    echo: "{{value}}",
  },
};
```

`fe/src/shared/i18n/locales/ko/settings.ts`:

```ts
/** 설정 화면 (pages/settings.tsx와 features/settings). */
export const settings = {
  general: {
    title: "일반",
    description: "앱 전체에 적용되는 설정이에요.",
    displayLanguage: {
      label: "화면 언어",
      hint: "메뉴와 화면에 쓰는 언어예요.",
    },
  },
};
```

`fe/src/shared/i18n/locales/ko/index.ts`:

```ts
import { common } from "./common";
import { settings } from "./settings";

/** 기준 사전. 네임스페이스 = 최상위 키. 새 네임스페이스는 여기와 en/index.ts, create-i18n.ts의 NAMESPACES에 함께 더한다. */
export const ko = { common, settings };
```

`fe/src/shared/i18n/locales/en/common.ts`:

```ts
import type { LocaleShape } from "../../locale-shape";
import type { common as ko } from "../ko/common";

export const common = {
  test: {
    echo: "{{value}}",
  },
} satisfies LocaleShape<typeof ko>;
```

`fe/src/shared/i18n/locales/en/settings.ts`:

```ts
import type { LocaleShape } from "../../locale-shape";
import type { settings as ko } from "../ko/settings";

export const settings = {
  general: {
    title: "General",
    description: "Settings that apply to the whole app.",
    displayLanguage: {
      label: "Display language",
      hint: "The language used for menus and screens.",
    },
  },
} satisfies LocaleShape<typeof ko>;
```

`fe/src/shared/i18n/locales/en/index.ts`:

```ts
import { common } from "./common";
import { settings } from "./settings";

export const en = { common, settings };
```

- [ ] **Step 5: 인스턴스와 타입 선언을 쓴다**

`fe/src/shared/i18n/create-i18n.ts`:

```ts
import i18next, { type i18n } from "i18next";
import { initReactI18next } from "react-i18next";
import { UI_LANGUAGES, type UiLanguage } from "@damwha/contracts";
import { en } from "./locales/en";
import { ko } from "./locales/ko";

export const NAMESPACES = ["common", "settings"] as const;

/**
 * 앱의 i18next 인스턴스. **동기로** 초기화한다(`initAsync: false`) — 리소스가 번들 안에 있으니
 * 기다릴 것이 없고, 비동기면 첫 렌더가 키 문자열을 한 번 그린다.
 * `initReactI18next`가 이 인스턴스를 react-i18next의 전역으로 걸어, Provider 없이도
 * `useTranslation`이 이것을 쓴다(테스트의 개별 렌더 포함).
 */
export function createAppI18n(lng: UiLanguage): i18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng,
    fallbackLng: "ko",
    supportedLngs: [...UI_LANGUAGES],
    ns: [...NAMESPACES],
    defaultNS: "common",
    resources: { ko, en },
    initAsync: false,
    // React가 텍스트를 이스케이프한다 — 여기서도 하면 `&lt;`가 화면에 보인다.
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance;
}
```

`fe/src/shared/i18n/i18next.d.ts`:

```ts
import "i18next";
import type { ko } from "./locales/ko";

// t("settings:general.title")의 키를 타입 검사한다. 기준은 ko — en은 satisfies로 같은 모양이 강제된다.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: typeof ko;
  }
}
```

- [ ] **Step 6: 통과와 타입을 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run src/shared/i18n/create-i18n.test.ts && pnpm --filter damwha-fe exec tsc -b`
Expected: PASS (3 tests), tsc 오류 없음.

- [ ] **Step 7: 키 누락이 정말 잡히는지 한 번 확인한다(되돌린다)**

`en/settings.ts`에서 `hint` 줄을 지우고 `pnpm --filter damwha-fe exec tsc -b` → `Property 'hint' is missing` 오류가 나는지 본다. 확인 후 되돌린다.

- [ ] **Step 8: 커밋**

```bash
git add fe/package.json pnpm-lock.yaml fe/src/shared/i18n
git commit -m "feat(fe): i18n 코어 — i18next 동기 초기화, TS 사전과 키 모양 검사

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

### Task 4: FE — 언어 저장소, desktop 브리지, 앱 연결

**Files:**
- Create: `fe/src/shared/i18n/language-store.ts`
- Create: `fe/src/shared/i18n/index.ts`
- Modify: `fe/src/features/meeting/lib/desktop-bridge.ts`
- Modify: `fe/src/main.tsx`
- Modify: `fe/vitest.setup.ts`
- Test: `fe/src/shared/i18n/language-store.test.ts`, `fe/src/shared/i18n/index.test.ts`

**Interfaces:**
- Consumes: `createAppI18n` (Task 3), contracts `isUiLanguage`·`pickUiLanguage`.
- Produces:
  - `UI_LANGUAGE_STORAGE_KEY = "damwha:ui-language"`
  - `interface LanguageEnv { search(): string; readStored(): string | null; writeStored(v: string): void; systemLanguages(): readonly string[]; apply(lang: UiLanguage): void }`
  - `resolveInitialLanguage(env: LanguageEnv): UiLanguage`
  - `interface UiLanguageBridge { show(lang: unknown): void; next(): Promise<UiLanguage> }`
  - `createLanguageStore(env): { getSnapshot(): UiLanguage; subscribe(l): () => void; choose(lang: UiLanguage): void; bridge: UiLanguageBridge; start(): void }`
  - `languageStore`, `i18n` (싱글턴, `shared/i18n/index.ts`), `useUiLanguage(): UiLanguage`
  - `window.__damwha_desktop.uiLanguage` (desktop Task 8이 이 이름으로 부른다)

- [ ] **Step 1: 실패하는 저장소 테스트를 쓴다**

`fe/src/shared/i18n/language-store.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import {
  createLanguageStore,
  resolveInitialLanguage,
  type LanguageEnv,
} from "./language-store";

function fakeEnv(over: Partial<LanguageEnv> & { stored?: string | null } = {}) {
  let stored = over.stored ?? null;
  const env: LanguageEnv & { writes: string[]; applied: string[] } = {
    writes: [],
    applied: [],
    search: () => "",
    readStored: () => stored,
    writeStored(v) {
      stored = v;
      env.writes.push(v);
    },
    systemLanguages: () => ["ko-KR"],
    apply(lang) {
      env.applied.push(lang);
    },
    ...over,
  };
  return env;
}

test("초기 언어: ?lang → 저장값 → 기기 언어", () => {
  expect(resolveInitialLanguage(fakeEnv({ search: () => "?lang=en", stored: "ko" }))).toBe("en");
  expect(resolveInitialLanguage(fakeEnv({ search: () => "?lang=fr", stored: "en" }))).toBe("en");
  expect(resolveInitialLanguage(fakeEnv({ stored: "en" }))).toBe("en");
  expect(resolveInitialLanguage(fakeEnv({ stored: "xx" }))).toBe("ko");
  expect(resolveInitialLanguage(fakeEnv({ systemLanguages: () => ["ja-JP"] }))).toBe("en");
});

test("저장소 읽기가 던져도 기기 언어로 뜬다", () => {
  const env = fakeEnv({
    readStored: () => {
      throw new Error("blocked");
    },
  });
  expect(resolveInitialLanguage(env)).toBe("ko");
});

test("기기 언어로 떴을 때는 아무것도 저장하지 않는다 — 고르기 전까지 기기를 따른다", () => {
  const env = fakeEnv();
  const s = createLanguageStore(env);
  s.start();
  expect(s.getSnapshot()).toBe("ko");
  expect(env.writes).toEqual([]);
  expect(env.applied).toEqual(["ko"]);
});

test("choose: 저장하고, 적용하고, 구독자에게 알리고, main이 물으면 그 값을 준다", async () => {
  const env = fakeEnv();
  const s = createLanguageStore(env);
  const listener = vi.fn();
  s.subscribe(listener);
  const asked = s.bridge.next();
  s.choose("en");
  expect(s.getSnapshot()).toBe("en");
  expect(env.writes).toEqual(["en"]);
  expect(env.applied).toEqual(["en"]);
  expect(listener).toHaveBeenCalledTimes(1);
  await expect(asked).resolves.toBe("en");
});

test("main이 묻기 전에 여러 번 고르면 대기열에는 마지막 값 하나만 남는다", async () => {
  const s = createLanguageStore(fakeEnv());
  s.choose("en");
  s.choose("ko");
  s.choose("en");
  await expect(s.bridge.next()).resolves.toBe("en");
  let second: string | null = null;
  void s.bridge.next().then((v) => (second = v));
  await Promise.resolve();
  expect(second).toBeNull(); // 더 쌓인 것이 없다
});

test("show(main이 확정한 값): 적용하고 캐시로 저장하지만 main에게 되돌려 보내지 않는다", async () => {
  const env = fakeEnv();
  const s = createLanguageStore(env);
  s.bridge.show("en");
  expect(s.getSnapshot()).toBe("en");
  expect(env.writes).toEqual(["en"]); // ⌘R로 ?lang 없이 다시 떠도 이 값으로 뜬다
  let got: string | null = null;
  void s.bridge.next().then((v) => (got = v));
  await Promise.resolve();
  expect(got).toBeNull();
});

test("show는 모르는 값을 무시한다 — 렌더러 밖에서 온 데이터다", () => {
  const s = createLanguageStore(fakeEnv());
  s.bridge.show("fr");
  s.bridge.show(null);
  expect(s.getSnapshot()).toBe("ko");
});

test("저장 실패해도 이번 세션에는 고른 언어가 적용된다", () => {
  const env = fakeEnv({
    writeStored: () => {
      throw new Error("quota");
    },
  });
  const s = createLanguageStore(env);
  s.choose("en");
  expect(s.getSnapshot()).toBe("en");
});

test("같은 값이면 다시 적용하지 않는다", () => {
  const env = fakeEnv();
  const s = createLanguageStore(env);
  const listener = vi.fn();
  s.subscribe(listener);
  s.bridge.show("ko");
  expect(listener).not.toHaveBeenCalled();
  expect(env.applied).toEqual([]);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run src/shared/i18n/language-store.test.ts`
Expected: FAIL — `Cannot find module './language-store'`.

- [ ] **Step 3: 저장소를 구현한다**

`fe/src/shared/i18n/language-store.ts`:

```ts
import { isUiLanguage, pickUiLanguage, type UiLanguage } from "@damwha/contracts";

/**
 * 화면 언어 — 첫 값을 정하고, 바뀌면 <html lang>과 구독자(i18n)에게 알리고, desktop main과 주고받는다
 * (다국어 스펙 §4). 모양은 shared/lib/theme.ts의 저장소를 따른다.
 *
 * 원본이 둘이다. desktop 안에서는 main(ui-language.json)이 원본이고 이 저장소는 캐시다 — main이 준 값(show)을
 * localStorage에 적어 두어, ⌘R로 ?lang 없는 URL이 다시 떠도 같은 언어로 뜬다. 브라우저 단독에서는 localStorage가
 * 원본이고, 사람이 고를 때만 쓴다(그 전에는 기기 언어를 따른다).
 */
export const UI_LANGUAGE_STORAGE_KEY = "damwha:ui-language";

export interface LanguageEnv {
  /** `location.search` — desktop main이 첫 로드에 `?lang=`을 붙인다. */
  search(): string;
  /** 던질 수 있다 — 사이트 데이터가 막힌 브라우저. */
  readStored(): string | null;
  /** 던질 수 있다. */
  writeStored(v: string): void;
  systemLanguages(): readonly string[];
  apply(lang: UiLanguage): void;
}

export function resolveInitialLanguage(env: LanguageEnv): UiLanguage {
  const fromQuery = new URLSearchParams(env.search()).get("lang");
  if (isUiLanguage(fromQuery)) return fromQuery;
  try {
    const stored = env.readStored();
    if (isUiLanguage(stored)) return stored;
  } catch {
    // 막힌 저장소 — 기기 언어로 간다.
  }
  return pickUiLanguage(env.systemLanguages());
}

/** main이 부르는 두 함수 (desktop windows/language-bridge.ts). 렌더러가 먼저 여는 채널이 아니다. */
export interface UiLanguageBridge {
  /** main이 확정한 값. 렌더러 밖에서 온 데이터라 모르는 값은 버린다. */
  show(lang: unknown): void;
  /** 사람이 고른 다음 값. 고를 때까지 기다린다. */
  next(): Promise<UiLanguage>;
}

export function createLanguageStore(env: LanguageEnv) {
  let language = resolveInitialLanguage(env);
  const listeners = new Set<() => void>();
  // 대기열은 **마지막 값 하나**다. main이 묻지 않는 동안(브라우저 단독, 붙기 전) 고른 값이 쌓이면
  // 나중에 main이 옛 값들을 차례로 받아 저장·메뉴 재구성을 헛돈다.
  let queued: UiLanguage | null = null;
  const waiting: Array<(lang: UiLanguage) => void> = [];

  const persist = (next: UiLanguage) => {
    try {
      env.writeStored(next);
    } catch {
      // 저장 실패 — 이번 세션에는 적용된다. 다음 실행은 ?lang 또는 기기 언어로 뜬다.
    }
  };

  const set = (next: UiLanguage) => {
    if (next === language) return;
    language = next;
    env.apply(next);
    listeners.forEach((l) => l());
  };

  return {
    getSnapshot: (): UiLanguage => language,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 사람이 설정에서 골랐다. */
    choose(next: UiLanguage): void {
      persist(next);
      set(next);
      const resolve = waiting.shift();
      if (resolve !== undefined) resolve(next);
      else queued = next;
    },
    bridge: {
      show(raw: unknown): void {
        if (!isUiLanguage(raw)) return;
        persist(raw);
        set(raw);
      },
      next(): Promise<UiLanguage> {
        if (queued !== null) {
          const v = queued;
          queued = null;
          return Promise.resolve(v);
        }
        return new Promise((resolve) => waiting.push(resolve));
      },
    } satisfies UiLanguageBridge,
    /** 한 번만 부른다(main.tsx). 첫 값을 <html lang>에 적는다. */
    start(): void {
      env.apply(language);
    },
  };
}

export type LanguageStore = ReturnType<typeof createLanguageStore>;

export function browserLanguageEnv(w: Window = window): LanguageEnv {
  return {
    search: () => w.location.search,
    readStored: () => w.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY),
    writeStored: (v) => w.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, v),
    systemLanguages: () =>
      w.navigator.languages?.length ? w.navigator.languages : [w.navigator.language],
    apply: (lang) => {
      w.document.documentElement.lang = lang;
    },
  };
}
```

- [ ] **Step 4: 저장소 테스트 통과를 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run src/shared/i18n/language-store.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: 싱글턴·훅·연결 테스트를 쓴다**

`fe/src/shared/i18n/index.test.ts`:

```ts
import { afterEach, expect, test } from "vitest";
import { i18n, languageStore } from "./index";

afterEach(() => {
  languageStore.bridge.show("ko");
});

test("테스트 환경은 한국어로 시작한다 (vitest.setup.ts가 저장값을 ko로 둔다)", () => {
  expect(languageStore.getSnapshot()).toBe("ko");
  expect(i18n.language).toBe("ko");
});

test("저장소가 바뀌면 i18n이 따라간다", () => {
  languageStore.bridge.show("en");
  expect(i18n.language).toBe("en");
  expect(i18n.t("settings:general.title")).toBe("General");
});
```

- [ ] **Step 6: 싱글턴·훅을 구현하고 테스트 환경을 ko로 고정한다**

`fe/src/shared/i18n/index.ts`:

```ts
import { createAppI18n } from "./create-i18n";
import { browserLanguageEnv, createLanguageStore } from "./language-store";

export const languageStore = createLanguageStore(browserLanguageEnv());
export const i18n = createAppI18n(languageStore.getSnapshot());

// 저장소가 원본, i18n은 따라간다. changeLanguage는 리소스가 번들 안이라 동기로 끝난다.
languageStore.subscribe(() => {
  void i18n.changeLanguage(languageStore.getSnapshot());
});

export function useUiLanguage(): UiLanguage {
  return useSyncExternalStore(languageStore.subscribe, languageStore.getSnapshot);
}
```

(`index.ts` 머리에 `import { useSyncExternalStore } from "react";`와 `import type { UiLanguage } from "@damwha/contracts";`를 더한다. 훅을 별도 파일로 빼면 그 파일이 `./index`를 import하고 `index`가 그것을 재수출하는 순환이 생긴다.)

`fe/vitest.setup.ts` **맨 위**(다른 import보다 먼저 실행되도록 import 문 없이 첫 줄로 — import는 호이스팅되지만 이 파일의 import는 jest-dom뿐이라 앱 모듈을 먼저 부르지 않는다)에 추가:

```ts
// 앱 모듈이 import되며 언어 저장소를 만들기 전에 한국어로 고정한다. jsdom의 navigator.language는 en-US라
// 이것이 없으면 한글 문구로 찾는 기존 테스트가 전부 영어 화면을 본다 (다국어 스펙 §8).
// 키는 shared/i18n/language-store.ts의 UI_LANGUAGE_STORAGE_KEY — 여기서 import하면 저장소가 먼저 만들어진다.
window.localStorage.setItem("damwha:ui-language", "ko");
```

- [ ] **Step 7: 연결 테스트 통과를 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run src/shared/i18n`
Expected: PASS.

- [ ] **Step 8: 앱과 desktop 브리지에 건다**

`fe/src/main.tsx`: `themeStore` import 옆에 `import { languageStore } from "@/shared/i18n";`을 더하고, `themeStore.start();` 다음 줄에:

```ts
// <html lang>을 첫 언어로. 사전은 import 시점에 이미 그 언어로 초기화됐다.
languageStore.start();
```

`fe/src/features/meeting/lib/desktop-bridge.ts`:
- import 추가: `import { languageStore } from "@/shared/i18n";` 와 `import type { UiLanguageBridge } from "@/shared/i18n/language-store";`
- `DesktopBridge`에 필드 추가:

```ts
  /** 화면 언어 (다국어 스펙 §4.1). main의 language-bridge.ts가 이 이름으로 부른다 — 이름을 바꾸면 조용히 끊긴다. */
  uiLanguage: UiLanguageBridge;
```

- `installDesktopBridge`의 객체에 `uiLanguage: languageStore.bridge,` 추가.

기존 `desktop-bridge.test.ts`에 테스트 하나 추가:

```ts
test("uiLanguage 브리지를 건다 — main이 이 이름으로 부른다", () => {
  const w = {} as Window;
  installDesktopBridge(w);
  expect(typeof w.__damwha_desktop?.uiLanguage.next).toBe("function");
  expect(typeof w.__damwha_desktop?.uiLanguage.show).toBe("function");
});
```

(파일의 기존 import 모양을 따른다. `test`/`expect`가 이미 import돼 있다.)

- [ ] **Step 9: FE 전체 테스트와 타입을 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run && pnpm --filter damwha-fe exec tsc -b && pnpm fe lint`
Expected: 전부 PASS — 기존 테스트가 하나도 깨지지 않는다(아직 옮긴 문구가 없다).

- [ ] **Step 10: 커밋**

```bash
git add fe/src/shared/i18n fe/src/main.tsx fe/vitest.setup.ts fe/src/features/meeting/lib/desktop-bridge.ts fe/src/features/meeting/lib/desktop-bridge.test.ts
git commit -m "feat(fe): 화면 언어 저장소 — ?lang·저장값·기기 언어, desktop uiLanguage 브리지

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

### Task 5: FE — 설정 "일반" 섹션의 화면 언어

**Files:**
- Create: `fe/src/features/settings/ui/general-settings-section.tsx`
- Create: `fe/src/features/settings/ui/general-settings-section.test.tsx`
- Modify: `fe/src/pages/settings.tsx` (처리 방식 섹션 앞에 배치)

**Interfaces:**
- Consumes: `languageStore`, `useUiLanguage` (Task 4), 사전 `settings:general.*` (Task 3).
- Produces: `GeneralSettingsSection` 컴포넌트.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`fe/src/features/settings/ui/general-settings-section.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { languageStore } from "@/shared/i18n";
import { GeneralSettingsSection } from "./general-settings-section";

afterEach(() => {
  cleanup();
  languageStore.bridge.show("ko");
});

async function pick(name: RegExp) {
  const trigger = screen.getByLabelText(/화면 언어|Display language/);
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name }));
}

test("선택지는 각 언어의 자기 이름이다 — 읽지 못하는 화면에서도 자기 언어는 찾는다", async () => {
  render(<GeneralSettingsSection />);
  const trigger = screen.getByLabelText("화면 언어");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(await screen.findByRole("option", { name: "한국어" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "English" })).toBeTruthy();
});

test("English를 고르면 화면이 바로 영어가 되고, <html lang>이 바뀌고, main에 전달된다", async () => {
  render(<GeneralSettingsSection />);
  const asked = languageStore.bridge.next();
  await pick(/English/);
  expect(await screen.findByRole("heading", { name: "General" })).toBeTruthy();
  expect(document.documentElement.lang).toBe("en");
  await expect(asked).resolves.toBe("en");
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run src/features/settings/ui/general-settings-section.test.tsx`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현한다**

`fe/src/features/settings/ui/general-settings-section.tsx` (Select import 경로와 Card 사용은 `pages/settings.tsx`·`processing-settings-form.tsx`의 기존 import를 그대로 따른다 — `@/shared/ui/card`, `@/shared/ui/select`):

```tsx
import { useTranslation } from "react-i18next";
import { UI_LANGUAGES, isUiLanguage, type UiLanguage } from "@damwha/contracts";
import { languageStore, useUiLanguage } from "@/shared/i18n";
import { Card } from "@/shared/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";

/** 각 언어의 자기 이름. 사전에 두지 않는다 — 어느 화면 언어에서도 같은 글자여야 한다 (다국어 스펙 §4.3). */
const AUTONYMS: Record<UiLanguage, string> = {
  ko: "한국어", // i18n-allow: autonym
  en: "English",
};

/** 설정 › 일반. 앱 전체에 걸리는 값 — 지금은 화면 언어 하나. */
export function GeneralSettingsSection() {
  const { t } = useTranslation("settings");
  const language = useUiLanguage();
  return (
    <section aria-labelledby="settings-general">
      <Card className="flex flex-col gap-5">
        <header className="flex flex-col gap-1">
          <h2 id="settings-general" className="text-h2 font-semibold text-foreground">
            {t("general.title")}
          </h2>
          <p className="text-sm text-[color:var(--text-muted)]">{t("general.description")}</p>
        </header>
        <div className="flex flex-col gap-1.5">
          <span
            id="settings-display-language"
            className="text-sm font-medium text-[color:var(--text-secondary)]"
          >
            {t("general.displayLanguage.label")}
          </span>
          <Select
            value={language}
            onValueChange={(v) => {
              if (isUiLanguage(v)) languageStore.choose(v);
            }}
          >
            <SelectTrigger aria-labelledby="settings-display-language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UI_LANGUAGES.map((lang) => (
                <SelectItem key={lang} value={lang}>
                  {AUTONYMS[lang]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-[color:var(--text-muted)]">
            {t("general.displayLanguage.hint")}
          </p>
        </div>
      </Card>
    </section>
  );
}
```

`fe/src/pages/settings.tsx`: import `GeneralSettingsSection`을 더하고, `<section aria-labelledby="settings-processing">` **앞에** `<GeneralSettingsSection />`을 둔다. 파일 머리 주석의 "섹션 셋(처리 방식 · 모델 · 허깅페이스 토큰)"을 "섹션 넷(일반 · 처리 방식 · 모델 · 허깅페이스 토큰)"으로 고친다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run src/features/settings src/pages/settings.test.tsx && pnpm --filter damwha-fe exec tsc -b && pnpm fe lint`
Expected: PASS. `pages/settings.test.tsx`가 섹션 수·제목 순서를 단정하고 있어 깨지면, 새 섹션이 맨 앞에 온 것을 반영해 그 단정만 고친다(한국어 문구는 그대로).

- [ ] **Step 5: 브라우저에서 눈으로 확인한다**

`pnpm db:up`이 떠 있는 상태에서 `pnpm dev` → `http://localhost:5173/settings`. "일반" 카드가 맨 위에 있고, English를 고르면 카드 제목이 "General"로 바뀌며, 새로고침해도 English가 유지되는지 본다(localStorage). `?lang=ko`를 붙여 열면 한국어로 뜨는지도 본다.

- [ ] **Step 6: 커밋**

```bash
git add fe/src/features/settings/ui/general-settings-section.tsx fe/src/features/settings/ui/general-settings-section.test.tsx fe/src/pages/settings.tsx
git commit -m "feat(fe): 설정 › 일반 — 화면 언어 선택

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

### Task 6: desktop — 화면 언어 저장소 (`ui-language.json`)

**Files:**
- Create: `desktop/src/config/ui-language-store.ts`
- Test: `desktop/tests/config/ui-language-store.test.ts`

**Interfaces:**
- Consumes: `isUiLanguage` (Task 2).
- Produces: `interface UiLanguageStore { read(): UiLanguage | null; write(lang: UiLanguage): void }`, `makeUiLanguageStore(userData: string): UiLanguageStore`, `UI_LANGUAGE_FILE = "ui-language.json"`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`desktop/tests/config/ui-language-store.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/config/ui-language-store.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현한다**

`desktop/src/config/ui-language-store.ts`:

```ts
import * as fs from "fs";
import * as path from "path";
import { isUiLanguage, type UiLanguage } from "../i18n/locale";

/**
 * 화면 언어의 원본 (다국어 스펙 §4.1). 파일이 없으면 기기 언어를 따른다 — 첫 실행에 쓰지 않는다.
 * 사람이 설정에서 고를 때만 쓴다(language-bridge.ts).
 *
 * 읽기는 절대 던지지 않는다: 깨진 파일 때문에 앱이 뜨지 않으면 언어를 고칠 화면에도 못 간다.
 * 쓰기는 던진다 — 호출자가 화면을 이전 값으로 되돌린다. 쓰기는 token-store.ts처럼 임시 파일 + rename.
 */
export const UI_LANGUAGE_FILE = "ui-language.json";

export interface UiLanguageStore {
  read(): UiLanguage | null;
  write(lang: UiLanguage): void;
}

export function makeUiLanguageStore(userData: string): UiLanguageStore {
  const file = path.join(userData, UI_LANGUAGE_FILE);
  return {
    read() {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed === null || typeof parsed !== "object") return null;
        const lang = (parsed as { language?: unknown }).language;
        return isUiLanguage(lang) ? lang : null;
      } catch {
        return null;
      }
    },
    write(lang) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ language: lang }), { flag: "w" });
      try {
        fs.renameSync(tmp, file);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
    },
  };
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/config/ui-language-store.test.ts && pnpm desktop lint`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add desktop/src/config/ui-language-store.ts desktop/tests/config/ui-language-store.test.ts
git commit -m "feat(desktop): 화면 언어 저장소 ui-language.json

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

### Task 7: desktop — 사전과 메뉴

**Files:**
- Create: `desktop/src/i18n/dictionary.ts`
- Test: `desktop/tests/i18n/dictionary.test.ts`
- Modify: `desktop/src/windows/menu-template.ts`
- Modify: `desktop/src/windows/menu.ts`
- Modify: `desktop/tests/windows/menu-template.test.ts`

**Interfaces:**
- Consumes: `UiLanguage` (Task 2).
- Produces: `t(lang: UiLanguage, key: DesktopKey, vars?: Record<string, string | number>): string`, `type DesktopKey`; `buildMenuTemplate(handlers, appName, opts?: { restoreEnabled: boolean; language?: UiLanguage })`; `installMenu(handlers, opts?: { restoreEnabled: boolean; language?: UiLanguage })`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`desktop/tests/i18n/dictionary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { t } from "../../src/i18n/dictionary";

describe("desktop 사전", () => {
  it("언어별 문구", () => {
    expect(t("ko", "menu.serviceStatus")).toBe("서비스 상태");
    expect(t("en", "menu.serviceStatus")).toBe("Service status");
  });
  it("{{이름}} 보간 — 없는 변수는 그대로 둔다", () => {
    expect(t("en", "test.echo", { value: 3 })).toBe("3");
    expect(t("en", "test.echo")).toBe("{{value}}");
  });
});
```

`desktop/tests/windows/menu-template.test.ts`에 추가(파일의 기존 핸들러 픽스처를 재사용 — 이름이 다르면 그 이름으로):

```ts
it("language: en이면 앱이 만든 항목이 영어다 (role 항목은 macOS가 붙인다)", () => {
  const tpl = buildMenuTemplate(handlers, "Damwha", { restoreEnabled: false, language: "en" });
  const labels = JSON.stringify(tpl.map((m) => [m.label, (m.submenu as { label?: string }[]).map((i) => i.label)]));
  expect(labels).toContain("Check for updates…");
  expect(labels).toContain("Service status");
  expect(labels).not.toMatch(/\p{Script=Hangul}/u);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/i18n/dictionary.test.ts tests/windows/menu-template.test.ts`
Expected: FAIL.

- [ ] **Step 3: 사전을 구현한다**

`desktop/src/i18n/dictionary.ts`:

```ts
import type { UiLanguage } from "./locale";

/**
 * desktop main의 사람용 문구 (다국어 스펙 §4.4). 복수형이 거의 없어 i18next를 들이지 않는다.
 * `ko`가 기준이고 `en`은 같은 키를 **모두** 가져야 한다(Record<DesktopKey, string>).
 * 로그(appendSupervisorLog)로 가는 문구는 여기 두지 않는다 — 번역하지 않는다.
 * 보간은 i18next와 같은 `{{이름}}`.
 */
const ko = {
  "test.echo": "{{value}}",
  "menu.checkForUpdates": "업데이트 확인…",
  "menu.restore": "업데이트 전으로 되돌리기…",
  "menu.services": "서비스",
  "menu.serviceStatus": "서비스 상태",
  "menu.retry": "다시 시도",
};

export type DesktopKey = keyof typeof ko;

const en: Record<DesktopKey, string> = {
  "test.echo": "{{value}}",
  "menu.checkForUpdates": "Check for updates…",
  "menu.restore": "Restore previous version…",
  // "Services"는 macOS 앱 메뉴의 서비스(role: services)와 겹쳐 읽힌다.
  "menu.services": "Status",
  "menu.serviceStatus": "Service status",
  "menu.retry": "Retry",
};

const DICT: Record<UiLanguage, Record<DesktopKey, string>> = { ko, en };

export function t(lang: UiLanguage, key: DesktopKey, vars?: Record<string, string | number>): string {
  const text = DICT[lang][key];
  if (vars === undefined) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}
```

- [ ] **Step 4: 메뉴를 사전으로 옮긴다**

`desktop/src/windows/menu-template.ts`:
- `import type { UiLanguage } from "../i18n/locale";`, `import { t } from "../i18n/dictionary";`
- 시그니처: `opts: { restoreEnabled: boolean; language?: UiLanguage } = { restoreEnabled: false }` 그리고 함수 첫 줄에 `const lang = opts.language ?? "ko";`
- 다섯 label을 `t(lang, "menu.checkForUpdates")`, `t(lang, "menu.restore")`, `t(lang, "menu.services")`, `t(lang, "menu.serviceStatus")`, `t(lang, "menu.retry")`로 바꾼다.
- 파일 머리 주석에 한 줄: "role 항목(about·hide·quit·editMenu…)의 이름은 macOS가 시스템 언어로 붙인다 — 화면 언어를 따르지 않는다."

`desktop/src/windows/menu.ts`: `installMenu`의 `opts` 타입을 `{ restoreEnabled: boolean; language?: UiLanguage }`로 넓히고 `import type { UiLanguage } from "../i18n/locale";`.

- [ ] **Step 5: 통과를 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/i18n tests/windows/menu-template.test.ts && pnpm desktop lint`
Expected: PASS — 기존 한국어 메뉴 테스트도 기본값 ko로 그대로 통과.

- [ ] **Step 6: 커밋**

```bash
git add desktop/src/i18n/dictionary.ts desktop/tests/i18n/dictionary.test.ts desktop/src/windows/menu-template.ts desktop/src/windows/menu.ts desktop/tests/windows/menu-template.test.ts
git commit -m "feat(desktop): main 사전과 메뉴의 화면 언어

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

### Task 8: desktop — 언어 브리지

**Files:**
- Create: `desktop/src/windows/language-bridge.ts`
- Test: `desktop/tests/windows/language-bridge.test.ts`

**Interfaces:**
- Consumes: `UiLanguage`, `isUiLanguage` (Task 2); FE의 `window.__damwha_desktop.uiLanguage.{next,show}` (Task 4).
- Produces:
  - `UI_LANGUAGE_ASK_SCRIPT: string`, `uiLanguageShowCall(lang: UiLanguage): string`
  - `interface LanguageBridgeDeps<W> { run(win: W, script: string): Promise<unknown>; alive(win: W): boolean; initial(): UiLanguage; save(lang: UiLanguage): void; onChange(lang: UiLanguage): void; log(line: string): void }`
  - `interface LanguageBridge<W> { attach(win: W): void; current(): UiLanguage }`
  - `createLanguageBridge<W>(deps): LanguageBridge<W>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`desktop/tests/windows/language-bridge.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  createLanguageBridge,
  UI_LANGUAGE_ASK_SCRIPT,
  uiLanguageShowCall,
  type LanguageBridgeDeps,
} from "../../src/windows/language-bridge";
import type { UiLanguage } from "../../src/i18n/locale";

/** 가짜 페이지 — next()로 돌려줄 값을 줄 세우고 show 호출을 모은다 (token-bridge.test.ts의 fakePage와 같은 모양). */
function fakePage() {
  const shown: string[] = [];
  const pending: Array<(v: unknown) => void> = [];
  let alive = true;
  let bridge = true;
  const run = vi.fn(async (_w: object, script: string): Promise<unknown> => {
    if (script === UI_LANGUAGE_ASK_SCRIPT) {
      if (!bridge) return null;
      return new Promise((r) => pending.push(r));
    }
    const m = /uiLanguage\?\.show\((.*)\);$/.exec(script);
    if (m) shown.push(JSON.parse(m[1]) as string);
    return undefined;
  });
  return {
    win: {},
    shown,
    run,
    pick(v: unknown) {
      pending.shift()?.(v);
    },
    get asking() {
      return pending.length;
    },
    kill() {
      alive = false;
    },
    noBridge() {
      bridge = false;
    },
    get alive() {
      return alive;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function make(page: ReturnType<typeof fakePage>, over: Partial<LanguageBridgeDeps<object>> = {}) {
  const saved: UiLanguage[] = [];
  const changed: UiLanguage[] = [];
  const logs: string[] = [];
  const b = createLanguageBridge<object>({
    run: page.run,
    alive: () => page.alive,
    initial: () => "ko",
    save: (l) => saved.push(l),
    onChange: (l) => changed.push(l),
    log: (l) => logs.push(l),
    ...over,
  });
  return { b, saved, changed, logs };
}

describe("language-bridge", () => {
  it("show 호출문은 값을 JSON으로만 싣는다", () => {
    expect(uiLanguageShowCall("en")).toBe('void window.__damwha_desktop?.uiLanguage?.show("en");');
  });

  it("attach: 현재 값을 밀어 넣고 묻기 시작한다", async () => {
    const page = fakePage();
    const { b } = make(page);
    b.attach(page.win);
    await flush();
    expect(page.shown).toEqual(["ko"]);
    expect(page.asking).toBe(1);
  });

  it("사람이 고르면: 저장 → current → onChange → show → 다시 묻는다", async () => {
    const page = fakePage();
    const { b, saved, changed } = make(page);
    b.attach(page.win);
    await flush();
    page.pick("en");
    await flush();
    expect(saved).toEqual(["en"]);
    expect(b.current()).toBe("en");
    expect(changed).toEqual(["en"]);
    expect(page.shown).toEqual(["ko", "en"]);
    expect(page.asking).toBe(1);
  });

  it("같은 값이면 저장·onChange 없이 show만 한다", async () => {
    const page = fakePage();
    const { b, saved, changed } = make(page);
    b.attach(page.win);
    await flush();
    page.pick("ko");
    await flush();
    expect(saved).toEqual([]);
    expect(changed).toEqual([]);
    expect(page.shown).toEqual(["ko", "ko"]);
  });

  it("저장 실패 → current는 그대로, 이전 값을 show해 화면을 되돌린다, 로그를 남긴다", async () => {
    const page = fakePage();
    const { b, changed, logs } = make(page, {
      save: () => {
        throw new Error("EACCES");
      },
    });
    b.attach(page.win);
    await flush();
    page.pick("en");
    await flush();
    expect(b.current()).toBe("ko");
    expect(changed).toEqual([]);
    expect(page.shown).toEqual(["ko", "ko"]);
    expect(logs.join("\n")).toMatch(/EACCES|Error/);
    expect(page.asking).toBe(1); // 고리는 계속 돈다
  });

  it("모르는 값은 버리고 계속 묻는다", async () => {
    const page = fakePage();
    const { b, saved } = make(page);
    b.attach(page.win);
    await flush();
    page.pick("fr");
    await flush();
    expect(saved).toEqual([]);
    expect(b.current()).toBe("ko");
    expect(page.asking).toBe(1);
  });

  it("⌘R 재부착: 옛 세대의 답은 버린다", async () => {
    const page = fakePage();
    const { b, saved } = make(page);
    b.attach(page.win);
    await flush();
    b.attach(page.win); // 새 문서
    await flush();
    expect(page.asking).toBe(2);
    page.pick("en"); // 옛 고리의 묻기가 늦게 끝났다
    await flush();
    expect(saved).toEqual([]);
    expect(b.current()).toBe("ko");
    page.pick("en"); // 새 고리
    await flush();
    expect(saved).toEqual(["en"]);
  });

  it("다리가 없는 페이지(null)면 고리를 조용히 끝낸다", async () => {
    const page = fakePage();
    page.noBridge();
    const { b } = make(page);
    b.attach(page.win);
    await flush();
    expect(page.asking).toBe(0);
  });

  it("initial은 처음 쓸 때 한 번만 부른다", () => {
    const page = fakePage();
    const initial = vi.fn((): UiLanguage => "en");
    const { b } = make(page, { initial });
    expect(initial).not.toHaveBeenCalled();
    expect(b.current()).toBe("en");
    expect(b.current()).toBe("en");
    expect(initial).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows/language-bridge.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현한다**

`desktop/src/windows/language-bridge.ts`:

```ts
import { isUiLanguage, type UiLanguage } from "../i18n/locale";

/**
 * 담화 화면 안의 화면 언어 — **흐름** (다국어 스펙 §4.1). 잎(executeJavaScript·파일 쓰기·메뉴 재구성)은
 * main.ts가 주입한다. 이 파일은 electron을 import하지 않는다.
 *
 * token-bridge.ts의 "main이 묻고 페이지가 답한다" 모양만 빌린다 — 렌더러 → main 채널을 만들지 않는다
 * (Phase 2 스펙 §6.11). 토큰 쪽의 submit·clear 직렬화(mutating)는 필요 없다: 언어 변경은 멱등이고 마지막
 * 값이 이긴다. 필요한 것은 **페이지 세대**다 — ⌘R 전 문서의 묻기가 늦게 끝나 새 문서에 옛 값을 밀어 넣지 않게.
 */
export const UI_LANGUAGE_ASK_SCRIPT =
  "window.__damwha_desktop?.uiLanguage ? window.__damwha_desktop.uiLanguage.next() : null";

/** 값은 JSON으로만 싣는다(token-bridge.ts의 hfTokenShowCall과 같은 이유). */
export function uiLanguageShowCall(lang: UiLanguage): string {
  return `void window.__damwha_desktop?.uiLanguage?.show(${JSON.stringify(lang)});`;
}

export interface LanguageBridgeDeps<W> {
  run(win: W, script: string): Promise<unknown>;
  alive(win: W): boolean;
  /** 기동 시 값 — 저장값 ?? 기기 언어. 처음 쓸 때 한 번 부른다(app ready 전에 부르지 않게). */
  initial(): UiLanguage;
  /** 파일에 쓴다. 던지면 화면을 이전 값으로 되돌린다. */
  save(lang: UiLanguage): void;
  /** 값이 실제로 바뀌었다 — 메뉴 재구성 등. */
  onChange(lang: UiLanguage): void;
  log(line: string): void;
}

export interface LanguageBridge<W> {
  /** 담화 화면이 붙었다 — 첫 로드와 ⌘R 모두. 현재 값을 밀어 넣고 새 고리를 연다. 옛 고리는 낡는다. */
  attach(win: W): void;
  current(): UiLanguage;
}

function nameOf(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : typeof e;
}

export function createLanguageBridge<W>(d: LanguageBridgeDeps<W>): LanguageBridge<W> {
  let value: UiLanguage | null = null;
  let page = 0;
  const current = (): UiLanguage => (value ??= d.initial());

  const push = (win: W) => {
    if (!d.alive(win)) return;
    d.run(win, uiLanguageShowCall(current())).catch((e: unknown) => {
      if (d.alive(win)) d.log(`담화 화면에 화면 언어를 알리지 못했어요 (${nameOf(e)}).`);
    });
  };

  const loop = async (win: W, gen: number): Promise<void> => {
    for (;;) {
      if (gen !== page || !d.alive(win)) return;
      let raw: unknown;
      try {
        raw = await d.run(win, UI_LANGUAGE_ASK_SCRIPT);
      } catch (e) {
        if (d.alive(win)) d.log(`화면 언어 요청을 기다리지 못했어요 (${nameOf(e)}).`);
        return;
      }
      if (gen !== page) return; // ⌘R 전 문서의 답 — 버린다
      if (raw === null) return; // 다리가 없는 페이지
      if (!isUiLanguage(raw)) {
        d.log(`알 수 없는 화면 언어 요청을 버렸어요 (${JSON.stringify(raw)}).`);
        continue;
      }
      if (raw !== current()) {
        try {
          d.save(raw);
          value = raw;
          d.onChange(raw);
        } catch (e) {
          d.log(`화면 언어를 저장하지 못해 이전 값으로 되돌렸어요 (${nameOf(e)}).`);
        }
      }
      push(win);
    }
  };

  return {
    attach(win) {
      const gen = ++page;
      push(win);
      void loop(win, gen);
    },
    current,
  };
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows/language-bridge.test.ts && pnpm desktop lint`
Expected: PASS (9 tests).

- [ ] **Step 5: 변이로 테스트를 확인한다(되돌린다)**

`loop`의 `if (gen !== page) return; // ⌘R 전 문서의 답` 줄을 지우고 테스트 → "⌘R 재부착" 테스트가 실패해야 한다. `push(win);`을 `if (raw === current()) push(win);`로 바꾸고 → "저장 실패" 테스트가 실패해야 한다. 둘 다 확인 후 되돌린다.

- [ ] **Step 6: 커밋**

```bash
git add desktop/src/windows/language-bridge.ts desktop/tests/windows/language-bridge.test.ts
git commit -m "feat(desktop): 화면 언어 브리지 — main이 묻고 페이지가 답한다, 페이지 세대로 ⌘R 방어

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

### Task 9: desktop — main에 잇기 (`?lang`, 부착, 메뉴)

**Files:**
- Create: `desktop/src/windows/renderer-url.ts`
- Test: `desktop/tests/windows/renderer-url.test.ts`
- Modify: `desktop/src/main.ts`

**Interfaces:**
- Consumes: Task 6 `makeUiLanguageStore`, Task 7 `installMenu(…, { language })`, Task 8 `createLanguageBridge`, Task 2 `pickUiLanguage`.
- Produces: `withUiLanguage(url: string, lang: UiLanguage): string`; main.ts의 모듈 상수 `languageBridge`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`desktop/tests/windows/renderer-url.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { withUiLanguage } from "../../src/windows/renderer-url";

describe("withUiLanguage", () => {
  it("packaged API origin", () => {
    expect(withUiLanguage("http://127.0.0.1:51234/", "en")).toBe("http://127.0.0.1:51234/?lang=en");
  });
  it("dev Vite origin (경로 없음)", () => {
    expect(withUiLanguage("http://localhost:5173", "ko")).toBe("http://localhost:5173/?lang=ko");
  });
  it("있던 쿼리는 두고 lang만 바꾼다", () => {
    expect(withUiLanguage("http://127.0.0.1:1/?a=1&lang=ko", "en")).toBe("http://127.0.0.1:1/?a=1&lang=en");
  });
  it("origin은 바뀌지 않는다 — 탐색 경계(applyNavigationBoundary)의 origin 검사를 그대로 통과한다", () => {
    const u = "http://127.0.0.1:51234/";
    expect(new URL(withUiLanguage(u, "en")).origin).toBe(new URL(u).origin);
  });
});
```

- [ ] **Step 2: 실패를 확인한 뒤 구현한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows/renderer-url.test.ts` → FAIL (모듈 없음).

`desktop/src/windows/renderer-url.ts`:

```ts
import type { UiLanguage } from "../i18n/locale";

/**
 * 담화 화면 첫 로드 URL에 화면 언어를 싣는다 (다국어 스펙 §4.1). FE는 첫 렌더 **전에** 이 값을 읽는다 —
 * 로드 뒤에 밀어 넣으면 한국어가 한 프레임 보였다가 바뀐다. 문자열 이어 붙이기가 아니라 URL API로 만든다:
 * packaged(`${apiBase}/`)와 dev(`VITE_ORIGIN`, 경로 없음) 모양이 달라서다.
 */
export function withUiLanguage(url: string, lang: UiLanguage): string {
  const u = new URL(url);
  u.searchParams.set("lang", lang);
  return u.toString();
}
```

Run again → PASS.

- [ ] **Step 3: main.ts에 잇는다**

`desktop/src/main.ts`에 다음을 한다(위치는 grep으로 찾는다 — 줄 번호는 바뀐다):

1. import 추가:

```ts
import { makeUiLanguageStore } from "./config/ui-language-store";
import { pickUiLanguage } from "./i18n/locale";
import { createLanguageBridge } from "./windows/language-bridge";
import { withUiLanguage } from "./windows/renderer-url";
```

2. `const tokenBridge = createTokenBridge<BrowserWindow>({` **앞**에:

```ts
/**
 * 담화 화면의 화면 언어 (다국어 스펙 §4.1). 흐름은 windows/language-bridge.ts — 여기는 잎이다.
 * 붙는 자리는 tokenBridge와 같은 둘이다(reattachWindow의 첫 부착, ⌘R 뒤 did-finish-load).
 */
const languageBridge = createLanguageBridge<BrowserWindow>({
  run: (w, script) => w.webContents.executeJavaScript(script),
  alive: (w) => !w.isDestroyed(),
  initial: () =>
    makeUiLanguageStore(app.getPath("userData")).read() ?? pickUiLanguage(app.getPreferredSystemLanguages()),
  save: (lang) => makeUiLanguageStore(app.getPath("userData")).write(lang),
  onChange: () => refreshMenu(),
  log: appendSupervisorLog,
});
```

(`appendSupervisorLog`·`refreshMenu`가 이 지점보다 아래에 `function`으로 선언돼 있으면 호이스팅으로 문제없다. `const` 화살표면 이 블록을 그 아래로 옮긴다 — `pnpm desktop lint`와 실행으로 확인.)

3. 메뉴 두 곳 — `installMenu(menuHandlers, { restoreEnabled: restoreAllowedNow() });`를 **둘 다**(`refreshMenu` 안과 첫 설치) 다음으로 바꾼다:

```ts
installMenu(menuHandlers, { restoreEnabled: restoreAllowedNow(), language: languageBridge.current() });
```

4. 첫 로드 — `await target.loadURL(renderer.url);`를:

```ts
await target.loadURL(withUiLanguage(renderer.url, languageBridge.current()));
```

5. 부착 두 곳 — `tokenBridge.attach(created);`(did-finish-load 안)와 `tokenBridge.attach(target);`(reattachWindow 안) **각각 바로 다음 줄**에 `languageBridge.attach(created);` / `languageBridge.attach(target);`.

- [ ] **Step 4: 타입과 desktop 전체 테스트**

Run: `pnpm desktop lint && pnpm --filter damwha-desktop exec vitest run`
Expected: PASS.

- [ ] **Step 5: 실제 앱으로 확인한다**

Run: `pnpm desktop:dev` (dev 앱 — 번들 스크립트를 먼저 돌리므로 처음엔 오래 걸린다)

확인할 것:
1. 한국어 OS라면 메뉴가 "서비스 / 서비스 상태 / 다시 시도", 설정 › 일반이 "한국어".
2. 설정에서 English → 설정 카드 제목이 "General", **앱 메뉴가 "Status / Service status / Retry"로 바뀐다**.
3. 다른 화면으로 이동한 뒤 ⌘R → 여전히 English(메뉴·일반 카드).
4. 앱을 끄고 다시 켠다 → English로 뜬다. `~/Library/Application Support/<앱 이름>/ui-language.json`에 `{"language":"en"}`.
5. 한국어로 되돌리고 파일을 지운 뒤 다시 켜면 OS 언어를 따른다.

- [ ] **Step 6: 커밋**

```bash
git add desktop/src/windows/renderer-url.ts desktop/tests/windows/renderer-url.test.ts desktop/src/main.ts
git commit -m "feat(desktop): 화면 언어를 main에 잇는다 — 첫 로드 ?lang, 두 부착 지점, 메뉴 재구성

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

## Part B — 요약 언어 (스펙 §9의 2단계)

### Task 10: BE — 처리 설정의 `summary_language`

**Files:**
- Modify: `be/src/config/env.ts`
- Modify: `be/src/settings/presets.ts`
- Modify: `be/src/settings/processing-config.ts`
- Modify: `be/src/settings/resolve-processing.ts`
- Test: `be/test/processing-config.spec.ts`, `be/test/resolve-processing.spec.ts`, `be/test/settings.service.spec.ts`
- Modify(픽스처 갱신): `be/test/job-payload.spec.ts`(resolvePreset 호출 인자), `be/test/settings.e2e-spec.ts`, `be/test/summary.e2e-spec.ts`, `be/test/meetings.e2e-spec.ts`, `be/test/system.e2e-spec.ts`(PUT 본문)

**Interfaces:**
- Consumes: contracts `SUMMARY_LANGUAGES`, `SummaryLanguage` (Task 1).
- Produces: `ProcessingConfig.summary_language: SummaryLanguage`(필수); `resolvePreset(name: PresetName, language: string, summaryLanguage: SummaryLanguage): ProcessingConfig`; env `SUMMARY_LANGUAGE`; PUT 본문 두 모양 모두 `summary_language` 필수.

- [ ] **Step 1: 실패하는 단위 테스트를 쓴다**

`be/test/processing-config.spec.ts` 끝에:

```ts
import { resolveStoredValue } from '../src/settings/processing-config';

describe('summary_language', () => {
  const env0 = process.env.SUMMARY_LANGUAGE;
  beforeAll(() => { process.env.DATABASE_URL ??= 'postgres://localhost/test'; });
  afterEach(() => {
    if (env0 === undefined) delete process.env.SUMMARY_LANGUAGE;
    else process.env.SUMMARY_LANGUAGE = env0;
  });

  it('PUT은 두 모양 모두 summary_language를 요구한다', () => {
    expect(PutProcessingValueSchema.safeParse({ preset: 'light', language: 'ko' }).success).toBe(false);
    expect(PutProcessingValueSchema.safeParse({ ...CUSTOM, language: 'ko' }).success).toBe(false);
    expect(PutProcessingValueSchema.safeParse({ preset: 'light', language: 'ko', summary_language: 'en' }).success).toBe(true);
    expect(PutProcessingValueSchema.safeParse({ ...CUSTOM, language: 'ko', summary_language: 'transcript' }).success).toBe(true);
  });

  it('PUT은 목록 밖 값을 거부한다', () => {
    expect(PutProcessingValueSchema.safeParse({ preset: 'light', language: 'ko', summary_language: 'ja' }).success).toBe(false);
  });

  it('저장값에 없으면 env SUMMARY_LANGUAGE, env도 없으면 transcript', () => {
    delete process.env.SUMMARY_LANGUAGE;
    expect(resolveStoredValue({ preset: 'light', language: 'ko' }).summary_language).toBe('transcript');
    process.env.SUMMARY_LANGUAGE = 'en';
    expect(resolveStoredValue({ preset: 'light', language: 'ko' }).summary_language).toBe('en');
    expect(resolveStoredValue({ ...CUSTOM, language: 'ko' }).summary_language).toBe('en');
  });

  it('저장값이 있으면 env보다 저장값', () => {
    process.env.SUMMARY_LANGUAGE = 'en';
    expect(resolveStoredValue({ preset: 'light', language: 'ko', summary_language: 'ko' }).summary_language).toBe('ko');
    expect(resolveStoredValue({ ...CUSTOM, language: 'ko', summary_language: 'transcript' }).summary_language).toBe('transcript');
  });
});
```

`be/test/resolve-processing.spec.ts`: 첫 줄 근처 `const global_ = resolvePreset('standard', 'ko');`를 `resolvePreset('standard', 'ko', 'en')`로 바꾸고, describe 안에 추가:

```ts
  it('프리셋 override도 전역 summary_language를 이어받는다', () => {
    expect(resolveProcessingConfig(global_, { preset: 'light' }, true).summary_language).toBe('en');
  });
  it('개별 노브 override도 전역 summary_language를 이어받는다', () => {
    expect(resolveProcessingConfig(global_, { whisper_model: 'medium' }, true).summary_language).toBe('en');
    expect(resolveProcessingConfig(global_, { preset: 'light', language: 'ja' }, true).summary_language).toBe('en');
  });
  it('override 스키마는 summary_language를 받지 않는다 — 회의별 요약 언어는 없다', () => {
    expect(ProcessingOverrideSchema.safeParse({ summary_language: 'ko' }).success).toBe(false);
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-be exec jest --runInBand test/processing-config.spec.ts test/resolve-processing.spec.ts`
Expected: FAIL (타입 오류로 컴파일 실패 포함).

- [ ] **Step 3: 구현한다**

`be/src/config/env.ts`: import에 `import { SUMMARY_LANGUAGES } from '@damwha/contracts';`, `SUMMARY_LLM_MODEL` 줄 다음에:

```ts
  // 요약·렌즈 출력 언어의 기본값(다국어 스펙 §3.2·§5.1). 저장된 처리 설정에 값이 없을 때만 쓴다.
  // desktop이 API를 띄울 때 기기 언어(ko/en)를 넣는다 — 그래서 사람이 고르기 전에는 기기 언어를 따른다.
  // desktop 없이 띄우면 transcript(녹취 언어 따름) — 이 설정이 생기기 전의 동작이다.
  // 목록 밖 값이면 기동 실패(SUMMARY_LLM_MODEL과 같은 이유).
  SUMMARY_LANGUAGE: z.enum(SUMMARY_LANGUAGES).default('transcript'),
```

`be/src/settings/presets.ts`:
- `import type { SummaryLanguage } from '@damwha/contracts';`
- `ProcessingConfig`에 `summary_language: SummaryLanguage;` (summary_model 다음). 주석: `// 프리셋과 무관 — language처럼 이름 프리셋과 custom 양쪽에 있다 (다국어 스펙 §5.1).`
- `resolvePreset(name: PresetName, language: string, summaryLanguage: SummaryLanguage): ProcessingConfig` — 반환 객체에 `summary_language: summaryLanguage,`.

`be/src/settings/processing-config.ts`:
- import에 `SUMMARY_LANGUAGES` 추가(`STT_LANGUAGES` 옆).
- `const summaryLanguageSchema = z.enum(SUMMARY_LANGUAGES);` (putLanguageSchema 다음). 주석: `// 요약 언어는 처음부터 카탈로그로 조인다 — language와 달리 조이기 전에 저장된 자유값이 없다.`
- `namedPresetSchema`를 두 인자로:

```ts
const namedPresetSchema = (language: z.ZodTypeAny, summaryLanguage: z.ZodTypeAny) =>
  z.object({
    preset: z.enum(['light', 'standard', 'quality']),
    language,
    summary_language: summaryLanguage,
  }).strict();
```

- Stored: custom 객체에 `summary_language: summaryLanguageSchema.optional(),`, named는 `namedPresetSchema(storedLanguageSchema, summaryLanguageSchema.optional())`. 주석: `// summary_language 부재 = "이 행이 쓰일 당시엔 이 설정이 없었다" → env (summary_model과 같은 규칙).`
- Put: custom에 `summary_language: summaryLanguageSchema,`, named는 `namedPresetSchema(putLanguageSchema, summaryLanguageSchema)`. 주석(기존 "이름 프리셋은 이름+언어만" 줄을 고친다): `// 쓰기(PUT body) — custom은 전 필드 필수. 이름 프리셋은 이름+언어+요약 언어만(개별 노브 혼입 400).`
- `envFallbackProcessingConfig` 반환에 `summary_language: env.SUMMARY_LANGUAGE,`.
- `resolveStoredValue`:

```ts
export function resolveStoredValue(value: StoredProcessingValue): ProcessingConfig {
  const summaryLanguage = value.summary_language ?? loadEnv().SUMMARY_LANGUAGE;
  if (value.preset === 'custom') {
    return {
      preset: 'custom', preset_revision: null, language: value.language,
      whisper_model: value.whisper_model, devices: value.devices,
      // 필드 부재는 "이 행이 쓰일 당시엔 env가 진실이었다"는 뜻 (spec §2).
      // 저장된 값이 있으면 언제나 그 값이 진실이다.
      summary_model: value.summary_model ?? loadEnv().SUMMARY_LLM_MODEL,
      summary_language: summaryLanguage,
    };
  }
  return resolvePreset(value.preset, value.language, summaryLanguage);
}
```

(`StoredProcessingValue`의 `summary_language` 타입이 `z.ZodTypeAny`로 흐려지면 `value.summary_language as SummaryLanguage | undefined`로 좁히지 말고, `namedPresetSchema`의 인자 타입을 제네릭 `<L extends z.ZodTypeAny, S extends z.ZodTypeAny>(language: L, summaryLanguage: S)`로 바꿔 추론을 살린다.)

`be/src/settings/resolve-processing.ts`:
- 프리셋 분기: `cfg = resolvePreset(override.preset, override.language ?? global.language, global.summary_language);`
- custom 재조립 객체에 `summary_language: cfg.summary_language,` (summary_model 다음). 주석: `// 회의별 요약 언어는 없다 — 전역 값을 그대로 잇는다 (다국어 스펙 §5.1).`

- [ ] **Step 4: 단위 테스트와 타입을 통과시킨다**

`be/test/job-payload.spec.ts`의 `resolvePreset('standard', 'ko')` 전부를 `resolvePreset('standard', 'ko', 'transcript')`로 바꾼다:

Run: `sed -i '' "s/resolvePreset('standard', 'ko')/resolvePreset('standard', 'ko', 'transcript')/g" be/test/job-payload.spec.ts`

`be/test/settings.service.spec.ts`의 `toEqual({ preset: 'light', ... summary_model: ... })` 기대값에 `summary_language: 'transcript'`를 더한다(테스트 env에 SUMMARY_LANGUAGE가 없으므로).

Run: `pnpm --filter damwha-be exec tsc --noEmit && pnpm --filter damwha-be exec jest --runInBand test/processing-config.spec.ts test/resolve-processing.spec.ts test/job-payload.spec.ts`
Expected: PASS. (`job-payload.spec.ts`는 Task 11에서 v6로 다시 바뀐다 — 지금은 v5 단정 그대로 통과.)

- [ ] **Step 5: PUT을 쓰는 e2e 본문을 갱신한다**

다음 파일들의 `.put('/settings/processing').send({...})` 본문에 `summary_language: 'transcript'`를 더한다(값이 요약 언어를 시험하는 것이 아니면 `transcript`): `be/test/settings.e2e-spec.ts`(9곳), `be/test/summary.e2e-spec.ts`(2곳), `be/test/meetings.e2e-spec.ts`(1곳), `be/test/system.e2e-spec.ts`(1곳). 찾기:

Run: `grep -n "settings/processing" be/test/*.e2e-spec.ts`

그리고 `be/test/settings.e2e-spec.ts`에 테스트 하나를 더한다(파일의 기존 `request(app.getHttpServer())` 모양을 따른다):

```ts
  it('PUT에 summary_language가 없으면 400, 있으면 저장되고 GET에 나온다', async () => {
    await request(app.getHttpServer())
      .put('/settings/processing').send({ preset: 'light', language: 'ko' }).expect(400);
    await request(app.getHttpServer())
      .put('/settings/processing').send({ preset: 'light', language: 'ko', summary_language: 'en' }).expect(200);
    const res = await request(app.getHttpServer()).get('/settings/processing').expect(200);
    expect(res.body.summary_language).toBe('en');
  });
```

Run: `pnpm --filter damwha-be exec jest --runInBand test/settings test/summary.e2e-spec.ts test/meetings.e2e-spec.ts test/system.e2e-spec.ts`
Expected: PASS (Docker가 떠 있어야 한다 — testcontainers).

- [ ] **Step 6: 커밋**

```bash
git add be/src/config/env.ts be/src/settings be/test
git commit -m "feat(be): 처리 설정에 요약 언어 — 저장값 없으면 env SUMMARY_LANGUAGE, PUT 필수

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

### Task 11: BE — job 계약 v6/v2 (zod)와 공유 픽스처

**Files:**
- Modify: `be/src/contracts/job-payload.schema.ts`
- Create: `be/test/fixtures/job-payloads/process_meeting.v6.valid.json`, `summarize-meeting-v2.json`, `extract_lenses.v1.valid.json`, `extract_lenses.v2.valid.json`, `live_session.v2.valid.json`
- Modify: `be/test/contract-fixtures.spec.ts`, `be/test/job-payload.spec.ts`

**Interfaces:**
- Consumes: `ProcessingConfig.summary_language` (Task 10).
- Produces:
  - `ModelsSchemaV4`, `ProcessMeetingPayloadV6Schema`, `type ProcessMeetingPayloadV6`
  - `ExtractLensesPayloadSchema`·`SummarizeMeetingPayloadSchema`·`LiveSessionPayloadSchema` = v1|v2 판별 합집합
  - `buildProcessMeetingPayload(...)`: `ProcessMeetingPayloadV6` (schema_version 6, `models.summary_language`)
  - `buildExtractLensesPayload({ meetingId, processingVersion, extractionRunId, model, outputLanguage })`: v2
  - `buildSummarizeMeetingPayload({ meetingId, processingVersion, model, outputLanguage })`: v2
  - `buildLiveSessionPayload(...)`: v2 (process = v6)

- [ ] **Step 1: 픽스처를 쓴다 (옛 픽스처는 손대지 않는다)**

`be/test/fixtures/job-payloads/process_meeting.v6.valid.json` — v5 픽스처에 `schema_version: 6`, `models.summary_language: "en"`:

```json
{
  "schema_version": 6,
  "meeting_id": "mtg_1",
  "audio_key": "meetings/mtg_1/original.m4a",
  "processing_version": 2,
  "reprocess": false,
  "models": {
    "whisper_model": "small",
    "language": "ko",
    "devices": { "diarization": "gpu", "stt": "cpu" },
    "preset": "light",
    "preset_revision": "2026-08-12.3",
    "summary_model": "mlx-community/Qwen3.5-4B-8bit",
    "summary_language": "en",
    "diarization": { "model": "pyannote/speaker-diarization-community-1", "min_speakers": null, "max_speakers": null },
    "embedding": { "model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192 }
  },
  "identify": { "threshold": 0.8, "suggest_threshold": 0.6 },
  "followups": { "lens": true, "summary": true }
}
```

`summarize-meeting-v2.json`:

```json
{
  "schema_version": 2,
  "meeting_id": "mtg_1",
  "processing_version": 0,
  "model": "mlx-community/Qwen3.5-4B-8bit",
  "output_language": "ko"
}
```

`extract_lenses.v1.valid.json`:

```json
{
  "schema_version": 1,
  "meeting_id": "mtg_1",
  "processing_version": 0,
  "extraction_run_id": "ler_1",
  "model": "mlx-community/Qwen3.5-4B-8bit"
}
```

`extract_lenses.v2.valid.json`:

```json
{
  "schema_version": 2,
  "meeting_id": "mtg_1",
  "processing_version": 0,
  "extraction_run_id": "ler_1",
  "model": "mlx-community/Qwen3.5-4B-8bit",
  "output_language": "en"
}
```

`live_session.v2.valid.json` — `live_session.valid.json`을 복사해 바깥 `schema_version: 2`, `process.schema_version: 6`, `process.models.summary_language: "transcript"`.

- [ ] **Step 2: 실패하는 계약 테스트를 쓴다**

`be/test/contract-fixtures.spec.ts`의 import에 `ExtractLensesPayloadSchema`를 더하고, describe 안에:

```ts
  it('validates process_meeting.v6.valid.json', () => {
    const p = ProcessMeetingPayloadSchema.parse(read('process_meeting.v6.valid.json'));
    expect(p.schema_version).toBe(6);
    if (p.schema_version === 6) expect(p.models.summary_language).toBe('en');
  });
  it('rejects v6 payload missing summary_language (워커 기본값 폴백 금지)', () => {
    const v6 = read('process_meeting.v6.valid.json');
    delete v6.models.summary_language;
    expect(() => ProcessMeetingPayloadSchema.parse(v6)).toThrow();
  });
  it('rejects v5 payload carrying summary_language (v5 models는 strict)', () => {
    const v5 = read('process_meeting.v5.valid.json');
    v5.models.summary_language = 'en';
    expect(() => ProcessMeetingPayloadSchema.parse(v5)).toThrow();
  });
  it('summarize_meeting: v1은 output_language 없이, v2는 필수', () => {
    expect(SummarizeMeetingPayloadSchema.parse(read('summarize-meeting-v1.json')).schema_version).toBe(1);
    const v2 = SummarizeMeetingPayloadSchema.parse(read('summarize-meeting-v2.json'));
    expect(v2.schema_version === 2 && v2.output_language).toBe('ko');
    const bad = read('summarize-meeting-v2.json');
    delete bad.output_language;
    expect(() => SummarizeMeetingPayloadSchema.parse(bad)).toThrow();
    expect(() => SummarizeMeetingPayloadSchema.parse({ ...read('summarize-meeting-v1.json'), output_language: 'ko' })).toThrow();
  });
  it('extract_lenses: v1은 output_language 없이, v2는 필수', () => {
    expect(ExtractLensesPayloadSchema.parse(read('extract_lenses.v1.valid.json')).schema_version).toBe(1);
    const v2 = ExtractLensesPayloadSchema.parse(read('extract_lenses.v2.valid.json'));
    expect(v2.schema_version === 2 && v2.output_language).toBe('en');
    const bad = read('extract_lenses.v2.valid.json');
    bad.output_language = 'ja';
    expect(() => ExtractLensesPayloadSchema.parse(bad)).toThrow();
  });
  it('live_session v2는 process v6을, v1은 process v5를 싣는다', () => {
    expect(LiveSessionPayloadSchema.parse(read('live_session.v2.valid.json')).process.schema_version).toBe(6);
    expect(LiveSessionPayloadSchema.parse(read('live_session.valid.json')).process.schema_version).toBe(5);
    const mixed = read('live_session.v2.valid.json');
    mixed.process = read('live_session.valid.json').process;
    expect(() => LiveSessionPayloadSchema.parse(mixed)).toThrow();
  });
```

`be/test/job-payload.spec.ts`: `expect(p.schema_version).toBe(5)` 두 곳을 `6`으로, 테스트 이름 `'stamps schema_version=5 on process_meeting payload'`를 `=6`으로, 첫 테스트에 `expect(p.models.summary_language).toBe('transcript');`를 더한다. 그리고 추가:

```ts
  it('처리 설정의 summary_language를 models에 싣는다', () => {
    const p = buildProcessMeetingPayload({
      meetingId: 'mtg_1', audioKey: 'meetings/x/original.wav',
      processingVersion: 0, reprocess: false,
      processing: resolvePreset('standard', 'ko', 'en'),
      followups: { lens: true, summary: true },
    });
    expect(p.models.summary_language).toBe('en');
  });

  it('summarize/extract 빌더는 v2와 output_language를 싣는다', () => {
    const s = buildSummarizeMeetingPayload({ meetingId: 'mtg_1', processingVersion: 0, model: 'm', outputLanguage: 'ko' });
    expect(s).toEqual({ schema_version: 2, meeting_id: 'mtg_1', processing_version: 0, model: 'm', output_language: 'ko' });
    expect(() => SummarizeMeetingPayloadSchema.parse(s)).not.toThrow();
    const e = buildExtractLensesPayload({ meetingId: 'mtg_1', processingVersion: 0, extractionRunId: 'ler_1', model: 'm', outputLanguage: 'en' });
    expect(e.schema_version).toBe(2);
    expect(e.output_language).toBe('en');
    expect(() => ExtractLensesPayloadSchema.parse(e)).not.toThrow();
  });

  it('live_session 빌더는 v2이고 process는 v6이다', () => {
    const l = buildLiveSessionPayload({
      meetingId: 'mtg_1', audioKey: 'meetings/x/original.wav',
      processing: resolvePreset('standard', 'ko', 'ko'),
      followups: { lens: true, summary: true },
    });
    expect(l.schema_version).toBe(2);
    expect(l.process.schema_version).toBe(6);
    expect(l.process.models.summary_language).toBe('ko');
    expect(() => LiveSessionPayloadSchema.parse(l)).not.toThrow();
  });
```

(필요한 이름을 파일 머리 import에 더한다: `buildSummarizeMeetingPayload`, `buildExtractLensesPayload`, `buildLiveSessionPayload`, `SummarizeMeetingPayloadSchema`, `ExtractLensesPayloadSchema`, `LiveSessionPayloadSchema`.)

- [ ] **Step 3: 실패를 확인한다**

Run: `pnpm --filter damwha-be exec jest --runInBand test/contract-fixtures.spec.ts test/job-payload.spec.ts`
Expected: FAIL.

- [ ] **Step 4: 스키마와 빌더를 구현한다**

`be/src/contracts/job-payload.schema.ts`:

import 줄에 `SUMMARY_LANGUAGES` 추가: `import { WHISPER_MODELS, MODEL_ROLES, STT_BACKENDS, SUMMARY_LANGUAGES } from '@damwha/contracts';`

`ModelsSchemaV3` 다음에:

```ts
// v4 = v3 + 요약·렌즈 출력 언어 (다국어 스펙 §5.2). 필수 — v3의 summary_model과 같은 이유:
// job이 기록한 결정이 워커 기본값에 좌우되면 안 된다. 옛 버전은 워커가 transcript로 읽는다.
export const ModelsSchemaV4 = z
  .object({
    whisper_model: z.enum(WHISPER_MODELS),
    language: z.string(),
    devices: z.object({ diarization: DeviceSchema, stt: DeviceSchema }),
    preset: z.enum(['light', 'standard', 'quality', 'custom']),
    preset_revision: z.string().nullable(),
    summary_model: z.enum(SUMMARY_MODELS),
    summary_language: z.enum(SUMMARY_LANGUAGES),
    diarization: DiarizationSchema,
    embedding: EmbeddingSchema,
  })
  .strict();
```

`ProcessMeetingPayloadV5Schema` 다음에:

```ts
// v6 = v5 + models.summary_language (ModelsSchemaV4).
export const ProcessMeetingPayloadV6Schema = z.object({
  schema_version: z.literal(6), ...processMeetingCommon,
  models: ModelsSchemaV4, identify: IdentifySchemaV4, followups: FollowupsSchemaV5,
});
```

`ProcessMeetingPayloadSchema`의 판별 합집합 목록 끝에 `ProcessMeetingPayloadV6Schema`.

`ExtractLensesPayloadSchema`를 교체:

```ts
const ExtractLensesPayloadV1Schema = z.object({
  schema_version: z.literal(1),
  meeting_id: z.string().regex(/^mtg_[1-9][0-9]*$/),
  processing_version: z.number().int().nonnegative(),
  extraction_run_id: z.string().regex(/^ler_[1-9][0-9]*$/),
  model: z.string().min(1),
}).strict();
// v2 = v1 + output_language. 필수 — process_meeting v6과 같은 이유.
const ExtractLensesPayloadV2Schema = ExtractLensesPayloadV1Schema.extend({
  schema_version: z.literal(2),
  output_language: z.enum(SUMMARY_LANGUAGES),
}).strict();
export const ExtractLensesPayloadSchema = z.discriminatedUnion('schema_version', [
  ExtractLensesPayloadV1Schema, ExtractLensesPayloadV2Schema,
]);
```

`SummarizeMeetingPayloadSchema`를 같은 모양으로 교체(기존 주석 유지):

```ts
const SummarizeMeetingPayloadV1Schema = z.object({
  schema_version: z.literal(1),
  meeting_id: z.string().regex(/^mtg_[1-9][0-9]*$/),
  processing_version: z.number().int().nonnegative(),
  model: z.string().min(1),
}).strict();
const SummarizeMeetingPayloadV2Schema = SummarizeMeetingPayloadV1Schema.extend({
  schema_version: z.literal(2),
  output_language: z.enum(SUMMARY_LANGUAGES),
}).strict();
export const SummarizeMeetingPayloadSchema = z.discriminatedUnion('schema_version', [
  SummarizeMeetingPayloadV1Schema, SummarizeMeetingPayloadV2Schema,
]);
```

`LiveSessionPayloadSchema`를 교체(기존 주석 유지, 끝에 한 줄 더: `// v2는 process가 v6이다. v1(process v5)은 큐에 남은 세션을 위해 계속 받는다.`):

```ts
const liveSessionCommon = {
  meeting_id: z.string().regex(/^mtg_[1-9][0-9]*$/),
  audio_key: z.string().min(1),
  source: z.enum(['mic', 'browser']),
};
const LiveSessionPayloadV1Schema = z.object({
  schema_version: z.literal(1), ...liveSessionCommon, process: ProcessMeetingPayloadV5Schema,
}).strict();
const LiveSessionPayloadV2Schema = z.object({
  schema_version: z.literal(2), ...liveSessionCommon, process: ProcessMeetingPayloadV6Schema,
}).strict();
export const LiveSessionPayloadSchema = z.discriminatedUnion('schema_version', [
  LiveSessionPayloadV1Schema, LiveSessionPayloadV2Schema,
]);
```

타입: `export type ProcessMeetingPayloadV6 = z.infer<typeof ProcessMeetingPayloadV6Schema>;`를 V5 타입 줄 다음에.

빌더:
- `buildProcessMeetingPayload(...)`의 반환 타입을 `ProcessMeetingPayloadV6`로, `schema_version: 6`, models에 `summary_language: p.summary_language,`(summary_model 다음).
- `buildExtractLensesPayload(args: { meetingId: string; processingVersion: number; extractionRunId: string; model: string; outputLanguage: SummaryLanguage }): ExtractLensesPayload` — `schema_version: 2`, 끝에 `output_language: args.outputLanguage`.
- `buildSummarizeMeetingPayload(args: { meetingId: string; processingVersion: number; model: string; outputLanguage: SummaryLanguage }): SummarizeMeetingPayload` — `schema_version: 2`, `output_language: args.outputLanguage`.
- `buildLiveSessionPayload`: `schema_version: 2`.
- `import type { SummaryLanguage } from '@damwha/contracts';`를 type import 줄에 더한다.

- [ ] **Step 5: 통과와 타입을 확인한다**

Run: `pnpm --filter damwha-be exec tsc --noEmit`
Expected: `summary.service.ts`·`lens-extraction.service.ts`에서 `outputLanguage` 누락 오류 — **Task 12에서 고친다.** 이 두 오류 외에는 없어야 한다.

Run: `pnpm --filter damwha-be exec jest --runInBand test/contract-fixtures.spec.ts test/job-payload.spec.ts`
Expected: PASS (ts-jest는 파일 단위로 컴파일하므로 두 서비스의 오류와 무관하게 돈다. 만약 ts-jest가 진단 오류로 막으면 Task 12를 먼저 끝내고 둘을 함께 돌린다).

- [ ] **Step 6: 커밋은 Task 12와 함께 한다** (tsc가 초록이 된 뒤)

### Task 12: BE — enqueue 경로가 언어를 싣는다

**Files:**
- Modify: `be/src/summary/summary.service.ts`
- Modify: `be/src/lenses/lens-extraction.service.ts`
- Modify: `be/src/lenses/lenses.module.ts` (SettingsModule import)
- Test: `be/test/summary.e2e-spec.ts`, `be/test/lens-extraction.e2e-spec.ts`, `be/test/live-orphan.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 11 빌더, `SettingsService.getProcessingConfig()`.
- Produces: 재생성 경로가 **현재 설정의** `summary_language`를 `output_language`로 싣는다.

- [ ] **Step 1: 실패하는 e2e 테스트를 쓴다**

`be/test/summary.e2e-spec.ts`의 `'body 없음 → 전역 설정의 summary_model로 큐잉된다'` 다음에:

```ts
  it('재생성은 현재 설정의 요약 언어를 output_language로 싣는다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await request(app.getHttpServer())
      .put('/settings/processing')
      .send({ preset: 'light', language: 'ko', summary_language: 'en' }).expect(200);
    await request(app.getHttpServer()).post(`/meetings/${meetingId}/summary/generate`).expect(202);
    const job = await db.pool.query(
      `SELECT payload FROM job WHERE meeting_id=$1 AND type='summarize_meeting'`, [meetingId],
    );
    expect(job.rows[0].payload).toMatchObject({ schema_version: 2, output_language: 'en' });
  });
```

`be/test/lens-extraction.e2e-spec.ts`의 `'reuses the active run for duplicate requests'` 안 `expect(job.payload).toMatchObject({ schema_version: 1, ...` 를 `schema_version: 2, ..., output_language: 'transcript'`로 고친다(테스트 env에 SUMMARY_LANGUAGE가 없고 설정도 저장하지 않았으므로). 그리고 그 테스트 다음에:

```ts
  it('재추출은 현재 설정의 요약 언어를 output_language로 싣는다', async () => {
    const meetingId = await createMeeting();
    await request(app.getHttpServer())
      .put('/settings/processing')
      .send({ preset: 'light', language: 'ko', summary_language: 'ko' }).expect(200);
    const res = await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/lenses/extract`).expect(202);
    const { rows: [job] } = await db.pool.query('SELECT payload FROM job WHERE id=$1', [res.body.job_id]);
    expect(job.payload).toMatchObject({ schema_version: 2, output_language: 'ko' });
  });
```

(이 파일의 `TestingModule`이 `CAPABILITIES`를 덮지 않아 PUT이 gpu 적격성 검사에 걸리면 — PUT은 gpu 검사를 하지 않으므로 걸리지 않아야 한다 — `summary.e2e-spec.ts`의 `.overrideProvider(CAPABILITIES)` 블록을 복사한다.)

`be/test/live-orphan.e2e-spec.ts`의 `'finalizes a sealed session whose worker was lost'` 다음에 — API 마무리 경로가 옛 v1 세션의 process v5를 **변환 없이** 복사하는지:

```ts
  it('API 마무리는 옛 v1 세션의 process v5를 그대로 넣는다 — 워커가 v5를 transcript로 읽는다', async () => {
    const { body: m } = await start().expect(201);
    // 이 세션을 업그레이드 전에 만들어진 v1로 되돌린다(process v5, summary_language 없음).
    await db.pool.query(
      `UPDATE job SET payload = jsonb_set(
         jsonb_set(payload, '{schema_version}', '1'),
         '{process}', (payload->'process') #- '{models,summary_language}' || '{"schema_version":5}'::jsonb)
       WHERE id=(SELECT current_job_id FROM meeting WHERE id=$1)`, [m.id]);
    await claim(m.id);
    await send(m.id, 0, chunk(1)).expect(200);
    await stop(m.id, CHUNK, CHUNK).expect(200);
    await reap(m.id);
    expect(await orphans.sweep()).toBe(1);
    const { rows } = await db.pool.query(
      `SELECT payload FROM job WHERE meeting_id=$1 AND type='process_meeting'`, [m.id]);
    expect(rows[0].payload.schema_version).toBe(5);
    expect(rows[0].payload.models.summary_language).toBeUndefined();
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-be exec jest --runInBand test/summary.e2e-spec.ts test/lens-extraction.e2e-spec.ts test/live-orphan.e2e-spec.ts`
Expected: FAIL (컴파일 오류 또는 payload 불일치).

- [ ] **Step 3: 구현한다**

`be/src/summary/summary.service.ts` — `request()`의 설정 로드를 한 번으로 모은다:

```ts
    // 설정 로드(DB)는 트랜잭션 진입 전에 — spec §5의 순서 원칙.
    const processing = await this.settings.getProcessingConfig();
    const model = parsed.data.summary_model ?? processing.summary_model;
    // 요약 언어는 재생성 body로 덮지 않는다 — 회의별 요약 언어는 없다 (다국어 스펙 §2).
    const outputLanguage = processing.summary_language;
```

`buildSummarizeMeetingPayload({...})` 호출에 `outputLanguage,`를 더한다.

(알려진 한계, 주석으로 남긴다 — `if (active) {` 블록 위: `// 진행 중 요약이 다른 언어로 큐잉됐어도 그것을 돌려준다 — meeting_summary에 언어 열이 없다. 끝난 뒤 다시 요청하면 새 언어로 만든다.`)

`be/src/lenses/lens-extraction.service.ts`:
- `import { SettingsService } from '../settings/settings.service';`
- constructor에 `private readonly settings: SettingsService,`
- `request()` 첫 줄 다음에: `const outputLanguage = (await this.settings.getProcessingConfig()).summary_language;` (주석: `// 설정 로드는 트랜잭션 전에 (summary.service.ts와 같은 순서).`)
- `buildExtractLensesPayload({...})`에 `outputLanguage,`.

`be/src/lenses/lenses.module.ts`:
- `import { SettingsModule } from '../settings/settings.module';`
- `@Module({ imports: [SettingsModule], controllers: ...` (summary.module.ts의 주석을 한 줄 복사: `// SettingsModule은 @Global()이 아니다 — 명시 import 필요.`)
- 순환 import가 생기면(SettingsModule이 LensesModule을 import하는 경우) `pnpm --filter damwha-be exec tsc --noEmit`와 앱 기동에서 드러난다 — 그때는 `forwardRef(() => SettingsModule)`.

- [ ] **Step 4: BE 전체를 통과시킨다**

Run: `pnpm --filter damwha-be exec tsc --noEmit && pnpm be test`
Expected: PASS. 실패가 나면 v5를 정확히 단정하던 다른 테스트다 — 그 단정을 v6로 옮긴다(옛 픽스처 파일은 고치지 않는다).

- [ ] **Step 5: 변이로 확인한다(되돌린다)**

`resolve-processing.ts`의 프리셋 분기에서 `global.summary_language`를 `'transcript'`로 바꾸면 Task 10의 "프리셋 override도 전역 summary_language를 이어받는다"가 실패하는지, `summary.service.ts`의 `outputLanguage,`를 `outputLanguage: 'transcript',`로 바꾸면 "재생성은 현재 설정의 요약 언어를…"이 실패하는지 확인하고 되돌린다.

- [ ] **Step 6: 커밋 (Task 11 포함)**

```bash
git add be/src be/test
git commit -m "feat(be): job 계약 v6/v2 — process_meeting·live_session·summarize·extract가 요약 언어를 싣는다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

### Task 13: worker — 계약(pydantic) v6/v2

**Files:**
- Modify: `be/worker/damwha_worker/contracts.py`
- Test: `be/worker/tests/test_contracts.py`, `be/worker/tests/test_contracts_live.py`, `be/worker/tests/test_contracts_lenses.py`, 새 `be/worker/tests/test_contracts_output_language.py`

**Interfaces:**
- Consumes: Task 11 픽스처.
- Produces: `SummaryLanguage = Literal["transcript", "ko", "en"]`; `ModelsConfig.summary_language: SummaryLanguage = "transcript"`; `ExtractLensesPayload.output_language`·`SummarizeMeetingPayload.output_language: SummaryLanguage` (v1이면 `"transcript"`); `parse_payload`가 process_meeting v6, summarize/extract v2, live_session v2를 받는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_contracts_output_language.py`:

```python
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from damwha_worker.contracts import parse_payload

FIX = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "job-payloads"


def load(name):
    return json.loads((FIX / name).read_text())


def test_process_meeting_v6_carries_summary_language():
    p = parse_payload("process_meeting", load("process_meeting.v6.valid.json"))
    assert p.schema_version == 6
    assert p.models.summary_language == "en"
    assert p.followups.lens is True


@pytest.mark.parametrize(
    "name",
    [
        "process_meeting.valid.json",
        "process_meeting.v2.valid.json",
        "process_meeting.v3.valid.json",
        "process_meeting.v4.valid.json",
        "process_meeting.v5.valid.json",
    ],
)
def test_older_process_meeting_reads_as_transcript(name):
    # 큐에 남은 옛 job — 만들어질 때의 실제 동작이 "녹취 언어 따름"이었다.
    assert parse_payload("process_meeting", load(name)).models.summary_language == "transcript"


def test_v6_without_summary_language_is_rejected():
    data = load("process_meeting.v6.valid.json")
    del data["models"]["summary_language"]
    with pytest.raises(ValidationError):
        parse_payload("process_meeting", data)


def test_v6_rejects_unknown_summary_language():
    data = load("process_meeting.v6.valid.json")
    data["models"]["summary_language"] = "ja"
    with pytest.raises(ValidationError):
        parse_payload("process_meeting", data)


def test_summarize_v1_is_transcript_and_v2_carries_language():
    assert parse_payload("summarize_meeting", load("summarize-meeting-v1.json")).output_language == "transcript"
    assert parse_payload("summarize_meeting", load("summarize-meeting-v2.json")).output_language == "ko"


def test_summarize_version_and_field_must_agree():
    v2 = load("summarize-meeting-v2.json")
    del v2["output_language"]
    with pytest.raises(ValidationError):
        parse_payload("summarize_meeting", v2)
    v1 = load("summarize-meeting-v1.json") | {"output_language": "ko"}
    with pytest.raises(ValidationError):
        parse_payload("summarize_meeting", v1)


def test_extract_v1_is_transcript_and_v2_carries_language():
    assert parse_payload("extract_lenses", load("extract_lenses.v1.valid.json")).output_language == "transcript"
    assert parse_payload("extract_lenses", load("extract_lenses.v2.valid.json")).output_language == "en"


def test_extract_version_and_field_must_agree():
    v2 = load("extract_lenses.v2.valid.json")
    del v2["output_language"]
    with pytest.raises(ValidationError):
        parse_payload("extract_lenses", v2)


def test_live_session_v2_embeds_process_v6():
    p = parse_payload("live_session", load("live_session.v2.valid.json"))
    assert p.process.schema_version == 6
    assert p.process.models.summary_language == "transcript"
    assert p.process_wire["schema_version"] == 6


def test_live_session_v1_still_embeds_process_v5():
    p = parse_payload("live_session", load("live_session.valid.json"))
    assert p.process.schema_version == 5
    assert p.process.models.summary_language == "transcript"


def test_live_session_version_must_match_process_version():
    mixed = load("live_session.v2.valid.json")
    mixed["process"] = load("live_session.valid.json")["process"]
    with pytest.raises(ValidationError):
        parse_payload("live_session", mixed)
```

`be/worker/tests/test_contracts.py`의 `test_rejects_future_schema_version`: `{"schema_version": 6}` → `{"schema_version": 7}`.
`be/worker/tests/test_contracts_live.py`: `load("live_session.valid.json") | {"schema_version": 2}`가 `UnsupportedPayloadVersion`을 기대하는 단정을 `{"schema_version": 3}`으로 바꾼다.

- [ ] **Step 2: 실패를 확인한다**

Run: `uv run --directory be/worker pytest -q tests/test_contracts_output_language.py tests/test_contracts.py tests/test_contracts_live.py tests/test_contracts_lenses.py`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

`be/worker/damwha_worker/contracts.py`:

1. `SUPPORTED_SCHEMA_VERSIONS`: `"process_meeting": frozenset({1, 2, 3, 4, 5, 6})`, `"extract_lenses": frozenset({1, 2})`, `"summarize_meeting": frozenset({1, 2})`, `"live_session": frozenset({1, 2})`.

2. `Device = Literal[...]` 다음에:

```python
# 요약·렌즈 출력 언어 (다국어 스펙 §5). transcript = 녹취 언어 따름 — 옛 버전 job은 이 값으로 읽는다.
# 값의 진실원은 @damwha/contracts의 SUMMARY_LANGUAGES.
SummaryLanguage = Literal["transcript", "ko", "en"]
```

3. `ModelsWireV3` 다음에:

```python
class ModelsWireV4(BaseModel):
    """wire v4 = v3 + summary_language. 필수 — v3의 summary_model과 같은 이유."""

    model_config = ConfigDict(extra="forbid")

    whisper_model: WhisperModel
    language: str
    devices: Devices
    preset: str | None = None
    preset_revision: str | None = None
    summary_model: NonEmptyString
    summary_language: SummaryLanguage
    diarization: Diarization
    embedding: Embedding
```

4. `ModelsConfig`에 `summary_model` 다음 필드: `summary_language: SummaryLanguage = "transcript"` 그리고 독스트링 끝에 한 문장: `summary_language는 v6부터 — 그 전 버전 유래는 transcript(당시의 실제 동작)다.`

5. `_v3_models_to_internal` 다음에:

```python
def _v4_models_to_internal(m: ModelsWireV4) -> ModelsConfig:
    return ModelsConfig(**m.model_dump())
```

6. `ProcessMeetingPayloadWireV5` 다음에:

```python
class ProcessMeetingPayloadWireV6(BaseModel):
    """wire v6 = v5 + models.summary_language."""

    schema_version: Literal[6]
    meeting_id: MeetingId
    audio_key: str
    processing_version: int
    reprocess: bool
    models: ModelsWireV4
    identify: IdentifyWireV4
    followups: FollowupsWireV5
```

7. `_parse_process_meeting`: 마지막 v5 분기를 `if version == 5:` 블록으로 감싸고(return 그대로), 그 뒤에 v6:

```python
    v6 = ProcessMeetingPayloadWireV6.model_validate(data)
    return ProcessMeetingPayload(
        schema_version=6,
        meeting_id=v6.meeting_id,
        audio_key=v6.audio_key,
        processing_version=v6.processing_version,
        reprocess=v6.reprocess,
        models=_v4_models_to_internal(v6.models),
        identify=IdentifyConfig(
            threshold=v6.identify.threshold,
            suggest_threshold=v6.identify.suggest_threshold,
        ),
        followups=FollowupsConfig(lens=v6.followups.lens, summary=v6.followups.summary),
    )
```

8. 버전과 필드가 짝이 맞는지 보는 공용 검사(모듈 수준 함수)를 `ExtractLensesPayload` 앞에:

```python
def _output_language_matches_version(data):
    """v1은 output_language를 모르고 v2는 필수다 (zod의 v1|v2 판별 합집합과 같은 판정)."""
    if isinstance(data, dict):
        version = data.get("schema_version")
        has = "output_language" in data
        if version == 2 and not has:
            raise ValueError("output_language is required in schema_version 2")
        if version == 1 and has:
            raise ValueError("output_language is not part of schema_version 1")
    return data
```

9. `ExtractLensesPayload`: `schema_version: Literal[1, 2]`, `model` 다음에 `output_language: SummaryLanguage = "transcript"`, 그리고

```python
    @model_validator(mode="before")
    @classmethod
    def _version_field(cls, data):
        return _output_language_matches_version(data)
```

10. `SummarizeMeetingPayload`: 같은 세 가지(버전 Literal[1, 2], `output_language` 기본값, 같은 validator).

11. `LiveSessionPayloadWire`: `schema_version: Literal[1, 2]`, 독스트링 `"""wire v1(process v5)·v2(process v6). process는 API가 완전히 해석한 process_meeting payload 그대로다."""`, validator의 첫 검사를:

```python
        expected = 5 if self.schema_version == 1 else 6
        if self.process.get("schema_version") != expected:
            raise ValueError(
                f"live_session v{self.schema_version}.process must be a wire v{expected} "
                "process_meeting payload"
            )
```

12. `LiveSessionPayload`(내부)의 `schema_version: int = 1`은 그대로 두고, `_parse_live_session`이 `schema_version=wire.schema_version`을 넘기게 한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `uv run --directory be/worker pytest -q tests/test_contracts_output_language.py tests/test_contracts.py tests/test_contracts_live.py tests/test_contracts_lenses.py tests/test_contracts_index.py tests/test_contracts_model_jobs.py`
Expected: PASS. 옛 에러 문구(`"must be a wire v5 process_meeting payload"`)를 단정하던 테스트가 있으면 새 문구의 부분 문자열(`"process_meeting payload"`)로 바꾼다.

- [ ] **Step 5: 커밋**

```bash
git add be/worker/damwha_worker/contracts.py be/worker/tests
git commit -m "feat(worker): 계약 v6/v2 — 요약 언어를 읽고 옛 버전은 transcript로

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

### Task 14: worker — 프롬프트의 언어 지시와 호출 사슬

**Files:**
- Create: `be/worker/damwha_worker/output_language.py`
- Modify: `be/worker/damwha_worker/summary_client.py`, `be/worker/damwha_worker/lens_client.py`
- Modify: `be/worker/damwha_worker/pipeline/summarize_meeting.py`, `be/worker/damwha_worker/pipeline/extract_lenses.py`
- Test: 새 `be/worker/tests/test_output_language.py`; 수정 `tests/test_summary_client.py`, `tests/test_lens_client.py`, `tests/test_summarize_meeting.py`, `tests/test_extract_lenses.py`, `tests/test_worker_loop.py`

**Interfaces:**
- Consumes: `SummaryLanguage`, payload `.output_language` (Task 13).
- Produces: `output_language_instruction(fields: str, lang: SummaryLanguage) -> str`; `SummaryClient.summarize(*, model, utterances, output_language)`; `LensClient.extract(*, model, utterances, meeting_date=None, output_language)` — `output_language`는 **기본값 없는 키워드 인자**.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_output_language.py`:

```python
import json

import httpx
import pytest

from damwha_worker.lens_client import LensClient
from damwha_worker.output_language import output_language_instruction
from damwha_worker.summary_client import SummaryClient

# 이 설정이 생기기 전의 프롬프트 끝 문장. transcript일 때 한 글자도 달라지면 안 된다 (다국어 스펙 §5.3).
OLD_SUMMARY_TAIL = "Write topics, title, and bullets in the language of the transcript."
OLD_LENS_TAIL = "Write text in the language of the transcript."


def test_instruction_per_language():
    assert output_language_instruction("text", "transcript") == OLD_LENS_TAIL
    assert output_language_instruction("text", "ko") == (
        "Write text in Korean, even if the transcript is in another language."
    )
    assert output_language_instruction("text", "en") == (
        "Write text in English, even if the transcript is in another language."
    )


def _capture(monkeypatch, body):
    captured = {}

    def post(self, url, **kw):
        captured.update(kw)
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(body)}}]},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(httpx.Client, "post", post)
    return captured


UTTS = [{"id": "utt_1", "text": "가"}]


@pytest.mark.parametrize(
    ("lang", "tail"),
    [
        ("transcript", OLD_SUMMARY_TAIL),
        ("en", "Write topics, title, and bullets in English, even if the transcript is in another language."),
    ],
)
def test_summary_prompt_ends_with_the_instruction(monkeypatch, lang, tail):
    captured = _capture(monkeypatch, {"topics": [], "segments": []})
    SummaryClient("http://x", None, 5.0, 8192).summarize(model="m", utterances=UTTS, output_language=lang)
    system = captured["json"]["messages"][0]["content"]
    assert system.endswith(tail)
    assert system.count("Write ") == 1  # 언어 지시가 두 번 들어가지 않는다


@pytest.mark.parametrize(
    ("lang", "tail"),
    [
        ("transcript", OLD_LENS_TAIL),
        ("ko", "Write text in Korean, even if the transcript is in another language."),
    ],
)
def test_lens_prompt_ends_with_the_instruction(monkeypatch, lang, tail):
    captured = _capture(monkeypatch, {"items": []})
    LensClient("http://x", None, 5.0, 8192).extract(model="m", utterances=UTTS, output_language=lang)
    system = captured["json"]["messages"][0]["content"]
    assert system.endswith(tail)


def test_output_language_is_required(monkeypatch):
    _capture(monkeypatch, {"items": []})
    with pytest.raises(TypeError):
        SummaryClient("http://x", None, 5.0, 8192).summarize(model="m", utterances=UTTS)  # type: ignore[call-arg]
```

(`"Write "`가 프롬프트 본문의 다른 곳에도 나오면 — 렌즈 프롬프트는 "Write due_at as…"가 있다 — 렌즈 쪽에는 count 단정을 두지 않는다(위 코드처럼).)

- [ ] **Step 2: 실패를 확인한다**

Run: `uv run --directory be/worker pytest -q tests/test_output_language.py`
Expected: FAIL — `No module named 'damwha_worker.output_language'`.

- [ ] **Step 3: 지시문 모듈과 두 클라이언트를 구현한다**

`be/worker/damwha_worker/output_language.py`:

```python
"""요약·렌즈 프롬프트의 출력 언어 지시 한 문장 (다국어 스펙 §5.3).

프롬프트 본문은 영어 그대로 두고 끝 문장만 고른다. transcript일 때의 문장은 이 설정이 생기기 전의
문장과 **같아야** 한다 — 옛 job과 새 job(transcript)이 같은 출력을 낸다.

"even if …"를 붙이는 이유: 작은 로컬 모델은 지시보다 입력 언어에 끌린다. 녹취와 다른 언어를 고른
경우에만 붙는다.
"""

from .contracts import SummaryLanguage

_NAMES: dict[str, str] = {"ko": "Korean", "en": "English"}


def output_language_instruction(fields: str, lang: SummaryLanguage) -> str:
    if lang == "transcript":
        return f"Write {fields} in the language of the transcript."
    return f"Write {fields} in {_NAMES[lang]}, even if the transcript is in another language."
```

`be/worker/damwha_worker/summary_client.py`:
- `from .output_language import output_language_instruction`, `from .contracts import ..., SummaryLanguage` (기존 contracts import 줄에 추가).
- `_SUMMARY_SYSTEM_PROMPT` 상수를 `_SUMMARY_SYSTEM_PROMPT_BASE`로 이름을 바꾸고 마지막 두 문자열 조각 `"output timestamps. Do not speculate. Write topics, title, and bullets in the "` / `"language of the transcript."`를 `"output timestamps. Do not speculate. "`로 끝나게 자른다(끝의 공백 하나 유지).
- 그 아래:

```python
def _summary_system_prompt(output_language: SummaryLanguage) -> str:
    return _SUMMARY_SYSTEM_PROMPT_BASE + output_language_instruction(
        "topics, title, and bullets", output_language
    )
```

- `summarize(self, *, model: str, utterances: list[dict[str, Any]], output_language: SummaryLanguage) -> SummaryResponse:` 그리고 system 메시지 content를 `_summary_system_prompt(output_language)`로.

`be/worker/damwha_worker/lens_client.py`: 같은 방식 — `_EXTRACTION_SYSTEM_PROMPT` → `_EXTRACTION_SYSTEM_PROMPT_BASE`(끝 `"speculate or return duplicates. "`), `_extraction_system_prompt(output_language)`는 `output_language_instruction("text", output_language)`를 붙인다, `extract(self, *, model, utterances, meeting_date=None, output_language: SummaryLanguage)`.

- [ ] **Step 4: 파이프라인이 payload의 언어를 넘긴다**

`pipeline/summarize_meeting.py`: `client.summarize(model=payload.model, utterances=row_dicts)` → `client.summarize(model=payload.model, utterances=row_dicts, output_language=payload.output_language)`.

`pipeline/extract_lenses.py`: `client.extract(model=payload.model, utterances=..., meeting_date=meeting_date)`에 `output_language=payload.output_language,`.

- [ ] **Step 5: 기존 테스트의 호출과 가짜를 맞춘다**

클라이언트 직접 호출(`test_summary_client.py` 19곳, `test_lens_client.py` 25곳)에 `output_language="transcript"`를 더한다:

Run:
```bash
sed -i '' 's/\.summarize(model=/.summarize(output_language="transcript", model=/g' be/worker/tests/test_summary_client.py
sed -i '' 's/\.extract(model=/.extract(output_language="transcript", model=/g' be/worker/tests/test_lens_client.py
grep -c 'output_language="transcript"' be/worker/tests/test_summary_client.py be/worker/tests/test_lens_client.py
```
Expected: 19, 25 (여러 줄에 걸친 호출이 있으면 그 수보다 적다 — `grep -n "\.summarize(\|\.extract(" `로 남은 것을 손으로 고친다).

`tests/test_worker_loop.py`의 가짜 클라이언트 메서드(314·366·681·723·778·841·928행 근처) 시그니처에 `output_language="transcript"`를 키워드로 더한다. 예: `def extract(self, *, model, utterances, meeting_date=None, output_language="transcript"):`. `**kwargs`로 받는 가짜(`test_extract_lenses.py:116`, `test_summarize_meeting.py:291`)는 그대로.

파이프라인이 payload의 언어를 넘기는지 단정을 더한다. `tests/test_summarize_meeting.py`의 `test_pipeline_sends_payload_model_and_utterance_rows` 다음에:

```python
def test_pipeline_passes_payload_output_language(conn, summary_job):
    job, _ids = summary_job
    job = {**job, "payload": {**job["payload"], "schema_version": 2, "output_language": "en"}}
    captured = {}

    def summarize(**kwargs):
        captured.update(kwargs)
        return _response([])

    run_summarize_meeting(conn, job, _payload(job), SimpleNamespace(summarize=summarize), worker_id="w")
    assert captured["output_language"] == "en"


def test_pipeline_reads_v1_payload_as_transcript(conn, summary_job):
    job, _ids = summary_job  # 픽스처의 payload는 v1이다
    captured = {}

    def summarize(**kwargs):
        captured.update(kwargs)
        return _response([])

    run_summarize_meeting(conn, job, _payload(job), SimpleNamespace(summarize=summarize), worker_id="w")
    assert captured["output_language"] == "transcript"
```

`tests/test_extract_lenses.py`의 `test_extract_uses_payload_model_and_speaker_display_name` 다음에:

```python
def test_extract_passes_payload_output_language(conn, extraction_job, fake_client):
    job, _ids = extraction_job
    job = {**job, "payload": {**job["payload"], "schema_version": 2, "output_language": "ko"}}
    captured = {}

    def extract(**kwargs):
        captured.update(kwargs)
        return []

    fake_client.extract = extract
    run_extract_lenses(conn, job, _payload(job), fake_client, worker_id="w")
    assert captured["output_language"] == "ko"
```

- [ ] **Step 6: worker 전체 테스트**

Run: `pnpm worker:test`
Expected: PASS.

- [ ] **Step 7: 변이로 확인한다(되돌린다)**

`summarize_meeting.py`에서 `output_language=payload.output_language`를 `output_language="transcript"`로 바꾸면 새 파이프라인 테스트가 실패하는지 확인하고 되돌린다.

- [ ] **Step 8: 커밋**

```bash
git add be/worker/damwha_worker be/worker/tests
git commit -m "feat(worker): 요약·렌즈 프롬프트의 출력 언어 지시 — transcript는 기존 문장 그대로

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

### Task 15: worker — 후속 job이 언어를 이어받는다

**Files:**
- Modify: `be/worker/damwha_worker/db/meetings.py` (`persist_process_meeting`)
- Modify: `be/worker/damwha_worker/pipeline/process_meeting.py`
- Test: `be/worker/tests/test_db_persist.py`, `be/worker/tests/test_process_meeting.py`

**Interfaces:**
- Consumes: `payload.models.summary_language` (Task 13).
- Produces: `persist_process_meeting(..., output_language: str | None = None)` — 후속 job(lens·summary 모델 중 하나라도 있음)을 넣을 때 필수, 없으면 `ValueError`. 넣는 payload는 v2 + `output_language`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_db_persist.py` 끝에(파일 머리에 `import pytest`가 없으면 더한다):

```python
def _persist_with_followups(conn, mid, jid, **kw):
    return db.persist_process_meeting(
        conn,
        job_id=jid,
        worker_id="w1",
        meeting_id=mid,
        processing_version=0,
        normalized_key="k",
        duration_ms=1,
        utterances=[],
        clusters=[],
        lens_llm_model="qwen",
        summary_llm_model="model",
        **kw,
    )


def test_follow_up_jobs_carry_output_language(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    assert _persist_with_followups(conn, mid, jid, output_language="en") == "committed"
    rows = conn.execute(
        "SELECT type, payload FROM job WHERE meeting_id=%s "
        "AND type IN ('extract_lenses','summarize_meeting')",
        (mid,),
    ).fetchall()
    assert {
        r["type"]: (r["payload"]["schema_version"], r["payload"]["output_language"]) for r in rows
    } == {"extract_lenses": (2, "en"), "summarize_meeting": (2, "en")}


def test_follow_up_jobs_require_output_language(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    with pytest.raises(ValueError, match="output_language"):
        _persist_with_followups(conn, mid, jid)
    # 트랜잭션에 들어가기 전에 멈췄다 — 아무것도 쓰지 않았다
    assert conn.execute(
        "SELECT count(*) c FROM job WHERE meeting_id=%s AND type<>'process_meeting'", (mid,)
    ).fetchone()["c"] == 0
```

- [ ] **Step 2: 실패를 확인한다**

Run: `uv run --directory be/worker pytest -q tests/test_db_persist.py`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

`db/meetings.py` `persist_process_meeting`:
- 시그니처 끝에 `output_language: str | None = None,`
- `try:` 앞에:

```python
    # 후속 job은 process payload의 요약 언어를 그대로 잇는다 (다국어 스펙 §5.2). 기본값으로 떨어지면
    # "고른 적 없는 언어로 요약"이 되므로, 후속을 넣는데 언어가 없으면 조용히 transcript로 가지 않고 멈춘다.
    if (lens_llm_model is not None or summary_llm_model is not None) and output_language is None:
        raise ValueError("output_language is required when enqueuing follow-up jobs")
```

- extract_lenses payload: `"schema_version": 2,` 그리고 `"model": lens_llm_model,` 다음 `"output_language": output_language,`.
- summarize_meeting payload: 같은 두 가지.

`pipeline/process_meeting.py`의 `db.persist_process_meeting(...)` 호출에 `output_language=payload.models.summary_language,`.

기존 `test_db_persist.py`의 세 테스트 — `test_persist_enqueues_index_and_linked_lens_extraction_run_on_commit`, `test_persist_discarded_enqueues_no_index_or_lens_extraction_run`, `test_persist_enqueues_summarize_job_and_queued_row_on_commit` — 의 `persist_process_meeting(...)` 호출에 `output_language="transcript",`를 더하고, 첫째와 셋째의 기대 payload를 `"schema_version": 2,` + 끝에 `"output_language": "transcript",`로 고친다. 그 밖에 `lens_llm_model`/`summary_llm_model`을 넘기는 호출이 더 있으면(`grep -n "llm_model=" be/worker/tests/*.py`) 같은 인자를 더한다.

- [ ] **Step 4: process_meeting 파이프라인 경유 확인**

`tests/test_process_meeting.py`의 `_payload_v5` 다음에 v6 헬퍼를, `test_v5_deferred_followups_are_not_queued` 다음에 테스트 둘을 더한다:

```python
def _payload_v6(meeting_id, audio_key, *, summary_language, pv=0):
    return parse_payload(
        "process_meeting",
        {
            "schema_version": 6,
            "meeting_id": str(meeting_id),
            "audio_key": audio_key,
            "processing_version": pv,
            "reprocess": pv > 0,
            "models": {
                "whisper_model": "large-v3-turbo",
                "language": "ko",
                "devices": {"diarization": "cpu", "stt": "cpu"},
                "preset": "standard",
                "preset_revision": "2026-08-12.3",
                "summary_model": "mlx-community/Qwen3.5-27B-8bit",
                "summary_language": summary_language,
                "diarization": {"model": "d", "min_speakers": None, "max_speakers": None},
                "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
            },
            "identify": {"threshold": 0.7, "suggest_threshold": 0.5},
            "followups": {"lens": True, "summary": True},
        },
    )


def _run_with_followups(conn, tmp_path, payload_for):
    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    out = run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        payload_for(mid),
        _models(),
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(2000),
        lens_llm_model="worker-env-model",
        summary_llm_model="worker-env-model",
    )
    assert out == "committed"
    rows = conn.execute(
        "SELECT type, payload FROM job WHERE meeting_id=%s "
        "AND type IN ('extract_lenses','summarize_meeting')",
        (mid,),
    ).fetchall()
    return {r["type"]: r["payload"]["output_language"] for r in rows}


def test_v6_followups_inherit_summary_language(conn, tmp_path):
    got = _run_with_followups(
        conn, tmp_path,
        lambda mid: _payload_v6(mid, "meetings/m/original.m4a", summary_language="en"),
    )
    assert got == {"extract_lenses": "en", "summarize_meeting": "en"}


def test_v5_followups_are_transcript(conn, tmp_path):
    got = _run_with_followups(
        conn, tmp_path,
        lambda mid: _payload_v5(mid, "meetings/m/original.m4a", lens=True, summary=True),
    )
    assert got == {"extract_lenses": "transcript", "summarize_meeting": "transcript"}
```

Run: `pnpm worker:test`
Expected: PASS.

- [ ] **Step 5: 변이로 확인한다(되돌린다)**

`process_meeting.py`의 `output_language=payload.models.summary_language`를 `output_language="transcript"`로 → Step 4의 v6 단정이 실패하는지 확인하고 되돌린다.

- [ ] **Step 6: 커밋**

```bash
git add be/worker/damwha_worker/db/meetings.py be/worker/damwha_worker/pipeline/process_meeting.py be/worker/tests
git commit -m "feat(worker): 후속 요약·렌즈 job이 process의 요약 언어를 잇는다 (v2)

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

### Task 16: FE — 처리 설정의 요약 언어

**Files:**
- Modify: `fe/src/features/settings/api/types.ts`
- Modify: `fe/src/features/settings/lib/presets.ts`
- Modify: `fe/src/features/settings/ui/processing-settings-form.tsx`
- Modify: `fe/src/shared/i18n/locales/ko/settings.ts`, `fe/src/shared/i18n/locales/en/settings.ts`
- Test: `fe/src/features/settings/ui/processing-settings-form.test.tsx`
- Modify(픽스처): `ProcessingConfig` 리터럴이 있는 테스트 전부 — `tsc -b`가 가리킨다

**Interfaces:**
- Consumes: contracts `SUMMARY_LANGUAGES`·`SummaryLanguage`; Task 10의 API 모양.
- Produces: `ProcessingConfig.summary_language`, `ProcessingSettingsUpdate` 두 모양 모두 `summary_language`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`processing-settings-form.test.tsx`:
- `CONFIG`와 `PRESET_LIGHT_RESOLVED`에 `summary_language: "transcript",`를 더한다.
- `"이름 프리셋 저장은 이름+언어만 보낸다"` → 이름을 `"이름 프리셋 저장은 이름+언어+요약 언어만 보낸다"`로, 기대 본문에 `summary_language: "transcript"`.
- 고급에서 모델·언어를 바꾸는 두 테스트의 custom 기대 본문에 `summary_language: "transcript"`.
- 새 테스트:

```tsx
test("요약 언어는 프리셋과 무관하다 — 바꿔도 프리셋이 유지되고, 저장하면 함께 보낸다", async () => {
  mockApi();
  const put = vi
    .spyOn(apiClient, "put")
    .mockResolvedValue({ data: { ...CONFIG, summary_language: "en" } } as never);
  renderForm();
  await screen.findByRole("radio", { name: /표준/ });

  const trigger = screen.getByLabelText("요약 언어");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "영어" }));

  expect(screen.getByRole("radio", { name: /표준/ }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("저장하지 않은 변경이 있어요")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith("/settings/processing", {
      preset: "standard",
      language: "ko",
      summary_language: "en",
    }),
  );
});

test("요약 언어 아래에 이미 만든 요약은 바뀌지 않는다고 알린다", async () => {
  mockApi();
  renderForm();
  expect(await screen.findByText(/이미 만든 요약은 바뀌지 않아요/)).toBeTruthy();
});

test("프리셋을 바꿔도 고른 요약 언어는 남는다", async () => {
  mockApi({ ...CONFIG, summary_language: "ko" });
  const put = vi.spyOn(apiClient, "put").mockResolvedValue({ data: CONFIG } as never);
  renderForm();
  fireEvent.click(await screen.findByRole("radio", { name: /가볍게/ }));
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith("/settings/processing", {
      preset: "light",
      language: "ko",
      summary_language: "ko",
    }),
  );
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run src/features/settings/ui/processing-settings-form.test.tsx`
Expected: FAIL.

- [ ] **Step 3: 타입·사전·폼을 구현한다**

`api/types.ts`:
- contracts 재수출·import 목록에 `SummaryLanguage` 추가.
- `ProcessingConfig`에 `summary_language: SummaryLanguage;` (summary_model 다음).
- `ProcessingSettingsUpdate`: 이름 프리셋 모양 `{ preset: PresetName; language: SttLanguage; summary_language: SummaryLanguage }`, custom 모양에 `summary_language: SummaryLanguage;`. 문서 주석 "이름 프리셋은 이름+언어만"을 "이름 프리셋은 이름+언어+요약 언어만"으로.

사전 — `locales/ko/settings.ts`에 `general` 옆에:

```ts
  processing: {
    summaryLanguage: {
      label: "요약 언어",
      hint: "이미 만든 요약은 바뀌지 않아요. 다음 처리나 '다시 만들기'부터 적용돼요.",
      options: {
        transcript: "녹취 언어 따름",
        ko: "한국어",
        en: "영어",
      },
    },
  },
```

`locales/en/settings.ts`에 같은 모양:

```ts
  processing: {
    summaryLanguage: {
      label: "Summary language",
      hint: "Existing summaries stay as they are. The new language applies from the next processing run or when you regenerate.",
      options: {
        transcript: "Same as the recording",
        ko: "Korean",
        en: "English",
      },
    },
  },
```

`processing-settings-form.tsx`:
- import: `import { useTranslation } from "react-i18next";`, `import { SUMMARY_LANGUAGES } from "@damwha/contracts";`, 타입 import에 `SummaryLanguage`.
- `FormState`에 `summary_language: SummaryLanguage;`, `fromConfig`에 `summary_language: c.summary_language,`, `sameForm`에 `&& a.summary_language === b.summary_language`.
- `selectPreset`의 `setForm({...})`에 `summary_language: form.summary_language,`.
- `handleSave`: custom 본문에 `summary_language: form.summary_language,`, 이름 프리셋 본문을 `{ preset: form.preset, language: form.language, summary_language: form.summary_language }`.
- 컴포넌트 본문(훅 자리, `const [form, setForm]` 근처)에 `const { t } = useTranslation("settings");`.
- 고급 펼침 블록이 끝난 뒤, `<p className="text-xs text-[color:var(--text-faint)]">모델은 처음 쓸 때 받아요…` **앞**에:

```tsx
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-[color:var(--text-secondary)]">
          {t("processing.summaryLanguage.label")}
        </span>
        <Select
          value={form.summary_language}
          // 프리셋과 무관한 값 — setKnob(custom 전환)을 쓰지 않는다 (다국어 스펙 §5.1).
          onValueChange={(v) => setForm({ ...form, summary_language: v as SummaryLanguage })}
        >
          <SelectTrigger aria-label={t("processing.summaryLanguage.label")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUMMARY_LANGUAGES.map((lang) => (
              <SelectItem key={lang} value={lang}>
                {t(`processing.summaryLanguage.options.${lang}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-[color:var(--text-muted)]">
          {t("processing.summaryLanguage.hint")}
        </p>
      </div>
```

- 파일 머리 주석의 "이름 프리셋 저장은 이름+언어만 전송"을 "이름 프리셋 저장은 이름+언어+요약 언어만 전송"으로.

- [ ] **Step 4: 픽스처를 맞추고 전체를 통과시킨다**

Run: `pnpm --filter damwha-fe exec tsc -b`
Expected: `summary_language`가 빠진 `ProcessingConfig` 리터럴마다 오류 — 후보는 `features/meeting/api/meetings.test.tsx`, `features/meeting/ui/new-meeting-dialog.test.tsx`, `features/meeting/ui/reprocess-dialog.test.tsx`, `features/models/lib/preset-need.test.ts`, `features/models/lib/rows.test.ts`, `features/models/ui/models-in-use.test.tsx`, `features/settings/api/settings.test.tsx`, `features/settings/ui/override-section.test.tsx`, `pages/meeting-live.test.tsx`, `pages/meeting.test.tsx`, `pages/settings.test.tsx`. 각 리터럴에 `summary_language: "transcript",`를 더한다. `settings.test.tsx`(api)가 PUT 본문을 단정하면 거기에도.

Run: `pnpm --filter damwha-fe exec tsc -b && pnpm --filter damwha-fe exec vitest run && pnpm fe lint`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add fe/src
git commit -m "feat(fe): 처리 설정의 요약 언어 — 프리셋과 무관, 저장 시 함께 보낸다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

### Task 17: desktop — 기기 언어를 `SUMMARY_LANGUAGE`로

**Files:**
- Modify: `desktop/src/config/config.ts` (`launchEnv`)
- Modify: `desktop/src/main.ts` (호출부)
- Test: `desktop/tests/config/config-reload.test.ts`

**Interfaces:**
- Consumes: `pickUiLanguage` (Task 2).
- Produces: `launchEnv(cfg: LoadedConfig, llmPort: number, hfToken: string | null, deviceLanguage: UiLanguage): { env: ApiEnv; baseline: ApiEnv }`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`desktop/tests/config/config-reload.test.ts`의 `launchEnv(` 호출 넷(350·384·396·410행 근처)에 넷째 인자 `"ko"`를 더하고, 파일 끝에:

```ts
describe("createConfigReloader — the device summary language (다국어 스펙 §5.4)", () => {
  it("기기 언어를 SUMMARY_LANGUAGE로 얹는다 — 기준선에는 넣지 않아 재적용이 지우지 않는다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-reload-"));
    try {
      const cfg = loadConfig(dir);
      const live = launchEnv(cfg, 51234, null, "en");
      expect(live.env.SUMMARY_LANGUAGE).toBe("en");
      expect("SUMMARY_LANGUAGE" in live.baseline).toBe(false);

      const reload = createConfigReloader({
        load: () => loadConfig(dir),
        live: () => ({ env: live.env, baseline: live.baseline, mode: cfg.databaseMode }),
        log: () => {},
      });
      reload();
      expect(live.env.SUMMARY_LANGUAGE).toBe("en");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("config.json에 사람이 적은 SUMMARY_LANGUAGE가 있으면 그 값이 이긴다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-reload-"));
    try {
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ SUMMARY_LANGUAGE: "transcript" }));
      const live = launchEnv(loadConfig(dir), 51234, null, "en");
      expect(live.env.SUMMARY_LANGUAGE).toBe("transcript");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

(이 describe는 파일 끝, 다른 describe와 같은 수준에 둔다. 위 `launchEnv(` 호출 넷에 넷째 인자 `"ko"`를 더하는 것도 잊지 않는다.)

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/config/config-reload.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

`desktop/src/config/config.ts`:
- `import type { UiLanguage } from "../i18n/locale";`
- `launchEnv` 시그니처에 `deviceLanguage: UiLanguage`를 더하고, `if (hfToken !== null) env.HF_TOKEN = hfToken;` 다음에:

```ts
  // 요약 언어의 기기 기본값 (다국어 스펙 §5.4). 저장된 처리 설정에 요약 언어가 없을 때만 API가 쓴다 — 그래서
  // 사람이 고르기 전에는 기기 언어를 따른다. 화면 언어의 저장값이 아니라 **OS 언어**다: 두 설정은 독립이다.
  // config.json에 사람이 적은 값이 있으면 그것이 이긴다(디버깅). 기준선에는 넣지 않는다 — LLM 주소와 같은 자리.
  if (env.SUMMARY_LANGUAGE === undefined) env.SUMMARY_LANGUAGE = deviceLanguage;
```

- 함수 문서 주석의 "이 실행이 정한 값 — 빈 포트로 고른 LLM 주소, 기동 게이트가 Keychain에서 읽은 HF 토큰"에 ", 기기 언어로 정한 요약 언어 기본값"을 더한다.

`desktop/src/main.ts`: `launchEnv(cfg, await freePort(), hfToken)` → `launchEnv(cfg, await freePort(), hfToken, pickUiLanguage(app.getPreferredSystemLanguages()))` (`pickUiLanguage`는 Task 9에서 import했다).

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run && pnpm desktop lint`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add desktop/src/config/config.ts desktop/src/main.ts desktop/tests/config/config-reload.test.ts
git commit -m "feat(desktop): 기기 언어를 요약 언어 기본값(SUMMARY_LANGUAGE)으로 API에 넘긴다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

### Task 18: 실제 모델 확인과 스펙 갱신

**Files:**
- Modify: `docs/superpowers/specs/2026-09-26-i18n-ko-en-design.md` (§3.1, §4.2, §5.3, §5.4, §11에 한 행)

- [ ] **Step 1: 전체 검증**

Run:
```bash
pnpm --filter @damwha/contracts test
pnpm --filter damwha-fe exec tsc -b && pnpm --filter damwha-fe exec vitest run && pnpm fe lint
pnpm desktop lint && pnpm --filter damwha-desktop exec vitest run
pnpm --filter damwha-be exec tsc --noEmit && pnpm be test
pnpm worker:test
```
Expected: 전부 PASS. 하나라도 실패하면 여기서 멈추고 고친다.

- [ ] **Step 2: 실제 모델로 출력 언어를 확인한다 (스펙 §5.3)**

`pnpm desktop:dev`로 앱을 띄운다. 이미 처리된 **한국어 회의 1건**을 고른다.
1. 설정 › 처리 방식 › 요약 언어를 "영어"로 저장.
2. 그 회의에서 요약 "다시 만들기"와 렌즈 다시 추출.
3. 결과의 주제·구간 제목·불릿·렌즈 텍스트가 영어인지 본다. 프리셋 셋의 요약 모델(`SUMMARY_MODELS` 세 개 — 받아 둔 것만)로 각각 한 번.
4. "녹취 언어 따름"으로 되돌려 다시 만들면 한국어로 나오는지 본다.

결과를 모델별로 한 줄씩 스펙 §5.3 끝에 적는다: `- 2026-09-XX 실측: Qwen3.5-4B-8bit — 영어 지시 준수(요약·렌즈) / …`. 따르지 않는 모델이 있으면 그 사실과 증상(섞임·무시)을 적고, 사용자에게 보고한다 — 재시도 검증기는 이 계획 범위 밖이다.

- [ ] **Step 3: 스펙에 이 계획의 결정을 반영한다**

- §3.1 끝에: "desktop은 contracts를 런타임에 import하지 않는다 — `desktop/src/i18n/locale.ts`의 사본과 대조 테스트(`desktop/tests/i18n/locale.test.ts`). 이유: desktop에는 런타임 dependencies가 없고 asar에는 컴파일된 main만 들어간다."
- §4.2의 localStorage 키를 `damwha:ui-language`로 고치고, 한 문장 추가: "desktop 안의 FE는 main이 준 값(show)도 이 키에 캐시한다 — ⌘R로 `?lang` 없는 URL이 다시 떠도 같은 언어로 뜨게."
- §5.4의 `apiChildEnv`를 `launchEnv`로 고치고 이유("이 실행이 정한 값을 얹는 자리, 기준선 밖이라 재적용이 지우지 않는다, config.json 값이 이긴다")를 한 줄.
- §11 표 아래에 한 줄: "구현 계획 `docs/superpowers/plans/2026-09-26-i18n-ko-en-foundation.md`가 위 세 가지를 바꿨다."

- [ ] **Step 4: 그래프 갱신과 커밋**

Run: `graphify update .` (graphify-out/이 있으면. 없으면 건너뛴다 — gitignore 대상이다.)

```bash
git add docs/superpowers/specs/2026-09-26-i18n-ko-en-design.md
git commit -m "docs(spec): 다국어 기반 구현의 결정과 모델 실측을 스펙에 반영

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```
