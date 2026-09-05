import pydantic
import pytest

from damwha_worker.config import Settings, load_settings

_REQUIRED = {
    "DATABASE_URL": "postgres://u:p@localhost:5432/db",
    "LENS_LLM_BASE_URL": "http://127.0.0.1:8000/v1",
}


@pytest.fixture(autouse=True)
def _required_env(monkeypatch):
    # env_file=".env"를 읽으므로, 로컬 .env가 있고 없고에 따라 결과가 달라지지 않도록
    # 필수 값은 테스트가 직접 넣는다.
    for k, v in _REQUIRED.items():
        monkeypatch.setenv(k, v)


def test_loads_settings_from_env():
    s = load_settings()
    assert s.database_url.endswith("/db")
    assert s.poll_interval_seconds == 2.0  # default


def test_default_speaker_prefix_default_and_strip(monkeypatch):
    s = load_settings()
    assert s.default_speaker_prefix == "Speaker"  # default
    monkeypatch.setenv("DEFAULT_SPEAKER_PREFIX", "  화자  ")
    assert load_settings().default_speaker_prefix == "화자"  # stripped


def test_default_speaker_prefix_rejects_blank(monkeypatch):
    monkeypatch.setenv("DEFAULT_SPEAKER_PREFIX", "   ")
    with pytest.raises(pydantic.ValidationError):
        load_settings()


def test_lens_llm_base_url_is_required(monkeypatch):
    # 기본값이 있으면 "주소 미설정"이 조용히 넘어가 첫 렌즈/요약 job에서야 드러난다.
    # _env_file=None으로 로컬 .env를 배제해야 CI와 개발 머신에서 같은 결과가 나온다.
    monkeypatch.delenv("LENS_LLM_BASE_URL", raising=False)
    with pytest.raises(pydantic.ValidationError, match="lens_llm_base_url"):
        Settings(_env_file=None)


def test_meeting_timezone_defaults_to_seoul():
    assert load_settings().meeting_timezone == "Asia/Seoul"


def test_unknown_meeting_timezone_fails_at_startup(monkeypatch):
    # 오타를 렌즈 job claim 이후에 터뜨리면 설정 오류가 job 실패로 분류돼 나타난다.
    monkeypatch.setenv("MEETING_TIMEZONE", "Asia/Seuol")
    with pytest.raises(pydantic.ValidationError):
        load_settings()


def test_live_max_minutes_defaults_to_four_hours(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x")
    monkeypatch.setenv("LENS_LLM_BASE_URL", "http://127.0.0.1:8000/v1")
    from damwha_worker.config import Settings

    assert Settings(_env_file=None).live_max_minutes == 240.0
    monkeypatch.setenv("LIVE_MAX_MINUTES", "30")
    assert Settings(_env_file=None).live_max_minutes == 30.0
