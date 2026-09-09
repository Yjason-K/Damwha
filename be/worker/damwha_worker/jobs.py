"""job type 하나당 실행·실패·shutdown 정책을 한 자리에 묶는다.

예전에는 `handle_job` 한 함수에 if 체인이 두 개 있었다 — 위쪽은 실행, 아래쪽은 실패
처리. type을 하나 더하면 50줄 떨어진 두 곳을 같이 고쳐야 했고, "live_session은 왜
재시도가 없나" 같은 질문에 답하려면 190줄을 통째로 읽어야 했다. 지금은 type 하나가
`JobHandler` 하나고, run/on_failure/on_shutdown 세 메서드가 그 type의 계약 전부다.

여섯 handler를 굳이 한 파일에 두는 이유는, 이 파일을 읽는 목적이 대개 *정책 비교*이기
때문이다 — 어떤 type이 재시도를 하고 어떤 type이 회의까지 닫는지는 나란히 놓고 볼 때만
보인다. 실제 파이프라인 로직은 여기 없다; `pipeline/`에 있고 handler는 얇은 어댑터다.
"""

import logging
import threading
from collections.abc import Callable
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass

from . import db
from .errors import AUDIO_DEVICE_FAILED, ErrorKind, WorkerError
from .pipeline.enroll_speaker import run_enroll_speaker
from .pipeline.extract_lenses import run_extract_lenses
from .pipeline.index_meeting import run_index_meeting
from .pipeline.live_session import run_live_session
from .pipeline.process_meeting import run_process_meeting
from .pipeline.summarize_meeting import run_summarize_meeting
from .storage import Storage

log = logging.getLogger("damwha_worker")

#: 미리보기를 반납하며 job에 남기는 사유. 회의에는 아무것도 쓰지 않는다 (설계 §4.2).
WORKER_SHUTDOWN = "worker_shutdown"


def no_llm_server(_model):
    """LLM 서버를 워커가 관리하지 않을 때의 기본값 — 아무것도 띄우지 않는다."""
    return nullcontext()


# --------------------------------------------------------------------------- #
# 주입물
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class JobContext:
    """job 1건을 처리하는 데 필요한 주입물 전부.

    모델과 LLM 클라이언트는 값이 아니라 *빌더*로 받는다. 실제 빌드는 handler가 하므로
    claim한 job이 실제로 쓰는 것 하나만 만들어진다 — index_meeting job이 torch를
    import하며 수십 초를 쓰지 않는 이유다. 테스트는 필요한 빌더만 채우고 나머지는
    None으로 둔다.
    """

    storage: Storage
    worker_id: str

    build_models: Callable[[], object] | None = None
    build_embedder: Callable[[], object] | None = None
    build_text_embedder: Callable[[], object] | None = None
    build_lens_client: Callable[[], object] | None = None
    build_summary_client: Callable[[], object] | None = None
    build_live_models: Callable[[], object] | None = None
    #: (payload, storage, state_box) → 라이브 오디오 소스
    build_live_source: Callable[..., object] | None = None
    #: 모델 이름을 받아 LLM 서버를 띄우는 컨텍스트 매니저
    llm_server: Callable[[str], object] = no_llm_server

    search_embedding: tuple = (None, None)
    default_speaker_prefix: str = "Speaker"
    lens_llm_model: str | None = None
    summary_llm_model: str | None = None
    meeting_timezone: str = "Asia/Seoul"
    live_max_minutes: float = 240.0

    shutdown_event: threading.Event | None = None
    #: heartbeat가 소유권 상실(운영자 취소/reaper)을 감지했을 때 부를 훅을 걸고 떼는 자리
    register_abort: Callable | None = None


# --------------------------------------------------------------------------- #
# 소유권 상실 훅
# --------------------------------------------------------------------------- #


@contextmanager
def abort_hook(register_abort, on_lost):
    """heartbeat가 소유권 상실(운영자 취소/reaper)을 감지했을 때 부를 훅을 본문 동안 건다.

    본문이 끝나면 훅을 해제해 정상 완료 직후 beat 경합을 막는다. on_lost가 None이면
    걸 게 없다.
    """
    if register_abort is None or on_lost is None:
        yield
        return
    register_abort(on_lost)
    try:
        yield
    finally:
        register_abort(None)


def llm_abort_hook(register_abort, proc):
    """워커가 직접 띄운 LLM 서버(proc)가 있을 때만 — 소유권을 잃으면 proc에 SIGTERM.

    진행 중 HTTP 요청이 즉시 실패해 파이프라인이 에러 경로로 빠지고, managed_llm_server의
    finally가 wait/kill 에스컬레이션을 마무리한다. 외부 서버 재사용(proc None)이면 죽일 게
    없으니 걸지 않는다.
    """
    return abort_hook(register_abort, proc.terminate if proc is not None else None)


def shutdown_abort_hook(register_abort, shutdown_event):
    """process_meeting — 소유권을 잃으면 shutdown_event를 set해 다음 stage 경계
    (enter_stage) 또는 STT clip(SttProgressReporter)에서 멈춘다. 결과는 어차피 소유권
    가드에 막혀 버려지니, 취소된 회의에 GPU 시간을 더 쓰지 않는 것이 목적이다."""
    return abort_hook(register_abort, shutdown_event.set if shutdown_event is not None else None)


# --------------------------------------------------------------------------- #
# handler 계약
# --------------------------------------------------------------------------- #


class JobHandler:
    """job type 하나의 계약. 서브클래스는 run()과, 기본과 다른 정책만 덮어쓴다."""

    #: job.type 컬럼 값
    type: str = ""

    def run(self, conn, job: dict, payload, ctx: JobContext) -> str:
        """job을 실제로 처리하고 outcome 문자열을 돌려준다."""
        raise NotImplementedError

    def on_failure(self, conn, job: dict, ctx: JobContext, error: dict, *, retry: bool) -> str:
        """기본: 재시도 여지가 있으면 반납, 없으면 job만 failed로 닫는다.

        `retry`는 dispatch가 계산한다 — TRANSIENT이면서 attempts가 max에 못 미칠 때만 참.
        """
        if retry:
            return "requeued" if db.requeue(conn, job["id"], ctx.worker_id) else "lost"
        return "failed" if db.fail_job(conn, job["id"], ctx.worker_id, error) else "lost"

    def on_shutdown(self, conn, job: dict, ctx: JobContext) -> str:
        """기본: 반납해 다음 기동이나 다른 워커가 처음부터 이어받게 한다."""
        log.info("job %s type=%s → shutdown requeue", job["id"], job["type"])
        ok = db.requeue_for_shutdown(conn, job["id"], ctx.worker_id)
        return "requeued_shutdown" if ok else "lost"


def _requeue_or(conn, job, ctx, *, retry: bool, close) -> str:
    """`retry`면 반납하고, 아니면 `close`가 정한 방식으로 닫는다."""
    if retry:
        return "requeued" if db.requeue(conn, job["id"], ctx.worker_id) else "lost"
    return close()


# --------------------------------------------------------------------------- #
# handler 구현
# --------------------------------------------------------------------------- #


class ProcessMeetingHandler(JobHandler):
    """녹음 파일 한 건의 전체 처리. 실패하면 회의도 failed로 닫는다."""

    type = "process_meeting"

    def run(self, conn, job, payload, ctx):
        sm, sd = ctx.search_embedding or (None, None)
        with shutdown_abort_hook(ctx.register_abort, ctx.shutdown_event):
            models = ctx.build_models()
            return run_process_meeting(
                conn,
                job,
                payload,
                models,
                ctx.storage,
                worker_id=ctx.worker_id,
                search_embedding_model=sm,
                search_embedding_dim=sd,
                default_speaker_prefix=ctx.default_speaker_prefix,
                lens_llm_model=ctx.lens_llm_model,
                summary_llm_model=ctx.summary_llm_model,
                shutdown_event=ctx.shutdown_event,
            )

    def on_failure(self, conn, job, ctx, error, *, retry):
        def close():
            ok = db.fail_process_meeting(conn, job["id"], ctx.worker_id, job["meeting_id"], error)
            return "failed" if ok else "lost"

        return _requeue_or(conn, job, ctx, retry=retry, close=close)


class EnrollSpeakerHandler(JobHandler):
    """화자 등록 샘플 한 건. 실패하면 그 화자를 failed로 표시한다."""

    type = "enroll_speaker"

    def run(self, conn, job, payload, ctx):
        return run_enroll_speaker(
            conn,
            job,
            payload,
            ctx.build_embedder(),
            ctx.storage,
            worker_id=ctx.worker_id,
            shutdown_event=ctx.shutdown_event,
        )

    def on_failure(self, conn, job, ctx, error, *, retry):
        def close():
            speaker_id = (job["payload"] or {}).get("speaker_id")
            ok = db.fail_enroll(conn, job["id"], ctx.worker_id, speaker_id, error)
            return "failed" if ok else "lost"

        return _requeue_or(conn, job, ctx, retry=retry, close=close)


class IndexMeetingHandler(JobHandler):
    """검색 색인. 실패해도 job만 닫는다 — 회의는 done을 유지한다(기본 정책 그대로)."""

    type = "index_meeting"

    def run(self, conn, job, payload, ctx):
        return run_index_meeting(
            conn,
            job,
            payload,
            ctx.build_text_embedder(),
            worker_id=ctx.worker_id,
            shutdown_event=ctx.shutdown_event,
        )


class ExtractLensesHandler(JobHandler):
    """렌즈 추출. 실패는 job이 아니라 extraction_run에 기록된다."""

    type = "extract_lenses"

    def run(self, conn, job, payload, ctx):
        with ctx.llm_server(payload.model) as proc, llm_abort_hook(ctx.register_abort, proc):
            client = ctx.build_lens_client()
            return run_extract_lenses(
                conn,
                job,
                payload,
                client,
                worker_id=ctx.worker_id,
                shutdown_event=ctx.shutdown_event,
                meeting_timezone=ctx.meeting_timezone,
            )

    def on_failure(self, conn, job, ctx, error, *, retry):
        def close():
            payload = job["payload"] or {}
            return db.fail_lens_extraction(
                conn,
                job["id"],
                ctx.worker_id,
                payload.get("extraction_run_id"),
                payload.get("processing_version"),
                error,
            )

        return _requeue_or(conn, job, ctx, retry=retry, close=close)


class SummarizeMeetingHandler(JobHandler):
    """회의 요약. 실패는 summary 행에 기록된다."""

    type = "summarize_meeting"

    def run(self, conn, job, payload, ctx):
        with ctx.llm_server(payload.model) as proc, llm_abort_hook(ctx.register_abort, proc):
            summary_client = ctx.build_summary_client()
            return run_summarize_meeting(
                conn,
                job,
                payload,
                summary_client,
                worker_id=ctx.worker_id,
                shutdown_event=ctx.shutdown_event,
            )

    def on_failure(self, conn, job, ctx, error, *, retry):
        return _requeue_or(
            conn,
            job,
            ctx,
            retry=retry,
            close=lambda: db.fail_summary(conn, job["id"], ctx.worker_id, error),
        )


class LiveSessionHandler(JobHandler):
    """진행 중 회의의 실시간 미리보기. 유일하게 재시도가 없는 type이다."""

    type = "live_session"

    def run(self, conn, job, payload, ctx):
        # 소유권 상실은 루프가 1초마다 직접 읽는다(get_live_input_state → 'lost') —
        # process_meeting의 shutdown 훅은 걸지 않는다. shutdown_event는 루프가 stop으로 다룬다.
        live_models = ctx.build_live_models()
        # source(TailSource)와 run_live_session이 같은 dict를 봐야 한다 — 소스는
        # 생성 시점에 클로저로 쥐고, 루프는 매 폴링마다 이 자리에 최신 스냅샷을 놓는다.
        # 첫 스냅샷은 run_live_session이 스스로 채운다.
        state_box = {"state": db.LiveInputState(None, 0, None)}
        source = ctx.build_live_source(payload, ctx.storage, state_box)
        return run_live_session(
            conn,
            job,
            payload,
            live_models,
            ctx.storage,
            source,
            worker_id=ctx.worker_id,
            shutdown_event=ctx.shutdown_event,
            max_minutes=ctx.live_max_minutes,
            state_box=state_box,
        )

    def on_failure(self, conn, job, ctx, error, *, retry):
        # `retry`를 통째로 무시하는 유일한 handler다 (설계 §2.6) — 끊긴 녹음은 이어 붙일 수
        # 없고, 재claim한 워커는 이미 지나간 오디오를 앞에서부터 다시 전사하게 된다.
        # 그동안 회의는 계속 자란다. max_attempts=1과 같은 이유다.
        return self._close(conn, job, ctx, error)

    def on_shutdown(self, conn, job, ctx):
        # live job은 어떤 경우에도 requeue_for_shutdown에 들어가지 않는다 (설계 §4.2).
        log.info("job %s → live session returned on shutdown", job["id"])
        return self._close(
            conn,
            job,
            ctx,
            {
                "code": WORKER_SHUTDOWN,
                "message": "the preview worker shut down; the recording is unaffected",
                "kind": ErrorKind.PERMANENT.value,
                "stage": job.get("stage"),
            },
        )

    @staticmethod
    def _close(conn, job, ctx, error) -> str:
        """browser 세션은 미리보기만 반납한다 — 마무리는 봉인 뒤 API가 이어받는다 (설계
        §4.1 3행). 회의는 recording에 남아 append를 계속 받는다. mic 세션은 워커가
        캡처자라 반납할 미리보기가 아니라 잃은 녹음이므로 회의까지 닫는다."""
        ok = (
            db.fail_live_preview(conn, job["id"], ctx.worker_id, error)
            if is_browser_live(job)
            else db.fail_process_meeting(conn, job["id"], ctx.worker_id, job["meeting_id"], error)
        )
        return "failed" if ok else "lost"


def is_browser_live(job: dict) -> bool:
    """이 job이 브라우저가 캡처하는 라이브 세션인가.

    payload의 source로 가르는 이유는 소유권이다. browser 세션의 오디오는 브라우저가 API로
    보내고 API가 파일에 쓰므로, 워커 장애는 미리보기만 끝낼 수 있다 (설계 §4.1). mic 세션은
    반대로 워커가 캡처자라 워커를 잃으면 그 녹음도 없다 — 기존 거절 정책대로 회의까지 닫는다.
    """
    return job["type"] == "live_session" and (job["payload"] or {}).get("source") == "browser"


def default_live_source(payload, storage, state_box):
    """payload의 source로 구현체를 고른다.

    'browser'가 유일하게 동작하는 경로다 — API가 쓰는 파일을 따라 읽는다.

    'mic'은 계약에 자리만 남아 있고 **여기서 즉시 거절한다.** 캡처를 브라우저로 옮긴 뒤로
    mic 세션은 조용히 틀린 결과를 만든다: API는 브라우저가 보낸 바이트를 파일에 쓰고 워커는
    이 Mac의 마이크를 전사하므로 정본과 미리보기가 서로 다른 소리가 되고, MicSource는
    봉인 경계를 보지 않으므로 stop 뒤에도 max_minutes(4시간)까지 돈다 — 그동안
    meeting_single_recording_idx가 다음 녹음을 전부 막는다. 시작조차 못 하는 편이
    네 시간 뒤에 알게 되는 것보다 낫다.

    MicSource와 그 테스트는 나중에 시스템 오디오 캡처가 들어올 때의 참조로 남긴다.
    """
    if payload.source == "browser":
        from .audio.tail_source import TailSource

        return TailSource(
            storage.resolve(payload.audio_key),
            # 소스 스레드는 이 자리를 읽기만 한다 — 루프가 1초마다 스냅샷을 통째로
            # 교체하므로 committed와 sealed가 서로 다른 시점의 값으로 섞이지 않는다.
            input_state=lambda: state_box["state"],
        )
    raise WorkerError(
        AUDIO_DEVICE_FAILED,
        f"live source {payload.source!r} is not supported — capture moved to the browser",
        ErrorKind.PERMANENT,
        stage="capture",
    )


# --------------------------------------------------------------------------- #
# 레지스트리
# --------------------------------------------------------------------------- #

HANDLERS: dict[str, JobHandler] = {
    handler.type: handler
    for handler in (
        ProcessMeetingHandler(),
        EnrollSpeakerHandler(),
        IndexMeetingHandler(),
        ExtractLensesHandler(),
        SummarizeMeetingHandler(),
        LiveSessionHandler(),
    )
}

#: 레지스트리에 없는 type의 실패 정책. `parse_payload`가 먼저 ValueError를 던지므로 run은
#: 여기까지 오지 않고 실패 경로만 쓴다 — if 체인 시절 마지막 else가 process_meeting 분기였던
#: 동작을 그대로 유지한다.
UNKNOWN_TYPE_POLICY: JobHandler = HANDLERS["process_meeting"]


def handler_for(job_type: str) -> JobHandler:
    return HANDLERS.get(job_type, UNKNOWN_TYPE_POLICY)
