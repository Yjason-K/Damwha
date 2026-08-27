"""쿼리 임베딩 전용 로컬 서비스. API가 localhost로만 호출. ML은 src/ 밖 유지."""

from fastapi import FastAPI
from pydantic import BaseModel

from .config import load_settings
from .models.registry import build_text_embedder

app = FastAPI()
_settings = load_settings()
_embedder = build_text_embedder(_settings)


class EmbedRequest(BaseModel):
    texts: list[str]


class EmbedResponse(BaseModel):
    model: str
    dimension: int
    vectors: list[list[float]]


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest):
    vectors = _embedder.embed_texts(req.texts)
    return EmbedResponse(
        model=_settings.search_embedding_model,
        dimension=_settings.search_embedding_dim,
        vectors=vectors,
    )


def main() -> None:  # pragma: no cover — `damwha-embed` 콘솔 스크립트
    import uvicorn

    uvicorn.run(app, host=_settings.embed_service_host, port=_settings.embed_service_port)
