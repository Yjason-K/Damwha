import queue
import threading
import time
import wave

import pytest

from damwha_worker import db
from damwha_worker.audio.source import FileSource
from damwha_worker.audio.wav_writer import WavWriter
from damwha_worker.contracts import parse_payload
from damwha_worker.errors import (
    AUDIO_DEVICE_FAILED,
    IO_ERROR,
    LIVE_STT_FAILED,
    ErrorKind,
    WorkerError,
)
from damwha_worker.models.base import Word
from damwha_worker.pipeline import live_session
from damwha_worker.pipeline.live_session import Capture, LiveModels, run_live_session
from damwha_worker.storage import Storage
from tests.audio_fixtures import make_wav
from tests.conftest import seed_job, seed_meeting, seed_speaker, seed_voiceprint
from tests.fakes import (
    BackloggedSource,
    FakeEmbedder,
    FakeStreamingVAD,
    FakeTranscriber,
    RaisingSource,
    SilenceSource,
)

EMB = "speechbrain/spkrec-ecapa-voxceleb"


def _payload(mid):
    process = {
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
            "preset_revision": "2026-08-12.3",
            "summary_model": "mlx-community/Qwen3.5-4B-8bit",
            "diarization": {"model": "d", "min_speakers": None, "max_speakers": None},
            "embedding": {"model": EMB, "dimension": 192},
        },
        "identify": {"threshold": 0.8, "suggest_threshold": 0.6},
        "followups": {"lens": True, "summary": True},
    }
    return parse_payload(
        "live_session",
        {
            "schema_version": 1,
            "meeting_id": str(mid),
            "audio_key": f"meetings/{mid}/original.wav",
            "source": "mic",
            "process": process,
        },
    )


def _claimed(conn):
    mid = seed_meeting(conn, status="recording")
    jid = seed_job(conn, type="live_session", meeting_id=mid, max_attempts=1)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    return mid, conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone()


def _models(*, transcriber=None, embedder=None, vad=None):
    return LiveModels(
        transcriber=transcriber
        or FakeTranscriber([Word("안녕", 0, 400, 0.9), Word("하세요", 400, 800, 0.9)]),
        embedder=embedder or FakeEmbedder([[1.0] + [0.0] * 191]),
        vad=vad or FakeStreamingVAD({5: [("start", 0)], 40: [("end", 0)]}),
    )


def _run(conn, tmp_path, job, payload, models, source, **kw):
    return run_live_session(
        conn,
        job,
        payload,
        models,
        Storage(str(tmp_path)),
        source,
        worker_id="w1",
        stop_poll_seconds=kw.pop("stop_poll_seconds", 0.02),
        **kw,
    )


def test_session_writes_preview_rows_and_finalizes_into_process_meeting(conn, tmp_path):
    sid = seed_speaker(conn, name="영재", enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0] + [0.0] * 191)
    mid, job = _claimed(conn)
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 64))  # 64프레임 = 2048ms

    out = _run(conn, tmp_path, job, _payload(mid), _models(), src)

    assert out == "committed"
    rows = conn.execute(
        "SELECT seq, start_ms, end_ms, text, speaker_id, similarity FROM live_utterance "
        "WHERE meeting_id=%s ORDER BY seq",
        (mid,),
    ).fetchall()
    assert len(rows) == 1
    assert rows[0]["text"] == "안녕 하세요"
    assert rows[0]["start_ms"] == 0 and rows[0]["end_ms"] == 41 * 32  # pre-roll 5-6 프레임
    assert rows[0]["speaker_id"] == sid
    assert rows[0]["similarity"] == pytest.approx(1.0, abs=1e-6)
    m = conn.execute(
        "SELECT status, duration_ms, recorded_at, current_job_id FROM meeting WHERE id=%s",
        (mid,),
    ).fetchone()
    assert m["status"] == "uploaded" and m["duration_ms"] == 2048
    new = conn.execute(
        "SELECT type, payload FROM job WHERE id=%s", (m["current_job_id"],)
    ).fetchone()
    assert new["type"] == "process_meeting" and new["payload"] == _payload(mid).process_wire
    with wave.open(str(tmp_path / "meetings" / str(mid) / "original.wav"), "rb") as r:
        assert r.getnframes() == 64 * 512  # 헤더가 확정된 완전한 파일


def test_session_skips_rows_for_empty_transcripts_and_unknown_speakers(conn, tmp_path):
    mid, job = _claimed(conn)
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 64))
    models = _models(
        transcriber=FakeTranscriber([Word("모르는", 0, 300, 0.5)]),
        embedder=FakeEmbedder([[0.0, 1.0] + [0.0] * 190]),  # 등록 성문 없음 → 화자 ?
    )
    assert _run(conn, tmp_path, job, _payload(mid), models, src) == "committed"
    rows = conn.execute(
        "SELECT speaker_id, similarity FROM live_utterance WHERE meeting_id=%s", (mid,)
    ).fetchall()
    assert rows == [{"speaker_id": None, "similarity": None}]


def test_session_writes_nothing_when_transcript_is_empty(conn, tmp_path):
    mid, job = _claimed(conn)
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 64))
    out = _run(conn, tmp_path, job, _payload(mid), _models(transcriber=FakeTranscriber([])), src)
    assert out == "committed"
    row = conn.execute(
        "SELECT count(*) c FROM live_utterance WHERE meeting_id=%s", (mid,)
    ).fetchone()
    assert row["c"] == 0


def test_stop_flag_ends_capture_and_finalizes(conn, pg_url, tmp_path):
    mid, job = _claimed(conn)
    src = SilenceSource()
    result = {}
    # psycopg 커넥션은 스레드 간 공유가 안 된다 — 세션 스레드는 자기 커넥션을 쓴다
    t = threading.Thread(
        target=lambda: result.setdefault(
            "out",
            _run(
                db.connect(pg_url),
                tmp_path,
                job,
                _payload(mid),
                _models(vad=FakeStreamingVAD()),
                src,
            ),
        ),
    )
    t.start()
    time.sleep(0.2)
    conn.execute("UPDATE job SET stop_requested_at=now() WHERE id=%s", (job["id"],))
    t.join(timeout=10)
    assert result["out"] == "committed"
    assert src.emitted > 0
    with wave.open(str(tmp_path / "meetings" / str(mid) / "original.wav"), "rb") as r:
        assert r.getnframes() == src.emitted * 512 or r.getnframes() == (src.emitted - 1) * 512


def test_lost_ownership_returns_lost_and_keeps_the_file(conn, pg_url, tmp_path):
    mid, job = _claimed(conn)
    src = SilenceSource()
    result = {}
    t = threading.Thread(
        target=lambda: result.setdefault(
            "out",
            _run(
                db.connect(pg_url),
                tmp_path,
                job,
                _payload(mid),
                _models(vad=FakeStreamingVAD()),
                src,
            ),
        ),
    )
    t.start()
    time.sleep(0.2)
    conn.execute("UPDATE job SET status='failed' WHERE id=%s", (job["id"],))  # API cancel
    t.join(timeout=10)
    assert result["out"] == "lost"
    assert (tmp_path / "meetings" / str(mid) / "original.wav").exists()
    row = conn.execute("SELECT count(*) c FROM job WHERE type='process_meeting'").fetchone()
    assert row["c"] == 0


def test_shutdown_event_finalizes_instead_of_requeue(conn, tmp_path):
    mid, job = _claimed(conn)
    ev = threading.Event()
    src = SilenceSource()
    threading.Timer(0.2, ev.set).start()
    out = _run(
        conn, tmp_path, job, _payload(mid), _models(vad=FakeStreamingVAD()), src, shutdown_event=ev
    )
    assert out == "committed"
    status = conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
    assert status == "uploaded"


def test_max_duration_stops_the_session(conn, tmp_path):
    mid, job = _claimed(conn)
    src = SilenceSource()
    ticks = iter([0.0, 0.0, 0.0, 10_000.0, 10_000.0, 10_000.0, 10_000.0, 10_000.0])
    out = _run(
        conn,
        tmp_path,
        job,
        _payload(mid),
        _models(vad=FakeStreamingVAD()),
        src,
        max_minutes=1.0,
        clock=lambda: next(ticks, 10_000.0),
    )
    assert out == "committed"


def test_consecutive_clip_failures_raise_live_stt_failed(conn, tmp_path):
    class Boom:
        def transcribe(self, *a, **k):
            raise RuntimeError("model exploded")

    mid, job = _claimed(conn)
    events = {i * 20: [("start", 0)] for i in range(6)} | {
        i * 20 + 15: [("end", 0)] for i in range(6)
    }
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 130))
    with pytest.raises(WorkerError) as ei:
        _run(
            conn,
            tmp_path,
            job,
            _payload(mid),
            _models(transcriber=Boom(), vad=FakeStreamingVAD(events)),
            src,
            clip_failure_limit=5,
        )
    assert ei.value.code == LIVE_STT_FAILED and ei.value.kind is ErrorKind.PERMANENT
    # 파일은 닫혀 있고 완전하다
    with wave.open(str(tmp_path / "meetings" / str(mid) / "original.wav"), "rb") as r:
        assert r.getnframes() == 130 * 512


def test_one_clip_failure_is_tolerated_and_counter_resets(conn, tmp_path):
    class Flaky:
        def __init__(self):
            self.calls = 0

        def transcribe(self, *a, **k):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("once")
            return [Word("됐다", 0, 300, 0.9)]

    mid, job = _claimed(conn)
    events = {0: [("start", 0)], 15: [("end", 0)], 20: [("start", 0)], 35: [("end", 0)]}
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 64))
    out = _run(
        conn,
        tmp_path,
        job,
        _payload(mid),
        _models(transcriber=Flaky(), vad=FakeStreamingVAD(events)),
        src,
    )
    assert out == "committed"
    row = conn.execute(
        "SELECT count(*) c FROM live_utterance WHERE meeting_id=%s", (mid,)
    ).fetchone()
    assert row["c"] == 1


def test_source_failure_propagates_as_worker_error(conn, tmp_path):
    mid, job = _claimed(conn)
    src = RaisingSource(WorkerError(AUDIO_DEVICE_FAILED, "no mic", ErrorKind.PERMANENT))
    with pytest.raises(WorkerError) as ei:
        _run(conn, tmp_path, job, _payload(mid), _models(), src)
    assert ei.value.code == AUDIO_DEVICE_FAILED
    # 프레임 0 → 파일 없음
    assert not (tmp_path / "meetings" / str(mid) / "original.wav").exists()


def test_file_is_complete_even_when_transcription_is_slow(conn, tmp_path):
    class Slow:
        def transcribe(self, *a, **k):
            time.sleep(0.3)
            return [Word("느림", 0, 300, 0.9)]

    mid, job = _claimed(conn)
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 200))
    events = {0: [("start", 0)], 10: [("end", 0)], 20: [("start", 0)], 30: [("end", 0)]}
    out = _run(
        conn,
        tmp_path,
        job,
        _payload(mid),
        _models(transcriber=Slow(), vad=FakeStreamingVAD(events)),
        src,
    )
    assert out == "committed"
    with wave.open(str(tmp_path / "meetings" / str(mid) / "original.wav"), "rb") as r:
        assert r.getnframes() == 200 * 512


def test_every_captured_frame_reaches_the_file_when_an_exception_aborts_the_loop(conn, tmp_path):
    """종료 순서 회귀 가드: finally에서 capture.join()이 writer sentinel보다 먼저여야 한다.

    마이크처럼 stop() 뒤에도 버퍼가 남는 소스에서, 클립 연속 실패가 finally로 뛰어들 때
    캡처 스레드는 아직 살아 있다. sentinel을 먼저 보내면 writer가 일찍 끝나고 그 뒤 캡처가
    넣는 프레임은 아무도 읽지 않는다 — 예외 경로마다 녹음 꼬리가 조용히 잘린다.
    capture.join()을 writer_q.put(None) 아래로 옮기면 이 테스트가 깨져야 한다.
    """

    class Boom:
        def transcribe(self, *a, **k):
            raise RuntimeError("model exploded")

    mid, job = _claimed(conn)
    # 12프레임(384ms)짜리 발화 5개 → 5번째 실패가 프레임 72에서 터진다. 소스는 130프레임을
    # 3ms 간격으로 내므로 그 시점에 58프레임이 아직 남아 있다.
    events = {i * 15: [("start", 0)] for i in range(5)} | {
        i * 15 + 12: [("end", 0)] for i in range(5)
    }
    src = BackloggedSource(130)
    with pytest.raises(WorkerError) as ei:
        _run(
            conn,
            tmp_path,
            job,
            _payload(mid),
            _models(transcriber=Boom(), vad=FakeStreamingVAD(events)),
            src,
            clip_failure_limit=5,
        )
    assert ei.value.code == LIVE_STT_FAILED
    assert src.emitted == 130  # stop()은 남은 버퍼 뒤에 서므로 소스는 끝까지 낸다
    with wave.open(str(tmp_path / "meetings" / str(mid) / "original.wav"), "rb") as r:
        assert r.getnframes() == src.emitted * 512  # 낸 프레임 = 디스크에 닿은 프레임


def test_writer_death_fails_the_session_instead_of_committing_a_truncated_file(
    conn, tmp_path, monkeypatch
):
    """디스크가 차서 writer 스레드가 죽으면(ENOSPC) 세션은 커밋하면 안 된다.

    커밋하면 회의는 uploaded가 되고 duration_ms는 큐에 넣은 양이 아니라 디스크에 닿은
    양만큼 틀리며, 아무 데도 그 사실이 남지 않는다 — 정확히 이 기능이 막으려는 조용한 손실.
    """

    class FullDisk(WavWriter):
        def append(self, pcm: bytes) -> None:
            if self.frames_written >= 10 * 512:
                raise OSError(28, "No space left on device")
            super().append(pcm)

    monkeypatch.setattr(live_session, "WavWriter", FullDisk)
    mid, job = _claimed(conn)
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 64))
    with pytest.raises(WorkerError) as ei:
        _run(conn, tmp_path, job, _payload(mid), _models(vad=FakeStreamingVAD()), src)
    assert ei.value.code == IO_ERROR and ei.value.kind is ErrorKind.PERMANENT
    m = conn.execute("SELECT status, duration_ms FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert m["status"] == "recording" and m["duration_ms"] is None
    row = conn.execute("SELECT count(*) c FROM job WHERE type='process_meeting'").fetchone()
    assert row["c"] == 0
    # 디스크에 닿은 데까지는 헤더가 확정된 채 남는다 — 지우지 않는다.
    with wave.open(str(tmp_path / "meetings" / str(mid) / "original.wav"), "rb") as r:
        assert r.getnframes() == 10 * 512


def test_zero_frame_session_is_not_finalized(conn, tmp_path):
    """프레임 0이면 넘길 녹음이 없다 — finalize와 파일 삭제가 어긋나면 안 된다.

    예전에는 커밋하고 회의를 uploaded로 올린 뒤 finally가 배치 job이 읽을 파일을 지웠다.
    """
    mid, job = _claimed(conn)
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 0))
    with pytest.raises(WorkerError) as ei:
        _run(conn, tmp_path, job, _payload(mid), _models(vad=FakeStreamingVAD()), src)
    assert ei.value.code == AUDIO_DEVICE_FAILED and ei.value.kind is ErrorKind.PERMANENT
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == (
        "recording"
    )
    row = conn.execute("SELECT count(*) c FROM job WHERE type='process_meeting'").fetchone()
    assert row["c"] == 0
    assert not (tmp_path / "meetings" / str(mid) / "original.wav").exists()


def test_capture_bounds_the_preview_queue_but_never_the_writer_queue(tmp_path):
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 100))
    writer_q, preview_q = queue.Queue(), queue.Queue()
    cap = Capture(src, writer_q, preview_q, preview_max_frames=10)
    cap.start()
    cap.join(timeout=5)
    assert cap.error is None
    assert writer_q.qsize() == 101  # 100 프레임 + None
    assert preview_q.qsize() == 11  # 10 프레임 + None
    assert cap.dropped == 90


def test_writer_death_ends_the_session_promptly_not_only_at_stop(conn, tmp_path, monkeypatch):
    """디스크가 차면 그 자리에서 세션이 끝나야 한다 — 종료를 누를 때가 아니라.

    writer 스레드만 죽고 캡처·미리보기·heartbeat는 그대로 도는 상태라, 루프의 1초 폴링이
    보지 않으면 5분에 찬 디스크를 60분짜리 회의의 끝에서야 보고한다. 그래서 소스는 실패
    뒤에도 계속 프레임을 내는 SilenceSource이고, 상한 시간(2초)은 회귀했을 때 테스트가
    멈추지 않게 하는 안전망일 뿐이다 — 그 상한까지 가면 emitted가 한참 커져 깨진다.

    close()도 같이 던지는 것이 진짜 ENOSPC다(남은 버퍼를 flush하다 같은 오류가 난다).
    오류 판정이 close()보다 뒤로 가면 그 close가 원인을 가려 IO_ERROR가 아니라
    uncategorized로 닫힌다.
    """

    class FullDisk(WavWriter):
        def append(self, pcm: bytes) -> None:
            if self.frames_written >= 10 * 512:
                raise OSError(28, "No space left on device")
            super().append(pcm)

        def close(self) -> None:
            raise OSError(28, "No space left on device")

    monkeypatch.setattr(live_session, "WavWriter", FullDisk)
    mid, job = _claimed(conn)
    src = SilenceSource()
    with pytest.raises(WorkerError) as ei:
        _run(
            conn,
            tmp_path,
            job,
            _payload(mid),
            _models(vad=FakeStreamingVAD()),
            src,
            max_minutes=2.0 / 60,
        )
    assert ei.value.code == IO_ERROR and ei.value.kind is ErrorKind.PERMANENT
    assert "No space left on device" in repr(ei.value.__cause__)
    # 아무도 종료를 누르지 않았다 — 루프가 스스로 끝냈다.
    row = conn.execute("SELECT stop_requested_at FROM job WHERE id=%s", (job["id"],)).fetchone()
    assert row["stop_requested_at"] is None
    # 실패(10프레임) 직후 몇 프레임 안에 끝난다. 상한까지 갔다면 400프레임쯤 나온다.
    assert src.emitted < 100
    m = conn.execute("SELECT status, duration_ms FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert m["status"] == "recording" and m["duration_ms"] is None
