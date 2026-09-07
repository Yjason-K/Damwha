import os
import struct
import threading
import time

import pytest

from damwha_worker.audio.source import FRAME_BYTES
from damwha_worker.audio.tail_source import (
    BYTES_PER_MS,
    DRIFT_BYTES,
    HEADER_LEN,
    TailSource,
)
from damwha_worker.db import LiveInputState
from damwha_worker.errors import IO_ERROR, WorkerError

#: 확정 경계를 검사하지 않는 테스트가 쓰는 "파일 전체가 확정됨" 값.
UNBOUNDED = 1 << 40

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
    """결정적 시계. sleep이 시간을 앞으로 민다 — 실제로 자지 않는다.

    sleep 횟수에 상한이 있다. 이 시계는 실제로 자지 않으므로, TailSource가 끝나지 못하는
    회귀(예: 종료 조건을 available이 아니라 yielded로 되돌리면 부분 프레임에서 영원히
    돌지 못한다)가 나면 테스트가 **실패하지 않고 100% CPU로 hang한다** — 493개짜리
    스위트에서 hang은 실패보다 나쁘고, 이 저장소엔 pytest-timeout 설정이 없다.
    상한은 정상 테스트가 절대 닿지 않을 만큼 넉넉하다.
    """

    def __init__(self, max_sleeps=100_000):
        self.t = 0.0
        self._left = max_sleeps

    def __call__(self):
        return self.t

    def sleep(self, s):
        self._left -= 1
        if self._left < 0:
            raise AssertionError("TailSource가 끝나지 않는다 — 무한 폴링 회귀")
        self.t += s


class RealClock:
    """실제 시계 — ENOENT 회복 테스트는 별도 스레드의 실제 타이밍과 맞물려야 하므로
    시간을 흉내만 내는 Clock으론 재시도 루프가 순식간에(가짜) grace를 다 써버린다."""

    def __call__(self):
        return time.monotonic()

    def sleep(self, s):
        time.sleep(s)


def _src(path, sealed=None, committed=None, signal=None, **kw):
    c = kw.pop("clock", None) or Clock()
    if committed is None:
        # 마이그레이션 024의 CHECK가 sealed_bytes = committed_bytes를 강제한다. 확정 경계
        # 자체를 보는 테스트만 committed를 따로 준다.
        committed = sealed if sealed is not None else UNBOUNDED
    state = LiveInputState(signal, committed, sealed)
    return TailSource(path, input_state=lambda: state, clock=c, sleep=c.sleep, **kw), c


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


# ── 확정 경계 (설계 §3.5) ───────────────────────────────────────────────────
#
# 읽기 상한은 파일 크기가 아니라 min(파일 크기, committed_bytes)다. 파일에는 크래시가 남긴
# 미확정 꼬리가 붙어 있을 수 있고, 다음 요청이 그것을 잘라내고 다른 PCM을 쓴다.


def test_never_reads_past_the_committed_boundary(tmp_path):
    # 확정 한 프레임 + 미확정 한 프레임. 미확정 쪽은 파일에 있어도 나오면 안 된다.
    path = _wav(tmp_path, b"\x01" * FRAME_BYTES + b"\x09" * FRAME_BYTES)
    src, _ = _src(path, sealed=None, committed=FRAME_BYTES)
    frames = src.frames()
    assert next(frames) == b"\x01" * FRAME_BYTES
    src.stop()
    assert list(frames) == []


def test_a_truncated_unconfirmed_tail_never_reaches_the_transcript(tmp_path):
    # 미확정 꼬리를 미리 읽어 두면, API가 그것을 잘라내고 다른 PCM을 쓴 뒤 미리보기가
    # 정본에 없는 소리를 말하게 된다 — 되돌릴 수 없는 종류의 오류다.
    path = _wav(tmp_path, b"\x01" * FRAME_BYTES + b"\x09" * FRAME_BYTES)
    box = {"state": LiveInputState(None, FRAME_BYTES, None)}
    c = Clock()
    src = TailSource(path, input_state=lambda: box["state"], clock=c, sleep=c.sleep)
    frames = src.frames()
    assert next(frames) == b"\x01" * FRAME_BYTES

    # API가 미확정 꼬리를 truncate하고 다른 PCM을 다시 써 확정·봉인한다 (설계 §3.3 ①).
    with open(path, "r+b") as f:
        f.truncate(HEADER_LEN + FRAME_BYTES)
        f.seek(HEADER_LEN + FRAME_BYTES)
        f.write(b"\x02" * FRAME_BYTES)
    box["state"] = LiveInputState("stop", FRAME_BYTES * 2, FRAME_BYTES * 2)

    assert list(frames) == [b"\x02" * FRAME_BYTES]  # \x09는 한 번도 나오지 않았다


def test_lost_ownership_ends_the_source_without_reading(tmp_path):
    # 소유권을 잃은 뒤에도 읽으면 이미 남이 쓰고 있는 파일을 전사한다 (설계 §4.2).
    path = _wav(tmp_path, b"\x01" * FRAME_BYTES * 4)
    src, _ = _src(path, sealed=None, committed=FRAME_BYTES * 4, signal="lost")
    assert list(src.frames()) == []


def test_a_short_file_after_sealing_fails_only_after_the_timeout(tmp_path):
    # 봉인 길이에 영영 못 닿는다 — 그냥 두면 미리보기가 max_minutes(4시간)까지 돈다.
    path = _wav(tmp_path, b"\x01" * FRAME_BYTES)
    src, clock = _src(path, sealed=FRAME_BYTES * 4, sealed_short_seconds=10.0, poll_seconds=0.5)
    with pytest.raises(WorkerError) as e:
        list(src.frames())
    assert e.value.code == IO_ERROR
    assert clock.t >= 10.0  # 곧바로 죽지 않고 상한만큼 기다렸다
