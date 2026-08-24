"""실 bge-m3 TextEmbedder. models extra에서만 import (테스트는 FakeTextEmbedder 사용)."""


class BgeM3TextEmbedder:
    def __init__(self, model_name: str = "BAAI/bge-m3") -> None:
        from sentence_transformers import SentenceTransformer

        # 텍스트 임베더는 MPS를 쓰지 않는다 — 파이프라인 GPU 모델과의 메모리 경쟁
        # 회피(ECAPA가 CPU로 강제되는 것과 동일 근거). 색인은 백그라운드 job이라
        # CPU 지연이 무해하다.
        self._model = SentenceTransformer(model_name, device="cpu")

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        vecs = self._model.encode(
            texts, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False
        )
        return [v.tolist() for v in vecs]
