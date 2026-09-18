from dataclasses import dataclass
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# ── HF 요청의 유한 상한 (스펙 §6.6-b) ─────────────────────────────────
# 2026-09-18 실측이 반증한 전제: 패킷이 버려지는 네트워크에서 `snapshot_download` 계열이 캐시가
# 차 있어도 **무한 대기**한다 — hub의 공유 httpx 클라이언트가 `timeout=None`이고(`utils/_http.py`)
# `repo_info`에는 `etag_timeout` 같은 방어가 없다. 그래서 상한을 워커가 직접 정한다.
#
# **여기가 단일 진실 원천이다.** 앱(`desktop/`)은 이 값을 env로 주지 않는다 — 그러면 웹 흐름
# (`pnpm worker`)과 앱이 서로 다른 상한으로 돌고, 어느 쪽이 참인지 코드로 알 수 없게 된다.
# `models/downloads.py::apply_hf_limits`가 이 값을 hub·xet의 env 이름으로 옮긴다.
#
# 값의 근거:
# - etag 15초: 라이브러리 기본값 10과 **달라야** hub가 호출자의 `etag_timeout`을 이 값으로 덮는다
#   (`file_download.py:959-961`). 먹통 네트워크에서 파일당 이 시간을 내므로 짧을수록 좋지만,
#   느린 회선의 HEAD 왕복에는 10초가 빠듯하다.
# - download 30초: 스트리밍 중 **바이트 사이** 간격의 상한이다(전체 다운로드 시간이 아니다).
#   hub는 여기서 1초 뒤 한 번만 재개하므로 최악이 30+1+30≈61초 — 아래 무진행 90초 안에 들어와
#   HTTP 경로는 감시가 발화하기 전에 스스로 끝난다.
# - request/connect 30·10초: `repo_info`처럼 per-call 방어가 없는 호출의 유일한 상한.
#   `snapshot_download`는 `httpx.TimeoutException`을 잡아 **캐시로 폴백**하므로
#   (`_snapshot_download.py:249`) 이 상한이 먹통 네트워크의 무한 대기를 캐시 적재로 바꾼다.
# - xet 30·10·60초: hf_xet는 자기 기본값(read 300초·connect 60초·retry 360초)을 로그로 찍지만
#   2026-09-18 실측에서 끊긴 전송이 600초를 예외 없이 멈춰 있었다 — 그 값들을 지키지 않는다.
#   그래서 이 셋은 **개선일 뿐 보증이 아니고**, 보증은 무진행 감시가 한다.
# - 무진행 90초: 감독자(Task 10)의 무진행 판정 120초보다 **짧다**. 워커가 언제나 자기 다운로드를
#   먼저 끝내므로 둘이 같은 다운로드를 두 번 죽이지 않는다 (30초 여유).
HF_ETAG_TIMEOUT_SECONDS = 15
HF_DOWNLOAD_TIMEOUT_SECONDS = 30
HF_REQUEST_TIMEOUT_SECONDS = 30
HF_CONNECT_TIMEOUT_SECONDS = 10
HF_RETRY_MAX_DURATION_SECONDS = 60
HF_STALL_SECONDS = 90.0


@dataclass(frozen=True)
class HfLimits:
    etag_timeout: int
    download_timeout: int
    request_timeout: int
    connect_timeout: int
    retry_max_duration: int
    stall_seconds: float


class Settings(BaseSettings):
    # model_cache_dir가 pydantic 보호 네임스페이스(model_)와 겹쳐 경고가 나므로 끈다.
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", protected_namespaces=())

    database_url: str
    storage_root: str = "../storage"
    worker_id: str = "worker-1"
    hf_token: str | None = None
    poll_interval_seconds: float = 2.0
    # 라이브 배너의 "신호 끊김" 임계값(fe/src/features/meeting/ui/live-banner.tsx의
    # STALE_MS)이 이 값의 3배로 잡혀 있다. 주기를 늘리면 그 상수도 같이 본다 —
    # 임계값이 주기에 가까워지면 건강한 녹음에서도 배너가 빨갛게 번쩍인다.
    heartbeat_interval_seconds: float = 30.0
    reaper_stale_minutes: float = 30.0
    reaper_interval_seconds: float = 300.0
    stt_chunk_minutes: float = 25.0
    # 라이브 세션 상한. 넘으면 stop이 온 것과 똑같이 finalize한다 (설계 §4).
    live_max_minutes: float = 240.0
    model_cache_dir: str | None = None
    search_embedding_model: str = "BAAI/bge-m3"
    search_embedding_dim: int = 1024
    embed_service_host: str = "127.0.0.1"
    embed_service_port: int = 8100
    default_speaker_prefix: str = "Speaker"
    # 렌즈 프롬프트의 "Meeting date"를 렌더하는 존. recorded_at은 timestamptz라
    # 존을 고정하지 않으면 오전 이른 회의가 UTC로 전날이 되어 due_at이 하루씩 밀린다.
    meeting_timezone: str = "Asia/Seoul"
    # 필수 — 기본값을 두지 않는다. 기본값이 있으면 "주소를 안 넣었다"와 "그 주소에
    # 서버가 없다"가 구별되지 않고, lens_llm_managed 경로는 이 URL의 host:port에
    # 서버를 bind하므로 포트가 명시돼 있어야 한다. 설정 누락은 기동 시점에
    # ValidationError로 드러나는 편이 낫다.
    lens_llm_base_url: str
    lens_llm_model: str = "mlx-community/Qwen3.5-4B-8bit"
    summary_llm_model: str = "mlx-community/Qwen3.5-4B-8bit"
    lens_llm_api_key: str | None = None
    lens_llm_timeout_seconds: float = 300.0
    # 응답이 잘리면 JSON 파싱이 깨져 PERMANENT 실패가 되므로 상한은 넉넉하게 잡는다
    # (mlx_lm.server 기본값 512는 회의 하나 분량의 요약도 못 담는다). 상한은 예약이
    # 아니라 한도라, 크게 잡아도 모델이 stop에서 멈추면 그만큼만 생성한다.
    lens_llm_max_tokens: int = 8192
    # LLM 서버를 워커가 소유한다 — 렌즈/요약 자식이 job 직전에 띄우고 끝나면 내린다.
    # 큐가 비어 있는 동안 모델이 메모리를 쥐고 있지 않게 하는 것이 목적이다. 이미 떠
    # 있는 서버(수동 기동·SMOKE)를 발견하면 그건 남의 것이라 재사용만 하고 죽이지 않는다.
    lens_llm_managed: bool = True
    # 빈 값(기본) = 이 워커와 같은 인터프리터로 `-m damwha_worker.llm_entry`를 띄운다 — 부모의
    # `--run-id`가 argv에 남아 앱이 소유를 증명할 수 있다 (스펙 §6.2). 값을 채우면 그 실행 파일을
    # 그대로 실행하는 탈출구다(수동 운용·다른 백엔드). 그렇게 띄운 서버에는 소유 표식이 없다.
    lens_llm_server_bin: str = ""
    # 첫 실행은 HF 다운로드를 포함한다 — 27B는 수십 GB라 넉넉히 잡는다.
    lens_llm_server_start_timeout_seconds: float = 600.0
    lens_llm_server_stop_timeout_seconds: float = 20.0
    # 단일 진실 원천은 env(FFMPEG_BIN/FFPROBE_BIN) — pipeline/ffmpeg.py가 호출 시점에
    # 직접 읽는다. 여기 두 필드는 문서화·.env 운용 경로용 사본이다.
    ffmpeg_bin: str = "ffmpeg"
    ffprobe_bin: str = "ffprobe"
    # HF 상한 (스펙 §6.6-b). 근거는 이 파일 머리의 상수 주석에 있다.
    hf_etag_timeout_seconds: int = HF_ETAG_TIMEOUT_SECONDS
    hf_download_timeout_seconds: int = HF_DOWNLOAD_TIMEOUT_SECONDS
    hf_request_timeout_seconds: int = HF_REQUEST_TIMEOUT_SECONDS
    hf_connect_timeout_seconds: int = HF_CONNECT_TIMEOUT_SECONDS
    hf_retry_max_duration_seconds: int = HF_RETRY_MAX_DURATION_SECONDS
    hf_stall_seconds: float = HF_STALL_SECONDS

    @field_validator("default_speaker_prefix")
    @classmethod
    def _non_empty_prefix(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("default_speaker_prefix must not be empty")
        return v

    @field_validator("meeting_timezone")
    @classmethod
    def _known_timezone(cls, v: str) -> str:
        # 기동 시점에 막는다. 폴백은 두지 않는다 — 잘못된 존으로 조용히 UTC를 쓰면
        # 하루 어긋난 due_at이 저장되고, 그건 기동 실패보다 훨씬 늦게 발견된다.
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"unknown IANA timezone {v!r}") from exc
        return v


def load_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


_DEFAULT_HF_LIMITS = HfLimits(
    etag_timeout=HF_ETAG_TIMEOUT_SECONDS,
    download_timeout=HF_DOWNLOAD_TIMEOUT_SECONDS,
    request_timeout=HF_REQUEST_TIMEOUT_SECONDS,
    connect_timeout=HF_CONNECT_TIMEOUT_SECONDS,
    retry_max_duration=HF_RETRY_MAX_DURATION_SECONDS,
    stall_seconds=HF_STALL_SECONDS,
)


def hf_limits() -> HfLimits:
    """HF 상한. `Settings`를 못 만드는 프로세스에서도 같은 값이 선다.

    `llm_entry`는 `--once` 자식에게서 env를 물려받을 뿐이라 `DATABASE_URL`·`LENS_LLM_BASE_URL`이
    없을 수 있는데(`_worker_id`가 같은 이유로 같은 폴백을 쓴다), 상한이 없는 프로세스를 만들 바에는
    기본값으로 내려간다 — 어떤 값도 무한대가 아니어야 한다는 것이 이 절의 요구다.
    """
    try:
        s = load_settings()
    except Exception:  # noqa: BLE001 — 설정 실패가 상한을 없애지 않는다
        return _DEFAULT_HF_LIMITS
    return HfLimits(
        etag_timeout=s.hf_etag_timeout_seconds,
        download_timeout=s.hf_download_timeout_seconds,
        request_timeout=s.hf_request_timeout_seconds,
        connect_timeout=s.hf_connect_timeout_seconds,
        retry_max_duration=s.hf_retry_max_duration_seconds,
        stall_seconds=s.hf_stall_seconds,
    )
