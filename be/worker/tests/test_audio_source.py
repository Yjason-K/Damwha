import threading
import time

import pytest

from damwha_worker.audio.source import FRAME_BYTES, FRAME_MS, FileSource, MicSource
from damwha_worker.errors import AUDIO_DEVICE_FAILED, ErrorKind, WorkerError
from tests.audio_fixtures import frame_bytes, make_wav


def test_file_source_yields_whole_frames_and_drops_the_tail(tmp_path):
    path = make_wav(str(tmp_path / "a.wav"), 5, tail_samples=100)
    frames = list(FileSource(path).frames())
    assert len(frames) == 5
    assert all(len(f) == FRAME_BYTES for f in frames)
    assert frames[3] == frame_bytes(3)


def test_file_source_rejects_non_16k_mono(tmp_path):
    path = make_wav(str(tmp_path / "44k.wav"), 2, sample_rate=44100)
    with pytest.raises(ValueError):
        list(FileSource(path).frames())


def test_file_source_stop_ends_iteration_early(tmp_path):
    path = make_wav(str(tmp_path / "a.wav"), 50)
    src = FileSource(path)
    out = []
    for f in src.frames():
        out.append(f)
        if len(out) == 3:
            src.stop()
    assert len(out) == 3


def test_file_source_realtime_sleeps_one_frame_per_frame(tmp_path):
    path = make_wav(str(tmp_path / "a.wav"), 4)
    slept = []
    list(FileSource(path, realtime=True, sleep=slept.append).frames())
    assert slept == [FRAME_MS / 1000] * 4


class _FakeStream:
    """sounddevice.InputStream 흉내 — start()에서 콜백을 스레드로 돌린다."""

    def __init__(self, *, samplerate, channels, dtype, blocksize, device, callback):
        assert (samplerate, channels, dtype, blocksize) == (16000, 1, "int16", 512)
        self._cb = callback
        self._stop = threading.Event()
        self.closed = False

    def start(self):
        def _pump():
            i = 0
            while not self._stop.is_set():
                self._cb(bytearray(frame_bytes(i)), 512, None, None)
                i += 1
                time.sleep(0.001)

        threading.Thread(target=_pump, daemon=True).start()

    def stop(self):
        self._stop.set()

    def close(self):
        self.closed = True


class _FakeSounddevice:
    def __init__(self, stream_cls=_FakeStream):
        self.InputStream = stream_cls


def test_mic_source_streams_callback_frames_until_stop():
    sd = _FakeSounddevice()
    src = MicSource(sounddevice_module=sd)
    got = []
    for f in src.frames():
        got.append(f)
        if len(got) == 5:
            src.stop()
    assert len(got) >= 5
    assert got[0] == frame_bytes(0) and len(got[4]) == FRAME_BYTES


def test_mic_source_maps_open_failure_to_permanent_audio_device_failed():
    class _Broken(_FakeStream):
        def start(self):
            raise RuntimeError("Error opening InputStream: no default input device")

    src = MicSource(sounddevice_module=_FakeSounddevice(_Broken))
    with pytest.raises(WorkerError) as ei:
        list(src.frames())
    assert ei.value.code == AUDIO_DEVICE_FAILED
    assert ei.value.kind is ErrorKind.PERMANENT


def test_mic_source_without_sounddevice_installed_is_permanent(monkeypatch):
    import builtins

    real_import = builtins.__import__

    def _no_sd(name, *a, **k):
        if name == "sounddevice":
            raise ImportError("No module named 'sounddevice'")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", _no_sd)
    with pytest.raises(WorkerError) as ei:
        list(MicSource().frames())
    assert ei.value.code == AUDIO_DEVICE_FAILED
