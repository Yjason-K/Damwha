from types import SimpleNamespace

import pytest

from damwha_worker import db
from damwha_worker.contracts import SummaryResponse, SummarySegmentCandidate
from damwha_worker.errors import ErrorKind, WorkerError
from damwha_worker.pipeline.summarize_meeting import run_summarize_meeting
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
    row = _one(conn, "SELECT status, topics, error FROM meeting_summary")
    assert row["topics"] == []
    assert row["status"] == "failed"
    assert row["error"]["code"] == "discarded_by_stale_guard"
    assert _one(conn, "SELECT status FROM job WHERE id=%s", (job["id"],))["status"] == "done"


def test_mark_summary_running_discards_and_closes_row_on_stale_version(conn, summary_job):
    job, ids = summary_job
    conn.execute("UPDATE meeting SET processing_version=1 WHERE id=%s", (ids["meeting_id"],))
    assert (
        db.mark_summary_running(
            conn,
            job_id=job["id"],
            worker_id="w",
            meeting_id=ids["meeting_id"],
            processing_version=0,
        )
        == "discarded"
    )
    row = _one(conn, "SELECT status, error FROM meeting_summary")
    assert row["status"] == "failed"
    assert row["error"]["code"] == "discarded_by_stale_guard"
    assert _one(conn, "SELECT status FROM job WHERE id=%s", (job["id"],))["status"] == "done"


def test_fail_summary_marks_row_but_keeps_meeting_done(conn, summary_job):
    job, ids = summary_job
    error = WorkerError("bad_response", "invalid", ErrorKind.PERMANENT).to_json(stage="summarize")
    assert db.fail_summary(conn, job["id"], "w", error) == "failed"
    assert _one(conn, "SELECT status FROM meeting_summary")["status"] == "failed"
    assert (
        _one(conn, "SELECT status FROM meeting WHERE id=%s", (ids["meeting_id"],))["status"]
        == "done"
    )


def test_fail_summary_closes_row_when_payload_lacks_processing_version(conn, tmp_path):
    # processing_version이 빠진 payload는 parse_payload 자체가 실패한다 — 이게
    # 유일하게 타는 경로다. job_id가 아니라 (meeting_id, processing_version)으로
    # meeting_summary를 찾던 옛 코드는 processing_version=None이라 행을 못 찾고
    # queued에 영원히 발이 묶였다.
    from damwha_worker.__main__ import handle_job
    from damwha_worker.storage import Storage

    meeting_id = seed_meeting(conn, status="done", processing_version=0)
    job_id = seed_job(
        conn,
        type="summarize_meeting",
        meeting_id=meeting_id,
        attempts=2,
        max_attempts=3,
        payload={"schema_version": 1, "meeting_id": meeting_id, "model": "model"},
    )
    conn.execute(
        """INSERT INTO meeting_summary(meeting_id, processing_version, job_id, model, status)
           VALUES (%s, 0, %s, 'model', 'queued')""",
        (meeting_id, job_id),
    )
    job = db.claim(conn, "w")
    out = handle_job(conn, job, Storage(str(tmp_path)), "w")
    assert out == "failed"
    assert _one(conn, "SELECT status FROM job WHERE id=%s", (job_id,))["status"] == "failed"
    assert _one(conn, "SELECT status FROM meeting_summary")["status"] == "failed"


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


def _payload(job):
    from damwha_worker.contracts import parse_payload

    return parse_payload(job["type"], job["payload"])


def _response(segments, topics=("주제",)):
    return SummaryResponse(topics=list(topics), segments=segments)


def _segment(start, end, title="제목", bullets=("불릿",)):
    return SummarySegmentCandidate(
        start_utterance_id=start,
        end_utterance_id=end,
        title=title,
        bullets=list(bullets),
    )


def test_pipeline_fills_timestamps_from_database(conn, summary_job):
    job, ids = summary_job
    client = SimpleNamespace(
        summarize=lambda **_kw: _response([_segment(ids["utt_1"], ids["utt_2"])])
    )
    assert run_summarize_meeting(conn, job, _payload(job), client, worker_id="w") == "committed"
    segment = _one(conn, "SELECT segments FROM meeting_summary")["segments"][0]
    assert segment["start_ms"] == 0
    assert segment["end_ms"] == 3000
    assert segment["title"] == "제목"


def test_pipeline_sends_payload_model_and_utterance_rows(conn, summary_job):
    job, ids = summary_job
    captured = {}

    def summarize(**kwargs):
        captured.update(kwargs)
        return _response([])

    assert (
        run_summarize_meeting(
            conn, job, _payload(job), SimpleNamespace(summarize=summarize), worker_id="w"
        )
        == "committed"
    )
    assert captured["model"] == "model"
    assert [u["id"] for u in captured["utterances"]] == [ids["utt_1"], ids["utt_2"]]


def test_pipeline_rejects_segment_with_unknown_utterance(conn, summary_job):
    job, _ids = summary_job
    client = SimpleNamespace(summarize=lambda **_kw: _response([_segment("utt_999", "utt_998")]))
    with pytest.raises(WorkerError):
        run_summarize_meeting(conn, job, _payload(job), client, worker_id="w")
    assert _one(conn, "SELECT segments FROM meeting_summary")["segments"] == []


def test_pipeline_rejects_segment_with_reversed_boundaries(conn, summary_job):
    job, ids = summary_job
    client = SimpleNamespace(
        summarize=lambda **_kw: _response([_segment(ids["utt_2"], ids["utt_1"])])
    )
    with pytest.raises(WorkerError):
        run_summarize_meeting(conn, job, _payload(job), client, worker_id="w")
    assert _one(conn, "SELECT segments FROM meeting_summary")["segments"] == []


def test_pipeline_rejects_out_of_order_segments(conn, summary_job):
    job, ids = summary_job
    client = SimpleNamespace(
        summarize=lambda **_kw: _response(
            [
                _segment(ids["utt_2"], ids["utt_2"], title="뒤"),
                _segment(ids["utt_1"], ids["utt_1"], title="앞"),
            ]
        )
    )
    with pytest.raises(WorkerError):
        run_summarize_meeting(conn, job, _payload(job), client, worker_id="w")


def test_pipeline_stores_empty_summary_for_meeting_without_utterances(conn):
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
        """INSERT INTO meeting_summary(meeting_id, processing_version, job_id, model, status)
           VALUES (%s, 0, %s, 'model', 'queued')""",
        (meeting_id, job_id),
    )
    job = db.claim(conn, "w")
    client = SimpleNamespace(summarize=lambda **_kw: _response([], topics=()))
    assert run_summarize_meeting(conn, job, _payload(job), client, worker_id="w") == "committed"
    row = _one(conn, "SELECT status, topics FROM meeting_summary")
    assert row["status"] == "done"
    assert row["topics"] == []


def test_llm_call_is_timed_and_logged(conn, summary_job, caplog):
    # 요약 LLM 호출은 수 분 걸린다 — timed_stage로 감싸야 tick/완료 로그가 콘솔에 남는다
    job, ids = summary_job
    client = SimpleNamespace(
        summarize=lambda **_kw: _response([_segment(ids["utt_1"], ids["utt_2"])])
    )
    with caplog.at_level("INFO", logger="damwha_worker"):
        assert run_summarize_meeting(conn, job, _payload(job), client, worker_id="w") == "committed"
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert f"job={job['id']} meeting={ids['meeting_id']} stage=summarize_meeting done" in text
    assert "utterances=2 segments=1" in text
