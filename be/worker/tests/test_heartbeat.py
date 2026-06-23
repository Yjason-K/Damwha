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
