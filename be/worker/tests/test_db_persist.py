from damwha_worker import db
from tests.conftest import seed_job, seed_meeting, seed_speaker


def _claimed_pm_job(conn, *, pv=0):
    mid = seed_meeting(conn, processing_version=pv, status="processing")
    jid = seed_job(conn, meeting_id=mid)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    return mid, jid


def test_persist_commits_results(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    out = db.persist_process_meeting(
        conn,
        job_id=jid,
        worker_id="w1",
        meeting_id=mid,
        processing_version=0,
        normalized_key="meetings/x/normalized.wav",
        duration_ms=12345,
        utterances=[
            {
                "speaker_id": None,
                "diar_label": "SPEAKER_00",
                "start_ms": 0,
                "end_ms": 1000,
                "text": "안녕",
                "confidence": 0.9,
                "status": "ok",
                "transcript_error": None,
                "order_index": 0,
            },
        ],
        clusters=[
            {"diar_label": "SPEAKER_00", "centroid": [0.1] * 192, "resolved_speaker_id": None}
        ],
        embedding_model="speechbrain/spkrec-ecapa-voxceleb",
        embedding_dim=192,
    )
    assert out == "committed"
    m = conn.execute(
        "SELECT status, duration_ms, normalized_key FROM meeting WHERE id=%s", (mid,)
    ).fetchone()
    assert m["status"] == "done" and m["duration_ms"] == 12345
    assert (
        conn.execute("SELECT count(*) c FROM utterance WHERE meeting_id=%s", (mid,)).fetchone()["c"]
        == 1
    )
    assert (
        conn.execute(
            "SELECT count(*) c FROM meeting_cluster WHERE meeting_id=%s", (mid,)
        ).fetchone()["c"]
        == 1
    )
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "done"
    assert (
        conn.execute(
            "SELECT count(*) c FROM speaker WHERE enrollment_status='provisional'", ()
        ).fetchone()["c"]
        == 1
    )


def test_persist_replaces_existing_rows(conn):
    # Use two separate jobs simulating reprocess: first persists "a", second persists "b"
    mid = seed_meeting(conn, processing_version=0, status="processing")
    jid1 = seed_job(conn, meeting_id=mid)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid1, mid))
    db.claim(conn, "w1")
    db.persist_process_meeting(
        conn,
        job_id=jid1,
        worker_id="w1",
        meeting_id=mid,
        processing_version=0,
        normalized_key="k",
        duration_ms=1,
        utterances=[
            {
                "speaker_id": None,
                "diar_label": "S0",
                "start_ms": 0,
                "end_ms": 1,
                "text": "a",
                "confidence": None,
                "status": "ok",
                "transcript_error": None,
                "order_index": 0,
            }
        ],
        clusters=[],
    )
    # reprocess: bump pv, new job owns meeting
    jid2 = seed_job(conn, meeting_id=mid)
    conn.execute(
        "UPDATE meeting SET processing_version=1, current_job_id=%s, "
        "status='processing' WHERE id=%s",
        (jid2, mid),
    )
    conn.execute(
        "UPDATE job SET status='running', locked_by='w1', locked_at=now(), attempts=1 WHERE id=%s",
        (jid2,),
    )
    db.persist_process_meeting(
        conn,
        job_id=jid2,
        worker_id="w1",
        meeting_id=mid,
        processing_version=1,
        normalized_key="k",
        duration_ms=1,
        utterances=[
            {
                "speaker_id": None,
                "diar_label": "S0",
                "start_ms": 0,
                "end_ms": 1,
                "text": "b",
                "confidence": None,
                "status": "ok",
                "transcript_error": None,
                "order_index": 0,
            }
        ],
        clusters=[],
    )
    rows = conn.execute("SELECT text FROM utterance WHERE meeting_id=%s", (mid,)).fetchall()
    assert [r["text"] for r in rows] == ["b"]


def test_persist_discarded_when_meeting_superseded(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    # a newer reprocess bumped meeting to pv=1 + a different current_job_id
    # (must exist in job table due to FK)
    newer_jid = seed_job(conn, meeting_id=mid)
    conn.execute(
        "UPDATE meeting SET processing_version=1, current_job_id=%s WHERE id=%s", (newer_jid, mid)
    )
    out = db.persist_process_meeting(
        conn,
        job_id=jid,
        worker_id="w1",
        meeting_id=mid,
        processing_version=0,
        normalized_key="k",
        duration_ms=1,
        utterances=[],
        clusters=[],
    )
    assert out == "discarded"
    # meeting untouched (still pv=1), job done with discard reason
    j = conn.execute("SELECT status, error FROM job WHERE id=%s", (jid,)).fetchone()
    assert j["status"] == "done" and j["error"]["code"] == "discarded_by_stale_guard"
    assert (
        conn.execute("SELECT count(*) c FROM utterance WHERE meeting_id=%s", (mid,)).fetchone()["c"]
        == 0
    )


def test_persist_lost_when_not_owner(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    out = db.persist_process_meeting(
        conn,
        job_id=jid,
        worker_id="OTHER",
        meeting_id=mid,
        processing_version=0,
        normalized_key="k",
        duration_ms=1,
        utterances=[],
        clusters=[],
    )
    assert out == "lost"
    # nothing written; job still running, meeting not done
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "running"
    )
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "processing"
    )


def test_persist_enroll_sets_ready(conn):
    sid = seed_speaker(conn, enrollment_status="pending")
    jid = seed_job(conn, type="enroll_speaker", meeting_id=None)
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    db.claim(conn, "w1")
    out = db.persist_enroll(
        conn,
        job_id=jid,
        worker_id="w1",
        speaker_id=sid,
        embedding=[0.2] * 192,
        model="m",
        dimension=192,
        sample_duration_ms=3000,
        quality_score=0.8,
    )
    assert out == "committed"
    assert (
        conn.execute("SELECT enrollment_status FROM speaker WHERE id=%s", (sid,)).fetchone()[
            "enrollment_status"
        ]
        == "ready"
    )
    assert (
        conn.execute("SELECT count(*) c FROM voiceprint WHERE speaker_id=%s", (sid,)).fetchone()[
            "c"
        ]
        == 1
    )


def test_persist_enroll_lost_when_speaker_superseded(conn):
    sid = seed_speaker(conn, enrollment_status="pending")
    jid = seed_job(conn, type="enroll_speaker")
    # newer job owns speaker (must exist in job table due to FK)
    newer_jid = seed_job(conn, type="enroll_speaker")
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (newer_jid, sid))
    db.claim(conn, "w1")
    out = db.persist_enroll(
        conn,
        job_id=jid,
        worker_id="w1",
        speaker_id=sid,
        embedding=[0.2] * 192,
        model="m",
        dimension=192,
        sample_duration_ms=None,
        quality_score=None,
    )
    assert out == "lost"
    assert (
        conn.execute("SELECT count(*) c FROM voiceprint WHERE speaker_id=%s", (sid,)).fetchone()[
            "c"
        ]
        == 0
    )


def test_persist_enqueues_index_job_on_commit(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    out = db.persist_process_meeting(
        conn,
        job_id=jid,
        worker_id="w1",
        meeting_id=mid,
        processing_version=0,
        normalized_key="k",
        duration_ms=1,
        utterances=[],
        clusters=[],
        index_search_model="BAAI/bge-m3",
        index_search_dim=1024,
    )
    assert out == "committed"
    row = conn.execute(
        "SELECT type, meeting_id, payload FROM job WHERE type='index_meeting' AND meeting_id=%s",
        (mid,),
    ).fetchone()
    assert row is not None
    assert row["payload"]["processing_version"] == 0
    assert row["payload"]["search_embedding"] == {"model": "BAAI/bge-m3", "dimension": 1024}


def test_persist_no_index_job_when_discarded(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    newer = seed_job(conn, meeting_id=mid)
    conn.execute(
        "UPDATE meeting SET processing_version=1, current_job_id=%s WHERE id=%s", (newer, mid)
    )
    out = db.persist_process_meeting(
        conn,
        job_id=jid,
        worker_id="w1",
        meeting_id=mid,
        processing_version=0,
        normalized_key="k",
        duration_ms=1,
        utterances=[],
        clusters=[],
        index_search_model="BAAI/bge-m3",
        index_search_dim=1024,
    )
    assert out == "discarded"
    assert (
        conn.execute("SELECT count(*) c FROM job WHERE type='index_meeting'", ()).fetchone()["c"]
        == 0
    )


def test_persist_auto_creates_provisional_for_unidentified(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    out = db.persist_process_meeting(
        conn,
        job_id=jid,
        worker_id="w1",
        meeting_id=mid,
        processing_version=0,
        normalized_key="k",
        duration_ms=1,
        utterances=[
            {
                "speaker_id": None,
                "diar_label": "SPEAKER_00",
                "start_ms": 0,
                "end_ms": 1,
                "text": "a",
                "confidence": None,
                "status": "ok",
                "transcript_error": None,
                "order_index": 0,
            }
        ],
        clusters=[
            {"diar_label": "SPEAKER_00", "centroid": [0.1] * 192, "resolved_speaker_id": None}
        ],
        embedding_model="speechbrain/spkrec-ecapa-voxceleb",
        embedding_dim=192,
        default_speaker_prefix="Speaker",
    )
    assert out == "committed"
    sp = conn.execute("SELECT id, name, enrollment_status FROM speaker", ()).fetchall()
    assert len(sp) == 1
    assert sp[0]["enrollment_status"] == "provisional"
    assert sp[0]["name"].startswith("Speaker_")
    sid = sp[0]["id"]
    # cluster resolved to the new provisional speaker
    cl = conn.execute(
        "SELECT resolved_speaker_id FROM meeting_cluster WHERE meeting_id=%s", (mid,)
    ).fetchone()
    assert cl["resolved_speaker_id"] == sid
    # voiceprint with provenance
    vp = conn.execute(
        "SELECT speaker_id, source, source_cluster_id FROM voiceprint WHERE speaker_id=%s", (sid,)
    ).fetchone()
    assert vp["source"] == "auto_cluster" and vp["source_cluster_id"] is not None
    # utterance assigned to the provisional speaker
    u = conn.execute("SELECT speaker_id FROM utterance WHERE meeting_id=%s", (mid,)).fetchone()
    assert u["speaker_id"] == sid


def test_persist_centroidless_cluster_makes_no_speaker(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    out = db.persist_process_meeting(
        conn,
        job_id=jid,
        worker_id="w1",
        meeting_id=mid,
        processing_version=0,
        normalized_key="k",
        duration_ms=1,
        utterances=[
            {
                "speaker_id": None,
                "diar_label": "SPEAKER_00",
                "start_ms": 0,
                "end_ms": 1,
                "text": "a",
                "confidence": None,
                "status": "ok",
                "transcript_error": None,
                "order_index": 0,
            }
        ],
        clusters=[{"diar_label": "SPEAKER_00", "centroid": None, "resolved_speaker_id": None}],
        embedding_model="m",
        embedding_dim=192,
    )
    assert out == "committed"
    assert conn.execute("SELECT count(*) c FROM speaker", ()).fetchone()["c"] == 0
    assert conn.execute("SELECT count(*) c FROM voiceprint", ()).fetchone()["c"] == 0
    cl = conn.execute(
        "SELECT resolved_speaker_id FROM meeting_cluster WHERE meeting_id=%s", (mid,)
    ).fetchone()
    assert cl["resolved_speaker_id"] is None  # unresolved cluster kept
    u = conn.execute("SELECT speaker_id FROM utterance WHERE meeting_id=%s", (mid,)).fetchone()
    assert u["speaker_id"] is None


def _utt(label, oi=0):
    return {
        "speaker_id": None,
        "diar_label": label,
        "start_ms": 0,
        "end_ms": 1,
        "text": "x",
        "confidence": None,
        "status": "ok",
        "transcript_error": None,
        "order_index": oi,
    }


def test_reprocess_gcs_unconfirmed_provisional_orphan(conn):
    mid, jid1 = _claimed_pm_job(conn, pv=0)
    db.persist_process_meeting(
        conn,
        job_id=jid1,
        worker_id="w1",
        meeting_id=mid,
        processing_version=0,
        normalized_key="k",
        duration_ms=1,
        utterances=[_utt("S0")],
        clusters=[{"diar_label": "S0", "centroid": [0.1] * 192, "resolved_speaker_id": None}],
        embedding_model="m",
        embedding_dim=192,
    )
    prov1 = conn.execute("SELECT id FROM speaker").fetchone()["id"]
    # reprocess: pv=1, new running job owns the meeting
    jid2 = seed_job(conn, meeting_id=mid)
    conn.execute(
        "UPDATE meeting SET processing_version=1, current_job_id=%s, "
        "status='processing' WHERE id=%s",
        (jid2, mid),
    )
    conn.execute(
        "UPDATE job SET status='running', locked_by='w1', locked_at=now(), attempts=1 WHERE id=%s",
        (jid2,),
    )
    db.persist_process_meeting(
        conn,
        job_id=jid2,
        worker_id="w1",
        meeting_id=mid,
        processing_version=1,
        normalized_key="k",
        duration_ms=1,
        utterances=[_utt("S0")],
        clusters=[{"diar_label": "S0", "centroid": [0.2] * 192, "resolved_speaker_id": None}],
        embedding_model="m",
        embedding_dim=192,
    )
    rows = conn.execute("SELECT id FROM speaker").fetchall()
    assert len(rows) == 1 and rows[0]["id"] != prov1  # run-1 orphan GC'd
    vp = conn.execute("SELECT count(*) c FROM voiceprint").fetchone()["c"]
    assert vp == 1  # orphan voiceprint cascade-deleted


def test_reprocess_keeps_confirmed_ready_speaker(conn):
    mid, jid1 = _claimed_pm_job(conn, pv=0)
    db.persist_process_meeting(
        conn,
        job_id=jid1,
        worker_id="w1",
        meeting_id=mid,
        processing_version=0,
        normalized_key="k",
        duration_ms=1,
        utterances=[_utt("S0")],
        clusters=[{"diar_label": "S0", "centroid": [0.1] * 192, "resolved_speaker_id": None}],
        embedding_model="m",
        embedding_dim=192,
    )
    prov1 = conn.execute("SELECT id FROM speaker").fetchone()["id"]
    conn.execute(
        "UPDATE speaker SET enrollment_status='ready', name='김영재' WHERE id=%s", (prov1,)
    )
    # reprocess with a DIFFERENT label so prov1 ends unreferenced but is ready → must survive
    jid2 = seed_job(conn, meeting_id=mid)
    conn.execute(
        "UPDATE meeting SET processing_version=1, current_job_id=%s, "
        "status='processing' WHERE id=%s",
        (jid2, mid),
    )
    conn.execute(
        "UPDATE job SET status='running', locked_by='w1', locked_at=now(), attempts=1 WHERE id=%s",
        (jid2,),
    )
    db.persist_process_meeting(
        conn,
        job_id=jid2,
        worker_id="w1",
        meeting_id=mid,
        processing_version=1,
        normalized_key="k",
        duration_ms=1,
        utterances=[_utt("S1")],
        clusters=[{"diar_label": "S1", "centroid": [0.3] * 192, "resolved_speaker_id": None}],
        embedding_model="m",
        embedding_dim=192,
    )
    row = conn.execute("SELECT enrollment_status FROM speaker WHERE id=%s", (prov1,)).fetchone()
    assert row is not None and row["enrollment_status"] == "ready"  # ready never GC'd


def test_persist_names_are_unique_across_two_meetings(conn):
    names = []
    for _ in range(2):
        mid, jid = _claimed_pm_job(conn, pv=0)
        db.persist_process_meeting(
            conn,
            job_id=jid,
            worker_id="w1",
            meeting_id=mid,
            processing_version=0,
            normalized_key="k",
            duration_ms=1,
            utterances=[],
            clusters=[{"diar_label": "S0", "centroid": [0.1] * 192, "resolved_speaker_id": None}],
            embedding_model="m",
            embedding_dim=192,
        )
    rows = conn.execute("SELECT name FROM speaker ORDER BY name", ()).fetchall()
    names = [r["name"] for r in rows]
    assert len(names) == 2 and len(set(names)) == 2  # unique
    import re

    assert all(re.fullmatch(r"Speaker_\d{3,}", n) for n in names)
