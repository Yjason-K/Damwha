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
    data = load("process_meeting.valid.json") | {"schema_version": 3}
    with pytest.raises(UnsupportedPayloadVersion):
        parse_payload("process_meeting", data)


def test_parses_v2_fixture():
    p = parse_payload("process_meeting", load("process_meeting.v2.valid.json"))
    assert p.models.devices.diarization == "gpu"
    assert p.models.devices.stt == "cpu"
    assert p.models.whisper_model == "small"
    assert p.models.preset == "light"
    assert p.models.preset_revision == "2026-07-13.1"


@pytest.mark.parametrize(
    ("v1_device", "expected"),
    [("mps", "gpu"), ("cpu", "cpu"), ("cuda", "cpu")],  # cuda→cpu (spec §4)
)
def test_v1_converts_to_internal_v2(v1_device, expected):
    data = load("process_meeting.valid.json")
    data["models"]["device"] = v1_device
    p = parse_payload("process_meeting", data)
    assert p.models.devices.diarization == expected
    assert p.models.devices.stt == expected
    assert p.models.preset is None
    assert p.models.preset_revision is None


def test_v1_missing_version_converts():
    p = parse_payload("process_meeting", load("process_meeting.no_version.json"))
    assert p.schema_version == 1
    assert p.models.devices.stt in ("cpu", "gpu")


def test_parse_models_from_raw_dict():
    from damwha_worker.contracts import parse_models

    m = parse_models(load("process_meeting.v2.valid.json"))
    assert m.whisper_model == "small"
    m1 = parse_models(load("process_meeting.valid.json"))
    assert m1.devices.stt == "gpu"  # v1 mps


@pytest.mark.parametrize(
    ("job_type", "fixture"),
    [
        ("enroll_speaker", "enroll_speaker.valid.json"),
        ("index_meeting", "index_meeting.valid.json"),
    ],
)
def test_enroll_index_reject_v2(job_type, fixture):
    # enroll/index는 v1 불변 (spec §4) — 전역 버전 집합이면 v2가 새어 들어간다
    data = load(fixture) | {"schema_version": 2}
    with pytest.raises(UnsupportedPayloadVersion):
        parse_payload(job_type, data)


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
