from damwha_worker import db
from damwha_worker.contracts import IndexMeetingPayload
from damwha_worker.pipeline.index_meeting import run_index_meeting
from tests.conftest import seed_job, seed_meeting
from tests.fakes import FakeTextEmbedder


def _payload(mid, pv=0):
    return IndexMeetingPayload(
        meeting_id=str(mid), processing_version=pv,
        search_embedding={"model": "BAAI/bge-m3", "dimension": 1024},
    )


def _seed_utts(conn, mid, rows):
    # rows: list of (order_index, status, text)
    for oi, status, text in rows:
        conn.execute(
            "INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version) "
            "VALUES (%s,'SPEAKER_00',0,1000,%s,%s,%s,0)",
            (mid, text, status, oi),
        )


def _claim(conn, mid):
    jid = seed_job(conn, type="index_meeting", meeting_id=mid)
    db.claim(conn, "w1")
    return conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone()


def test_index_embeds_only_ok_text_utterances(conn):
    mid = seed_meeting(conn, status="done", processing_version=0)
    _seed_utts(conn, mid, [(0, "ok", "안녕하세요"), (1, "silence", None), (2, "ok", None)])
    job = _claim(conn, mid)
    out = run_index_meeting(conn, job, _payload(mid), FakeTextEmbedder(), worker_id="w1")
    assert out == "committed"
    # status='ok' AND text IS NOT NULL 인 1건만 임베딩
    n = conn.execute("SELECT count(*) c FROM utterance_embedding", ()).fetchone()["c"]
    assert n == 1


def test_index_commits_zero_when_no_indexable(conn):
    mid = seed_meeting(conn, status="done", processing_version=0)
    _seed_utts(conn, mid, [(0, "silence", None)])
    job = _claim(conn, mid)
    out = run_index_meeting(conn, job, _payload(mid), FakeTextEmbedder(), worker_id="w1")
    assert out == "committed"  # 색인 대상 0개도 동일한 2-가드 TX를 타고 job done
    assert conn.execute("SELECT count(*) c FROM utterance_embedding", ()).fetchone()["c"] == 0
    assert conn.execute("SELECT status FROM job WHERE id=%s", (job["id"],)).fetchone()["status"] == "done"


def test_index_discarded_on_stale_pv(conn):
    mid = seed_meeting(conn, status="done", processing_version=0)
    _seed_utts(conn, mid, [(0, "ok", "안녕")])
    job = _claim(conn, mid)
    conn.execute("UPDATE meeting SET processing_version=1 WHERE id=%s", (mid,))
    out = run_index_meeting(conn, job, _payload(mid, pv=0), FakeTextEmbedder(), worker_id="w1")
    assert out == "discarded"
    assert conn.execute("SELECT count(*) c FROM utterance_embedding", ()).fetchone()["c"] == 0
