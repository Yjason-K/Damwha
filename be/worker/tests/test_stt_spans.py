from damwha_worker.models.base import SpeechSpan
from damwha_worker.pipeline.stt_spans import prepare_stt_spans


def test_pad_clamps_negative_start_to_zero():
    out = prepare_stt_spans([SpeechSpan(100, 500)], duration_ms=10_000)
    assert out == [SpeechSpan(0, 700)]


def test_pad_clamps_end_to_duration():
    out = prepare_stt_spans([SpeechSpan(9_900, 9_990)], duration_ms=10_000)
    assert out == [SpeechSpan(9_700, 10_000)]


def test_overlapping_spans_after_pad_are_merged():
    out = prepare_stt_spans([SpeechSpan(0, 1_000), SpeechSpan(1_300, 2_000)], duration_ms=5_000)
    assert out == [SpeechSpan(0, 2_200)]


def test_touching_spans_after_pad_are_merged():
    # pad 후 (0,1200)과 (1200,2200) — 맞닿음도 병합
    out = prepare_stt_spans([SpeechSpan(200, 1_000), SpeechSpan(1_400, 2_000)], duration_ms=5_000)
    assert out == [SpeechSpan(0, 2_200)]


def test_distant_spans_stay_separate():
    out = prepare_stt_spans([SpeechSpan(0, 500), SpeechSpan(3_000, 4_000)], duration_ms=10_000)
    assert out == [SpeechSpan(0, 700), SpeechSpan(2_800, 4_200)]


def test_invalid_and_out_of_range_spans_removed():
    out = prepare_stt_spans(
        [
            SpeechSpan(500, 500),  # end == start → 제거
            SpeechSpan(700, 600),  # end < start → 제거
            SpeechSpan(10_500, 11_000),  # duration 밖 → 제거
        ],
        duration_ms=10_000,
    )
    assert out == []


def test_empty_input_returns_empty():
    assert prepare_stt_spans([], duration_ms=10_000) == []


def test_unsorted_input_is_sorted():
    out = prepare_stt_spans([SpeechSpan(3_000, 4_000), SpeechSpan(0, 500)], duration_ms=10_000)
    assert out == [SpeechSpan(0, 700), SpeechSpan(2_800, 4_200)]
