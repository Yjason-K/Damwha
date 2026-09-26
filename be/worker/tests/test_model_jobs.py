"""download_model·delete_model (모델 다운로드 관리 스펙 §7).

실 DB(`conn`)와 가짜 snapshot으로 돈다.
"""

import errno
import threading

import pytest

from damwha_worker import db, errors
from damwha_worker.contracts import ModelJobPayload
from damwha_worker.db import core
from damwha_worker.models import downloads
from damwha_worker.pipeline import model_jobs
from tests.conftest import seed_job
from tests.test_cache_scan import make_repo

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


def test_download_cancels_mid_download_via_stop_requested(conn, conn2, monkeypatch):
    """호출자 스레드가 훅과 같은 방식(`_run_watched`)으로 `job.stop_requested_at`을 감시한다
    (스펙 §7.2). `cancel_when`에 넘기는 술어를 `lambda: False` 같은 것으로 바꾸면 이 테스트가
    빨개져야 한다 — `snapshot`이 그 술어를 실제로 읽는 `_run_watched`를 통과하게 만든다."""
    monkeypatch.setenv("DAMWHA_SHARED_STATE", "off")
    monkeypatch.setattr(downloads, "_WATCHDOG_TICK_SECONDS", 0.01)
    monkeypatch.setattr(downloads._STATE, "stall_seconds", 1.0)

    job = _running(conn, "download_model", _STT_TINY_MLX)
    gate = threading.Event()

    def blocked(**_kw):
        gate.wait(5)
        return "late"

    def fake_snapshot(**kwargs):
        repo_id = kwargs["repo_id"]
        report = downloads._Report(conn=None, key=repo_id, writer="w")
        return downloads._run_watched(blocked, (), {}, report, repo_id)

    def flip_stop_requested():
        conn2.execute("UPDATE job SET stop_requested_at=now() WHERE id=%s", (job["id"],))

    threading.Timer(0.05, flip_stop_requested).start()
    try:
        with pytest.raises(downloads.DownloadCancelled):
            model_jobs.run_download_model(
                conn,
                job,
                _p(role="stt", name="tiny", backend="mlx"),
                worker_id=W,
                hf_token=None,
                snapshot=fake_snapshot,
            )
    finally:
        gate.set()  # 감시가 버린 백그라운드 스레드를 풀어 스위트에 남기지 않는다


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
    core.merge_model_readiness(conn, "mlx-community/whisper-tiny", {"state": "failed"}, W)
    err = downloads.DownloadCancelled("mlx-community/whisper-tiny").to_json()
    out = DownloadModelHandler().on_failure(
        conn, job, JobContext(storage=None, worker_id=W), err, retry=True
    )
    assert out == "failed"
    row = _status(conn, job["id"])
    assert row["status"] == "failed" and row["error"]["code"] == errors.DOWNLOAD_CANCELLED
    # 취소도 최종 실패와 같은 정리를 받는다 — readiness에 failed가 남으면 desktop 상태 창이
    # 선택 기능의 실패에 "다시 시작"을 권한다 (스펙 §7.4).
    assert "mlx-community/whisper-tiny" not in core.read_model_readiness(conn)["entries"]


def _del(conn, tmp_path, payload, *, lens=("mlx-community/Qwen3.5-4B-8bit",), job=None):
    job = job or _running(conn, "delete_model", payload)
    return job, model_jobs.run_delete_model(
        conn, job, _p(**{k: v for k, v in payload.items() if k != "schema_version"}),
        worker_id=W, lens_models=list(lens), summary_fallback="mlx-community/Qwen3.5-4B-8bit",
        cache_root=str(tmp_path),
    )


def test_delete_removes_repo_dir_and_readiness_key(conn, tmp_path):
    make_repo(tmp_path, "mlx-community/whisper-small-mlx", {"config.json": b"{}"})
    core.merge_model_readiness(conn, "mlx-community/whisper-small-mlx", {"state": "ready"}, W)
    job, out = _del(
        conn, tmp_path, {"schema_version": 1, "role": "stt", "name": "small", "backend": "mlx"}
    )
    assert out == "committed"
    assert not (tmp_path / "models--mlx-community--whisper-small-mlx").exists()
    assert "mlx-community/whisper-small-mlx" not in core.read_model_readiness(conn)["entries"]
    assert _status(conn, job["id"])["status"] == "done"


def test_delete_refuses_fixed_role(conn, tmp_path):
    with pytest.raises(errors.WorkerError) as ei:
        _del(conn, tmp_path, {"schema_version": 1, "role": "diarization",
                              "name": "pyannote/speaker-diarization-community-1"})
    assert ei.value.code == errors.MODEL_NOT_DELETABLE


def test_delete_refuses_model_used_by_queued_job_and_keeps_files(conn, tmp_path):
    make_repo(tmp_path, "mlx-community/whisper-small-mlx", {"config.json": b"{}"})
    seed_job(conn, type="process_meeting", payload={
        "schema_version": 5,
        "models": {"whisper_model": "small", "devices": {"diarization": "gpu", "stt": "gpu"},
                   "summary_model": "mlx-community/Qwen3.5-9B-8bit"},
        "followups": {"lens": True, "summary": True},
    })
    with pytest.raises(errors.WorkerError) as ei:
        _del(
            conn, tmp_path,
            {"schema_version": 1, "role": "stt", "name": "small", "backend": "mlx"},
        )
    assert ei.value.code == errors.MODEL_IN_USE
    assert (tmp_path / "models--mlx-community--whisper-small-mlx").exists()


def test_delete_excludes_itself_and_missing_dir_is_fine(conn, tmp_path):
    _job, out = _del(conn, tmp_path, {"schema_version": 1, "role": "summary",
                                      "name": "mlx-community/Qwen3.5-27B-8bit"})
    assert out == "committed"  # 폴더가 이미 없어도 성공 — 결과(없음)가 같다


def test_delete_refuses_lens_model(conn, tmp_path):
    seed_job(conn, type="process_meeting", payload={
        "schema_version": 5,
        "models": {"whisper_model": "small", "devices": {"diarization": "gpu", "stt": "gpu"},
                   "summary_model": "mlx-community/Qwen3.5-9B-8bit"},
        "followups": {"lens": True, "summary": True},
    })
    with pytest.raises(errors.WorkerError) as ei:
        _del(
            conn, tmp_path,
            {"schema_version": 1, "role": "summary", "name": "mlx-community/Qwen3.5-4B-8bit"},
        )
    assert ei.value.code == errors.MODEL_IN_USE


def test_delete_rmtree_permission_error_is_permanent_and_keeps_readiness_key(
    conn, tmp_path, monkeypatch
):
    """스펙 §7.3·§8 — 삭제 도중 실패(권한 등)는 PERMANENT다. rmtree가 그대로 던지면
    `errors.classify`가 uncategorized TRANSIENT로 잘못 분류한다(리뷰 지적, fix round 1)."""
    make_repo(tmp_path, "mlx-community/whisper-small-mlx", {"config.json": b"{}"})
    core.merge_model_readiness(conn, "mlx-community/whisper-small-mlx", {"state": "ready"}, W)

    def _boom(_path):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(model_jobs.shutil, "rmtree", _boom)
    with pytest.raises(errors.WorkerError) as ei:
        _del(
            conn, tmp_path,
            {"schema_version": 1, "role": "stt", "name": "small", "backend": "mlx"},
        )
    assert ei.value.code == errors.MODEL_DELETE_FAILED
    assert ei.value.kind is errors.ErrorKind.PERMANENT
    # 실패했으니 readiness key는 그대로 남아야 한다 — 성공했을 때만 지운다.
    assert "mlx-community/whisper-small-mlx" in core.read_model_readiness(conn)["entries"]
