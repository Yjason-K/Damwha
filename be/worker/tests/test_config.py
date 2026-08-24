import pydantic

from damwha_worker.config import load_settings


def test_loads_settings_from_env(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@localhost:5432/db")
    s = load_settings()
    assert s.database_url.endswith("/db")
    assert s.poll_interval_seconds == 2.0  # default


def test_default_speaker_prefix_default_and_strip(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@localhost:5432/db")
    s = load_settings()
    assert s.default_speaker_prefix == "Speaker"  # default
    monkeypatch.setenv("DEFAULT_SPEAKER_PREFIX", "  화자  ")
    assert load_settings().default_speaker_prefix == "화자"  # stripped


def test_default_speaker_prefix_rejects_blank(monkeypatch):
    import pytest

    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@localhost:5432/db")
    monkeypatch.setenv("DEFAULT_SPEAKER_PREFIX", "   ")
    with pytest.raises(pydantic.ValidationError):
        load_settings()
