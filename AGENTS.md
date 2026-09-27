# AGENTS.md

Damwha monorepo. Codex reads this file from the repo root; the substantive
per-package guidance lives one level down.

- **Backend** (`be/`, package `damwha-be`) — NestJS API + Python ML worker:
  read [`be/CLAUDE.md`](be/CLAUDE.md).
- **Frontend** (`fe/`, package `damwha-fe`) — React 19 + Vite SPA:
  read [`fe/CLAUDE.md`](fe/CLAUDE.md) and [`fe/DESIGN.md`](fe/DESIGN.md).
- **Monorepo rules** (pnpm workspace, cwd hazards, `.env` layout, docker-compose
  placement): [`CLAUDE.md`](CLAUDE.md).

The repo has no CI; where older docs say tests "run in CI", read that as "are CI-safe".
