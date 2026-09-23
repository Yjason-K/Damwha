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
# HF 모델 다운로드 (스펙 §6.10 1층·§8). 401과 403은 둘 다 재시도해도 안 되는 PERMANENT지만 안내가
# 다르다 — 401은 토큰 재입력, 403은 그 모델의 사용 조건 수락. 코드가 둘을 가른다.
HF_TOKEN_INVALID = "hf_token_invalid"  # 401: 토큰이 없거나 무효
HF_GATE_NOT_ACCEPTED = "hf_gate_not_accepted"  # 403: 게이트 모델의 조건 미수락
MODEL_DOWNLOAD_FAILED = "model_download_failed"  # 그 밖 — 네트워크·타임아웃·오프라인 캐시 미스·5xx

# 디스크 부족. PERMANENT인 이유: 디스크가 그대로인 채 재시도해 봐야 같은 자리에서 진다.
# Phase 5가 만든 백오프 5회를 여기에 태우지 않는다 (Phase 6a 스펙 §8.1).
DISK_FULL = "DISK_FULL"

_AUTH_STATUSES = (401, 403)
_CHAIN_LIMIT = 8


def _chain(exc: BaseException):
    """예외와 그 원인 사슬. transformers는 hub 오류를 `OSError(...) from e`로 감싸 보낸다."""
    seen = set()
    while exc is not None and id(exc) not in seen and len(seen) < _CHAIN_LIMIT:
        seen.add(id(exc))
        yield exc
        exc = exc.__cause__ or exc.__context__


def _type_names(exc: BaseException) -> set[str]:
    return {cls.__name__ for cls in type(exc).__mro__}


def http_status(exc: BaseException) -> int | None:
    """사슬에서 처음 만나는 HTTP 응답 코드. `GatedRepoError`는 응답이 없어도 403으로 본다.

    huggingface_hub는 models extra에만 있어 여기서 import하지 않는다 — `.response.status_code`와
    클래스 이름으로 판별한다.
    """
    for e in _chain(exc):
        status = getattr(getattr(e, "response", None), "status_code", None)
        if isinstance(status, int):
            return status
        if "GatedRepoError" in _type_names(e):
            return 403
    return None


def is_download_error(exc: BaseException) -> bool:
    """사슬 어딘가에 huggingface_hub가 던진 예외가 있으면 다운로드 실패다."""
    return any(
        any(cls.__module__.startswith("huggingface_hub") for cls in type(e).__mro__)
        for e in _chain(exc)
    )


def classify_download(exc: BaseException) -> ErrorKind:
    """HF 다운로드 실패의 종류. 401·403(`GatedRepoError` 포함)은 PERMANENT, 나머지는 TRANSIENT.

    네트워크 단절·타임아웃·오프라인 캐시 미스(`LocalEntryNotFoundError`)·5xx는 다음 시도에서
    달라질 수 있다 — 1층 재시도(스펙 §6.10)가 job을 `queued`로 돌려 다시 받게 한다. 인증 실패는
    토큰을 바꾸거나 조건을 수락하기 전에는 몇 번을 다시 해도 같다.
    """
    if http_status(exc) in _AUTH_STATUSES:
        return ErrorKind.PERMANENT
    return ErrorKind.TRANSIENT


def download_error(exc: BaseException) -> WorkerError:
    """다운로드 실패를 WorkerError로. `classify`와 `model_readiness` 항목이 같은 판정을 쓴다."""
    status = http_status(exc)
    kind = classify_download(exc)
    if status == 401:
        return WorkerError(
            HF_TOKEN_INVALID,
            "Hugging Face rejected the token (401) — the token is missing or invalid",
            kind,
        )
    if status == 403:
        return WorkerError(
            HF_GATE_NOT_ACCEPTED,
            "Hugging Face refused access (403) — accept the model's user conditions "
            "on its Hugging Face page with the account that owns the token",
            kind,
        )
    detail = str(exc).strip().splitlines()
    message = f"{type(exc).__name__}: {detail[0] if detail else ''}".rstrip(": ")
    return WorkerError(MODEL_DOWNLOAD_FAILED, message, kind)


def classify(exc: Exception) -> WorkerError:
    if isinstance(exc, WorkerError):
        return exc
    if isinstance(exc, UnsupportedPayloadVersion):
        return WorkerError(UNSUPPORTED_PAYLOAD_VERSION, str(exc), ErrorKind.PERMANENT)
    if is_download_error(exc):
        return download_error(exc)
    if isinstance(exc, (ModuleNotFoundError, ImportError)):
        return WorkerError(MODEL_LOAD_FAILED, str(exc), ErrorKind.PERMANENT)
    if isinstance(exc, MemoryError):
        return WorkerError(OOM, "out of memory", ErrorKind.TRANSIENT)
    if isinstance(exc, RuntimeError) and "out of memory" in str(exc).lower():
        return WorkerError(OOM, str(exc), ErrorKind.TRANSIENT)
    log.warning("uncategorized exception treated as TRANSIENT: %r", exc)
    return WorkerError("uncategorized", str(exc), ErrorKind.TRANSIENT)
