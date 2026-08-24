# AGENTS.md

Damwha monorepo. Codex reads this file from the repo root; the substantive
per-package guidance lives one level down.

- **Backend** (`be/`, package `damwha-be`) — NestJS API + Python ML worker:
  read [`be/AGENTS.md`](be/AGENTS.md), with [`be/CLAUDE.md`](be/CLAUDE.md) as the
  fuller and more current version of the same material.
- **Frontend** (`fe/`, package `damwha-fe`) — React 19 + Vite SPA:
  read [`fe/CLAUDE.md`](fe/CLAUDE.md) and [`fe/DESIGN.md`](fe/DESIGN.md).
- **Monorepo rules** (pnpm workspace, cwd hazards, `.env` layout, docker-compose
  placement): [`CLAUDE.md`](CLAUDE.md).

Note: `be/AGENTS.md` and `be/CLAUDE.md` disagree in a few places (reaper status
propagation, `job.next_attempt_at` backoff, whether the worker poll loop spawns a
child per job). Where they conflict, `be/CLAUDE.md` is the newer document — but
verify against `be/src` rather than trusting either. Neither repo has ever had
CI; where the docs say tests "run in CI", read that as "are CI-safe".
