"""HF 다운로드 진행 훅 (스펙 §6.9) — `models/downloads.py`.

훅이 잘못 깔리면 두 방향으로 조용히 틀린다. 이미 import된 소비자(`from huggingface_hub import …`로
이름을 묶어 둔 모듈)를 못 덮으면 진행이 안 올라오고, `sys.modules`를 `getattr`로 훑으면
transformers의 지연 모듈이 서브모듈을 import하다 던진다. 테스트는 그 둘과 멱등·명시
`tqdm_class` 존중·바이트 단위 판별·초당 1회 제한·R-9b(캐시 적중은 `downloading`을 남기지 않는다)를
본다.
"""

import io
import re
import sys
import threading
import time
import types
from types import SimpleNamespace

import httpx
import pytest

from damwha_worker import db, errors
from damwha_worker.db import core
from damwha_worker.errors import ErrorKind
from damwha_worker.models import downloads

hub = pytest.importorskip("huggingface_hub")
from huggingface_hub import _snapshot_download, file_download  # noqa: E402
from huggingface_hub import constants as hub_constants  # noqa: E402
from huggingface_hub import errors as hub_errors  # noqa: E402

KEY = db.MODEL_READINESS_KEY
SHA = "a" * 40


@pytest.fixture
def clean(conn, monkeypatch):
    monkeypatch.delenv("DAMWHA_SHARED_STATE", raising=False)
    conn.execute("DELETE FROM app_setting WHERE key=%s", (KEY,))
    yield
    conn.execute("DELETE FROM app_setting WHERE key=%s", (KEY,))


@pytest.fixture
def hook_db(conn, clean, monkeypatch):
    """훅의 지연 연결을 테스트 DB 연결로 바꾼다. 연결을 연 횟수를 센다."""
    opened = []

    def _open():
        opened.append(1)
        return conn

    monkeypatch.setattr(downloads, "_open_connection", _open)
    return opened


@pytest.fixture
def uninstall(monkeypatch):
    """전역 패치를 테스트마다 되돌린다. monkeypatch보다 먼저 정리되도록 그것에 의존한다."""
    yield
    downloads._uninstall()


@pytest.fixture
def stub_download(monkeypatch, uninstall):
    """설치 **전에** 원본 자리를 가짜로 바꿔, 훅이 그것을 원본으로 잡게 한다."""
    calls = []
    script = {"run": lambda tqdm_class: None, "result": "/cache/snapshot/file"}

    def fake_hf_hub_download(repo_id, filename, *, tqdm_class=None, local_files_only=False, **kw):
        calls.append(
            {
                "repo_id": repo_id,
                "tqdm_class": tqdm_class,
                "local_files_only": local_files_only,
                **kw,
            }
        )
        script["run"](tqdm_class)
        return script["result"]

    monkeypatch.setattr(file_download, "hf_hub_download", fake_hf_hub_download)
    return calls, script


def _row(conn):
    r = conn.execute("SELECT value FROM app_setting WHERE key=%s", (KEY,)).fetchone()
    return None if r is None else r["value"]


def _entry(conn, key="org/m"):
    row = _row(conn)
    return None if row is None else row["entries"].get(key)


def _bytes_bar(tqdm_class, total, chunks, **kw):
    bar = tqdm_class(
        total=total, initial=0, unit="B", unit_scale=True, desc="f", disable=True, **kw
    )
    for n in chunks:
        bar.update(n)
    bar.close()


# ── 설치 ───────────────────────────────────────────────────────────────


def test_consumer_bound_before_install_is_rebound(monkeypatch, uninstall):
    """모듈 수준 `from huggingface_hub import …`는 import 시점에 이름을 묶는다 (§6.9 갈래 2)."""
    original_snap = _snapshot_download.snapshot_download
    original_file = file_download.hf_hub_download
    consumer = types.ModuleType("fake_consumer_bound_early")
    consumer.snapshot_download = original_snap
    consumer.hf_hub_download = original_file
    consumer.unrelated = object()
    monkeypatch.setitem(sys.modules, consumer.__name__, consumer)

    downloads.install_hf_progress_hook("w1")

    assert consumer.snapshot_download is not original_snap
    assert consumer.snapshot_download.__damwha_original__ is original_snap
    assert consumer.hf_hub_download.__damwha_original__ is original_file


def test_consumer_imported_after_install_gets_the_hook(uninstall):
    """아직 import되지 않은 소비자는 원본 자리를 바꿔 덮는다 (갈래 1)."""
    downloads.install_hf_progress_hook("w1")

    late = types.ModuleType("fake_consumer_bound_late")
    exec(
        "from huggingface_hub import hf_hub_download, snapshot_download\n"
        "from huggingface_hub.file_download import hf_hub_download as direct\n",
        late.__dict__,
    )

    for fn in (late.hf_hub_download, late.snapshot_download, late.direct):
        assert hasattr(fn, "__damwha_original__")
    # snapshot_download 안쪽의 hf_hub_download도 같은 이름 자리를 본다
    assert hasattr(_snapshot_download.hf_hub_download, "__damwha_original__")


def test_install_survives_modules_whose_getattr_raises(monkeypatch, uninstall):
    """transformers의 지연 모듈처럼 `__getattr__`가 서브모듈을 import하다 던져도 설치는 성공한다.

    `getattr(mod, name, None)`은 이 모듈에서 ModuleNotFoundError를 던진다 — 기본값은
    AttributeError만 삼킨다. `vars(mod)`는 `__getattr__`를 부르지 않는다.
    """
    touched = []

    lazy = types.ModuleType("fake_lazy_module")

    def _module_getattr(name):
        touched.append(name)
        raise ModuleNotFoundError(f"No module named 'torchvision' (while resolving {name})")

    lazy.__getattr__ = _module_getattr
    with pytest.raises(ModuleNotFoundError):
        getattr(lazy, "snapshot_download", None)  # 전제: getattr 훑기는 여기서 죽는다
    touched.clear()

    class _Hostile:
        __slots__ = ()

        def __getattr__(self, name):
            raise ModuleNotFoundError(name)

    monkeypatch.setitem(sys.modules, lazy.__name__, lazy)
    monkeypatch.setitem(sys.modules, "fake_hostile_object", _Hostile())
    monkeypatch.setitem(sys.modules, "fake_none_entry", None)

    downloads.install_hf_progress_hook("w1")

    assert touched == []
    assert hasattr(hub.hf_hub_download, "__damwha_original__")


def test_install_is_idempotent(monkeypatch, uninstall):
    consumer = types.ModuleType("fake_consumer_idempotent")
    consumer.hf_hub_download = file_download.hf_hub_download
    monkeypatch.setitem(sys.modules, consumer.__name__, consumer)
    original = file_download.hf_hub_download

    downloads.install_hf_progress_hook("w1")
    first = file_download.hf_hub_download
    downloads.install_hf_progress_hook("w1")

    assert file_download.hf_hub_download is first
    assert consumer.hf_hub_download is first
    assert first.__damwha_original__ is original  # 감싼 것을 다시 감싸지 않는다
    assert hub.hf_hub_download is first


def test_uninstall_restores_every_binding(monkeypatch):
    consumer = types.ModuleType("fake_consumer_restore")
    consumer.snapshot_download = _snapshot_download.snapshot_download
    monkeypatch.setitem(sys.modules, consumer.__name__, consumer)
    original = _snapshot_download.snapshot_download

    downloads.install_hf_progress_hook("w1")
    downloads._uninstall()

    assert _snapshot_download.snapshot_download is original
    assert consumer.snapshot_download is original


def test_install_without_huggingface_hub_is_a_no_op(monkeypatch, uninstall):
    monkeypatch.setitem(sys.modules, "huggingface_hub", None)  # import → ImportError

    downloads.install_hf_progress_hook("w1")  # 던지지 않는다


def test_install_failure_is_swallowed_and_leaves_the_originals_alone(
    monkeypatch, uninstall, caplog
):
    """R-9c-b — hub 내부가 바뀌어 붙일 자리가 사라져도, 보고 기능의 실패가 `--once` 자식(아직 job을
    집기 전)이나 gate 서비스인 embed를 죽이면 안 된다. 부분적으로 바꾼 이름은 되돌린다."""
    original_file = file_download.hf_hub_download
    original_snap = _snapshot_download.snapshot_download
    consumer = types.ModuleType("fake_consumer_install_failure")
    consumer.hf_hub_download = original_file
    monkeypatch.setitem(sys.modules, consumer.__name__, consumer)

    def boom(mod):  # 갈래 2(sys.modules 훑기) 도중에 터진다 — 갈래 1은 이미 바꾼 뒤다
        raise RuntimeError("huggingface_hub moved the download functions")

    monkeypatch.setattr(downloads, "_namespace", boom)

    downloads.install_hf_progress_hook("w1")  # 던지지 않는다

    assert file_download.hf_hub_download is original_file
    assert _snapshot_download.snapshot_download is original_snap
    assert consumer.hf_hub_download is original_file
    assert "hf_hub_download" not in vars(hub)  # 지연 속성 자리도 원래대로
    assert downloads._STATE.writer is None
    assert "download progress hook not installed" in caplog.text


def test_downloads_still_work_after_a_failed_install(stub_download, hook_db, conn, monkeypatch):
    calls, script = stub_download
    monkeypatch.setattr(downloads, "_namespace", lambda mod: 1 / 0)
    script["run"] = lambda cls: _bytes_bar(cls, 10, [10]) if cls is not None else None

    downloads.install_hf_progress_hook("w1")

    assert hub.hf_hub_download("org/m", "f.bin") == script["result"]
    assert calls[-1]["tqdm_class"] is None  # 훅이 없으니 원본 그대로 돈다
    assert _row(conn) is None


# ── 호출 경로 ─────────────────────────────────────────────────────────


def test_explicit_tqdm_class_is_respected(stub_download, hook_db, conn):
    """호출자가 `tqdm_class`를 주면 우리 훅은 빠진다 — `snapshot_download` 안쪽의
    `_AggregatedTqdm`, sentence-transformers·faster-whisper의 `disabled_tqdm`이 그렇다.
    그 다운로드의 진행은 **보고되지 않는다** (알려진 한계)."""
    calls, script = stub_download
    downloads.install_hf_progress_hook("w1")

    class Mine:
        def __init__(self, *a, **kw):
            pass

        def update(self, n=1):
            pass

        def close(self):
            pass

    script["run"] = lambda cls: _bytes_bar(cls, 10, [10]) if cls is not Mine else None
    hub.hf_hub_download("org/m", "f.bin", tqdm_class=Mine)

    assert calls[-1]["tqdm_class"] is Mine
    assert _row(conn) is None
    assert hook_db == []


def test_hook_injects_a_hub_tqdm_subclass(stub_download, hook_db):
    calls, _ = stub_download
    downloads.install_hf_progress_hook("w1")

    hub.hf_hub_download("org/m", "f.bin")

    injected = calls[-1]["tqdm_class"]
    assert isinstance(injected, type) and issubclass(injected, hub.utils.tqdm)


def test_local_files_only_calls_pass_through(stub_download, hook_db, conn):
    calls, _ = stub_download
    downloads.install_hf_progress_hook("w1")

    hub.hf_hub_download("org/m", "f.bin", local_files_only=True)

    assert calls[-1]["tqdm_class"] is None
    assert hook_db == []


def test_bytes_are_counted_only_for_byte_bars(stub_download, hook_db, conn):
    """`tqdm_class`는 바이트 바(`unit="B"`)와 파일 수 바 둘 다에 쓰인다."""
    _, script = stub_download

    def run(cls):
        files = cls(range(3), total=3, disable=True)  # thread_map의 파일 수 바 — unit="it"
        for _ in files:
            files.update(1)
        _bytes_bar(cls, 100, [40, 60])

    script["run"] = run
    downloads.install_hf_progress_hook("w1")

    hub.hf_hub_download("org/m", "f.bin")

    entry = _entry(conn)
    assert entry["state"] == "ready"
    assert entry["bytes_done"] == 100
    assert entry["bytes_total"] == 100
    assert entry["writer"] == "w1"
    assert entry["error"] is None


def test_enabled_bars_count_too(stub_download, hook_db, conn):
    _, script = stub_download
    script["run"] = lambda cls: _bytes_bar_enabled(cls)
    downloads.install_hf_progress_hook("w1")

    hub.hf_hub_download("org/m", "f.bin")

    assert _entry(conn)["bytes_done"] == 7


def _bytes_bar_enabled(cls):
    bar = cls(total=7, unit="B", desc="f", disable=False, file=io.StringIO())
    bar.update(3)
    bar.update(4)
    bar.close()


def test_progress_writes_are_throttled_to_one_per_second(stub_download, hook_db, conn, monkeypatch):
    _, script = stub_download
    now = {"t": 100.0}
    monkeypatch.setattr(downloads, "_clock", lambda: now["t"])
    writes = []
    real_merge = core.merge_model_readiness

    def counting_merge(c, key, entry, writer):
        writes.append((now["t"], entry["state"], entry.get("bytes_done")))
        return real_merge(c, key, entry, writer)

    monkeypatch.setattr(core, "merge_model_readiness", counting_merge)

    def run(cls):
        bar = cls(total=10_000, unit="B", disable=True)
        for _ in range(500):  # 같은 순간의 갱신 500번 → 첫 바이트 1회만
            bar.update(1)
        now["t"] += 0.5
        bar.update(1)  # 0.5초 — 아직 안 쓴다
        now["t"] += 0.6
        bar.update(1)  # 1.1초 — 쓴다
        bar.close()

    script["run"] = run
    downloads.install_hf_progress_hook("w1")

    hub.hf_hub_download("org/m", "f.bin")

    assert writes == [
        (100.0, "downloading", 1),
        (101.1, "downloading", 502),
        (101.1, "ready", 502),
    ]


def test_cache_hit_writes_nothing(stub_download, hook_db, conn):
    """R-9b — 바이트가 오가지 않은 호출은 `downloading`을 남기지 않는다 (P4-C9: 두 번째 실행에
    새 downloading 0건). 연결조차 열지 않는다."""
    _, script = stub_download

    def run(cls):  # snapshot_download처럼 바를 만들되 갱신은 없다
        cls(total=0, unit="B", disable=True).close()

    script["run"] = run
    downloads.install_hf_progress_hook("w1")

    hub.hf_hub_download("org/m", "f.bin")

    assert _row(conn) is None
    assert hook_db == []


def test_first_byte_writes_downloading_immediately(stub_download, hook_db, conn):
    _, script = stub_download
    seen = {}

    def run(cls):
        bar = cls(total=100, unit="B", disable=True)
        bar.update(1)
        seen["during"] = _entry(conn)
        bar.close()

    script["run"] = run
    downloads.install_hf_progress_hook("w1")

    hub.hf_hub_download("org/m", "f.bin")

    assert seen["during"]["state"] == "downloading"
    assert seen["during"]["bytes_total"] == 100
    assert seen["during"]["started_at"] <= seen["during"]["updated_at"]


def test_attempt_counts_up_after_a_failure(stub_download, hook_db, conn):
    _, script = stub_download
    downloads.install_hf_progress_hook("w1")

    def fail(cls):
        _bytes_bar(cls, 100, [10])
        raise httpx.ReadTimeout("slow", request=httpx.Request("GET", "https://huggingface.co"))

    script["run"] = fail
    with pytest.raises(httpx.ReadTimeout):
        hub.hf_hub_download("org/m", "f.bin")
    assert _entry(conn)["attempt"] == 1

    script["run"] = lambda cls: _bytes_bar(cls, 100, [100])
    hub.hf_hub_download("org/m", "f.bin")
    assert (_entry(conn)["state"], _entry(conn)["attempt"]) == ("ready", 2)

    hub.hf_hub_download("org/m", "f.bin")
    assert _entry(conn)["attempt"] == 1  # ready 다음은 다시 1


# ── 실패 ──────────────────────────────────────────────────────────────


def _http_error(cls, status, repo="org/m"):
    resp = httpx.Response(status, request=httpx.Request("GET", f"https://huggingface.co/{repo}"))
    return cls(f"{status} error for {repo}", response=resp)


@pytest.mark.parametrize(
    ("status", "code"), [(401, errors.HF_TOKEN_INVALID), (403, errors.HF_GATE_NOT_ACCEPTED)]
)
def test_auth_failure_is_recorded_permanent_and_reraised(
    stub_download, hook_db, conn, status, code
):
    _, script = stub_download
    exc = _http_error(hub_errors.GatedRepoError, status)

    def run(cls):
        raise exc

    script["run"] = run
    downloads.install_hf_progress_hook("w1")

    with pytest.raises(hub_errors.GatedRepoError) as caught:
        hub.hf_hub_download("org/m", "config.yaml")

    assert caught.value is exc
    entry = _entry(conn)
    assert entry["state"] == "failed"
    assert entry["error_kind"] == ErrorKind.PERMANENT.value
    assert entry["error"].startswith(f"{code}: ")
    assert entry["bytes_done"] == 0


def test_network_failure_mid_transfer_is_recorded_transient(stub_download, hook_db, conn):
    _, script = stub_download

    def run(cls):
        _bytes_bar(cls, 100, [30])
        raise httpx.RemoteProtocolError("peer closed connection")

    script["run"] = run
    downloads.install_hf_progress_hook("w1")

    with pytest.raises(httpx.RemoteProtocolError):
        hub.hf_hub_download("org/m", "f.bin")

    entry = _entry(conn)
    assert entry["state"] == "failed"
    assert entry["error_kind"] == ErrorKind.TRANSIENT.value
    assert entry["error"].startswith(f"{errors.MODEL_DOWNLOAD_FAILED}: ")
    assert (entry["bytes_done"], entry["bytes_total"]) == (30, 100)


def test_missing_file_on_the_hub_is_not_a_failure(stub_download, hook_db, conn):
    """transformers는 없는 선택 파일(adapter_config.json …)을 매번 물어보고 404를 삼킨다."""
    _, script = stub_download

    def run(cls):
        raise _http_error(hub_errors.RemoteEntryNotFoundError, 404)

    script["run"] = run
    downloads.install_hf_progress_hook("w1")

    with pytest.raises(hub_errors.RemoteEntryNotFoundError):
        hub.hf_hub_download("org/m", "adapter_config.json")

    assert _row(conn) is None


def test_db_failure_never_breaks_the_download(stub_download, monkeypatch, clean, caplog):
    _, script = stub_download

    class _Broken:
        closed = False

        def execute(self, *a, **kw):
            raise RuntimeError("db is gone")

        def close(self):
            self.closed = True

    monkeypatch.setattr(downloads, "_open_connection", lambda: _Broken())
    script["run"] = lambda cls: _bytes_bar(cls, 100, [50, 50])
    downloads.install_hf_progress_hook("w1")

    assert hub.hf_hub_download("org/m", "f.bin") == script["result"]
    assert "model_readiness" in caplog.text


def test_unreachable_db_never_breaks_the_download(stub_download, monkeypatch, clean):
    _, script = stub_download

    def _refuse():
        raise OSError("connection refused")

    monkeypatch.setattr(downloads, "_open_connection", _refuse)
    script["run"] = lambda cls: _bytes_bar(cls, 100, [50, 50])
    downloads.install_hf_progress_hook("w1")

    assert hub.hf_hub_download("org/m", "f.bin") == script["result"]


def test_shared_state_off_never_opens_a_connection(stub_download, hook_db, conn, monkeypatch):
    _, script = stub_download
    monkeypatch.setenv("DAMWHA_SHARED_STATE", "off")
    script["run"] = lambda cls: _bytes_bar(cls, 100, [100])
    downloads.install_hf_progress_hook("w1")

    hub.hf_hub_download("org/m", "f.bin")

    assert hook_db == []
    assert _row(conn) is None


# ── 실제 huggingface_hub 경로 (네트워크 없음) ─────────────────────────


def _cache(tmp_path, repo="org/m"):
    folder = tmp_path / f"models--{repo.replace('/', '--')}"
    (folder / "snapshots" / SHA).mkdir(parents=True)
    (folder / "refs").mkdir()
    (folder / "refs" / "main").write_text(SHA)
    return folder


def test_real_cache_hit_through_the_hook_writes_nothing(tmp_path, hook_db, conn, uninstall):
    folder = _cache(tmp_path)
    (folder / "snapshots" / SHA / "config.json").write_text("{}")
    downloads.install_hf_progress_hook("w1")

    path = hub.hf_hub_download("org/m", "config.json", revision=SHA, cache_dir=tmp_path)

    assert path == str(folder / "snapshots" / SHA / "config.json")
    assert _row(conn) is None
    assert hook_db == []


def test_offline_miss_of_a_known_missing_file_is_not_a_failure(
    tmp_path, hook_db, conn, monkeypatch, uninstall
):
    """오프라인에서 `.no_exist`가 기록한 선택 파일을 물으면 hub는 LocalEntryNotFoundError를 던지고
    호출자가 삼킨다 — 이미 받은 모델을 `failed`로 적으면 안 된다."""
    folder = _cache(tmp_path)
    (folder / ".no_exist" / SHA).mkdir(parents=True)
    (folder / ".no_exist" / SHA / "adapter_config.json").touch()
    monkeypatch.setattr(hub_constants, "HF_HUB_OFFLINE", True)
    downloads.install_hf_progress_hook("w1")

    with pytest.raises(hub_errors.LocalEntryNotFoundError):
        hub.hf_hub_download("org/m", "adapter_config.json", cache_dir=tmp_path)

    assert _row(conn) is None


def test_offline_miss_of_a_needed_file_is_a_transient_failure(
    tmp_path, hook_db, conn, monkeypatch, uninstall
):
    _cache(tmp_path)
    monkeypatch.setattr(hub_constants, "HF_HUB_OFFLINE", True)
    downloads.install_hf_progress_hook("w1")

    with pytest.raises(hub_errors.LocalEntryNotFoundError):
        hub.hf_hub_download("org/m", "model.safetensors", cache_dir=tmp_path)

    entry = _entry(conn)
    assert entry["state"] == "failed"
    assert entry["error_kind"] == ErrorKind.TRANSIENT.value


# ── report_download (계약 절의 컨텍스트 매니저) ─────────────────────


def test_report_download_records_ready_after_bytes(conn, clean):
    with downloads.report_download(conn, "org/m", "embed") as report:
        report.progress(10, 40)
        report.progress(30, 40)

    entry = _entry(conn)
    assert (entry["state"], entry["bytes_done"], entry["bytes_total"]) == ("ready", 40, 40)
    assert entry["writer"] == "embed"


def test_report_download_without_bytes_writes_nothing(conn, clean):
    with downloads.report_download(conn, "org/m", "embed"):
        pass

    assert _row(conn) is None


def test_report_download_records_failure_and_reraises(conn, clean):
    exc = OSError("disk full")
    with pytest.raises(OSError) as caught:
        with downloads.report_download(conn, "org/m", "embed"):
            raise exc

    assert caught.value is exc
    entry = _entry(conn)
    assert entry["state"] == "failed"
    assert entry["error_kind"] == ErrorKind.TRANSIENT.value
    assert "disk full" in entry["error"]


def test_zero_byte_cache_hit_never_overwrites_an_earlier_failure(conn, clean):
    """R-9c-e — 삼켜진 실패 뒤의 0바이트 적중이 `ready`를 쓰면, 곧 실패할 job과 화면이 어긋난다.

    적중은 "이 파일이 캐시에 있다"일 뿐 "그 모델이 멀쩡하다"가 아니다. 남은 `failed`는 그 key를
    **실제로 다시 받는** 다음 다운로드만 덮는다.
    """
    with pytest.raises(OSError):
        with downloads.report_download(conn, "org/half", "embed"):
            raise OSError("weights download died")
    failed = _entry(conn, "org/half")
    assert failed["state"] == "failed"

    with downloads.report_download(conn, "org/half", "embed"):
        pass  # 다른 파일이 캐시에 있었다 — 바이트 0

    after = _entry(conn, "org/half")
    assert after["state"] == "failed"
    assert after["error"] == failed["error"]
    assert after["bytes_done"] == 0

    with downloads.report_download(conn, "org/half", "embed") as report:
        report.progress(40, 40)  # 진짜로 다시 받았다

    recovered = _entry(conn, "org/half")
    assert (recovered["state"], recovered["bytes_done"]) == ("ready", 40)
    assert recovered["attempt"] == 2  # 실패 뒤의 재시도로 센다


# ── 설치 지점 ────────────────────────────────────────────────────────


def test_once_child_installs_the_hook_before_the_job(monkeypatch, tmp_path):
    """`--once` 자식 — writer는 WORKER_ID (R-9a). 무거운 import는 job 안(wiring 빌더)이다."""
    from damwha_worker import __main__ as worker_main

    order = []
    monkeypatch.setattr(worker_main.signal, "signal", lambda *a: None)
    monkeypatch.setattr(
        downloads, "install_hf_progress_hook", lambda writer: order.append(("hook", writer))
    )
    monkeypatch.setattr(worker_main, "run_single_job", lambda *a, **kw: order.append("job") or 3)
    settings = SimpleNamespace(
        worker_id="worker-9", storage_root=str(tmp_path), database_url="postgresql://unused"
    )

    assert worker_main.run_child(settings, threading.Event()) == 3
    assert order == [("hook", "worker-9"), "job"]


def test_the_three_call_sites_are_plain(monkeypatch):
    """가드는 훅 안에 있다 (R-9c-b). 호출부가 다시 `try`로 감싸이면 "실패는 훅이 삼킨다"는 계약이
    두 곳으로 갈리고, 되돌아가도 아무 테스트가 깨지지 않는다 — 실제로 한 번 그렇게 되돌아갔다."""
    import inspect

    from damwha_worker import __main__ as worker_main
    from damwha_worker import embed_service, llm_entry

    pytest.importorskip("fastapi")
    for fn in (worker_main.run_child, embed_service.main, llm_entry.main):
        src = inspect.getsource(fn)
        assert "install_hf_progress_hook" in src, fn
        assert "try" not in src, fn


def test_embed_main_installs_the_hook_before_loading_the_model(monkeypatch):
    """embed — writer는 리터럴 `embed` (R-9a). 로깅 → 런타임 보고 → 훅 → 적재 → uvicorn."""
    pytest.importorskip("fastapi")
    from damwha_worker import embed_service

    order = []
    monkeypatch.setattr(
        embed_service.console, "install_logging", lambda level: order.append("logging")
    )
    monkeypatch.setattr(
        downloads, "install_hf_progress_hook", lambda writer: order.append(("hook", writer))
    )
    settings = SimpleNamespace(embed_service_host="127.0.0.1", embed_service_port=1)
    monkeypatch.setattr(embed_service, "_service", lambda: order.append("load") or (settings, None))
    fake_uvicorn = types.ModuleType("uvicorn")
    fake_uvicorn.run = lambda app, host, port: order.append("serve")
    monkeypatch.setitem(sys.modules, "uvicorn", fake_uvicorn)

    embed_service.main()

    assert order == ["logging", ("hook", "embed"), "load", "serve"]


# ── bge-m3: 리비전 고정 + safetensors 한정 (P4-C10) ─────────────────


@pytest.fixture
def fake_sentence_transformers(monkeypatch):
    captured = {}

    class SentenceTransformer:
        def __init__(self, name, **kw):
            captured.update(name=name, **kw)

    mod = types.ModuleType("sentence_transformers")
    mod.SentenceTransformer = SentenceTransformer
    monkeypatch.setitem(sys.modules, "sentence_transformers", mod)
    return captured


def test_bge_m3_loads_one_pinned_safetensors_revision(fake_sentence_transformers, monkeypatch):
    from damwha_worker.models.bge_embed import BgeM3TextEmbedder

    had = "torchcodec" in sys.modules
    monkeypatch.delitem(sys.modules, "torchcodec", raising=False)
    try:
        BgeM3TextEmbedder("BAAI/bge-m3")
        # Part 1 §8.1의 사장 dylib 우회가 그대로 남아 있다
        assert "torchcodec" in sys.modules and sys.modules["torchcodec"] is None
    finally:
        if not had:
            sys.modules.pop("torchcodec", None)

    got = fake_sentence_transformers
    assert got["name"] == "BAAI/bge-m3"
    assert got["revision"] == "9a0624b896d81da7492a910ffa53731274b6cf3d"
    assert re.fullmatch(r"[0-9a-f]{40}", got["revision"])
    assert got["model_kwargs"] == {"use_safetensors": True}
    assert got["device"] == "cpu"


def test_other_embedding_models_are_not_pinned_but_stay_safetensors_only(
    fake_sentence_transformers, monkeypatch
):
    from damwha_worker.models.bge_embed import BgeM3TextEmbedder

    monkeypatch.setitem(sys.modules, "torchcodec", None)
    BgeM3TextEmbedder("org/other-model")

    assert fake_sentence_transformers["revision"] is None
    assert fake_sentence_transformers["model_kwargs"] == {"use_safetensors": True}


# ── 유한 타임아웃 (스펙 §6.6-b) ───────────────────────────────────────


@pytest.fixture
def clear_hf_env(monkeypatch):
    for name in downloads.HF_LIMIT_ENV_KEYS:
        monkeypatch.delenv(name, raising=False)


def test_apply_hf_limits_puts_a_finite_bound_on_every_layer(clear_hf_env, uninstall):
    import os

    downloads.apply_hf_limits()

    values = {name: os.environ.get(name) for name in downloads.HF_LIMIT_ENV_KEYS}
    assert all(v is not None and int(v) > 0 for v in values.values()), values
    # 라이브러리 기본값과 달라야 hub가 호출자의 etag_timeout을 이 값으로 덮는다
    # (file_download.py:959-961).
    assert hub_constants.HF_HUB_ETAG_TIMEOUT != hub_constants.DEFAULT_ETAG_TIMEOUT
    assert hub_constants.HF_HUB_ETAG_TIMEOUT == int(values["HF_HUB_ETAG_TIMEOUT"])
    assert hub_constants.HF_HUB_DOWNLOAD_TIMEOUT == int(values["HF_HUB_DOWNLOAD_TIMEOUT"])


def test_apply_hf_limits_bounds_the_shared_client(clear_hf_env, uninstall):
    """`snapshot_download`의 `repo_info`에는 방어가 없다 — 공유 클라이언트가 유일한 상한이다."""
    downloads.apply_hf_limits()

    timeout = hub.get_session().timeout
    assert timeout.read is not None and timeout.read > 0
    assert timeout.connect is not None and timeout.connect > 0


def test_installing_the_hook_applies_the_limits(clear_hf_env, stub_download, hook_db):
    import os

    downloads.install_hf_progress_hook("w1")

    assert os.environ["HF_HUB_ETAG_TIMEOUT"] == str(downloads._STATE.limits.etag_timeout)
    assert downloads._STATE.stall_seconds > 0


def test_an_env_value_from_outside_wins(clear_hf_env, uninstall, monkeypatch):
    """앱이나 운영자가 명시한 값을 덮지 않는다 — 워커 설정은 그 자리가 빌 때의 진실 원천이다."""
    import os

    monkeypatch.setenv("HF_HUB_ETAG_TIMEOUT", "7")
    downloads.apply_hf_limits()

    assert os.environ["HF_HUB_ETAG_TIMEOUT"] == "7"
    assert hub_constants.HF_HUB_ETAG_TIMEOUT == 7


# ── 무진행 감시 (스펙 §6.9 무진행 규칙, R4-15) ────────────────────────


def test_a_stalled_download_ends_as_transient(stub_download, hook_db, conn, monkeypatch):
    """진행이 멈춘 다운로드는 유한 시간에 TRANSIENT 실패로 끝나 `--once` 자식을 풀어 준다."""
    _, script = stub_download
    release = threading.Event()
    script["run"] = lambda cls: release.wait(10)
    monkeypatch.setattr(downloads, "_WATCHDOG_TICK_SECONDS", 0.01)
    downloads.install_hf_progress_hook("w1")
    downloads._STATE.stall_seconds = 0.2

    with pytest.raises(errors.WorkerError) as raised:
        hub.hf_hub_download("org/m", "f.bin")
    release.set()

    assert raised.value.kind is ErrorKind.TRANSIENT
    assert raised.value.code == errors.MODEL_DOWNLOAD_FAILED
    entry = _entry(conn)
    assert entry["state"] == "failed"
    assert entry["error_kind"] == ErrorKind.TRANSIENT.value


def test_a_progressing_download_is_left_alone(stub_download, hook_db, conn, monkeypatch):
    """감시 기준은 Task 9의 훅이 올리는 진행이다 — 흐르고 있으면 발화하지 않는다."""
    _, script = stub_download

    def run(cls):
        bar = cls(total=50, initial=0, unit="B", desc="f", disable=True)
        for _ in range(5):
            time.sleep(0.1)
            bar.update(10)
        bar.close()

    script["run"] = run
    monkeypatch.setattr(downloads, "_WATCHDOG_TICK_SECONDS", 0.01)
    downloads.install_hf_progress_hook("w1")
    downloads._STATE.stall_seconds = 0.4

    assert hub.hf_hub_download("org/m", "f.bin") == script["result"]
    entry = _entry(conn)
    assert entry["state"] == "ready" and entry["bytes_done"] == 50


def test_a_late_progress_update_cannot_revive_a_stalled_entry(
    stub_download, hook_db, conn, monkeypatch
):
    """감시가 끝낸 다운로드의 스레드는 버려진다 — 뒤늦은 진행이 `failed`를 되돌리면 안 된다."""
    _, script = stub_download
    seen = {}
    release = threading.Event()

    def run(cls):
        seen["bar"] = cls(total=50, initial=0, unit="B", desc="f", disable=True)
        release.wait(10)
        seen["bar"].update(10)

    script["run"] = run
    monkeypatch.setattr(downloads, "_WATCHDOG_TICK_SECONDS", 0.01)
    downloads.install_hf_progress_hook("w1")
    downloads._STATE.stall_seconds = 0.2

    with pytest.raises(errors.WorkerError):
        hub.hf_hub_download("org/m", "f.bin")
    release.set()
    time.sleep(0.1)

    assert _entry(conn)["state"] == "failed"


# ── R-9d: 캐시로 적재에 성공하면 `ready`를 적는다 ─────────────────────


def test_a_cache_first_load_clears_a_stale_failure(conn, clean, hook_db, stub_download):
    """Task 9의 훅은 바이트가 오간 다운로드만 `ready`를 쓴다(R-9b). 그래서 옛 `failed`가 캐시로
    잘 뜨는 모델에 붙어 있게 되고 화면이 거짓 실패를 보인다 — 로더가 통째로 적재에 성공한
    이 자리가 그것을 지운다."""
    downloads.install_hf_progress_hook("w1")
    core.merge_model_readiness(
        conn, "org/m", {"state": "failed", "error": "boom", "error_kind": "TRANSIENT"}, "w1"
    )

    downloads.load_cache_first("org/m", lambda **_: "loaded")

    entry = _entry(conn)
    assert entry["state"] == "ready"
    assert entry["error"] is None and entry["error_kind"] is None
    assert entry["writer"] == "w1"


def test_a_cache_first_load_writes_nothing_without_a_hook(conn, clean):
    downloads.load_cache_first("org/m", lambda **_: "loaded")

    assert _row(conn) is None


def test_a_cache_first_load_writes_nothing_when_shared_state_is_off(
    conn, clean, hook_db, stub_download, monkeypatch
):
    downloads.install_hf_progress_hook("w1")
    monkeypatch.setenv("DAMWHA_SHARED_STATE", "off")

    downloads.load_cache_first("org/m", lambda **_: "loaded")

    assert _row(conn) is None


def test_the_online_fallback_leaves_the_entry_to_the_hook(conn, clean, hook_db, stub_download):
    """캐시 미스는 `ready`가 아니다 — 그 뒤의 실제 다운로드가 훅을 통해 상태를 쓴다."""
    _, script = stub_download
    downloads.install_hf_progress_hook("w1")
    script["run"] = lambda cls: _bytes_bar(cls, 20, [20]) if cls is not None else None

    def load(*, local_files_only):
        if local_files_only:
            raise hub_errors.LocalEntryNotFoundError("nothing cached")
        return hub.hf_hub_download("org/m", "f.bin")

    downloads.load_cache_first("org/m", load)

    entry = _entry(conn)
    assert entry["state"] == "ready" and entry["bytes_done"] == 20


def test_an_explicit_none_timeout_is_bounded_again(clear_hf_env, uninstall):
    """hub의 `model_info`는 `timeout=None`을 명시해 넘긴다 (`hf_api.py:3311`) — httpx에서 그것은
    '상한 없음'이라 클라이언트 기본값을 끈다. 실측: 이 방어가 없으면 먹통 엔드포인트에서
    `snapshot_download`가 300초를 넘겨도 끝나지 않았다."""
    downloads.apply_hf_limits()

    request = hub.get_session().build_request("GET", "https://example.invalid/x", timeout=None)

    bound = request.extensions["timeout"]
    assert bound["read"] is not None and bound["read"] > 0
    assert bound["connect"] is not None and bound["connect"] > 0


# ── 수정 1회차: 개발 DB 차단 · 워치독 경합 · 전역 복원 ────────────────


def test_a_hook_write_cannot_reach_an_ambient_database(uninstall, monkeypatch):
    """훅의 지연 연결은 **주입된 것**이어야 한다.

    실제로 그렇지 않았다: `test_offline_load.py`가 연결을 주입하지 않은 채 훅을 설치해,
    R-9d의 `ready` 쓰기가 `be/worker/.env`의 `DATABASE_URL`(= Docker 개발 DB, 절대 불변)로
    연결을 열고 `app_setting`에 `model_readiness` 한 행을 썼다. `downloads.py`가 DB 오류를
    전부 삼키므로 테스트는 통과했고 아무 신호도 없었다. `conftest`의 autouse 가드 둘이 막는다.
    """
    opened = []
    monkeypatch.setattr(core, "connect", lambda url, **kw: opened.append(url))
    downloads.install_hf_progress_hook("w1")

    downloads.load_cache_first("org/m", lambda **_: "loaded")  # _mark_ready가 쓰려 한다

    assert opened == []


def test_the_suite_never_carries_a_reachable_database_url():
    """`conftest.no_ambient_database`가 env를 닿을 수 없는 주소로 고정한다."""
    from tests.conftest import UNREACHABLE_DSN

    assert downloads._database_url() == UNREACHABLE_DSN


def test_the_watchdog_does_not_kill_a_download_that_just_finished(uninstall, monkeypatch):
    """`wait()`가 False를 돌려준 뒤 판정까지의 사이에 스레드가 끝날 수 있다.

    그 경합에서 감시가 발화하면 성공한 결과를 버리고 TRANSIENT를 던진다. 아래 `report`는
    `last_progress`를 **읽는 순간** 작업 스레드를 끝내고 기다려, 정확히 그 창을 재현한다.
    """
    monkeypatch.setattr(downloads, "_WATCHDOG_TICK_SECONDS", 0.01)
    downloads.apply_hf_limits()
    downloads._STATE.stall_seconds = 0.05
    release, finished = threading.Event(), threading.Event()

    class _RacyReport:
        abandoned = False

        @property
        def last_progress(self):
            release.set()  # 작업 스레드를 풀어 주고
            finished.wait(5)  # 그것이 끝난 뒤에 값을 돌려준다
            return 0.0  # 무한히 오래된 진행 → idle >= limit

        def abandon(self):
            type(self).abandoned = True

    def original():
        release.wait(5)
        try:
            return "done"
        finally:
            finished.set()

    got = downloads._run_watched(lambda: original(), (), {}, _RacyReport(), "org/m")

    assert got == "done"
    assert _RacyReport.abandoned is False


def test_non_byte_progress_still_counts_as_movement(stub_download, hook_db, conn):
    """바이트가 안 흐르는 정상 구간(파일 수 바)을 '무진행'으로 보지 않는다 — 다만 바이트로
    세지도, 항목을 쓰지도 않는다 (Task 9의 계약 그대로)."""
    _, script = stub_download
    seen = {}

    def run(cls):
        bar = cls(total=3, initial=0, unit="it", desc="files", disable=True)
        seen["before"] = downloads._clock()
        time.sleep(0.02)
        bar.update(1)
        bar.close()

    script["run"] = run
    downloads.install_hf_progress_hook("w1")

    hub.hf_hub_download("org/m", "f.bin")

    assert _row(conn) is None  # 바이트가 아니므로 아무것도 안 쓴다


def test_uninstall_restores_the_global_limits(clear_hf_env, monkeypatch):
    """`apply_hf_limits`는 프로세스 전역(env·hub 상수·hub 팩토리)을 고친다 — 되돌리지 않으면
    한 테스트가 고른 값이 스위트 끝까지 남는다."""
    import os

    monkeypatch.setenv("HF_HUB_DOWNLOAD_TIMEOUT", "9")
    etag_before = hub_constants.HF_HUB_ETAG_TIMEOUT
    download_before = hub_constants.HF_HUB_DOWNLOAD_TIMEOUT

    downloads.apply_hf_limits()
    assert os.environ["HF_HUB_ETAG_TIMEOUT"] != ""
    downloads._uninstall()

    assert "HF_HUB_ETAG_TIMEOUT" not in os.environ  # 없던 것은 없던 대로
    assert os.environ["HF_HUB_DOWNLOAD_TIMEOUT"] == "9"  # 있던 것은 그대로
    assert hub_constants.HF_HUB_ETAG_TIMEOUT == etag_before
    assert hub_constants.HF_HUB_DOWNLOAD_TIMEOUT == download_before
