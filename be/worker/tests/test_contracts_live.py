import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from damwha_worker.contracts import (
    LiveSessionPayload,
    ProcessMeetingPayload,
    UnsupportedPayloadVersion,
    parse_payload,
)

FIX = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "job-payloads"


def load(name):
    return json.loads((FIX / name).read_text())


def test_parses_live_session_fixture_and_normalizes_process():
    p = parse_payload("live_session", load("live_session.valid.json"))
    assert isinstance(p, LiveSessionPayload)
    assert p.source == "mic"
    assert isinstance(p.process, ProcessMeetingPayload)
    assert p.process.schema_version == 5
    assert p.process.models.whisper_model == "large-v3-turbo"
    assert p.process.identify.suggest_threshold == 0.6
    assert p.process.followups.lens is True


def test_keeps_the_wire_process_block_verbatim_for_requeue():
    data = load("live_session.valid.json")
    p = parse_payload("live_session", data)
    assert p.process_wire == data["process"]


def test_rejects_process_that_is_not_v5():
    data = load("live_session.valid.json")
    data["process"]["schema_version"] = 4
    del data["process"]["followups"]
    with pytest.raises(ValidationError):
        parse_payload("live_session", data)


def test_rejects_mismatched_meeting_id_or_audio_key():
    data = load("live_session.valid.json")
    data["process"]["meeting_id"] = "mtg_2"
    with pytest.raises(ValidationError):
        parse_payload("live_session", data)
    data = load("live_session.valid.json")
    data["process"]["audio_key"] = "meetings/mtg_1/other.wav"
    with pytest.raises(ValidationError):
        parse_payload("live_session", data)


def test_rejects_unknown_source_and_future_version():
    data = load("live_session.valid.json")
    data["source"] = "system"
    with pytest.raises(ValidationError):
        parse_payload("live_session", data)
    data = load("live_session.valid.json") | {"schema_version": 2}
    with pytest.raises(UnsupportedPayloadVersion):
        parse_payload("live_session", data)
