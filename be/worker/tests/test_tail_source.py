import os
import struct
import threading
import time

import pytest

from damwha_worker.audio.source import FRAME_BYTES
from damwha_worker.audio.tail_source import BYTES_PER_MS, DRIFT_BYTES, TailSource
from damwha_worker.errors import IO_ERROR, WorkerError

HEADER = (
    b"RIFF"
    + struct.pack("<I", 0xFFFFFFFF)
    + b"WAVE"
    + b"fmt "
    + struct.pack("<IHHIIHH", 16, 1, 1, 16000, 32000, 2, 16)
    + b"data"
    + struct.pack("<I", 0xFFFFFFFF)
)


def _wav(tmp_path, pcm=b""):
    p = tmp_path / "live.wav"
    p.write_bytes(HEADER + pcm)
    return str(p)


class Clock:
    """결정적 시계. sleep이 시간을 앞으로 민다 — 실제로 자지 않는다."""

    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


class RealClock:
    """실제 시계 — ENOENT 회복 테스트는 별도 스레드의 실제 타이밍과 맞물려야 하므로
    시간을 흉내만 내는 Clock으론 재시도 루프가 순식간에(가짜) grace를 다 써버린다."""

    def __call__(self):
        return time.monotonic()

    def sleep(self, s):
        time.sleep(s)


def _src(path, sealed=None, **kw):
    c = kw.pop("clock", None) or Clock()
    return TailSource(path, sealed_bytes=lambda: sealed, clock=c, sleep=c.sleep, **kw), c


def test_yields_only_complete_frames(tmp_path):
    # 프레임 하나 반 → 한 프레임만 나오고, 봉인되면 나머지 반쪽은 버려진다
    path = _wav(tmp_path, b"\x01" * (FRAME_BYTES + 500))
    src, _ = _src(path, sealed=FRAME_BYTES + 500)
    out = list(src.frames())
    assert len(out) == 1
    assert out[0] == b"\x01" * FRAME_BYTES
    assert src.position_ms == FRAME_BYTES // BYTES_PER_MS


def test_eof_is_catch_up_not_end(tmp_path):
    # 봉인이 없으면 파일 끝에서 끝나지 않고 기다린다. 다른 스레드가 더 쓰면 이어서 읽는다.
    path = _wav(tmp_path, b"\x01" * FRAME_BYTES)
    src, _ = _src(path, sealed=None)
    got = []

    def consume():
        for f in src.frames():
            got.append(f)

    t = threading.Thread(target=consume, daemon=True)
    t.start()
    deadline = time.monotonic() + 5
    while len(got) < 1 and time.monotonic() < deadline:
        time.sleep(0.005)
    assert len(got) >= 1, "source produced no frames within 5s"
    with open(path, "ab") as f:
        f.write(b"\x02" * FRAME_BYTES)
    deadline = time.monotonic() + 5
    while len(got) < 2 and time.monotonic() < deadline:
        time.sleep(0.005)
    assert len(got) >= 2, "source produced no second frame within 5s"
    src.stop()
    t.join(timeout=5)
    assert got[1] == b"\x02" * FRAME_BYTES


def test_ends_exactly_at_sealed_bytes(tmp_path):
    # 파일에 3프레임이 있어도 sealed가 2프레임이면 2개만 낸다
    path = _wav(tmp_path, b"\x03" * (FRAME_BYTES * 3))
    src, _ = _src(path, sealed=FRAME_BYTES * 2)
    assert len(list(src.frames())) == 2


def test_ignores_header_size_fields(tmp_path):
    # 헤더가 "data 크기 0"이라고 말해도 실제 PCM을 전부 읽는다.
    # 봉인 전환 중 헤더를 믿으면 파일을 조기 종료한다.
    path = _wav(tmp_path, b"\x04" * FRAME_BYTES)
    with open(path, "r+b") as f:
        f.seek(40)
        f.write(struct.pack("<I", 0))
    src, _ = _src(path, sealed=FRAME_BYTES)
    assert len(list(src.frames())) == 1


def test_enoent_waits_within_grace_then_fails(tmp_path):
    missing = str(tmp_path / "nope.wav")
    src, clock = _src(missing, sealed=None, grace_seconds=1.0, poll_seconds=0.5)
    with pytest.raises(WorkerError) as e:
        list(src.frames())
    assert e.value.code == IO_ERROR
    assert clock.t >= 1.0  # 곧바로 죽지 않고 grace 동안 기다렸다


def test_enoent_recovers_if_file_appears_within_grace(tmp_path):
    # frames()는 제너레이터라 첫 next() 전에는 _open()이 실행조차 안 된다. 파일을
    # 미리 만들어두면 재시도 경로가 전혀 실행되지 않으므로, 파일을 next() *이후에*
    # 늦게 나타나게 해야 재시도 경로가 실제로 검증된다. 실시간 스레드 타이밍과 맞물려야
    # 하므로 가짜 Clock 대신 RealClock(실제 time.sleep/time.monotonic)을 쓴다.
    path = str(tmp_path / "late.wav")
    src, _ = _src(path, sealed=FRAME_BYTES, grace_seconds=5.0, poll_seconds=0.05, clock=RealClock())
    frames = src.frames()

    def _write_late():
        time.sleep(0.2)
        with open(path, "wb") as f:
            f.write(HEADER + b"\x05" * FRAME_BYTES)

    threading.Thread(target=_write_late, daemon=True).start()
    # 첫 next() 호출 시점에는 파일이 아직 없다 — grace 안이므로 재시도 후 읽어야 한다
    assert not os.path.exists(path)
    assert next(frames) == b"\x05" * FRAME_BYTES


def test_drift_seek_jumps_forward_and_reports_position(tmp_path):
    # DRIFT_BYTES보다 훨씬 앞선 파일 → 첫 프레임부터 뒤쪽으로 건너뛴다
    pcm = bytes(DRIFT_BYTES + FRAME_BYTES * 10)
    path = _wav(tmp_path, pcm)
    src, _ = _src(path, sealed=len(pcm))
    first = next(src.frames())
    assert first is not None
    assert src.skips == 1
    # target = floor((available - DRIFT_BYTES) / FRAME_BYTES) * FRAME_BYTES
    target = ((len(pcm) - DRIFT_BYTES) // FRAME_BYTES) * FRAME_BYTES
    # 첫 프레임을 이미 하나 냈으므로 position은 target + 한 프레임
    assert src.position_ms == (target + FRAME_BYTES) // BYTES_PER_MS


def test_no_drift_seek_when_within_threshold(tmp_path):
    path = _wav(tmp_path, b"\x06" * (FRAME_BYTES * 4))
    src, _ = _src(path, sealed=FRAME_BYTES * 4)
    list(src.frames())
    assert src.skips == 0


def test_short_read_is_retried_not_treated_as_eof(tmp_path):
    # 프레임 경계 중간까지만 쓰인 파일에 나머지가 나중에 온다
    path = _wav(tmp_path, b"\x07" * 500)
    src, _ = _src(path, sealed=None)
    got = []
    t = threading.Thread(target=lambda: got.extend(src.frames()), daemon=True)
    t.start()
    with open(path, "ab") as f:
        f.write(b"\x07" * (FRAME_BYTES - 500))
    deadline = time.monotonic() + 5
    while not got and time.monotonic() < deadline:
        time.sleep(0.005)
    assert got, "source produced no frames within 5s"
    src.stop()
    t.join(timeout=5)
    assert got[0] == b"\x07" * FRAME_BYTES
