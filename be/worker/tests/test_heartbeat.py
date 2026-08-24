import time

from damwha_worker import db
from damwha_worker.heartbeat import Heartbeat
from tests.conftest import seed_job, seed_meeting


def test_heartbeat_advances_locked_at(conn, pg_url):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    before = conn.execute("SELECT locked_at FROM job WHERE id=%s", (jid,)).fetchone()["locked_at"]
    with Heartbeat(pg_url, jid, "w1", interval=0.05):
        time.sleep(0.2)
    after = conn.execute("SELECT locked_at FROM job WHERE id=%s", (jid,)).fetchone()["locked_at"]
    assert after > before


def _locked_at(conn, jid):
    return conn.execute("SELECT locked_at FROM job WHERE id=%s", (jid,)).fetchone()["locked_at"]


def _wait_until(pred, timeout=10.0, tick=0.02):
    # 고정 sleep 대신 deadline poll — 느린 CI에서도 flake 없이, 빠른 환경에선 즉시 통과
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(tick)
    return False


def test_heartbeat_survives_initial_connect_failure(conn, pg_url, monkeypatch):
    # 최초 connect가 2회 실패해도 스레드는 죽지 않고 재시도 후 beat를 기록한다
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    before = _locked_at(conn, jid)

    real_connect = db.connect
    calls = []

    def flaky_connect(url):
        calls.append(1)
        if len(calls) <= 2:
            raise OSError("db down")
        return real_connect(url)

    monkeypatch.setattr(db, "connect", flaky_connect)
    with Heartbeat(pg_url, jid, "w1", interval=0.05):
        assert _wait_until(lambda: len(calls) >= 3 and _locked_at(conn, jid) > before)
    # 실패 2회 + 성공 후 beat가 실제 기록됨


def test_heartbeat_reconnects_after_beat_failure(conn, pg_url, monkeypatch):
    # beat 1회 실패 → 커넥션 폐기 → 다음 interval에 재접속해 beat 재개
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    before = _locked_at(conn, jid)

    real_connect = db.connect
    real_heartbeat = db.heartbeat
    connects, beats = [], []

    def counting_connect(url):
        connects.append(1)
        return real_connect(url)

    def flaky_beat(c, job_id, worker_id):
        beats.append(1)
        if len(beats) == 1:
            raise OSError("connection lost")
        return real_heartbeat(c, job_id, worker_id)

    monkeypatch.setattr(db, "connect", counting_connect)
    monkeypatch.setattr(db, "heartbeat", flaky_beat)
    with Heartbeat(pg_url, jid, "w1", interval=0.05):
        assert _wait_until(
            lambda: len(connects) >= 2 and len(beats) >= 2 and _locked_at(conn, jid) > before
        )
    # 초기 접속 + beat 실패 후 재접속, beat 재개


def test_heartbeat_fires_on_lost_once_when_ownership_is_lost(conn, pg_url):
    # 운영자 취소(BE가 job을 failed로) → beat의 rowcount 0 → on_lost 정확히 1회
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    calls = []
    hb = Heartbeat(pg_url, jid, "w1", interval=0.05)
    hb.set_on_lost(lambda: calls.append(1))
    with hb:
        time.sleep(0.2)
        assert calls == []  # 소유 중엔 부르지 않는다
        conn.execute("UPDATE job SET status='failed' WHERE id=%s", (jid,))
        assert _wait_until(lambda: len(calls) == 1)
        time.sleep(0.2)
    assert calls == [1]


def test_heartbeat_on_lost_can_be_cleared(conn, pg_url):
    # 훅을 None으로 되돌리면 소유권을 잃어도 아무것도 부르지 않는다(정상 완료 직후 경합 방지)
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    calls = []
    hb = Heartbeat(pg_url, jid, "w1", interval=0.05)
    hb.set_on_lost(lambda: calls.append(1))
    hb.set_on_lost(None)
    with hb:
        conn.execute("UPDATE job SET status='done' WHERE id=%s", (jid,))
        time.sleep(0.3)
    assert calls == []
