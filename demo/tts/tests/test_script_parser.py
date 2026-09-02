import pytest

from damwha_demo_tts.script_parser import (
    Overlap,
    Pause,
    ScriptError,
    Utterance,
    parse_script,
)

CAST = ("박준영", "김서연", "이도현", "최민지")


def test_plain_line_becomes_utterance():
    events = parse_script("박준영: 자, 시작할까요.\n", CAST)
    assert events == [Utterance(speaker="박준영", text="자, 시작할까요.")]


def test_overlap_marker_becomes_overlap_event():
    events = parse_script("[겹침] 이도현: 아 네네.\n", CAST)
    assert events == [Overlap(speaker="이도현", text="아 네네.")]


def test_pause_marker_becomes_pause_seconds():
    events = parse_script("[사이 2초]\n", CAST)
    assert events == [Pause(seconds=2.0)]


def test_metadata_lines_are_ignored():
    src = "\n".join(
        [
            "# 1회차 — 킥오프",
            "",
            "**날짜:** 2026-06-15",
            "> 심어둔 것 — 결정 1",
            "| 회차 | 파일 |",
            "---",
            "박준영: 시작하죠.",
        ]
    )
    assert parse_script(src, CAST) == [Utterance(speaker="박준영", text="시작하죠.")]


def test_text_is_passed_through_untouched():
    events = parse_script("이도현: 어... 일 년치요?\n", CAST)
    assert events[0].text == "어... 일 년치요?"


def test_unknown_speaker_fails_with_line_number():
    with pytest.raises(ScriptError, match="3.*홍길동"):
        parse_script("박준영: a.\n김서연: b.\n홍길동: c.\n", CAST)


def test_unrecognized_line_fails_loud():
    with pytest.raises(ScriptError, match="2"):
        parse_script("박준영: a.\n이건 규약 밖 줄이다\n", CAST)


def test_line_number_after_events_is_kept():
    events = parse_script("# t\n\n박준영: a.\n[사이 1초]\n김서연: b.\n", CAST)
    assert [e.line for e in events] == [3, 4, 5]
