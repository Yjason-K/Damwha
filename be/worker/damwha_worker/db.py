import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


def connect(url: str) -> psycopg.Connection:
    return psycopg.connect(url, row_factory=dict_row, autocommit=True)


def claim(conn, worker_id: str) -> dict | None:
    return conn.execute(
        """
        UPDATE job SET status='running', locked_by=%s, locked_at=now(),
               attempts = attempts + 1, updated_at=now()
        WHERE id IN (
          SELECT id FROM job WHERE status='queued'
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
        ) RETURNING *
        """,
        (worker_id,),
    ).fetchone()


def mark_processing(conn, meeting_id: str, job_id: str, processing_version: int) -> int:
    cur = conn.execute(
        """
        UPDATE meeting SET status='processing'
        WHERE id=%s AND current_job_id=%s AND processing_version=%s
        """,
        (meeting_id, job_id, processing_version),
    )
    return cur.rowcount


def set_stage(conn, job_id: str, worker_id: str, stage: str, progress: int) -> int:
    cur = conn.execute(
        """
        UPDATE job SET stage=%s, progress=%s, updated_at=now()
        WHERE id=%s AND locked_by=%s AND status='running'
        """,
        (stage, progress, job_id, worker_id),
    )
    return cur.rowcount


def heartbeat(conn, job_id: str, worker_id: str) -> int:
    cur = conn.execute(
        """
        UPDATE job SET locked_at=now(), updated_at=now()
        WHERE id=%s AND locked_by=%s AND status='running'
        """,
        (job_id, worker_id),
    )
    return cur.rowcount


def requeue(conn, job_id: str, worker_id: str) -> int:
    cur = conn.execute(
        """
        UPDATE job SET status='queued', locked_by=NULL, locked_at=NULL, updated_at=now()
        WHERE id=%s AND locked_by=%s AND status='running'
        """,
        (job_id, worker_id),
    )
    return cur.rowcount


def requeue_for_shutdown(conn, job_id: str, worker_id: str) -> int:
    # graceful shutdown은 job의 잘못이 아니다 — claim이 올린 attempts를 되돌린다.
    cur = conn.execute(
        """
        UPDATE job SET status='queued', locked_by=NULL, locked_at=NULL,
               attempts = greatest(attempts - 1, 0), updated_at=now()
        WHERE id=%s AND locked_by=%s AND status='running'
        """,
        (job_id, worker_id),
    )
    return cur.rowcount


def fail_process_meeting(conn, job_id: str, worker_id: str, meeting_id: str, error: dict) -> bool:
    try:
        with conn.transaction():
            cur = conn.execute(
                "UPDATE job SET status='failed', error=%s, updated_at=now() "
                "WHERE id=%s AND locked_by=%s AND status='running'",
                (Jsonb(error), job_id, worker_id),
            )
            if cur.rowcount == 0:
                raise _Abort
            conn.execute(
                "UPDATE meeting SET status='failed', error=%s WHERE id=%s AND current_job_id=%s",
                (Jsonb({"code": error["code"], "message": error["message"]}), meeting_id, job_id),
            )
        return True
    except _Abort:
        return False


def fail_enroll(conn, job_id: str, worker_id: str, speaker_id: str, error: dict) -> bool:
    try:
        with conn.transaction():
            cur = conn.execute(
                "UPDATE job SET status='failed', error=%s, updated_at=now() "
                "WHERE id=%s AND locked_by=%s AND status='running'",
                (Jsonb(error), job_id, worker_id),
            )
            if cur.rowcount == 0:
                raise _Abort
            conn.execute(
                "UPDATE speaker SET enrollment_status='failed', enrollment_error=%s "
                "WHERE id=%s AND current_job_id=%s",
                (Jsonb({"code": error["code"], "message": error["message"]}), speaker_id, job_id),
            )
        return True
    except _Abort:
        return False


class _Abort(Exception):
    """Internal: rollback a guarded transaction when ownership is lost."""


def _vec(values):
    return "[" + ",".join(repr(float(x)) for x in values) + "]"


def persist_process_meeting(
    conn,
    *,
    job_id,
    worker_id,
    meeting_id,
    processing_version,
    normalized_key,
    duration_ms,
    utterances,
    clusters,
    embedding_model=None,
    embedding_dim=None,
    default_speaker_prefix="Speaker",
    index_search_model=None,
    index_search_dim=None,
) -> str:
    try:
        with conn.transaction():
            # (1) job ownership
            owned = conn.execute(
                "SELECT 1 FROM job WHERE id=%s AND locked_by=%s AND status='running' FOR UPDATE",
                (job_id, worker_id),
            ).fetchone()
            if owned is None:
                raise _Abort

            # (2) meeting guard
            cur = conn.execute(
                """
                UPDATE meeting SET status='done', error=NULL,
                       normalized_key=%s, duration_ms=%s
                WHERE id=%s AND processing_version=%s AND current_job_id=%s
                """,
                (normalized_key, duration_ms, meeting_id, processing_version, job_id),
            )
            if cur.rowcount == 0:
                conn.execute(
                    "UPDATE job SET status='done', error=%s, updated_at=now() WHERE id=%s",
                    (
                        Jsonb(
                            {
                                "code": "discarded_by_stale_guard",
                                "message": (
                                    "meeting superseded by newer processing_version/current_job_id"
                                ),
                                "stage": "persist",
                                "kind": None,
                            }
                        ),
                        job_id,
                    ),
                )
                return "discarded"

            # fresh: replace results
            conn.execute("DELETE FROM utterance WHERE meeting_id=%s", (meeting_id,))
            conn.execute("DELETE FROM meeting_cluster WHERE meeting_id=%s", (meeting_id,))

            # 미식별 cluster → provisional speaker + voiceprint(provenance) 자동 생성
            # (embedding_model이 없으면 voiceprint 삽입 불가 → 미해소 cluster만 보존)
            label_to_new_speaker: dict[str, str] = {}
            for c in clusters:
                centroid = c["centroid"]
                if centroid is None or embedding_model is None:
                    # centroid 없거나 embedding model 미제공: speaker/voiceprint 없이 cluster만 보존
                    conn.execute(
                        """
                        INSERT INTO meeting_cluster(meeting_id, diar_label, centroid,
                            resolved_speaker_id, processing_version, job_id)
                        VALUES (%s,%s,%s::vector,%s,%s,%s)
                        """,
                        (
                            meeting_id,
                            c["diar_label"],
                            _vec(centroid) if centroid is not None else None,
                            c["resolved_speaker_id"],
                            processing_version,
                            job_id,
                        ),
                    )
                    continue
                sid = conn.execute(
                    """
                    INSERT INTO speaker(name, enrollment_status)
                    VALUES (%s || '_' || lpad(nextval('speaker_default_seq')::text, 3, '0'),
                            'provisional')
                    RETURNING id
                    """,
                    (default_speaker_prefix,),
                ).fetchone()["id"]
                cid = conn.execute(
                    """
                    INSERT INTO meeting_cluster(meeting_id, diar_label, centroid,
                        resolved_speaker_id, processing_version, job_id)
                    VALUES (%s,%s,%s::vector,%s,%s,%s)
                    RETURNING id
                    """,
                    (meeting_id, c["diar_label"], _vec(centroid), sid, processing_version, job_id),
                ).fetchone()["id"]
                conn.execute(
                    """
                    INSERT INTO voiceprint(speaker_id, embedding, model, dimension,
                        source, source_cluster_id)
                    VALUES (%s,%s::vector,%s,%s,'auto_cluster',%s)
                    """,
                    (sid, _vec(centroid), embedding_model, embedding_dim, cid),
                )
                label_to_new_speaker[c["diar_label"]] = sid

            for u in utterances:
                speaker_id = u["speaker_id"] or label_to_new_speaker.get(u["diar_label"])
                conn.execute(
                    """
                    INSERT INTO utterance(meeting_id, speaker_id, diar_label,
                        start_ms, end_ms, text, confidence, status,
                        transcript_error, order_index, processing_version, job_id)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (
                        meeting_id,
                        speaker_id,
                        u["diar_label"],
                        u["start_ms"],
                        u["end_ms"],
                        u["text"],
                        u["confidence"],
                        u["status"],
                        Jsonb(u["transcript_error"]) if u["transcript_error"] is not None else None,
                        u["order_index"],
                        processing_version,
                        job_id,
                    ),
                )
            # GC provisional speakers orphaned by this (re)process: no utterance/cluster
            # references them. auto_cluster voiceprints cascade-delete with the speaker.
            # First run: no-op. Reprocess: removes the prior run's unconfirmed provisionals.
            # 'ready' (confirmed) speakers are never deleted. Runs AFTER the new rows are
            # inserted, so this run's just-created provisionals are referenced and kept.
            conn.execute(
                """
                DELETE FROM speaker s
                WHERE s.enrollment_status='provisional'
                  AND NOT EXISTS (SELECT 1 FROM utterance WHERE speaker_id = s.id)
                  AND NOT EXISTS (SELECT 1 FROM meeting_cluster WHERE resolved_speaker_id = s.id)
                """
            )
            conn.execute(
                "UPDATE job SET status='done', progress=100, updated_at=now() WHERE id=%s",
                (job_id,),
            )
            if index_search_model is not None and index_search_dim is not None:
                conn.execute(
                    "INSERT INTO job(type, meeting_id, payload) VALUES('index_meeting', %s, %s)",
                    (
                        meeting_id,
                        Jsonb(
                            {
                                "schema_version": 1,
                                "meeting_id": str(meeting_id),
                                "processing_version": processing_version,
                                "search_embedding": {
                                    "model": index_search_model,
                                    "dimension": index_search_dim,
                                },
                            }
                        ),
                    ),
                )
            return "committed"
    except _Abort:
        return "lost"


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


def fail_job(conn, job_id: str, worker_id: str, error: dict) -> bool:
    cur = conn.execute(
        "UPDATE job SET status='failed', error=%s, updated_at=now() "
        "WHERE id=%s AND locked_by=%s AND status='running'",
        (Jsonb(error), job_id, worker_id),
    )
    return cur.rowcount > 0


def _lens_stale_error() -> dict:
    return {
        "code": "discarded_by_stale_guard",
        "message": "meeting superseded by newer processing_version",
        "stage": "extract_lenses",
        "kind": None,
    }


def mark_lens_run_running(
    conn, *, job_id, worker_id, meeting_id, processing_version, run_id
) -> str:
    """Claim the run only while this claimed job still represents its meeting version."""
    try:
        with conn.transaction():
            row = conn.execute(
                """
                SELECT j.id, r.status AS run_status, m.processing_version
                FROM job j
                JOIN lens_extraction_run r ON r.job_id=j.id
                JOIN meeting m ON m.id=r.meeting_id
                WHERE j.id=%s AND j.locked_by=%s AND j.status='running'
                  AND j.meeting_id=%s AND r.id=%s AND r.meeting_id=%s
                  AND r.processing_version=%s
                FOR UPDATE OF j, r, m
                """,
                (job_id, worker_id, meeting_id, run_id, meeting_id, processing_version),
            ).fetchone()
            if row is None:
                raise _Abort
            if row["processing_version"] != processing_version:
                error = _lens_stale_error()
                conn.execute(
                    "UPDATE job SET status='done', error=%s, updated_at=now() WHERE id=%s",
                    (Jsonb(error), job_id),
                )
                conn.execute(
                    """UPDATE lens_extraction_run SET status='done', finished_at=now()
                       WHERE id=%s""",
                    (run_id,),
                )
                return "discarded"
            if row["run_status"] not in {"queued", "running"}:
                raise _Abort
            conn.execute("UPDATE lens_extraction_run SET status='running' WHERE id=%s", (run_id,))
            return "running"
    except _Abort:
        return "lost"


def persist_lens_extraction(
    conn, *, job_id, worker_id, meeting_id, processing_version, run_id, candidates
) -> str:
    """Validate and merge candidates atomically under job/run/version ownership guards."""
    try:
        with conn.transaction():
            row = conn.execute(
                """
                SELECT r.status AS run_status, m.processing_version
                FROM job j
                JOIN lens_extraction_run r ON r.job_id=j.id
                JOIN meeting m ON m.id=r.meeting_id
                WHERE j.id=%s AND j.locked_by=%s AND j.status='running'
                  AND j.meeting_id=%s AND r.id=%s AND r.meeting_id=%s
                  AND r.processing_version=%s
                FOR UPDATE OF j, r, m
                """,
                (job_id, worker_id, meeting_id, run_id, meeting_id, processing_version),
            ).fetchone()
            if row is None:
                raise _Abort
            if row["processing_version"] != processing_version:
                error = _lens_stale_error()
                conn.execute(
                    "UPDATE job SET status='done', error=%s, updated_at=now() WHERE id=%s",
                    (Jsonb(error), job_id),
                )
                conn.execute(
                    "UPDATE lens_extraction_run SET status='done', finished_at=now() WHERE id=%s",
                    (run_id,),
                )
                return "discarded"
            if row["run_status"] != "running":
                raise _Abort

            # Validate all references before changing a lens row.  A malformed response
            # therefore cannot leave earlier candidates committed.
            for candidate in candidates:
                utterance_ids = {
                    candidate.primary_utterance_id,
                    *candidate.supporting_utterance_ids,
                }
                for utterance_id in utterance_ids:
                    valid = conn.execute(
                        """SELECT 1 FROM utterance WHERE id=%s AND meeting_id=%s
                           AND processing_version=%s AND status='ok'""",
                        (utterance_id, meeting_id, processing_version),
                    ).fetchone()
                    if valid is None:
                        from .errors import ErrorKind, WorkerError

                        raise WorkerError(
                            "invalid_lens_candidate",
                            (
                                f"utterance {utterance_id} is not an ok utterance "
                                "for this meeting version"
                            ),
                            ErrorKind.PERMANENT,
                            stage="extract_lenses",
                        )
                if candidate.assignee_speaker_id is not None:
                    member = conn.execute(
                        """SELECT 1 FROM utterance WHERE meeting_id=%s AND speaker_id=%s
                           AND processing_version=%s""",
                        (meeting_id, candidate.assignee_speaker_id, processing_version),
                    ).fetchone()
                    if member is None:
                        from .errors import ErrorKind, WorkerError

                        raise WorkerError(
                            "invalid_lens_candidate",
                            "assignee_speaker_id has no utterance in this meeting version",
                            ErrorKind.PERMANENT,
                            stage="extract_lenses",
                        )

            existing = conn.execute(
                """
                SELECT li.id, li.kind,
                       (SELECT utterance_id FROM lens_evidence
                        WHERE lens_item_id=li.id AND relation='primary') AS primary_utterance_id
                FROM lens_item li
                WHERE li.meeting_id=%s AND li.source='ai' AND NOT li.user_modified
                  AND li.lifecycle_status='active' AND li.completion_status='open'
                ORDER BY li.id
                FOR UPDATE
                """,
                (meeting_id,),
            ).fetchall()
            by_key = {(item["kind"], item["primary_utterance_id"]): item for item in existing}
            matched = set()
            for candidate in candidates:
                item = by_key.get((candidate.kind, candidate.primary_utterance_id))
                if item is not None and item["id"] not in matched:
                    lens_id = item["id"]
                    matched.add(lens_id)
                    conn.execute(
                        """UPDATE lens_item SET kind=%s, text=%s, assignee_speaker_id=%s,
                           due_at=%s, updated_at=now() WHERE id=%s""",
                        (
                            candidate.kind,
                            candidate.text,
                            candidate.assignee_speaker_id,
                            candidate.due_at,
                            lens_id,
                        ),
                    )
                    conn.execute("DELETE FROM lens_evidence WHERE lens_item_id=%s", (lens_id,))
                else:
                    lens_id = conn.execute(
                        """INSERT INTO lens_item(
                               meeting_id, kind, text, source, assignee_speaker_id, due_at
                           )
                           VALUES (%s,%s,%s,'ai',%s,%s) RETURNING id""",
                        (
                            meeting_id,
                            candidate.kind,
                            candidate.text,
                            candidate.assignee_speaker_id,
                            candidate.due_at,
                        ),
                    ).fetchone()["id"]
                conn.execute(
                    """INSERT INTO lens_evidence(lens_item_id, utterance_id, relation)
                       VALUES (%s,%s,'primary')""",
                    (lens_id, candidate.primary_utterance_id),
                )
                seen = {candidate.primary_utterance_id}
                for utterance_id in candidate.supporting_utterance_ids:
                    if utterance_id not in seen:
                        seen.add(utterance_id)
                        conn.execute(
                            """INSERT INTO lens_evidence(lens_item_id, utterance_id, relation)
                               VALUES (%s,%s,'supporting')""",
                            (lens_id, utterance_id),
                        )
            for item in existing:
                if item["id"] not in matched:
                    conn.execute(
                        """UPDATE lens_item SET lifecycle_status='archived', updated_at=now()
                           WHERE id=%s""",
                        (item["id"],),
                    )
            conn.execute(
                """UPDATE lens_extraction_run
                   SET status='done', error=NULL, finished_at=now() WHERE id=%s""",
                (run_id,),
            )
            conn.execute(
                """UPDATE job SET status='done', progress=100, error=NULL,
                   updated_at=now() WHERE id=%s""",
                (job_id,),
            )
            return "committed"
    except _Abort:
        return "lost"


def fail_lens_extraction(
    conn, job_id: str, worker_id: str, run_id: str, processing_version: int, error: dict
) -> str:
    """Finish an extraction failure, discarding it when its meeting version is stale."""
    try:
        with conn.transaction():
            row = conn.execute(
                """SELECT m.processing_version
                   FROM job j
                   JOIN lens_extraction_run r ON r.job_id=j.id
                   JOIN meeting m ON m.id=r.meeting_id
                   WHERE j.id=%s AND j.locked_by=%s AND j.status='running'
                     AND r.id=%s AND r.processing_version=%s
                   FOR UPDATE OF j, r, m""",
                (job_id, worker_id, run_id, processing_version),
            ).fetchone()
            if row is None:
                raise _Abort
            if row["processing_version"] != processing_version:
                stale_error = _lens_stale_error()
                conn.execute(
                    "UPDATE job SET status='done', error=%s, updated_at=now() WHERE id=%s",
                    (Jsonb(stale_error), job_id),
                )
                conn.execute(
                    """UPDATE lens_extraction_run
                       SET status='done', error=%s, finished_at=now() WHERE id=%s""",
                    (Jsonb(stale_error), run_id),
                )
                return "discarded"
            conn.execute(
                "UPDATE job SET status='failed', error=%s, updated_at=now() WHERE id=%s",
                (Jsonb(error), job_id),
            )
            conn.execute(
                """UPDATE lens_extraction_run SET status='failed', error=%s, finished_at=now()
                   WHERE id=%s""",
                (Jsonb(error), run_id),
            )
        return "failed"
    except _Abort:
        return "lost"


def persist_enroll(
    conn,
    *,
    job_id,
    worker_id,
    speaker_id,
    embedding,
    model,
    dimension,
    sample_duration_ms,
    quality_score,
) -> str:
    try:
        with conn.transaction():
            owned = conn.execute(
                "SELECT 1 FROM job WHERE id=%s AND locked_by=%s AND status='running' FOR UPDATE",
                (job_id, worker_id),
            ).fetchone()
            if owned is None:
                raise _Abort
            cur = conn.execute(
                """
                UPDATE speaker SET enrollment_status='ready', enrollment_error=NULL
                WHERE id=%s AND current_job_id=%s
                """,
                (speaker_id, job_id),
            )
            if cur.rowcount == 0:
                raise _Abort  # speaker superseded by a newer enroll job
            conn.execute(
                """
                INSERT INTO voiceprint(speaker_id, embedding, model, dimension,
                    sample_duration_ms, quality_score, source)
                VALUES (%s,%s::vector,%s,%s,%s,%s,'enroll')
                """,
                (speaker_id, _vec(embedding), model, dimension, sample_duration_ms, quality_score),
            )
            conn.execute(
                "UPDATE job SET status='done', progress=100, updated_at=now() WHERE id=%s",
                (job_id,),
            )
            return "committed"
    except _Abort:
        return "lost"


def peek_queued(conn) -> bool:
    """큐에 처리 대기 job이 있는지 읽기 전용 확인. 어떤 행도 claim하지 않는다."""
    return conn.execute("SELECT 1 FROM job WHERE status='queued' LIMIT 1").fetchone() is not None
