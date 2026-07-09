import logging
import time

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


def main() -> None:  # pragma: no cover — 실모델 + 무한 루프 (로컬 실행)
    logging.basicConfig(level=logging.INFO)
    settings = load_settings()
    storage = Storage(settings.storage_root)
    conn = db.connect(settings.database_url)
    from .heartbeat import Heartbeat
    from .models.registry import build_embedder, build_models, build_text_embedder

    log.info("worker %s started", settings.worker_id)
    while True:
        job = db.claim(conn, settings.worker_id)
        if job is None:
            time.sleep(settings.poll_interval_seconds)
            continue
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
            build_models_fn=build_models,
            build_embedder_fn=build_embedder,
            build_text_embedder_fn=build_text_embedder,
            heartbeat_cm=hb,
        )
        log.info("job %s type=%s → %s", job["id"], job["type"], outcome)
        time.sleep(settings.poll_interval_seconds)


if __name__ == "__main__":  # pragma: no cover
    main()
