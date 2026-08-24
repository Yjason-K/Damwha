from damwha_worker.pipeline.speaker_arbiter import make_embedding_arbiter


class SpanEmbedder:
    """Embedder 프로토콜 구현 — 호출된 스팬을 기록하고 고정 벡터를 돌려준다."""

    def __init__(self, vector: list[float] | None) -> None:
        self._vector = vector
        self.calls: list[tuple[str, int, int]] = []

    def embed(self, wav_path: str, segments) -> list[list[float] | None]:
        self.calls.append((segments[0].diar_label, segments[0].start_ms, segments[0].end_ms))
        return [self._vector]


CENTROIDS = {"A": [1.0, 0.0], "B": [0.0, 1.0]}


def test_neighbor_clearly_closer_returns_true():
    emb = SpanEmbedder([0.9, 0.1])  # A(이웃)에 훨씬 가까움
    arb = make_embedding_arbiter("x.wav", emb, CENTROIDS)
    assert arb(100, 500, "B", "A") is True
    assert emb.calls == [("B", 100, 500)]


def test_own_clearly_closer_returns_false():
    emb = SpanEmbedder([0.1, 0.9])  # B(자기)에 훨씬 가까움
    arb = make_embedding_arbiter("x.wav", emb, CENTROIDS)
    assert arb(100, 500, "B", "A") is False


def test_too_close_to_call_returns_none():
    emb = SpanEmbedder([1.0, 1.0])  # 등거리
    arb = make_embedding_arbiter("x.wav", emb, CENTROIDS)
    assert arb(100, 500, "B", "A") is None


def test_unembeddable_span_returns_none():
    arb = make_embedding_arbiter("x.wav", SpanEmbedder(None), CENTROIDS)
    assert arb(100, 500, "B", "A") is None


def test_missing_centroid_returns_none():
    arb = make_embedding_arbiter("x.wav", SpanEmbedder([1.0, 0.0]), {"A": [1.0, 0.0], "B": None})
    assert arb(100, 500, "B", "A") is None
