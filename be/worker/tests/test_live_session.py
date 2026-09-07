import os
import queue
import threading
import time

import pytest

from damwha_worker import db
from damwha_worker.audio.source import FRAME_BYTES
from damwha_worker.contracts import parse_payload
from damwha_worker.errors import (
    AUDIO_DEVICE_FAILED,
    IO_ERROR,
    LIVE_STT_FAILED,
    ErrorKind,
    ShutdownRequested,
    WorkerError,
)
from damwha_worker.models.base import Word
from damwha_worker.pipeline.live_session import Capture, LiveModels, run_live_session
from damwha_worker.storage import Storage
from tests.conftest import seed_job, seed_meeting, seed_speaker, seed_voiceprint
from tests.fakes import (
    FakeEmbedder,
    FakeStreamingVAD,
    FakeTranscriber,
    GrowingFileSource,
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


def _seal(conn, job, n_bytes):
    """stop_requested_at과 sealed_bytes를 같이 찍는다 — get_live_input_state는
    stop_requested_at이 없으면 sealed_bytes가 있어도 signal=None을 낸다 (설계 §4.4 ③).

    확정 경계도 같이 올린다. API의 stop은 committed와 sealed를 하나의 TX에서 같은 값으로
    커밋하고(설계 §3.4), 워커의 finalize는 그 둘이 일치할 때만 자기 차례로 본다 (설계 §4.1).
    """
    conn.execute(
        "UPDATE job SET stop_requested_at=now(), committed_bytes=%s, sealed_bytes=%s WHERE id=%s",
        (n_bytes, n_bytes, job["id"]),
    )


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
    _seal(conn, job, FRAME_BYTES * 64)  # 64프레임 = 2048ms
    src = GrowingFileSource([b"\x00" * FRAME_BYTES] * 64)

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
        "SELECT status, duration_ms, current_job_id FROM meeting WHERE id=%s",
        (mid,),
    ).fetchone()
    assert m["status"] == "uploaded" and m["duration_ms"] == 2048
    new = conn.execute(
        "SELECT type, payload FROM job WHERE id=%s", (m["current_job_id"],)
    ).fetchone()
    assert new["type"] == "process_meeting" and new["payload"] == _payload(mid).process_wire


def test_session_skips_rows_for_empty_transcripts_and_unknown_speakers(conn, tmp_path):
    mid, job = _claimed(conn)
    _seal(conn, job, FRAME_BYTES * 64)
    src = GrowingFileSource([b"\x00" * FRAME_BYTES] * 64)
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
    _seal(conn, job, FRAME_BYTES * 64)
    src = GrowingFileSource([b"\x00" * FRAME_BYTES] * 64)
    out = _run(conn, tmp_path, job, _payload(mid), _models(transcriber=FakeTranscriber([])), src)
    assert out == "committed"
    row = conn.execute(
        "SELECT count(*) c FROM live_utterance WHERE meeting_id=%s", (mid,)
    ).fetchone()
    assert row["c"] == 0


def test_reads_until_sealed_bytes_then_finalizes(conn, tmp_path):
    """봉인 길이에 닿아야 끝난다. duration_ms는 sealed_bytes에서 나온다 — 자라는 중인 파일의
    크기가 아니다(워커는 파일을 아예 안 본다)."""
    mid, job = _claimed(conn)
    sealed = FRAME_BYTES * 10
    _seal(conn, job, sealed)
    src = GrowingFileSource([b"\x00" * FRAME_BYTES] * 10)
    out = _run(conn, tmp_path, job, _payload(mid), _models(vad=FakeStreamingVAD()), src)
    assert out == "committed"
    row = conn.execute("SELECT status, duration_ms FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert row["status"] == "uploaded"
    assert row["duration_ms"] == sealed // 32  # 32 bytes/ms


def test_skip_reseeds_segmenter_position(conn, tmp_path):
    """소스가 건너뛰면 세그먼터의 절대 위치가 따라가야 한다 — 안 그러면 발화 시각이 밀린다.

    이벤트 인덱스는 건너뛴 뒤(2, 12)만 쓴다 — skip_to가 vad.reset()도 부르므로(FakeStreamingVAD
    의 frames_seen이 0으로 돌아간다) 건너뛰기 전 인덱스와 겹치면 스퓨리어스 발화가 낀다.
    """
    mid, job = _claimed(conn)
    _seal(conn, job, FRAME_BYTES * 15)
    # 2프레임 뒤에 10분 지점으로 건너뛴다.
    src = GrowingFileSource([b"\x01" * FRAME_BYTES] * 15, skip_after=2, skip_to_ms=600_000)
    models = _models(vad=FakeStreamingVAD({2: [("start", 0)], 12: [("end", 0)]}))
    _run(conn, tmp_path, job, _payload(mid), models, src)
    rows = conn.execute(
        "SELECT start_ms FROM live_utterance WHERE meeting_id=%s ORDER BY seq", (mid,)
    ).fetchall()
    assert rows, "발화가 하나는 나와야 한다"
    assert rows[0]["start_ms"] >= 600_000, "건너뛴 뒤의 발화가 건너뛰기 전 시각으로 기록됐다"


def test_does_not_write_the_audio_file(conn, tmp_path):
    """워커는 이제 reader다. 파일을 만들거나 쓰지 않는다."""
    mid, job = _claimed(conn)
    _seal(conn, job, FRAME_BYTES)
    payload = _payload(mid)
    path = Storage(str(tmp_path)).resolve(payload.audio_key)
    src = GrowingFileSource([b"\x00" * FRAME_BYTES])
    _run(conn, tmp_path, job, payload, _models(vad=FakeStreamingVAD()), src)
    assert not os.path.exists(path), "워커가 오디오 파일을 만들었다 — API가 writer다"


def test_lost_ownership_returns_lost(conn, pg_url, tmp_path):
    """소유권을 잃으면(취소) 봉인 여부와 무관하게 즉시 lost로 끝낸다."""
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
    conn.execute("UPDATE job SET status='failed' WHERE id=%s", (job["id"],))  # API cancel
    t.join(timeout=10)
    assert result["out"] == "lost"
    row = conn.execute("SELECT count(*) c FROM job WHERE type='process_meeting'").fetchone()
    assert row["c"] == 0


def test_shutdown_before_the_seal_returns_the_preview(conn, tmp_path):
    """봉인 전 SIGTERM은 미리보기를 반납한다 — 자기 마음대로 마무리하지 않는다 (설계 §4.2).

    여기서 finalize하면 아직 자라는 중인 파일의 길이로 duration을 정하고, 브라우저가 보내는
    중인 나머지 오디오를 정본에서 잘라낸 채 배치 패스를 큐에 넣는다. 봉인은 API의 몫이다.
    """
    mid, job = _claimed(conn)
    ev = threading.Event()
    src = SilenceSource()
    threading.Timer(0.2, ev.set).start()
    with pytest.raises(ShutdownRequested):
        _run(
            conn,
            tmp_path,
            job,
            _payload(mid),
            _models(vad=FakeStreamingVAD()),
            src,
            shutdown_event=ev,
        )
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == (
        "recording"
    )
    row = conn.execute("SELECT count(*) c FROM job WHERE type='process_meeting'").fetchone()
    assert row["c"] == 0


def test_max_duration_without_a_seal_does_not_finalize(conn, tmp_path):
    """상한 시간 도달은 미리보기 반납일 뿐이지 임의 봉인이 아니다 (설계 §4.2).

    4시간 상한을 강제하는 것은 API다(누적 460800000바이트에서 봉인). 워커가 여기서 스스로
    끝을 정하면 두 actor가 서로 다른 정본 길이를 주장하게 된다.
    """
    mid, job = _claimed(conn)
    conn.execute("UPDATE job SET committed_bytes=0 WHERE id=%s", (job["id"],))
    src = SilenceSource()
    ticks = iter([0.0, 0.0, 0.0, 10_000.0, 10_000.0, 10_000.0, 10_000.0, 10_000.0])
    with pytest.raises(WorkerError) as ei:
        _run(
            conn,
            tmp_path,
            job,
            _payload(mid),
            _models(vad=FakeStreamingVAD()),
            src,
            max_minutes=1.0,
            clock=lambda: next(ticks, 10_000.0),
        )
    assert ei.value.code == IO_ERROR
    row = conn.execute("SELECT status, sealed_bytes FROM job WHERE id=%s", (job["id"],)).fetchone()
    assert row["sealed_bytes"] is None
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == (
        "recording"
    )
    assert (
        conn.execute("SELECT count(*) c FROM job WHERE type='process_meeting'").fetchone()["c"] == 0
    )


def test_shutdown_event_finalizes_instead_of_requeue(conn, tmp_path):
    """봉인 뒤의 SIGTERM은 마무리해도 된다 — 끝 길이는 이미 API가 정했다 (설계 §4.2).

    재queue는 어느 쪽이든 안 된다(§2.2). 여기서 반납해도 API 인계로 수렴하지만, 정본 길이가
    확정된 뒤라 이 워커가 끝내는 편이 회의를 30초 스윕까지 recording에 두지 않는다.
    """
    mid, job = _claimed(conn)
    _seal(conn, job, FRAME_BYTES * 100)
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
    """소스가 봉인에 닿지 못한 채로 계속 돌아도, 상한 시간이 지나면 스스로 끝낸다."""
    mid, job = _claimed(conn)
    _seal(conn, job, FRAME_BYTES * 100)
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


def test_stop_without_seal_gives_up_after_60_seconds(conn, tmp_path):
    """API가 stop_requested_at만 찍고 sealed_bytes를 안 쓰면(마이그레이션 창·API 버그),
    max_minutes(4시간)까지 기다리지 않고 60초 만에 IO_ERROR로 끝난다 — 봉인 없이는
    TailSource가 절대 EOF를 내지 않으므로, 안 그러면 4시간을 그냥 버린다."""
    mid, job = _claimed(conn)
    conn.execute("UPDATE job SET stop_requested_at=now() WHERE id=%s", (job["id"],))
    src = SilenceSource()
    tick = {"t": 0.0}

    def clock():
        tick["t"] += 30.0
        return tick["t"]

    with pytest.raises(WorkerError) as ei:
        _run(conn, tmp_path, job, _payload(mid), _models(vad=FakeStreamingVAD()), src, clock=clock)
    assert ei.value.code == IO_ERROR and ei.value.kind is ErrorKind.PERMANENT


def test_consecutive_clip_failures_raise_live_stt_failed(conn, tmp_path):
    class Boom:
        def transcribe(self, *a, **k):
            raise RuntimeError("model exploded")

    mid, job = _claimed(conn)
    events = {i * 20: [("start", 0)] for i in range(6)} | {
        i * 20 + 15: [("end", 0)] for i in range(6)
    }
    src = GrowingFileSource([b"\x00" * FRAME_BYTES] * 130)
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
    _seal(conn, job, FRAME_BYTES * 64)
    events = {0: [("start", 0)], 15: [("end", 0)], 20: [("start", 0)], 35: [("end", 0)]}
    src = GrowingFileSource([b"\x00" * FRAME_BYTES] * 64)
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


def test_zero_frame_session_is_not_finalized(conn, tmp_path):
    """봉인 길이가 0이면(한 바이트도 안 왔다) finalize하지 않는다.

    예전에는 커밋하고 회의를 uploaded로 올린 뒤 finally가 배치 job이 읽을 파일을 지웠다.
    지금은 워커가 파일을 보지 않으므로 판단은 오직 sealed_bytes다.
    """
    mid, job = _claimed(conn)
    _seal(conn, job, 0)
    src = GrowingFileSource([])
    with pytest.raises(WorkerError) as ei:
        _run(conn, tmp_path, job, _payload(mid), _models(vad=FakeStreamingVAD()), src)
    assert ei.value.code == AUDIO_DEVICE_FAILED and ei.value.kind is ErrorKind.PERMANENT
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == (
        "recording"
    )
    row = conn.execute("SELECT count(*) c FROM job WHERE type='process_meeting'").fetchone()
    assert row["c"] == 0


def test_capture_blocks_instead_of_dropping_when_the_queue_is_full():
    """유계 큐가 backpressure의 유일한 장치다: 가득 차면 put이 막혀 소스가 더 나아가지 않는다.

    (예전 preview 큐처럼) 넘치면 오래된 것부터 버리는 경로가 있었다면 큐가 가득 차도 소스는
    끝까지 진행한다 — position_ms가 멈추지 않고 총량(160)까지 뛴다. 여기서는 큐를
    maxsize=1로 좁혀 첫 프레임 뒤 두 번째 프레임의 put이 반드시 막히게 만들고, 소스가
    거기서 정말로 멈춰 있는지(진행하지 않는지)를 직접 관찰한다.
    """
    total = 5
    src = GrowingFileSource([b"\x00" * FRAME_BYTES] * total)
    q: queue.Queue = queue.Queue(maxsize=1)
    cap = Capture(src, q, stop_poll_seconds=0.01)
    cap.start()
    try:
        # 프레임 1(32ms)은 큐에 들어가고, 프레임 2(64ms)는 put에서 막힌다 — 소스는 정확히
        # 여기서 멈춘다. 고정된 sleep 하나로 "다 됐다"고 가정하는 대신, 조건이 실제로 될
        # 때까지 상한(2초) 안에서 짧게 반복 확인한다.
        deadline = time.monotonic() + 2.0
        while src.position_ms < 64 and time.monotonic() < deadline:
            time.sleep(0.005)
        assert src.position_ms == 64, "put이 막히기 전에 소스가 이미 더 진행했다"

        # 드레인하지 않고 더 기다려도(0.1초 ≈ stop_poll_seconds의 10배) 그대로다. 드롭
        # 경로가 있었다면 이 사이에 나머지 프레임을 전부 흘려 position_ms가 160으로 뛴다.
        time.sleep(0.1)
        assert src.position_ms == 64, "큐가 가득 찬 채로도 소스가 계속 진행했다 — 드롭됐다"

        # 드레인하면 막혔던 프레임들이 순서대로, 빠짐없이 큐를 통과한다. 마지막 None
        # sentinel은 여기서 확인하지 않는다 — 그건 별도의 계약(end-of-stream 전달)이라
        # test_capture_delivers_the_end_of_stream_sentinel_even_when_the_queue_is_full이
        # 전담한다.
        received = [q.get(timeout=2.0) for _ in range(total)]
        assert received == [((i + 1) * 32, b"\x00" * FRAME_BYTES) for i in range(total)]
    finally:
        cap.stop()
        cap.join(timeout=5)


def test_capture_delivers_the_end_of_stream_sentinel_even_when_the_queue_is_full():
    """소스가 끝나는 순간 큐가 꽉 차 있어도 sentinel(None)은 반드시 도착해야 한다.

    메인 루프가 "소스가 끝났다"를 아는 유일한 길이 이 None이다 (live_session.py의
    `if item is None: stop_reason = "source_ended"`). sentinel을 put_nowait로 넣던
    시절엔 이 순간 큐가 가득 차 있으면 Full로 조용히 사라졌다 — sealed_bytes를 이미 받은
    세션조차 그 사실을 영영 못 보고 max_minutes(4시간)까지 못 끝난다. 60초 stop-without
    -seal 가드도 못 구한다: 그 가드는 sealed_bytes가 없을 때만 도는데, 이 시나리오는
    정확히 봉인이 이미 왔기 때문에 소스가 끝난 경우다. 회의는 recording에 멈춰 있고,
    meeting_single_recording_idx(부분 유니크 인덱스)가 그 상태인 회의를 하나로 막으므로
    다음 녹음 전부가 4시간 동안 막힌다.

    이 테스트는 put_nowait에 대해서는 실패해야 한다: 큐를 소스 프레임 수와 같은
    maxsize로 채워 생성기가 끝나는 바로 그 순간 큐가 이미 가득 차 있게 만든다.
    """
    total = 3
    src = GrowingFileSource([b"\x00" * FRAME_BYTES] * total)
    q: queue.Queue = queue.Queue(maxsize=total)
    cap = Capture(src, q, stop_poll_seconds=0.01)
    cap.start()
    try:
        # 큐가 total개로 꽉 찰 때까지 기다린다 — 그 시점엔 소스도 이미 프레임을 전부
        # 냈다(생성기 종료 직전/직후)이므로, sentinel을 넣을 빈자리가 없다.
        deadline = time.monotonic() + 2.0
        while q.qsize() < total and time.monotonic() < deadline:
            time.sleep(0.005)
        assert q.qsize() == total

        # 드레인하지 않은 채 잠깐 더 기다린다 — 캡처 스레드가 생성기 종료를 마치고
        # sentinel을 (막힌 채로) 재시도하고 있을 시간을 준다. put_nowait였다면 이 사이에
        # 이미 사라졌을 것이고, 되돌릴 방법이 없다.
        time.sleep(0.1)

        received = [q.get(timeout=2.0) for _ in range(total)]
        assert received == [((i + 1) * 32, b"\x00" * FRAME_BYTES) for i in range(total)]
        sentinel = q.get(timeout=2.0)
        assert sentinel is None, "sentinel이 도착하지 않았다 — source_ended를 영영 못 본다"
    finally:
        cap.stop()
        cap.join(timeout=5)
