/**
 * Wire enums both runtimes must agree on.
 *
 * These lists used to live in `be/src/contracts/model-catalog.ts` and again, by
 * hand, in `fe/src/features/settings/api/types.ts`. Nothing checked the two
 * copies against each other: when the summary catalog moved from Ollama tags to
 * HF repo ids (2026-08-12) the frontend kept sending the old strings and
 * `PUT /settings/processing` answered with a bare zod union failure —
 * `Invalid input`, no mention of which field or which values were allowed.
 * The repos were separate then, so there was nowhere to put a shared type.
 * They are one workspace now, so the list lives here and both sides import it.
 *
 * Keep this package dependency-free: values and pure helpers only. It is imported by a NestJS
 * CommonJS build and by a Vite ESM build, so anything runtime-specific in here
 * breaks one of them.
 */

/**
 * Summary/lens LLM catalog. Values are what the LLM server receives verbatim:
 * `mlx_lm.server` reads the request's `model` as an HF repo id and offers no way
 * to alias it (see `be/worker/SMOKE.md`), so the catalog holds repo ids.
 */
export const SUMMARY_MODELS = [
  'mlx-community/Qwen3.5-4B-8bit',
  'mlx-community/Qwen3.5-9B-8bit',
  'mlx-community/Qwen3.5-27B-8bit',
] as const;
export type SummaryModel = (typeof SUMMARY_MODELS)[number];

/** Whisper sizes selectable in processing settings. */
export const WHISPER_MODELS = [
  'tiny',
  'base',
  'small',
  'medium',
  'large-v3',
  'large-v3-turbo',
] as const;
export type WhisperModel = (typeof WHISPER_MODELS)[number];

/** Named processing presets. A per-field override resolves to `custom`. */
export const PRESET_NAMES = ['light', 'standard', 'quality'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

/** Per-stage device request. `gpu` never falls back to `cpu` — see be/CLAUDE.md. */
export const DEVICES = ['cpu', 'gpu'] as const;
export type Device = (typeof DEVICES)[number];

/**
 * 전사 언어. Whisper는 디코딩 시작 토큰으로 언어를 **하나만** 받는다 — 목록을
 * 넘길 방법이 없어서 다중 선택은 이 계약에 존재하지 않는다. 문장 안에 영어
 * 단어가 섞이는 한국어(code-switching)는 `ko` 하나로 이미 전사된다.
 *
 * `auto`는 언어를 비워 whisper가 감지하게 하는 값이다(파일당 1개로 확정).
 * 워커가 `None`으로 변환한다 — `be/worker/damwha_worker/models/base.py`.
 *
 * 이 목록은 **쓰기 경로에서만** 강제된다. 읽기(저장된 행 / env `STT_LANGUAGE`)는
 * 자유 문자열을 계속 허용한다 — 목록을 도입하기 전에 저장된 값이 있기 때문.
 */
export const STT_LANGUAGES = ['auto', 'ko', 'en', 'ja', 'zh'] as const;
export type SttLanguage = (typeof STT_LANGUAGES)[number];

/**
 * 모델 역할 (모델 다운로드 관리 스펙 §4.3). 모델 목록 자체는 `WHISPER_MODELS`·`SUMMARY_MODELS`이고,
 * 고정 역할(화자 분리·화자 식별·검색 임베딩)의 모델 이름은 BE env가 정한다.
 */
export const MODEL_ROLES = [
  'stt',
  'summary',
  'diarization',
  'speaker_embedding',
  'search_embedding',
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** 지울 수 있는 역할. 고정 역할은 미리 받기만 된다 (Notion P2-D). */
export const DELETABLE_ROLES = ['stt', 'summary'] as const;

/** 전사 백엔드 — `devices.stt`가 gpu면 mlx, cpu면 faster (worker `models/registry.py`). */
export const STT_BACKENDS = ['mlx', 'faster'] as const;
export type SttBackend = (typeof STT_BACKENDS)[number];

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
