"""process_meeting 결과 영속화와 실패 마킹.

`persist_process_meeting`이 이 패키지에서 가장 큰 함수다 — utterance·meeting_cluster·
voiceprint를 한 트랜잭션에 쓰고, job 가드와 meeting 가드를 둘 다 적용한다.
"""

from psycopg.types.json import Jsonb

from .core import _Abort, _vec


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
    lens_llm_model=None,
    summary_llm_model=None,
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

            # Fresh results are versioned.  Keep prior utterances intact: lens evidence
            # may point to them and the API/search paths select only the current version.
            conn.execute("DELETE FROM meeting_cluster WHERE meeting_id=%s", (meeting_id,))

            # Every diarization label gets a cluster row — it is the meeting's
            # diar_label→speaker record, the entry point for a user correction, and
            # where a near-miss suggestion is parked. A label identify already bound
            # keeps that speaker; an unbound one mints a provisional speaker plus a
            # voiceprint carrying its provenance. Without an embedding model there is
            # no voiceprint to insert, so such a label stays unresolved.
            label_to_new_speaker: dict[str, str] = {}
            for c in clusters:
                centroid = c["centroid"]
                bound = c["resolved_speaker_id"]
                suggested = c.get("suggested_speaker_id")
                similarity = c.get("suggested_similarity")
                if bound is not None or centroid is None or embedding_model is None:
                    # Bound outright, or not comparable at all — either way nothing is
                    # minted here, and a binding leaves no near-miss to record.
                    conn.execute(
                        """
                        INSERT INTO meeting_cluster(meeting_id, diar_label, centroid,
                            resolved_speaker_id, suggested_speaker_id, suggested_similarity,
                            processing_version, job_id)
                        VALUES (%s,%s,%s::vector,%s,%s,%s,%s,%s)
                        """,
                        (
                            meeting_id,
                            c["diar_label"],
                            _vec(centroid) if centroid is not None else None,
                            bound,
                            None if bound is not None else suggested,
                            None if bound is not None else similarity,
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
                        resolved_speaker_id, suggested_speaker_id, suggested_similarity,
                        processing_version, job_id)
                    VALUES (%s,%s,%s::vector,%s,%s,%s,%s,%s)
                    RETURNING id
                    """,
                    (
                        meeting_id,
                        c["diar_label"],
                        _vec(centroid),
                        sid,
                        suggested,
                        similarity,
                        processing_version,
                        job_id,
                    ),
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
            # A pending suggestion counts as a reference: deleting its target would
            # silently void a merge the user has not answered yet (and the FK's
            # ON DELETE SET NULL would strand the score behind a null id).
            conn.execute(
                """
                DELETE FROM speaker s
                WHERE s.enrollment_status='provisional'
                  AND NOT EXISTS (SELECT 1 FROM utterance WHERE speaker_id = s.id)
                  AND NOT EXISTS (SELECT 1 FROM meeting_cluster WHERE resolved_speaker_id = s.id)
                  AND NOT EXISTS (SELECT 1 FROM meeting_cluster WHERE suggested_speaker_id = s.id)
                """
            )
            # 라이브 미리보기 행은 정본이 들어오는 이 순간 역할이 끝난다 (설계 §2.4).
            conn.execute("DELETE FROM live_utterance WHERE meeting_id=%s", (meeting_id,))
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
            if lens_llm_model is not None:
                run_id = conn.execute(
                    """
                    INSERT INTO lens_extraction_run(meeting_id, processing_version, status, model)
                    VALUES (%s, %s, 'queued', %s)
                    RETURNING id
                    """,
                    (meeting_id, processing_version, lens_llm_model),
                ).fetchone()["id"]
                extraction_job_id = conn.execute(
                    """
                    INSERT INTO job(type, meeting_id, payload)
                    VALUES ('extract_lenses', %s, %s)
                    RETURNING id
                    """,
                    (
                        meeting_id,
                        Jsonb(
                            {
                                "schema_version": 1,
                                "meeting_id": str(meeting_id),
                                "processing_version": processing_version,
                                "extraction_run_id": str(run_id),
                                "model": lens_llm_model,
                            }
                        ),
                    ),
                ).fetchone()["id"]
                conn.execute(
                    "UPDATE lens_extraction_run SET job_id=%s WHERE id=%s",
                    (extraction_job_id, run_id),
                )
            if summary_llm_model is not None:
                summary_job_id = conn.execute(
                    """
                    INSERT INTO job(type, meeting_id, payload)
                    VALUES ('summarize_meeting', %s, %s)
                    RETURNING id
                    """,
                    (
                        meeting_id,
                        Jsonb(
                            {
                                "schema_version": 1,
                                "meeting_id": str(meeting_id),
                                "processing_version": processing_version,
                                "model": summary_llm_model,
                            }
                        ),
                    ),
                ).fetchone()["id"]
                conn.execute(
                    """
                    INSERT INTO meeting_summary(meeting_id, processing_version, job_id,
                                                model, status)
                    VALUES (%s, %s, %s, %s, 'queued')
                    ON CONFLICT (meeting_id) DO UPDATE
                    SET processing_version=EXCLUDED.processing_version,
                        job_id=EXCLUDED.job_id, model=EXCLUDED.model, status='queued',
                        topics='[]'::jsonb, segments='[]'::jsonb, error=NULL,
                        updated_at=now()
                    """,
                    (meeting_id, processing_version, summary_job_id, summary_llm_model),
                )
            return "committed"
    except _Abort:
        return "lost"
