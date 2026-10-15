"""embed·LLM 서버의 '브라우저 금지' 판정 (spec 2026-10-08-local-api-access-control §3.8).

두 서버의 클라이언트는 be(Node fetch)·desktop 프로브(Node fetch)·worker(httpx)뿐이라
Origin·Sec-Fetch-Site를 싣지 않는다. 실린 요청은 브라우저다. Host는 rebinding을 막는다.
"""

import pytest

from damwha_worker import browser_guard as bg


def _get(headers):
    lowered = {k.lower(): v for k, v in headers.items()}
    return lambda name: lowered.get(name.lower())


@pytest.mark.parametrize(
    ("header", "want"),
    [
        ("127.0.0.1:8100", "127.0.0.1"),
        ("LOCALHOST:8100", "localhost"),
        ("[::1]:8100", "[::1]"),
        ("attacker@127.0.0.1", None),
        ("", None),
        (None, None),
    ],
)
def test_hostname_of(header, want):
    assert bg.hostname_of(header) == want


@pytest.mark.parametrize("bind", [None, "127.0.0.1", "0.0.0.0", "::", ""])
def test_wildcard_or_loopback_bind_allows_only_loopback(bind):
    assert bg.allowed_hostnames(bind) == bg.LOOPBACK_HOSTS


def test_named_bind_host_is_also_allowed():
    assert bg.allowed_hostnames("Mac-Studio.local") == bg.LOOPBACK_HOSTS | {"mac-studio.local"}


def test_bare_ipv6_bind_is_bracketed():
    assert "[fd00::1]" in bg.allowed_hostnames("fd00::1")


def test_server_client_passes():
    # Node fetch는 sec-fetch-mode를 붙인다(실측) — 그건 브라우저 신호가 아니다.
    assert bg.rejection(_get({"Host": "127.0.0.1:8100", "Sec-Fetch-Mode": "cors"}), None) is None


@pytest.mark.parametrize(
    "headers",
    [
        {"Host": "127.0.0.1:8100", "Origin": "https://evil.example"},
        {"Host": "127.0.0.1:8100", "Origin": "null"},
        {"Host": "127.0.0.1:8100", "Sec-Fetch-Site": "cross-site"},
        {
            "Host": "127.0.0.1:8100",
            "Sec-Fetch-Site": "same-origin",
        },  # rebinding 뒤엔 같은 origin이다
        {"Host": "attacker.example:8100"},
        {},
    ],
)
def test_browser_or_foreign_host_is_rejected(headers):
    assert bg.rejection(_get(headers), None) is not None


def test_origin_is_rejected_even_with_a_named_bind_host():
    assert bg.rejection(
        _get({"Host": "mac-studio.local:8100", "Origin": "http://mac-studio.local:8100"}),
        "mac-studio.local",
    )


def test_named_bind_host_passes_for_server_clients():
    assert bg.rejection(_get({"Host": "mac-studio.local:8100"}), "mac-studio.local") is None
