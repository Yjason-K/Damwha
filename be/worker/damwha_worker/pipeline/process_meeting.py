import os
from collections.abc import Callable
from dataclasses import dataclass

from .. import db
from ..contracts import ProcessMeetingPayload
from ..errors import ErrorKind, WorkerError
from ..models.base import VAD, Diarizer, Embedder, Transcriber
from ..storage import Storage
from . import ffmpeg
from .align import build_utterances
from .identify import centroids_by_label, identify_clusters


@dataclass
class Models:
    vad: VAD
    diarizer: Diarizer
    embedder: Embedder
    transcriber: Transcriber


def _stage(conn, job_id, worker_id, stage, progress):
    if db.set_stage(conn, job_id, worker_id, stage, progress) == 0:
        raise WorkerError(
            "lost_ownership", f"lock lost at {stage}", ErrorKind.TRANSIENT, stage=stage
        )


def run_process_meeting(
    conn,
    job: dict,
    payload: ProcessMeetingPayload,
    models: Models,
    storage: Storage,
    *,
    worker_id: str,
    normalize_fn: Callable[[str, str], None] | None = None,
    probe_fn: Callable[[str], ffmpeg.ProbeResult] | None = None,
) -> str:
    # 기본값은 호출 시점에 해석한다 — def-time에 모듈 속성을 캡처하지 않으므로
    # 테스트가 ffmpeg.normalize/probe를 monkeypatch할 수 있다.
    normalize_fn = normalize_fn or ffmpeg.normalize
    probe_fn = probe_fn or ffmpeg.probe
    job_id = job["id"]
    meeting_id = payload.meeting_id

    # mark processing (meeting guard); 0-row → lost ownership
    if db.mark_processing(conn, meeting_id, job_id, payload.processing_version) == 0:
        return "lost"

    # 1) normalize + probe (정규화는 'vad' stage 이전 — stage enum에 normalize 없음)
    src = storage.resolve(payload.audio_key)
    norm_key = storage.normalized_key(meeting_id)
    norm_path = storage.resolve(norm_key)
    if not storage.exists(norm_key):
        os.makedirs(os.path.dirname(norm_path), exist_ok=True)
        normalize_fn(src, norm_path)
    duration_ms = probe_fn(norm_path).duration_ms

    # 2) VAD (구간은 STT 실패 추적/무음 판정 보조용)
    _stage(conn, job_id, worker_id, "vad", 15)
    speech_spans = models.vad.detect(norm_path)

    # 3) diarize
    _stage(conn, job_id, worker_id, "diarize", 35)
    segments = models.diarizer.diarize(norm_path)

    # 4) embed → centroids
    _stage(conn, job_id, worker_id, "identify", 50)
    embeddings = models.embedder.embed(norm_path, segments)
    centroids = centroids_by_label(segments, embeddings)

    # 5) identify
    label_to_speaker = identify_clusters(
        conn,
        centroids,
        model=payload.models.embedding.model,
        dimension=payload.models.embedding.dimension,
        threshold=payload.identify.threshold,
    )

    # 6) STT
    _stage(conn, job_id, worker_id, "stt", 75)
    words = models.transcriber.transcribe(norm_path, payload.models.language)

    # 7) align
    _stage(conn, job_id, worker_id, "align", 90)
    utts = build_utterances(words, segments, failed_spans=speech_spans if not words else None)

    utterance_rows = [
        {
            "speaker_id": label_to_speaker.get(u.diar_label),
            "diar_label": u.diar_label,
            "start_ms": u.start_ms,
            "end_ms": u.end_ms,
            "text": u.text,
            "confidence": u.confidence,
            "status": u.status,
            "transcript_error": None,
            "order_index": u.order_index,
        }
        for u in utts
    ]

    # 미식별 라벨만 cluster로 보존 (centroid 포함)
    cluster_rows = [
        {
            "diar_label": label,
            "centroid": centroids.get(label),
            "resolved_speaker_id": None,
        }
        for label, sid in label_to_speaker.items()
        if sid is None
    ]

    # 8) persist
    _stage(conn, job_id, worker_id, "persist", 95)
    return db.persist_process_meeting(
        conn,
        job_id=job_id,
        worker_id=worker_id,
        meeting_id=meeting_id,
        processing_version=payload.processing_version,
        normalized_key=norm_key,
        duration_ms=duration_ms,
        utterances=utterance_rows,
        clusters=cluster_rows,
    )
