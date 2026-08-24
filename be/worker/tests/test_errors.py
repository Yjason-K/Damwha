from damwha_worker.contracts import UnsupportedPayloadVersion
from damwha_worker.errors import OOM, ErrorKind, WorkerError, classify


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


def test_mps_oom_runtimeerror_classified_as_oom():
    exc = RuntimeError("MPS backend out of memory (MPS allocated: 4.01 GiB, ...)")
    werr = classify(exc)
    assert werr.code == OOM
    assert werr.kind is ErrorKind.TRANSIENT


def test_classify_unknown_defaults_transient():
    w = classify(RuntimeError("weird"))
    assert w.kind is ErrorKind.TRANSIENT
    assert w.code == "uncategorized"


def test_classify_import_error_is_permanent():
    w = classify(ModuleNotFoundError("No module named 'sentence_transformers'"))
    assert w.kind is ErrorKind.PERMANENT
    assert w.code == "model_load_failed"


def test_classify_plain_import_error_is_permanent():
    w = classify(ImportError("cannot import name 'X'"))
    assert w.kind is ErrorKind.PERMANENT
    assert w.code == "model_load_failed"
