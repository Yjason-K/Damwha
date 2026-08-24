"""워커가 소유하는 LLM 서버(`mlx_lm.server`) 수명 관리.

렌즈/요약 job은 job 1건짜리 자식 프로세스 안에서만 LLM을 쓴다. 서버를 상시 띄워
두면 큐가 비어 있는 동안에도 모델이 메모리를 쥐고 있으므로(8bit 27B면 ~28GB),
자식이 job 직전에 띄우고 끝나면 내린다. 모델 이름은 payload가 들고 있어
(`ExtractLensesPayload.model` / `SummarizeMeetingPayload.model`) claim 직후 확정된다
— 슈퍼바이저의 peek는 손대지 않는다.

이미 떠 있는 서버를 발견하면 그건 사람이 띄운 것이므로(SMOKE·개발) 재사용만 하고
죽이지 않는다.
"""

import json
import logging
import shutil
import subprocess
import time
from contextlib import contextmanager
from urllib.parse import urlparse

import httpx

from .errors import LLM_SERVER_START_FAILED, ErrorKind, WorkerError

log = logging.getLogger("damwha_worker")

_READY_POLL_SECONDS = 0.5
_KILL_GRACE_SECONDS = 5.0


def probe_models(base_url: str, timeout_seconds: float = 5.0) -> list[str] | None:
    """LLM 서버 도달성을 1회 확인하고 서빙 중인 모델 id를 돌려준다. 실패하면 None."""
    try:
        with httpx.Client(timeout=timeout_seconds) as client:
            response = client.get(f"{base_url.rstrip('/')}/models")
        response.raise_for_status()
        return [m["id"] for m in response.json()["data"]]
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        return None


def _host_port(base_url: str) -> tuple[str, int]:
    parsed = urlparse(base_url)
    if not parsed.hostname or parsed.port is None:
        raise WorkerError(
            LLM_SERVER_START_FAILED,
            f"cannot manage an LLM server for {base_url!r} — the URL needs an explicit "
            "host:port (e.g. http://127.0.0.1:8000/v1)",
            ErrorKind.PERMANENT,
        )
    return parsed.hostname, parsed.port


def _stop(proc, stop_timeout_seconds: float) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=stop_timeout_seconds)
    except subprocess.TimeoutExpired:
        log.warning("LLM server ignored SIGTERM — killing")
        proc.kill()
        try:
            proc.wait(timeout=_KILL_GRACE_SECONDS)
        except subprocess.TimeoutExpired:  # pragma: no cover — SIGKILL 무시는 불가능
            pass


@contextmanager
def managed_llm_server(
    model: str,
    settings,
    *,
    popen=subprocess.Popen,
    probe=probe_models,
    monotonic=time.monotonic,
    sleep=time.sleep,
):
    """`model`을 서빙하는 LLM 서버를 보장한 채 본문을 실행한다.

    yield 값은 워커가 띄운 프로세스이고, 띄우지 않았으면(비활성 또는 외부 서버 재사용)
    None이다. 본문이 예외로 끝나도 워커가 띄운 서버는 반드시 내린다.
    """
    base_url = settings.lens_llm_base_url
    if not settings.lens_llm_managed:
        yield None
        return
    if probe(base_url) is not None:
        log.info("LLM server already running at %s — reusing it (not worker-managed)", base_url)
        yield None
        return

    host, port = _host_port(base_url)
    binary = shutil.which(settings.lens_llm_server_bin)
    if binary is None:
        raise WorkerError(
            LLM_SERVER_START_FAILED,
            f"{settings.lens_llm_server_bin!r} not found on PATH — install it with "
            "`uv tool install mlx-lm`, or set LENS_LLM_MANAGED=false and start the "
            "server yourself",
            ErrorKind.PERMANENT,
        )

    log.info("starting LLM server: %s %s on %s:%s", settings.lens_llm_server_bin, model, host, port)
    proc = popen(
        [
            binary,
            "--model",
            model,
            # 서버 기본값도 추론 off로 맞춘다 — 클라이언트도 요청마다 같은 값을 보낸다.
            "--chat-template-args",
            json.dumps({"enable_thinking": False}),
            "--host",
            host,
            "--port",
            str(port),
        ]
    )
    try:
        _wait_ready(proc, model, settings, probe, monotonic, sleep)
    except BaseException:
        _stop(proc, settings.lens_llm_server_stop_timeout_seconds)
        raise

    try:
        yield proc
    finally:
        log.info("stopping LLM server (%s)", model)
        _stop(proc, settings.lens_llm_server_stop_timeout_seconds)


def _wait_ready(proc, model, settings, probe, monotonic, sleep) -> None:
    """서버가 /models에 응답할 때까지 기다린다. 조기 종료는 그 자리에서 실패."""
    deadline = monotonic() + settings.lens_llm_server_start_timeout_seconds
    while True:
        code = proc.poll()
        if code is not None:
            raise WorkerError(
                LLM_SERVER_START_FAILED,
                f"LLM server for {model} exited with code {code} before becoming ready",
                ErrorKind.TRANSIENT,
            )
        if probe(settings.lens_llm_base_url) is not None:
            return
        if monotonic() >= deadline:
            raise WorkerError(
                LLM_SERVER_START_FAILED,
                "LLM server did not become ready within "
                f"{settings.lens_llm_server_start_timeout_seconds}s at "
                f"{settings.lens_llm_base_url}",
                ErrorKind.TRANSIENT,
            )
        sleep(_READY_POLL_SECONDS)
