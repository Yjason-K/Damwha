"""검색 색인(index_meeting) 결과 영속화."""

from psycopg.types.json import Jsonb

from .core import _Abort, _vec


def persist_index_meeting(
    conn, *, job_id, worker_id, meeting_id, processing_version, model, dimension, embeddings
) -> str:
    try:
        with conn.transaction():
            # (1) job ownership guard
            owned = conn.execute(
                "SELECT 1 FROM job WHERE id=%s AND locked_by=%s AND status='running' FOR UPDATE",
                (job_id, worker_id),
            ).fetchone()
            if owned is None:
                raise _Abort
            # (2) meeting stale guard: 더 새 reprocess가 pv를 올렸으면 discard
            mrow = conn.execute(
                "SELECT processing_version FROM meeting WHERE id=%s FOR UPDATE", (meeting_id,)
            ).fetchone()
            if mrow is None or mrow["processing_version"] != processing_version:
                conn.execute(
                    "UPDATE job SET status='done', error=%s, updated_at=now() WHERE id=%s",
                    (
                        Jsonb(
                            {
                                "code": "discarded_by_stale_guard",
                                "message": "meeting superseded by newer processing_version",
                                "stage": "embed",
                                "kind": None,
                            }
                        ),
                        job_id,
                    ),
                )
                return "discarded"
            # upsert embeddings (UNIQUE utterance_id, model)
            for e in embeddings:
                conn.execute(
                    """
                    INSERT INTO utterance_embedding(utterance_id, embedding, model, dimension,
                        processing_version, job_id)
                    VALUES (%s,%s::vector,%s,%s,%s,%s)
                    ON CONFLICT (utterance_id, model)
                    DO UPDATE SET embedding=EXCLUDED.embedding, dimension=EXCLUDED.dimension,
                        processing_version=EXCLUDED.processing_version, job_id=EXCLUDED.job_id,
                        created_at=now()
                    """,
                    (
                        e["utterance_id"],
                        _vec(e["embedding"]),
                        model,
                        dimension,
                        processing_version,
                        job_id,
                    ),
                )
            conn.execute(
                "UPDATE job SET status='done', progress=100, updated_at=now() WHERE id=%s",
                (job_id,),
            )
            return "committed"
    except _Abort:
        return "lost"
