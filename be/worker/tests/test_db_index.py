from damwha_worker import db
from tests.conftest import seed_job, seed_meeting


def _indexable_utterance(conn, meeting_id, *, order_index=0, status="ok", text="안녕", pv=0):
    row = conn.execute(
        "INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version) "
        "VALUES (%s,'SPEAKER_00',0,1000,%s,%s,%s,%s) RETURNING id",
        (meeting_id, text, status, order_index, pv),
    ).fetchone()
    return row["id"]


def _claimed_index_job(conn, *, pv=0):
    mid = seed_meeting(conn, status="done", processing_version=pv)
    jid = seed_job(conn, type="index_meeting", meeting_id=mid)
    db.claim(conn, "w1")  # → running, locked_by=w1
    return mid, jid


def test_persist_index_commits_embeddings(conn):
    mid, jid = _claimed_index_job(conn, pv=0)
    uid = _indexable_utterance(conn, mid, pv=0)
    out = db.persist_index_meeting(
        conn, job_id=jid, worker_id="w1", meeting_id=mid, processing_version=0,
        model="BAAI/bge-m3", dimension=1024,
        embeddings=[{"utterance_id": uid, "embedding": [0.1] * 1024}],
    )
    assert out == "committed"
    n = conn.execute("SELECT count(*) c FROM utterance_embedding WHERE utterance_id=%s", (uid,)).fetchone()["c"]
    assert n == 1
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "done"
    # meeting은 그대로 done
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == "done"


def test_persist_index_discarded_when_meeting_superseded(conn):
    mid, jid = _claimed_index_job(conn, pv=0)
    uid = _indexable_utterance(conn, mid, pv=0)
    conn.execute("UPDATE meeting SET processing_version=1 WHERE id=%s", (mid,))  # 새 reprocess
    out = db.persist_index_meeting(
        conn, job_id=jid, worker_id="w1", meeting_id=mid, processing_version=0,
        model="BAAI/bge-m3", dimension=1024,
        embeddings=[{"utterance_id": uid, "embedding": [0.1] * 1024}],
    )
    assert out == "discarded"
    assert conn.execute("SELECT count(*) c FROM utterance_embedding", ()).fetchone()["c"] == 0
    j = conn.execute("SELECT status, error FROM job WHERE id=%s", (jid,)).fetchone()
    assert j["status"] == "done" and j["error"]["code"] == "discarded_by_stale_guard"


def test_persist_index_lost_when_job_not_owned(conn):
    mid, jid = _claimed_index_job(conn, pv=0)
    uid = _indexable_utterance(conn, mid, pv=0)
    out = db.persist_index_meeting(
        conn, job_id=jid, worker_id="OTHER", meeting_id=mid, processing_version=0,
        model="BAAI/bge-m3", dimension=1024,
        embeddings=[{"utterance_id": uid, "embedding": [0.1] * 1024}],
    )
    assert out == "lost"
    assert conn.execute("SELECT count(*) c FROM utterance_embedding", ()).fetchone()["c"] == 0


def test_fail_job_marks_job_only(conn):
    mid, jid = _claimed_index_job(conn, pv=0)
    ok = db.fail_job(conn, jid, "w1", {"code": "model_load_failed", "message": "boom"})
    assert ok is True
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "failed"
    # meeting은 절대 failed가 되지 않는다
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == "done"
