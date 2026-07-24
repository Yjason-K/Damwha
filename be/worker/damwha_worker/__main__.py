import logging
import os
import signal
import subprocess
import sys
import threading

from . import db
from .config import load_settings
from .contracts import parse_payload
from .errors import ErrorKind, ShutdownRequested, classify
from .pipeline.enroll_speaker import run_enroll_speaker
from .pipeline.extract_lenses import run_extract_lenses
from .pipeline.index_meeting import run_index_meeting
from .pipeline.process_meeting import run_process_meeting
from .storage import Storage

log = logging.getLogger("damwha_worker")

_MAX_BACKOFF_SECONDS = 60.0
_TIMEOUT_EXC = subprocess.TimeoutExpired


def handle_job(
    conn,
    job: dict,
    storage: Storage,
    worker_id: str,
    *,
    build_models=None,
    build_embedder=None,
    build_text_embedder=None,
    build_lens_client=None,
    search_embedding=None,
    default_speaker_prefix="Speaker",
    lens_llm_model=None,
    shutdown_event=None,
) -> str:
    try:
        if shutdown_event is not None and shutdown_event.is_set():
            # claim과 dispatch 사이에 시그널 — 모델 빌드 전에 반납
            raise ShutdownRequested("shutdown requested before dispatch")
        payload = parse_payload(job["type"], job["payload"])
        if job["type"] == "process_meeting":
            sm, sd = search_embedding or (None, None)
            models = build_models()
            return run_process_meeting(
                conn,
                job,
                payload,
                models,
                storage,
                worker_id=worker_id,
                search_embedding_model=sm,
                search_embedding_dim=sd,
                default_speaker_prefix=default_speaker_prefix,
                lens_llm_model=lens_llm_model,
                shutdown_event=shutdown_event,
            )
        if job["type"] == "enroll_speaker":
            embedder = build_embedder()
            return run_enroll_speaker(
                conn,
                job,
                payload,
                embedder,
                storage,
                worker_id=worker_id,
                shutdown_event=shutdown_event,
            )
        if job["type"] == "index_meeting":
            text_embedder = build_text_embedder()
            return run_index_meeting(
                conn,
                job,
                payload,
                text_embedder,
                worker_id=worker_id,
                shutdown_event=shutdown_event,
            )
        if job["type"] == "extract_lenses":
            client = build_lens_client()
            return run_extract_lenses(
                conn, job, payload, client, worker_id=worker_id, shutdown_event=shutdown_event
            )
        raise ValueError(f"unknown job type {job['type']}")
    except ShutdownRequested:
        log.info("job %s type=%s → shutdown requeue", job["id"], job["type"])
        ok = db.requeue_for_shutdown(conn, job["id"], worker_id)
        return "requeued_shutdown" if ok else "lost"
    except Exception as exc:  # noqa: BLE001 — 분류해서 requeue/fail
        werr = classify(exc)
        error_json = werr.to_json(stage=job.get("stage"))
        log.warning(
            "job %s type=%s failed: code=%s kind=%s attempt=%s/%s",
            job["id"],
            job["type"],
            werr.code,
            werr.kind.value,
            job["attempts"],
            job["max_attempts"],
        )
        transient_retry = werr.kind is ErrorKind.TRANSIENT and job["attempts"] < job["max_attempts"]
        if job["type"] == "enroll_speaker":
            speaker_id = (job["payload"] or {}).get("speaker_id")
            if transient_retry:
                return "requeued" if db.requeue(conn, job["id"], worker_id) else "lost"
            ok = db.fail_enroll(conn, job["id"], worker_id, speaker_id, error_json)
            return "failed" if ok else "lost"
        if job["type"] == "index_meeting":
            # 검색 색인 실패는 job만 — meeting은 done 유지
            if transient_retry:
                return "requeued" if db.requeue(conn, job["id"], worker_id) else "lost"
            return "failed" if db.fail_job(conn, job["id"], worker_id, error_json) else "lost"
        if job["type"] == "extract_lenses":
            run_id = (job["payload"] or {}).get("extraction_run_id")
            processing_version = (job["payload"] or {}).get("processing_version")
            if transient_retry:
                return "requeued" if db.requeue(conn, job["id"], worker_id) else "lost"
            return db.fail_lens_extraction(
                conn, job["id"], worker_id, run_id, processing_version, error_json
            )
        # process_meeting
        meeting_id = job["meeting_id"]
        if transient_retry:
            return "requeued" if db.requeue(conn, job["id"], worker_id) else "lost"
        return (
            "failed"
            if db.fail_process_meeting(conn, job["id"], worker_id, meeting_id, error_json)
            else "lost"
        )


def run_once(
    conn,
    worker_id: str,
    storage: Storage,
    *,
    build_models=None,
    build_embedder=None,
    build_text_embedder=None,
    build_lens_client=None,
    search_embedding=None,
    default_speaker_prefix="Speaker",
    lens_llm_model=None,
    shutdown_event=None,
) -> str | None:
    job = db.claim(conn, worker_id)
    if job is None:
        return None
    return handle_job(
        conn,
        job,
        storage,
        worker_id,
        build_models=build_models,
        build_embedder=build_embedder,
        build_text_embedder=build_text_embedder,
        build_lens_client=build_lens_client,
        search_embedding=search_embedding,
        default_speaker_prefix=default_speaker_prefix,
        lens_llm_model=lens_llm_model,
        shutdown_event=shutdown_event,
    )


def dispatch_claimed_job(
    conn,
    job: dict,
    storage: Storage,
    settings,
    *,
    build_models_fn,
    build_embedder_fn,
    build_text_embedder_fn,
    heartbeat_cm,
    build_lens_client_fn=None,
    shutdown_event=None,
) -> str:
    """claim된 job 1건: heartbeat 진입 → 콜백(지연 빌드)을 handle_job에 주입."""
    with heartbeat_cm:
        return handle_job(
            conn,
            job,
            storage,
            settings.worker_id,
            build_models=lambda: build_models_fn(job["payload"], settings),
            build_embedder=lambda: build_embedder_fn(job["payload"], settings),
            build_text_embedder=lambda: build_text_embedder_fn(settings),
            build_lens_client=(
                (lambda: build_lens_client_fn(settings)) if build_lens_client_fn else None
            ),
            search_embedding=(settings.search_embedding_model, settings.search_embedding_dim),
            default_speaker_prefix=settings.default_speaker_prefix,
            lens_llm_model=settings.lens_llm_model,
            shutdown_event=shutdown_event,
        )


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
            heartbeat_cm=hb,
            shutdown_event=shutdown,
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

    def _build_models(payload, worker_settings):
        from .models.registry import build_models

        return build_models(payload, worker_settings)

    def _build_embedder(payload, worker_settings):
        from .models.registry import build_embedder

        return build_embedder(payload, worker_settings)

    def _build_text_embedder(worker_settings):
        from .models.registry import build_text_embedder

        return build_text_embedder(worker_settings)

    def _build_lens_client(worker_settings):
        from .lens_client import LensClient

        return LensClient(
            worker_settings.lens_llm_base_url,
            worker_settings.lens_llm_api_key,
            worker_settings.lens_llm_timeout_seconds,
        )

    return run_single_job(
        settings,
        storage,
        shutdown,
        connect_fn=lambda: db.connect(settings.database_url),
        build_models_fn=_build_models,
        build_embedder_fn=_build_embedder,
        build_text_embedder_fn=_build_text_embedder,
        build_lens_client_fn=_build_lens_client,
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

    log.info("supervisor %s started", settings.worker_id)
    run_supervisor(
        settings,
        shutdown,
        connect_fn=lambda: db.connect(settings.database_url),
        spawn_fn=_spawn,
        child_holder=child_holder,
    )
    log.info("supervisor %s stopped", settings.worker_id)


def main() -> None:  # pragma: no cover — 실모델 + 시그널 배선 (로컬 실행)
    logging.basicConfig(level=logging.INFO)
    settings = load_settings()
    shutdown = threading.Event()
    if "--once" in sys.argv[1:]:
        sys.exit(run_child(settings, shutdown))
    run_supervisor_main(settings, shutdown)


if __name__ == "__main__":  # pragma: no cover
    main()
