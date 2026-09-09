"""렌즈 추출 run의 running/영속/실패 전이.

실패가 job이 아니라 `lens_extraction_run`에 기록되는 게 다른 type과 다른 점이다.
"""

from psycopg.types.json import Jsonb

from .core import _Abort


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
                        from ..errors import ErrorKind, WorkerError

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
                        from ..errors import ErrorKind, WorkerError

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
