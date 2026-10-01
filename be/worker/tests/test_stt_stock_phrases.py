import pytest

from damwha_worker.models.base import Word
from damwha_worker.pipeline.stt_stock_phrases import (
    MAX_CONFIDENCE,
    drop_stock_hallucination,
    is_stock_hallucination,
)


def w(text: str, confidence: float | None = 0.3, start_ms: int = 0) -> Word:
    return Word(text=text, start_ms=start_ms, end_ms=start_ms + 400, confidence=confidence)


@pytest.mark.parametrize(
    "texts",
    [
        ["감사합니다."],
        ["감사합니다"],
        ["감사합니다.", "감사합니다."],
        ["시청해주셔서", "감사합니다."],
        ["다음", "영상에서", "만나요."],
        ["감사합니다.", "다음", "영상에서", "만나요."],
        ["한글자막"],
    ],
)
def test_drops_a_low_confidence_segment_made_only_of_stock_phrases(texts):
    # mtg_17 재현: 0.7~1.4초 clip의 단독 "감사합니다." — 단어 확률 0.10~0.72
    segment = [w(t, 0.3, i * 400) for i, t in enumerate(texts)]
    assert drop_stock_hallucination(segment) == []


def test_keeps_a_confidently_spoken_thanks():
    # mtg_6의 실제 인사는 0.98이었다
    segment = [w("감사합니다.", 0.98)]
    assert drop_stock_hallucination(segment) == segment


def test_threshold_is_exclusive():
    assert is_stock_hallucination([w("감사합니다.", MAX_CONFIDENCE - 0.01)])
    assert not is_stock_hallucination([w("감사합니다.", MAX_CONFIDENCE)])


def test_one_confident_word_saves_the_segment():
    segment = [w("감사합니다.", 0.2), w("감사합니다.", 0.9, 400)]
    assert drop_stock_hallucination(segment) == segment


def test_keeps_a_segment_where_the_phrase_is_part_of_a_sentence():
    segment = [w("도와주셔서", 0.3), w("감사합니다.", 0.3, 400)]
    assert drop_stock_hallucination(segment) == segment


def test_keeps_a_segment_that_merely_contains_a_phrase_word():
    # 부분 일치로 자르지 않는다 — "감사" 티켓, "감사합니다만" 같은 말
    for text in ["감사", "감사합니다만", "영상에서"]:
        segment = [w(text, 0.1)]
        assert drop_stock_hallucination(segment) == segment


def test_missing_confidence_counts_as_confident():
    segment = [w("감사합니다.", None)]
    assert drop_stock_hallucination(segment) == segment


def test_empty_segment_is_untouched():
    assert drop_stock_hallucination([]) == []
