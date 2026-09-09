"""워커의 모든 SQL. 도메인별 모듈로 나뉘어 있고, 여기서 평평하게 다시 내보낸다.

호출자는 예전처럼 `from . import db` 뒤에 `db.claim(...)`을 쓴다 — 1177줄짜리 한 파일이
도메인별로 갈라졌을 뿐, 이름은 하나도 옮겨가지 않았다.
"""

from .core import WORKER_CAPABILITIES_KEY, connect, upsert_worker_capabilities
from .lenses import fail_lens_extraction, mark_lens_run_running, persist_lens_extraction
from .live import (
    LiveInputState,
    delete_live_utterances,
    fail_live_preview,
    finalize_live_session,
    get_live_input_state,
    insert_live_utterance,
)
from .meetings import fail_process_meeting, persist_process_meeting
from .queue import (
    claim,
    fail_job,
    heartbeat,
    mark_processing,
    peek_queued,
    reap_stale,
    requeue,
    requeue_for_shutdown,
    set_stage,
)
from .search import persist_index_meeting
from .speakers import fail_enroll, persist_enroll
from .summaries import fail_summary, mark_summary_running, persist_summary

__all__ = [
    "WORKER_CAPABILITIES_KEY",
    "connect",
    "upsert_worker_capabilities",
    "claim",
    "fail_job",
    "heartbeat",
    "mark_processing",
    "peek_queued",
    "reap_stale",
    "requeue",
    "requeue_for_shutdown",
    "set_stage",
    "fail_process_meeting",
    "persist_process_meeting",
    "fail_enroll",
    "persist_enroll",
    "fail_summary",
    "mark_summary_running",
    "persist_summary",
    "fail_lens_extraction",
    "mark_lens_run_running",
    "persist_lens_extraction",
    "persist_index_meeting",
    "LiveInputState",
    "delete_live_utterances",
    "fail_live_preview",
    "finalize_live_session",
    "get_live_input_state",
    "insert_live_utterance",
]
