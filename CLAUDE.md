# CLAUDE.md

Repo-root guidance for the **Damwha** monorepo. The detailed, living docs are
per-package — read the one for the subtree you are editing before changing code.

## Monorepo map

| Path | Package | What it is |
| --- | --- | --- |
| `be/` | `damwha-be` | NestJS 10 API over Postgres (pgvector + pg_bigm), raw SQL, no ORM. Read [`be/CLAUDE.md`](be/CLAUDE.md). |
| `be/worker/` | *(uv project)* | Python 3.12 ML worker. **Not** a pnpm workspace member — it has no `package.json` and is driven by uv. |
| `desktop/` | `damwha-desktop` | Electron macOS 앱 — 번들 PostgreSQL·API·worker·embed를 감독한다. Read [`desktop/CLAUDE.md`](desktop/CLAUDE.md). |
| `fe/` | `damwha-fe` | React 19 + Vite 8 + Tailwind 4 SPA. Read [`fe/CLAUDE.md`](fe/CLAUDE.md) and [`fe/DESIGN.md`](fe/DESIGN.md). |
| `site/` | `damwha-site` | Astro 7 정적 제품 사이트 — `damwha.0kimjae.dev`, `/`(en)·`/ko/`, Cloudflare Pages. Read [`site/README.md`](site/README.md). |
| `packages/contracts/` | `@damwha/contracts` | Wire enums and pure helpers both Node packages must agree on (`SUMMARY_MODELS`, `WHISPER_MODELS`, `PRESET_NAMES`, `DEVICES`, `UI_LANGUAGES`, `SUMMARY_LANGUAGES`, `pickUiLanguage`). Dependency-free. |
| `share/` | `damwha-share` | 공유 링크 서버 — Node 프로세스 하나가 암호문 API(`/api/shares`)와 정적 뷰어(`/s/:id`)를 디스크 파일 위에서 서빙한다. 개인 서버의 Docker(`deploy/share/`) + Cloudflare Tunnel로 `damwha-share.0kimjae.dev`. Read [`share/README.md`](share/README.md). |
| `packages/share-format/` | `@damwha/share-format` | 공유 봉투(AES-256-GCM + gzip)와 페이로드 모양, 공유 id 규칙. be가 암호화, 뷰어가 복호화. CJS+ESM. |
| `packages/share-view/` | `@damwha/share-view` | 공유본 React 렌더러(소스 TSX). fe 미리보기와 뷰어가 같이 쓴다. |

The API and the worker communicate **only** through Postgres — never over HTTP.
The `job` table is the contract in both directions (zod on the TypeScript side,
pydantic on the Python side); the other shared rows are three `app_setting` keys, all
written on the worker side and read-only for the API: `worker_capabilities` (the
worker — how the API reports the host Mac's spec instead of its own container's),
`model_readiness` (worker, embed and `llm_entry` — per-model download progress) and
`model_inventory` (the worker supervisor's inventory thread — which models are
in the HF cache and how big they are).

The API also sends **outbound** HTTP to the share server — the only external call
it makes (`be/src/shares/share-client.ts`). Sharing is on only when the API's
`HOST` is loopback and it is not a demo (`DEMO_READ_ONLY`); the share server's
expiry time is the authority.

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
pnpm site:dev                 # 제품 사이트 :4321 (pnpm dev에는 끼지 않는다)
pnpm build / test / lint      # fan out across both packages
pnpm be <script>              # any damwha-be script  (= pnpm --filter damwha-be run)
pnpm fe <script>              # any damwha-fe script
pnpm db:up / db:down          # Postgres via be/docker-compose.yml
pnpm worker / worker:test     # uv run --directory be/worker ...
pnpm embed                    # bge-m3 embed service on 127.0.0.1:8100 (foreground)
pnpm share:dev                # 공유 서버+뷰어 :8787 (데이터 share/.data). be/.env에 SHARE_API_URL=http://localhost:8787
pnpm share:test               # 공유 서버(node) + 뷰어(jsdom) 테스트
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
- **`be/docker-compose.yml` pins `name: damwha`.** The project used to be called
  `be` — the directory-derived default — so it renamed itself with the compose
  file. It is now explicit, and the live volume is `damwha_pgdata`; changing the
  `name:` orphans it. (The old, now-unused `be_pgdata` still holds the pre-rename
  copy of the data.)

## History

`be/` and `fe/` were separate GitHub repos (`Damwha_BE`, `Damwha_FE`) until the
2026-08 merge. Both histories were rewritten into their subdirectories with
`git filter-repo --to-subdirectory-filter` and are preserved in full — `git log
-- be/src` and `git log -- fe/src` reach back to each repo's first commit.
Historical docs under `be/docs/` and `fe/docs/` still say "별도 레포" and refer to
`../be` / `../fe`; those are dated snapshots that are not edited after the fact —
read those paths as repo-root-relative `be/` and `fe/`.

## Work records (spec · plan · result)

Non-trivial work leaves a dated record in `docs/superpowers/`, whichever agent
does it — the superpowers plugin is not required. Simple work leaves none.

- **Record** when the work changes behavior across two or more of `be/`, `fe/`,
  `desktop/`, `be/worker/`; touches a contract (`job` table, `@damwha/contracts`,
  an API shape, DB schema or migrations) or the packaging/release pipeline; runs
  through a planning workflow (omo `ulw-plan` / `mass ulw`); or the user asks for
  a spec first. When unsure, ask once before starting.
- **Skip** questions and investigations, one- or two-file fixes, typos, config
  one-liners, doc edits, commits/pushes.
- **Files** (Korean, same shape as the existing ones):
  - spec — `specs/YYYY-MM-DD-<slug>-design.md`, written once the design is
    approved: 작성일, 선행 branch/commit, what it supersedes, 목표, 범위.
  - plan — `plans/YYYY-MM-DD-<slug>.md`, with a `**Spec:**` link. omo drafts and
    reviews plans in `.omo/plans/` (its tools need that path); copy the approved,
    reviewed plan here without the `superpowers:` sub-skill header line. Progress
    is tracked in `.omo/plans/`, not in the copy.
  - result — `reports/YYYY-MM-DD-<slug>-results.md` when the work finishes:
    links to spec and plan, branch, verification commands with their outcome,
    and a verdict per completion criterion of the spec.
- These are dated snapshots — never edit one after the fact; a later spec
  supersedes an earlier one. `.omo/` is local working state and is not committed.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships. It is gitignored — regenerate it locally.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
