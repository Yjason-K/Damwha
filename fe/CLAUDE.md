# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`damwha-fe` is the web frontend for **Damwha** (담화, "conversation") — a personal/self-hosted conversation recording + search platform. A recording may be a meeting, an interview, a call, or just a conversation; nothing in the pipeline assumes "meeting". The backend (`damwha-be`, NestJS) lives in the **same repo** at `be/` — a pnpm workspace sibling — serving meetings/speakers/jobs over REST. The core domain object is an **utterance** (speaker-attributed, timestamped, traceable to source audio).

`meeting` stays the term in code, DB, and API paths — that's an intentional scope decision (see below), not an oversight. Only UI copy and docs use "대화"/conversation.

Note on names: the directory is `fe/` but the package is `damwha-fe` (mirrors `damwha-be`) — that package name is what `pnpm --filter damwha-fe` takes. The service is always "Damwha" in user-facing text. "Timbre" is the internal codename for the design system only — never surface it to users.

The API layer (Axios + TanStack Query) makes real requests against `damwha-be` — meetings/speakers/search and the `settings` feature (processing settings + spec detection) all call live endpoints.

## Product concept

Full spec: [`docs/product-concept.md`](docs/product-concept.md) (개념 정의서 v0.6). The essentials that shape the UI and data model:

- **Primary object = utterance.** Every utterance ties to a **speaker · timestamp · source audio · surrounding context**. Search, organize, and review all build on this traceability. The signature capability is **utterance-jump**: from anywhere, jump to the exact moment and inspect original text + audio + adjacent turns.
- **Three jobs (priority order):** 기록 (record as structured speaker-attributed utterances) → 정리 (organize per-speaker/per-conversation; topics + paragraph summary is the **base layer** that applies to every recording, with typed extraction — action items/decisions/promises — as an **extension layer** on top, see Lenses below) → 검색 (compound search over date + topic + attendee + content). 추적 (tracing) is a by-product of traceability, **not** the product's center.
- **Browse-first shell, search always present.** Opening the app shows the meeting list (recognition over recall), not an empty search box. Search is a global ⌘K / top-bar action reachable from any screen — never a dedicated home. This is why `/meetings/:meetingId` is a three-pane shell: left = meetings/folders, center = transcript (speaker timeline + utterances), right = insight panel (summary + lenses).
- **Lenses** = an extension layer over utterances, not an optional toggled-on view — it simply yields nothing when a conversation isn't meeting-shaped (0 extracted items ⇒ the section disappears on its own; no conversation-type field was introduced to gate it). v1 kinds: FE `LensKind` is `action | decision | promise` — `topic` was removed from the lens domain; topics now live in the summary base layer, not as a lens. Generated via AI auto-extraction. Scoped per-meeting (right panel) or global (left-nav view). Extraction is **non-blocking + post-editable**: auto-filled with no gate, each item carries a source (AI / user-added / user-edited), confidence is only a non-blocking hint, and re-extraction is non-destructive (human-touched items are preserved/merged).
- **Pipeline:** `audio → VAD → diarization → identification (vector DB / cosine similarity) → STT (Whisper) → structured JSON → search indexing (+ optional type extraction) → store`. Speaker identity comes from one-time voiceprint enrollment.
- **Privacy stance:** personal/self-hosted; all voiceprints stored locally only, no recording notice. The boundary is **export/share** — keep it disabled by default with intentional friction (confirm/warn).
- **Non-goals (initial):** team collaboration/wiki, per-member analytics dashboards (surveillance-flavored), meeting knowledge graph. The product is a _personal_ conversation memory, not a team monitoring tool.

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
pnpm vitest run src/pages/index-route.test.tsx
pnpm vitest run -t "회의가 있으면 첫 회의로 리다이렉트한다"
```

`pnpm build` runs the typecheck and the bundle separately — `tsc -b` is the source of truth for type errors (Vite does not typecheck). Run it (or `pnpm build`) to verify types.

`vitest.setup.ts` polyfills the Pointer Capture / `scrollIntoView` APIs jsdom lacks so Radix (Select etc.) works under test. Radix `Select` doesn't open on a jsdom click — in tests, focus the trigger then fire `keyDown` `ArrowDown` to open it, and click the option.

## Architecture

Vite 8 + React 19 SPA, **feature-based-lite** layout. Path alias `@/*` → `src/*` (configured in both `vite.config.ts` and `tsconfig.app.json` — keep them in sync).

- `src/main.tsx` — mount point, renders `<AppProviders/>` in StrictMode.
- `src/app/` — composition root.
  - `providers.tsx` assembles `QueryClientProvider` + `RouterProvider`. The QueryClient is created once via `useState(createQueryClient)`.
  - `router.tsx` — `createBrowserRouter`. `AppShell` (`app/app-shell.tsx`) is a layout route owning the grid, `LeftNav`, and the ⌘K command palette; nested under it: `index` (redirects to the newest meeting), `meetings/:meetingId`, `lenses/:kind`, `speakers`, `settings`, `*` (not-found). `/showcase` sits outside the shell. The shell and the index route are **eager**; the rest are **code-split** via `lazyRoute()` to keep the landing bundle small. Add new heavy routes through `lazyRoute`. `routes` is also exported separately so tests build the same tree via `createMemoryRouter(routes, { initialEntries })`.
- `src/pages/` — one component per route.
- `src/shared/` — cross-cutting building blocks:
  - `api/client.ts` — single Axios instance (baseURL from env).
  - `api/query-client.ts` — `createQueryClient()` factory (staleTime 60s, retry 1).
  - `config/env.ts` — typed access to `import.meta.env` (`VITE_API_BASE_URL`). Read env **only** through this module.
  - `lib/utils.ts` — `cn()` (clsx + tailwind-merge).
  - `ui/` — shadcn/Radix components (the `@/shared/ui` alias).

Future features go under `src/features/<feature>/`, each owning its own `api`/`ui`/`model`. Don't create empty placeholder folders.

The shell (`AppShell`, `app/app-shell.tsx`) owns the nav rail `<nav>` (sized by `--rail-nav`) and the ⌘K palette; `pages/meeting.tsx`'s `/meetings/:meetingId` view is the product's **three-pane browse shell** made concrete — content `<main>` (transcript) + insight `<aside>` (sized by `--rail-insight`) render inside the shell's `<Outlet/>`. It runs on live meeting data via TanStack Query hooks. (`--topbar-h` and `--content-max` are declared in `index.css` but currently unused — check them before inventing a new value.)

`src/features/meeting/` owns the `/meetings/:meetingId` view's data layer. `api/mappers.ts`'s `toMeetingDetail` maps `summary` — embedded in the `GET /meetings/:id` response — into `topics`/`segments`/`summaryStatus` on the `Meeting` domain type; `api/meetings.ts` adds `useGenerateSummary` (regenerate; takes an optional `summary_model` sent as the request body — omitted means the server falls back to the global processing setting, and the override is never persisted; a 409 means a different model is already summarizing and gets its own toast, distinct from the generic failure toast) and `useSyncSummaryStatus` (reconciles the polled `/status` summary state into the detail cache). Per-meeting lenses are a separate fetch: `api/lenses.ts`'s `useMeetingLenses` calls its own `GET /meetings/:id/lenses` endpoint, mapped via `mapMeetingLenses`. `api/notes.ts`'s `useAutosaveNote`도 같은 이유로 `GET`/`PUT /meetings/:id/note`를 상세와 분리된 `["meeting-note", id]` 쿼리 키로 쓴다 — 자동저장이 상세 캐시(`["meeting", id]`)를 건드리면 그 캐시를 구독하는 전사 패널 전체가 800ms마다 리렌더된다. `ui/insight-pane.tsx` is the right rail — tabs are `요약 / 파일 / 메모` (참석자 is no longer its own tab); the 요약 tab stacks 요약 모델 선택 → 참석자 → 주요 주제 → 다음 할 일 → 핵심 결정 → 단락별 요약. The regeneration model-select state is owned by `src/pages/meeting.tsx` and passed down as props; `InsightPane` stays presentational.

`src/features/settings/` (처리 설정) owns the processing-config surface: `api` (`useProcessingSettings` / `useUpdateProcessingSettings` / `useCapabilities`), `lib` (`PRESET_META` — each preset also pins a `summary_model` — + `SUMMARY_MODEL_OPTIONS` + `PRESET_META_REVISION` — **keep synced with the BE preset definitions**; a `preset_revision` mismatch surfaces a drift notice), and `ui` (`ProcessingSettingsForm`, `OverrideSection`). The same sync constraint covers `api/types.ts`'s `SummaryModel` union, a hand-maintained mirror of BE's `SUMMARY_MODELS` catalog — a value outside it is a server 400 on PUT. Reached via LeftNav "처리 설정" → the `/settings` route.

- **업로드 모달은 후속 처리(렌즈/요약)를 미룰 수 있다.** 렌즈/요약 각각 실행 시점을 `SegmentedControl`(`자동 실행 | 나중에 실행`)로 고르고 **기본은 자동 실행**이라 기본 동작은 예전과 같다 — 전사 직후 워커가 두 job을 자동으로 건다. 스위치를 쓰지 않는 이유는 `"...은 나중에" + ON/OFF`가 이중 부정이라 ON이 "실행"인지 "미룸"인지 한 번 더 해석해야 했기 때문. "나중에 실행"을 고르면 multipart에 `defer_lens`/`defer_summary`가 `"true"`로 실리고, BE가 `process_meeting` payload(wire **v5**)의 `followups`를 꺼서 워커가 해당 후속 job을 큐잉하지 않는다. 미룬 뒤 실행하는 경로는 인사이트 패널이 준다: 요약은 `summaryStatus`가 null이라 기존 "요약 만들기"가 그대로 뜨고, 렌즈는 `GET /meetings/:id/lenses`가 함께 주는 `extraction_status`(현재 처리 버전의 마지막 run 상태, null = 돌린 적 없음)로 `LensState`가 "지금 찾기"/"다시 찾기"를 그린다 — **0건과 미실행을 가르는 값이 이것뿐이라** 이 필드 없이는 미룬 회의가 빈 화면으로만 보인다. `'done'`이면 아무것도 그리지 않아 "추출했는데 0건이면 섹션이 사라진다"는 원칙이 유지된다. 버튼은 기존 `useRetryExtraction`(`POST /meetings/:id/lenses/extract`)을 재사용하고, `queued`/`running` 동안 `useMeetingLenses`가 5초 폴링한다. 둘 다 `status='done'`에서만 눌린다. 재처리 다이얼로그에는 이 스위치가 **없다**: 이미 있는 결과를 새 버전으로 갈아끼우는 흐름이라 후속도 같이 따라가야 한다.
- **Override UI exposes preset + summary model.** `OverrideSection` (used by upload + reprocess dialogs) lets the user pick a per-job preset and summary model; the server contract still accepts the other individual field overrides (whisper/devices/language), but the UI keeps those hidden (approved product-scope reduction) to avoid the confusion of per-knob edits resolving to "custom" — summary model is the one exception, exposed because "just this once, bigger model" is a clear enough ask (it still resolves to `custom` server-side).
- **화자 확인(`ResolveDialog`)은 워커의 2단계 판정을 그대로 받는다.** BE는 성문 점수가 `IDENTIFY_THRESHOLD` 이상이면 클러스터를 곧바로 그 화자에 묶고(이 경우 여기 안 나온다), 그 아래 `IDENTIFY_SUGGEST_THRESHOLD`까지의 제안 구간에 걸리면 클러스터에 **자기 화자를 그대로 둔 채** 후보만 달아 보낸다(`suggested_speaker_id` / `suggested_speaker_name` / `suggested_similarity`, BE 마이그레이션 `018`). 다이얼로그는 그 후보를 **미리 골라두고** "추천 · 유사도 NN%" 힌트로 이유를 밝히되, 연결은 사용자가 버튼을 눌러야 일어난다. 확정/거절 어느 쪽이든 기존 `POST /meetings/:id/clusters/:clusterId/resolve`가 처리하고 서버가 제안을 지운다 — 별도 엔드포인트는 없다.
- **선택 목록은 `ready` + `provisional` 둘 다다.** `ready`만 담으면 신규 설치는 `ready` 화자가 0명이라 드롭다운이 통째로 비고, 같은 사람을 회의 간에 이어붙일 방법이 사라진다(BE의 원래 버그와 같은 가정이었다). `pending`/`failed`는 성문이 아직 없거나 실패한 상태라 계속 제외하고, 클러스터가 이미 물고 있는 화자도 자기 자신으로의 연결이라 뺀다. `provisional` 화자는 이름이 전부 자동 생성 `Speaker_NNN`이므로 구분 라벨 없이 구분선으로만 나눈다.
- **Reprocess UI:** the `TranscriptPane` header shows a `rotateCcw` button **only for `done`/`failed` meetings** → opens `ReprocessDialog` → `useReprocessMeeting` (in `features/meeting`).
- **GPU is conservative by default:** GPU is allowed only when `caps?.gpu_eligible === true` (unknown/loading/failed ⇒ disallowed). Because every preset uses GPU diarization, preset cards are disabled when not eligible. The GPU switch is asymmetric — turning **on** (cpu→gpu) is blocked when ineligible, but turning **off** (gpu→cpu) is always allowed (recovery path for a migrated DB).

`src/features/lens/` (전역 렌즈 대시보드) owns the "모든 회의" view — `api` (`useLensList` infinite query, `useLensExtractionStatus` polling every 10s, `useSetLensCompletion`, `useRetryExtraction`), `lib/map-item.ts` (wire → view mapping incl. primary evidence), `model` (`LENS_META` = **action/decision/promise only**), and `ui` (`LensDashboard`, `LensList`, `LensFilterBar`, `LensExtractionBanner`). Design: `../be/docs/superpowers/specs/2026-07-21-lens-global-dashboard-design.md`.

- **`topic` is not a dashboard kind.** Topics are saved searches (roadmap 작업 4), so the lens domain here carries three kinds; don't reuse the meeting-domain `LensKind`.
- **Completion filter is a single-value segment** (`열림|완료`) because BE `completion_status` takes one value — there is no combined view. Toggling completion optimistically removes the row from the current list.
- **Evidence jump navigates to `/meetings/:id?u=<utteranceId>`** — the URL carries both the highlight and the audio seek, so search jumps and lens evidence jumps now behave identically (the earlier "no audio seek" carve-out is gone). Historical items whose utterance no longer exists after reprocess surface a toast and drop `?u=` with `replace: true`.

**URL contract:** `/` → replace-redirects to the newest meeting in the list · `/meetings/:id` meeting detail · `/meetings/:id?u=<utteranceId>` highlights that utterance and seeks the audio to it · `/lenses/:kind` global lens dashboard · `/speakers` · `/settings`. The insight-pane tab and the meeting-list filter are intentionally not carried in the URL.

## Styling & design system

**Read [`DESIGN.md`](DESIGN.md) before creating or modifying any UI.** It holds the design intent, the "situation → token" index, interaction-state requirements, and the hard Don'ts (light-only, no raw hex, no shadows on flat cards, no ad-hoc tokens). Don't re-derive visual decisions per screen — DESIGN.md is what keeps them consistent.

Division of labor: `DESIGN.md` = how it should look and why · `src/index.css` = the actual values (single SoT) · `src/shared/ui/` = the implementation. **Never copy token values into `DESIGN.md`** — it names tokens only, so the two can't drift.

**The visual tone is Cal.com** (reference spec: `DESIGN-cal.md` at the repo root). What that retone actually moved: the neutral ramp, the accent ramp, the semantic + speaker palettes, the radius scale, and the fonts — nothing else. Two consequences worth internalising before you touch a component:

- **The action layer is achromatic.** `--primary` / `--accent-solid` is ink black, and so is the focused-input border (`--border-focus`). Blue survives only as the "where am I" signal — `--accent-bg` / `--accent-text` / `--text-link` / `--focus-ring`. Splitting the axis is what keeps a selected row distinguishable from a hovered one, since hover is a neutral gray face. Don't "fix" the black button back to a blue one.
- **Density and the brand mark were out of scope.** The dense `--text-*` scale, `--rail-nav` / `--rail-insight`, spacing and layout, and `BrandMark` / `favicon.svg` / the `theme-color` meta are all unchanged, deliberately. Cal is a marketing surface with generous whitespace and a page-closing dark footer; the three-pane shell has neither and can't absorb them.

**Tailwind v4 via `@tailwindcss/vite` — there is no `tailwind.config`.** All theming is CSS-first in `src/index.css`:

- `:root` holds the Damwha (Timbre) design tokens: raw scales (`--gray-*`, `--accent-*`, speaker palette `--spk-N-*`) and **semantic aliases** (`--surface-*`, `--text-*`, `--border-*`). Reference the semantic aliases in components, not raw scales.
- The **shadcn token contract** (`--background`, `--primary`, `--sidebar-*`, …) is mapped _onto_ those Timbre semantics at the bottom of the `:root` block, so shadcn components render on-brand automatically. Caveat: shadcn's `--accent` means "hover/subtle surface", and the primary action colour is `--primary` (not `--accent`) — post-retone that colour is ink black, so don't call it "the brand blue".
- `--accent-*` is deliberately not a single hue: `9`/`10` are the black action steps, `1`/`2`/`3`/`6`/`11`/`12` stay on Cal's brand-accent blue. The `index.css` comment explains why; don't "normalise" the ramp.
- `@theme inline` / `@theme` blocks expose these as Tailwind utilities (`bg-primary`, `text-spk-1-text`, `rounded-md`, dense `text-*` scale, Inter / JetBrains Mono).

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
