"""embed·LLM 서버의 '브라우저 금지' 판정 (spec 2026-10-08-local-api-access-control §3.8).

두 서버는 브라우저 클라이언트가 없다. be·desktop 프로브는 Node fetch, worker는
httpx로 부르고 어느 쪽도 Origin·Sec-Fetch-Site를 싣지 않는다. 그래서 그 둘 중
하나라도 있으면 브라우저로 보고 거부한다(설정과 관계없이).
Sec-Fetch-Mode는 보지 않는다: Node fetch(undici)가 `sec-fetch-mode: cors`를
붙인다(실측).

Host는 DNS rebinding을 막는다. loopback 셋에 더해 **설정된 bind 호스트 이름**도
받는다. EMBED_SERVICE_ALLOW_NON_LOOPBACK·embed_service_host·LENS_LLM_BASE_URL로
loopback 밖에 띄우는 구성이 아직 있고, 그 클라이언트는 그 이름을 Host로 보낸다.
와일드카드 bind(0.0.0.0, ::)는 이름이 아니므로 더하지 않는다.

이 모듈은 아무것도 import하지 않는다. llm_entry가 mlx를 올리기 전에,
embed_service가 모델을 올리기 전에 쓴다.
"""

from __future__ import annotations

import re
from collections.abc import Callable

LOOPBACK_HOSTS: frozenset[str] = frozenset({"localhost", "127.0.0.1", "[::1]"})
_WILDCARD_BINDS = frozenset({"", "0.0.0.0", "::", "[::]"})
# URL 파서를 쓰지 않는다 — `attacker@127.0.0.1`을 127.0.0.1로 읽는다.
_HOST_HEADER = re.compile(r"^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$", re.IGNORECASE)


def hostname_of(host_header: str | None) -> str | None:
    if host_header is None:
        return None
    m = _HOST_HEADER.match(host_header.strip())
    return m.group(1).lower() if m else None


def allowed_hostnames(bind_host: str | None) -> frozenset[str]:
    if bind_host is None:
        return LOOPBACK_HOSTS
    name = bind_host.strip().lower()
    if name in _WILDCARD_BINDS:
        return LOOPBACK_HOSTS
    if ":" in name and not name.startswith("["):
        name = f"[{name}]"  # Host 헤더의 IPv6는 대괄호 안에 온다
    return LOOPBACK_HOSTS | {name}


def rejection(get_header: Callable[[str], str | None], bind_host: str | None) -> str | None:
    """거부 사유, 또는 통과면 None. `get_header`는 대소문자를 무시하는 헤더 조회다."""
    if get_header("origin") is not None:
        return "browser requests are not accepted (Origin)"
    if get_header("sec-fetch-site") is not None:
        return "browser requests are not accepted (Sec-Fetch-Site)"
    name = hostname_of(get_header("host"))
    if name is None or name not in allowed_hostnames(bind_host):
        return "Host is not allowed"
    return None
