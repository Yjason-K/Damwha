from damwha_worker.contracts import UnsupportedPayloadVersion
from damwha_worker.errors import ErrorKind, WorkerError, classify


def test_workererror_to_json():
    e = WorkerError("corrupt_audio", "bad header", ErrorKind.PERMANENT)
    j = e.to_json(stage="persist")
    assert j["code"] == "corrupt_audio"
    assert j["kind"] == "PERMANENT"
    assert j["stage"] == "persist"


def test_classify_passthrough_workererror():
    e = WorkerError("oom", "x", ErrorKind.TRANSIENT)
    assert classify(e) is e


def test_classify_unsupported_version_is_permanent():
    w = classify(UnsupportedPayloadVersion("schema_version 2"))
    assert w.kind is ErrorKind.PERMANENT
    assert w.code == "unsupported_payload_version"


def test_classify_memoryerror_is_oom():
    w = classify(MemoryError())
    assert w.kind is ErrorKind.TRANSIENT
    assert w.code == "oom"


def test_classify_unknown_defaults_transient():
    w = classify(RuntimeError("weird"))
    assert w.kind is ErrorKind.TRANSIENT
    assert w.code == "uncategorized"
