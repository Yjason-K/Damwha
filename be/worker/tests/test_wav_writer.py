import hashlib
import queue
import struct
import wave

from damwha_worker.audio.wav_writer import (
    HEADER_LEN,
    STREAMING_SIZE,
    WavWriter,
    repair_streaming_header,
    run_writer_thread,
)

FRAME = bytes(range(256)) * 4  # 1024바이트 = int16 512샘플


def _sizes(path):
    with open(path, "rb") as f:
        head = f.read(HEADER_LEN)
    return struct.unpack("<I", head[4:8])[0], struct.unpack("<I", head[40:44])[0]


def test_open_writes_streaming_header_and_close_writes_real_sizes(tmp_path):
    path = str(tmp_path / "a.wav")
    w = WavWriter(path)
    w.flush()
    assert _sizes(path) == (STREAMING_SIZE, STREAMING_SIZE)
    for _ in range(10):
        w.append(FRAME)
    w.close()
    assert _sizes(path) == (36 + 10 * 1024, 10 * 1024)
    assert w.frames_written == 5120 and w.duration_ms == 320
    with wave.open(path, "rb") as r:
        actual = (r.getnchannels(), r.getsampwidth(), r.getframerate(), r.getnframes())
        assert actual == (1, 2, 16000, 5120)


def test_file_cut_without_close_is_recovered_by_repair(tmp_path):
    path = str(tmp_path / "cut.wav")
    w = WavWriter(path)
    for _ in range(7):
        w.append(FRAME)
    w.flush()  # close 없이 끊긴 파일 — 헤더는 스트리밍 값 그대로
    assert _sizes(path) == (STREAMING_SIZE, STREAMING_SIZE)
    assert repair_streaming_header(path) is True
    assert _sizes(path) == (36 + 7 * 1024, 7 * 1024)
    with wave.open(path, "rb") as r:
        assert r.getnframes() == 7 * 512


def test_repair_truncates_a_half_sample_tail(tmp_path):
    path = str(tmp_path / "odd.wav")
    w = WavWriter(path)
    w.append(FRAME)
    w.append(b"\x01")  # 샘플 경계가 아닌 1바이트
    w.flush()
    assert repair_streaming_header(path) is True
    assert _sizes(path) == (36 + 1024, 1024)
    with wave.open(path, "rb") as r:
        assert r.getnframes() == 512


def test_repair_leaves_a_normal_wav_untouched(tmp_path):
    path = str(tmp_path / "ok.wav")
    w = WavWriter(path)
    w.append(FRAME)
    w.close()
    before = hashlib.sha256(open(path, "rb").read()).hexdigest()
    assert repair_streaming_header(path) is False
    assert hashlib.sha256(open(path, "rb").read()).hexdigest() == before


def test_repair_ignores_missing_or_foreign_files(tmp_path):
    assert repair_streaming_header(str(tmp_path / "missing.wav")) is False
    other = tmp_path / "x.m4a"
    other.write_bytes(b"not a wav at all, definitely more than forty-four bytes long..")
    assert repair_streaming_header(str(other)) is False


def test_writer_thread_drains_queue_until_sentinel(tmp_path):
    path = str(tmp_path / "t.wav")
    w = WavWriter(path)
    q: queue.Queue = queue.Queue()
    t = run_writer_thread(w, q)
    for _ in range(3):
        q.put(FRAME)
    q.put(None)
    t.join(timeout=5)
    assert not t.is_alive()
    w.close()
    with wave.open(path, "rb") as r:
        assert r.getnframes() == 3 * 512


def test_writer_thread_records_the_exception_that_killed_it(tmp_path):
    """예외를 삼키면 디스크가 찬 순간 스레드만 조용히 죽는다 — 세션이 볼 수 있게 남긴다."""

    class FullDisk(WavWriter):
        def append(self, pcm: bytes) -> None:
            raise OSError(28, "No space left on device")

    w = FullDisk(str(tmp_path / "t.wav"))
    q: queue.Queue = queue.Queue()
    t = run_writer_thread(w, q)
    q.put(FRAME)
    t.join(timeout=5)
    assert not t.is_alive()
    assert isinstance(t.error, OSError) and t.error.errno == 28
    w.close()


def test_writer_thread_leaves_error_none_on_a_clean_drain(tmp_path):
    w = WavWriter(str(tmp_path / "t.wav"))
    q: queue.Queue = queue.Queue()
    t = run_writer_thread(w, q)
    q.put(FRAME)
    q.put(None)
    t.join(timeout=5)
    assert t.error is None
    w.close()
