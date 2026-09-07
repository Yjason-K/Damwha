import logging
import traceback as _tb
from enum import Enum

from .contracts import UnsupportedPayloadVersion

log = logging.getLogger("damwha_worker")


class ErrorKind(Enum):
    PERMANENT = "PERMANENT"
    TRANSIENT = "TRANSIENT"


class WorkerError(Exception):
    def __init__(self, code: str, message: str, kind: ErrorKind, stage: str | None = None) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.kind = kind
        self.stage = stage

    def to_json(self, stage: str | None = None) -> dict:
        out = {
            "code": self.code,
            "message": self.message,
            "kind": self.kind.value,
            "stage": stage or self.stage,
        }
        tb = "".join(_tb.format_exception(type(self), self, self.__traceback__)).strip()
        if tb and tb != "None":
            out["traceback"] = tb
        return out


class ShutdownRequested(Exception):
    """Graceful shutdown 제어 흐름 예외 — 실패 분류(classify) 대상이 아니다."""


# Permanent codes
CORRUPT_AUDIO = "corrupt_audio"
UNSUPPORTED_FORMAT = "unsupported_format"
PROBE_FAILED = "probe_failed"
UNSUPPORTED_PAYLOAD_VERSION = "unsupported_payload_version"
SAMPLE_TOO_SHORT = "sample_too_short"
GPU_UNAVAILABLE = "gpu_unavailable"
# 라이브 세션 (설계 §8). 둘 다 PERMANENT — 끊긴 녹음은 이어 붙일 수 없다.
AUDIO_DEVICE_FAILED = "audio_device_failed"  # 마이크를 못 열었다 (권한·장치 없음·미설치)
LIVE_STT_FAILED = "live_stt_failed"  # 클립 연속 실패 상한 초과
# Mostly-transient codes (model_load_failed은 import류일 때 PERMANENT — classify 참조)
MODEL_LOAD_FAILED = "model_load_failed"
OOM = "oom"
IO_ERROR = "io_error"
DB_ERROR = "db_error"
LLM_REQUEST_FAILED = "llm_request_failed"
LLM_INVALID_RESPONSE = "llm_invalid_response"
# 워커가 소유한 LLM 서버를 못 띄웠다. 설정/설치 문제면 PERMANENT, 기동 실패면 TRANSIENT
# (llm_server.py가 직접 kind를 정한다).
LLM_SERVER_START_FAILED = "llm_server_start_failed"


def classify(exc: Exception) -> WorkerError:
    if isinstance(exc, WorkerError):
        return exc
    if isinstance(exc, UnsupportedPayloadVersion):
        return WorkerError(UNSUPPORTED_PAYLOAD_VERSION, str(exc), ErrorKind.PERMANENT)
    if isinstance(exc, (ModuleNotFoundError, ImportError)):
        return WorkerError(MODEL_LOAD_FAILED, str(exc), ErrorKind.PERMANENT)
    if isinstance(exc, MemoryError):
        return WorkerError(OOM, "out of memory", ErrorKind.TRANSIENT)
    if isinstance(exc, RuntimeError) and "out of memory" in str(exc).lower():
        return WorkerError(OOM, str(exc), ErrorKind.TRANSIENT)
    log.warning("uncategorized exception treated as TRANSIENT: %r", exc)
    return WorkerError("uncategorized", str(exc), ErrorKind.TRANSIENT)
