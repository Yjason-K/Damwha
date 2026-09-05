from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # model_cache_dir가 pydantic 보호 네임스페이스(model_)와 겹쳐 경고가 나므로 끈다.
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", protected_namespaces=())

    database_url: str
    storage_root: str = "../storage"
    worker_id: str = "worker-1"
    hf_token: str | None = None
    poll_interval_seconds: float = 2.0
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
    lens_llm_server_bin: str = "mlx_lm.server"
    # 첫 실행은 HF 다운로드를 포함한다 — 27B는 수십 GB라 넉넉히 잡는다.
    lens_llm_server_start_timeout_seconds: float = 600.0
    lens_llm_server_stop_timeout_seconds: float = 20.0

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
