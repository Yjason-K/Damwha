import threading

from damwha_worker import reaper


def test_reaper_loop_retries_after_database_error(monkeypatch):
    shutdown = threading.Event()
    calls = []

    class Connection:
        def close(self):
            calls.append("close")

    monkeypatch.setattr(reaper.db, "connect", lambda url: Connection())

    def _reap_stale(conn, stale_minutes):
        calls.append(stale_minutes)
        if calls.count(stale_minutes) == 1:
            raise RuntimeError("db unavailable")
        shutdown.set()
        return 0, 0

    monkeypatch.setattr(reaper.db, "reap_stale", _reap_stale)

    reaper.run_reaper_loop("postgresql://unused", 30, 0.001, shutdown)

    assert calls.count(30) == 2
