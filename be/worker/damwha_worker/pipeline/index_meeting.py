from .. import db
from ..contracts import IndexMeetingPayload
from ..models.base import TextEmbedder


def run_index_meeting(
    conn, job: dict, payload: IndexMeetingPayload, text_embedder: TextEmbedder, *, worker_id: str
) -> str:
    job_id = job["id"]
    meeting_id = payload.meeting_id
    pv = payload.processing_version

    db.set_stage(conn, job_id, worker_id, "embed", 20)

    rows = conn.execute(
        "SELECT id, text FROM utterance "
        "WHERE meeting_id=%s AND status='ok' AND text IS NOT NULL AND processing_version=%s "
        "ORDER BY order_index",
        (meeting_id, pv),
    ).fetchall()

    # 색인 대상이 0개여도 별도 분기를 두지 않는다 — 빈 임베딩으로 persist를 타서
    # 동일한 2-가드(job 소유권 + meeting pv)를 거치게 한다(stale/lost를 noop으로 숨기지 않음).
    embeddings = []
    if rows:
        vectors = text_embedder.embed_texts([r["text"] for r in rows])
        embeddings = [
            {"utterance_id": r["id"], "embedding": v} for r, v in zip(rows, vectors, strict=True)
        ]

    return db.persist_index_meeting(
        conn,
        job_id=job_id,
        worker_id=worker_id,
        meeting_id=meeting_id,
        processing_version=pv,
        model=payload.search_embedding.model,
        dimension=payload.search_embedding.dimension,
        embeddings=embeddings,
    )
