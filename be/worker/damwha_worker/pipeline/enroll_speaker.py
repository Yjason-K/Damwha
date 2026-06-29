import logging
import os
import time
from collections.abc import Callable

from .. import db
from ..contracts import EnrollSpeakerPayload
from ..models.base import DiarSegment, Embedder
from ..storage import Storage
from . import ffmpeg
from .timing import timed_stage

log = logging.getLogger("damwha_worker")


def run_enroll_speaker(
    conn,
    job: dict,
    payload: EnrollSpeakerPayload,
    embedder: Embedder,
    storage: Storage,
    *,
    worker_id: str,
    normalize_fn: Callable[[str, str], None] | None = None,
    probe_fn: Callable[[str], ffmpeg.ProbeResult] | None = None,
) -> str:
    # 기본값은 호출 시점 해석 (monkeypatch 가능) — run_process_meeting와 동일 이유.
    normalize_fn = normalize_fn or ffmpeg.normalize
    probe_fn = probe_fn or ffmpeg.probe
    job_id = job["id"]
    speaker_id = payload.speaker_id
    ctx = f"job={job_id} speaker={speaker_id}"
    total_t0 = time.perf_counter()
    log.info("%s enroll_speaker start", ctx)

    db.set_stage(conn, job_id, worker_id, "extract_embedding", 30)
    src = storage.resolve(payload.audio_key)
    norm_key = f"speakers/{speaker_id}/normalized.wav"
    norm_path = storage.resolve(norm_key)
    with timed_stage("extract_embedding", ctx) as t:
        if not storage.exists(norm_key):
            os.makedirs(os.path.dirname(norm_path), exist_ok=True)
            normalize_fn(src, norm_path)
            reused = 0
        else:
            reused = 1
        duration_ms = probe_fn(norm_path).duration_ms
        segment = DiarSegment("FULL", 0, duration_ms)
        embedding = embedder.embed(norm_path, [segment])[0]
        t["detail"] = f"reused={reused} duration_ms={duration_ms} dim={len(embedding)}"

    db.set_stage(conn, job_id, worker_id, "enroll_persist", 80)
    with timed_stage("enroll_persist", ctx) as t:
        outcome = db.persist_enroll(
            conn,
            job_id=job_id,
            worker_id=worker_id,
            speaker_id=speaker_id,
            embedding=embedding,
            model=payload.embedding.model,
            dimension=payload.embedding.dimension,
            sample_duration_ms=duration_ms,
            quality_score=None,
        )
        t["detail"] = f"outcome={outcome}"

    total_ms = int((time.perf_counter() - total_t0) * 1000)
    log.info("%s enroll_speaker done outcome=%s total_ms=%d", ctx, outcome, total_ms)
    return outcome
