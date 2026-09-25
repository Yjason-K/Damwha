"""워커 진입점: 부모(supervisor) 루프와 자식(--once) 한 건 처리.

job 하나를 실제로 어떻게 처리하는지는 여기 없다 — dispatch.py가 handler를 고르고,
jobs.py가 type별 정책을 갖고 있다. 이 파일이 다루는 건 프로세스 경계뿐이다:
시그널 2단계 처리, 자식 spawn과 exit code 분기, backoff, reaper 스레드.
"""

import json
import logging
import os
import signal
import subprocess
import sys
import threading

from . import capabilities, console, db, inventory, runtime_report, wiring
from .config import HF_STALL_SECONDS, load_settings
from .dispatch import dispatch_claimed_job, handle_job, run_once  # noqa: F401 — 공개 진입점
from .jobs import default_live_source
from .llm_server import managed_llm_server
from .llm_server import probe_models as check_lens_llm
from .models import cache_scan, downloads
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


def _reap_own_orphans(conn, settings) -> None:
    """내 신분으로 잠긴 `running` 행을 되돌린다 — **내 `--once` 자식이 하나도 없을 때만**.

    부모는 자식을 한 번에 하나만 띄우고 `_wait_child`로 거두므로, 그 보장이 서는 자리는 셋이다:
    기동 직후(자식을 아직 안 띄웠다), 자식을 거둔 직후, DB 재접속 직후(그 앞에서 자식을 이미
    거뒀다). 회수 실패는 로그만 남기고 루프를 계속한다 — 큐를 멈출 이유가 아니다.
    """
    try:
        requeued, failed = db.reap_own_orphans(conn, settings.worker_id)
    except Exception:  # noqa: BLE001 — 회수 실패가 폴링을 멈춰선 안 된다
        log.exception("own-orphan reclaim failed")
        return
    if requeued or failed:
        log.warning("reclaimed own orphans: requeued=%s failed=%s", requeued, failed)


def _clean_stale_downloads() -> None:
    """버려진 다운로드 임시 파일을 치운다 (모델 다운로드 관리 스펙 §7.5). 실패는 로그만."""
    try:
        n = cache_scan.clean_stale_incomplete(cache_scan.hub_cache_dir(), 2 * HF_STALL_SECONDS)
        if n:
            log.info("removed %d stale download temp file(s)", n)
    except Exception:  # noqa: BLE001
        log.warning("stale download cleanup failed", exc_info=True)


def run_supervisor(settings, shutdown, *, connect_fn, spawn_fn, child_holder) -> None:
    """부모: peek → job 있으면 자식 spawn → 종료 대기 → exit code 분기.

    자식 exit code: 0=처리 완료(즉시 재peek), 3=no job(poll sleep),
    그 외(2 포함)=크래시(capped backoff + WARNING).
    """
    conn = _reconnect(connect_fn, shutdown)
    if conn is None:
        return
    # 데스크톱 앱의 준비 계약. `supervisor <id> started`는 이 함수를 부르기 **전**에 찍히므로
    # 잘못된 DATABASE_URL이면 그 줄만 남고 여기 백오프 루프에 무기한 머문다 — 화면은
    # "준비됨"인데 큐는 영원히 안 돈다. 이 줄만이 "실제로 붙었다"를 뜻한다.
    log.info("supervisor %s ready (db connected)", settings.worker_id)
    _reap_own_orphans(conn, settings)
    _clean_stale_downloads()
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
            # 재접속에서도 같은 줄을 찍는다. 한 번만 찍으면 degraded에서 ok로 돌아온 것을
            # 앱이 관찰할 수 없다 (스펙 §6.6).
            log.info("supervisor %s ready (db connected)", settings.worker_id)
            # DB가 죽으면 그 job을 쥔 자식도 함께 죽는다. 그 행을 여기서 되돌리지 않으면
            # 회수 세 층이 모두 비켜 가 30분 reaper까지 `running`으로 얼어 있다 (P5-C8).
            _reap_own_orphans(conn, settings)
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
        _clean_stale_downloads()

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
            # 크래시한 자식이 쥐고 있던 행도 고아다 (DB는 멀쩡한 OOM·SIGKILL 경로).
            _reap_own_orphans(conn, settings)
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
    log.info("runtime %s", json.dumps(runtime_report.runtime_facts()))
    # HF 다운로드 진행 훅 (스펙 §6.9) — 모델 스택은 job 안에서 wiring 빌더가 import하므로 그보다
    # 앞이다. writer는 WORKER_ID (R-9a). supervisor는 모델을 받지 않으므로 설치하지 않는다.
    downloads.install_hf_progress_hook(settings.worker_id)

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


def _once_argv(run_id: str | None) -> list[str]:
    """`--once` 자식 spawn argv. 부모가 받은 `--run-id`를 그대로 이어 붙인다(있으면).

    `sys.executable`은 그대로 승계한다 — 번들 python이 자동으로 자식에 전해진다.
    """
    argv = [sys.executable, "-m", "damwha_worker", "--once"]
    if run_id is not None:
        argv.append(f"{runtime_report.RUN_ID_PREFIX}{run_id}")
    return argv


def _kill_child_group(proc, *, killpg=os.killpg) -> None:
    """2차 신호 — `--once` 자식의 **프로세스 그룹**을 통째로 SIGKILL한다.

    자식만 `proc.kill()`하면 자식이 즉사해 `managed_llm_server`의
    `finally: _stop(proc)`(terminate→wait→kill)가 영영 안 돈다 — 그 자식이 띄운 LLM 서버는
    pid 1로 재부모화돼 남는다. P4-C20(2026-09-18, 2회 재현)이 실측한 고아가 정확히 그것이다.

    자식은 `_spawn`이 `start_new_session=True`로 띄우므로 세션이자 프로세스 그룹의
    리더이고(pgid == pid), 그 자식이 띄운 것들은 같은 그룹에 있다. 그래서 `killpg(자식 pid)`는
    **우리가 만든 그 세션에만** 닿는다 — supervisor 자신의 그룹도, 남의 그룹도 아니다.

    그룹이 이미 비었거나(ESRCH) 신호를 못 보내면 자식만이라도 죽인다. 여기서 예외가 새면
    신호 핸들러가 터져 supervisor가 `os._exit`까지 못 간다.

    **먼저 `poll()`로 이미 죽은 자식을 거른다.** `proc.kill()`은 `Popen.send_signal`을 거치고
    그 안에 이 가드가 있다(bpo-38630) — `os.killpg`는 그것을 우회한다. "우리 그룹에만 닿는다"는
    위의 근거는 자식이 **아직 거둬지지 않았을 때만** 성립한다: 거둬진 순간 그 번호는 재배정될
    수 있고, `run_supervisor`가 자식을 거두는 자리(`_wait_child`)와 `child_holder`를 비우는
    자리 사이의 창에 신호가 들어오면 남의 그룹을 때린다. 창은 바이트코드 몇 개지만 가드는 공짜다.
    `poll()`은 `_waitpid_lock`을 non-blocking으로 잡으므로 신호 핸들러에서 불러도 교착하지 않는다.
    """
    if proc.poll() is not None:
        return
    try:
        killpg(proc.pid, signal.SIGKILL)
    except OSError:
        proc.kill()


def run_supervisor_main(settings, shutdown: threading.Event, *, run_id: str | None = None) -> None:
    """부모: 2단계 시그널 핸들러 설치 후 supervisor 루프."""
    log.info("runtime %s", json.dumps(runtime_report.runtime_facts()))
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
                log.info("signal %s again — killing child process group and exiting", signum)
                _kill_child_group(proc)
                os._exit(1)

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, _on_signal)

    def _spawn():
        return subprocess.Popen(_once_argv(run_id), start_new_session=True)

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
    # 받아 둔 모델 목록 (모델 다운로드 관리 스펙 §4.2). writer는 부모의 이 스레드 하나다.
    threading.Thread(
        target=inventory.run_inventory_loop,
        args=(settings.database_url, settings, shutdown),
        daemon=True,
    ).start()
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


def _flush_streams() -> None:
    """os._exit 직전에 우리가 쓴 것을 내보낸다. os._exit은 버퍼도 atexit도 건드리지 않는다."""
    for handler in logging.getLogger().handlers:
        handler.flush()
    sys.stdout.flush()
    sys.stderr.flush()


def _hard_exit(code: int, *, flush_fn=_flush_streams, exit_fn=os._exit) -> None:
    """`--once` 자식을 **인터프리터 finalize 없이** 끝낸다.

    P4-C7 실측(2026-09-19): 무진행 90초로 다운로드를 끊은 자식이 job 을 재큐까지 끝내
    놓고 죽지 않았다. 메인 스레드가 `Py_FinalizeEx → wait_for_thread_shutdown →
    threading._shutdown() → Thread.join()` 에서 영구 대기였다 — `_run_watched` 가 버린
    다운로드는 **파이썬 스레드로는 daemon** 이지만 `hf_xet` 이 남긴 네이티브 스레드
    여덟과 non-daemon 파이썬 스레드가 finalize 를 붙잡는다. 감독자는 `os_waitpid` 에서
    돌아오지 못해 다시 peek 하지 않았고, 재큐된 job 을 **아무도 집지 않았다**(11분 관측;
    그 자식을 kill -9 하자 8초 만에 재claim).

    한 건만 처리하고 끝나는 프로세스라 finalize 에 걸 것이 없다 — DB 연결은
    `run_single_job` 이 닫고, 남은 것은 우리가 쓴 로그뿐이라 그것만 먼저 내보낸다.
    flush 가 터져도 반드시 끝낸다: 여기서 예외가 새면 고치려던 그 멈춤이 되돌아온다.
    """
    try:
        flush_fn()
    except Exception:  # noqa: BLE001 — 끝내는 것이 flush 보다 중요하다
        pass
    exit_fn(code)


def main() -> None:  # pragma: no cover — 실모델 + 시그널 배선 (로컬 실행)
    # 진행 바와 로그가 같은 stderr를 쓴다 — 핸들러가 바를 지웠다 다시 그려야 섞이지 않는다
    console.install_logging(level=logging.INFO)
    settings = load_settings()
    shutdown = threading.Event()
    run_id = runtime_report.run_id_arg(sys.argv[1:])
    if "--once" in sys.argv[1:]:
        _hard_exit(run_child(settings, shutdown))
    run_supervisor_main(settings, shutdown, run_id=run_id)


if __name__ == "__main__":  # pragma: no cover
    main()
