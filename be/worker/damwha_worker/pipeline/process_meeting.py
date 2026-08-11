import logging
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

from .. import db
from ..contracts import ProcessMeetingPayload
from ..errors import ShutdownRequested
from ..models.base import VAD, Diarizer, Embedder, Transcriber
from ..storage import Storage
from . import ffmpeg
from .align import build_utterances
from .identify import centroids_by_label, identify_clusters
from .stage import enter_stage
from .stt_spans import prepare_stt_spans
from .timing import timed_stage

log = logging.getLogger("damwha_worker")


@dataclass
class Models:
    vad: VAD
    diarizer: Diarizer
    embedder: Embedder
    transcriber: Transcriber


def run_process_meeting(
    conn,
    job: dict,
    payload: ProcessMeetingPayload,
    models: Models,
    storage: Storage,
    *,
    worker_id: str,
    search_embedding_model: str | None = None,
    search_embedding_dim: int | None = None,
    normalize_fn: Callable[[str, str], None] | None = None,
    probe_fn: Callable[[str], ffmpeg.ProbeResult] | None = None,
    default_speaker_prefix: str = "Speaker",
    lens_llm_model: str | None = None,
    summary_llm_model: str | None = None,
    shutdown_event: threading.Event | None = None,
) -> str:
    # 기본값은 호출 시점에 해석한다 — def-time에 모듈 속성을 캡처하지 않으므로
    # 테스트가 ffmpeg.normalize/probe를 monkeypatch할 수 있다.
    normalize_fn = normalize_fn or ffmpeg.normalize
    probe_fn = probe_fn or ffmpeg.probe
    if shutdown_event is not None and shutdown_event.is_set():
        # normalize(ffmpeg)는 stage enum 밖이지만 긴 파일에서 수 분 걸릴 수 있다 —
        # mark_processing 전에 확인해 아무 부작용 없이 반납한다.
        raise ShutdownRequested("shutdown requested before normalize")
    job_id = job["id"]
    meeting_id = payload.meeting_id
    ctx = f"job={job_id} meeting={meeting_id}"
    total_t0 = time.perf_counter()
    log.info("%s process_meeting start pv=%s", ctx, payload.processing_version)

    # mark processing (meeting guard); 0-row → lost ownership
    if db.mark_processing(conn, meeting_id, job_id, payload.processing_version) == 0:
        log.info("%s process_meeting lost ownership at mark_processing", ctx)
        return "lost"

    # 1) normalize + probe (정규화는 'vad' stage 이전 — stage enum에 normalize 없음)
    src = storage.resolve(payload.audio_key)
    norm_key = storage.normalized_key(meeting_id)
    norm_path = storage.resolve(norm_key)
    with timed_stage("normalize", ctx) as t:
        if not storage.exists(norm_key):
            os.makedirs(os.path.dirname(norm_path), exist_ok=True)
            normalize_fn(src, norm_path)
            reused = 0
        else:
            reused = 1
        duration_ms = probe_fn(norm_path).duration_ms
        t["detail"] = f"reused={reused} duration_ms={duration_ms}"

    # 2) VAD (구간은 STT 실패 추적/무음 판정 보조용)
    enter_stage(conn, job_id, worker_id, "vad", 15, shutdown_event)
    with timed_stage("vad", ctx) as t:
        speech_spans = models.vad.detect(norm_path)
        t["detail"] = f"spans={len(speech_spans)}"

    # 3) diarize
    enter_stage(conn, job_id, worker_id, "diarize", 35, shutdown_event)
    with timed_stage("diarize", ctx) as t:
        segments = models.diarizer.diarize(norm_path)
        t["detail"] = f"segments={len(segments)}"

    # 4) embed → centroids
    enter_stage(conn, job_id, worker_id, "identify", 50, shutdown_event)
    with timed_stage("embed", ctx) as t:
        embeddings = models.embedder.embed(norm_path, segments)
        centroids = centroids_by_label(segments, embeddings)
        t["detail"] = f"clusters={len(centroids)}"

    # 5) identify
    with timed_stage("identify", ctx) as t:
        label_to_speaker = identify_clusters(
            conn,
            centroids,
            model=payload.models.embedding.model,
            dimension=payload.models.embedding.dimension,
            threshold=payload.identify.threshold,
        )
        identified = sum(1 for sid in label_to_speaker.values() if sid is not None)
        t["detail"] = f"identified={identified}/{len(label_to_speaker)}"

    # 6) STT — VAD 발화 구간만 디코딩(무음 환각 방지). 빈 VAD면 호출 자체를 생략
    #    (clip_timestamps=[]는 라이브러리가 '전체 오디오'로 해석할 수 있다).
    enter_stage(conn, job_id, worker_id, "stt", 75, shutdown_event)
    with timed_stage("stt", ctx) as t:
        prepared = prepare_stt_spans(speech_spans, duration_ms)
        if prepared:
            words = models.transcriber.transcribe(norm_path, payload.models.language, prepared)
        else:
            words = []
        clipped_ms = sum(s.end_ms - s.start_ms for s in prepared)
        t["detail"] = (
            f"words={len(words)} spans={len(prepared)} "
            f"clipped_ms={clipped_ms} duration_ms={duration_ms}"
        )

    # 7) align
    enter_stage(conn, job_id, worker_id, "align", 90, shutdown_event)
    with timed_stage("align", ctx) as t:
        utts = build_utterances(words, segments, failed_spans=speech_spans)
        t["detail"] = f"utterances={len(utts)}"

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
    enter_stage(conn, job_id, worker_id, "persist", 95, shutdown_event)
    with timed_stage("persist", ctx) as t:
        outcome = db.persist_process_meeting(
            conn,
            job_id=job_id,
            worker_id=worker_id,
            meeting_id=meeting_id,
            processing_version=payload.processing_version,
            normalized_key=norm_key,
            duration_ms=duration_ms,
            utterances=utterance_rows,
            clusters=cluster_rows,
            embedding_model=payload.models.embedding.model,
            embedding_dim=payload.models.embedding.dimension,
            default_speaker_prefix=default_speaker_prefix,
            index_search_model=search_embedding_model,
            index_search_dim=search_embedding_dim,
            lens_llm_model=lens_llm_model,
            summary_llm_model=summary_llm_model,
        )
        t["detail"] = (
            f"utterances={len(utterance_rows)} clusters={len(cluster_rows)} outcome={outcome}"
        )

    total_ms = int((time.perf_counter() - total_t0) * 1000)
    log.info("%s process_meeting done outcome=%s total_ms=%d", ctx, outcome, total_ms)
    return outcome
