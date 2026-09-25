"""download_model·delete_model (모델 다운로드 관리 스펙 §7).

실 DB(`conn`)와 가짜 snapshot으로 돈다.
"""

import errno

import pytest

from damwha_worker import db, errors
from damwha_worker.contracts import ModelJobPayload
from damwha_worker.db import core
from damwha_worker.models import downloads
from damwha_worker.pipeline import model_jobs
from tests.conftest import seed_job

W = "w-test"
_STT_TINY_MLX = {"schema_version": 1, "role": "stt", "name": "tiny", "backend": "mlx"}


@pytest.fixture(autouse=True)
def _clean(conn, monkeypatch):
    monkeypatch.delenv("DAMWHA_SHARED_STATE", raising=False)
    conn.execute("DELETE FROM app_setting WHERE key=%s", (core.MODEL_READINESS_KEY,))
    yield
    conn.execute("DELETE FROM app_setting WHERE key=%s", (core.MODEL_READINESS_KEY,))


def _running(conn, type_, payload):
    jid = seed_job(conn, type=type_, payload=payload, status="running", locked_by=W, attempts=1)
    return conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone()


def _p(**kw):
    return ModelJobPayload.model_validate({"schema_version": 1, **kw})


def _status(conn, jid):
    return conn.execute("SELECT status, error FROM job WHERE id=%s", (jid,)).fetchone()


def test_download_calls_snapshot_with_spec_and_completes(conn):
    job = _running(
        conn,
        "download_model",
        {"schema_version": 1, "role": "search_embedding", "name": "BAAI/bge-m3"},
    )
    calls = []
    out = model_jobs.run_download_model(
        conn,
        job,
        _p(role="search_embedding", name="BAAI/bge-m3"),
        worker_id=W,
        hf_token="t",
        snapshot=lambda **kw: calls.append(kw) or "/tmp/x",
    )
    assert out == "committed"
    assert calls[0]["repo_id"] == "BAAI/bge-m3"
    assert calls[0]["revision"] == "9a0624b896d81da7492a910ffa53731274b6cf3d"
    assert "model.safetensors" in calls[0]["allow_patterns"]
    assert calls[0]["token"] == "t"
    assert _status(conn, job["id"])["status"] == "done"


def test_download_without_spec_uses_name_as_repo(conn):
    job = _running(
        conn, "download_model", {"schema_version": 1, "role": "summary", "name": "org/custom-lens"}
    )
    calls = []
    model_jobs.run_download_model(
        conn,
        job,
        _p(role="summary", name="org/custom-lens"),
        worker_id=W,
        hf_token=None,
        snapshot=lambda **kw: calls.append(kw) or "/x",
    )
    assert calls[0]["repo_id"] == "org/custom-lens"
    assert calls[0].get("allow_patterns") is None


def test_download_already_cancelled_at_start(conn):
    job = _running(conn, "download_model", _STT_TINY_MLX)
    conn.execute("UPDATE job SET stop_requested_at=now() WHERE id=%s", (job["id"],))
    with pytest.raises(downloads.DownloadCancelled):
        model_jobs.run_download_model(
            conn,
            job,
            _p(role="stt", name="tiny", backend="mlx"),
            worker_id=W,
            hf_token=None,
            snapshot=lambda **kw: pytest.fail("must not download"),
        )


def test_download_enospc_is_disk_full(conn):
    job = _running(conn, "download_model", _STT_TINY_MLX)

    def boom(**_kw):
        raise OSError(errno.ENOSPC, "No space left on device")

    with pytest.raises(errors.WorkerError) as ei:
        model_jobs.run_download_model(
            conn,
            job,
            _p(role="stt", name="tiny", backend="mlx"),
            worker_id=W,
            hf_token=None,
            snapshot=boom,
        )
    assert ei.value.code == errors.DISK_FULL
    assert ei.value.kind is errors.ErrorKind.PERMANENT


def test_remove_model_readiness_key_is_atomic_and_scoped(conn):
    core.merge_model_readiness(conn, "a/b", {"state": "failed"}, "w")
    core.merge_model_readiness(conn, "c/d", {"state": "ready"}, "w")
    db.remove_model_readiness_key(conn, "a/b")
    entries = core.read_model_readiness(conn)["entries"]
    assert "a/b" not in entries and "c/d" in entries
    db.remove_model_readiness_key(conn, "missing/key")  # 없는 key는 무해하다


def test_stop_requested(conn):
    job = _running(conn, "download_model", _STT_TINY_MLX)
    assert db.stop_requested(conn, job["id"]) is False
    conn.execute("UPDATE job SET stop_requested_at=now() WHERE id=%s", (job["id"],))
    assert db.stop_requested(conn, job["id"]) is True


def test_handler_final_failure_removes_readiness_key(conn):
    from damwha_worker.jobs import DownloadModelHandler, JobContext

    job = _running(conn, "download_model", _STT_TINY_MLX)
    core.merge_model_readiness(conn, "mlx-community/whisper-tiny", {"state": "failed"}, W)
    ctx = JobContext(storage=None, worker_id=W)
    out = DownloadModelHandler().on_failure(
        conn, job, ctx, {"code": "model_download_failed"}, retry=False
    )
    assert out == "failed"
    assert "mlx-community/whisper-tiny" not in core.read_model_readiness(conn)["entries"]


def test_handler_retry_keeps_readiness_key(conn):
    from damwha_worker.jobs import DownloadModelHandler, JobContext

    job = _running(conn, "download_model", _STT_TINY_MLX)
    core.merge_model_readiness(conn, "mlx-community/whisper-tiny", {"state": "failed"}, W)
    out = DownloadModelHandler().on_failure(
        conn,
        job,
        JobContext(storage=None, worker_id=W),
        {"code": "model_download_failed"},
        retry=True,
    )
    assert out == "requeued"
    assert "mlx-community/whisper-tiny" in core.read_model_readiness(conn)["entries"]


def test_handler_cancel_closes_as_cancelled_without_retry(conn):
    from damwha_worker.jobs import DownloadModelHandler, JobContext

    job = _running(conn, "download_model", _STT_TINY_MLX)
    err = downloads.DownloadCancelled("mlx-community/whisper-tiny").to_json()
    out = DownloadModelHandler().on_failure(
        conn, job, JobContext(storage=None, worker_id=W), err, retry=True
    )
    assert out == "failed"
    row = _status(conn, job["id"])
    assert row["status"] == "failed" and row["error"]["code"] == errors.DOWNLOAD_CANCELLED
