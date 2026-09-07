import pytest
from psycopg.types.json import Jsonb

from damwha_worker import db
from tests.conftest import seed_job, seed_meeting

PROCESS = {"schema_version": 5, "meeting_id": "mtg_1", "audio_key": "k", "marker": "verbatim"}


def _claimed_live(conn, *, status="recording"):
    mid = seed_meeting(conn, status=status)
    jid = seed_job(conn, type="live_session", meeting_id=mid, max_attempts=1)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    return mid, jid


def _sealed(conn, jid, n_bytes):
    """API의 stop이 하는 일: 확정 경계와 봉인을 하나의 TX에서 같은 값으로 커밋한다
    (설계 §3.4). 워커의 finalize는 그 둘이 일치할 때만 자기 차례로 본다 (설계 §4.1)."""
    conn.execute(
        "UPDATE job SET stop_requested_at=now(), committed_bytes=%s, sealed_bytes=%s WHERE id=%s",
        (n_bytes, n_bytes, jid),
    )


def test_get_live_input_state_reports_none_stop_or_lost(conn):
    mid, jid = _claimed_live(conn)
    assert db.get_live_input_state(conn, jid, "w1") == db.LiveInputState(None, 0, None)
    conn.execute("UPDATE job SET stop_requested_at=now() WHERE id=%s", (jid,))
    assert db.get_live_input_state(conn, jid, "w1") == db.LiveInputState("stop", 0, None)
    assert db.get_live_input_state(conn, jid, "nobody") == db.LiveInputState("lost", 0, None)
    conn.execute("UPDATE job SET status='failed' WHERE id=%s", (jid,))
    assert db.get_live_input_state(conn, jid, "w1") == db.LiveInputState("lost", 0, None)
    assert db.get_live_input_state(conn, "job_999", "w1") == db.LiveInputState("lost", 0, None)


def test_get_live_input_state_carries_both_boundaries(conn):
    mid, jid = _claimed_live(conn)
    # 봉인 전: 확정 경계만 전진한다. 그것이 TailSource의 읽기 상한이다 (설계 §3.5).
    conn.execute("UPDATE job SET committed_bytes=%s WHERE id=%s", (32768, jid))
    assert db.get_live_input_state(conn, jid, "w1") == db.LiveInputState(None, 32768, None)
    conn.execute(
        "UPDATE job SET stop_requested_at=now(), committed_bytes=%s, sealed_bytes=%s WHERE id=%s",
        (65536, 65536, jid),
    )
    assert db.get_live_input_state(conn, jid, "w1") == db.LiveInputState("stop", 65536, 65536)


def test_get_live_input_state_hides_the_boundary_once_ownership_is_lost(conn):
    # 소유권을 잃은 워커가 마지막으로 본 경계를 계속 소비하면 이미 남이 쓰고 있는 파일을
    # 전사한다. lost는 committed=0으로 나가고 소비자는 즉시 끝낸다 (설계 §4.2).
    mid, jid = _claimed_live(conn)
    conn.execute(
        "UPDATE job SET stop_requested_at=now(), committed_bytes=%s, sealed_bytes=%s WHERE id=%s",
        (65536, 65536, jid),
    )
    assert db.get_live_input_state(conn, jid, "w2") == db.LiveInputState("lost", 0, None)


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
    _sealed(conn, jid, 2048 * 32)
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
    _sealed(conn, jid, 10 * 32)
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
    # 봉인까지 끝난 세션이라야 이 테스트가 소유권 하나 때문에 lost가 되는 것을 보인다.
    _sealed(conn, jid, 10 * 32)
    out = db.finalize_live_session(
        conn, job_id=jid, worker_id="w2", meeting_id=mid, duration_ms=10, process_payload=PROCESS
    )
    assert out == "lost"
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "recording"
    )


def test_finalize_preserves_capture_error(conn):
    mid, jid = _claimed_live(conn)
    _sealed(conn, jid, 1000 * 32)
    conn.execute(
        "UPDATE meeting SET capture_error=%s WHERE id=%s",
        (Jsonb({"code": "producer_abandoned"}), mid),
    )
    db.finalize_live_session(
        conn,
        job_id=jid,
        worker_id="w1",
        meeting_id=mid,
        duration_ms=1000,
        process_payload=PROCESS,
    )
    row = conn.execute(
        "SELECT status, error, capture_error FROM meeting WHERE id=%s", (mid,)
    ).fetchone()
    assert row["status"] == "uploaded"
    assert row["error"] is None
    # 처리 실패 error는 지워도 캡처 이력은 남아야 한다 — 설계 §2.10
    assert row["capture_error"] == {"code": "producer_abandoned"}


# ── 미리보기 실패 격리 (설계 §4.1·§4.2) ──────────────────────────────────


def test_preview_failure_does_not_fail_recording(conn):
    # 이 테스트는 기존 seed_meeting/seed_job helper의 기본 행을 live로 전환한다.
    from conftest import seed_job, seed_meeting

    from damwha_worker import db

    meeting_id = seed_meeting(conn)
    job_id = seed_job(conn, meeting_id=meeting_id)
    conn.execute(
        "UPDATE job SET type='live_session', status='running', locked_by='w1', "
        "committed_bytes=32768 WHERE id=%s",
        (job_id,),
    )
    conn.execute(
        "UPDATE meeting SET status='recording', current_job_id=%s WHERE id=%s",
        (job_id, meeting_id),
    )
    assert db.fail_live_preview(conn, job_id, "w1", {"code": "live_stt_failed"})
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (meeting_id,)).fetchone()["status"]
        == "recording"
    )


def test_preview_failure_touches_the_job_and_nothing_else(conn):
    """job만 failed다 — meeting.error도, 확정·봉인 경계도 건드리지 않는다 (설계 §4.2).

    경계를 건드리면 다음 append가 자기 오프셋을 못 찾고, meeting.error를 쓰면 배너가
    "이 회의는 실패했다"를 말한다. 둘 다 아직 녹음 중인 회의에 대해 거짓이다.
    """
    mid, jid = _claimed_live(conn)
    conn.execute("UPDATE job SET committed_bytes=%s WHERE id=%s", (32768, jid))

    assert db.fail_live_preview(conn, jid, "w1", {"code": "oom", "message": "out of memory"})

    job = conn.execute(
        "SELECT status, error, committed_bytes, sealed_bytes FROM job WHERE id=%s", (jid,)
    ).fetchone()
    assert job["status"] == "failed" and job["error"]["code"] == "oom"
    assert job["committed_bytes"] == 32768 and job["sealed_bytes"] is None
    meeting = conn.execute(
        "SELECT status, error, capture_error FROM meeting WHERE id=%s", (mid,)
    ).fetchone()
    assert meeting["status"] == "recording"
    assert meeting["error"] is None and meeting["capture_error"] is None


def test_preview_failure_is_guarded_by_ownership(conn):
    """다른 워커·이미 끝난 job이면 0행이고, 그것을 false로 보고한다 — 삼키지 않는다."""
    mid, jid = _claimed_live(conn)
    assert db.fail_live_preview(conn, jid, "w2", {"code": "oom"}) is False
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == (
        "running"
    )
    conn.execute("UPDATE job SET status='done' WHERE id=%s", (jid,))
    assert db.fail_live_preview(conn, jid, "w1", {"code": "oom"}) is False
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "done"


def test_preview_failure_reports_false_when_the_job_row_is_gone(conn):
    """0바이트 사용자 stop은 회의를 지우고, job은 FK의 ON DELETE CASCADE로 함께 사라진다.
    그 뒤 워커가 실패를 기록하려 하면 대상 자체가 없다 — 예외가 아니라 false다."""
    mid, jid = _claimed_live(conn)
    conn.execute("DELETE FROM meeting WHERE id=%s", (mid,))
    assert db.fail_live_preview(conn, jid, "w1", {"code": "oom"}) is False


def test_finalize_refuses_an_unsealed_session(conn):
    """봉인이 없으면 워커는 finalize하지 않는다 — 자라는 중인 파일로 duration을 정하게 된다."""
    mid, jid = _claimed_live(conn)
    conn.execute("UPDATE job SET committed_bytes=%s WHERE id=%s", (65536, jid))
    out = db.finalize_live_session(
        conn, job_id=jid, worker_id="w1", meeting_id=mid, duration_ms=2048, process_payload=PROCESS
    )
    assert out == "lost"
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "recording"
    )
    assert (
        conn.execute("SELECT count(*) c FROM job WHERE type='process_meeting'").fetchone()["c"] == 0
    )


def test_finalize_refuses_when_the_seal_does_not_cover_the_committed_prefix(conn):
    """024 이전 세션처럼 확정 경계가 없는 봉인은 워커의 finalize 조건이 아니다 (설계 §4.1)."""
    mid, jid = _claimed_live(conn)
    conn.execute(
        "UPDATE job SET stop_requested_at=now(), sealed_bytes=%s WHERE id=%s", (65536, jid)
    )
    out = db.finalize_live_session(
        conn, job_id=jid, worker_id="w1", meeting_id=mid, duration_ms=2048, process_payload=PROCESS
    )
    assert out == "lost"
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "recording"
    )
