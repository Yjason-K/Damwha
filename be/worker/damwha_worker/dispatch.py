"""claim한 job 1건을 handler에 넘기고, 예외를 outcome으로 번역한다.

이 파일이 아는 것은 세 가지뿐이다 — shutdown이 걸렸는가, payload가 계약에 맞는가,
예외가 TRANSIENT인가. job type별 분기는 전부 `jobs.HANDLERS`가 답한다.
"""

import logging
import threading

from . import db
from .contracts import parse_payload
from .errors import ErrorKind, ShutdownRequested, classify
from .jobs import JobContext, handler_for, no_llm_server
from .storage import Storage

log = logging.getLogger("damwha_worker")


def run_job(conn, job: dict, ctx: JobContext) -> str:
    """job 1건 처리. 성공/실패/반납 어느 쪽이든 outcome 문자열로 끝난다 — 예외는 밖으로
    나가지 않는다. 호출자(run_single_job)는 이 값을 로그로만 쓴다."""
    handler = handler_for(job["type"])
    try:
        if ctx.shutdown_event is not None and ctx.shutdown_event.is_set():
            # claim과 dispatch 사이에 시그널 — 모델 빌드 전에 반납
            raise ShutdownRequested("shutdown requested before dispatch")
        # 등록되지 않은 type이면 여기서 ValueError가 난다 (contracts.parse_payload).
        payload = parse_payload(job["type"], job["payload"])
        return handler.run(conn, job, payload, ctx)
    except ShutdownRequested:
        return handler.on_shutdown(conn, job, ctx)
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
        retry = werr.kind is ErrorKind.TRANSIENT and job["attempts"] < job["max_attempts"]
        return handler.on_failure(conn, job, ctx, error_json, retry=retry)


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
    build_summary_client=None,
    search_embedding=None,
    default_speaker_prefix="Speaker",
    lens_llm_model=None,
    summary_llm_model=None,
    meeting_timezone="Asia/Seoul",
    llm_server=None,
    shutdown_event=None,
    register_abort=None,
    build_live_models=None,
    build_live_source=None,
    live_max_minutes=240.0,
) -> str:
    """주입물을 kwarg로 받는 입구. 테스트는 필요한 빌더만 채워 부른다."""
    ctx = JobContext(
        storage=storage,
        worker_id=worker_id,
        build_models=build_models,
        build_embedder=build_embedder,
        build_text_embedder=build_text_embedder,
        build_lens_client=build_lens_client,
        build_summary_client=build_summary_client,
        build_live_models=build_live_models,
        build_live_source=build_live_source,
        llm_server=llm_server or no_llm_server,
        search_embedding=search_embedding or (None, None),
        default_speaker_prefix=default_speaker_prefix,
        lens_llm_model=lens_llm_model,
        summary_llm_model=summary_llm_model,
        meeting_timezone=meeting_timezone,
        live_max_minutes=live_max_minutes,
        shutdown_event=shutdown_event,
        register_abort=register_abort,
    )
    return run_job(conn, job, ctx)


def run_once(
    conn,
    worker_id: str,
    storage: Storage,
    *,
    build_models=None,
    build_embedder=None,
    build_text_embedder=None,
    build_lens_client=None,
    build_summary_client=None,
    search_embedding=None,
    default_speaker_prefix="Speaker",
    lens_llm_model=None,
    summary_llm_model=None,
    meeting_timezone="Asia/Seoul",
    llm_server=None,
    shutdown_event=None,
) -> str | None:
    """claim → 처리. 큐가 비어 있으면 None."""
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
        build_summary_client=build_summary_client,
        search_embedding=search_embedding,
        default_speaker_prefix=default_speaker_prefix,
        lens_llm_model=lens_llm_model,
        summary_llm_model=summary_llm_model,
        meeting_timezone=meeting_timezone,
        llm_server=llm_server,
        shutdown_event=shutdown_event,
    )


def context_from_settings(
    job: dict,
    storage: Storage,
    settings,
    *,
    build_models_fn,
    build_embedder_fn,
    build_text_embedder_fn,
    build_lens_client_fn=None,
    build_summary_client_fn=None,
    llm_server_fn=None,
    build_live_models_fn=None,
    build_live_source_fn=None,
    shutdown_event: threading.Event | None = None,
    register_abort=None,
) -> JobContext:
    """settings + (payload, settings)를 받는 빌더들 → 인자 없는 빌더로 감싼 JobContext.

    빌더를 여기서 부르지 않고 lambda로 미루는 게 요점이다 — handler가 자기에게 필요한
    것 하나만 실제로 호출한다.
    """
    payload = job["payload"]
    return JobContext(
        storage=storage,
        worker_id=settings.worker_id,
        build_models=lambda: build_models_fn(payload, settings),
        build_embedder=lambda: build_embedder_fn(payload, settings),
        build_text_embedder=lambda: build_text_embedder_fn(settings),
        build_lens_client=(
            (lambda: build_lens_client_fn(settings)) if build_lens_client_fn else None
        ),
        build_summary_client=(
            (lambda: build_summary_client_fn(settings)) if build_summary_client_fn else None
        ),
        build_live_models=(
            (lambda: build_live_models_fn(payload, settings)) if build_live_models_fn else None
        ),
        build_live_source=build_live_source_fn,
        llm_server=llm_server_fn or no_llm_server,
        search_embedding=(settings.search_embedding_model, settings.search_embedding_dim),
        default_speaker_prefix=settings.default_speaker_prefix,
        lens_llm_model=settings.lens_llm_model,
        summary_llm_model=settings.summary_llm_model,
        meeting_timezone=settings.meeting_timezone,
        live_max_minutes=settings.live_max_minutes,
        shutdown_event=shutdown_event,
        register_abort=register_abort,
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
    build_summary_client_fn=None,
    llm_server_fn=None,
    shutdown_event=None,
    build_live_models_fn=None,
    build_live_source_fn=None,
) -> str:
    """claim된 job 1건: heartbeat 진입 → 지연 빌더를 묶은 JobContext로 실행."""
    ctx = context_from_settings(
        job,
        storage,
        settings,
        build_models_fn=build_models_fn,
        build_embedder_fn=build_embedder_fn,
        build_text_embedder_fn=build_text_embedder_fn,
        build_lens_client_fn=build_lens_client_fn,
        build_summary_client_fn=build_summary_client_fn,
        llm_server_fn=llm_server_fn,
        build_live_models_fn=build_live_models_fn,
        build_live_source_fn=build_live_source_fn,
        shutdown_event=shutdown_event,
        # heartbeat가 소유권 상실(운영자 취소/reaper)을 감지하면 LLM 서버를 내린다
        register_abort=getattr(heartbeat_cm, "set_on_lost", None),
    )
    with heartbeat_cm:
        return run_job(conn, job, ctx)
