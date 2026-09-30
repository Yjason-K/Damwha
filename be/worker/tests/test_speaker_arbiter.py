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


def test_fragment_resolver_moves_to_closest_neighbor():
    from damwha_worker.pipeline.speaker_arbiter import make_fragment_resolver

    cents = {"A": [1.0, 0.0], "B": [0.0, 1.0], "C": [0.7, 0.7]}
    resolve = make_fragment_resolver("x.wav", SpanEmbedder([0.95, 0.3]), cents)
    # 자기(C) 0.88 < 이웃 A 0.95 + margin 없음 → A
    assert resolve(100, 500, "C", ["A", "B"]) == "A"


def test_fragment_resolver_keeps_own_when_clearly_closer():
    from damwha_worker.pipeline.speaker_arbiter import make_fragment_resolver

    resolve = make_fragment_resolver("x.wav", SpanEmbedder([0.1, 0.9]), CENTROIDS)
    assert resolve(100, 500, "B", ["A"]) == "B"


def test_fragment_resolver_short_span_is_padded_and_unembeddable_is_none():
    from damwha_worker.pipeline.speaker_arbiter import make_fragment_resolver

    emb = SpanEmbedder(None)
    resolve = make_fragment_resolver("x.wav", emb, CENTROIDS)
    assert resolve(100, 150, "B", ["A"]) is None
    # 임베딩 불가 길이를 피하려고 최소 300ms로 늘려 잰다
    assert emb.calls == [("B", 100, 400)]


def test_arbiter_embeds_each_span_once():
    # align의 스무딩 루프는 변경마다 처음부터 다시 훑어 같은 run을 거듭 묻는다 —
    # 실측 1회 처리에서 11,057번 호출, 서로 다른 스팬은 338개였다.
    emb = SpanEmbedder([0.9, 0.1])
    arb = make_embedding_arbiter("x.wav", emb, CENTROIDS)
    assert arb(100, 500, "B", "A") is True
    assert arb(100, 500, "B", "A") is True
    assert arb(100, 500, "A", "B") is False  # 같은 스팬, 다른 질문 — 임베딩은 재사용
    assert emb.calls == [("B", 100, 500)]
