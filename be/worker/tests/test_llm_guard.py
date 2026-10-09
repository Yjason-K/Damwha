"""LLM 서버 가드 (spec 2026-10-08 §3.8).

핵심 함정: mlx_lm 0.31.3의 `_run_http_server(..., handler_class=APIHandler)`는 **정의 시점에**
원래 클래스를 기본 인자로 잡았고 `run()`은 그 인자를 넘기지 않는다. 그래서 하위 클래스로 모듈
속성을 바꾸면 실제 서버는 가드 없이 뜬다. 메서드만 부르는 테스트는 그 실수를 못 잡으므로,
여기서는 **실제 HTTP 서버**에 요청을 보낸다.
"""

import http.client
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from damwha_worker import llm_guard


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _request(port, method, path, headers):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request(method, path, body=b"{}" if method == "POST" else None, headers=headers)
    res = conn.getresponse()
    res.read()
    conn.close()
    return res.status, {k.lower(): v for k, v in res.getheaders()}


def _make_handler():
    """APIHandler와 같은 모양의 대역 — do_GET/do_POST/do_OPTIONS와 CORS를 쓰는 _set_cors_headers."""

    class Handler(BaseHTTPRequestHandler):
        def _set_cors_headers(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "*")

        def _ok(self):
            self.send_response(200)
            self._set_cors_headers()
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

        def do_GET(self):
            self._ok()

        def do_POST(self):
            self._ok()

        def do_OPTIONS(self):
            self._ok()

        def log_message(self, *args):
            pass

    return Handler


def _serve(handler_cls):
    port = _free_port()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler_cls)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


@pytest.fixture
def guarded():
    handler = _make_handler()
    llm_guard.install(handler, bind_host="127.0.0.1")
    httpd, port = _serve(handler)
    yield port
    httpd.shutdown()


GOOD = {"Host": "127.0.0.1:8000"}


@pytest.mark.parametrize("method", ["GET", "POST", "OPTIONS"])
def test_server_client_passes_and_gets_no_cors_headers(guarded, method):
    status, headers = _request(guarded, method, "/v1/models", GOOD)
    assert status == 200
    assert not [k for k in headers if k.startswith("access-control-")]


@pytest.mark.parametrize("method", ["GET", "POST", "OPTIONS"])
@pytest.mark.parametrize(
    "extra",
    [
        {"Origin": "https://evil.example"},
        {"Sec-Fetch-Site": "cross-site"},
        {"Host": "attacker.example:8000"},
    ],
)
def test_browser_or_rebound_request_is_refused(guarded, method, extra):
    status, headers = _request(guarded, method, "/v1/chat/completions", {**GOOD, **extra})
    assert status == 403
    assert not [k for k in headers if k.startswith("access-control-")]


def test_install_is_idempotent():
    handler = _make_handler()
    llm_guard.install(handler, None)
    wrapped = handler.do_GET
    llm_guard.install(handler, None)  # 두 번 감싸지 않는다
    assert handler.do_GET is wrapped
    httpd, port = _serve(handler)
    try:
        assert _request(port, "GET", "/", GOOD)[0] == 200
    finally:
        httpd.shutdown()


@pytest.mark.parametrize(
    "bad",
    [
        None,
        type("NoMethods", (BaseHTTPRequestHandler,), {"_set_cors_headers": lambda self: None}),
        type("NoCors", (BaseHTTPRequestHandler,), {"do_GET": lambda self: None}),
    ],
)
def test_unexpected_handler_shape_fails_closed(bad):
    with pytest.raises(RuntimeError):
        llm_guard.install(bad, None)


@pytest.mark.parametrize(
    ("argv", "want"),
    [
        (["x", "--model", "m", "--host", "10.0.0.5", "--port", "8000"], "10.0.0.5"),
        (["x", "--host=127.0.0.1"], "127.0.0.1"),
        (["x", "--model", "m"], None),
        (["x", "--host"], None),
    ],
)
def test_host_arg(argv, want):
    assert llm_guard.host_arg(argv) == want


def test_real_mlx_server_path_is_guarded():
    """설치된 mlx_lm의 **실제** `_run_http_server` 경로. 하위 클래스 교체였다면 가드가 없다."""
    server = pytest.importorskip("mlx_lm.server")

    class FakeGenerator:
        """/health는 응답 생성기를 쓰지 않는다 — 모델 없이 서버를 띄운다."""

    llm_guard.install(server.APIHandler, bind_host="127.0.0.1")
    port = _free_port()
    threading.Thread(
        target=server._run_http_server, args=("127.0.0.1", port, FakeGenerator()), daemon=True
    ).start()
    # 서버가 붙을 때까지 기다린다
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.1).close()
            break
        except OSError:
            threading.Event().wait(0.05)

    ok_status, ok_headers = _request(port, "GET", "/health", {"Host": f"127.0.0.1:{port}"})
    assert ok_status == 200
    assert not [k for k in ok_headers if k.startswith("access-control-")]

    for extra in ({"Origin": "https://evil.example"}, {"Host": "attacker.example"}):
        status, headers = _request(port, "GET", "/health", {"Host": f"127.0.0.1:{port}", **extra})
        assert status == 403
        assert not [k for k in headers if k.startswith("access-control-")]
