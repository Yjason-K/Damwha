import subprocess

import pytest

from damwha_worker import capabilities


@pytest.fixture
def mac(monkeypatch):
    """실제 머신과 무관하게 'Apple Silicon Mac 16GB'를 흉내낸다."""
    monkeypatch.setattr(capabilities.sys, "platform", "darwin")
    monkeypatch.setattr(capabilities.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(capabilities, "_memory_bytes", lambda: 16 * 1024**3)
    monkeypatch.setattr(capabilities, "_sysctl", lambda name: "Apple M2")


def test_detect_reports_measured_spec(mac, monkeypatch):
    monkeypatch.setattr(capabilities, "probe_mps", lambda: True)
    assert capabilities.detect("worker-1") == {
        "worker_id": "worker-1",
        "platform": "darwin",
        "arch": "arm64",
        "chip": "Apple M2",
        "memory_gb": 16,
        "gpu_eligible": True,
        "gpu_probe": "mps_available",
    }


def test_rosetta_python_is_not_gpu_eligible(mac, monkeypatch):
    """env 추측(CAPABILITIES_ARCH=arm64)이 못 잡는 바로 그 경우.

    Rosetta 아래에서는 machine()이 x86_64를 돌려주고, torch도 MPS를 못 본다.
    """
    monkeypatch.setattr(capabilities.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(capabilities, "probe_mps", lambda: False)
    caps = capabilities.detect("worker-1")
    assert caps["arch"] == "x64"  # Node의 process.arch 어휘로 정규화
    assert caps["gpu_eligible"] is False
    assert caps["gpu_probe"] == "mps_unavailable"


def test_mps_unavailable_on_real_arm64_takes_gpu_away(mac, monkeypatch):
    monkeypatch.setattr(capabilities, "probe_mps", lambda: False)
    caps = capabilities.detect("worker-1")
    assert caps["gpu_eligible"] is False


def test_unknown_probe_falls_back_to_architecture(mac, monkeypatch):
    """torch 미설치(모델 extra 없음)가 GPU 자격을 뺏지는 않는다."""
    monkeypatch.setattr(capabilities, "probe_mps", lambda: None)
    caps = capabilities.detect("worker-1")
    assert caps["gpu_eligible"] is True
    assert caps["gpu_probe"] == "unknown"


def test_unreadable_memory_aborts_the_report(mac, monkeypatch):
    """부분 보고를 올리느니 API가 자기 추정으로 폴백하게 둔다."""
    monkeypatch.setattr(capabilities, "_memory_bytes", lambda: None)
    monkeypatch.setattr(capabilities, "probe_mps", lambda: True)
    with pytest.raises(RuntimeError):
        capabilities.detect("worker-1")


@pytest.mark.parametrize(
    "stdout,returncode,expected",
    [("1\n", 0, True), ("0\n", 0, False), ("", 1, None), ("Traceback...", 1, None), ("?", 0, None)],
)
def test_probe_mps_reads_the_child_verdict(monkeypatch, stdout, returncode, expected):
    def fake_run(*_a, **_k):
        return subprocess.CompletedProcess([], returncode, stdout, "")

    monkeypatch.setattr(capabilities.subprocess, "run", fake_run)
    assert capabilities.probe_mps() is expected


def test_probe_mps_timeout_is_unknown(monkeypatch):
    def fake_run(*_a, **_k):
        raise subprocess.TimeoutExpired(cmd=[], timeout=1)

    monkeypatch.setattr(capabilities.subprocess, "run", fake_run)
    assert capabilities.probe_mps() is None
