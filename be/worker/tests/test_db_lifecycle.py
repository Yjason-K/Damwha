from damwha_worker import db
from tests.conftest import seed_job, seed_meeting, seed_speaker


def test_claim_increments_attempts_and_locks(conn):
    mid = seed_meeting(conn)
    seed_job(conn, meeting_id=mid)
    j = db.claim(conn, "w1")
    assert j is not None
    assert j["status"] == "running"
    assert j["attempts"] == 1
    assert j["locked_by"] == "w1"
    assert j["stage"] is None


def test_claim_empty_returns_none(conn):
    assert db.claim(conn, "w1") is None


def test_claim_skips_future_retry_until_eligible(conn):
    delayed = seed_job(conn, type="index_meeting")
    conn.execute("UPDATE job SET next_attempt_at=now() + interval '1 hour' WHERE id=%s", (delayed,))
    ready = seed_job(conn, type="index_meeting")

    assert db.claim(conn, "w1")["id"] == ready


def test_set_stage_guarded_by_ownership(conn):
    mid = seed_meeting(conn)
    seed_job(conn, meeting_id=mid)
    j = db.claim(conn, "w1")
    assert db.set_stage(conn, j["id"], "w1", "diarize", 40) == 1
    assert db.set_stage(conn, j["id"], "someone-else", "stt", 60) == 0  # lost ownership
    row = conn.execute("SELECT stage, progress FROM job WHERE id=%s", (j["id"],)).fetchone()
    assert row["stage"] == "diarize" and row["progress"] == 40


def test_mark_processing_guarded_by_meeting(conn):
    mid = seed_meeting(conn, processing_version=2)
    jid = seed_job(conn, meeting_id=mid)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    assert db.mark_processing(conn, mid, jid, 2) == 1
    assert db.mark_processing(conn, mid, jid, 1) == 0  # version mismatch → stale
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "processing"
    )


def test_requeue_clears_lock(conn):
    mid = seed_meeting(conn)
    seed_job(conn, meeting_id=mid)
    j = db.claim(conn, "w1")
    assert db.requeue(conn, j["id"], "w1") == 1
    row = conn.execute(
        "SELECT status, locked_by, locked_at FROM job WHERE id=%s", (j["id"],)
    ).fetchone()
    assert row["status"] == "queued" and row["locked_by"] is None and row["locked_at"] is None


def test_requeue_sets_delay_from_claimed_attempt(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")

    assert db.requeue(conn, jid, "w1") == 1
    row = conn.execute(
        "SELECT next_attempt_at - now() AS delay FROM job WHERE id=%s", (jid,)
    ).fetchone()
    assert 0.5 <= row["delay"].total_seconds() <= 1.5


def test_requeue_for_shutdown_restores_attempts(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)  # attempts=0
    db.claim(conn, "w1")  # attempts 0→1
    assert db.requeue_for_shutdown(conn, jid, "w1") == 1
    row = conn.execute(
        "SELECT status, locked_by, locked_at, attempts FROM job WHERE id=%s", (jid,)
    ).fetchone()
    assert row["status"] == "queued"
    assert row["locked_by"] is None and row["locked_at"] is None
    assert row["attempts"] == 0  # claim의 +1이 되돌려짐 — 순 소모 0


def test_requeue_for_shutdown_attempts_never_negative(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    conn.execute("UPDATE job SET attempts=0 WHERE id=%s", (jid,))  # 인위적 0
    assert db.requeue_for_shutdown(conn, jid, "w1") == 1
    assert conn.execute("SELECT attempts FROM job WHERE id=%s", (jid,)).fetchone()["attempts"] == 0


def test_requeue_for_shutdown_guarded_by_ownership(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    assert db.requeue_for_shutdown(conn, jid, "w2") == 0  # 소유자 아님 — no-op
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "running"
    )


def test_reap_stale_fails_exhausted_process_meeting_and_entity(conn):
    mid = seed_meeting(conn, status="processing")
    jid = seed_job(
        conn,
        meeting_id=mid,
        status="running",
        locked_by="dead-worker",
        attempts=3,
        max_attempts=3,
        locked_minutes_ago=31,
    )
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))

    assert db.reap_stale(conn, 30) == (0, 1)
    job = conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()
    meeting = conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert job["status"] == "failed"
    assert meeting["status"] == "failed"


def test_reap_stale_makes_retried_job_immediately_eligible(conn):
    mid = seed_meeting(conn, status="processing")
    jid = seed_job(
        conn,
        meeting_id=mid,
        status="running",
        locked_by="dead-worker",
        attempts=1,
        max_attempts=3,
        locked_minutes_ago=31,
    )
    conn.execute("UPDATE job SET next_attempt_at=now() + interval '1 hour' WHERE id=%s", (jid,))

    assert db.reap_stale(conn, 30) == (1, 0)
    row = conn.execute("SELECT status, next_attempt_at FROM job WHERE id=%s", (jid,)).fetchone()
    assert row["status"] == "queued"
    assert row["next_attempt_at"] is None


def test_fail_process_meeting_propagates(conn):
    mid = seed_meeting(conn, processing_version=0)
    jid = seed_job(conn, meeting_id=mid)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    ok = db.fail_process_meeting(conn, jid, "w1", mid, {"code": "corrupt_audio", "message": "x"})
    assert ok is True
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "failed"
    )
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "failed"
    )


def test_fail_process_meeting_lost_ownership(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    assert db.fail_process_meeting(conn, jid, "OTHER", mid, {"code": "x", "message": "y"}) is False
    # job not failed by a non-owner
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "running"
    )


def test_fail_enroll_propagates(conn):
    sid = seed_speaker(conn, enrollment_status="pending")
    jid = seed_job(conn, type="enroll_speaker", meeting_id=None)
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    db.claim(conn, "w1")
    assert (
        db.fail_enroll(conn, jid, "w1", sid, {"code": "model_load_failed", "message": "x"}) is True
    )
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "failed"
    )
    row = conn.execute(
        "SELECT enrollment_status, enrollment_error FROM speaker WHERE id=%s", (sid,)
    ).fetchone()
    assert row["enrollment_status"] == "failed"
    assert row["enrollment_error"] is not None


def test_fail_enroll_lost_ownership(conn):
    sid = seed_speaker(conn, enrollment_status="pending")
    jid = seed_job(conn, type="enroll_speaker", meeting_id=None)
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    db.claim(conn, "w1")
    assert db.fail_enroll(conn, jid, "OTHER", sid, {"code": "x", "message": "y"}) is False
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "running"
    )
    assert (
        conn.execute("SELECT enrollment_status FROM speaker WHERE id=%s", (sid,)).fetchone()[
            "enrollment_status"
        ]
        == "pending"
    )


def test_peek_queued_true_when_queued_job_exists(conn):
    mid = seed_meeting(conn)
    seed_job(conn, meeting_id=mid)
    assert db.peek_queued(conn) is True


def test_peek_queued_false_when_empty(conn):
    assert db.peek_queued(conn) is False


def test_peek_queued_does_not_claim(conn):
    mid = seed_meeting(conn)
    seed_job(conn, meeting_id=mid)
    db.peek_queued(conn)
    row = conn.execute("SELECT status FROM job WHERE meeting_id=%s", (mid,)).fetchone()
    assert row["status"] == "queued"


def test_worker_capabilities_upsert_overwrites(conn):
    db.upsert_worker_capabilities(conn, {"worker_id": "w1", "gpu_eligible": True})
    db.upsert_worker_capabilities(conn, {"worker_id": "w2", "gpu_eligible": False})
    row = conn.execute(
        "SELECT value FROM app_setting WHERE key=%s", (db.WORKER_CAPABILITIES_KEY,)
    ).fetchone()
    assert row["value"] == {"worker_id": "w2", "gpu_eligible": False}
