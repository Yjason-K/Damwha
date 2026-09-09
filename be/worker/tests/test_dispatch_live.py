import threading

import pytest

from damwha_worker import db
from damwha_worker.__main__ import handle_job
from damwha_worker.audio.source import FRAME_BYTES
from damwha_worker.audio.tail_source import TailSource
from damwha_worker.contracts import parse_payload
from damwha_worker.errors import AUDIO_DEVICE_FAILED, ErrorKind, WorkerError
from damwha_worker.jobs import default_live_source
from damwha_worker.models.base import Word
from damwha_worker.pipeline.live_session import LiveModels
from damwha_worker.storage import Storage
from tests.conftest import seed_job, seed_meeting
from tests.fakes import (
    FakeEmbedder,
    FakeStreamingVAD,
    FakeTranscriber,
    GrowingFileSource,
    RaisingSource,
)


def _live_payload(mid, *, source="mic"):
    return {
        "schema_version": 1,
        "meeting_id": str(mid),
        "audio_key": f"meetings/{mid}/original.wav",
        "source": source,
        "process": {
            "schema_version": 5,
            "meeting_id": str(mid),
            "audio_key": f"meetings/{mid}/original.wav",
            "processing_version": 0,
            "reprocess": False,
            "models": {
                "whisper_model": "large-v3-turbo",
                "language": "ko",
                "devices": {"diarization": "cpu", "stt": "cpu"},
                "preset": "standard",
                "preset_revision": None,
                "summary_model": "mlx-community/Qwen3.5-4B-8bit",
                "diarization": {"model": "d", "min_speakers": None, "max_speakers": None},
                "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
            },
            "identify": {"threshold": 0.8, "suggest_threshold": 0.6},
            "followups": {"lens": True, "summary": True},
        },
    }


def _claimed(conn, mid, *, source="mic"):
    jid = seed_job(
        conn,
        type="live_session",
        meeting_id=mid,
        payload=_live_payload(mid, source=source),
        max_attempts=1,
    )
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    return conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone()


def _models():
    return LiveModels(
        transcriber=FakeTranscriber([Word("안녕", 0, 300, 0.9)]),
        embedder=FakeEmbedder([None]),
        vad=FakeStreamingVAD({2: [("start", 0)], 30: [("end", 0)]}),
    )


def test_dispatches_live_session_and_queues_the_final_pass(conn, tmp_path):
    mid = seed_meeting(conn, status="recording")
    job = _claimed(conn, mid)
    conn.execute(
        "UPDATE job SET stop_requested_at=now(), committed_bytes=%s, sealed_bytes=%s WHERE id=%s",
        (FRAME_BYTES * 64, FRAME_BYTES * 64, job["id"]),
    )
    src = GrowingFileSource([b"\x00" * FRAME_BYTES] * 64)
    out = handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        build_live_models=_models,
        # build_live_source는 이제 (payload, storage, state_box) 3개를 받는다 —
        # 여기서는 라우팅만 확인하므로 인자를 무시하고 미리 만든 fake를 그대로 낸다.
        build_live_source=lambda *_a, **_k: src,
    )
    assert out == "committed"
    m = conn.execute("SELECT status, current_job_id FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert m["status"] == "uploaded"
    assert (
        conn.execute("SELECT type FROM job WHERE id=%s", (m["current_job_id"],)).fetchone()["type"]
        == "process_meeting"
    )


def test_live_failure_never_requeues_even_when_transient(conn, tmp_path):
    mid = seed_meeting(conn, status="recording")
    job = _claimed(conn, mid)
    src = RaisingSource(WorkerError(AUDIO_DEVICE_FAILED, "no mic", ErrorKind.TRANSIENT))
    out = handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        build_live_models=_models,
        build_live_source=lambda *_a, **_k: src,
    )
    assert out == "failed"
    j = conn.execute("SELECT status, error FROM job WHERE id=%s", (job["id"],)).fetchone()
    assert j["status"] == "failed" and j["error"]["code"] == AUDIO_DEVICE_FAILED
    m = conn.execute("SELECT status, error FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert m["status"] == "failed" and m["error"]["code"] == AUDIO_DEVICE_FAILED


def test_default_live_source_picks_tail_source_for_browser(tmp_path):
    """browser 세션은 API가 쓰는 파일을 따라 읽는 TailSource를 쓴다."""
    payload = parse_payload("live_session", _live_payload("mtg_1", source="browser"))
    src = default_live_source(payload, Storage(str(tmp_path)), {"bytes": None})
    assert isinstance(src, TailSource)


def test_default_live_source_rejects_mic(tmp_path):
    """mic 세션은 시작조차 하지 않는다.

    캡처를 브라우저로 옮긴 뒤 mic은 조용히 틀린 결과를 만든다 — API는 브라우저 바이트를
    파일에 쓰고 워커는 호스트 마이크를 전사하며, MicSource가 sealed_bytes를 안 보므로
    stop 뒤에도 max_minutes(4시간)까지 돌아 그동안 새 녹음이 전부 막힌다.
    """
    payload = parse_payload("live_session", _live_payload("mtg_1"))
    with pytest.raises(WorkerError) as e:
        default_live_source(payload, Storage(str(tmp_path)), {"bytes": None})
    assert e.value.code == AUDIO_DEVICE_FAILED
    assert e.value.kind is ErrorKind.PERMANENT


def test_mic_session_closes_its_meeting_instead_of_hanging(conn, tmp_path):
    """mic 거절이 회의를 'recording'에 남기면 안 된다.

    default_live_source의 raise는 run_live_session 이전이라, live_session의 실패 경로가
    실제로 회의까지 닫는지는 별개 사실이다 — 안 닫으면 부분 유일 인덱스가 다음 녹음을
    영원히 막아, 4시간 hang을 없애려던 수정이 더 나쁜 갇힘으로 바뀐다.
    """
    mid = seed_meeting(conn, status="recording")
    job = _claimed(conn, mid)
    out = handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        build_live_models=_models,
        build_live_source=default_live_source,
    )
    assert out == "failed"
    m = conn.execute("SELECT status, error FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert m["status"] == "failed"
    assert m["error"]["code"] == AUDIO_DEVICE_FAILED


def test_browser_preview_failure_leaves_the_recording_alone(conn, tmp_path):
    """브라우저 세션의 미리보기 실패는 job만 닫는다 (설계 §4.1 3행, 수용 테스트 R1).

    오디오는 브라우저가 API로 보내고 API가 파일에 쓴다 — 워커의 OOM이 그 녹음을 끝낼
    권한은 없다. 회의는 recording에 남고 append는 계속 받으며, 마무리는 봉인 후 API가 한다.
    """
    mid = seed_meeting(conn, status="recording")
    job = _claimed(conn, mid, source="browser")
    src = RaisingSource(MemoryError())
    out = handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        build_live_models=_models,
        build_live_source=lambda *_a, **_k: src,
    )
    assert out == "failed"
    j = conn.execute("SELECT status, error FROM job WHERE id=%s", (job["id"],)).fetchone()
    assert j["status"] == "failed" and j["error"]["code"] == "oom"
    m = conn.execute("SELECT status, error FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert m["status"] == "recording" and m["error"] is None
    assert (
        conn.execute("SELECT count(*) c FROM job WHERE type='process_meeting'").fetchone()["c"] == 0
    )


def test_shutdown_before_dispatch_returns_the_preview_instead_of_requeueing(conn, tmp_path):
    """SIGTERM이 claim과 dispatch 사이에 와도 live job은 requeue_for_shutdown에 넣지 않는다
    (설계 §4.2). 재queue하면 다음 워커가 이미 지나간 오디오를 앞에서부터 다시 전사한다."""
    mid = seed_meeting(conn, status="recording")
    job = _claimed(conn, mid, source="browser")
    ev = threading.Event()
    ev.set()
    out = handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        build_live_models=_models,
        build_live_source=lambda *_a, **_k: GrowingFileSource([]),
        shutdown_event=ev,
    )
    assert out == "failed"
    j = conn.execute("SELECT status, attempts, error FROM job WHERE id=%s", (job["id"],)).fetchone()
    assert j["status"] == "failed" and j["attempts"] == 1
    assert j["error"]["code"] == "worker_shutdown"
    m = conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert m["status"] == "recording"


def test_preview_failure_reports_lost_when_the_session_is_already_gone(conn, tmp_path):
    """0바이트 사용자 stop이 회의를 지우면 job도 FK CASCADE로 사라진다 — 그 뒤의 실패
    기록은 대상이 없다. 소유권 가드의 0행을 삼키지 않고 lost로 보고한다 (설계 §4.2)."""
    mid = seed_meeting(conn, status="recording")
    job = _claimed(conn, mid, source="browser")
    conn.execute("DELETE FROM meeting WHERE id=%s", (mid,))
    out = handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        build_live_models=_models,
        build_live_source=lambda *_a, **_k: RaisingSource(MemoryError()),
    )
    assert out == "lost"


def test_shutdown_never_requeues_a_mic_session_either(conn, tmp_path):
    """live job은 source와 무관하게 requeue_for_shutdown에 들어가지 않는다 (설계 §4.2).

    mic은 워커가 캡처자라 반납할 미리보기가 아니라 잃은 녹음이다 — 기존 거절 정책대로
    회의까지 닫는다. 재queue만은 어느 쪽이든 안 된다: 다음 워커가 이미 지나간 구간을
    앞에서부터 다시 전사하는 것은 라이브에서 복구가 아니라 손상이다.
    """
    mid = seed_meeting(conn, status="recording")
    job = _claimed(conn, mid)
    ev = threading.Event()
    ev.set()
    out = handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        build_live_models=_models,
        build_live_source=lambda *_a, **_k: GrowingFileSource([]),
        shutdown_event=ev,
    )
    assert out == "failed"
    j = conn.execute("SELECT status, attempts FROM job WHERE id=%s", (job["id"],)).fetchone()
    assert j["status"] == "failed" and j["attempts"] == 1
    m = conn.execute("SELECT status, error FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert m["status"] == "failed" and m["error"]["code"] == "worker_shutdown"
