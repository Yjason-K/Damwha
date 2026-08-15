import threading

import pytest

from damwha_worker import db
from damwha_worker.contracts import parse_payload
from damwha_worker.errors import ShutdownRequested
from damwha_worker.models.base import DiarSegment, SpeechSpan, Word
from damwha_worker.pipeline.ffmpeg import ProbeResult
from damwha_worker.pipeline.process_meeting import Models, run_process_meeting
from damwha_worker.storage import Storage
from tests.conftest import seed_job, seed_meeting, seed_speaker, seed_voiceprint
from tests.fakes import FakeDiarizer, FakeEmbedder, FakeTranscriber, FakeVAD


def _payload(meeting_id, audio_key, pv=0, threshold=0.7):
    return parse_payload(
        "process_meeting",
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
        },
    )


def _models():
    return Models(
        vad=FakeVAD([SpeechSpan(0, 2000)]),
        diarizer=FakeDiarizer(
            [DiarSegment("SPEAKER_00", 0, 1000), DiarSegment("SPEAKER_01", 1000, 2000)]
        ),
        embedder=FakeEmbedder([[1.0] + [0.0] * 191, [0.0, 1.0] + [0.0] * 190]),
        transcriber=FakeTranscriber([Word("안녕", 0, 500, 0.9), Word("반가워", 1100, 1500, 0.8)]),
    )


def _payload_v3(meeting_id, audio_key, summary_model, pv=0, threshold=0.7):
    return parse_payload(
        "process_meeting",
        {
            "schema_version": 3,
            "meeting_id": str(meeting_id),
            "audio_key": audio_key,
            "processing_version": pv,
            "reprocess": pv > 0,
            "models": {
                "whisper_model": "large-v3-turbo",
                "language": "ko",
                "devices": {"diarization": "cpu", "stt": "cpu"},
                "preset": "standard",
                "preset_revision": "2026-08-12.1",
                "summary_model": summary_model,
                "diarization": {"model": "d", "min_speakers": None, "max_speakers": None},
                "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
            },
            "identify": {"threshold": threshold},
        },
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
    # EVERY label gets a cluster row — including the one identify bound outright.
    # The table is the meeting's diar_label→speaker record and the entry point for
    # a user correction, so an auto-linked label must not be invisible in it.
    cl = {
        c["diar_label"]: c
        for c in conn.execute(
            "SELECT diar_label, resolved_speaker_id, suggested_speaker_id "
            "FROM meeting_cluster WHERE meeting_id=%s",
            (mid,),
        ).fetchall()
    }
    assert sorted(cl) == ["SPEAKER_00", "SPEAKER_01"]
    assert cl["SPEAKER_00"]["resolved_speaker_id"] == sid
    assert cl["SPEAKER_01"]["resolved_speaker_id"] == prov["id"]
    # A bound cluster has nothing pending, and only minted speakers get a voiceprint.
    assert cl["SPEAKER_00"]["suggested_speaker_id"] is None
    vps = conn.execute(
        "SELECT speaker_id, source FROM voiceprint WHERE source='auto_cluster'"
    ).fetchall()
    assert [v["speaker_id"] for v in vps] == [prov["id"]]
    assert (
        conn.execute("SELECT duration_ms FROM meeting WHERE id=%s", (mid,)).fetchone()[
            "duration_ms"
        ]
        == 2000
    )


def _payload_v4(meeting_id, audio_key, *, threshold, suggest_threshold, pv=0):
    return parse_payload(
        "process_meeting",
        {
            "schema_version": 4,
            "meeting_id": str(meeting_id),
            "audio_key": audio_key,
            "processing_version": pv,
            "reprocess": pv > 0,
            "models": {
                "whisper_model": "large-v3-turbo",
                "language": "ko",
                "devices": {"diarization": "cpu", "stt": "cpu"},
                "preset": "standard",
                "preset_revision": "2026-08-12.1",
                "summary_model": "mlx-community/Qwen3.5-4B-8bit",
                "diarization": {"model": "d", "min_speakers": None, "max_speakers": None},
                "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
            },
            "identify": {"threshold": threshold, "suggest_threshold": suggest_threshold},
        },
    )


def test_band_match_mints_its_own_speaker_and_records_the_candidate(conn, tmp_path):
    # SPEAKER_00's centroid sits at cos≈0.707 from the known speaker: too close to
    # call. It must still get its own provisional speaker (so its utterances are
    # attributed) while the near-miss is parked for the user to confirm.
    known = seed_speaker(conn, enrollment_status="provisional")
    seed_voiceprint(conn, speaker_id=known, embedding=[1.0, 1.0] + [0.0] * 190)

    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")

    out = run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload_v4(mid, "meetings/m/original.m4a", threshold=0.9, suggest_threshold=0.5),
        _models(),
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(2000),
    )
    assert out == "committed"

    cl = {
        c["diar_label"]: c
        for c in conn.execute(
            "SELECT diar_label, resolved_speaker_id, suggested_speaker_id, suggested_similarity "
            "FROM meeting_cluster WHERE meeting_id=%s",
            (mid,),
        ).fetchall()
    }
    row = cl["SPEAKER_00"]
    assert row["suggested_speaker_id"] == known
    assert row["suggested_similarity"] == pytest.approx(0.7071, abs=1e-3)
    # Its own speaker, not the suggested one — a suggestion never binds.
    assert row["resolved_speaker_id"] not in (None, known)


def test_pre_v4_payload_records_no_suggestion(conn, tmp_path):
    known = seed_speaker(conn, enrollment_status="provisional")
    seed_voiceprint(conn, speaker_id=known, embedding=[1.0, 1.0] + [0.0] * 190)

    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")

    run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(mid, "meetings/m/original.m4a", threshold=0.9),  # v1 — no band
        _models(),
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(2000),
    )
    suggested = conn.execute(
        "SELECT count(*) AS n FROM meeting_cluster "
        "WHERE meeting_id=%s AND suggested_speaker_id IS NOT NULL",
        (mid,),
    ).fetchone()["n"]
    assert suggested == 0


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
    # 신규 STT 관측 지표 — FakeVAD (0,2000) → pad/clamp 후 (0,2000) 1개
    assert "words=2 spans=1 clipped_ms=2000 duration_ms=2000" in text
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
        vad=FakeVAD([SpeechSpan(0, 40)]),
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


def test_shutdown_before_normalize_raises_without_side_effects(conn, tmp_path):
    # shutdown 확인은 mark_processing/normalize보다 먼저 — 아무 부작용 없이 반납된다
    mid = seed_meeting(
        conn, status="uploaded", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    ev = threading.Event()
    ev.set()
    normalize_calls = []
    with pytest.raises(ShutdownRequested):
        run_process_meeting(
            conn,
            conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
            _payload(mid, "meetings/m/original.m4a"),
            _models(),
            Storage(str(tmp_path)),
            worker_id="w1",
            normalize_fn=lambda s, d: normalize_calls.append(1),
            probe_fn=lambda p: ProbeResult(2000),
            shutdown_event=ev,
        )
    assert normalize_calls == []  # ffmpeg 미실행
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "uploaded"  # mark_processing 미도달
    )


def test_stt_receives_prepared_spans(conn, tmp_path):
    # VAD (100,900),(1000,1600) → pad 200 → (0,1100),(800,1800) → 병합 (0,1800)
    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    models = Models(
        vad=FakeVAD([SpeechSpan(100, 900), SpeechSpan(1000, 1600)]),
        diarizer=FakeDiarizer(
            [DiarSegment("SPEAKER_00", 0, 1000), DiarSegment("SPEAKER_01", 1000, 2000)]
        ),
        embedder=FakeEmbedder([[1.0] + [0.0] * 191, [0.0, 1.0] + [0.0] * 190]),
        transcriber=FakeTranscriber([Word("안녕", 0, 500, 0.9), Word("반가워", 1100, 1500, 0.8)]),
    )
    out = run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(mid, "meetings/m/original.m4a"),
        models,
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(2000),
    )
    assert out == "committed"
    assert models.transcriber.calls == 1
    assert models.transcriber.received_spans == [SpeechSpan(0, 1800)]


def test_empty_vad_skips_stt_and_yields_silence(conn, tmp_path):
    # VAD 0개 → transcriber 호출 생략, failed_spans=[]이므로 전 세그먼트 silence
    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    models = Models(
        vad=FakeVAD([]),
        diarizer=FakeDiarizer(
            [DiarSegment("SPEAKER_00", 0, 1000), DiarSegment("SPEAKER_01", 1000, 2000)]
        ),
        embedder=FakeEmbedder([[1.0] + [0.0] * 191, [0.0, 1.0] + [0.0] * 190]),
        transcriber=FakeTranscriber([Word("환각", 0, 500, 0.9)]),  # 호출되면 안 됨
    )
    out = run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(mid, "meetings/m/original.m4a"),
        models,
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(2000),
    )
    assert out == "committed"
    assert models.transcriber.calls == 0
    rows = conn.execute(
        "SELECT status, text FROM utterance WHERE meeting_id=%s ORDER BY order_index", (mid,)
    ).fetchall()
    assert len(rows) == 2
    assert all(r["status"] == "silence" and r["text"] is None for r in rows)


def test_v3_payload_summary_model_wins_over_worker_env(conn, tmp_path):
    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")

    out = run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload_v3(mid, "meetings/m/original.m4a", "mlx-community/Qwen3.5-27B-8bit"),
        _models(),
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(2000),
        summary_llm_model="worker-env-model",
    )
    assert out == "committed"
    row = conn.execute("SELECT model FROM meeting_summary WHERE meeting_id=%s", (mid,)).fetchone()
    assert row["model"] == "mlx-community/Qwen3.5-27B-8bit"


def test_v1_payload_falls_back_to_worker_env_summary_model(conn, tmp_path):
    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")

    out = run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(mid, "meetings/m/original.m4a"),  # v1 — summary_model 없음
        _models(),
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(2000),
        summary_llm_model="worker-env-model",
    )
    assert out == "committed"
    row = conn.execute("SELECT model FROM meeting_summary WHERE meeting_id=%s", (mid,)).fetchone()
    assert row["model"] == "worker-env-model"


def test_stt_progress_logged_and_written_between_stage_bounds(conn, tmp_path, caplog, monkeypatch):
    # 전사 중간 보고가 콘솔 로그 + job.progress(75→90 구간) 양쪽에 나타나야 한다
    mid = seed_meeting(conn, status="processing", audio_key="meetings/m/original.m4a")
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")

    stage_writes: list[tuple[str, int]] = []
    real_set_stage = db.set_stage

    def spy(conn_, job_id, worker_id, stage, progress):
        stage_writes.append((stage, progress))
        return real_set_stage(conn_, job_id, worker_id, stage, progress)

    monkeypatch.setattr(db, "set_stage", spy)

    models = _models()
    models.transcriber = FakeTranscriber(
        [Word("안녕", 0, 500, 0.9), Word("반가워", 1100, 1500, 0.8)],
        progress_steps=[(1_000, 2_000), (2_000, 2_000)],
    )
    with caplog.at_level("INFO", logger="damwha_worker"):
        run_process_meeting(
            conn,
            conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
            _payload(mid, "meetings/m/original.m4a"),
            models,
            Storage(str(tmp_path)),
            worker_id="w1",
            normalize_fn=lambda s, d: None,
            probe_fn=lambda p: ProbeResult(2000),
        )
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "stage=stt running units=1/1 audio_ms=1000/2000 pct=50" in text
    # stt 진입(75) 이후 중간 갱신이 75~90 사이로 기록된다
    assert ("stt", 82) in stage_writes
    assert ("stt", 90) in stage_writes
    assert stage_writes.index(("stt", 75)) < stage_writes.index(("stt", 82))


def test_stt_drives_a_console_progress_bar(conn, tmp_path, monkeypatch):
    # 전사 stage는 TTY 진행 바를 열고 clip마다 갱신한다(비TTY면 바 자체가 no-op)
    from contextlib import contextmanager

    from damwha_worker.pipeline import process_meeting as pm

    mid = seed_meeting(conn, status="processing", audio_key="meetings/m/original.m4a")
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")

    opened: list[str] = []
    updates: list[tuple[float, str]] = []

    class RecordingBar:
        def update(self, fraction, text=""):
            updates.append((fraction, text))

    @contextmanager
    def fake_progress_bar(label, **_kwargs):
        opened.append(label)
        yield RecordingBar()

    monkeypatch.setattr(pm.console, "progress_bar", fake_progress_bar)

    models = _models()
    models.transcriber = FakeTranscriber(
        [Word("안녕", 0, 500, 0.9)], progress_steps=[(1_000, 2_000), (2_000, 2_000)]
    )
    run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(mid, "meetings/m/original.m4a"),
        models,
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(2000),
    )
    assert opened == ["stt"]
    assert [f for f, _ in updates] == [0.5, 1.0]
