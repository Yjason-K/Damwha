"""쿼리 임베딩 전용 로컬 서비스. API가 localhost로만 호출. ML은 src/ 밖 유지.

진입: `python -m damwha_worker.embed_service [--run-id=<uuid>]` (스펙 §6.2) 또는 `damwha-embed`
콘솔 스크립트(`deploy/README.md`의 `uv tool install` 경로). `--run-id`는 앱이 `ps`로 읽는 소유
표식일 뿐 여기서는 읽지 않는다 — uvicorn도 `sys.argv`를 보지 않는다.

**import만으로는 설정을 읽지도 모델을 받지도 않는다.** 설정과 임베더는 `_service()`가 처음
불릴 때 만든다. 빌드의 진입점 확인과 테스트가 이 모듈을 import하는데, 모듈 수준에서 만들면
그 자리에서 `DATABASE_URL`을 요구하고 bge-m3(2.2 GB)를 받는다.
"""

import json
import logging
import threading

from fastapi import FastAPI
from pydantic import BaseModel

from . import console
from .config import load_settings
from .runtime_report import runtime_facts

log = logging.getLogger("damwha_worker")

app = FastAPI()
_lock = threading.Lock()
_loaded = None  # (settings, embedder) — _service()가 채운다


def _service():
    """설정과 임베더를 처음 부를 때 한 번만 만든다. `(settings, embedder)`를 돌려준다."""
    global _loaded
    if _loaded is None:
        with _lock:  # 엔드포인트는 스레드풀에서 돈다 — 모델을 두 번 올리지 않는다
            if _loaded is None:
                from .models.registry import build_text_embedder

                settings = load_settings()
                _loaded = (settings, build_text_embedder(settings))
    return _loaded


class EmbedRequest(BaseModel):
    texts: list[str]


class EmbedResponse(BaseModel):
    model: str
    dimension: int
    vectors: list[list[float]]


@app.get("/health")
def health():
    # 지연 초기화를 부르지 않는다 — 모델이 아직 안 올라왔어도 프로세스가 살아 있음을 답한다.
    return {"status": "ok"}


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest):
    settings, embedder = _service()
    vectors = embedder.embed_texts(req.texts)
    return EmbedResponse(
        model=settings.search_embedding_model,
        dimension=settings.search_embedding_dim,
        vectors=vectors,
    )


def main() -> None:  # pragma: no cover — `damwha-embed` 콘솔 스크립트 / `-m` 진입
    import uvicorn

    # 순서가 계약이다 (스펙 §9 P4-C12): 로깅 → 런타임 보고 → 지연 초기화 → uvicorn.
    # 로깅을 먼저 잡지 않으면 보고가 embed.log에 남지 않는다.
    console.install_logging(level=logging.INFO)
    log.info("runtime %s", json.dumps(runtime_facts()))
    # Task 9: HF 다운로드 진행 훅을 여기서 설치한다 — 모델을 올리기 **전에** (스펙 §6.9).
    # 기동 시점에 모델을 올린다 — 첫 /embed 요청이 적재 시간(~31초)을 떠안지 않게.
    settings, _ = _service()
    uvicorn.run(app, host=settings.embed_service_host, port=settings.embed_service_port)


if __name__ == "__main__":  # pragma: no cover
    main()
