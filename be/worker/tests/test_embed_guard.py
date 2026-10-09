"""embed 서비스의 브라우저 금지 미들웨어 (spec 2026-10-08 §3.8).

/health로 본다 — 모델을 올리지 않는다.

fastapi는 models extra라 테스트 전용 venv(worker:sync:test)에는 없다 — 그때는 건너뛴다.
"""

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from damwha_worker import embed_service  # noqa: E402


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(embed_service, "_bind_host", "127.0.0.1")
    return TestClient(embed_service.app)


def test_server_client_reaches_health(client):
    r = client.get("/health", headers={"host": "127.0.0.1:8100", "sec-fetch-mode": "cors"})
    assert r.status_code == 200
    assert "access-control-allow-origin" not in r.headers


@pytest.mark.parametrize(
    "headers",
    [
        {"host": "127.0.0.1:8100", "origin": "https://evil.example"},
        {"host": "127.0.0.1:8100", "sec-fetch-site": "cross-site"},
        {"host": "attacker.example:8100"},
    ],
)
def test_browser_or_rebound_request_is_refused(client, headers):
    r = client.get("/health", headers=headers)
    assert r.status_code == 403
    assert "access-control-allow-origin" not in r.headers


def test_embed_route_is_guarded_before_the_model_loads(client, monkeypatch):
    def boom():
        raise AssertionError("_service() must not run for a refused request")

    monkeypatch.setattr(embed_service, "_service", boom)
    r = client.post("/embed", json={"texts": ["x"]}, headers={"host": "attacker.example:8100"})
    assert r.status_code == 403


def test_named_bind_host_is_accepted(monkeypatch):
    monkeypatch.setattr(embed_service, "_bind_host", "mac-studio.local")
    r = TestClient(embed_service.app).get("/health", headers={"host": "mac-studio.local:8100"})
    assert r.status_code == 200
