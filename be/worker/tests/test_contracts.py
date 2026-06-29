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


def test_rejects_uuid_meeting_id():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        parse_payload("process_meeting", load("process_meeting.invalid_id.json"))


@pytest.mark.parametrize(
    "bad",
    [
        "ca8e8f66-6e2b-4c4f-8d0b-7d432a7a6aca",  # UUID
        "mtg_0",  # zero
        "mtg_001",  # leading zero
        "mtg_1٢",  # unicode digit (\d 회귀 방지)
    ],
)
def test_rejects_bad_meeting_ids(bad):
    from pydantic import ValidationError

    data = load("process_meeting.valid.json") | {"meeting_id": bad}
    with pytest.raises(ValidationError):
        parse_payload("process_meeting", data)
