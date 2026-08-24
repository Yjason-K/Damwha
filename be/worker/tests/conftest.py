from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from testcontainers.postgres import PostgresContainer

# worker/tests/conftest.py → parents[2] == be/ (리포 루트)
MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "src" / "database" / "migrations"


def _run_migrations(url: str) -> None:
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    assert files, f"no migrations found in {MIGRATIONS_DIR}"
    with psycopg.connect(url, autocommit=True) as c:
        for f in files:
            c.execute(f.read_text())


@pytest.fixture(scope="session")
def pg_url():
    with PostgresContainer("damwha/postgres-bigm:pg16") as pg:
        url = pg.get_connection_url().replace("postgresql+psycopg2", "postgresql")
        _run_migrations(url)
        yield url


@pytest.fixture
def conn(pg_url):
    c = psycopg.connect(pg_url, row_factory=dict_row, autocommit=True)
    try:
        yield c
    finally:
        c.execute(
            "TRUNCATE job, utterance, meeting_cluster, voiceprint, meeting, speaker "
            "RESTART IDENTITY CASCADE"
        )
        c.execute("ALTER SEQUENCE speaker_default_seq RESTART")
        c.close()


def seed_meeting(
    conn, *, status="uploaded", processing_version=0, audio_key="k", current_job_id=None
):
    row = conn.execute(
        "INSERT INTO meeting(audio_key, status, processing_version, current_job_id) "
        "VALUES (%s,%s,%s,%s) RETURNING id",
        (audio_key, status, processing_version, current_job_id),
    ).fetchone()
    return row["id"]


def seed_job(
    conn,
    *,
    type="process_meeting",
    meeting_id=None,
    payload=None,
    status="queued",
    locked_by=None,
    attempts=0,
    max_attempts=3,
    locked_minutes_ago=None,
):
    locked_at = (
        None if locked_minutes_ago is None else f"now() - interval '{locked_minutes_ago} minutes'"
    )
    sql = (
        "INSERT INTO job(type, meeting_id, payload, status, locked_by, "
        "attempts, max_attempts, locked_at) "
        f"VALUES (%s,%s,%s,%s,%s,%s,%s,{locked_at or 'NULL'}) RETURNING id"
    )
    row = conn.execute(
        sql, (type, meeting_id, Jsonb(payload or {}), status, locked_by, attempts, max_attempts)
    ).fetchone()
    return row["id"]


def seed_speaker(conn, *, name="t", enrollment_status="ready", current_job_id=None):
    row = conn.execute(
        "INSERT INTO speaker(name, enrollment_status, current_job_id) "
        "VALUES (%s,%s,%s) RETURNING id",
        (name, enrollment_status, current_job_id),
    ).fetchone()
    return row["id"]


def seed_voiceprint(
    conn, *, speaker_id, embedding, model="speechbrain/spkrec-ecapa-voxceleb", dimension=192
):
    vec = "[" + ",".join(str(x) for x in embedding) + "]"
    conn.execute(
        "INSERT INTO voiceprint(speaker_id, embedding, model, dimension) "
        "VALUES (%s,%s::vector,%s,%s)",
        (speaker_id, vec, model, dimension),
    )
