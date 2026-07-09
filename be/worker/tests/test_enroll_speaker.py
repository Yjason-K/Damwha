import pytest

from damwha_worker import db
from damwha_worker.__main__ import handle_job
from damwha_worker.contracts import EnrollSpeakerPayload
from damwha_worker.errors import ErrorKind, WorkerError
from damwha_worker.pipeline.enroll_speaker import run_enroll_speaker
from damwha_worker.pipeline.ffmpeg import ProbeResult
from damwha_worker.storage import Storage
from tests.conftest import seed_job, seed_speaker
from tests.fakes import FakeEmbedder


def _payload(speaker_id, audio_key):
    return EnrollSpeakerPayload.model_validate(
        {
            "schema_version": 1,
            "speaker_id": str(speaker_id),
            "audio_key": audio_key,
            "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
        }
    )


def test_enroll_sets_ready_and_writes_voiceprint(conn, tmp_path):
    sid = seed_speaker(conn, enrollment_status="pending")
    jid = seed_job(conn, type="enroll_speaker", payload={})
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    db.claim(conn, "w1")
    out = run_enroll_speaker(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(sid, "speakers/s/sample.wav"),
        FakeEmbedder([[0.3] * 192]),
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(3000),
    )
    assert out == "committed"
    assert (
        conn.execute("SELECT enrollment_status FROM speaker WHERE id=%s", (sid,)).fetchone()[
            "enrollment_status"
        ]
        == "ready"
    )
    vp = conn.execute(
        "SELECT sample_duration_ms, source FROM voiceprint WHERE speaker_id=%s", (sid,)
    ).fetchone()
    assert vp["sample_duration_ms"] == 3000 and vp["source"] == "enroll"


def test_enroll_stage_logs_emitted(conn, tmp_path, caplog):
    sid = seed_speaker(conn, enrollment_status="pending")
    jid = seed_job(conn, type="enroll_speaker", payload={})
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    db.claim(conn, "w1")
    with caplog.at_level("INFO", logger="damwha_worker"):
        run_enroll_speaker(
            conn,
            conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
            _payload(sid, "speakers/s/sample.wav"),
            FakeEmbedder([[0.3] * 192]),
            Storage(str(tmp_path)),
            worker_id="w1",
            normalize_fn=lambda s, d: None,
            probe_fn=lambda p: ProbeResult(3000),
        )
    msgs = [r.getMessage() for r in caplog.records]
    text = "\n".join(msgs)
    for stage in ("extract_embedding", "enroll_persist"):
        assert any(f"stage={stage} done elapsed_ms=" in m for m in msgs), stage
    assert "enroll_speaker start" in text
    assert "dim=192" in text
    assert "enroll_speaker done outcome=committed total_ms=" in text


def test_enroll_too_short_sample_raises_permanent(conn, tmp_path):
    sid = seed_speaker(conn, enrollment_status="pending")
    jid = seed_job(conn, type="enroll_speaker", payload={})
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    db.claim(conn, "w1")
    with pytest.raises(WorkerError) as ei:
        run_enroll_speaker(
            conn,
            conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
            _payload(sid, "speakers/s/sample.wav"),
            FakeEmbedder([None]),  # <100ms 샘플 → 임베딩 불가
            Storage(str(tmp_path)),
            worker_id="w1",
            normalize_fn=lambda s, d: None,
            probe_fn=lambda p: ProbeResult(50),
        )
    assert ei.value.code == "sample_too_short"
    assert ei.value.kind is ErrorKind.PERMANENT


def test_enroll_too_short_fails_job_and_speaker(conn, tmp_path, monkeypatch):
    # handle_job 경유: PERMANENT → 재시도 없이 job failed + speaker failed
    import damwha_worker.pipeline.enroll_speaker as es

    monkeypatch.setattr(es.ffmpeg, "normalize", lambda s, d: None)
    monkeypatch.setattr(es.ffmpeg, "probe", lambda p: ProbeResult(50))
    sid = seed_speaker(conn, enrollment_status="pending")
    payload = {
        "schema_version": 1,
        "speaker_id": str(sid),
        "audio_key": "speakers/s/sample.wav",
        "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
    }
    jid = seed_job(conn, type="enroll_speaker", payload=payload)
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    job = db.claim(conn, "w1")
    out = handle_job(
        conn, job, Storage(str(tmp_path)), "w1", build_embedder=lambda: FakeEmbedder([None])
    )
    assert out == "failed"
    row = conn.execute("SELECT status, error FROM job WHERE id=%s", (jid,)).fetchone()
    assert row["status"] == "failed"
    assert row["error"]["code"] == "sample_too_short"
    assert (
        conn.execute("SELECT enrollment_status FROM speaker WHERE id=%s", (sid,)).fetchone()[
            "enrollment_status"
        ]
        == "failed"
    )


def test_enroll_lost_ownership_raises_transient(conn, tmp_path):
    # enter_stage 도입으로 enroll도 소유권 상실 시 헛연산 없이 즉시 중단된다
    sid = seed_speaker(conn, enrollment_status="pending")
    jid = seed_job(conn, type="enroll_speaker", payload={})
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    db.claim(conn, "w1")  # w1 소유
    with pytest.raises(WorkerError) as ei:
        run_enroll_speaker(
            conn,
            conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
            _payload(sid, "speakers/s/sample.wav"),
            FakeEmbedder([[0.3] * 192]),
            Storage(str(tmp_path)),
            worker_id="w2",  # 소유자 아님
            normalize_fn=lambda s, d: None,
            probe_fn=lambda p: ProbeResult(3000),
        )
    assert ei.value.code == "lost_ownership"
    assert ei.value.kind is ErrorKind.TRANSIENT
