"""`app_setting.model_readiness` — 두 번째 공유 행 (스펙 §6.9).

실제 writer는 supervisor·`--once` 자식·embed·`llm_entry`로 **다른 프로세스**다. 한 연결의 순차
쓰기로는 read-modify-write 경합을 증명할 수 없으므로, 동시성 테스트는 연결 두 개(`conn`·`conn2`)를
실제로 겹쳐 돌린다.
"""

import threading

import httpx
import pytest
from psycopg.types.json import Jsonb

from damwha_worker import db, errors
from damwha_worker.db import core
from damwha_worker.errors import ErrorKind, classify, classify_download

KEY = db.MODEL_READINESS_KEY


@pytest.fixture(autouse=True)
def _clean_rows(conn, monkeypatch):
    # conn fixture는 app_setting을 비우지 않는다 — 이 파일이 만든 행은 여기서 지운다.
    monkeypatch.delenv("DAMWHA_SHARED_STATE", raising=False)
    conn.execute("DELETE FROM app_setting WHERE key IN (%s, %s)", (KEY, db.WORKER_CAPABILITIES_KEY))
    yield
    conn.execute("DELETE FROM app_setting WHERE key IN (%s, %s)", (KEY, db.WORKER_CAPABILITIES_KEY))


def _stamps(monkeypatch, *values):
    """merge가 찍는 시각을 순서대로 고정한다 — '늦게 도착한 옛 쓰기'를 결정적으로 만든다."""
    it = iter(values)
    monkeypatch.setattr(core, "readiness_now", lambda: next(it))


def _row(conn):
    r = conn.execute("SELECT value FROM app_setting WHERE key=%s", (KEY,)).fetchone()
    return None if r is None else r["value"]


def _downloading(**over):
    return {"state": "downloading", "bytes_done": 5, "bytes_total": 10, "attempt": 1, **over}


# ── 한 key ─────────────────────────────────────────────────────────────


def test_single_key_round_trips(conn):
    db.merge_model_readiness(
        conn, "org/a", _downloading(started_at="2026-01-01T00:00:00.000000Z"), "w1"
    )

    value = db.read_model_readiness(conn)
    entry = value["entries"]["org/a"]
    assert entry["state"] == "downloading"
    assert entry["bytes_done"] == 5
    assert entry["bytes_total"] == 10
    assert entry["attempt"] == 1
    assert entry["started_at"] == "2026-01-01T00:00:00.000000Z"
    assert entry["error"] is None
    assert entry["error_kind"] is None
    assert value["updated_at"] == entry["updated_at"]


def test_missing_row_is_created(conn):
    assert _row(conn) is None

    db.merge_model_readiness(conn, "org/a", {"state": "ready"}, "w1")

    value = _row(conn)
    assert set(value) == {"updated_at", "entries"}
    assert set(value["entries"]["org/a"]) == {
        "state",
        "bytes_done",
        "bytes_total",
        "writer",
        "attempt",
        "started_at",
        "updated_at",
        "error",
        "error_kind",
    }


def test_read_without_row_is_empty(conn):
    assert db.read_model_readiness(conn) == {"updated_at": None, "entries": {}}


@pytest.mark.parametrize("stored", [None, "wat", 7, [1, 2], {"entries": "nope"}, {"entries": None}])
def test_read_tolerates_a_value_that_is_not_the_expected_object(conn, stored):
    """R-9c-c — 읽는 쪽(`llm_server._wait_ready`)이 대기 중에 부른다. 남이 넣은 값 하나가
    기다림을 예외로 끝내면 안 된다."""
    conn.execute(
        "INSERT INTO app_setting(key, value) VALUES (%s, %s) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        (KEY, Jsonb(stored)),
    )

    assert db.read_model_readiness(conn) == {"updated_at": None, "entries": {}}


def test_writer_and_updated_at_are_stamped_by_the_function(conn, monkeypatch):
    """호출자가 준 writer·updated_at은 무시된다 — 비교 기준을 호출자에게 맡기지 않는다."""
    _stamps(monkeypatch, "2026-09-18T00:00:01.000000Z")

    db.merge_model_readiness(
        conn, "org/a", _downloading(writer="liar", updated_at="9999-12-31T00:00:00.000000Z"), "w1"
    )

    entry = _row(conn)["entries"]["org/a"]
    assert entry["writer"] == "w1"
    assert entry["updated_at"] == "2026-09-18T00:00:01.000000Z"


def test_timestamps_are_fixed_precision_and_strictly_increasing():
    """사전순 = 시간순이려면 자릿수가 고정이어야 한다 ('…20Z' < '…20.5Z'는 거짓)."""
    stamps = [db.readiness_now() for _ in range(2000)]
    assert len({len(s) for s in stamps}) == 1
    assert all(s.endswith("Z") and len(s) == len("2026-09-18T00:00:00.000000Z") for s in stamps)
    assert stamps == sorted(stamps)
    assert len(set(stamps)) == len(stamps)  # 같은 프로세스 안에서는 동률이 생기지 않는다


def test_state_must_be_known(conn):
    with pytest.raises(ValueError):
        db.merge_model_readiness(conn, "org/a", {"state": "done"}, "w1")


# ── 역전 방지 ──────────────────────────────────────────────────────────


def test_late_downloading_cannot_overwrite_ready(conn, monkeypatch):
    # ready를 먼저 반영했는데, 더 이른 시각에 만들어진 downloading이 뒤늦게 도착한다.
    _stamps(monkeypatch, "2026-09-18T00:00:02.000000Z", "2026-09-18T00:00:01.000000Z")

    db.merge_model_readiness(conn, "org/a", {"state": "ready"}, "embed")
    db.merge_model_readiness(conn, "org/a", _downloading(), "w1")

    entry = _row(conn)["entries"]["org/a"]
    assert entry["state"] == "ready"
    assert entry["writer"] == "embed"


def test_tie_keeps_the_first_write(conn, monkeypatch):
    """`<` 비교 — 같은 시각이면 먼저 쓴 것이 이긴다. `<=`면 동률 진행 갱신이 ready를 덮는다."""
    _stamps(monkeypatch, "2026-09-18T00:00:01.000000Z", "2026-09-18T00:00:01.000000Z")

    db.merge_model_readiness(conn, "org/a", {"state": "ready"}, "embed")
    db.merge_model_readiness(conn, "org/a", _downloading(), "w1")

    assert _row(conn)["entries"]["org/a"]["state"] == "ready"


def test_newer_write_replaces_the_entry(conn, monkeypatch):
    _stamps(monkeypatch, "2026-09-18T00:00:01.000000Z", "2026-09-18T00:00:02.000000Z")

    db.merge_model_readiness(conn, "org/a", _downloading(), "w1")
    db.merge_model_readiness(conn, "org/a", {"state": "ready", "bytes_done": 10}, "w1")

    entry = _row(conn)["entries"]["org/a"]
    assert entry["state"] == "ready"
    assert entry["bytes_done"] == 10


def test_top_level_updated_at_never_goes_back(conn, monkeypatch):
    # 다른 key의 더 오래된 쓰기가 최상위 updated_at을 되돌리지 않는다.
    _stamps(monkeypatch, "2026-09-18T00:00:03.000000Z", "2026-09-18T00:00:01.000000Z")

    db.merge_model_readiness(conn, "org/a", {"state": "ready"}, "w1")
    db.merge_model_readiness(conn, "org/b", {"state": "ready"}, "embed")

    value = _row(conn)
    assert set(value["entries"]) == {"org/a", "org/b"}
    assert value["updated_at"] == "2026-09-18T00:00:03.000000Z"


# ── 동시성: 서로 다른 연결 ────────────────────────────────────────────


def test_two_connections_different_keys_do_not_erase_each_other(conn, conn2):
    db.merge_model_readiness(conn, "org/a", {"state": "ready"}, "w1")
    db.merge_model_readiness(conn2, "org/b", _downloading(), "embed")

    assert set(_row(conn)["entries"]) == {"org/a", "org/b"}


def test_concurrent_writers_on_two_connections_lose_nothing(conn, conn2):
    """두 연결이 동시에 서로 다른 key를 쓴다. 읽고-고치고-쓰면 여기서 key가 사라진다."""
    n = 60
    barrier = threading.Barrier(2)
    failures = []

    def writer(c, prefix, name):
        try:
            barrier.wait()
            for i in range(n):
                db.merge_model_readiness(c, f"{prefix}/{i}", _downloading(bytes_done=i), name)
        except Exception as exc:  # noqa: BLE001
            failures.append(exc)

    threads = [
        threading.Thread(target=writer, args=(conn, "a", "w1")),
        threading.Thread(target=writer, args=(conn2, "b", "embed")),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert failures == []
    entries = _row(conn)["entries"]
    assert len(entries) == 2 * n
    assert entries["a/59"]["writer"] == "w1"
    assert entries["b/59"]["writer"] == "embed"


# ── DAMWHA_SHARED_STATE ───────────────────────────────────────────────


@pytest.mark.parametrize(
    ("value", "enabled"),
    [(None, True), ("on", True), ("", True), ("off", False), ("OFF", False), (" off ", False)],
)
def test_shared_state_switch(monkeypatch, value, enabled):
    if value is None:
        monkeypatch.delenv("DAMWHA_SHARED_STATE", raising=False)
    else:
        monkeypatch.setenv("DAMWHA_SHARED_STATE", value)
    assert db.shared_state_enabled() is enabled


def test_shared_state_off_writes_no_readiness(conn, monkeypatch):
    monkeypatch.setenv("DAMWHA_SHARED_STATE", "off")

    db.merge_model_readiness(conn, "org/a", {"state": "ready"}, "w1")

    assert _row(conn) is None


def test_shared_state_off_writes_no_capabilities(conn, monkeypatch):
    monkeypatch.setenv("DAMWHA_SHARED_STATE", "off")

    db.upsert_worker_capabilities(conn, {"worker_id": "w1", "gpu_eligible": True})

    row = conn.execute(
        "SELECT value FROM app_setting WHERE key=%s", (db.WORKER_CAPABILITIES_KEY,)
    ).fetchone()
    assert row is None


# ── classify_download ────────────────────────────────────────────────


def _hub_error(status):
    hub = pytest.importorskip("huggingface_hub.errors")
    resp = httpx.Response(status, request=httpx.Request("GET", "https://huggingface.co/org/m"))
    return hub.HfHubHTTPError(f"{status} Client Error", response=resp)


@pytest.mark.parametrize("status", [401, 403])
def test_auth_failures_are_permanent(status):
    assert classify_download(_hub_error(status)) is ErrorKind.PERMANENT


def test_gated_repo_error_is_permanent():
    hub = pytest.importorskip("huggingface_hub.errors")
    resp = httpx.Response(403, request=httpx.Request("GET", "https://huggingface.co/pyannote/x"))
    assert classify_download(hub.GatedRepoError("gated", response=resp)) is ErrorKind.PERMANENT


def test_wrapped_auth_failure_is_still_permanent():
    """transformers는 hub 오류를 `OSError(...) from e`로 감싼다 — 사슬을 따라 내려가 본다."""
    try:
        try:
            raise _hub_error(403)
        except Exception as inner:
            raise OSError("You are trying to access a gated repo.") from inner
    except OSError as outer:
        assert classify_download(outer) is ErrorKind.PERMANENT


@pytest.mark.parametrize("status", [500, 502, 503, 429])
def test_server_side_failures_are_transient(status):
    assert classify_download(_hub_error(status)) is ErrorKind.TRANSIENT


def test_network_failures_are_transient():
    req = httpx.Request("GET", "https://huggingface.co/org/m")
    assert classify_download(httpx.ConnectError("refused", request=req)) is ErrorKind.TRANSIENT
    assert classify_download(httpx.ReadTimeout("slow", request=req)) is ErrorKind.TRANSIENT


def test_offline_cache_miss_is_transient():
    hub = pytest.importorskip("huggingface_hub.errors")
    assert classify_download(hub.LocalEntryNotFoundError("not cached")) is ErrorKind.TRANSIENT


def test_classify_routes_download_failures_through_classify_download():
    """`errors.classify`가 다운로드 예외를 `classify_download`로 보낸다 — 401·403이 PERMANENT로
    job을 끝내고, 코드가 두 경우를 가른다 (스펙 §8: 401 재입력 / 403 수락 페이지)."""
    w401 = classify(_hub_error(401))
    w403 = classify(_hub_error(403))
    assert (w401.code, w401.kind) == (errors.HF_TOKEN_INVALID, ErrorKind.PERMANENT)
    assert (w403.code, w403.kind) == (errors.HF_GATE_NOT_ACCEPTED, ErrorKind.PERMANENT)


def test_classify_marks_network_download_failures_transient():
    hub = pytest.importorskip("huggingface_hub.errors")
    w = classify(hub.LocalEntryNotFoundError("connection error and not cached"))
    assert (w.code, w.kind) == (errors.MODEL_DOWNLOAD_FAILED, ErrorKind.TRANSIENT)


def test_classify_leaves_non_download_errors_alone():
    w = classify(RuntimeError("weird"))
    assert (w.code, w.kind) == ("uncategorized", ErrorKind.TRANSIENT)
