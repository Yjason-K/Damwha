import pytest

from damwha_worker import db
from damwha_worker.errors import ErrorKind, WorkerError
from tests.conftest import seed_job, seed_meeting


def _one(conn, sql, params=()):
    return conn.execute(sql, params).fetchone()


def test_summarize_job_type_is_permitted_by_job_constraint(conn):
    definition = _one(
        conn,
        """SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint WHERE conname='job_type_check'""",
    )["definition"]
    assert "summarize_meeting" in definition


def test_summarize_stages_are_permitted_by_job_constraint(conn):
    definition = _one(
        conn,
        """SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint WHERE conname='job_stage_check'""",
    )["definition"]
    assert "summarize_meeting" in definition
    assert "persist_summary" in definition


def test_meeting_summary_table_exists_with_defaults(conn):
    from tests.conftest import seed_meeting

    meeting_id = seed_meeting(conn, status="done", processing_version=0)
    conn.execute(
        """INSERT INTO meeting_summary(meeting_id, processing_version, model, status)
           VALUES (%s, 0, 'model', 'queued')""",
        (meeting_id,),
    )
    row = _one(conn, "SELECT topics, segments, error FROM meeting_summary")
    assert row["topics"] == []
    assert row["segments"] == []
    assert row["error"] is None


def test_meeting_summary_status_check_rejects_unknown_value(conn):
    import psycopg
    import pytest

    from tests.conftest import seed_meeting

    meeting_id = seed_meeting(conn, status="done", processing_version=0)
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            """INSERT INTO meeting_summary(meeting_id, processing_version, model, status)
               VALUES (%s, 0, 'model', 'bogus')""",
            (meeting_id,),
        )


def _utterance(conn, meeting_id, *, version=0, text="spoken", start_ms=0, end_ms=1000):
    return conn.execute(
        """
        INSERT INTO utterance(meeting_id, diar_label, start_ms, end_ms, text, status,
                              order_index, processing_version)
        VALUES (%s, 'S0', %s, %s, %s, 'ok',
                (SELECT coalesce(max(order_index) + 1, 0)
                 FROM utterance WHERE meeting_id=%s),
                %s) RETURNING id
        """,
        (meeting_id, start_ms, end_ms, text, meeting_id, version),
    ).fetchone()["id"]


@pytest.fixture
def summary_job(conn):
    meeting_id = seed_meeting(conn, status="done", processing_version=0)
    utt_1 = _utterance(conn, meeting_id, start_ms=0, end_ms=1000)
    utt_2 = _utterance(conn, meeting_id, text="support", start_ms=2000, end_ms=3000)
    job_id = seed_job(
        conn,
        type="summarize_meeting",
        meeting_id=meeting_id,
        payload={
            "schema_version": 1,
            "meeting_id": meeting_id,
            "processing_version": 0,
            "model": "model",
        },
    )
    conn.execute(
        """INSERT INTO meeting_summary(meeting_id, processing_version, job_id, model, status)
           VALUES (%s, 0, %s, 'model', 'queued')""",
        (meeting_id, job_id),
    )
    return db.claim(conn, "w"), {"meeting_id": meeting_id, "utt_1": utt_1, "utt_2": utt_2}


def test_mark_summary_running_flips_status(conn, summary_job):
    job, ids = summary_job
    assert (
        db.mark_summary_running(
            conn,
            job_id=job["id"],
            worker_id="w",
            meeting_id=ids["meeting_id"],
            processing_version=0,
        )
        == "running"
    )
    assert _one(conn, "SELECT status FROM meeting_summary")["status"] == "running"


def test_persist_summary_writes_topics_and_segments(conn, summary_job):
    job, ids = summary_job
    assert (
        db.persist_summary(
            conn,
            job_id=job["id"],
            worker_id="w",
            meeting_id=ids["meeting_id"],
            processing_version=0,
            topics=["주제"],
            segments=[
                {
                    "start_utterance_id": ids["utt_1"],
                    "end_utterance_id": ids["utt_2"],
                    "start_ms": 0,
                    "end_ms": 3000,
                    "title": "제목",
                    "bullets": ["불릿"],
                }
            ],
        )
        == "committed"
    )
    row = _one(conn, "SELECT status, topics, segments FROM meeting_summary")
    assert row["status"] == "done"
    assert row["topics"] == ["주제"]
    assert row["segments"][0]["end_ms"] == 3000


def test_persist_summary_discards_on_stale_version(conn, summary_job):
    job, ids = summary_job
    conn.execute("UPDATE meeting SET processing_version=1 WHERE id=%s", (ids["meeting_id"],))
    assert (
        db.persist_summary(
            conn,
            job_id=job["id"],
            worker_id="w",
            meeting_id=ids["meeting_id"],
            processing_version=0,
            topics=["주제"],
            segments=[],
        )
        == "discarded"
    )
    assert _one(conn, "SELECT topics FROM meeting_summary")["topics"] == []
    assert _one(conn, "SELECT status FROM job WHERE id=%s", (job["id"],))["status"] == "done"


def test_fail_summary_marks_row_but_keeps_meeting_done(conn, summary_job):
    job, ids = summary_job
    error = WorkerError("bad_response", "invalid", ErrorKind.PERMANENT).to_json(stage="summarize")
    assert db.fail_summary(conn, job["id"], "w", ids["meeting_id"], 0, error) == "failed"
    assert _one(conn, "SELECT status FROM meeting_summary")["status"] == "failed"
    assert (
        _one(conn, "SELECT status FROM meeting WHERE id=%s", (ids["meeting_id"],))["status"]
        == "done"
    )


def test_reaper_fails_summary_row_when_worker_lock_expires(conn):
    meeting_id = seed_meeting(conn, status="done", processing_version=0)
    job_id = seed_job(
        conn,
        type="summarize_meeting",
        meeting_id=meeting_id,
        status="running",
        locked_by="w",
        attempts=3,
        max_attempts=3,
        locked_minutes_ago=30,
        payload={
            "schema_version": 1,
            "meeting_id": meeting_id,
            "processing_version": 0,
            "model": "model",
        },
    )
    conn.execute(
        """INSERT INTO meeting_summary(meeting_id, processing_version, job_id, model, status)
           VALUES (%s, 0, %s, 'model', 'running')""",
        (meeting_id, job_id),
    )
    db.reap_stale(conn, 5)
    assert _one(conn, "SELECT status FROM meeting_summary")["status"] == "failed"
