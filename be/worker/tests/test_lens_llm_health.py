import logging

import httpx

from damwha_worker.__main__ import check_lens_llm, log_lens_llm_health


def test_returns_served_model_ids(httpx_mock):
    httpx_mock.add_response(
        json={"data": [{"id": "mlx-community/Qwen3.5-4B-8bit"}, {"id": "other"}]}
    )

    assert check_lens_llm("http://localhost:8000/v1") == [
        "mlx-community/Qwen3.5-4B-8bit",
        "other",
    ]
    assert httpx_mock.get_request().url == "http://localhost:8000/v1/models"


def test_strips_trailing_slash(httpx_mock):
    httpx_mock.add_response(json={"data": []})

    assert check_lens_llm("http://localhost:8000/v1/") == []
    assert httpx_mock.get_request().url == "http://localhost:8000/v1/models"


def test_none_when_server_is_down(httpx_mock):
    httpx_mock.add_exception(httpx.ConnectError("connection refused"))

    assert check_lens_llm("http://localhost:8000/v1") is None


def test_none_on_http_error(httpx_mock):
    httpx_mock.add_response(status_code=500)

    assert check_lens_llm("http://localhost:8000/v1") is None


def test_none_on_unexpected_body(httpx_mock):
    # 다른 서버가 그 포트를 물고 있는 경우 — 200이지만 OpenAI 모양이 아니다.
    httpx_mock.add_response(json={"models": ["a"]})

    assert check_lens_llm("http://localhost:8000/v1") is None


def test_unreachable_server_warns_but_does_not_raise(httpx_mock, caplog):
    # 워커는 떠야 한다 — process_meeting은 LLM을 쓰지 않는다.
    httpx_mock.add_exception(httpx.ConnectError("connection refused"))

    with caplog.at_level(logging.WARNING, logger="damwha_worker"):
        log_lens_llm_health("http://localhost:8000/v1")

    assert "unreachable" in caplog.text
    assert "http://localhost:8000/v1" in caplog.text


def test_reachable_server_logs_served_models(httpx_mock, caplog):
    httpx_mock.add_response(json={"data": [{"id": "mlx-community/Qwen3.5-4B-8bit"}]})

    with caplog.at_level(logging.INFO, logger="damwha_worker"):
        log_lens_llm_health("http://localhost:8000/v1")

    assert "mlx-community/Qwen3.5-4B-8bit" in caplog.text
    assert "unreachable" not in caplog.text


def test_managed_server_absence_is_not_a_warning(httpx_mock, caplog):
    # 워커가 서버를 소유하면 '지금 안 떠 있음'이 정상 상태다 — job 직전에 띄운다.
    httpx_mock.add_exception(httpx.ConnectError("connection refused"))

    with caplog.at_level(logging.INFO, logger="damwha_worker"):
        log_lens_llm_health("http://localhost:8000/v1", managed=True)

    assert "unreachable" not in caplog.text
    assert "worker-managed" in caplog.text
