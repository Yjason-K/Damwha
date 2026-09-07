import threading
import time

import psycopg
import pytest
from psycopg.rows import dict_row
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


# ── worker finalize ↔ API orphan 회수 (설계 §4.1·§5) ──────────────────────
#
# 두 psycopg 연결로 실제 잠금을 잡고 겨룬다. 순서는 job 행 잠금이 강제하고, 대기는
# pg_locks가 확인한다 — 임의 sleep으로 승자를 가정하지 않는다. 워커 쪽은 진짜
# finalize_live_session이다: TS에서 워커 SQL을 흉내 낸 테스트는 이 구현을 검증하지 못한다.


def _api_recovery(conn, *, job_id, meeting_id, duration_ms, process_payload):
    """API 스위퍼가 잠금 아래에서 하는 회수 (live.service.ts finalizeByApi).

    이 테스트의 주어는 워커의 실제 finalize이고, 이쪽은 겨루는 다른 actor의 역할이다.
    잠금 순서는 API와 같은 job → meeting. 가드가 막으면 0을 돌려주고 아무것도 쓰지 않는다.
    """
    conn.execute("SELECT id FROM job WHERE id=%s FOR UPDATE", (job_id,))
    conn.execute("SELECT id FROM meeting WHERE id=%s FOR UPDATE", (meeting_id,))
    cur = conn.execute(
        "UPDATE meeting SET status='uploaded', duration_ms=%s, error=NULL "
        "WHERE id=%s AND status='recording' AND current_job_id=%s",
        (duration_ms, meeting_id, job_id),
    )
    if cur.rowcount == 0:
        return 0
    new_id = conn.execute(
        "INSERT INTO job(type, meeting_id, payload) VALUES('process_meeting',%s,%s) RETURNING id",
        (meeting_id, Jsonb(process_payload)),
    ).fetchone()["id"]
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (new_id, meeting_id))
    conn.execute(
        "UPDATE job SET status='done', progress=100, updated_at=now() WHERE id=%s", (job_id,)
    )
    return 1


def _wait_until_blocked(conn, pid, timeout=15.0):
    """그 백엔드가 실제로 잠금을 기다릴 때까지 기다린다. 판정은 pg_locks가 한다."""
    deadline = time.monotonic() + timeout
    while True:
        blocked = conn.execute(
            "SELECT count(*) c FROM pg_locks WHERE pid=%s AND NOT granted", (pid,)
        ).fetchone()["c"]
        if blocked:
            return
        assert time.monotonic() < deadline, f"backend {pid} never blocked on a lock"
        time.sleep(0.01)


def _in_thread(fn):
    """결과와 예외를 함께 담아 돌려주는 얇은 러너 — 스레드가 조용히 죽지 않게 한다."""
    box = {}

    def run():
        try:
            box["out"] = fn()
        except BaseException as e:  # noqa: BLE001 - 그대로 다시 올린다
            box["err"] = e

    t = threading.Thread(target=run)
    t.start()
    return t, box


def test_worker_finalize_wins_and_the_waiting_api_recovery_writes_nothing(conn, pg_url):
    """워커가 job 잠금을 먼저 잡았다. 뒤늦게 잠근 API는 recording이 아님을 보고 물러난다."""
    mid, jid = _claimed_live(conn)
    _sealed(conn, jid, 4096 * 32)
    worker = psycopg.connect(pg_url, row_factory=dict_row, autocommit=True)
    api = psycopg.connect(pg_url, row_factory=dict_row)  # autocommit=False
    try:
        api_pid = api.execute("SELECT pg_backend_pid() p").fetchone()["p"]
        # 바깥 트랜잭션으로 finalize의 잠금을 커밋 직전까지 붙잡아 둔다.
        with worker.transaction():
            out = db.finalize_live_session(
                worker,
                job_id=jid,
                worker_id="w1",
                meeting_id=mid,
                duration_ms=4096,
                process_payload=PROCESS,
            )
            assert out == "committed"
            t, box = _in_thread(
                lambda: _api_recovery(
                    api, job_id=jid, meeting_id=mid, duration_ms=2048, process_payload=PROCESS
                )
            )
            _wait_until_blocked(conn, api_pid)
        t.join(timeout=20)
        assert not t.is_alive()
        api.commit()
    finally:
        api.rollback()
        api.close()
        worker.close()

    assert "err" not in box, box.get("err")
    assert box["out"] == 0  # stale actor는 한 행도 쓰지 않았다
    meeting = conn.execute(
        "SELECT status, duration_ms, current_job_id FROM meeting WHERE id=%s", (mid,)
    ).fetchone()
    assert meeting["status"] == "uploaded" and meeting["duration_ms"] == 4096
    rows = conn.execute(
        "SELECT id FROM job WHERE type='process_meeting' AND meeting_id=%s", (mid,)
    ).fetchall()
    assert len(rows) == 1
    assert meeting["current_job_id"] == rows[0]["id"]


def test_api_recovery_wins_and_the_waiting_worker_finalize_writes_nothing(conn, pg_url):
    """API가 job 잠금을 먼저 잡고 회수했다. 뒤늦게 잠근 워커의 실제 finalize는 lost다."""
    mid, jid = _claimed_live(conn)
    _sealed(conn, jid, 4096 * 32)
    worker = psycopg.connect(pg_url, row_factory=dict_row, autocommit=True)
    api = psycopg.connect(pg_url, row_factory=dict_row)  # autocommit=False
    try:
        worker_pid = worker.execute("SELECT pg_backend_pid() p").fetchone()["p"]
        assert (
            _api_recovery(
                api, job_id=jid, meeting_id=mid, duration_ms=4096, process_payload=PROCESS
            )
            == 1
        )
        t, box = _in_thread(
            lambda: db.finalize_live_session(
                worker,
                job_id=jid,
                worker_id="w1",
                meeting_id=mid,
                duration_ms=2048,  # 루프가 들고 있던 낡은 값 — 절대 반영되면 안 된다
                process_payload=PROCESS,
            )
        )
        _wait_until_blocked(conn, worker_pid)
        api.commit()
        t.join(timeout=20)
        assert not t.is_alive()
    finally:
        api.rollback()
        api.close()
        worker.close()

    assert "err" not in box, box.get("err")
    assert box["out"] == "lost"  # stale actor는 한 행도 쓰지 않았다
    meeting = conn.execute(
        "SELECT status, duration_ms, current_job_id FROM meeting WHERE id=%s", (mid,)
    ).fetchone()
    assert meeting["status"] == "uploaded" and meeting["duration_ms"] == 4096
    rows = conn.execute(
        "SELECT id FROM job WHERE type='process_meeting' AND meeting_id=%s", (mid,)
    ).fetchall()
    assert len(rows) == 1
    assert meeting["current_job_id"] == rows[0]["id"]
    live = conn.execute("SELECT status, error FROM job WHERE id=%s", (jid,)).fetchone()
    assert live["status"] == "done" and live["error"] is None
