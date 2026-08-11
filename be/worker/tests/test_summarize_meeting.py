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
