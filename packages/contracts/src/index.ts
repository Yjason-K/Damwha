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
