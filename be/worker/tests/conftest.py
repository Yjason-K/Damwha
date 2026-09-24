from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from testcontainers.postgres import PostgresContainer

from damwha_worker.models import downloads

# worker/tests/conftest.py → parents[2] == be/ (리포 루트)
MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "src" / "database" / "migrations"

# 닿을 수 없는 주소. 포트 1은 즉시 refused라 실수로 붙는 코드가 **빠르게** 실패한다.
UNREACHABLE_DSN = "postgresql://nobody@127.0.0.1:1/damwha-worker-tests-must-not-connect"


@pytest.fixture(scope="session", autouse=True)
def no_ambient_database():
    """이 스위트가 **환경의** DB(개발 Docker DB)에 붙지 못하게 막는다.

    실제로 붙은 적이 있다. `models/downloads.py`의 훅은 연결을 인자로 받지 않고 **스스로**
    연다(계약) — 주소는 env `DATABASE_URL` → 없으면 `Settings`(= `be/worker/.env`)다. 훅을
    설치했는데 그 지연 연결을 가짜로 바꾸지 않은 테스트가 하나 있었고, 그것이 `app_setting`에
    `model_readiness` 한 행을 **개발 DB에** 썼다. `downloads.py`가 DB 오류를 전부 삼키므로
    테스트는 통과했고 아무 신호도 없었다.

    두 층으로 막는다. env는 `Settings`까지 덮고(pydantic-settings에서 env가 `.env`를 이긴다),
    `_open_connection` 차단은 주소를 어디서 얻든 연결 자체를 막는다. `conn`·`pg_url`은
    testcontainer URL을 **명시적으로** 넘기므로 둘 다 영향을 받지 않는다.
    """
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("DATABASE_URL", UNREACHABLE_DSN)
        yield


@pytest.fixture(autouse=True)
def no_ambient_hook_connection(monkeypatch):
    """훅의 지연 연결은 **주입된 것**이어야 한다. 주입하지 않은 테스트에서는 열리지 않는다.

    이 fixture보다 뒤에 도는 테스트 fixture(`hook_db` 등)가 같은 이름을 다시 덮어 쓴다 —
    그쪽이 이긴다.
    """

    def _refuse():
        raise AssertionError(
            "the download hook tried to open its own DB connection — inject one "
            "(monkeypatch downloads._open_connection) instead of reaching the ambient DATABASE_URL"
        )

    monkeypatch.setattr(downloads, "_open_connection", _refuse)


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


@pytest.fixture
def conn2(pg_url):
    """두 번째 실제 연결 — 다른 프로세스의 writer를 흉내 낸다 (정리는 conn fixture가 한다)."""
    c = psycopg.connect(pg_url, row_factory=dict_row, autocommit=True)
    try:
        yield c
    finally:
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
    interruptions=0,
    max_interruptions=None,
):
    locked_at = (
        None if locked_minutes_ago is None else f"now() - interval '{locked_minutes_ago} minutes'"
    )
    cols = "type, meeting_id, payload, status, locked_by, attempts, max_attempts, interruptions"
    vals = "%s,%s,%s,%s,%s,%s,%s,%s"
    params = [type, meeting_id, Jsonb(payload or {}), status, locked_by, attempts, max_attempts,
              interruptions]
    # None이면 컬럼을 빼 DEFAULT(026의 3)를 탄다 — 격자의 "한도 생략" 케이스가 그 값을 고정한다.
    if max_interruptions is not None:
        cols += ", max_interruptions"
        vals += ",%s"
        params.append(max_interruptions)
    sql = (
        f"INSERT INTO job({cols}, locked_at) "
        f"VALUES ({vals},{locked_at or 'NULL'}) RETURNING id"
    )
    return conn.execute(sql, params).fetchone()["id"]


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
