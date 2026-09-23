#!/usr/bin/env bash
# PreToolUse(Bash) guard: block npm install / npm i / npm ci / npm add anywhere in this monorepo.
# Root CLAUDE.md: npm install inside be/ recreates package-lock.json and a hoisted
# node_modules that re-masks undeclared dependencies. The root is a pnpm workspace,
# so npm has no legitimate install use here at all.
#
# Heredoc bodies (commit messages, file contents) are stripped before matching so
# that prose mentioning the forbidden command does not trip the guard.
cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null)
code=$(printf '%s\n' "$cmd" | awk '
  skip != "" { if ($0 == skip) skip = ""; next }
  match($0, /<<-?[[:space:]]*["'"'"']?[A-Za-z_][A-Za-z0-9_]*["'"'"']?/) {
    tag = substr($0, RSTART, RLENGTH)
    sub(/^<<-?[[:space:]]*/, "", tag); gsub(/["'"'"']/, "", tag)
    skip = tag
  }
  { print }
')
if printf '%s' "$code" | grep -Eq '(^|[;&|[:space:]])npm[[:space:]]+(install|i|ci|add)([[:space:]]|$)'; then
  echo "blocked: npm install is forbidden in this pnpm monorepo (see CLAUDE.md). Use: pnpm install (root) or pnpm add --filter <pkg> <dep>." >&2
  exit 2
fi
exit 0
