import pytest

from damwha_worker.errors import ErrorKind, WorkerError
from damwha_worker.models.device import torch_device


def test_cpu_passthrough():
    assert torch_device("cpu") == "cpu"


def test_gpu_maps_to_mps_when_available(monkeypatch):
    import sys
    import types

    torch = types.SimpleNamespace(
        backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: True))
    )
    monkeypatch.setitem(sys.modules, "torch", torch)
    assert torch_device("gpu") == "mps"


def test_gpu_unavailable_is_permanent(monkeypatch):
    import sys
    import types

    torch = types.SimpleNamespace(
        backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False))
    )
    monkeypatch.setitem(sys.modules, "torch", torch)
    with pytest.raises(WorkerError) as e:
        torch_device("gpu")
    assert e.value.kind is ErrorKind.PERMANENT
    assert e.value.code == "gpu_unavailable"
