# 다국어(한국어·영어) 설계

**작성일:** 2026-09-26
**상태:** 설계 초안 — codex 리뷰(gpt-5.6-terra) 반영, 사용자 리뷰 대기
**범위:** 화면 언어(FE·desktop)와 요약 언어(BE·worker) — 언어 결정 규칙, 저장, desktop↔FE 전달,
job 계약, 문구 이전, 번역, 테스트, 작업 순서

## 1. 목적과 성공 기준

Damwha의 **콘텐츠**는 이미 다국어다. 인식 언어(`STT_LANGUAGES = auto/ko/en/ja/zh`)가 whisper까지
흐르고, 요약·렌즈 프롬프트는 "녹취 언어로 써라"라고 말하며, bge-m3와 pg_bigm은 영어도 다룬다.
다국어가 아닌 것은 **화면**이다. i18n 라이브러리가 없고 한글 문구가 소스에 직접 박혀 있다
(주석·테스트 제외, 2026-09-26 기준).

| 패키지 | 한글 문자열 줄 | 파일 |
| --- | --- | --- |
| `fe/src` | ~820 | 81 |
| `desktop/src` + `desktop/shell` | ~515 | 36 |
| `be/src` | ~170 | 23 (대부분 Swagger 설명) |

그리고 요약 언어는 **고를 수 없다** — 항상 녹취 언어를 따른다. 한국어 회의를 영어로 요약받을 방법이 없다.

성공 기준:

- 영어 OS에서 앱을 처음 켜면 메뉴·상태 창·진단 문구·담화 화면·요약이 모두 영어로 나온다.
  한국어 OS면 모두 한국어다. 그 밖의 언어는 영어다.
- 설정에서 화면 언어와 요약 언어를 **각각** 바꿀 수 있다. 화면 언어는 재시작 없이 바로 바뀐다.
- `en`으로 렌더한 화면에 한글이 새지 않는다(샘플 회의 콘텐츠 제외). 새 하드코딩 한글은 CI에서 실패한다.
- 기존 테스트는 거의 그대로 통과한다.

## 2. 범위

**한다**

- UI 언어 `ko`·`en` — FE 전 화면, desktop main의 메뉴·다이얼로그·상태 창·진단 원인·셸 안내·종료 흐름.
- 요약 언어 `transcript`·`ko`·`en` — 요약(주제·구간 제목·불릿)과 렌즈, 즉 **LLM이 쓰는 글 전부**.
- 두 설정 모두 "기기 언어를 따르다가, 사용자가 고르면 고정"(§3.2).
- BE가 사람에게 보이는 에러 문구를 내는 곳에 기계용 `code`를 붙인다.

**하지 않는다**

- 인식(STT) 언어 — 기존 "인식 언어" 설정 그대로.
- 회의별 요약 언어 override. 다른 언어가 필요하면 설정을 바꾸고 "다시 만들기"를 쓴다.
- 기존 요약·렌즈의 자동 재생성. 설정 변경은 다음 처리·다시 만들기부터 적용된다.
- 데모·쇼케이스의 **샘플 회의 콘텐츠**(발화·요약 본문) — UI가 아니라 콘텐츠다. 투어(driver.js) 문구는 번역한다.
- Swagger(`@ApiOperation` 등) 설명, `supervisor.log`·worker 로그, 코드 주석, `docs/`.
- ko·en 외의 UI 언어. 구조는 언어 추가를 막지 않지만 사전은 둘뿐이다.
- 제품 사이트(`2026-09-26-product-site-design.md`) — 별도 설계.

## 3. 언어 결정

### 3.1 공유 계약 (`@damwha/contracts`)

```ts
export const UI_LANGUAGES = ['ko', 'en'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

export const SUMMARY_LANGUAGES = ['transcript', 'ko', 'en'] as const;
export type SummaryLanguage = (typeof SUMMARY_LANGUAGES)[number];

/** 선호 언어 목록(BCP 47)을 앞에서부터 보고 처음 걸리는 ko*/en*. 없으면 'en'. */
export function pickUiLanguage(locales: readonly string[]): UiLanguage;
```

`pickUiLanguage`는 이 패키지의 첫 **함수**다. 패키지는 "dependency-free, value-only"였는데, 순수 함수 하나는
그 취지(양쪽이 같은 답을 내야 하는 것을 한 곳에)에 맞는다. 의존성은 여전히 없다. 루트 CLAUDE.md의
표 설명을 "wire enums and pure helpers"로 고친다.

매칭은 대소문자 무시, 접두 비교다: `ko`, `ko-KR`, `ko_KR` → `ko`; `en-US`, `en-GB` → `en`.
`['ja-JP', 'en-US']` → `en`(두 번째에서 걸림), `['ja-JP']` → `en`(기본값), `[]` → `en`.

### 3.2 "기기 언어를 따르다가, 고르면 고정"

두 설정 모두 **저장값 부재 = 기기 언어를 따른다**, **저장값 존재 = 그 값**이다. 첫 실행에 값을 저장하지
않는다 — 저장하면 OS 언어를 바꾼 사람이 앱 안에서 다시 골라야 한다. 사람이 고른 순간에만 쓴다.

| | 기기 언어의 출처 | 저장 위치 |
| --- | --- | --- |
| 화면 언어 (desktop) | `app.getPreferredSystemLanguages()` → `pickUiLanguage` | userData `ui-language.json` |
| 화면 언어 (브라우저 단독) | `navigator.languages` → `pickUiLanguage` | localStorage |
| 요약 언어 | desktop이 API를 띄울 때 넣는 env `SUMMARY_LANGUAGE` | `app_setting` processing |

요약 언어의 기기 기본값은 `pickUiLanguage`의 결과(`ko`/`en`)이지 `transcript`가 아니다 — "기기 언어로
자동 설정"이 요구다. `pnpm dev`처럼 desktop 없이 API를 띄우면 env가 없으므로 기본값은 `transcript`이고,
오늘과 똑같이 동작한다.

## 4. 화면 언어

### 4.1 desktop: main이 원본

**저장소.** `desktop/src/config/ui-language-store.ts` — userData의 `ui-language.json`
(`{ "language": "en" }`). `token-store.ts`처럼 읽기·쓰기를 주입받는 모양으로 두고, 파일이 없거나 깨졌거나
값이 `UI_LANGUAGES` 밖이면 "저장값 없음"으로 읽는다(예외로 기동을 막지 않는다).

**현재 언어.** main은 `current: UiLanguage`를 하나 들고 있다. 기동 시 `저장값 ?? pickUiLanguage(OS)`.
main 쪽 문구는 모두 이 값으로 사전을 찾는다.

**첫 화면 — 깜빡임 없이.** 담화 화면의 `loadURL`에 `?lang=<current>`를 붙인다(`windows/shell-url.ts`).
문자열 이어 붙이기가 아니라 `new URL()`·`searchParams`로 만든다 — API origin(packaged)과 Vite origin(dev)
양쪽이다. 쿼리는 origin을 바꾸지 않으므로 `applyNavigationBoundary`의 origin 검사는 그대로 통과한다. FE는 첫 렌더 **전에** 이 값을 동기로 읽어 i18n을 초기화한다. 페이지 로드 뒤에 밀어 넣으면 한국어가
한 프레임 보였다가 바뀐다.

**바꾸기 — 렌더러→main 채널 없이.** desktop은 렌더러→main 채널을 만들지 않는다(Phase 2 스펙 §6.11,
`windows/token-bridge.ts`). 같은 방식을 쓴다: FE의 `window.__damwha_desktop`에 `uiLanguage` 고리를 더하고,
main이 `uiLanguage.next()`를 **묻는다**. 사람이 설정에서 언어를 고르면 그 호출이 새 값으로 끝난다. main은

1. `ui-language.json`에 쓰고 `current`를 바꾼다,
2. 메뉴를 다시 만든다(`windows/menu.ts`),
3. 상태 창이 떠 있으면 다시 그린다,
4. 페이지에 `uiLanguage.show(lang)`를 보낸다(FE는 이미 바꿨지만 main이 확정한 값을 다시 받는다 — 저장 실패 시
   이전 값으로 되돌리는 길이 이것이다),
5. 다시 `next()`를 묻는다.

token-bridge를 복사하거나 확장하지 않는다 — 그 파일은 토큰 전용 동작(submit·clear), `mutating` 직렬화,
토큰 문구가 얽혀 있다. **묻는 고리 패턴만 빌린** 작은 `windows/language-bridge.ts`를 새로 둔다(electron을
import하지 않고 잎을 주입받는 같은 나눔). 규칙:

- 붙는 자리는 tokenBridge와 같은 두 곳이다 — `reattachWindow`의 첫 부착(`main.ts`, `tokenBridge.attach(target)`
  옆)과 ⌘R 뒤 `did-finish-load`(`main.ts`, `created.webContents.on("did-finish-load", …)` 안). 두 호출을
  나란히 둔다.
- **페이지 세대 표시**: attach마다 세대 번호를 올리고, 옛 세대의 고리는 답을 받아도 버린다 — ⌘R 전의 고리가
  늦게 끝나 새 페이지에 옛 값을 `show`하거나 두 고리가 서로 되묻는 반복을 막는다.
- 언어 변경은 멱등이라 `mutating` 같은 직렬화는 필요 없다 — 마지막 값이 이긴다.

**FE가 desktop 밖인가.** `window.__damwha_desktop`이 없으면 브라우저 단독이다(§4.2).

**API가 뜨기 전 화면.** 상태 창(`shell/status.html`·`services.html`)과 다이얼로그는 main의 `current`로
그리므로 API·FE와 무관하게 처음부터 맞는 언어다. 정적 HTML의 문구는 main이 그릴 때 사전 값을 넣는다
(`status-view.ts`가 이미 뷰 모델을 만들어 넣는 자리).

### 4.2 브라우저 단독

`?lang` → localStorage `damwha.uiLanguage` → `pickUiLanguage(navigator.languages)` 순. 설정에서 고르면
localStorage에 쓴다. localStorage 접근은 try/catch로 감싼다.

### 4.3 FE 인프라

- `i18next` + `react-i18next`. 사전은 JSON이 아니라 **TS 객체** — `fe/src/shared/i18n/locales/ko.ts`,
  `en.ts`. `ko`가 기준이고 `en`은 `satisfies Resources<typeof ko>`(같은 키 구조) — **키가 빠지면 `tsc -b`가 실패**한다.
  react-i18next의 타입 확장(`CustomTypeOptions`)으로 `t('meeting.title')`의 키도 타입 검사한다.
- 네임스페이스는 feature 단위(`meeting`, `lens`, `speaker`, `settings`, `models`, `hfToken`, `demo`,
  `common`, `errors`). 한 파일이 900줄이 되지 않게 locale 폴더 안에서 namespace별 파일로 나눈다.
- 복수형은 i18next plural(`_one`/`_other`). 한국어는 `_other`만 둔다.
- 날짜·숫자는 `Intl`에 현재 언어를 넘기는 `shared/i18n/format.ts` 한 곳을 거친다(현재 `Intl`/`toLocale`
  사용처는 1곳).
- `<html lang>`은 언어가 바뀔 때마다 갱신한다(`fe/index.html`의 고정 `lang="ko"`는 초기값으로만 남는다).
- 언어 선택 UI: 설정 페이지에 **"일반" 섹션을 새로 두고** 그 안에 "화면 언어" 셀렉트. 선택지는 각 언어의
  자기 이름(`한국어`, `English`)으로 쓴다 — 읽지 못하는 언어로 된 메뉴에서도 자기 언어는 찾을 수 있어야 한다.

### 4.4 desktop 사전

main 쪽 문구는 복수형이 거의 없어 i18next를 들이지 않는다. `desktop/src/i18n/`에 `ko.ts`·`en.ts`(같은
`satisfies` 규칙)와 `t(key, vars?)` 하나. 번역 대상:

- `diagnostics/causes.ts` — 진단 원인 제목·설명·조치
- `windows/menu-template.ts`, 다이얼로그(`app/quit-flow.ts` 등), `windows/shell-hints.ts`,
  `windows/status-view.ts`, `windows/token-bridge.ts`의 사람용 message
- `shell/status.html`, `shell/services.html`의 정적 문구

`appendSupervisorLog`로 가는 문구는 번역하지 않는다 — 사람이 아니라 진단이 읽는 기록이고, 로그 언어가
실행마다 바뀌면 버그 리포트를 비교할 수 없다. 같은 문장이 화면과 로그 양쪽에 쓰이는 곳(예: `onAskFailed`의
`actionNotice`)은 둘로 나눈다: 화면에는 `t()`, 로그에는 고정 한국어 원문.

## 5. 요약 언어

### 5.1 설정 (BE)

`summary_language`를 처리 설정(`app_setting` processing)의 필드로 둔다. **프리셋과 무관하다** — `language`처럼
이름 프리셋과 custom 양쪽에 있다.

- **읽기**(`StoredProcessingValueSchema`): optional. 없으면 env `SUMMARY_LANGUAGE`(기본 `transcript`).
  `summary_model`의 "필드 부재 = env가 진실" 규칙과 같다. 읽기 스키마는 `z.enum(SUMMARY_LANGUAGES)` — 자유값을
  허용했던 `language`와 달리 이 필드는 처음부터 카탈로그로 조인다(과거에 저장된 자유값이 없다).
- **env**(`be/src/config/env.ts`): `SUMMARY_LANGUAGE: z.enum(SUMMARY_LANGUAGES).default('transcript')`.
  카탈로그 밖 값이면 기동 실패 — desktop이 넣는 값은 항상 `pickUiLanguage`의 결과라 안전하다.
- **쓰기**(`PutProcessingValueSchema`): 두 모양 모두 **필수**. 그래서 사람이 처리 설정을 한 번 저장하면
  그 시점에 보이던 요약 언어로 고정된다(화면에 보이던 값과 같으므로 보이는 변화는 없다 — OS 언어를 나중에
  바꿨을 때만 차이가 난다). "기기 언어 따름"을 별도 선택지로 두는 것은 YAGNI.
- `ProcessingConfig`(`presets.ts`)에 `summary_language`를 **필수 필드로** 더하고
  `resolvePreset(name, language, summaryLanguage)`. `GET /settings/processing`의 resolved 뷰에도 나온다.
- **회의별 override 해석**(`resolve-processing.ts` `resolveProcessingConfig`): override는 이 필드를 받지 않지만,
  override가 프리셋을 고르는 분기(`resolvePreset(override.preset, …)`)와 개별 노브 분기(custom 재조립) **모두**
  `global.summary_language`를 이어받아야 한다. 필드가 필수이므로 빠뜨리면 `tsc`가 잡는다 — optional로 두면
  override가 있는 업로드·재처리·라이브만 조용히 기본값으로 떨어진다. override 스키마(`ProcessingOverrideSchema`,
  `.strict()`)에는 넣지 않는다.
- `PRESET_REVISION`은 올리지 않는다 — 프리셋 정의(모델·장치)가 바뀐 게 아니다.

### 5.2 job 계약

요약·렌즈 job은 두 곳에서 들어간다: worker가 process_meeting 커밋 때 넣는 후속 job
(`be/worker/damwha_worker/db/meetings.py`)과 API의 "다시 만들기"(`summary.service.ts`,
`lens-extraction.service.ts`). 그래서 언어는 **처음 job을 만들 때 해석해서 payload에 싣는다**.

| job | 변경 | 옛 버전 변환 |
| --- | --- | --- |
| `process_meeting` | **v6** — `models`에 `summary_language` 필수(`ModelsSchemaV4` = V3 + 이 필드) | v1–v5 → `transcript` |
| `summarize_meeting` | **v2** — `output_language` 필수 | v1 → `transcript` |
| `extract_lenses` | **v2** — `output_language` 필수 | v1 → `transcript` |
| `live_session` | **v2** — `process`가 process_meeting v6 | v1 → `process`를 v5→v6 변환 |

- 필수인 이유는 v3의 `summary_model`, v5의 `followups`와 같다: job이 기록한 결정이 worker 기본값에 좌우되면
  안 된다. 옛 버전을 `transcript`로 읽는 것은 "그 job이 만들어질 때의 실제 동작"이다.
- worker의 후속 job 삽입은 process payload의 `models.summary_language`를 `output_language`로 복사한다.
- API의 다시 만들기는 **현재 설정값**(`resolveProcessing`)을 읽어 넣는다.
- 라이브 세션의 최종 process_meeting은 `live_session.process`를 **그대로 복사**해 넣는다. 그 경로는 둘이다 —
  worker가 마무리할 때(`db/live.py`)와 worker를 잃어 API가 마무리할 때(`live.service.ts`
  `finalizeWithoutWorker`, `fresh.payload.process`를 그대로 enqueue). 둘 다 **변환하지 않고** 복사한다.
  그래서 v1 live_session 안의 process v5는 v5 그대로 큐에 들어가고, worker의 process_meeting 파서가 v5를
  `transcript`로 읽는다. 이것이 성립하려면 **worker는 process_meeting v1–v6을 계속 받아야 한다**(이 설계의
  불변식) — 옛 버전 지원을 걷어내는 변경은 두 복사 경로를 먼저 고쳐야 한다. 두 경로 각각에 v1 live_session →
  v5 process → `transcript` 요약 테스트를 둔다.
- 양쪽 스키마: zod(`job-payload.schema.ts`)와 pydantic(`contracts.py`, `SUPPORTED` 버전 집합). 내부 정규형
  `ModelsConfig`에 `summary_language: str = "transcript"`.
- API와 worker는 desktop 앱 안에서 함께 배포되므로 "새 API + 옛 worker" 조합은 없다. 남는 것은 **큐에 남은
  옛 job**뿐이고 위 변환이 그것을 덮는다.

### 5.3 worker 프롬프트

`summary_client.py`·`lens_client.py`의 고정 문장만 `output_language`로 고른다. 프롬프트 본문은 영어 그대로.

| `output_language` | 문장 |
| --- | --- |
| `transcript` | 기존 문장 그대로 ("… in the language of the transcript.") |
| `ko` | "… in Korean, even if the transcript is in another language." |
| `en` | "… in English, even if the transcript is in another language." |

"even if …"를 붙이는 이유: 작은 로컬 모델은 지시보다 입력 언어에 끌린다. 구현 때 실제 한국어 회의 1건을
`en`으로 요약해 출력 언어를 눈으로 확인한다(모델 목록 `SUMMARY_MODELS` 각각). 따르지 않는 모델이 있으면
그 결과를 이 절에 적는다 — 추가 검증기(출력 언어 감지 후 재시도)는 그때 판단한다.

**호출 사슬.** 지금 두 클라이언트는 언어 인자를 받지 않는다(`summary_client.py`의 요약 함수,
`lens_client.py`의 추출 함수). `output_language: SummaryLanguage`를 두 클라이언트 API의 **필수 키워드 인자**로
더하고, 파싱된 payload에서 `pipeline/summarize_meeting.py`·`pipeline/extract_lenses.py`를 거쳐 넘긴다.
문장 선택은 두 클라이언트가 공유하는 함수 하나(`output_language_instruction(lang) -> str`)로 둔다.

**렌즈에서 무엇이 바뀌나.** `LensCandidate`(`contracts.py`)에 원문 인용 필드는 없다. 서술인 `text`만 출력
언어를 따르고, 나머지 — `kind`, `assignee_speaker_id`, `due_at`, `primary_utterance_id`·
`supporting_utterance_ids`(증거 발화 ID) — 는 언어와 무관하다. 출력 글을 녹취와 비교하는 검증기는 없고
(증거 ID가 입력 범위 안인지만 본다), 그래서 출력 언어가 녹취와 달라도 검증에서 떨어지지 않는다. 요약도
같다 — `topics`·`title`·`bullets`가 서술이고 `start_index`·`end_index`는 인덱스다.

### 5.4 desktop의 기기 기본값

`services/api-process.ts`의 `apiChildEnv`가 `SUMMARY_LANGUAGE=<pickUiLanguage(app.getPreferredSystemLanguages())>`를
얹는다. 화면 언어의 저장값이 아니라 **OS 언어**다 — 두 설정은 독립이다(화면은 한국어, 요약은 기기 언어인 영어,
가 가능해야 한다). dev 런처(`launchDev`)도 같은 함수를 쓰므로 desktop dev에서도 같다. dotenv는 이미 있는
env를 덮지 않으므로 `be/.env`에 값이 있어도 desktop이 넣은 값이 이긴다 — 의도한 동작이다.

### 5.5 FE

처리 설정 폼(`processing-settings-form.tsx`)에 "요약 언어" 셀렉트(`녹취 언어 따름` / `한국어` / `English`).
아래에 한 줄: "이미 만든 요약은 바뀌지 않아요. 다음 처리나 '다시 만들기'부터 적용돼요."
프리셋 선택과 무관하게 항상 보인다. `PUT` 본문에 항상 싣는다.

PUT 필수화 때문에 폼 한 곳이 아니라 이 사슬 전체가 바뀐다 — 하나라도 빠지면 이름 프리셋 저장이 400이 된다:
`features/settings/api/types.ts`의 `ProcessingSettingsUpdate`(이름 프리셋 모양 `{preset, language}`에도),
폼의 `FormState`·`fromConfig`·`sameForm`(더티 판정)·프리셋 선택 핸들러·제출 본문(이름 프리셋과 custom 양쪽),
그리고 BE `namedPresetSchema`·custom 스키마 두 팔. 테스트는 "이름 프리셋으로 바꿔 저장", "custom으로 저장",
"요약 언어만 바꿔 저장(더티 판정)"을 명시적으로 둔다.

## 6. 에러 문구

- FE `ApiError`는 이미 서버의 `code`를 싣고 화면이 code로 문구를 고른다(`fe/src/shared/api/client.ts`).
  이 패턴을 넓힌다: 화면은 `errors.<code>` 키가 있으면 그것을, 없으면 서버 `message`를 보여 준다.
- BE에서 사람용 한국어 `message`를 내는 곳(화자 삭제 충돌 2건, `speakers.service.ts`)에 code를 단다:
  `speaker_enrollment_in_progress`, `speaker_in_use_by_processing`. `message`는 남긴다(API 직접 호출자용) —
  영어로 바꾼다.
- `client.ts`의 fallback("알 수 없는 오류가 발생했어요.", "서버에 연결할 수 없어요.", `diskFullMessage`)은
  사전으로 옮긴다. axios 인터셉터는 React 밖이므로 `i18n.t`를 직접 부른다.
- worker 에러 코드(`errors.py`)는 이미 코드다 — FE의 기존 code→문구 매핑을 사전으로 옮긴다.
- **worker가 한국어 문구를 쓰는 곳**이 있고 그것이 화면까지 간다: `DISK_FULL`의 message
  (`pipeline/model_jobs.py`의 받기 중 ENOSPC, `models/disk.py`의 사전 용량 검사)는 한국어이고,
  `models/downloads.py`가 `<code>: <message>`로 `app_setting.model_readiness`에 적는다. 그것을 desktop 상태 창
  (`status-view.ts`의 `readinessErrorMessage`)과 FE 모델 화면(`features/models/lib/actions.ts`의
  `DISK_FULL` 분기, `j.error.message`를 그대로 표시)이 **원문 그대로** 그린다. 고친다:
  - worker 문구는 영어로 바꾼다(로그·알 수 없는 소비자용). 화면은 이 문구를 쓰지 않는다.
  - `DISK_FULL`은 FE·desktop 둘 다 **code로 사전 문구**를 고른다. 남은 용량 같은 수치가 필요하면 message를
    파싱하지 않는다 — 그 수치를 문구에 넣지 않는 일반 문구("디스크 공간이 부족해요 …")로 시작하고, 수치가
    필요해지면 job error에 구조화된 필드를 더하는 별도 변경으로 한다.
  - desktop의 `readinessErrorMessage`도 code를 먼저 보고 사전에 있으면 그것을, 없으면 message를 쓴다.
  - 구현 첫 단계의 전수 확인에 worker를 포함한다: `WorkerError(...)`의 message 중 `model_readiness`·
    `job.error`를 거쳐 화면에 닿는 것 전부. 이미 영어인 message(예: `llm_request_failed`)는 한국어 화면에 영어로
    새는 기존 문제이므로 같은 code 매핑으로 함께 덮는다.
- BE 전역에서 사람에게 보일 수 있는 한글 `message`가 더 있는지 구현 첫 단계에서 전수 확인한다
  (`HttpException` 계열 + zod 에러 포맷터).

## 7. 번역

영어는 Claude가 초안을 쓰고 다듬는다. 기준:

**용어집** (사전·코드 리뷰에서 이 표를 따른다)

| 한국어 | English | 비고 |
| --- | --- | --- |
| 담화 | Damwha | 제품명, 번역하지 않음 |
| 회의 | Meeting | |
| 발화 | Utterance | |
| 화자 | Speaker | |
| 화자 등록 | Enroll speaker | |
| 렌즈 | Lens / Lenses | |
| 요약 | Summary | |
| 녹음 / 실시간 녹음 | Recording / Live recording | |
| 처리 | Processing | |
| 다시 처리 | Reprocess | |
| 인식 언어 | Transcription language | |
| 요약 언어 | Summary language | |
| 화면 언어 | Display language | |
| 모델 받기 / 지우기 | Download / Remove model | |
| 저장한 발화 | Saved utterances | |
| 프리셋 (가볍게/표준/정확하게) | Preset (Light/Standard/Quality) | 코드의 light·standard·quality |

**문체.** 한국어는 지금의 해요체 그대로. 영어는 짧은 평서문, sentence case(버튼·제목 포함), 축약형 허용
("can't"), 느낌표 없음, 사람을 탓하지 않는 에러 문구("Couldn't reach the server" — "You …" 아님).

**길이.** 영어는 30–50% 길다. 문구 이전 PR마다 `en`으로 주요 화면 스크린샷을 찍어 넘침·줄바꿈을 본다
(버튼·배지·표 헤더·사이드바가 위험 지점). 고칠 때는 문구를 줄이는 것이 먼저, 레이아웃 변경은 그다음.

## 8. 테스트와 회귀 방지

- **기존 테스트 보존.** `fe/vitest.setup.ts`에서 i18n을 `ko`로 초기화한다. 한글 문구로 찾는 테스트 53개 파일은
  그대로 통과해야 한다 — 이전 PR에서 테스트가 깨지면 그것은 문구가 바뀌었다는 신호이지 테스트를 고칠 이유가 아니다.
- **키 누락.** `en`의 `satisfies`로 `tsc -b`(= `pnpm fe build`)가 잡는다. desktop 사전도 같다.
- **한글 유출 테스트.** 주요 화면(회의 목록·회의 상세·렌즈·화자·설정·저장한 발화)을 `en`으로 렌더하고 DOM
  텍스트에 한글(`\p{Script=Hangul}`)이 있으면 실패. 샘플 콘텐츠를 담는 픽스처는 영어 문자열로 만들어 예외 목록이
  필요 없게 한다.
- **하드코딩 가드.** `scripts/check-hangul.mjs` — 지정한 패키지의 `.ts`/`.tsx`에서 사전·테스트·주석을 뺀 한글
  문자열 리터럴·JSX 텍스트를 찾으면 실패. 허용 목록(로그 원문 등)은 파일 안에서 명시적으로 표시한다
  (`// i18n-allow: log`). 패키지의 이전이 끝나는 PR에서 그 패키지의 `lint`에 연결한다.
- **job 계약 픽스처.** `be/test/fixtures/job-payloads/`는 zod(`be/test/contract-fixtures.spec.ts`)와
  pydantic(`be/worker/tests/test_contracts.py`)이 **함께** 읽는다. 기존 v1–v5·v1 픽스처는 **손대지 않는다**
  (변환 테스트의 입력이다). process_meeting v6, summarize_meeting·extract_lenses v2, live_session v2 픽스처를
  더한다. v5를 정확히 가정하는 단정(`be/test/job-payload.spec.ts`의 빌더 결과, `be/worker/tests/
  test_contracts_live.py`, `be/worker/tests/test_db_persist.py`의 후속 job 삽입)은 v6/v2로 옮긴다 —
  "기존 테스트는 거의 그대로"는 FE 문구 테스트에 대한 말이고, 계약 테스트는 이 단계에서 상당수 바뀐다.
- **요약 언어.**
  - zod·pydantic 양쪽: v1–v5 process_meeting, v1 summarize/extract, v1 live_session이 `transcript`로
    변환되는가; v6/v2가 필드 없이 오면 거부되는가.
  - worker 후속 job 삽입이 `summary_language`를 `output_language`로 복사하는가.
  - 프롬프트 문장 선택(3가지).
  - 처리 설정: 부재 → env, env 부재 → `transcript`, PUT 필수.
  - 변이로 검증한다 — 복사 한 줄, 변환 기본값 하나를 바꿨을 때 테스트가 실패하는지 확인한다.
- **desktop.** `pickUiLanguage` 표 테스트, 언어 저장소(없음·깨짐·범위 밖·정상), 브리지 흐름(next → 저장 →
  메뉴 → show → 재질문, 저장 실패 시 이전 값 show, ⌘R 재부착), `apiChildEnv`가 `SUMMARY_LANGUAGE`를 싣는가.
  `pnpm --filter damwha-desktop exec vitest`로 돌린다(`pnpm desktop exec`는 0개 실행·exit 0).
- **수동.** 영어 OS 계정(또는 `defaults write kr.damwha.app AppleLanguages '("en-US")'`)으로 패키징 앱을 첫
  실행해 메뉴·상태 창·담화 화면·요약이 모두 영어인지, 설정에서 한국어로 바꾸면 메뉴까지 바뀌는지 본다.

## 9. 작업 순서

각 단계는 하나 이상의 PR이다. 1과 2는 서로 독립이다.

1. **기반** — contracts(`UI_LANGUAGES`, `SUMMARY_LANGUAGES`, `pickUiLanguage`), FE i18n 인프라와 `?lang`·
   localStorage, 설정 "일반"의 화면 언어, desktop 언어 저장소·브리지·메뉴 재구성·desktop 사전 뼈대.
   이 단계에서 옮기는 문구는 설정 "일반"과 메뉴뿐이다.
2. **요약 언어** — BE 설정·env, job 계약 v6/v2(zod·pydantic), worker 후속 job 복사와 프롬프트, FE 설정 항목,
   desktop `SUMMARY_LANGUAGE`. 실제 모델로 출력 언어 확인(§5.3).
3. **FE 문구 이전** — feature별 PR: meeting → lens → speaker → settings·models·hf-token → demo·tour·shared.
   마지막 PR에서 FE 한글 유출 테스트와 하드코딩 가드를 켠다.
4. **desktop 문구 이전** — causes → 상태 창·셸 HTML → 다이얼로그·종료 흐름·셸 안내. 끝에서 가드를 켠다.
5. **에러 코드** — §6의 전수 확인과 BE code, FE `errors` 네임스페이스.
6. **문서** — `fe/CLAUDE.md`·`desktop/CLAUDE.md`에 i18n 규칙(사전 위치, 새 문구 추가법, 로그는 번역하지 않음,
   가드), 루트 CLAUDE.md의 contracts 설명.

## 10. 위험과 열린 질문

- **작은 로컬 모델의 언어 지시 준수**(§5.3) — 구현 때 모델별로 확인한다.
- **문구 이전 중 의미 변화** — 기계적 이전과 번역을 같은 PR에서 하되, 한국어 원문은 한 글자도 바꾸지 않는다.
  한국어 문구 개선은 별도 PR.
- **FE 테스트가 `ko` 고정에 기대는 것** — 영어 경로는 유출 테스트와 수동 확인이 덮는다. 영어 전용 동작
  (복수형, `Intl` 포맷)은 개별 단위 테스트를 둔다.

## 11. 리뷰 기록

**codex (gpt-5.6-terra, reasoning medium), 2026-09-26.** 8건, 모두 코드에서 재현 확인 후 반영했다.

| # | codex 심각도 | 지적 | 반영 |
| --- | --- | --- | --- |
| 1 | P1 → **P2로 낮춤** | API의 라이브 마무리 경로(`finalizeWithoutWorker`)가 누락 | §5.2. 옛 process v5를 그대로 넣어도 worker가 v5를 `transcript`로 읽으므로 잘못된 결과는 나지 않는다 — 누락된 것은 그 **불변식의 명시**와 테스트였다 |
| 2 | P1 | worker의 한국어 `DISK_FULL` 문구가 `model_readiness`를 거쳐 영어 화면에 샌다 | §6 |
| 3 | P2 | 요약·렌즈 클라이언트가 언어 인자를 받지 않는다 — 호출 사슬 미기술 | §5.3 |
| 4 | P2 | 렌즈에 `quote` 필드는 없다(사실 오류) | §5.3 |
| 5 | P2 | PUT 필수화가 FE 타입·폼 상태·더티 판정·BE 두 스키마까지 바꾼다 | §5.5 |
| 6 | P2 | 회의별 override 해석이 필드를 떨어뜨릴 수 있다 | §5.1 |
| 7 | P2 | 계약 픽스처·v5 단정 테스트의 이전 범위 누락 | §8 |
| 8 | P3 | token-bridge를 그대로 쓸 수 없다 — 별도 language-bridge, 세대 표시, `new URL()` | §4.1 |
