# CLAUDE.md

Repo-root guidance for the **Damwha** monorepo. The detailed, living docs are
per-package — read the one for the subtree you are editing before changing code.

## Monorepo map

| Path | Package | What it is |
| --- | --- | --- |
| `be/` | `damwha-be` | NestJS 10 API over Postgres (pgvector + pg_bigm), raw SQL, no ORM. Read [`be/CLAUDE.md`](be/CLAUDE.md). |
| `be/worker/` | *(uv project)* | Python 3.12 ML worker. **Not** a pnpm workspace member — it has no `package.json` and is driven by uv. |
| `fe/` | `damwha-fe` | React 19 + Vite 8 + Tailwind 4 SPA. Read [`fe/CLAUDE.md`](fe/CLAUDE.md) and [`fe/DESIGN.md`](fe/DESIGN.md). |
| `packages/contracts/` | `@damwha/contracts` | Wire enums both Node packages must agree on (`SUMMARY_MODELS`, `WHISPER_MODELS`, `PRESET_NAMES`, `DEVICES`). Dependency-free, value-only. |

The API and the worker communicate **only** through the Postgres `job` table
(zod on the TypeScript side, pydantic on the Python side) — never over HTTP.

`@damwha/contracts` exists because `be` and `fe` were separate repos until the
2026-08 merge, so any list both sides had to agree on was kept twice by hand.
That drifted for real: when the summary catalog moved from Ollama tags to HF
repo ids (2026-08-12), the frontend kept sending the old strings and
`PUT /settings/processing` answered with a bare zod union failure —
`Invalid input`, naming neither the field nor the allowed values. The package
**ships both CJS and ESM** (`dist/cjs` for the NestJS `require()` build,
`dist/esm` for Vite) — a CJS-only build passes `vite build` and vitest, which
pre-bundle it, and then fails only in `vite dev`, which serves a linked
workspace package as ESM and finds no named exports. `pnpm install` builds it
through the package's `prepare` script; `pnpm build` from the root covers it
too, since pnpm orders workspace builds by dependency.

## Commands

pnpm 10.26.0 is pinned in the root `package.json` and activated by corepack.

```bash
pnpm install                  # from the ROOT — one lockfile covers be + fe
pnpm dev                      # API :3000 + Vite :5173 in parallel
pnpm build / test / lint      # fan out across both packages
pnpm be <script>              # any damwha-be script  (= pnpm --filter damwha-be run)
pnpm fe <script>              # any damwha-fe script
pnpm db:up / db:down          # Postgres via be/docker-compose.yml
pnpm worker / worker:test     # uv run --directory be/worker ...
pnpm worker:sync              # uv sync --extra models — the real worker's venv
pnpm worker:sync:test         # same venv, models stripped (tests only)
```

Hard rules:

- **`npm install` inside `be/` is forbidden.** It recreates `package-lock.json`
  and a hoisted `node_modules`, which re-masks undeclared dependencies. `multer`
  was exactly that bug: `be/src/storage/upload-options.ts` imports it while only
  `@nestjs/platform-express` declared it.
- **Never launch a package from the repo root.** `be` loads `.env` via dotenv and
  resolves `STORAGE_ROOT=./storage` against `process.cwd()`; the worker does the
  same with `../storage`. Running either from the root silently repoints them at
  an empty directory. Every root script above delegates with `--filter` /
  `uv run --directory`, which sets the cwd correctly.
- **`.env` files stay per-package.** `be/.env`, `be/worker/.env`, `fe/.env` — the
  same key `STORAGE_ROOT` intentionally holds different values in the first two.
  There is no root `.env` and there must not be one.
- **`be/docker-compose.yml` stays in `be/`.** Compose derives its project name
  from the compose file's directory; moving it to the root would rename the
  project `be` → `daewha` and orphan the `be_pgdata` volume.

## History

`be/` and `fe/` were separate GitHub repos (`Damwha_BE`, `Damwha_FE`) until the
2026-08 merge. Both histories were rewritten into their subdirectories with
`git filter-repo --to-subdirectory-filter` and are preserved in full — `git log
-- be/src` and `git log -- fe/src` reach back to each repo's first commit.
Historical docs under `be/docs/` and `fe/docs/` still say "별도 레포" and refer to
`../be` / `../fe`; those are dated snapshots that are not edited after the fact —
read those paths as repo-root-relative `be/` and `fe/`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships. It is gitignored — regenerate it locally.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
