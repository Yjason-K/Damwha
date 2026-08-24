import logging
import threading
import time

from .. import db
from ..contracts import IndexMeetingPayload
from ..models.base import TextEmbedder
from .stage import enter_stage
from .timing import timed_stage

log = logging.getLogger("damwha_worker")


def run_index_meeting(
    conn,
    job: dict,
    payload: IndexMeetingPayload,
    text_embedder: TextEmbedder,
    *,
    worker_id: str,
    shutdown_event: threading.Event | None = None,
) -> str:
    job_id = job["id"]
    meeting_id = payload.meeting_id
    pv = payload.processing_version
    ctx = f"job={job_id} meeting={meeting_id} pv={pv}"
    total_t0 = time.perf_counter()
    log.info("%s index_meeting start", ctx)

    enter_stage(conn, job_id, worker_id, "embed", 20, shutdown_event)

    with timed_stage("embed", ctx) as t:
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
                {"utterance_id": r["id"], "embedding": v}
                for r, v in zip(rows, vectors, strict=True)
            ]
        t["detail"] = f"utterances={len(rows)} embeddings={len(embeddings)}"

    with timed_stage("index_persist", ctx) as t:
        outcome = db.persist_index_meeting(
            conn,
            job_id=job_id,
            worker_id=worker_id,
            meeting_id=meeting_id,
            processing_version=pv,
            model=payload.search_embedding.model,
            dimension=payload.search_embedding.dimension,
            embeddings=embeddings,
        )
        t["detail"] = f"outcome={outcome}"

    total_ms = int((time.perf_counter() - total_t0) * 1000)
    log.info("%s index_meeting done outcome=%s total_ms=%d", ctx, outcome, total_ms)
    return outcome
