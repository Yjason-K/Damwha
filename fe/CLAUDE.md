# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`damwha-fe` is the web frontend for **Damwha** (담화, "conversation") — a personal/self-hosted conversation recording + search platform. A recording may be a meeting, an interview, a call, or just a conversation; nothing in the pipeline assumes "meeting". The backend (`damwha-be`, NestJS) is a **separate sibling git repo** (`../be`) serving meetings/speakers/jobs over REST. The core domain object is an **utterance** (speaker-attributed, timestamped, traceable to source audio).

`meeting` stays the term in code, DB, and API paths — that's an intentional scope decision (see below), not an oversight. Only UI copy and docs use "대화"/conversation.

Note on names: the directory is `daewha/fe` but the package is `damwha-fe` (mirrors `damwha-be`). The service is always "Damwha" in user-facing text. "Timbre" is the internal codename for the design system only — never surface it to users.

The API layer (Axios + TanStack Query) makes real requests against `damwha-be` — meetings/speakers/search and the `settings` feature (processing settings + spec detection) all call live endpoints.

## Product concept

Full spec: [`docs/product-concept.md`](docs/product-concept.md) (개념 정의서 v0.6). The essentials that shape the UI and data model:

- **Primary object = utterance.** Every utterance ties to a **speaker · timestamp · source audio · surrounding context**. Search, organize, and review all build on this traceability. The signature capability is **utterance-jump**: from anywhere, jump to the exact moment and inspect original text + audio + adjacent turns.
- **Three jobs (priority order):** 기록 (record as structured speaker-attributed utterances) → 정리 (organize per-speaker/per-conversation; topics + paragraph summary is the **base layer** that applies to every recording, with typed extraction — action items/decisions/promises — as an **extension layer** on top, see Lenses below) → 검색 (compound search over date + topic + attendee + content). 추적 (tracing) is a by-product of traceability, **not** the product's center.
- **Browse-first shell, search always present.** Opening the app shows the meeting list (recognition over recall), not an empty search box. Search is a global ⌘K / top-bar action reachable from any screen — never a dedicated home. This is why `/app` is a three-pane shell: left = meetings/folders, center = transcript (speaker timeline + utterances), right = insight panel (summary + lenses).
- **Lenses** = an extension layer over utterances, not an optional toggled-on view — it simply yields nothing when a conversation isn't meeting-shaped (0 extracted items ⇒ the section disappears on its own; no conversation-type field was introduced to gate it). v1 kinds: FE `LensKind` is `action | decision | promise` — `topic` was removed from the lens domain; topics now live in the summary base layer, not as a lens. Generated via AI auto-extraction. Scoped per-meeting (right panel) or global (left-nav view). Extraction is **non-blocking + post-editable**: auto-filled with no gate, each item carries a source (AI / user-added / user-edited), confidence is only a non-blocking hint, and re-extraction is non-destructive (human-touched items are preserved/merged).
- **Pipeline:** `audio → VAD → diarization → identification (vector DB / cosine similarity) → STT (Whisper) → structured JSON → search indexing (+ optional type extraction) → store`. Speaker identity comes from one-time voiceprint enrollment.
- **Privacy stance:** personal/self-hosted; all voiceprints stored locally only, no recording notice. The boundary is **export/share** — keep it disabled by default with intentional friction (confirm/warn).
- **Non-goals (initial):** team collaboration/wiki, per-member analytics dashboards (surveillance-flavored), meeting knowledge graph. The product is a _personal_ meeting memory, not a team monitoring tool.

## Commands

This repo requires **Node 22** and **pnpm** (`engine-strict=true`; npm/yarn will fail). Fresh shells on this machine often default to Node 20 — activate 22 inline per command if `node -v` is wrong: `nvm use 22 && pnpm ...`.

```bash
pnpm install          # install deps
pnpm dev              # Vite dev server
pnpm build            # tsc -b (project-references typecheck) THEN vite build
pnpm preview          # serve the production build
pnpm lint             # eslint .
pnpm format           # prettier --write .
pnpm test             # vitest run (jsdom)
pnpm test:watch       # vitest watch mode

# single test file / by name
pnpm vitest run src/pages/home.test.tsx
pnpm vitest run -t "홈 페이지"
```

`pnpm build` runs the typecheck and the bundle separately — `tsc -b` is the source of truth for type errors (Vite does not typecheck). Run it (or `pnpm build`) to verify types.

`vitest.setup.ts` polyfills the Pointer Capture / `scrollIntoView` APIs jsdom lacks so Radix (Select etc.) works under test. Radix `Select` doesn't open on a jsdom click — in tests, focus the trigger then fire `keyDown` `ArrowDown` to open it, and click the option.

## Architecture

Vite 8 + React 19 SPA, **feature-based-lite** layout. Path alias `@/*` → `src/*` (configured in both `vite.config.ts` and `tsconfig.app.json` — keep them in sync).

- `src/main.tsx` — mount point, renders `<AppProviders/>` in StrictMode.
- `src/app/` — composition root.
  - `providers.tsx` assembles `QueryClientProvider` + `RouterProvider`. The QueryClient is created once via `useState(createQueryClient)`.
  - `router.tsx` — `createBrowserRouter`. `/` (home) and `*` (not-found) are **eager**; heavier routes (`/app` meeting shell, `/speakers`, `/settings` processing settings, `/showcase`) are **code-split** via `lazyRoute()` to keep the landing bundle small. Add new heavy routes through `lazyRoute`.
- `src/pages/` — one component per route.
- `src/shared/` — cross-cutting building blocks:
  - `api/client.ts` — single Axios instance (baseURL from env).
  - `api/query-client.ts` — `createQueryClient()` factory (staleTime 60s, retry 1).
  - `config/env.ts` — typed access to `import.meta.env` (`VITE_API_BASE_URL`). Read env **only** through this module.
  - `lib/utils.ts` — `cn()` (clsx + tailwind-merge).
  - `ui/` — shadcn/Radix components (the `@/shared/ui` alias).

Future features go under `src/features/<feature>/`, each owning its own `api`/`ui`/`model`. Don't create empty placeholder folders.

The `/app` route (`pages/meeting.tsx`) is the product's **three-pane browse shell**: nav rail `<nav>` + content `<main>` + insight `<aside>`, the rails sized by the `--rail-nav` / `--rail-insight` layout variables. It runs on live meeting data via TanStack Query hooks. (`--topbar-h` and `--content-max` are declared in `index.css` but currently unused — check them before inventing a new value.)

`src/features/meeting/` owns the `/app` shell's data layer. `api/mappers.ts`'s `toMeetingDetail` maps `summary` — embedded in the `GET /meetings/:id` response — into `topics`/`segments`/`summaryStatus` on the `Meeting` domain type; `api/meetings.ts` adds `useGenerateSummary` (regenerate) and `useSyncSummaryStatus` (reconciles the polled `/status` summary state into the detail cache). Per-meeting lenses are a separate fetch: `api/lenses.ts`'s `useMeetingLenses` calls its own `GET /meetings/:id/lenses` endpoint, mapped via `mapMeetingLenses`. `ui/insight-pane.tsx` is the right rail — tabs are `요약 / 파일 / 메모` (참석자 is no longer its own tab); the 요약 tab stacks 참석자 → 주요 주제 → 다음 할 일 → 핵심 결정 → 단락별 요약.

`src/features/settings/` (처리 설정) owns the processing-config surface: `api` (`useProcessingSettings` / `useUpdateProcessingSettings` / `useCapabilities`), `lib` (`PRESET_META` + `PRESET_META_REVISION` — **keep synced with the BE preset definitions**; a `preset_revision` mismatch surfaces a drift notice), and `ui` (`ProcessingSettingsForm`, `OverrideSection`). Reached via LeftNav "처리 설정" → the `/settings` route.

- **Override UI exposes preset selection only.** `OverrideSection` (used by upload + reprocess dialogs) lets the user pick a per-job preset; the server contract still accepts individual field overrides, but the UI is intentionally scoped down (approved product-scope reduction) to avoid the confusion of per-knob edits resolving to "custom".
- **Reprocess UI:** the `TranscriptPane` header shows a `rotateCcw` button **only for `done`/`failed` meetings** → opens `ReprocessDialog` → `useReprocessMeeting` (in `features/meeting`).
- **GPU is conservative by default:** GPU is allowed only when `caps?.gpu_eligible === true` (unknown/loading/failed ⇒ disallowed). Because every preset uses GPU diarization, preset cards are disabled when not eligible. The GPU switch is asymmetric — turning **on** (cpu→gpu) is blocked when ineligible, but turning **off** (gpu→cpu) is always allowed (recovery path for a migrated DB).

`src/features/lens/` (전역 렌즈 대시보드) owns the "모든 회의" view — `api` (`useLensList` infinite query, `useLensExtractionStatus` polling every 10s, `useSetLensCompletion`, `useRetryExtraction`), `lib/map-item.ts` (wire → view mapping incl. primary evidence), `model` (`LENS_META` = **action/decision/promise only**), and `ui` (`LensDashboard`, `LensList`, `LensFilterBar`, `LensExtractionBanner`). Design: `../be/docs/superpowers/specs/2026-07-21-lens-global-dashboard-design.md`.

- **`topic` is not a dashboard kind.** Topics are saved searches (roadmap 작업 4), so the lens domain here carries three kinds; don't reuse the meeting-domain `LensKind`.
- **Completion filter is a single-value segment** (`열림|완료`) because BE `completion_status` takes one value — there is no combined view. Toggling completion optimistically removes the row from the current list.
- **Evidence jump switches to the meeting view and highlights the utterance — no audio seek** (deliberate, spec 비범위). Historical items whose utterance no longer exists after reprocess surface a toast instead of a silent no-op.

## Styling & design system

**Read [`DESIGN.md`](DESIGN.md) before creating or modifying any UI.** It holds the design intent, the "situation → token" index, interaction-state requirements, and the hard Don'ts (light-only, no raw hex, no shadows on flat cards, no ad-hoc tokens). Don't re-derive visual decisions per screen — DESIGN.md is what keeps them consistent.

Division of labor: `DESIGN.md` = how it should look and why · `src/index.css` = the actual values (single SoT) · `src/shared/ui/` = the implementation. **Never copy token values into `DESIGN.md`** — it names tokens only, so the two can't drift.

**Tailwind v4 via `@tailwindcss/vite` — there is no `tailwind.config`.** All theming is CSS-first in `src/index.css`:

- `:root` holds the Damwha (Timbre) design tokens: raw scales (`--gray-*`, `--accent-*`, speaker palette `--spk-N-*`) and **semantic aliases** (`--surface-*`, `--text-*`, `--border-*`). Reference the semantic aliases in components, not raw scales.
- The **shadcn token contract** (`--background`, `--primary`, `--sidebar-*`, …) is mapped _onto_ those Timbre semantics at the bottom of the `:root` block, so shadcn components render on-brand automatically. Caveat: shadcn's `--accent` means "hover/subtle surface", and the brand blue is `--primary` (not `--accent`).
- `@theme inline` / `@theme` blocks expose these as Tailwind utilities (`bg-primary`, `text-spk-1-text`, `rounded-md`, dense `text-*` scale, Geist fonts).

shadcn config (`components.json`): **new-york** style, `lucide` icons, aliases pointing at `@/shared/*`. Components follow the CVA pattern — variants defined with `class-variance-authority`, co-located with the component, e.g. `buttonVariants` exported alongside `Button`.

**When you add a new `<name>Variants` CVA export**, register the name in `eslint.config.js` under `react-refresh/only-export-components` → `allowExportNames` (currently: `buttonVariants`, `badgeVariants`, `cardVariants`, `iconButtonVariants`). Otherwise lint fails.

## Conventions

- **TypeScript strict + `verbatimModuleSyntax`** → type-only imports must use `import type { ... }`. `noUnusedLocals`/`noUnusedParameters` are on.
- **Prettier:** double quotes, semicolons, trailing comma `all`, printWidth 80. Run `pnpm format` before finishing.
- UI copy, commit messages, and design/spec docs are written in **Korean**.
- Honor `prefers-reduced-motion` (already handled globally in `index.css`); convey loading state via `aria-busy` / `role="status"`, not motion alone.

## Docs

`docs/superpowers/specs/` and `docs/superpowers/plans/` are **dated snapshots** (e.g. the scaffold design/plan) and are not edited after the fact. Record ongoing/changed decisions in the **living docs** instead:

- `CLAUDE.md` (this file) — how to work in this repo
- `DESIGN.md` — how the UI should look; keep its token index in sync when `src/index.css` tokens change
- `docs/product-concept.md` — what the product is (개념 정의서)

## Behavioral guidelines

Guidelines to reduce common LLM coding mistakes. **Tradeoff:** these bias toward caution over speed — for trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
