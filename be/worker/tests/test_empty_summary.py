import json
from contextlib import nullcontext
from pathlib import Path

import pytest
from psycopg import Connection

from damwha_worker import db
from damwha_worker.__main__ import handle_job
from damwha_worker.storage import Storage
from damwha_worker.summary_client import SummaryClient
from tests.conftest import seed_job, seed_meeting


@pytest.fixture
def empty_summary_job(conn: Connection):
    meeting_id = seed_meeting(conn, status="done", processing_version=0)
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
        """INSERT INTO meeting_summary(meeting_id, processing_version, job_id, model, status,
                                       topics, segments, suggested_tags, error)
           VALUES (%s, 0, %s, 'model', 'queued',
                   '["old"]', '[{"title":"old"}]', '["old"]', '{"code":"old"}')""",
        (meeting_id, job_id),
    )
    return db.claim(conn, "w")


@pytest.mark.parametrize("with_segments", [False, True])
@pytest.mark.parametrize("excluded_rows", [False, True])
def test_issue_103_empty_summary_finishes_without_llm_request(
    conn: Connection, empty_summary_job, tmp_path: Path, httpx_mock, with_segments, excluded_rows
):
    job = empty_summary_job
    if excluded_rows:
        conn.execute(
            """INSERT INTO utterance(meeting_id, diar_label, start_ms, end_ms, text,
                                     status, order_index, processing_version)
               VALUES (%s, 'S0', 0, 1000, 'old transcript', 'ok', 0, 1),
                      (%s, 'S0', 0, 1000, NULL, 'ok', 1, 0),
                      (%s, 'S0', 0, 1000, 'not usable', 'transcribe_failed', 2, 0)""",
            (job["meeting_id"],) * 3,
        )
    body = {
        "topics": ["invented"],
        "segments": (
            [{"start_index": 1, "end_index": 1, "title": "invented", "bullets": ["invented"]}]
            if with_segments
            else []
        ),
    }
    httpx_mock.add_response(
        url="http://summary.test/chat/completions",
        json={"choices": [{"message": {"content": json.dumps(body)}}]},
        is_optional=True,
    )

    outcome = handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w",
        build_summary_client=lambda: SummaryClient("http://summary.test", None, 1),
        llm_server=lambda _model: nullcontext(),
    )

    assert outcome == "committed"
    assert httpx_mock.get_requests() == []
    summary = conn.execute(
        "SELECT status, topics, segments, suggested_tags, error FROM meeting_summary"
    ).fetchone()
    assert summary == {
        "status": "done",
        "topics": [],
        "segments": [],
        "suggested_tags": [],
        "error": None,
    }
    result = conn.execute("SELECT status, progress, error FROM job WHERE id=%s", (job["id"],))
    assert result.fetchone() == {"status": "done", "progress": 100, "error": None}


def test_issue_103_empty_summary_does_not_start_model_server(
    conn: Connection, empty_summary_job, tmp_path: Path
):
    def unavailable_server(_model: str):
        raise AssertionError("an empty transcript must not start the model server")

    outcome = handle_job(
        conn,
        empty_summary_job,
        Storage(str(tmp_path)),
        "w",
        llm_server=unavailable_server,
    )

    assert outcome == "committed"
