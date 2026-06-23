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


# Permanent codes
CORRUPT_AUDIO = "corrupt_audio"
UNSUPPORTED_FORMAT = "unsupported_format"
PROBE_FAILED = "probe_failed"
UNSUPPORTED_PAYLOAD_VERSION = "unsupported_payload_version"
# Transient codes
MODEL_LOAD_FAILED = "model_load_failed"
OOM = "oom"
IO_ERROR = "io_error"
DB_ERROR = "db_error"


def classify(exc: Exception) -> WorkerError:
    if isinstance(exc, WorkerError):
        return exc
    if isinstance(exc, UnsupportedPayloadVersion):
        return WorkerError(UNSUPPORTED_PAYLOAD_VERSION, str(exc), ErrorKind.PERMANENT)
    if isinstance(exc, MemoryError):
        return WorkerError(OOM, "out of memory", ErrorKind.TRANSIENT)
    log.warning("uncategorized exception treated as TRANSIENT: %r", exc)
    return WorkerError("uncategorized", str(exc), ErrorKind.TRANSIENT)
