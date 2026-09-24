"""회수 격자 — be/test/fixtures/job-reap/grid.json을 TS(be/test/reap-grid.spec.ts)와 함께 읽는다.

스펙 §8.1. 선택자만 다르다: reap_stale은 오래된 locked_at, reap_own_orphans는 자기 신분.
"""

import json
from pathlib import Path

import pytest

from damwha_worker import db
from tests.conftest import seed_job, seed_meeting

GRID = json.loads(
    (Path(__file__).resolve().parents[2] / "test" / "fixtures" / "job-reap" / "grid.json").read_text()
)


def _seed(conn, c, *, locked_by, locked_minutes_ago):
    meeting_status = {"live_session": "recording", "process_meeting": "processing"}.get(c["type"], "done")
    mid = seed_meeting(conn, status=meeting_status)
    jid = seed_job(
        conn,
        type=c["type"],
        meeting_id=mid,
        status="running",
        locked_by=locked_by,
        attempts=c["attempts"],
        max_attempts=c["max_attempts"],
        interruptions=c["interruptions"],
        max_interruptions=c.get("max_interruptions"),
        locked_minutes_ago=locked_minutes_ago,
    )
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    if c["type"] == "summarize_meeting":
        conn.execute(
            "INSERT INTO meeting_summary(meeting_id, processing_version, job_id, model, status) "
            "VALUES (%s, 0, %s, 'model', 'running')",
            (mid, jid),
        )
    elif c["type"] == "extract_lenses":
        conn.execute(
            "INSERT INTO lens_extraction_run(meeting_id, processing_version, status, model, job_id) "
            "VALUES (%s, 0, 'running', 'model', %s)",
            (mid, jid),
        )
    elif c["type"] == "enroll_speaker":
        conn.execute(
            "INSERT INTO speaker(name, enrollment_status, current_job_id) VALUES ('s','provisional',%s)",
            (jid,),
        )
    return jid, mid


def _dependent(conn, c, jid, mid):
    if c["type"] == "summarize_meeting":
        return conn.execute("SELECT status FROM meeting_summary WHERE job_id=%s", (jid,)).fetchone()["status"]
    if c["type"] == "extract_lenses":
        return conn.execute(
            "SELECT status FROM lens_extraction_run WHERE job_id=%s", (jid,)
        ).fetchone()["status"]
    if c["type"] == "enroll_speaker":
        s = conn.execute(
            "SELECT enrollment_status FROM speaker WHERE current_job_id=%s", (jid,)
        ).fetchone()["enrollment_status"]
        return "failed" if s == "failed" else "running"
    return conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]


def _check(conn, c, jid, mid):
    row = conn.execute(
        "SELECT status, attempts, interruptions, locked_by, locked_at FROM job WHERE id=%s", (jid,)
    ).fetchone()
    assert row["status"] == c["expect"]["status"]
    assert row["attempts"] == c["attempts"]
    assert row["interruptions"] == c["expect"]["interruptions"]
    if c["expect"]["status"] == "queued":
        assert row["locked_by"] is None and row["locked_at"] is None
    assert _dependent(conn, c, jid, mid) == c["expect"]["dependent"]


@pytest.mark.parametrize("c", GRID["reap"], ids=[c["name"] for c in GRID["reap"]])
def test_reap_stale_grid(conn, c):
    jid, mid = _seed(conn, c, locked_by="dead-worker", locked_minutes_ago=31)
    db.reap_stale(conn, 30)
    _check(conn, c, jid, mid)


@pytest.mark.parametrize("c", GRID["reap"], ids=[c["name"] for c in GRID["reap"]])
def test_reap_own_orphans_grid(conn, c):
    jid, mid = _seed(conn, c, locked_by="w1", locked_minutes_ago=0)
    db.reap_own_orphans(conn, "w1")
    _check(conn, c, jid, mid)


from damwha_worker.dispatch import failures  # noqa: E402


@pytest.mark.parametrize(
    "c", GRID["retry"], ids=[f"a{c['attempts']}-i{c['interruptions']}" for c in GRID["retry"]]
)
def test_retry_grid_failures_and_backoff(conn, c):
    """failures()와 requeue의 백오프가 같은 식인지 (스펙 §4.3). requeue는 running 행에서 부른다."""
    assert failures({"attempts": c["attempts"], "interruptions": c["interruptions"]}) == c["failures"]
    assert (failures(c) < c["max_attempts"]) == c["retry"]

    mid = seed_meeting(conn)
    jid = seed_job(
        conn, meeting_id=mid, status="running", locked_by="w1", attempts=c["attempts"],
        max_attempts=c["max_attempts"], interruptions=c["interruptions"], locked_minutes_ago=0,
    )
    assert db.requeue(conn, jid, "w1", {"code": "x", "kind": "TRANSIENT", "stage": None}) == 1
    row = conn.execute(
        "SELECT extract(epoch FROM next_attempt_at - updated_at) AS s FROM job WHERE id=%s", (jid,)
    ).fetchone()
    assert round(float(row["s"])) == c["backoff_seconds"]
