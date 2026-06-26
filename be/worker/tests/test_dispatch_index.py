from damwha_worker import db
from damwha_worker.__main__ import handle_job, run_once
from damwha_worker.errors import ErrorKind, WorkerError
from damwha_worker.storage import Storage
from tests.conftest import seed_job, seed_meeting
from tests.fakes import FakeTextEmbedder


class RaisingTextEmbedder:
    def __init__(self, kind=ErrorKind.PERMANENT):
        self._kind = kind

    def embed_texts(self, texts):
        raise WorkerError("model_load_failed", "boom", self._kind, stage="embed")


def _index_payload(mid):
    # handle_job이 dispatch 전에 parse_payload로 검증하므로 유효 payload가 필수다
    # (기본 {} → IndexMeetingPayload 검증 실패 → 의도한 경로 전에 TRANSIENT로 터짐).
    return {
        "schema_version": 1,
        "meeting_id": str(mid),
        "processing_version": 0,
        "search_embedding": {"model": "BAAI/bge-m3", "dimension": 1024},
    }


def _claimed_index_job(conn, mid):
    jid = seed_job(conn, type="index_meeting", meeting_id=mid, payload=_index_payload(mid))
    db.claim(conn, "w1")
    return conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone()


def test_index_permanent_failure_fails_job_only(conn, tmp_path):
    mid = seed_meeting(conn, status="done", processing_version=0)
    conn.execute(
        "INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,"
        "order_index,processing_version) "
        "VALUES (%s,'SPEAKER_00',0,1000,'안녕','ok',0,0)",
        (mid,),
    )
    job = _claimed_index_job(conn, mid)
    out = handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        text_embedder=RaisingTextEmbedder(ErrorKind.PERMANENT),
    )
    assert out == "failed"
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (job["id"],)).fetchone()["status"]
        == "failed"
    )
    # 핵심: meeting은 절대 failed가 아니다
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "done"
    )


def test_index_transient_failure_requeues(conn, tmp_path):
    mid = seed_meeting(conn, status="done", processing_version=0)
    conn.execute(
        "INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,"
        "order_index,processing_version) "
        "VALUES (%s,'SPEAKER_00',0,1000,'안녕','ok',0,0)",
        (mid,),
    )
    job = _claimed_index_job(conn, mid)
    out = handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        text_embedder=RaisingTextEmbedder(ErrorKind.TRANSIENT),
    )
    assert out == "requeued"
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (job["id"],)).fetchone()["status"]
        == "queued"
    )
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "done"
    )


def test_run_once_handles_index_job(conn, tmp_path):
    # run_once가 text_embedder를 받아 index_meeting을 정상 처리(None이면 깨짐)
    mid = seed_meeting(conn, status="done", processing_version=0)
    conn.execute(
        "INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,"
        "order_index,processing_version) "
        "VALUES (%s,'SPEAKER_00',0,1000,'안녕','ok',0,0)",
        (mid,),
    )
    seed_job(conn, type="index_meeting", meeting_id=mid, payload=_index_payload(mid))
    out = run_once(conn, "w1", None, Storage(str(tmp_path)), text_embedder=FakeTextEmbedder())
    assert out == "committed"
    assert conn.execute("SELECT count(*) c FROM utterance_embedding", ()).fetchone()["c"] == 1
