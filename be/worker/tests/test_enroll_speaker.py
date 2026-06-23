from damwha_worker import db
from damwha_worker.contracts import EnrollSpeakerPayload
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
