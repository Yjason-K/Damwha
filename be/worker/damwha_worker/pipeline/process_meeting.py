import logging
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

from .. import console, db
from ..contracts import ProcessMeetingPayload
from ..errors import ShutdownRequested
from ..models.base import VAD, Diarizer, Embedder, Transcriber
from ..storage import Storage
from . import ffmpeg
from .align import build_utterances
from .identify import centroids_by_label, identify_clusters
from .progress import SttProgressReporter
from .speaker_arbiter import make_embedding_arbiter
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
        matches = identify_clusters(
            conn,
            centroids,
            model=payload.models.embedding.model,
            dimension=payload.models.embedding.dimension,
            threshold=payload.identify.threshold,
            suggest_threshold=payload.identify.suggest_threshold,
        )
        identified = sum(1 for m in matches.values() if m.speaker_id is not None)
        suggested = sum(1 for m in matches.values() if m.suggested_speaker_id is not None)
        t["detail"] = f"identified={identified}/{len(matches)} suggested={suggested}"

    # 6) STT — VAD 발화 구간만 디코딩(무음 환각 방지). 빈 VAD면 호출 자체를 생략
    #    (clip_timestamps=[]는 라이브러리가 '전체 오디오'로 해석할 수 있다).
    enter_stage(conn, job_id, worker_id, "stt", 75, shutdown_event)
    with timed_stage("stt", ctx) as t:
        prepared = prepare_stt_spans(speech_spans, duration_ms)
        if prepared:
            # 전사는 이 파이프라인에서 가장 긴 단계다 — clip 단위 진행을 TTY 진행 바와
            # 콘솔 로그, job.progress(stt 75 → align 90 구간)에 흘린다.
            with console.progress_bar("stt") as bar:
                report = SttProgressReporter(
                    ctx,
                    total_units=len(prepared),
                    set_progress=lambda progress: db.set_stage(
                        conn, job_id, worker_id, "stt", progress
                    ),
                    bar=bar,
                    progress_from=75,
                    progress_to=90,
                )
                words = models.transcriber.transcribe(
                    norm_path, payload.models.language, prepared, on_progress=report
                )
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
        # 임베딩 판정자: 백채널 스무딩의 흡수/보존을 run 구간의 실제 목소리로 판정
        arbiter = make_embedding_arbiter(norm_path, models.embedder, centroids)
        utts = build_utterances(words, segments, failed_spans=speech_spans, arbitrate=arbiter)
        t["detail"] = f"utterances={len(utts)}"

    utterance_rows = [
        {
            "speaker_id": matches[u.diar_label].speaker_id if u.diar_label in matches else None,
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

    # 모든 라벨을 cluster로 보존한다. 자동 연결된 라벨도 행을 남기는 이유: 이 표가
    # 회의별 diar_label→speaker 기록이고, 자동 연결을 사용자가 되돌리는(resolve)
    # 진입점이며, 애매한 후보(suggested_*)를 실을 자리이기 때문이다.
    cluster_rows = [
        {
            "diar_label": label,
            "centroid": centroids.get(label),
            "resolved_speaker_id": m.speaker_id,
            "suggested_speaker_id": m.suggested_speaker_id,
            "suggested_similarity": m.similarity if m.suggested_speaker_id else None,
        }
        for label, m in matches.items()
    ]

    # 8) persist
    enter_stage(conn, job_id, worker_id, "persist", 95, shutdown_event)
    with timed_stage("persist", ctx) as t:
        # v3 payload는 API가 해석한 값을 싣고 온다. v1/v2 유래는 None이라 워커
        # env로 폴백한다 (spec §4).
        # followups는 v5부터 — 꺼진 쪽은 모델을 None으로 내려 persist가 후속 job을
        # 큐잉하지 않게 한다. 사용자는 나중에 API로 직접 실행한다. v1~v4 유래는
        # 둘 다 True라 동작이 그대로다.
        lens_model = lens_llm_model if payload.followups.lens else None
        summary_model = (
            (payload.models.summary_model or summary_llm_model)
            if payload.followups.summary
            else None
        )
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
            lens_llm_model=lens_model,
            summary_llm_model=summary_model,
        )
        t["detail"] = (
            f"utterances={len(utterance_rows)} clusters={len(cluster_rows)} outcome={outcome}"
        )

    total_ms = int((time.perf_counter() - total_t0) * 1000)
    log.info("%s process_meeting done outcome=%s total_ms=%d", ctx, outcome, total_ms)
    return outcome
