import subprocess

import pytest

from damwha_worker.errors import ErrorKind, WorkerError
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


def test_normalize_builds_16k_mono_wav_command(monkeypatch, tmp_path):
    captured = {}

    def runner(cmd):
        captured["cmd"] = cmd
        return ok_proc()

    monkeypatch.setattr(ffmpeg, "probe", lambda path: ffmpeg.ProbeResult(1))

    ffmpeg.normalize("/in/a.m4a", str(tmp_path / "n.wav"), runner=runner)
    cmd = captured["cmd"]
    assert "-ar" in cmd and "16000" in cmd and "-ac" in cmd and "1" in cmd
    assert cmd[-1] != str(tmp_path / "n.wav")


def test_normalize_probes_temp_file_then_atomically_replaces_destination(monkeypatch, tmp_path):
    destination = tmp_path / "normalized.wav"
    calls = []
    real_replace = ffmpeg.os.replace

    monkeypatch.setattr(
        ffmpeg,
        "probe",
        lambda path: calls.append(("probe", path)) or ffmpeg.ProbeResult(1),
    )

    def _replace(src, dst):
        calls.append(("replace", src, dst))
        real_replace(src, dst)

    monkeypatch.setattr(ffmpeg.os, "replace", _replace)

    ffmpeg.normalize(
        "/in/a.m4a",
        str(destination),
        runner=lambda cmd: calls.append(("ffmpeg", cmd)) or ok_proc(),
    )

    temp_path = calls[0][1][-1]
    assert temp_path != str(destination)
    assert calls[1] == ("probe", temp_path)
    assert calls[2] == ("replace", temp_path, str(destination))


def test_normalize_removes_temp_file_when_probe_fails(monkeypatch, tmp_path):
    removed = []
    monkeypatch.setattr(
        ffmpeg,
        "probe",
        lambda path: (_ for _ in ()).throw(WorkerError("x", "bad", ErrorKind.PERMANENT)),
    )
    monkeypatch.setattr(ffmpeg.os, "unlink", lambda path: removed.append(path))

    with pytest.raises(WorkerError):
        ffmpeg.normalize(
            "/in/a.m4a", str(tmp_path / "normalized.wav"), runner=lambda cmd: ok_proc()
        )

    assert len(removed) == 1


def test_normalize_failure_is_permanent(tmp_path):
    def runner(cmd):
        return ok_proc(returncode=1)

    with pytest.raises(WorkerError) as ei:
        ffmpeg.normalize("/in/a", str(tmp_path / "n.wav"), runner=runner)
    assert ei.value.kind.value == "PERMANENT"
