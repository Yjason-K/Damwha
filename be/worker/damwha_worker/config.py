from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # model_cache_dir가 pydantic 보호 네임스페이스(model_)와 겹쳐 경고가 나므로 끈다.
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", protected_namespaces=())

    database_url: str
    storage_root: str = "../storage"
    worker_id: str = "worker-1"
    hf_token: str | None = None
    whisper_backend: str = "mlx"
    device: str = "mps"
    poll_interval_seconds: float = 2.0
    heartbeat_interval_seconds: float = 30.0
    stt_chunk_minutes: float = 25.0
    model_cache_dir: str | None = None
    search_embedding_model: str = "BAAI/bge-m3"
    search_embedding_dim: int = 1024
    embed_service_host: str = "127.0.0.1"
    embed_service_port: int = 8100


def load_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
