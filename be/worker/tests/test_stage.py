import threading

import pytest

from damwha_worker import db
from damwha_worker.errors import ErrorKind, ShutdownRequested, WorkerError
from damwha_worker.pipeline.stage import enter_stage
from tests.conftest import seed_job, seed_meeting


def _claimed_job(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    return jid


def test_enter_stage_sets_stage_when_owned(conn):
    jid = _claimed_job(conn)
    enter_stage(conn, jid, "w1", "vad", 15)
    row = conn.execute("SELECT stage, progress FROM job WHERE id=%s", (jid,)).fetchone()
    assert row["stage"] == "vad" and row["progress"] == 15


def test_enter_stage_raises_shutdown_before_touching_db(conn):
    jid = _claimed_job(conn)
    ev = threading.Event()
    ev.set()
    with pytest.raises(ShutdownRequested):
        enter_stage(conn, jid, "w1", "vad", 15, shutdown_event=ev)
    # shutdown이 set_stage보다 먼저 — stage는 미기록
    assert conn.execute("SELECT stage FROM job WHERE id=%s", (jid,)).fetchone()["stage"] is None


def test_enter_stage_raises_lost_ownership_transient(conn):
    jid = _claimed_job(conn)  # w1 소유
    with pytest.raises(WorkerError) as ei:
        enter_stage(conn, jid, "w2", "vad", 15)  # 소유자 아님
    assert ei.value.code == "lost_ownership"
    assert ei.value.kind is ErrorKind.TRANSIENT
