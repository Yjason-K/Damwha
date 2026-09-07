# Public-demo Postgres: the pgvector + pg_bigm image plus the seed dump, restored
# by the official entrypoint on the FIRST start of an empty volume only. Later
# starts skip initdb.d entirely, so the demo data is never re-imported.
#
# Base is the local build of be/docker/postgres-bigm (deploy/demo/release.sh
# builds it first). Build context is the REPO ROOT.
ARG BASE=damwha/postgres-bigm:pg16
FROM ${BASE}
COPY demo/seed/damwha-demo.dump /seed/damwha-demo.dump
COPY deploy/demo/initdb-restore.sh /docker-entrypoint-initdb.d/10-restore-seed.sh
