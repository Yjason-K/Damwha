import pytest

from damwha_worker import db
from tests.conftest import seed_job, seed_meeting

PROCESS = {"schema_version": 5, "meeting_id": "mtg_1", "audio_key": "k", "marker": "verbatim"}


def _claimed_live(conn, *, status="recording"):
    mid = seed_meeting(conn, status=status)
    jid = seed_job(conn, type="live_session", meeting_id=mid, max_attempts=1)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    return mid, jid


def test_set_recording_started_is_guarded_by_current_job_and_status(conn):
    mid, jid = _claimed_live(conn)
    before = conn.execute("SELECT recorded_at FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert db.set_recording_started(conn, mid, jid) == 1
    after = conn.execute("SELECT recorded_at FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert after["recorded_at"] >= before["recorded_at"]
    assert db.set_recording_started(conn, mid, "job_999") == 0
    conn.execute("UPDATE meeting SET status='failed' WHERE id=%s", (mid,))
    assert db.set_recording_started(conn, mid, jid) == 0


def test_get_stop_requested_reports_none_stop_or_lost(conn):
    mid, jid = _claimed_live(conn)
    assert db.get_stop_requested(conn, jid, "w1") is None
    conn.execute("UPDATE job SET stop_requested_at=now() WHERE id=%s", (jid,))
    assert db.get_stop_requested(conn, jid, "w1") == "stop"
    assert db.get_stop_requested(conn, jid, "someone-else") == "lost"
    conn.execute("UPDATE job SET status='failed' WHERE id=%s", (jid,))
    assert db.get_stop_requested(conn, jid, "w1") == "lost"
    assert db.get_stop_requested(conn, "job_999", "w1") == "lost"


def test_insert_live_utterance_returns_id_and_enforces_seq(conn):
    mid, jid = _claimed_live(conn)
    lid = db.insert_live_utterance(
        conn,
        meeting_id=mid,
        job_id=jid,
        seq=0,
        start_ms=0,
        end_ms=800,
        text="안녕하세요",
        speaker_id=None,
        similarity=None,
    )
    assert lid.startswith("lut_")
    with pytest.raises(Exception, match="live_utterance_meeting_id_seq_key"):
        db.insert_live_utterance(
            conn,
            meeting_id=mid,
            job_id=jid,
            seq=0,
            start_ms=800,
            end_ms=1600,
            text="또",
            speaker_id=None,
            similarity=None,
        )


def test_delete_live_utterances_only_touches_that_meeting(conn):
    mid, jid = _claimed_live(conn)
    other = seed_meeting(conn)
    for m in (mid, other):
        db.insert_live_utterance(
            conn,
            meeting_id=m,
            job_id=jid,
            seq=0,
            start_ms=0,
            end_ms=500,
            text="x",
            speaker_id=None,
            similarity=None,
        )
    assert db.delete_live_utterances(conn, mid) == 1
    assert (
        conn.execute(
            "SELECT count(*) c FROM live_utterance WHERE meeting_id=%s", (other,)
        ).fetchone()["c"]
        == 1
    )


def test_finalize_commits_and_enqueues_the_wire_process_payload(conn):
    mid, jid = _claimed_live(conn)
    db.insert_live_utterance(
        conn,
        meeting_id=mid,
        job_id=jid,
        seq=0,
        start_ms=0,
        end_ms=500,
        text="살아남는다",
        speaker_id=None,
        similarity=None,
    )
    out = db.finalize_live_session(
        conn, job_id=jid, worker_id="w1", meeting_id=mid, duration_ms=2048, process_payload=PROCESS
    )
    assert out == "committed"
    m = conn.execute(
        "SELECT status, duration_ms, current_job_id FROM meeting WHERE id=%s", (mid,)
    ).fetchone()
    assert m["status"] == "uploaded" and m["duration_ms"] == 2048
    new = conn.execute("SELECT * FROM job WHERE id=%s", (m["current_job_id"],)).fetchone()
    assert new["type"] == "process_meeting" and new["status"] == "queued"
    assert new["payload"] == PROCESS
    assert new["meeting_id"] == mid
    live = conn.execute("SELECT status, progress FROM job WHERE id=%s", (jid,)).fetchone()
    assert live["status"] == "done" and live["progress"] == 100
    # 라이브 행은 최종 패스의 persist가 지운다 — finalize는 남긴다
    assert (
        conn.execute(
            "SELECT count(*) c FROM live_utterance WHERE meeting_id=%s", (mid,)
        ).fetchone()["c"]
        == 1
    )


def test_finalize_discards_when_meeting_was_cancelled(conn):
    mid, jid = _claimed_live(conn)
    conn.execute("UPDATE meeting SET status='failed' WHERE id=%s", (mid,))
    out = db.finalize_live_session(
        conn, job_id=jid, worker_id="w1", meeting_id=mid, duration_ms=10, process_payload=PROCESS
    )
    assert out == "discarded"
    job = conn.execute("SELECT status, error FROM job WHERE id=%s", (jid,)).fetchone()
    assert job["status"] == "done" and job["error"]["code"] == "discarded_by_stale_guard"
    assert (
        conn.execute("SELECT count(*) c FROM job WHERE type='process_meeting'").fetchone()["c"] == 0
    )


def test_finalize_returns_lost_without_job_ownership(conn):
    mid, jid = _claimed_live(conn)
    out = db.finalize_live_session(
        conn, job_id=jid, worker_id="w2", meeting_id=mid, duration_ms=10, process_payload=PROCESS
    )
    assert out == "lost"
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "recording"
    )
