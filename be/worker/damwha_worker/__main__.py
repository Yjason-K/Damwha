import logging
import signal
import threading

from . import db
from .config import load_settings
from .contracts import parse_payload
from .errors import ErrorKind, ShutdownRequested, classify
from .pipeline.enroll_speaker import run_enroll_speaker
from .pipeline.index_meeting import run_index_meeting
from .pipeline.process_meeting import run_process_meeting
from .storage import Storage

log = logging.getLogger("damwha_worker")


def handle_job(
    conn,
    job: dict,
    storage: Storage,
    worker_id: str,
    *,
    build_models=None,
    build_embedder=None,
    build_text_embedder=None,
    search_embedding=None,
    default_speaker_prefix="Speaker",
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
    search_embedding=None,
    default_speaker_prefix="Speaker",
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
        search_embedding=search_embedding,
        default_speaker_prefix=default_speaker_prefix,
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
            search_embedding=(settings.search_embedding_model, settings.search_embedding_dim),
            default_speaker_prefix=settings.default_speaker_prefix,
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
            heartbeat_cm=hb,
            shutdown_event=shutdown,
        )
        # 구 run_loop의 job-level 로그 유지
        log.info("job %s type=%s → %s", job["id"], job["type"], outcome)
        return 0
    finally:
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


def run_loop(conn, settings, shutdown, *, connect_fn, dispatch_fn) -> None:
    """폴 루프: claim → dispatch. 어떤 예외에도 죽지 않는다 — 재접속 후 계속.

    conn의 수명은 이 함수가 책임진다 — 정상 종료 시에도 close하고 반환한다.
    """
    job = None  # 현재 in-flight job (예외 시 requeue 대상)
    while not shutdown.is_set():
        try:
            job = db.claim(conn, settings.worker_id)
            if job is None:
                shutdown.wait(settings.poll_interval_seconds)
                continue
            outcome = dispatch_fn(conn, job)
            log.info("job %s type=%s → %s", job["id"], job["type"], outcome)
            job = None  # 정상 완료 — 큐에 남은 job 즉시 재claim
        except Exception:  # noqa: BLE001 — 루프는 죽지 않는다
            log.exception("worker loop error — reconnecting")
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
            conn = _reconnect(connect_fn, shutdown)
            if conn is None:
                return  # 재접속 중 shutdown (conn 없음 — close 불요)
            if job is not None:
                # in-flight job을 reaper 대기 없이 즉시 반환 시도 — 단, attempts가
                # 남았을 때만. claim은 attempts를 필터하지 않으므로, 소진된 job을
                # requeue하면 결정적 오류를 무한 재claim한다. 소진 시 running으로
                # 남겨 reaper가 fail + meeting/speaker 전파를 수행한다.
                if job["attempts"] < job["max_attempts"]:
                    try:
                        db.requeue(conn, job["id"], settings.worker_id)
                    except Exception:  # noqa: BLE001
                        log.warning(
                            "in-flight requeue failed — reaper will recover job %s", job["id"]
                        )
                else:
                    log.warning("job %s attempts exhausted — leaving for reaper", job["id"])
                job = None
            # 반복 오류 hot-loop 방지: 어떤 outer 예외든 다음 시도 전 poll 간격만큼 쉰다
            if shutdown.wait(settings.poll_interval_seconds):
                break
    try:
        conn.close()
    except Exception:  # noqa: BLE001
        pass


def main() -> None:  # pragma: no cover — 실모델 + 시그널 배선 (로컬 실행)
    logging.basicConfig(level=logging.INFO)
    settings = load_settings()
    storage = Storage(settings.storage_root)
    shutdown = threading.Event()

    def _on_signal(signum, frame):
        log.info(
            "signal %s received — will stop at next stage boundary (send again to force)", signum
        )
        shutdown.set()
        signal.signal(signum, signal.SIG_DFL)  # 2차 시그널 = 기본 동작(즉시 종료)

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, _on_signal)

    from .heartbeat import Heartbeat
    from .models.registry import build_embedder, build_models, build_text_embedder

    conn = _reconnect(lambda: db.connect(settings.database_url), shutdown)
    if conn is None:
        log.info("shutdown before initial DB connection")
        return
    log.info("worker %s started", settings.worker_id)

    def _dispatch(c, job):
        hb = Heartbeat(
            settings.database_url,
            job["id"],
            settings.worker_id,
            settings.heartbeat_interval_seconds,
        )
        return dispatch_claimed_job(
            c,
            job,
            storage,
            settings,
            build_models_fn=build_models,
            build_embedder_fn=build_embedder,
            build_text_embedder_fn=build_text_embedder,
            heartbeat_cm=hb,
            shutdown_event=shutdown,
        )

    run_loop(
        conn,
        settings,
        shutdown,
        connect_fn=lambda: db.connect(settings.database_url),
        dispatch_fn=_dispatch,
    )
    log.info("worker %s stopped", settings.worker_id)


if __name__ == "__main__":  # pragma: no cover
    main()
