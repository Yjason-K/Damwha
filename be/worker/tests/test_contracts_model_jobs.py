"""download_model·delete_model payload v1 — be 픽스처를 그대로 읽는다 (zod와 같은 판정)."""

import json
from pathlib import Path

import pytest

from damwha_worker.contracts import ModelJobPayload, parse_payload

FIX = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "job-payloads"


def _read(name):
    return json.loads((FIX / name).read_text())


@pytest.mark.parametrize("job_type", ["download_model", "delete_model"])
def test_valid_fixtures_parse(job_type):
    p = parse_payload(job_type, _read("model_job.stt.valid.json"))
    assert isinstance(p, ModelJobPayload)
    assert (p.role, p.name, p.backend) == ("stt", "small", "faster")
    s = parse_payload(job_type, _read("model_job.summary.valid.json"))
    assert (s.role, s.backend) == ("summary", None)


@pytest.mark.parametrize(
    "name",
    ["model_job.summary_with_backend.invalid.json", "model_job.stt_without_backend.invalid.json"],
)
def test_invalid_fixtures_rejected(name):
    with pytest.raises(ValueError):
        parse_payload("download_model", _read(name))


def test_unknown_role_rejected():
    with pytest.raises(ValueError):
        parse_payload("delete_model", {"schema_version": 1, "role": "vad", "name": "x"})
