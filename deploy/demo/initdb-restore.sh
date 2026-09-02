#!/bin/bash
# Runs inside the postgres entrypoint during first-time init, after POSTGRES_DB exists.
# The dump carries schema, _migrations and data — the API's migrate.js then finds
# nothing pending.
set -euo pipefail
echo "restoring demo seed into $POSTGRES_DB"
pg_restore --no-owner --no-acl --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" /seed/damwha-demo.dump
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -Atc "select count(*) || ' meetings seeded' from meeting"
