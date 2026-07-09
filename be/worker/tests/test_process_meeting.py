from damwha_worker import db
from damwha_worker.contracts import ProcessMeetingPayload
from damwha_worker.models.base import DiarSegment, SpeechSpan, Word
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
    # SPEAKER_01 now gets an auto-created provisional speaker (not None)
    prov = conn.execute(
        "SELECT id, name, enrollment_status FROM speaker WHERE enrollment_status='provisional'", ()
    ).fetchone()
    assert prov is not None and prov["name"].startswith("Speaker_")
    assert utts[1]["speaker_id"] == prov["id"]
    # its cluster + auto_cluster voiceprint exist
    cl = conn.execute(
        "SELECT diar_label, resolved_speaker_id FROM meeting_cluster WHERE meeting_id=%s", (mid,)
    ).fetchall()
    assert [c["diar_label"] for c in cl] == ["SPEAKER_01"]
    assert cl[0]["resolved_speaker_id"] == prov["id"]
    vp = conn.execute("SELECT source FROM voiceprint WHERE speaker_id=%s", (prov["id"],)).fetchone()
    assert vp["source"] == "auto_cluster"
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


def test_all_short_cluster_preserved_without_provisional_speaker(conn, tmp_path):
    # 전부 100ms 미만인 클러스터: cluster row는 centroid 없이 보존되고,
    # provisional speaker / zero voiceprint는 생성되지 않는다
    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    models = Models(
        vad=FakeVAD([]),
        diarizer=FakeDiarizer([DiarSegment("SPEAKER_00", 0, 50)]),
        embedder=FakeEmbedder([None]),  # <100ms → 임베딩 없음
        transcriber=FakeTranscriber([Word("짧다", 0, 40, 0.9)]),
    )
    out = run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(mid, "meetings/m/original.m4a"),
        models,
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(50),
    )
    assert out == "committed"
    cl = conn.execute(
        "SELECT centroid, resolved_speaker_id FROM meeting_cluster WHERE meeting_id=%s", (mid,)
    ).fetchall()
    assert len(cl) == 1
    assert cl[0]["centroid"] is None and cl[0]["resolved_speaker_id"] is None
    assert conn.execute("SELECT count(*) AS c FROM speaker", ()).fetchone()["c"] == 0
    assert conn.execute("SELECT count(*) AS c FROM voiceprint", ()).fetchone()["c"] == 0
    utt = conn.execute(
        "SELECT speaker_id, text FROM utterance WHERE meeting_id=%s", (mid,)
    ).fetchone()
    assert utt["speaker_id"] is None and utt["text"] == "짧다"


def test_run_process_meeting_uses_custom_prefix(conn, tmp_path):
    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
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
        default_speaker_prefix="화자",
    )
    names = [r["name"] for r in conn.execute("SELECT name FROM speaker", ()).fetchall()]
    assert names and all(n.startswith("화자_") for n in names)


def test_partial_stt_failure_marks_transcribe_failed_per_segment(conn, tmp_path):
    # words가 비어있지 않아도(부분 STT 실패) VAD speech와 겹치는 무발화 세그먼트는
    # silence가 아니라 transcribe_failed여야 한다. 수정 전 코드는 words가 있으면
    # failed_spans를 아예 전달하지 않아 SPEAKER_01이 silence로 위장된다.
    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    models = Models(
        vad=FakeVAD([SpeechSpan(1100, 1900)]),  # SPEAKER_01 구간에서 speech 감지
        diarizer=FakeDiarizer(
            [
                DiarSegment("SPEAKER_00", 0, 1000),
                DiarSegment("SPEAKER_01", 1000, 2000),
                DiarSegment("SPEAKER_02", 2000, 3000),
            ]
        ),
        embedder=FakeEmbedder(
            [
                [1.0] + [0.0] * 191,
                [0.0, 1.0] + [0.0] * 190,
                [0.0, 0.0, 1.0] + [0.0] * 189,
            ]
        ),
        transcriber=FakeTranscriber([Word("안녕", 0, 500, 0.9)]),  # words 비어있지 않음
    )
    out = run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(mid, "meetings/m/original.m4a"),
        models,
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(3000),
    )
    assert out == "committed"
    rows = conn.execute(
        "SELECT diar_label, status FROM utterance WHERE meeting_id=%s ORDER BY order_index",
        (mid,),
    ).fetchall()
    by_label = {r["diar_label"]: r["status"] for r in rows}
    assert by_label["SPEAKER_00"] == "ok"
    assert by_label["SPEAKER_01"] == "transcribe_failed"  # 수정 전: "silence"
    assert by_label["SPEAKER_02"] == "silence"
