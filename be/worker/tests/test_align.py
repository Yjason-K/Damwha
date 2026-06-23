from damwha_worker.models.base import DiarSegment, SpeechSpan, Word
from damwha_worker.pipeline.align import build_utterances


def test_assigns_words_by_midpoint_and_merges_consecutive():
    segments = [DiarSegment("S0", 0, 1000), DiarSegment("S1", 1000, 2000)]
    words = [
        Word("안녕", 0, 400, 0.9),  # mid 200 → S0
        Word("하세요", 400, 900, 0.8),  # mid 650 → S0
        Word("반가워", 1100, 1500, 0.7),  # mid 1300 → S1
    ]
    utts = build_utterances(words, segments)
    assert len(utts) == 2
    assert utts[0].diar_label == "S0" and utts[0].text == "안녕 하세요" and utts[0].status == "ok"
    assert utts[0].order_index == 0
    assert abs(utts[0].confidence - 0.85) < 1e-6
    assert utts[1].diar_label == "S1" and utts[1].text == "반가워"


def test_speaker_change_splits_even_if_adjacent():
    segments = [DiarSegment("S0", 0, 500), DiarSegment("S1", 500, 1000)]
    words = [Word("a", 0, 200, None), Word("b", 600, 800, None)]
    utts = build_utterances(words, segments)
    assert [u.diar_label for u in utts] == ["S0", "S1"]


def test_silence_segment_with_no_words():
    segments = [DiarSegment("S0", 0, 1000)]
    utts = build_utterances([], segments)
    assert len(utts) == 1 and utts[0].status == "silence" and utts[0].text is None


def test_transcribe_failed_span():
    segments = [DiarSegment("S0", 0, 1000)]
    utts = build_utterances([], segments, failed_spans=[SpeechSpan(0, 1000)])
    assert utts[0].status == "transcribe_failed" and utts[0].text is None


def test_order_index_is_time_ordered():
    segments = [DiarSegment("S1", 1000, 2000), DiarSegment("S0", 0, 1000)]
    words = [Word("late", 1100, 1200, None), Word("early", 100, 200, None)]
    utts = build_utterances(words, segments)
    assert [u.order_index for u in utts] == [0, 1]
    assert utts[0].start_ms < utts[1].start_ms


def test_empty_segments_returns_empty():
    assert build_utterances([Word("hi", 0, 500, 0.9)], []) == []
