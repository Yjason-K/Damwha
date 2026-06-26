import logging
import time

from . import db
from .config import load_settings
from .contracts import parse_payload
from .errors import ErrorKind, classify
from .pipeline.enroll_speaker import run_enroll_speaker
from .pipeline.index_meeting import run_index_meeting
from .pipeline.process_meeting import Models, run_process_meeting
from .storage import Storage

log = logging.getLogger("damwha_worker")


def handle_job(
    conn,
    job: dict,
    storage: Storage,
    worker_id: str,
    *,
    models: Models | None = None,
    text_embedder=None,
    search_embedding=None,
) -> str:
    try:
        payload = parse_payload(job["type"], job["payload"])
        if job["type"] == "process_meeting":
            sm, sd = search_embedding or (None, None)
            return run_process_meeting(
                conn,
                job,
                payload,
                models,
                storage,
                worker_id=worker_id,
                search_embedding_model=sm,
                search_embedding_dim=sd,
            )
        if job["type"] == "enroll_speaker":
            return run_enroll_speaker(
                conn, job, payload, models.embedder, storage, worker_id=worker_id
            )
        if job["type"] == "index_meeting":
            return run_index_meeting(conn, job, payload, text_embedder, worker_id=worker_id)
        raise ValueError(f"unknown job type {job['type']}")
    except Exception as exc:  # noqa: BLE001 — 분류해서 requeue/fail
        werr = classify(exc)
        error_json = werr.to_json(stage=job.get("stage"))
        log.warning(
            "job %s failed: code=%s kind=%s attempt=%s/%s",
            job["id"],
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
    models: Models | None,
    storage: Storage,
    *,
    text_embedder=None,
    search_embedding=None,
) -> str | None:
    job = db.claim(conn, worker_id)
    if job is None:
        return None
    return handle_job(
        conn,
        job,
        storage,
        worker_id,
        models=models,
        text_embedder=text_embedder,
        search_embedding=search_embedding,
    )


def main() -> None:  # pragma: no cover — 실모델 + 무한 루프 (로컬 실행)
    logging.basicConfig(level=logging.INFO)
    settings = load_settings()
    storage = Storage(settings.storage_root)
    conn = db.connect(settings.database_url)
    log.info("worker %s started", settings.worker_id)
    while True:
        job = db.claim(conn, settings.worker_id)
        if job is None:
            time.sleep(settings.poll_interval_seconds)
            continue
        from .heartbeat import Heartbeat
        from .models.registry import build_models, build_text_embedder

        hb_args = (
            settings.database_url,
            job["id"],
            settings.worker_id,
            settings.heartbeat_interval_seconds,
        )
        if job["type"] == "index_meeting":
            text_embedder = build_text_embedder(settings)
            with Heartbeat(*hb_args):
                outcome = handle_job(
                    conn, job, storage, settings.worker_id, text_embedder=text_embedder
                )
        else:
            models = build_models(job["payload"], settings)
            with Heartbeat(*hb_args):
                outcome = handle_job(
                    conn,
                    job,
                    storage,
                    settings.worker_id,
                    models=models,
                    search_embedding=(
                        settings.search_embedding_model,
                        settings.search_embedding_dim,
                    ),
                )
        log.info("job %s → %s", job["id"], outcome)
        time.sleep(settings.poll_interval_seconds)


if __name__ == "__main__":  # pragma: no cover
    main()
