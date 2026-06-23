import json
from pathlib import Path

import pytest

from damwha_worker.contracts import (
    ProcessMeetingPayload,
    UnsupportedPayloadVersion,
    parse_payload,
)

FIX = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "job-payloads"


def load(name):
    return json.loads((FIX / name).read_text())


def test_parses_process_meeting_fixture():
    p = parse_payload("process_meeting", load("process_meeting.valid.json"))
    assert isinstance(p, ProcessMeetingPayload)
    assert p.models.embedding.dimension == 192
    assert p.identify.threshold == 0.7


def test_parses_enroll_speaker_fixture():
    p = parse_payload("enroll_speaker", load("enroll_speaker.valid.json"))
    assert p.embedding.dimension == 192


def test_missing_schema_version_defaults_to_1():
    p = parse_payload("process_meeting", load("process_meeting.no_version.json"))
    assert p.schema_version == 1


def test_rejects_future_schema_version():
    data = load("process_meeting.valid.json") | {"schema_version": 2}
    with pytest.raises(UnsupportedPayloadVersion):
        parse_payload("process_meeting", data)
