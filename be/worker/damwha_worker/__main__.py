import logging
import time

from . import db
from .config import load_settings
from .contracts import parse_payload
from .errors import ErrorKind, classify
from .pipeline.enroll_speaker import run_enroll_speaker
from .pipeline.process_meeting import Models, run_process_meeting
from .storage import Storage

log = logging.getLogger("damwha_worker")


def handle_job(conn, job: dict, models: Models, storage: Storage, worker_id: str) -> str:
    try:
        payload = parse_payload(job["type"], job["payload"])
        if job["type"] == "process_meeting":
            return run_process_meeting(conn, job, payload, models, storage, worker_id=worker_id)
        if job["type"] == "enroll_speaker":
            return run_enroll_speaker(
                conn, job, payload, models.embedder, storage, worker_id=worker_id
            )
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
        if job["type"] == "enroll_speaker":
            speaker_id = (job["payload"] or {}).get("speaker_id")
            if werr.kind is ErrorKind.TRANSIENT and job["attempts"] < job["max_attempts"]:
                return "requeued" if db.requeue(conn, job["id"], worker_id) else "lost"
            return (
                "failed"
                if db.fail_enroll(conn, job["id"], worker_id, speaker_id, error_json)
                else "lost"
            )
        # process_meeting
        meeting_id = job["meeting_id"]
        if werr.kind is ErrorKind.TRANSIENT and job["attempts"] < job["max_attempts"]:
            return "requeued" if db.requeue(conn, job["id"], worker_id) else "lost"
        return (
            "failed"
            if db.fail_process_meeting(conn, job["id"], worker_id, meeting_id, error_json)
            else "lost"
        )


def run_once(conn, worker_id: str, models: Models, storage: Storage) -> str | None:
    job = db.claim(conn, worker_id)
    if job is None:
        return None
    return handle_job(conn, job, models, storage, worker_id)


def main() -> None:  # pragma: no cover — 실모델 + 무한 루프 (로컬 실행)
    logging.basicConfig(level=logging.INFO)
    settings = load_settings()
    storage = Storage(settings.storage_root)
    from .models.registry import build_models  # Task 14

    conn = db.connect(settings.database_url)
    log.info("worker %s started", settings.worker_id)
    while True:
        job = db.claim(conn, settings.worker_id)
        if job is None:
            time.sleep(settings.poll_interval_seconds)
            continue
        models = build_models(job["payload"], settings)
        from .heartbeat import Heartbeat

        with Heartbeat(
            settings.database_url,
            job["id"],
            settings.worker_id,
            settings.heartbeat_interval_seconds,
        ):
            outcome = handle_job(conn, job, models, storage, settings.worker_id)
        log.info("job %s → %s", job["id"], outcome)
        time.sleep(settings.poll_interval_seconds)  # requeue 후에도 poll 간격 유지


if __name__ == "__main__":  # pragma: no cover
    main()
