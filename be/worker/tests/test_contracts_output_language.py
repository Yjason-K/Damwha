import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from damwha_worker.contracts import parse_payload

FIX = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "job-payloads"


def load(name):
    return json.loads((FIX / name).read_text())


def test_process_meeting_v6_carries_summary_language():
    p = parse_payload("process_meeting", load("process_meeting.v6.valid.json"))
    assert p.schema_version == 6
    assert p.models.summary_language == "en"
    assert p.followups.lens is True


@pytest.mark.parametrize(
    "name",
    [
        "process_meeting.valid.json",
        "process_meeting.v2.valid.json",
        "process_meeting.v3.valid.json",
        "process_meeting.v4.valid.json",
        "process_meeting.v5.valid.json",
    ],
)
def test_older_process_meeting_reads_as_transcript(name):
    # 큐에 남은 옛 job — 만들어질 때의 실제 동작이 "녹취 언어 따름"이었다.
    assert parse_payload("process_meeting", load(name)).models.summary_language == "transcript"


def test_v6_without_summary_language_is_rejected():
    data = load("process_meeting.v6.valid.json")
    del data["models"]["summary_language"]
    with pytest.raises(ValidationError):
        parse_payload("process_meeting", data)


def test_v6_rejects_unknown_summary_language():
    data = load("process_meeting.v6.valid.json")
    data["models"]["summary_language"] = "ja"
    with pytest.raises(ValidationError):
        parse_payload("process_meeting", data)


def test_summarize_v1_is_transcript_and_v2_carries_language():
    v1 = parse_payload("summarize_meeting", load("summarize-meeting-v1.json"))
    assert v1.output_language == "transcript"
    v2 = parse_payload("summarize_meeting", load("summarize-meeting-v2.json"))
    assert v2.output_language == "ko"


def test_summarize_version_and_field_must_agree():
    v2 = load("summarize-meeting-v2.json")
    del v2["output_language"]
    with pytest.raises(ValidationError):
        parse_payload("summarize_meeting", v2)
    v1 = load("summarize-meeting-v1.json") | {"output_language": "ko"}
    with pytest.raises(ValidationError):
        parse_payload("summarize_meeting", v1)


def test_extract_v1_is_transcript_and_v2_carries_language():
    v1 = parse_payload("extract_lenses", load("extract_lenses.v1.valid.json"))
    assert v1.output_language == "transcript"
    v2 = parse_payload("extract_lenses", load("extract_lenses.v2.valid.json"))
    assert v2.output_language == "en"


def test_extract_version_and_field_must_agree():
    v2 = load("extract_lenses.v2.valid.json")
    del v2["output_language"]
    with pytest.raises(ValidationError):
        parse_payload("extract_lenses", v2)


def test_live_session_v2_embeds_process_v6():
    p = parse_payload("live_session", load("live_session.v2.valid.json"))
    assert p.process.schema_version == 6
    assert p.process.models.summary_language == "transcript"
    assert p.process_wire["schema_version"] == 6


def test_live_session_v1_still_embeds_process_v5():
    p = parse_payload("live_session", load("live_session.valid.json"))
    assert p.process.schema_version == 5
    assert p.process.models.summary_language == "transcript"


def test_live_session_version_must_match_process_version():
    mixed = load("live_session.v2.valid.json")
    mixed["process"] = load("live_session.valid.json")["process"]
    with pytest.raises(ValidationError):
        parse_payload("live_session", mixed)
