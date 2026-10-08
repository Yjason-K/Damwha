"""LLM 서버(mlx_lm.server)에 브라우저 금지 가드를 건다 (spec 2026-10-08 §3.8).

mlx_lm.server는 `--allowed-origins` 기본값 `*`로 모든 응답에 `Access-Control-Allow-Origin: *`를
붙이고, 본문을 Content-Type과 관계없이 json.loads한다 — 아무 웹페이지가 `text/plain` simple
request로 부르고 답을 읽을 수 있었다.

**클래스를 바꾸지 않고 원래 클래스 객체의 메서드를 제자리에서 바꾼다.**
`_run_http_server(..., handler_class=APIHandler)`가 정의 시점에 원래 클래스를 기본 인자로
잡았고 `run()`은 그 인자를 넘기지 않는다(mlx_lm 0.31.3 server.py:1702,1735). 모듈 속성을
하위 클래스로 바꾸면 실제 서버는 가드 없이 뜬다. 같은 객체의 메서드를 바꾸면 기본 인자도
같은 객체다.

`_set_cors_headers`는 아무 헤더도 쓰지 않게 덮는다 — Origin이 맞지 않아도
`Allow-Methods: *`·`Allow-Headers: *`를 쓴다(server.py:1075-1084). 이 메서드가
`cli_args.allowed_origins`의 유일한 소비자라, 이걸 덮으면 그 인자는 효과가 없다.

모양이 기대와 다르면(mlx_lm이 바뀌어 APIHandler·_set_cors_headers·do_*가 없음) RuntimeError —
조용히 가드 없이 뜨지 않는다.
"""

from __future__ import annotations

import json

from . import browser_guard

_MARK = "_damwha_guarded"


def host_arg(argv: list[str]) -> str | None:
    for i, token in enumerate(argv):
        if token == "--host":
            return argv[i + 1] if i + 1 < len(argv) else None
        if token.startswith("--host="):
            return token[len("--host=") :]
    return None


def _refuse(handler, reason: str) -> None:
    body = json.dumps({"error": reason}).encode()
    handler.send_response(403)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _guard(method, bind_host):
    def guarded(self):
        reason = browser_guard.rejection(self.headers.get, bind_host)
        if reason is not None:
            _refuse(self, reason)
            return
        method(self)

    guarded.__name__ = method.__name__
    return guarded


def install(handler_cls: type | None, bind_host: str | None) -> None:
    if handler_cls is None:
        raise RuntimeError("mlx_lm.server.APIHandler not found — refusing to start unguarded")
    if getattr(handler_cls, _MARK, False):
        return
    do_methods = [name for name in vars(handler_cls) if name.startswith("do_")]
    if not do_methods or not callable(getattr(handler_cls, "_set_cors_headers", None)):
        raise RuntimeError(
            f"mlx_lm APIHandler has an unexpected shape (do_*={do_methods}) — refusing to start"
        )
    for name in do_methods:
        setattr(handler_cls, name, _guard(getattr(handler_cls, name), bind_host))
    handler_cls._set_cors_headers = lambda self: None
    setattr(handler_cls, _MARK, True)
