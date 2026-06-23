import subprocess

import pytest

from damwha_worker.errors import WorkerError
from damwha_worker.pipeline import ffmpeg


def ok_proc(stdout=b"", returncode=0):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=b"")


def test_probe_parses_duration_ms():
    captured = {}

    def runner(cmd):
        captured["cmd"] = cmd
        return ok_proc(stdout=b'{"format": {"duration": "12.345"}}')

    res = ffmpeg.probe("/x/a.m4a", runner=runner)
    assert res.duration_ms == 12345
    assert "ffprobe" in captured["cmd"][0]


def test_probe_failure_is_permanent():
    def runner(cmd):
        return ok_proc(returncode=1)

    with pytest.raises(WorkerError) as ei:
        ffmpeg.probe("/x/bad", runner=runner)
    assert ei.value.kind.value == "PERMANENT"


def test_probe_missing_duration_is_permanent():
    def runner(cmd):
        return ok_proc(stdout=b'{"format": {}}')

    with pytest.raises(WorkerError):
        ffmpeg.probe("/x/a", runner=runner)


def test_normalize_builds_16k_mono_wav_command():
    captured = {}

    def runner(cmd):
        captured["cmd"] = cmd
        return ok_proc()

    ffmpeg.normalize("/in/a.m4a", "/out/n.wav", runner=runner)
    cmd = captured["cmd"]
    assert "-ar" in cmd and "16000" in cmd and "-ac" in cmd and "1" in cmd
    assert cmd[-1] == "/out/n.wav"


def test_normalize_failure_is_permanent():
    def runner(cmd):
        return ok_proc(returncode=1)

    with pytest.raises(WorkerError) as ei:
        ffmpeg.normalize("/in/a", "/out/n.wav", runner=runner)
    assert ei.value.kind.value == "PERMANENT"
