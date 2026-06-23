from damwha_worker.config import load_settings


def test_loads_settings_from_env(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@localhost:5432/db")
    monkeypatch.setenv("DEVICE", "cpu")
    s = load_settings()
    assert s.database_url.endswith("/db")
    assert s.device == "cpu"
    assert s.poll_interval_seconds == 2.0  # default
