from datetime import date
from types import SimpleNamespace

import pytest

from damwha_worker import db
from damwha_worker.errors import ErrorKind, WorkerError
from damwha_worker.pipeline.extract_lenses import run_extract_lenses
from tests.conftest import seed_job, seed_meeting


def _utterance(conn, meeting_id, *, version=0, text="spoken"):
    return conn.execute(
        """
        INSERT INTO utterance(meeting_id, diar_label, start_ms, end_ms, text, status,
                              order_index, processing_version)
        VALUES (%s, 'S0', 0, 1000, %s, 'ok',
                (SELECT coalesce(max(order_index) + 1, 0)
                 FROM utterance WHERE meeting_id=%s),
                %s) RETURNING id
        """,
        (meeting_id, text, meeting_id, version),
    ).fetchone()["id"]


def _candidate(kind, primary, supporting=(), **overrides):
    data = {
        "kind": kind,
        "text": "follow up",
        "assignee_speaker_id": None,
        "due_at": None,
        "primary_utterance_id": primary,
        "supporting_utterance_ids": list(supporting),
    }
    data.update(overrides)
    return SimpleNamespace(**data)


@pytest.fixture
def extraction_job(conn):
    meeting_id = seed_meeting(conn, status="done", processing_version=0)
    utt_1 = _utterance(conn, meeting_id)
    utt_2 = _utterance(conn, meeting_id, text="support")
    run_id = conn.execute(
        """INSERT INTO lens_extraction_run(meeting_id, processing_version, status, model)
           VALUES (%s, 0, 'queued', 'model') RETURNING id""",
        (meeting_id,),
    ).fetchone()["id"]
    job_id = seed_job(
        conn,
        type="extract_lenses",
        meeting_id=meeting_id,
        payload={
            "schema_version": 1,
            "meeting_id": meeting_id,
            "processing_version": 0,
            "extraction_run_id": run_id,
            "model": "model",
        },
    )
    conn.execute("UPDATE lens_extraction_run SET job_id=%s WHERE id=%s", (job_id, run_id))
    return db.claim(conn, "w"), {
        "meeting_id": meeting_id,
        "run_id": run_id,
        "utt_1": utt_1,
        "utt_2": utt_2,
    }


@pytest.fixture
def fake_client():
    return SimpleNamespace(extract=lambda **_kwargs: [])


def _payload(job):
    from damwha_worker.contracts import parse_payload

    return parse_payload(job["type"], job["payload"])


def _one(conn, sql, params=()):
    return conn.execute(sql, params).fetchone()


def test_extract_lenses_stage_is_permitted_by_job_constraint(conn):
    definition = _one(
        conn,
        """SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint WHERE conname='job_stage_check'""",
    )["definition"]
    assert "extract_lenses" in definition
    assert "persist_lenses" in definition


def test_extract_persists_ai_item_and_primary_evidence(conn, extraction_job, fake_client):
    job, ids = extraction_job
    fake_client.extract = lambda **_kwargs: [_candidate("action", ids["utt_1"], [ids["utt_2"]])]
    assert run_extract_lenses(conn, job, _payload(job), fake_client, worker_id="w") == "committed"
    assert _one(conn, "SELECT source FROM lens_item")["source"] == "ai"
    assert (
        _one(conn, "SELECT relation FROM lens_evidence WHERE utterance_id=%s", (ids["utt_1"],))[
            "relation"
        ]
        == "primary"
    )


def test_extract_uses_payload_model_and_speaker_display_name(conn, extraction_job, fake_client):
    job, ids = extraction_job
    speaker_id = conn.execute(
        "INSERT INTO speaker(name) VALUES ('Ada Lovelace') RETURNING id"
    ).fetchone()["id"]
    conn.execute("UPDATE utterance SET speaker_id=%s WHERE id=%s", (speaker_id, ids["utt_1"]))
    captured = {}

    def extract(**kwargs):
        captured.update(kwargs)
        return []

    fake_client.extract = extract

    assert run_extract_lenses(conn, job, _payload(job), fake_client, worker_id="w") == "committed"
    assert captured["model"] == "model"
    assert captured["utterances"] == [
        {
            "id": ids["utt_1"],
            "speaker_id": speaker_id,
            "speaker_name": "Ada Lovelace",
            "text": "spoken",
            "start_ms": 0,
            "end_ms": 1000,
        },
        {
            "id": ids["utt_2"],
            "speaker_id": None,
            "speaker_name": None,
            "text": "support",
            "start_ms": 0,
            "end_ms": 1000,
        },
    ]


def test_foreign_candidate_rolls_back_every_candidate(conn, extraction_job, fake_client):
    job, ids = extraction_job
    fake_client.extract = lambda **_kwargs: [
        _candidate("action", ids["utt_1"]),
        _candidate("decision", "utt_999"),
    ]
    with pytest.raises(WorkerError):
        run_extract_lenses(conn, job, _payload(job), fake_client, worker_id="w")
    assert _one(conn, "SELECT count(*) AS n FROM lens_item")["n"] == 0


def test_merge_preserves_user_modified_and_completed_items(conn, extraction_job, fake_client):
    job, ids = extraction_job
    with conn.transaction():
        hands_off = conn.execute(
            """INSERT INTO lens_item(
                   meeting_id, kind, text, source, user_modified, completion_status
               )
               VALUES (%s, 'action', 'hands off', 'ai', true, 'open') RETURNING id""",
            (ids["meeting_id"],),
        ).fetchone()["id"]
        done_item = conn.execute(
            """INSERT INTO lens_item(
                   meeting_id, kind, text, source, user_modified, completion_status
               )
               VALUES (%s, 'decision', 'done item', 'ai', false, 'done') RETURNING id""",
            (ids["meeting_id"],),
        ).fetchone()["id"]
        conn.execute(
            """INSERT INTO lens_evidence(lens_item_id, utterance_id, relation)
               VALUES (%s, %s, 'primary'), (%s, %s, 'primary')""",
            (hands_off, ids["utt_1"], done_item, ids["utt_2"]),
        )
    fake_client.extract = lambda **_kwargs: [_candidate("action", ids["utt_1"])]
    assert run_extract_lenses(conn, job, _payload(job), fake_client, worker_id="w") == "committed"
    rows = conn.execute("SELECT text, lifecycle_status FROM lens_item ORDER BY text").fetchall()
    assert [(r["text"], r["lifecycle_status"]) for r in rows] == [
        ("done item", "active"),
        ("follow up", "active"),
        ("hands off", "active"),
    ]


def test_merge_archives_unmatched_eligible_ai_item(conn, extraction_job, fake_client):
    job, ids = extraction_job
    with conn.transaction():
        old_id = conn.execute(
            """INSERT INTO lens_item(meeting_id, kind, text, source)
               VALUES (%s, 'action', 'old', 'ai') RETURNING id""",
            (ids["meeting_id"],),
        ).fetchone()["id"]
        conn.execute(
            """INSERT INTO lens_evidence(lens_item_id, utterance_id, relation)
               VALUES (%s, %s, 'primary')""",
            (old_id, ids["utt_2"]),
        )
    fake_client.extract = lambda **_kwargs: [_candidate("decision", ids["utt_1"])]
    assert run_extract_lenses(conn, job, _payload(job), fake_client, worker_id="w") == "committed"
    assert (
        _one(conn, "SELECT lifecycle_status FROM lens_item WHERE id=%s", (old_id,))[
            "lifecycle_status"
        ]
        == "archived"
    )


def test_stale_version_discards_without_writing_lenses(conn, extraction_job, fake_client):
    job, ids = extraction_job
    conn.execute("UPDATE meeting SET processing_version=1 WHERE id=%s", (ids["meeting_id"],))
    fake_client.extract = lambda **_kwargs: [_candidate("action", ids["utt_1"])]
    assert run_extract_lenses(conn, job, _payload(job), fake_client, worker_id="w") == "discarded"
    assert _one(conn, "SELECT count(*) AS n FROM lens_item")["n"] == 0
    assert (
        _one(conn, "SELECT status FROM lens_extraction_run WHERE id=%s", (ids["run_id"],))["status"]
        == "done"
    )


def test_mark_running_and_transient_requeue_leaves_run_running(conn, extraction_job):
    job, ids = extraction_job
    assert (
        db.mark_lens_run_running(
            conn,
            job_id=job["id"],
            worker_id="w",
            meeting_id=ids["meeting_id"],
            processing_version=0,
            run_id=ids["run_id"],
        )
        == "running"
    )
    assert db.requeue(conn, job["id"], "w") == 1
    assert (
        _one(conn, "SELECT status FROM lens_extraction_run WHERE id=%s", (ids["run_id"],))["status"]
        == "running"
    )


def test_final_failure_marks_run_but_keeps_meeting_done(conn, extraction_job):
    job, ids = extraction_job
    error = WorkerError("bad_response", "invalid", ErrorKind.PERMANENT).to_json(stage="extract")
    assert db.fail_lens_extraction(conn, job["id"], "w", ids["run_id"], 0, error) == "failed"
    assert (
        _one(conn, "SELECT status FROM lens_extraction_run WHERE id=%s", (ids["run_id"],))["status"]
        == "failed"
    )
    assert (
        _one(conn, "SELECT status FROM meeting WHERE id=%s", (ids["meeting_id"],))["status"]
        == "done"
    )


def test_llm_call_is_timed_and_logged(conn, extraction_job, caplog):
    # 렌즈 추출 LLM 호출도 긴 작업 — timed_stage로 감싸 콘솔에 진행이 남아야 한다
    job, ids = extraction_job
    client = SimpleNamespace(extract=lambda **_kwargs: [_candidate("action", ids["utt_1"])])
    with caplog.at_level("INFO", logger="damwha_worker"):
        run_extract_lenses(conn, job, _payload(job), client, worker_id="w")
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert f"job={job['id']} meeting={ids['meeting_id']} stage=extract_lenses done" in text
    assert "utterances=2 candidates=1" in text


def test_extract_passes_the_meeting_date_in_the_configured_timezone(conn, extraction_job):
    job, ids = extraction_job
    conn.execute(
        "UPDATE meeting SET recorded_at='2026-09-02T23:30:00+00:00' WHERE id=%s",
        (ids["meeting_id"],),
    )
    seen: dict = {}

    def _extract(**kwargs):
        seen.update(kwargs)
        return []

    run_extract_lenses(
        conn,
        job,
        _payload(job),
        SimpleNamespace(extract=_extract),
        worker_id="w",
        meeting_timezone="Asia/Seoul",
    )

    # 23:30 UTC == 다음날 08:30 KST. 존을 고정하지 않으면 하루 어긋난다.
    assert seen["meeting_date"] == date(2026, 9, 3)
