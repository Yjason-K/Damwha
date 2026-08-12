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
    model_cache_dir: str | None = None
    search_embedding_model: str = "BAAI/bge-m3"
    search_embedding_dim: int = 1024
    embed_service_host: str = "127.0.0.1"
    embed_service_port: int = 8100
    default_speaker_prefix: str = "Speaker"
    lens_llm_base_url: str = "http://127.0.0.1:11434/v1"
    lens_llm_model: str = "qwen3.5:4b-mlx"
    summary_llm_model: str = "qwen3.5:4b-mlx"
    lens_llm_api_key: str | None = None
    lens_llm_timeout_seconds: float = 300.0
    # 응답이 잘리면 JSON 파싱이 깨져 PERMANENT 실패가 되므로 상한은 넉넉하게 잡는다
    # (mlx_lm.server 기본값 512는 회의 하나 분량의 요약도 못 담는다). 상한은 예약이
    # 아니라 한도라, 크게 잡아도 모델이 stop에서 멈추면 그만큼만 생성한다.
    lens_llm_max_tokens: int = 8192

    @field_validator("default_speaker_prefix")
    @classmethod
    def _non_empty_prefix(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("default_speaker_prefix must not be empty")
        return v


def load_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
