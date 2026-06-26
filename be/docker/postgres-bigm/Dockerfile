# pgvector + pg_bigm 둘 다 포함하는 Postgres 16 이미지.
# pgvector는 베이스에 이미 있고, pg_bigm은 소스에서 빌드한다.
FROM pgvector/pgvector:pg16

USER root
ARG PG_BIGM_VERSION=1.2-20240606
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        build-essential postgresql-server-dev-16 wget ca-certificates; \
    wget -O /tmp/pg_bigm.tar.gz \
        "https://github.com/pgbigm/pg_bigm/archive/refs/tags/v${PG_BIGM_VERSION}.tar.gz"; \
    mkdir -p /tmp/pg_bigm; \
    tar -xzf /tmp/pg_bigm.tar.gz -C /tmp/pg_bigm --strip-components=1; \
    cd /tmp/pg_bigm; \
    make USE_PGXS=1; \
    make USE_PGXS=1 install; \
    apt-get purge -y build-essential postgresql-server-dev-16 wget; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/* /tmp/pg_bigm*
USER postgres
