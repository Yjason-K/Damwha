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
    data = load("process_meeting.valid.json") | {"schema_version": 6}
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


def test_parses_v3_fixture():
    p = parse_payload("process_meeting", load("process_meeting.v3.valid.json"))
    assert p.schema_version == 3
    assert p.models.summary_model == "mlx-community/Qwen3.5-4B-8bit"
    assert p.models.preset == "light"
    assert p.models.devices.stt == "cpu"


def test_parses_v4_fixture():
    p = parse_payload("process_meeting", load("process_meeting.v4.valid.json"))
    assert p.schema_version == 4
    assert p.identify.threshold == 0.8
    assert p.identify.suggest_threshold == 0.6
    assert p.models.summary_model == "mlx-community/Qwen3.5-4B-8bit"


def test_parses_v5_fixture():
    p = parse_payload("process_meeting", load("process_meeting.v5.valid.json"))
    assert p.schema_version == 5
    assert p.followups.lens is False
    assert p.followups.summary is False
    # v5는 v4가 실어오던 것을 그대로 유지한다 — 후속 스위치만 추가된 계약이다.
    assert p.identify.suggest_threshold == 0.6
    assert p.models.summary_model == "mlx-community/Qwen3.5-4B-8bit"


@pytest.mark.parametrize(
    "fixture",
    [
        "process_meeting.valid.json",
        "process_meeting.v2.valid.json",
        "process_meeting.v3.valid.json",
        "process_meeting.v4.valid.json",
    ],
)
def test_pre_v5_payloads_run_both_followups(fixture):
    # 큐에 남아 있던 예전 job은 예전처럼 렌즈/요약을 이어서 큐잉해야 한다.
    p = parse_payload("process_meeting", load(fixture))
    assert p.followups.lens is True
    assert p.followups.summary is True


def test_v5_requires_followups():
    from pydantic import ValidationError

    data = load("process_meeting.v5.valid.json")
    del data["followups"]
    with pytest.raises(ValidationError):
        parse_payload("process_meeting", data)


@pytest.mark.parametrize(
    "fixture",
    [
        "process_meeting.valid.json",
        "process_meeting.v2.valid.json",
        "process_meeting.v3.valid.json",
    ],
)
def test_pre_v4_payloads_have_no_suggestion_band(fixture):
    # An older queued job must keep behaving as it did: bind or nothing, never suggest.
    p = parse_payload("process_meeting", load(fixture))
    assert p.identify.suggest_threshold is None


def test_v4_requires_suggest_threshold():
    from pydantic import ValidationError

    data = load("process_meeting.v4.valid.json")
    del data["identify"]["suggest_threshold"]
    with pytest.raises(ValidationError):
        parse_payload("process_meeting", data)


def test_v4_rejects_band_above_threshold():
    # suggest_threshold > threshold makes the band unreachable — a binding match is
    # tested first — so it is a config error, not a quietly-ignored setting.
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        parse_payload("process_meeting", load("process_meeting.v4.inverted_band.json"))


def test_v3_requires_summary_model():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        parse_payload("process_meeting", load("process_meeting.v3.missing_summary_model.json"))


def test_v2_rejects_summary_model_extra_field():
    from pydantic import ValidationError

    data = load("process_meeting.v2.valid.json")
    data["models"]["summary_model"] = "mlx-community/Qwen3.5-4B-8bit"
    with pytest.raises(ValidationError):
        parse_payload("process_meeting", data)


@pytest.mark.parametrize("fixture", ["process_meeting.valid.json", "process_meeting.v2.valid.json"])
def test_v1_v2_have_no_summary_model(fixture):
    p = parse_payload("process_meeting", load(fixture))
    assert p.models.summary_model is None


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


def test_parse_summarize_meeting_payload():
    from damwha_worker.contracts import SummarizeMeetingPayload

    payload = parse_payload("summarize_meeting", load("summarize-meeting-v1.json"))
    assert isinstance(payload, SummarizeMeetingPayload)
    assert payload.model == "mlx-community/Qwen3.5-4B-8bit"


def test_summarize_meeting_payload_rejects_extra_field():
    from pydantic import ValidationError

    data = load("summarize-meeting-v1.json") | {"extraction_run_id": "ler_1"}
    with pytest.raises(ValidationError):
        parse_payload("summarize_meeting", data)


def test_summary_response_requires_known_utterance_id_shape():
    from pydantic import ValidationError

    from damwha_worker.contracts import SummaryResponse

    parsed = SummaryResponse.model_validate(
        {
            "topics": ["파이프라인 실행 순서"],
            "segments": [
                {
                    "start_utterance_id": "utt_1",
                    "end_utterance_id": "utt_2",
                    "title": "티켓 등록 수정",
                    "bullets": ["공유를 해드릴 것임"],
                }
            ],
        }
    )
    assert parsed.segments[0].title == "티켓 등록 수정"

    with pytest.raises(ValidationError):
        SummaryResponse.model_validate(
            {
                "topics": [],
                "segments": [
                    {
                        "start_utterance_id": "nope",
                        "end_utterance_id": "utt_2",
                        "title": "t",
                        "bullets": [],
                    }
                ],
            }
        )
