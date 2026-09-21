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
import sys
import threading
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from urllib.parse import urlparse

import httpx

from . import runtime_report
from .config import READINESS_STALL_SECONDS
from .db import core
from .errors import DISK_FULL, LLM_SERVER_START_FAILED, ErrorKind, WorkerError

log = logging.getLogger("damwha_worker")

_READY_POLL_SECONDS = 0.5
_KILL_GRACE_SECONDS = 5.0
_ENTRY_MODULE = "damwha_worker.llm_entry"
# 진행 보고를 읽는 연결의 상한. 이 연결은 **기다리는 동안만** 살아 있고, 못 열거나 멈춰도
# 기다림 자체를 깨지 않는다 — downloads.py의 훅 연결과 같은 값이다.
_CONNECT_KWARGS = {"connect_timeout": 5, "options": "-c statement_timeout=5000"}
_ISO_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"


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


def _server_command(server_bin: str) -> list[str]:
    """argv의 앞부분 — 무엇을 실행하는가.

    빈 값이 기본이다. 이 워커와 **같은 인터프리터**로 `-m damwha_worker.llm_entry`를 띄우고,
    부모(`--once` 자식)가 받은 `--run-id`를 모듈 바로 뒤에 이어 붙인다 (스펙 §6.2). 콘솔
    스크립트의 셔뱅을 타지 않으므로 번들 python이 그대로 이어지고, argv의 run-id로 앱이 이
    프로세스의 소유를 증명한다. 부모가 run-id를 받지 않았으면 지어내지 않는다.

    값이 있으면 그 실행 파일을 그대로 쓰는 탈출구다(수동 운용·다른 백엔드). `--run-id`를 붙이지
    않는다 — 임의의 백엔드는 모르는 인자로 죽을 수 있고, 앱은 그렇게 띄운 서버를 소유한다고
    증명할 수 없다.
    """
    if not server_bin:
        command = [sys.executable, "-m", _ENTRY_MODULE]
        run_id = runtime_report.run_id_arg(sys.argv)
        if run_id is not None:
            command.append(f"{runtime_report.RUN_ID_PREFIX}{run_id}")
        return command
    binary = shutil.which(server_bin)
    if binary is None:
        raise WorkerError(
            LLM_SERVER_START_FAILED,
            f"LENS_LLM_SERVER_BIN={server_bin!r} is not an executable file or a command on "
            "PATH — leave LENS_LLM_SERVER_BIN empty to run the bundled `python -m "
            f"{_ENTRY_MODULE}`, or set LENS_LLM_MANAGED=false and start the server yourself",
            ErrorKind.PERMANENT,
        )
    return [binary]


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
    command = _server_command(settings.lens_llm_server_bin)
    log.info("starting LLM server: %s %s on %s:%s", " ".join(command), model, host, port)
    proc = popen(
        [
            *command,
            "--model",
            model,
            # 서버 기본값도 추론 off로 맞춘다 — 클라이언트도 요청마다 같은 값을 보낸다.
            "--chat-template-args",
            json.dumps({"enable_thinking": False}),
            "--host",
            host,
            "--port",
            str(port),
        ],
        # stderr을 파이프로 받는다 — 아래 _start_stderr_relay가 DISK_FULL 서명을 감시할 수
        # 있게(Ruling R16). 감시자가 읽은 줄은 그대로 우리 stderr로 다시 쓰므로 로그 가시성은
        # 그대로다. 대역 popen은 이 kwarg를 무시한다.
        stderr=subprocess.PIPE,
    )
    # popen 직후, _wait_ready가 돌기 **전에** 시작한다 (Ruling R18, 2026-09-21 리뷰 fix
    # round 1) — readiness 대기 구간에도 이 프로세스가 유일한 stderr 파이프 독자여야 한다.
    # 그 구간에만 아무도 안 읽으면 (a) 서버가 준비되기 전에 죽었을 때 _stop이 파이프에 쌓인
    # 자식 트레이스백을 그냥 버리고, (b) 다운로드 유예로 최대 600초까지 늘어나는 대기 동안
    # 파이프가 차 자식이 stderr write에서 막힐 수 있다.
    _start_stderr_relay(proc)
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


def _open_readiness_connection(settings):
    """진행 보고를 읽을 **자기** 연결 (스펙 §6.9, 2026-09-17 결정).

    `--once` 자식이 쥔 연결을 인자로 받지 않는다 — 받으면 `_wait_ready`의 시그니처가 바뀌고
    파급이 `dispatch.py`·`jobs.py`·`__main__.py`의 호출부까지 번진다. 자기 연결이면 파급이
    `llm_server.py`·`config.py` 둘에 갇히고, 읽는 것은 폴링 주기마다 한 행이다.

    외부 DB 모드(`DAMWHA_SHARED_STATE=off`)에서는 열지 않는다 — 앱이 소유하지 않은 DB이고
    writer들도 그 모드에서는 이 행을 쓰지 않는다. 테스트는 이 이름을 대역으로 덮는다
    (`models/downloads.py`의 `_open_connection`과 같은 이음매).
    """
    if not core.shared_state_enabled():
        return None
    return core.connect(settings.database_url, **_CONNECT_KWARGS)


def _parse_stamp(value):
    """`model_readiness`의 고정 정밀도 UTC 문자열 → datetime. 알아볼 수 없으면 None."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value, _ISO_FORMAT).replace(tzinfo=UTC)
    except ValueError:
        return None


def _download_in_progress(conn, writer: str) -> bool:
    """`writer`가 **지금** 모델을 받고 있나 (스펙 §6.9).

    앱 감독자의 `desktop/src/services/model-readiness.ts::downloadInProgress`와 같은 규칙이다 —
    판정은 `bytes_done` 증가가 아니라 `updated_at`이고(총량을 모르는 다운로드가 있다), `writer`로
    서비스를 구별한다(다른 서비스가 받는 모델이 이쪽 유예를 늘리면 안 된다).

    읽기가 실패하면 False다. 못 읽는 것이 유예를 **늘리는** 사유가 되면 안 된다.
    """
    if conn is None:
        return False
    try:
        entries = core.read_model_readiness(conn)["entries"]
    except Exception:  # noqa: BLE001 — DB 오류가 기다림을 끝내지 않는다
        log.debug("model_readiness read failed — the ready wait continues", exc_info=True)
        return False
    now = datetime.now(UTC)
    for entry in entries.values():
        if not isinstance(entry, dict):
            continue
        if entry.get("state") != "downloading" or entry.get("writer") != writer:
            continue
        stamp = _parse_stamp(entry.get("updated_at"))
        if stamp is not None and (now - stamp).total_seconds() <= READINESS_STALL_SECONDS:
            return True
    return False


def _wait_ready(proc, model, settings, probe, monotonic, sleep) -> None:
    """서버가 /models에 응답할 때까지 기다린다. 조기 종료는 그 자리에서 실패.

    **모델을 받는 동안에는 유예를 소모하지 않는다** (스펙 §6.9). 첫 실행의 27B는 수십 GB라
    600초(`config.py`의 `lens_llm_server_start_timeout_seconds`)로는 못 받고, 그 제한에 걸려
    죽이면 받다 만 것을 버리고 처음부터 다시 받는 고리가 된다. 진행을 올리는 것은 이 프로세스가
    아니라 `llm_entry`(= popen한 자식)이므로 **DB를 읽어야** 안다.

    고정 deadline이 아니라 **소모한 시간의 누적**으로 센다 — 남은 시간을 빼는 방식이면 다운로드가
    끝난 순간 남은 유예가 0이라 곧바로 실패한다.

    연결은 여기서 열고 여기서 닫는다. 대기가 끝나면 필요 없고, 남겨 두면 `--once` 자식의 수명
    동안 유휴 연결이 하나 더 산다. **못 열어도 기다림은 진행한다** — 유예 연장을 못 할 뿐이고,
    못 여는 것이 600초 실패의 사유가 되면 안 된다.
    """
    budget = settings.lens_llm_server_start_timeout_seconds
    writer = settings.worker_id
    spent = 0.0
    last_tick = monotonic()
    conn = None
    opened = False
    try:
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
            if not opened:
                # 처음 기다릴 때 한 번만 연다. 실패하면 다시 시도하지 않는다 — 폴링마다 다시 열면
                # 닿지 않는 DB가 이 루프를 연결 시도로 채운다.
                opened = True
                try:
                    conn = _open_readiness_connection(settings)
                except Exception:  # noqa: BLE001 — 유예 연장만 없어진다
                    log.warning(
                        "could not open a connection for model_readiness — the ready wait "
                        "continues without the download grace",
                        exc_info=True,
                    )
                    conn = None
            now = monotonic()
            downloading = _download_in_progress(conn, writer)
            # last_tick은 **조건 없이** 민다. 다운로드 중일 때만 멈춰 두면 그동안 흐른 시간이
            # 다운로드가 끝나는 순간 한꺼번에 들어와 유예를 즉시 태운다.
            delta = now - last_tick
            last_tick = now
            if not downloading:
                spent += delta
            if spent >= budget:
                raise WorkerError(
                    LLM_SERVER_START_FAILED,
                    "LLM server did not become ready within "
                    f"{settings.lens_llm_server_start_timeout_seconds}s at "
                    f"{settings.lens_llm_base_url}",
                    ErrorKind.TRANSIENT,
                )
            sleep(_READY_POLL_SECONDS)
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001 — 닫기 실패가 결과를 바꾸지 않는다
                log.debug("closing the model_readiness connection failed", exc_info=True)


_DISK_FULL_MARKER = f"damwha_worker.errors.WorkerError: {DISK_FULL}: "
_DISK_FULL_WATCH_POLL_SECONDS = 0.1


def _start_stderr_relay(proc) -> None:
    """`proc.stderr`을 미러+감시하는 장수 스레드 **하나**를 `proc`의 수명 동안 띄운다
    (Ruling R18, 2026-09-21 리뷰 fix round 1).

    **`popen()` 직후, `_wait_ready`가 돌기 전에 불러야 한다.** 이전 라운드는 이 감시를
    `run_guarding_disk_full`이 불릴 때만(= readiness를 통과한 **뒤**) 시작했다 — 그 구간
    (최대 `lens_llm_server_start_timeout_seconds`, 다운로드 유예를 받으면 600초까지)에는
    아무도 stderr 파이프를 읽지 않았다. 두 가지 대가가 있었다: (a) 서버가 준비 전에 죽으면
    `_stop`이 파이프에 쌓인 자식 트레이스백(`LLM_SERVER_START_FAILED`의 사유)을 그냥
    버렸고, (b) 파이프가 OS 버퍼(16~64KiB)를 넘게 차면 자식이 stderr write에서 막힐 수
    있었다.

    이제는 `proc` 하나당 이 스레드 하나만 산다 — `run_guarding_disk_full`을 같은 `proc`로
    몇 번을 불러도(또는 readiness 구간에 터진 DISK_FULL이라도) 새 스레드가 이터레이터를
    나눠 먹는 일이 없다(이전 라운드의 Minor 5). `proc`에 `damwha_disk_full_event`(Event)와
    `damwha_disk_full_box`(잡은 메시지)를 붙인다 — `run_guarding_disk_full`은 그 둘만
    기다린다.

    `proc.stderr`이 없으면(대역 popen, 파이프 안 받음) 감시할 것이 없어 아무 것도 안 한다.
    """
    stderr = getattr(proc, "stderr", None)
    if stderr is None:
        return

    event = threading.Event()
    box: dict = {}
    proc.damwha_disk_full_event = event
    proc.damwha_disk_full_box = box

    def _relay() -> None:
        try:
            for raw in stderr:
                line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
                # 검사를 먼저, 미러를 나중에(이전 라운드의 Minor 6) — 아래 쓰기가 던져도
                # 서명 탐지는 이미 끝나 있다. 거꾸로 하면 미러 실패가 감시 자체를 죽인다.
                if _DISK_FULL_MARKER in line and "message" not in box:
                    box["message"] = line.split(_DISK_FULL_MARKER, 1)[1].rstrip("\r\n")
                    event.set()
                # 감시하는 동안에도 로그 가시성은 그대로 둔다 — 읽은 줄을 그대로 우리
                # stderr에 되쓴다(`--once` 자식의 stderr이고, 감독자가 그것을 캡처한다).
                try:
                    sys.stderr.write(line)
                    sys.stderr.flush()
                except (ValueError, OSError):  # noqa: BLE001 — 미러 실패가 감시를 막지 않는다
                    pass
        except (ValueError, OSError):  # noqa: BLE001 — 파이프 자체가 닫히면 그냥 끝난다
            pass

    threading.Thread(target=_relay, daemon=True, name="damwha-llm-stderr-relay").start()


def run_guarding_disk_full(proc, fn):
    """`fn()`을 돌리되, 워커가 띄운 LLM 서버(`proc`)의 stderr에서 `_start_stderr_relay`가
    이미 잡아 둔 DISK_FULL 래치가 보이면 `fn`의 응답을 기다리지 않고 그 자리에서 같은
    사유로 실패시킨다 (Ruling R16, 2026-09-21 task-10 정정 / Ruling R18로 감시 방식 개편).

    **왜 필요한가.** `mlx_lm.server`의 모델 지연 로드는 요청을 처리하는 스레드 안에서
    일어난다. `models/downloads.py`의 `check_free_space`가 그 스레드 안에서
    `WorkerError(DISK_FULL, ...)`를 던져도 파이썬 기본 스레드 예외 처리기가 stderr에
    찍고 삼킬 뿐 `fn`(HTTP 클라이언트의 블로킹 호출)에는 닿지 않는다 — packaged 실측:
    job이 `lens_llm_timeout_seconds`(5분)를 다 기다린 뒤에야 `llm_request_failed`/
    "timed out"으로 실패했고, 화면은 디스크 부족이 아니라 알 수 없는 타임아웃을 5분
    보여줬다.

    **그 스레드를 끊을 수는 없다** — `models/downloads.py`의 `_run_watched`와 같은
    이유다(막힌 호출 자체를 파이썬에서 끊을 수단이 없다). 그래서 `fn`을 별도 스레드에서
    돌리고 `_start_stderr_relay`가 유지하는 래치를 동시에 기다려, DISK_FULL이 보이면 그
    자리에서 실패시키고 `fn`을 돌리던 스레드는 daemon으로 버린다 — 인터프리터 종료를
    막지 않고, 어차피 job은 이 실패로 끝난다.

    **stderr을 이 함수가 직접 읽지 않는다.** 그건 `_start_stderr_relay`(`managed_llm_server`가
    `popen()` 직후 시작)의 몫이다 — 같은 `proc`로 이 함수를 여러 번 불러도 스트림을 두
    번 소비하지 않는다(이전 라운드의 Minor 5).

    **DISK_FULL만 잡는다.** 래치가 안 서면 `fn`이 정상적으로 끝나거나 던질 때까지 평소대로
    기다린다 — 다른 실패 경로(타임아웃·연결 오류 등)는 이 함수가 생기기 전과 똑같이 `fn`을
    통해 그대로 올라온다. 사유를 넓게 걸면 정확한 사유가 부정확해지고 기존 동작이 바뀐다.

    **문구를 짓지 않는다.** 잡은 메시지는 `damwha_worker.errors.WorkerError` 트레이스백
    줄에서 그대로 잘라낸 것이다 — `models/disk.py::check_free_space`가 이미
    `desktop/src/diagnostics/causes.ts`의 `diskFull` 모양대로 만든 문자열이므로, 여기서는
    그것을 한 글자도 새로 짓지 않고 그대로 다시 쓴다.

    `proc`가 없거나(외부 서버 재사용) 래치가 안 붙어 있으면(`_start_stderr_relay`가 안
    불렸거나 `proc.stderr`가 없는 대역) 감시할 것이 없으니 `fn()`을 그 자리에서 그대로
    돌린다 — 동작이 이 함수가 생기기 전과 같다.
    """
    event = getattr(proc, "damwha_disk_full_event", None)
    if proc is None or event is None:
        return fn()
    box = proc.damwha_disk_full_box

    done = threading.Event()
    result: dict = {}

    def _run() -> None:
        try:
            result["value"] = fn()
        except BaseException as exc:  # noqa: BLE001 — 호출자 스레드에서 그대로 다시 던진다
            result["error"] = exc
        finally:
            done.set()

    threading.Thread(target=_run, daemon=True, name="damwha-llm-request").start()

    # event를 done보다 먼저 검사한다 — readiness 대기 구간에 이미 터진 DISK_FULL처럼
    # `fn`을 부르기 전부터 래치가 서 있는 경우, fn이 (드물게) 폴링 주기 안에 끝나 버려도
    # 래치를 놓치지 않는다. done만 보고 있었으면 그 경합에서 진짜 실패를 숨기고 fn의
    # 결과를 그대로 돌려줄 뻔했다.
    while True:
        if event.is_set():
            raise WorkerError(DISK_FULL, box.get("message"), ErrorKind.PERMANENT)
        if done.wait(_DISK_FULL_WATCH_POLL_SECONDS):
            break
    if "error" in result:
        raise result["error"]
    return result["value"]
