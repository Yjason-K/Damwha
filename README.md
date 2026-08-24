# Damwha (담화)

Personal, self-hosted conversation recording and search. The primary object is the
**utterance** — speaker-attributed, timestamped, and traceable back to the original
audio. Everything runs locally: no cloud ML, voiceprints stay on disk.

## Packages

| Path | Package | Stack |
| --- | --- | --- |
| `be/` | `damwha-be` | NestJS 10 HTTP API — raw SQL over Postgres (pgvector + pg_bigm), no ORM |
| `be/worker/` | *(uv project)* | Python 3.12 ML worker: ffmpeg → VAD → diarization → speaker ID → STT → align, plus lens/summary extraction via a local LLM |
| `fe/` | `damwha-fe` | React 19 + Vite 8 + Tailwind 4 SPA |

The API and the worker never talk over HTTP — the Postgres `job` table is the only
contract between them (zod on the TypeScript side, pydantic on the Python side).
`be/worker` is managed by uv and is **not** a pnpm workspace member.

## Quickstart

Requires Node 22 (`.nvmrc`), Docker, and [uv](https://docs.astral.sh/uv/).

```bash
corepack enable            # activates the pinned pnpm@10.26.0
pnpm install               # installs be + fe from the single root lockfile

cp be/.env.example be/.env                # DATABASE_URL, STORAGE_ROOT, model envs
cp be/worker/.env.example be/worker/.env  # DATABASE_URL, LENS_LLM_BASE_URL
cp fe/.env.example fe/.env                # VITE_API_BASE_URL

pnpm db:up                 # Postgres (pgvector + pg_bigm); first run builds the image
pnpm be:migrate            # apply SQL migrations
pnpm dev                   # API :3000 (Swagger /docs) + Vite :5173, in parallel
```

Python ML worker:

```bash
pnpm worker:sync                              # deterministic deps only (tests, no models)
pnpm worker:test                              # pytest — needs Docker (testcontainers)
uv sync --directory be/worker --extra models  # real ML models (mlx-whisper/pyannote/ECAPA)
pnpm worker                                   # run the supervisor
```

## Common tasks

```bash
pnpm build          # be + fe
pnpm test           # be (jest, needs Docker) + fe (vitest)
pnpm lint           # fe only — damwha-be has no lint script
pnpm be <script>    # any damwha-be script, e.g. `pnpm be test:e2e`
pnpm fe <script>    # any damwha-fe script, e.g. `pnpm fe format`
```

Run package commands from the repo root through these scripts, or `cd` into the
package first. Do **not** run `npm install` inside `be/` — it recreates a hoisted
`node_modules` and a `package-lock.json` that the workspace no longer uses.

## Working in this repo

Read [`be/CLAUDE.md`](be/CLAUDE.md) before touching the API or the worker (job
contract, ownership guards, measured speaker-ID thresholds), and
[`fe/CLAUDE.md`](fe/CLAUDE.md) + [`fe/DESIGN.md`](fe/DESIGN.md) before touching the
UI. Those are the living docs; [`CLAUDE.md`](CLAUDE.md) at the root only carries
the monorepo map.
