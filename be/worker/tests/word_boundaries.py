import pytest

WORD_BOUNDARY_CASES = [
    pytest.param("ja", [" 今日", "は", "晴れ", "です", "。 "], "今日は晴れです。", id="ja"),
    pytest.param("zh", [" 今天", "天气", "很", "好", "。 "], "今天天气很好。", id="zh"),
    pytest.param("en", [" Hello", ",", " world", "! "], "Hello, world!", id="en"),
    pytest.param("ko", [" 오늘", " 날씨가", " 좋아요", ". "], "오늘 날씨가 좋아요.", id="ko"),
    pytest.param(
        "ja", [" 今日", "は", " meeting", "です", "。 "], "今日は meetingです。", id="mixed"
    ),
]
