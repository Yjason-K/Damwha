"""`app_setting.model_inventory` — 세 번째 공유 행 (모델 다운로드 관리 스펙 §4.2)."""

import threading

import pytest

from damwha_worker import db, inventory
from tests.test_cache_scan import make_repo

KEY = db.MODEL_INVENTORY_KEY


@pytest.fixture(autouse=True)
def _clean_rows(conn, monkeypatch):
    monkeypatch.delenv("DAMWHA_SHARED_STATE", raising=False)
    conn.execute("DELETE FROM app_setting WHERE key=%s", (KEY,))
    yield
    conn.execute("DELETE FROM app_setting WHERE key=%s", (KEY,))


def _row(conn):
    r = conn.execute("SELECT value FROM app_setting WHERE key=%s", (KEY,)).fetchone()
    return None if r is None else r["value"]


def test_write_overwrites_whole_row(conn):
    db.write_model_inventory(
        conn, {"scanned_at": "t1", "repos": {"a/b": {"size_bytes": 1, "complete": True}}}
    )
    db.write_model_inventory(conn, {"scanned_at": "t2", "repos": {}})
    assert _row(conn) == {"scanned_at": "t2", "repos": {}}


def test_write_is_skipped_when_shared_state_off(conn, monkeypatch):
    monkeypatch.setenv("DAMWHA_SHARED_STATE", "off")
    db.write_model_inventory(conn, {"scanned_at": "t", "repos": {}})
    assert _row(conn) is None


def test_build_inventory_shape(tmp_path):
    make_repo(tmp_path, "mlx-community/whisper-large-v3-turbo",
              {"config.json": b"{}", "weights.safetensors": b"123"})
    make_repo(tmp_path, "someone/else", {"a.bin": b"1"})
    value = inventory.build_inventory(
        str(tmp_path), lens_model="L", summary_fallback="S"
    )
    assert value["repos"]["mlx-community/whisper-large-v3-turbo"] == {
        "size_bytes": 5, "complete": True
    }
    assert value["repos"]["someone/else"]["complete"] is True
    assert {"role": "stt", "name": "small", "backend": "mlx",
            "repo_id": "mlx-community/whisper-small-mlx"} in value["resolved"]
    assert len(value["resolved"]) == 12  # 6 크기 × 2 백엔드
    assert all(r["role"] == "stt" for r in value["resolved"])
    assert value["approx"]["BAAI/bge-m3"] == 2_293_250_249
    assert value["worker_llm"] == {"lens_model": "L", "summary_fallback": "S"}
    assert isinstance(value["scanned_at"], str) and value["scanned_at"].endswith("Z")


class _Settings:
    database_url = "unused"
    poll_interval_seconds = 0.01
    lens_llm_model = "L"
    summary_llm_model = "S"


class _StopAfter:
    """루프의 `shutdown.wait`를 n번째에 참으로 만든다 — 실제로 기다리지 않는다."""

    def __init__(self, n):
        self.n = n
        self.calls = 0

    def is_set(self):
        return self.calls >= self.n

    def wait(self, _timeout):
        self.calls += 1
        return self.calls >= self.n


def _run(conn, root, *, ticks, clock, writes, fp_seq=None, monkeypatch=None):
    def connect(_url):
        class _C:
            def execute(self, *a, **k):
                writes.append(a[1][1].obj if hasattr(a[1][1], "obj") else a[1][1])
                return conn.execute(*a, **k)

            def close(self):
                pass

        return _C()

    if fp_seq is not None:
        it = iter(fp_seq)
        monkeypatch.setattr(inventory.cache_scan, "fingerprint", lambda _r: next(it))
    inventory.run_inventory_loop(
        "unused", _Settings(), _StopAfter(ticks), root=str(root), interval=0,
        clock=clock, connect=connect,
    )


def test_loop_writes_at_start_then_only_on_change_or_timeout(conn, tmp_path, monkeypatch):
    writes = []
    times = iter([0.0, 10.0, 20.0, 400.0])
    _run(conn, tmp_path, ticks=4, clock=lambda: next(times), writes=writes,
         fp_seq=[("a",), ("a",), ("b",), ("b",)], monkeypatch=monkeypatch)
    # t=0 시작(무조건), t=10 불변(건너뜀), t=20 지문 변화(씀), t=400 5분 경과(씀)
    assert len(writes) == 3


def test_loop_does_not_write_when_scan_raises(conn, tmp_path, monkeypatch):
    writes = []

    def boom(*_a, **_k):
        raise PermissionError("denied")

    monkeypatch.setattr(inventory, "build_inventory", boom)
    _run(conn, tmp_path, ticks=2, clock=lambda: 0.0, writes=writes)
    assert writes == []
    assert _row(conn) is None


def test_loop_writes_real_row(conn, tmp_path):
    make_repo(tmp_path, "BAAI/bge-m3", {"config.json": b"{}"},
              commit="9a0624b896d81da7492a910ffa53731274b6cf3d", ref=None)
    _run(conn, tmp_path, ticks=1, clock=lambda: 0.0, writes=[])
    row = _row(conn)
    assert row["repos"]["BAAI/bge-m3"] == {"size_bytes": 2, "complete": False}
    assert row["worker_llm"]["lens_model"] == "L"


def test_supervisor_main_starts_inventory_thread(monkeypatch):
    """배선 — 부모가 inventory 스레드를 띄운다."""
    from damwha_worker import __main__ as main_mod

    started = []
    real_thread = threading.Thread

    def spy(*args, target=None, **kwargs):
        started.append(target)
        return real_thread(target=lambda *a, **k: None)

    # run_supervisor_main은 SIGINT/SIGTERM 핸들러를 설치한다 —
    # 테스트 프로세스의 핸들러를 바꾸지 않게.
    monkeypatch.setattr(main_mod.signal, "signal", lambda *a, **k: None)
    monkeypatch.setattr(main_mod.threading, "Thread", spy)
    monkeypatch.setattr(main_mod, "run_supervisor", lambda *a, **k: None)
    monkeypatch.setattr(main_mod, "log_lens_llm_health", lambda *a, **k: None)

    class S(_Settings):
        worker_id = "w"
        reaper_stale_minutes = 30
        reaper_interval_seconds = 60
        lens_llm_base_url = "http://127.0.0.1:1/v1"
        lens_llm_managed = False

    main_mod.run_supervisor_main(S(), threading.Event(), run_id=None)
    assert inventory.run_inventory_loop in started
