from damwha_worker import db
from damwha_worker.contracts import ProcessMeetingPayload
from damwha_worker.models.base import DiarSegment, Word
from damwha_worker.pipeline.ffmpeg import ProbeResult
from damwha_worker.pipeline.process_meeting import Models, run_process_meeting
from damwha_worker.storage import Storage
from tests.conftest import seed_job, seed_meeting, seed_speaker, seed_voiceprint
from tests.fakes import FakeDiarizer, FakeEmbedder, FakeTranscriber, FakeVAD


def _payload(meeting_id, audio_key, pv=0, threshold=0.7):
    return ProcessMeetingPayload.model_validate(
        {
            "schema_version": 1,
            "meeting_id": str(meeting_id),
            "audio_key": audio_key,
            "processing_version": pv,
            "reprocess": pv > 0,
            "models": {
                "whisper_model": "large-v3-turbo",
                "device": "cpu",
                "language": "ko",
                "diarization": {"model": "d", "min_speakers": None, "max_speakers": None},
                "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
            },
            "identify": {"threshold": threshold},
        }
    )


def _models():
    return Models(
        vad=FakeVAD([]),
        diarizer=FakeDiarizer(
            [DiarSegment("SPEAKER_00", 0, 1000), DiarSegment("SPEAKER_01", 1000, 2000)]
        ),
        embedder=FakeEmbedder([[1.0] + [0.0] * 191, [0.0, 1.0] + [0.0] * 190]),
        transcriber=FakeTranscriber([Word("안녕", 0, 500, 0.9), Word("반가워", 1100, 1500, 0.8)]),
    )


def test_full_pipeline_with_identification(conn, tmp_path):
    # known speaker matches SPEAKER_00's centroid direction
    sid = seed_speaker(conn, enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0] + [0.0] * 191)

    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")

    storage = Storage(str(tmp_path))
    out = run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(mid, "meetings/m/original.m4a"),
        _models(),
        storage,
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(2000),
    )
    assert out == "committed"
    utts = conn.execute(
        "SELECT diar_label, speaker_id, text FROM utterance "
        "WHERE meeting_id=%s ORDER BY order_index",
        (mid,),
    ).fetchall()
    assert utts[0]["diar_label"] == "SPEAKER_00" and utts[0]["speaker_id"] == sid
    assert utts[1]["speaker_id"] is None  # SPEAKER_01 unidentified
    # only the unidentified label is preserved as a cluster
    clusters = conn.execute(
        "SELECT diar_label FROM meeting_cluster WHERE meeting_id=%s", (mid,)
    ).fetchall()
    assert [c["diar_label"] for c in clusters] == ["SPEAKER_01"]
    assert (
        conn.execute("SELECT duration_ms FROM meeting WHERE id=%s", (mid,)).fetchone()[
            "duration_ms"
        ]
        == 2000
    )


def test_stage_logs_emitted_with_counts(conn, tmp_path, caplog):
    mid = seed_meeting(conn, status="processing", audio_key="meetings/m/original.m4a")
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    with caplog.at_level("INFO", logger="damwha_worker"):
        run_process_meeting(
            conn,
            conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
            _payload(mid, "meetings/m/original.m4a"),
            _models(),
            Storage(str(tmp_path)),
            worker_id="w1",
            normalize_fn=lambda s, d: None,
            probe_fn=lambda p: ProbeResult(2000),
        )
    msgs = [r.getMessage() for r in caplog.records]
    text = "\n".join(msgs)
    # every stage logs a timed "done" line with elapsed_ms
    for stage in ("normalize", "vad", "diarize", "embed", "identify", "stt", "align", "persist"):
        assert any(f"stage={stage} done elapsed_ms=" in m for m in msgs), stage
    # counts (not content) are surfaced; start/total bracket the run
    assert "process_meeting start" in text
    assert "segments=2" in text and "words=2" in text and "utterances=2" in text
    assert "process_meeting done outcome=committed total_ms=" in text


def test_stage_progress_recorded(conn, tmp_path):
    mid = seed_meeting(conn, status="processing", audio_key="meetings/m/original.m4a")
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(mid, "meetings/m/original.m4a"),
        _models(),
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(2000),
    )
    assert (
        conn.execute("SELECT stage FROM job WHERE id=%s", (jid,)).fetchone()["stage"] == "persist"
    )
