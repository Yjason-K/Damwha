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
 * Keep this package dependency-free and value-only. It is imported by a NestJS
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
