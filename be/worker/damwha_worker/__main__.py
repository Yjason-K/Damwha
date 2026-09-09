"""워커 진입점: 부모(supervisor) 루프와 자식(--once) 한 건 처리.

job 하나를 실제로 어떻게 처리하는지는 여기 없다 — dispatch.py가 handler를 고르고,
jobs.py가 type별 정책을 갖고 있다. 이 파일이 다루는 건 프로세스 경계뿐이다:
시그널 2단계 처리, 자식 spawn과 exit code 분기, backoff, reaper 스레드.
"""

import logging
import os
import signal
import subprocess
import sys
import threading

from . import capabilities, console, db, wiring
from .config import load_settings
from .dispatch import dispatch_claimed_job, handle_job, run_once  # noqa: F401 — 공개 진입점
from .jobs import default_live_source
from .llm_server import managed_llm_server
from .llm_server import probe_models as check_lens_llm
from .reaper import run_reaper_loop
from .storage import Storage

log = logging.getLogger("damwha_worker")

_MAX_BACKOFF_SECONDS = 60.0
_TIMEOUT_EXC = subprocess.TimeoutExpired


def run_single_job(
    settings,
    storage: Storage,
    shutdown: threading.Event,
    *,
    connect_fn,
    build_models_fn,
    build_embedder_fn,
    build_text_embedder_fn,
    build_lens_client_fn=None,
    build_summary_client_fn=None,
    llm_server_fn=None,
    build_live_models_fn=None,
    build_live_source_fn=None,
) -> int:
    """자식 진입점: job 1건 처리 후 exit code 반환.

    0 = 처리 완료(성공/정상 fail/requeue/shutdown requeue), 3 = no job.
    자식은 재접속하지 않는다(spec §8) — connect 실패·미포착 예외는 전파해
    nonzero로 exit하고, 부모가 backoff/reaper로 복구한다.
    """
    conn = connect_fn()  # 실패 시 예외 전파 → nonzero exit → 부모 backoff (자식 재접속 없음)
    try:
        job = db.claim(conn, settings.worker_id)
        if job is None:
            return 3
        from .heartbeat import Heartbeat

        hb = Heartbeat(
            settings.database_url,
            job["id"],
            settings.worker_id,
            settings.heartbeat_interval_seconds,
        )
        outcome = dispatch_claimed_job(
            conn,
            job,
            storage,
            settings,
            build_models_fn=build_models_fn,
            build_embedder_fn=build_embedder_fn,
            build_text_embedder_fn=build_text_embedder_fn,
            build_lens_client_fn=build_lens_client_fn,
            build_summary_client_fn=build_summary_client_fn,
            llm_server_fn=llm_server_fn,
            heartbeat_cm=hb,
            shutdown_event=shutdown,
            build_live_models_fn=build_live_models_fn,
            build_live_source_fn=build_live_source_fn,
        )
        # job-level outcome 로그 유지
        log.info("job %s type=%s → %s", job["id"], job["type"], outcome)
        return 0
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def _wait_child(proc) -> int:
    """자식 종료까지 대기하며 returncode를 회수한다. shutdown 시 terminate/kill은
    부모 시그널 핸들러가 child_holder로 직접 보내므로, 여기서는 폴링만 한다.
    (0.5초 폴링이라 시그널 후 자식 종료를 곧 회수한다.)"""
    while True:
        try:
            return proc.wait(timeout=0.5)
        except _TIMEOUT_EXC:
            continue


def run_supervisor(settings, shutdown, *, connect_fn, spawn_fn, child_holder) -> None:
    """부모: peek → job 있으면 자식 spawn → 종료 대기 → exit code 분기.

    자식 exit code: 0=처리 완료(즉시 재peek), 3=no job(poll sleep),
    그 외(2 포함)=크래시(capped backoff + WARNING).
    """
    conn = _reconnect(connect_fn, shutdown)
    if conn is None:
        return
    consecutive_failures = 0
    while not shutdown.is_set():
        try:
            has_job = db.peek_queued(conn)
        except Exception:  # noqa: BLE001 — DB 장애: 재접속 후 계속
            log.exception("supervisor peek error — reconnecting")
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
            conn = _reconnect(connect_fn, shutdown)
            if conn is None:
                return
            consecutive_failures = 0  # DB 재접속은 자식 크래시가 아니다
            continue
        if not has_job:
            if shutdown.wait(settings.poll_interval_seconds):
                break
            continue

        proc = spawn_fn()
        # spawn과 holder 할당 사이 시그널이 오면 자식에 SIGTERM이 전달되지 않아
        # 자식이 stage-boundary 없이 job을 끝까지 실행한다(부모는 대기). 창은
        # 바이트코드 몇 개 수준이고 결과도 graceful(정상 완료)이라 수용한다.
        child_holder["proc"] = proc
        code = _wait_child(proc)
        child_holder["proc"] = None

        if shutdown.is_set():
            # shutdown 중 자식 종료는 크래시로 분류하지 않는다(핸들러 설치 전
            # 자식이 -SIGTERM으로 죽어 nonzero여도 정상 종료 경로).
            break
        if code == 0:
            consecutive_failures = 0
        elif code == 3:
            consecutive_failures = 0
            if shutdown.wait(settings.poll_interval_seconds):
                break
        else:
            consecutive_failures += 1
            delay = min(
                settings.poll_interval_seconds * (2 ** (consecutive_failures - 1)),
                _MAX_BACKOFF_SECONDS,
            )
            log.warning(
                "child crashed (exit=%s, consecutive=%d) — backoff %.1fs",
                code,
                consecutive_failures,
                delay,
            )
            if shutdown.wait(delay):
                break
    try:
        conn.close()
    except Exception:  # noqa: BLE001
        pass


def _reconnect(connect_fn, shutdown, *, initial_delay: float = 1.0, max_delay: float = 30.0):
    """capped 지수 backoff로 재접속. shutdown이 set되면 None."""
    delay = initial_delay
    while not shutdown.is_set():
        try:
            return connect_fn()
        except Exception:  # noqa: BLE001 — 어떤 연결 실패든 재시도
            log.warning("reconnect failed — retry in %.0fs", delay, exc_info=True)
            if shutdown.wait(delay):
                break
            delay = min(delay * 2, max_delay)
    return None


def run_child(settings, shutdown: threading.Event) -> int:
    """--once 자식: 시그널 핸들러 설치 후 job 1건 처리."""

    def _on_signal(signum, frame):
        log.info("signal %s received — stop at next stage boundary (send again to force)", signum)
        shutdown.set()
        signal.signal(signum, signal.SIG_DFL)  # 2차 = 즉시 종료

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, _on_signal)

    storage = Storage(settings.storage_root)
    return run_single_job(
        settings,
        storage,
        shutdown,
        connect_fn=lambda: db.connect(settings.database_url),
        build_models_fn=wiring.build_models,
        build_embedder_fn=wiring.build_embedder,
        build_text_embedder_fn=wiring.build_text_embedder,
        build_lens_client_fn=wiring.build_lens_client,
        build_summary_client_fn=wiring.build_summary_client,
        llm_server_fn=lambda model: managed_llm_server(model, settings),
        build_live_models_fn=wiring.build_live_models,
        build_live_source_fn=default_live_source,
    )


def log_lens_llm_health(base_url: str, *, managed: bool = False) -> None:
    """기동 시 1회 호출. 실패해도 워커는 뜬다 — process_meeting은 LLM을 쓰지 않으므로
    LLM 서버가 없다고 오디오 처리까지 막을 이유가 없다. 대신 크게 경고한다.

    `managed`면 서버가 아직 안 떠 있는 게 정상이다(렌즈/요약 자식이 job 직전에 띄운다)
    — 경고하지 않는다."""
    models = check_lens_llm(base_url)
    if managed:
        log.info(
            "lens/summary LLM at %s is worker-managed — started per lens/summary job%s",
            base_url,
            "" if models is None else f" (one already running, serving: {', '.join(models)})",
        )
    elif models is None:
        log.warning(
            "lens/summary LLM at %s is unreachable — extract_lenses/summarize_meeting jobs "
            "will retry and then fail (process_meeting is unaffected). Start it with: "
            "mlx_lm.server --model <repo> --chat-template-args '{\"enable_thinking\":false}'",
            base_url,
        )
    else:
        log.info("lens/summary LLM at %s serving: %s", base_url, ", ".join(models) or "(none)")


def report_host_capabilities(settings) -> None:
    """호스트 스펙을 app_setting에 적어, API가 컨테이너 대신 이 머신을 보고하게 한다.

    실패해도 워커는 그대로 돈다 — API는 자기 env 추정으로 폴백할 뿐이다. MPS 프로브가
    자식 프로세스에서 torch를 import하느라 수십 초 걸릴 수 있어 데몬 스레드에서 돈다;
    기동을 여기서 붙잡으면 큐가 그만큼 늦게 소비된다.
    """
    try:
        caps = capabilities.detect(settings.worker_id)
        conn = db.connect(settings.database_url)
        try:
            db.upsert_worker_capabilities(conn, caps)
        finally:
            conn.close()
        log.info("host capabilities reported: %s", caps)
    except Exception:
        log.warning(
            "could not report host capabilities — the API falls back to its own "
            "CAPABILITIES_* env guess",
            exc_info=True,
        )


def run_supervisor_main(settings, shutdown: threading.Event) -> None:
    """부모: 2단계 시그널 핸들러 설치 후 supervisor 루프."""
    child_holder = {"proc": None, "count": 0}

    def _on_signal(signum, frame):
        child_holder["count"] += 1
        shutdown.set()
        proc = child_holder["proc"]
        if proc is not None:
            if child_holder["count"] == 1:
                log.info("signal %s — forwarding SIGTERM to child (send again to kill)", signum)
                proc.terminate()
            else:
                log.info("signal %s again — killing child and exiting", signum)
                proc.kill()
                os._exit(1)

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, _on_signal)

    def _spawn():
        return subprocess.Popen(
            [sys.executable, "-m", "damwha_worker", "--once"],
            start_new_session=True,
        )

    reaper_thread = threading.Thread(
        target=run_reaper_loop,
        args=(
            settings.database_url,
            settings.reaper_stale_minutes,
            settings.reaper_interval_seconds,
            shutdown,
        ),
        daemon=True,
    )
    reaper_thread.start()
    threading.Thread(target=report_host_capabilities, args=(settings,), daemon=True).start()
    log_lens_llm_health(settings.lens_llm_base_url, managed=settings.lens_llm_managed)
    log.info("supervisor %s started", settings.worker_id)
    try:
        run_supervisor(
            settings,
            shutdown,
            connect_fn=lambda: db.connect(settings.database_url),
            spawn_fn=_spawn,
            child_holder=child_holder,
        )
    finally:
        shutdown.set()
        reaper_thread.join(timeout=5)
    log.info("supervisor %s stopped", settings.worker_id)


def main() -> None:  # pragma: no cover — 실모델 + 시그널 배선 (로컬 실행)
    # 진행 바와 로그가 같은 stderr를 쓴다 — 핸들러가 바를 지웠다 다시 그려야 섞이지 않는다
    console.install_logging(level=logging.INFO)
    settings = load_settings()
    shutdown = threading.Event()
    if "--once" in sys.argv[1:]:
        sys.exit(run_child(settings, shutdown))
    run_supervisor_main(settings, shutdown)


if __name__ == "__main__":  # pragma: no cover
    main()
